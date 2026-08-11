/**
 * The tools, and the run pipeline behind the two that matter.
 *
 * The shape of a run tool is: assemble (which resolves and confines the
 * project), pick a session, make sure a server is listening, take the session
 * lock, stream, fold, then report. Pre-flight failures — everything before the
 * stream opens — come back as `isError:true`; anything that reached the server
 * comes back as a normal result whose `status` says what happened. That split
 * is deliberate and load-bearing: `isError` results carry no
 * `structuredContent`, so using them for a failed run would strip the agent of
 * `sessionId`, `steps` and `reportPath` exactly when it needs them.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { assembleSteps, assembleTestFile } from './assemble.js';
import {
  badCdpProfileName,
  cdpFocusRouteMissing,
  cdpFocusTabNotFound,
  cdpFocusTargetAmbiguous,
  cdpTabTargetAmbiguous,
  listSessionsTimedOut,
  preflightError,
  unauthorized,
  type McpToolError,
} from './errors.js';
import {
  assertPortAttachable,
  maySeeForeignTabs,
  resolveCdpTarget,
  summarizeBrowsers,
} from './cdp.js';
import { configuredRoots, canonicalize, isInsideRoot, resolveTestsGlob } from './project.js';
import { userRootDir } from '../env/user-root.js';
import { discoverTestFiles } from '../parser/markdown.js';
import { DATA_URI_PREFIX, MAX_SCREENSHOT_BASE64, foldRun, type FoldedRun } from './run-fold.js';
import { withSession } from './registry.js';
import * as schemas from './schemas.js';
import { probeHealth, normalizeBaseUrl } from '../server/health.js';
import {
  ApiHttpError,
  ApiRouteNotFoundError,
  DEFAULT_SCREENSHOTS_RETURN,
  PreflightFailure,
  type ApiClient,
  type AssembledRun,
  type CaptureMode,
  type McpDeps,
  type RunEvent,
  type RunSettings,
  type ScreenshotsReturn,
} from './types.js';

/** The server refuses `config` on an existing session by throwing, and on the
 *  streaming path that throw arrives as an `output` event rather than a 400 —
 *  so text is the only handle we have. Pinned by a test against the server's
 *  own message so a change there breaks loudly rather than silently disabling
 *  the retry. */
const CONFIG_REJECTED = 'Config can only be provided on the first request';

/** `page.title()` is awaited per session with no server-side timeout, so one
 *  hung page can block the whole listing. */
const LIST_SESSIONS_TIMEOUT_MS = 5_000;

/** Report generation happens *after* the server notices a disconnect, so the
 *  first read is routinely `{finalized:false}`. TestBench backs off to about
 *  this long before giving up. */
const LAST_RUN_POLL_BUDGET_MS = 12_000;

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

/** The SDK's `CallToolResult` carries an index signature for protocol
 *  extensions; matching it here keeps every handler assignable without a cast
 *  at each registration site. */
type ToolResult = {
  [key: string]: unknown;
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Widen a §7 refusal into the SDK's result shape. */
function errorResult(error: McpToolError): ToolResult {
  return { content: [...error.content], isError: true };
}

/**
 * The structured half, repeated verbatim as text.
 *
 * A tool result has two halves and **hosts disagree about which one the model
 * sees**. Claude Code shows the model `structuredContent`; opencode's MCP
 * catalogue returns `content` untouched whenever it is non-empty
 * (`mcp/catalog.ts`), so a summary there is *all* the model gets. Measured
 * 2026-08-08 on the same server: `list_cdp_browsers` handed Claude Code the
 * full listing and opencode `"1 running, 2 available (not started)"` — and
 * `close_cdp_tab`'s documented flow is "read the targetIds out of that listing",
 * which no `targetId` survives to. This is the spec's own remedy: *"a tool that
 * returns structured content SHOULD also return the serialized JSON in a
 * TextContent block."*
 *
 * Compact, not indented — measured at +45% on a 25-step run result for
 * whitespace no model needs. It reverses "do not duplicate the full JSON as
 * text" in stories/mcp-server.md §2, which is amended to match; the summary
 * stays because it carries counts, truncation and warnings that raw JSON does
 * not narrate.
 */
function serialized(value: Record<string, unknown>): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value) };
}

/**
 * Validate our own output before handing it over.
 *
 * The SDK validates `structuredContent` against the declared `outputSchema`,
 * and on a mismatch its handler catches the error and returns
 * `{content, isError:true}` with no structured content at all — silently
 * producing the one shape this server promises never to produce for a run that
 * reached the server. Checking first turns that into a visible, still-valid
 * error result.
 */
function validated<T extends Record<string, unknown>>(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
  value: T,
  summary: string,
  extra: ToolResult['content'] = [],
  /** A minimal object known to satisfy `schema`, used when `value` does not.
   *  Without one there is nothing to degrade *to*. */
  fallback?: (detail: string) => Record<string, unknown>,
): ToolResult {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    // Summary, then the data, then `extra` — the image block stays last.
    return {
      content: [{ type: 'text', text: summary }, serialized(value), ...extra],
      structuredContent: value,
      isError: false,
    };
  }

  const detail = String((parsed.error as { message?: string })?.message ?? parsed.error);

  // Returning `value` with a warning bolted on — the obvious move — does not
  // work: the SDK re-validates, fails again, and answers with
  // `isError:true` and NO structured content, which is precisely the shape the
  // locked decision forbids for a run that reached the server. The degrade has
  // to be to something that actually validates, and we must confirm that it
  // does before trusting it.
  const degraded = fallback?.(detail);
  if (degraded && schema.safeParse(degraded).success) {
    // `degraded`, not `value` — the two halves must never describe different
    // results, and this is the one path where they could.
    return {
      content: [
        { type: 'text', text: `${summary}\n\n(result validation failed: ${detail})` },
        serialized(degraded),
      ],
      structuredContent: degraded,
      isError: false,
    };
  }

  // No usable fallback: fail loudly and deliberately rather than letting the
  // SDK produce the same shape by accident.
  return errorResult(
    preflightError(
      `The tool produced a result that does not match its own schema, and the ` +
        `fallback did not either. This is a bug in the MCP server.\n\n${detail}`,
    ),
  );
}

/** Turn a thrown pre-flight failure into the tool error it carries. */
function asToolError(err: unknown, envFiles: readonly string[], baseUrl: string): ToolResult {
  if (err instanceof PreflightFailure) return errorResult(err.toolError);
  if (err instanceof ApiHttpError) return errorResult(httpErrorToToolError(err, envFiles, baseUrl));
  return errorResult(preflightError(err instanceof Error ? err.message : String(err)));
}

/** The Sessions API's non-2xx answers, each of which means something different
 *  to whoever is reading. */
function httpErrorToToolError(
  err: ApiHttpError,
  envFiles: readonly string[],
  baseUrl: string,
): McpToolError {
  switch (err.status) {
    case 401:
      return unauthorized(envFiles, baseUrl);
    case 503:
      return preflightError(
        `${baseUrl} is shutting down (someone ran \`aiui stop\`). Try again once it has restarted.`,
      );
    case 500:
      // The error middleware hardcodes 500 and ignores `err.status`, so
      // body-parser's 413 lands here wearing the wrong number. Worth saying,
      // because "too large" is fixable and "internal error" is not.
      return preflightError(
        `${baseUrl} failed: ${err.serverMessage}\n` +
          (/entity too large/i.test(err.serverMessage)
            ? 'The request body exceeded the server\'s ~100KB limit — this is a size problem ' +
              'reported as a 500. Send fewer steps, or split the test.'
            : ''),
      );
    default:
      // The `: <cause>` tail is dropped when there is no cause. A server that
      // sends an empty reason phrase — anything over HTTP/2, or behind a proxy
      // — otherwise renders as "rejected the request (HTTP 404): ", a dangling
      // colon with nothing after it, which reads like the message got lost
      // rather than like there never was one.
      return preflightError(
        `${baseUrl} rejected the request (HTTP ${err.status})` +
          (err.serverMessage ? `: ${err.serverMessage}` : ''),
      );
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Default session ids.
 *
 * `run_test_file` keys on the file, so an agent iterating on one test reuses
 * one browser. `run_steps` keys on the process *and the project*: one process
 * may serve several roots, and an unscoped id would reuse one browser across
 * projects while the second project's `config` silently never applied.
 */
function defaultSessionId(kind: 'file' | 'steps', projectRoot: string, testFilePath: string): string {
  return kind === 'file'
    ? `mcp:${testFilePath}`
    : `mcp:steps-${process.pid}-${shortHash(projectRoot)}`;
}

function checkSessionOwnership(
  sessionId: string,
  allowForeign: boolean,
  /** What the caller would actually do to the foreign session. Stated in the
   *  refusal because "would drive their browser" is the wrong warning for a
   *  read — the hazard there is disclosure, not control, and an agent that is
   *  told the wrong risk cannot weigh the right one. */
  consequence = 'running steps in it would drive their browser',
): void {
  if (sessionId.startsWith('mcp:') || allowForeign) return;
  throw new PreflightFailure(
    preflightError(
      `Session "${sessionId}" was not created by this MCP server. It may belong to a ` +
        `developer's open editor, and ${consequence}.\n` +
        'Pass allow_foreign_session: true if that is genuinely what you want.',
    ),
  );
}

// ---------------------------------------------------------------------------
// Run pipeline
// ---------------------------------------------------------------------------

interface RunOutcome extends FoldedRun {
  sessionId: string;
  projectRoot: string;
  /** Which root the run resolved against (stories/mcp-no-project.md rule 7).
   *  A typo'd config filename now yields a *working* run against the user
   *  root, and this field is what keeps that visible instead of mysterious. */
  scope: 'project' | 'user';
  sessionCreated: boolean;
  configApplied: boolean;
  queuedForMs: number;
  tokens: { total: number; input: number; output: number } | null;
}

/**
 * Read the five run-setting arguments off a tool call.
 *
 * `runSettings` is the retained half and goes on the wire; `screenshotsReturn`
 * never leaves this process — it decides what the fold puts in the tool result.
 *
 * A key is only included when the caller actually named it. That distinction is
 * the retention contract: an absent key means "leave what the session has",
 * while `null` / `"default"` means "stop overriding", and collapsing the two
 * would make every ordinary run silently reset the session's settings.
 */
function readRunSettings(args: {
  model?: string | null | undefined;
  capture?: CaptureMode | undefined;
  full_page?: boolean | null | undefined;
  send_screenshots?: boolean | null | undefined;
  screenshots_return?: ScreenshotsReturn | 'default' | undefined;
}): { runSettings: RunSettings; screenshotsReturn: ScreenshotsReturn } {
  const runSettings: RunSettings = {};
  if (args.model !== undefined) runSettings.model = args.model;
  if (args.capture !== undefined) runSettings.capture = args.capture;
  if (args.full_page !== undefined) runSettings.fullPage = args.full_page;
  if (args.send_screenshots !== undefined) runSettings.sendScreenshots = args.send_screenshots;
  // `default` is `none`: no image comes back unless it was asked for. A
  // screenshot is a picture of a live signed-in session, and it is charged to
  // the caller's context — neither is a cost to incur by default.
  // `'default'` and an absent argument are the same thing here — unlike the four
  // above, this one is not retained, so there is no override to clear. It exists
  // for symmetry, so a model that has learned `default` on `capture` is not
  // surprised by one setting rejecting the word.
  const requested = args.screenshots_return;
  const screenshotsReturn: ScreenshotsReturn =
    requested === undefined || requested === 'default'
      ? DEFAULT_SCREENSHOTS_RETURN
      : requested;
  return { runSettings, screenshotsReturn };
}

async function pollLastRun(
  client: ApiClient,
  sessionId: string,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<{ reportPath: string | null; tokens: RunOutcome['tokens'] } | null> {
  const started = Date.now();
  let delay = 100;
  for (;;) {
    if (signal?.aborted) return null;
    try {
      const info = await client.getLastRun(sessionId);
      if (info.finalized) {
        return { reportPath: info.reportPath ?? null, tokens: info.tokens ?? null };
      }
    } catch {
      // A failed poll is never allowed to change the run's status — the run
      // already happened, and this is only about the report.
      return null;
    }
    if (Date.now() - started + delay > budgetMs) return null;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2_000);
  }
}

/**
 * The project's running CDP browsers, or `[]` if we cannot find out.
 *
 * Deliberately swallows everything. This exists to decorate a run that has
 * already finished, so a registry that is slow, broken or gone must cost the
 * caller a missing warning and never a changed `status`.
 */
async function runningCdpBrowsers(
  client: ApiClient,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<{ engine: string; profile: string; scope?: 'project' | 'user' | undefined }[]> {
  try {
    const browsers = await client.getCdpBrowsers({ projectRoot, includeForeign: false }, signal);
    return browsers.running.map((b) => ({ engine: b.engine, profile: b.profile, scope: b.scope }));
  } catch {
    return [];
  }
}

interface RunContext {
  deps: McpDeps;
  assembled: AssembledRun;
  sessionId: string;
  screenshotsReturn: ScreenshotsReturn;
  signal?: AbortSignal | undefined;
  onProgress?: ((completed: number, text: string) => void) | undefined;
}

async function executeRun(ctx: RunContext): Promise<RunOutcome> {
  const { deps, assembled, sessionId } = ctx;
  const { project, request, sentSteps } = assembled;

  await deps.ensureServerReady(project, ctx.signal);

  const client = deps.createApiClient({ baseUrl: project.serverUrl, apiKey: project.apiKey });

  // §6's gate. Only a *tool-supplied* `cdp` is checked: a `## Config: cdp:`
  // line in a test file is human-authored and already trusted, which is the
  // distinction `cdpSource` exists to carry.
  //
  // Here rather than in `assemble` because the check is a live round-trip to
  // the registry — a browser that was running when the agent listed may not be
  // running now, and attaching to a port something else has since taken is the
  // failure this prevents. Before `streamSteps`, so a refusal is a pre-flight
  // error and no run happens.
  if (assembled.cdpSource === 'tool' && assembled.cdpTarget !== null) {
    const target = assembled.cdpTarget;
    const { port, gateOwed } = await resolveCdpTarget(
      client,
      project.projectRoot,
      target,
      ctx.signal,
    );
    // A profile was resolved out of the caller's own `running` list, so the
    // port is owned by construction and there is nothing for the gate to check.
    // A caller-supplied port has cleared no such thing and still owes one.
    if (gateOwed) {
      await assertPortAttachable(
        client,
        project.projectRoot,
        port,
        project.cdpPermissions,
        project.configPath,
        ctx.signal,
      );
    }
    const tab = target.tab?.trim();
    const profile = target.profile?.trim();
    request.config = {
      ...request.config,
      cdp: {
        port,
        ...(tab !== undefined && tab !== '' ? { tab } : {}),
        // Descriptive only — `port` above is what selects the browser. Sent so
        // `list_sessions` can name what a session is driving instead of
        // reporting a bare number nobody can map back.
        ...(profile !== undefined && profile !== '' ? { profile } : {}),
      },
    };
  }

  const outcome = await withSession(project.serverUrl, sessionId, async ({ queuedForMs, isFirstCall, markConfigured }) => {
    // Progress counts terminal events only. Counting starts as well would
    // repeat a value, and MCP requires `progress` to increase on every
    // notification; counting every event would sail past `total`.
    let completed = 0;
    const onEvent = (event: RunEvent): void => {
      if (event.type === 'step:pass' || event.type === 'step:fail') {
        completed++;
        // The step's own text where we can recover it — a bare "step 3" tells
        // a watching human nothing about what is happening. Root-frame events
        // carry the line we sent, which maps back to the sent array; expanded
        // steps come from a file the agent never sent, so they fall back.
        const index = request.sourceLines?.indexOf(event.line) ?? -1;
        const label = index >= 0 ? (sentSteps[index] ?? null) : null;
        ctx.onProgress?.(completed, label ?? `step ${completed}`);
      }
    };

    const withConfig = { ...request };
    if (!isFirstCall) delete withConfig.config;

    let stream = await client.streamSteps(sessionId, withConfig, ctx.signal, onEvent);
    let configApplied = isFirstCall && request.config !== undefined;
    let sessionCreated = isFirstCall;

    // The session may already exist from an earlier process — `mcp:` ids
    // outlive us, and the server refuses `config` on an existing session. The
    // throw happens before the queue and before any step runs, so retrying
    // cannot double-execute anything.
    const rejectedConfig = stream.events.some(
      (e) => e.type === 'output' && e.kind === 'error' && e.msg.includes(CONFIG_REJECTED),
    );
    if (rejectedConfig && withConfig.config !== undefined) {
      const retry = { ...request };
      delete retry.config;
      // The counter deliberately keeps running across the retry. The server
      // raises this error before it enqueues the run, so in practice nothing
      // has been counted yet — but resetting would send `progress` backwards
      // if that ever stopped being true, and MCP requires it to increase on
      // every notification.
      stream = await client.streamSteps(sessionId, retry, ctx.signal, onEvent);
      configApplied = false;
      sessionCreated = false;
    }

    // Only now is the session known to exist: a connect failure must not burn
    // the flag, or the next call would skip `config` on a session that was
    // never created.
    if (stream.events.length > 0) markConfigured();

    const folded = foldRun({
      events: stream.events,
      receivedAt: stream.receivedAt,
      streamDropped: stream.streamDropped,
      dropped: stream.dropped,
      sentSteps,
      sourceLines: request.sourceLines,
      testFilePath: request.testFilePath ?? project.projectRoot,
      expansionPossible: request.skillsDir !== undefined || request.sections !== undefined,
      screenshotsReturn: ctx.screenshotsReturn,
    });

    return {
      ...folded,
      warnings: [...assembled.warnings, ...folded.warnings],
      reportPath: folded.reportPath,
      tokens: null,
      sessionId,
      projectRoot: project.projectRoot,
      scope: project.scope,
      sessionCreated,
      configApplied,
      queuedForMs,
    };
  });

  // W1 — the caller named a CDP browser and did not get it.
  //
  // `configApplied: false` already says so, but only to something that reads
  // structured output and knows what that field means. Measured, the run came
  // back `status: "passed"`, `warnings: []`, and executed in a fresh
  // signed-out browser. For a feature whose whole point is "use my signed-in
  // browser", a wrong-browser run that PASSES is the worst available outcome.
  if (request.config?.cdp !== undefined && !outcome.configApplied) {
    outcome.warnings = [
      ...outcome.warnings,
      `config.cdp was ignored: session "${sessionId}" already existed, and a ` +
        "session's browser is fixed when the session is created. These steps ran " +
        "in that session's existing browser, NOT the CDP one. To use the CDP " +
        `browser: close_session "${sessionId}", then run again.`,
    ];
  }

  // A model override running against a live step cache.
  //
  // The cache keys on step text and identity, NOT the model, so a switched model
  // can be served plans the previous one produced — which bites hardest in the
  // case you would switch for, comparing models. Warned rather than solved:
  // adding the model to the key would invalidate every cached entry in every
  // project for that one case.
  if (request.runSettings?.model !== undefined && request.cacheEnabled === true) {
    outcome.warnings = [
      ...outcome.warnings,
      'A model override ran with the step cache on. The cache does not key on ' +
        'the model, so some steps may have replayed plans made by the previous ' +
        'model rather than asking this one. Turn caching off for this project (or ' +
        'set `cache: off` in the test) if you are evaluating the model itself.',
    ];
  }

  // W2 — a fresh, signed-out, disposable browser was launched while a
  // persistent one sat idle.
  //
  // Only on session creation: that is the only moment `config` would have been
  // honoured, so it is the only moment the advice is actionable. Repeating it
  // on every later call would be noise the agent cannot act on, and a warning
  // that cries wolf is one nobody reads.
  if (outcome.sessionCreated && request.config?.cdp === undefined) {
    const idle = await runningCdpBrowsers(client, project.projectRoot, ctx.signal);
    if (idle.length > 0) {
      const named = idle
        .map((b) => `${b.engine} "${b.profile}"${b.scope === 'user' ? ' (user root)' : ''}`)
        .join(', ');
      outcome.warnings = [
        ...outcome.warnings,
        `This run launched a fresh, signed-out browser, but there are ` +
          `${idle.length} CDP browser(s) running: ${named}. If you meant to use one, ` +
          `pass config.cdp: { profile: "${idle[0]!.profile}" } — on a NEW session, ` +
          'since config is only read when a session is created.',
      ];
    }
  }

  // The report poll happens AFTER the session lock is released. It reads a
  // finished run's metadata and touches no session state, so holding the lock
  // through up to 12 s of backoff would just make the next caller wait — and
  // charge them for it in `queuedForMs`. It also honours the caller's signal,
  // so a cancelled call stops polling instead of running the budget out.
  const last = await pollLastRun(client, sessionId, LAST_RUN_POLL_BUDGET_MS, ctx.signal);
  if (!last) {
    outcome.warnings = [
      ...outcome.warnings,
      'Could not read the run report — the run itself is unaffected; ' +
        'call get_last_run later if you need the report path or token totals.',
    ];
  }
  return {
    ...outcome,
    reportPath: outcome.reportPath ?? last?.reportPath ?? null,
    tokens: last?.tokens ?? null,
  };
}

/**
 * "Show me what the page looks like now" — the viewport, as an image
 * (stories/run-settings.md §7).
 *
 * Two limits are honest to state rather than paper over. It is a VIEWPORT shot:
 * `GET /sessions/:id` calls `captureScreenshot(page)` with no full-page
 * argument, so `full_page` does not reach it. And the server swallows capture
 * failures into an empty string, so an empty value is an error here — reporting
 * a blank page would be a claim about the page that nobody downstream can
 * correct.
 */
async function screenshotResult(
  client: ApiClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const state = await client.getSessionState(sessionId, signal);
  const raw = typeof state.screenshot === 'string' ? state.screenshot : '';
  const base64 = raw.replace(DATA_URI_PREFIX, '');
  if (base64 === '') {
    return errorResult(
      preflightError(
        `Could not photograph the page of session "${sessionId}". The session is ` +
          'there but the capture failed — the browser may be mid-navigation or ' +
          'wedged. This is NOT a blank page. Try again, or read it with ' +
          'format: "text".',
      ),
    );
  }
  if (base64.length > MAX_SCREENSHOT_BASE64) {
    // An error, not a warning: unlike a run result, there is nothing else in
    // this response worth having once the image is gone.
    return errorResult(
      preflightError(
        `The screenshot is ${Math.round(base64.length / 1024)}KB of base64, over ` +
          'the size cap for an image in a tool result. Read the page with ' +
          'format: "text" instead, or narrow what is on screen.',
      ),
    );
  }

  const value = {
    sessionId: state.sessionId ?? sessionId,
    url: state.currentUrl ?? '',
    title: state.pageTitle ?? '',
    // 'queued' means a run is waiting behind another one, which for a read is
    // the same caveat as 'executing': the page may move under the caller.
    status: state.status === 'active' ? ('active' as const) : ('executing' as const),
    format: 'screenshot' as const,
    selector: null,
    // Empty on purpose — the picture is in the image block. `format` says which
    // half of this response carries the payload.
    content: '',
    truncated: false,
    returnedChars: base64.length,
    availableChars: base64.length,
  };
  return validated(
    schemas.getPageContentOutput,
    value,
    `${state.pageTitle || state.currentUrl} — viewport screenshot, ` +
      `${Math.round(base64.length / 1024)}KB`,
    [{ type: 'image', data: base64, mimeType: 'image/png' }],
  );
}

/**
 * Resolve a project, make the server usable, and hand the body a client.
 *
 * Exists so the non-run tools report failures as well as the run tools do:
 * with `project` scoped inside each handler's own `try`, a 401 was caught
 * with no `envFilesConsulted` and no base URL — rendering §7's row as
 * " rejected our AIUI_SERVER_API_KEY. Ours came from:  (or the environment)",
 * which names neither of the two things it exists to name.
 *
 * **`autoStart` defaults to ON** — every tool that reaches through this helper
 * starts the Sessions API server if it is down and loopback, then proceeds.
 * That is what the user expects: whichever aiui tool an agent reaches for first
 * — `list_cdp_browsers`, `list_sessions`, a run — should bring the server up
 * rather than fail on a bare ECONNREFUSED. A caller passes `autoStart: false`
 * only for a genuine "is it there?" probe that must be able to answer "no", and
 * the two tools with that contract (`server_status`, `get_run_settings`) do not
 * use this helper at all — they probe directly and report `running: false`.
 *
 * The earlier design defaulted to OFF for the "report on what's there" tools,
 * on the theory that "what browsers do I have?" must not create a server. In
 * practice that just made the first call fail confusingly; listing browsers or
 * sessions legitimately needs the server, and starting it to answer is the
 * right move. Nothing is traded away by starting: `ensureServerReady`'s
 * `unrecognized` arm throws the same refusal `assertServerRecognized` does, so
 * the key still never reaches a squatter — the only difference is a *down*
 * loopback server gets started instead of the request failing on connect.
 */
async function withProject(
  deps: McpDeps,
  projectRoot: string | undefined,
  body: (client: ApiClient, project: Awaited<ReturnType<McpDeps['resolveProject']>>) => Promise<ToolResult>,
  opts: { autoStart?: boolean; signal?: AbortSignal | undefined } = {},
): Promise<ToolResult> {
  let project: Awaited<ReturnType<McpDeps['resolveProject']>> | undefined;
  try {
    project = await deps.resolveProject({ projectRoot });
    // Before the key goes anywhere: both arms refuse an unrecognized service,
    // so an agent calling `list_sessions` as a "what's running?" probe never
    // hands the project's key to whatever holds the port. The only difference
    // is whether a DOWN loopback server is started (default) or let through as
    // a connect error (`autoStart: false`).
    await (opts.autoStart === false
      ? deps.assertServerRecognized(project, opts.signal)
      : deps.ensureServerReady(project, opts.signal));
    const client = deps.createApiClient({
      baseUrl: project.serverUrl,
      apiKey: project.apiKey,
    });
    return await body(client, project);
  } catch (err) {
    return asToolError(err, project?.envFilesConsulted ?? [], project?.serverUrl ?? '');
  }
}

/** One-line headline plus the first failure — what a host that ignores
 *  structured output will show, and what a human skimming a transcript reads.
 *  The SDK synthesizes nothing from `structuredContent`. */
function summarize(outcome: RunOutcome): string {
  const counted = outcome.steps.filter((s) => s.status === 'passed').length;
  const lines = [
    `${outcome.status.toUpperCase()} — ${counted}/${outcome.steps.length} steps passed ` +
      `(session ${outcome.sessionId})`,
  ];
  // Rule 7 of stories/mcp-no-project.md, on the line a host that ignores
  // structured output will show: a run that landed on the user root because
  // no project resolved must say so, or a typo'd config filename becomes a
  // working run with the project's skills mysteriously absent.
  if (outcome.scope === 'user') {
    lines.push(`Ran project-less against the user root (${outcome.projectRoot}).`);
  }
  if (outcome.error) lines.push(`Error: ${outcome.error}`);
  if (outcome.reportPath) lines.push(`Report: ${outcome.reportPath}`);
  if (outcome.warnings.length > 0) lines.push(`Warnings: ${outcome.warnings.length}`);
  // The echo, on the line a host that ignores structured output will show. A
  // retained setting is invisible otherwise — and "why is there no screenshot?"
  // is answered here rather than several turns later.
  const settings = outcome.effectiveSettings;
  if (settings) {
    lines.push(
      `Settings: model ${settings.model ?? '(not reported)'}, capture ` +
        `${settings.capture ?? '(not reported)'}, return ${settings.screenshotsReturn}` +
        (settings.sendScreenshots ? ', model sees screenshots' : ''),
    );
  }
  return lines.join('\n');
}

function outcomeToResult(outcome: RunOutcome): ToolResult {
  const image: ToolResult['content'] = outcome.screenshotBase64
    ? [{ type: 'image', data: outcome.screenshotBase64, mimeType: 'image/png' }]
    : [];
  const { screenshotBase64: _drop, ...rest } = outcome;
  return validated(
    schemas.runResultOutput,
    rest as unknown as Record<string, unknown>,
    summarize(outcome),
    image,
    // Keeps the three things an agent cannot recover any other way — which
    // session it was, where the report went, and that something ran — even
    // when the rest of the payload is unusable.
    (detail) => ({
      status: 'error',
      streamDropped: outcome.streamDropped,
      sessionId: outcome.sessionId,
      projectRoot: outcome.projectRoot,
      scope: outcome.scope,
      sessionCreated: outcome.sessionCreated,
      configApplied: outcome.configApplied,
      queuedForMs: outcome.queuedForMs,
      steps: [],
      captures: {},
      messages: [],
      warnings: [`The run finished, but its result could not be encoded: ${detail}`],
      reportPath: outcome.reportPath ?? null,
      tokens: null,
      error: detail,
      effectiveSettings: null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Shared syntax crib. An agent with no reference writes prose that half-works
 *  — the AI executes it, so the failure is a wrong run rather than an error. */
const STEP_SYNTAX = `
Step syntax: plain English, one action per step. Also supported:
  [skill: name arg=value]   run a reusable skill from the project's skills dir
  [tool: name arg=value]    call a project tool (JS/TS) directly
  [input: label]            needs a human — SKIPPED in an unattended run
  Section Name              call an inline "### Section Name" from the same file
  \${env.VAR} / \${data.key} substituted from the selected environment
  {{param}}                 substituted from ## Parameters`.trim();

/**
 * The CDP pointer, on the run tools themselves.
 *
 * It already exists on `list_cdp_browsers` and `start_cdp_browser` — and that
 * turned out to be the wrong place. Measured: an agent that had just started a
 * CDP browser was asked to "navigate to facebook.com" one turn later and ran it
 * in a fresh, signed-out, disposable browser, because by then the tool it was
 * calling said nothing about browsers at all. A tool description is the only
 * text guaranteed to be in front of the model at the moment of the call.
 */
const CDP_NOTE = `
Browser: steps run in a fresh, signed-out, disposable browser UNLESS you say
otherwise. Persistent CDP browsers holding real logins may also be running —
the project's, and the user's machine-wide ones (scope "user", reachable from
any directory, project or not). To use one, pass config.cdp:
{profile: "<name>"} (call list_cdp_browsers if unsure which exist; add
scope/engine if the name is ambiguous). Config is read only when a session is
CREATED, so pass it on the first call for a session; passing it later is
ignored.

Tab: attaching opens a NEW tab by default. To run in a tab that is already
open — one the user set up by hand — take its targetId from
list_cdp_browsers and pass config.cdp: {profile: "<name>", tab:
"targetId:<id>"}. Naming the profile alone leaves their tab untouched and
runs somewhere else.`.trim();

/**
 * The two couplings between the settings, on the tools themselves.
 *
 * A tool description is the only text guaranteed to be in front of the model at
 * the moment it calls, and both of these are the kind of thing that otherwise
 * produces a confident wrong report: asking for an image nobody captured, or
 * being surprised that `capture: "none"` still took pictures.
 */
const SETTINGS_NOTE = `
Settings: model, capture, full_page and send_screenshots stick to the session
until changed — set one once and later calls inherit it. Each run tells you what
it actually used in effectiveSettings; read that rather than assuming, since a
preference set earlier in a conversation is easy to lose track of.

Screenshots come back to you on a FAILURE by default — a picture of the page as
it broke, which is usually the fastest way to see why. Nothing comes back on a
passing run. Pass screenshots_return: "none" to suppress it, and do so when the
page under test holds something the user would not want in this conversation.

Two settings interact, and both surprise people:
  - capture happens BEFORE return. screenshots_return can only hand you a
    picture something took, so "final" needs capture: "every-step" on a passing
    run, and "on-failure" needs capture to include failures.
  - send_screenshots: true forces a capture on every model turn regardless of
    capture, because the model's own request needs the image.`.trim();

export function registerTools(server: McpServer, deps: McpDeps): void {
  // -- run_steps ------------------------------------------------------------
  server.registerTool(
    'run_steps',
    {
      title: 'Run steps',
      description:
        'Run natural-language steps in a real browser session and return per-step results.\n' +
        'Reuses one browser per project unless you pass a session_id, so successive calls ' +
        'share page state and captured variables. Calls on one session run one at a time.\n' +
        'Works without a project too: from a directory with no aiui.config.json, steps run ' +
        'against the machine-wide user root (the result says scope: "user") — but ' +
        '[skill:]/[tool:] steps are refused there, since skills and tools belong to a ' +
        'project.\n\n' +
        CDP_NOTE +
        '\n\n' +
        SETTINGS_NOTE +
        '\n\n' +
        STEP_SYNTAX,
      inputSchema: schemas.runStepsInput,
      outputSchema: schemas.runResultOutput,
    },
    async (args, extra) => {
      const envFiles: string[] = [];
      let baseUrl = '';
      try {
        const { runSettings, screenshotsReturn } = readRunSettings(args);
        const assembled = await assembleSteps({
          resolveProject: deps.resolveProject,
          steps: args.steps,
          projectRoot: args.project_root,
          envName: args.env_name,
          parameters: args.parameters,
          config: args.config,
          runSettings,
        });
        envFiles.push(...assembled.project.envFilesConsulted);
        baseUrl = assembled.project.serverUrl;

        const sessionId =
          args.session_id ??
          defaultSessionId('steps', assembled.project.projectRoot, assembled.request.testFilePath ?? '');
        checkSessionOwnership(sessionId, args.allow_foreign_session === true);

        const outcome = await executeRun({
          deps,
          assembled,
          sessionId,
          screenshotsReturn,
          signal: extra.signal,
          onProgress: progressReporter(extra, assembled),
        });
        return outcomeToResult(outcome);
      } catch (err) {
        if (extra.signal?.aborted) throw err;
        return asToolError(err, envFiles, baseUrl);
      }
    },
  );

  // -- run_test_file --------------------------------------------------------
  server.registerTool(
    'run_test_file',
    {
      title: 'Run a test file',
      description:
        'Run one .md test file end to end and return per-step results, the report path ' +
        'and token totals. Frontmatter environments, data sources and inline sections are ' +
        'all honoured.\n\n' +
        CDP_NOTE +
        '\n\n' +
        SETTINGS_NOTE +
        '\n\n' +
        STEP_SYNTAX,
      inputSchema: schemas.runTestFileInput,
      outputSchema: schemas.runResultOutput,
    },
    async (args, extra) => {
      const envFiles: string[] = [];
      let baseUrl = '';
      try {
        const { runSettings, screenshotsReturn } = readRunSettings(args);
        const assembled = await assembleTestFile({
          resolveProject: deps.resolveProject,
          path: args.path,
          projectRoot: args.project_root,
          envName: args.env_name,
          parameters: args.parameters,
          config: args.config,
          runSettings,
        });
        envFiles.push(...assembled.project.envFilesConsulted);
        baseUrl = assembled.project.serverUrl;

        const sessionId =
          args.session_id ??
          defaultSessionId('file', assembled.project.projectRoot, assembled.request.testFilePath ?? args.path);
        checkSessionOwnership(sessionId, args.allow_foreign_session === true);

        const outcome = await executeRun({
          deps,
          assembled,
          sessionId,
          screenshotsReturn,
          signal: extra.signal,
          onProgress: progressReporter(extra, assembled),
        });
        return outcomeToResult(outcome);
      } catch (err) {
        if (extra.signal?.aborted) throw err;
        return asToolError(err, envFiles, baseUrl);
      }
    },
  );

  // -- list_test_files ------------------------------------------------------
  server.registerTool(
    'list_test_files',
    {
      title: 'List test files',
      description:
        "List the project's test files (absolute paths, sorted). Not filtered by type, so " +
        'a skill file may appear here; run_test_file refuses those.',
      inputSchema: schemas.listTestFilesInput,
      outputSchema: schemas.listTestFilesOutput,
    },
    async (args) => {
      // Not `withProject`: this tool reads the filesystem only, so it neither
      // needs a client nor should require a reachable server to answer.
      let project: Awaited<ReturnType<McpDeps['resolveProject']>> | undefined;
      try {
        // Test files are project-shaped, so this is one of the two tools that
        // refuses rather than falling back to the user root
        // (stories/mcp-no-project.md).
        project = await deps.resolveProject({
          projectRoot: args.project_root,
          requireProject: true,
        });
        const { dir, pattern } = resolveTestsGlob(project);
        // `tests.dir` is confined, but the pattern is not and glob honours
        // `../` inside it — so a hostile or simply wrong `aiui.config.json`
        // could enumerate .md paths outside every allowed root. Filtering the
        // results also covers a symlinked tests directory. Against the
        // CONFIGURED roots, not `allowedRoots()`: this tool requires a project,
        // and its results must stay inside the project boundary rather than the
        // user root that joined the addressing allow-list.
        const roots = configuredRoots();
        const files = (await discoverTestFiles(dir, pattern)).filter((file) =>
          roots.some((root) => isInsideRoot(canonicalize(file), root)),
        );
        return validated(
          schemas.listTestFilesOutput,
          { files, projectRoot: project.projectRoot },
          `${files.length} test file(s) under ${project.projectRoot}`,
        );
      } catch (err) {
        return asToolError(err, project?.envFilesConsulted ?? [], project?.serverUrl ?? '');
      }
    },
  );

  // -- list_sessions --------------------------------------------------------
  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description:
        'List open browser sessions on the server. `owner` distinguishes sessions this MCP ' +
        "server created from another client's (typically a developer's editor).",
      inputSchema: schemas.listSessionsInput,
      outputSchema: schemas.listSessionsOutput,
    },
    async (args) =>
      withProject(deps, args.project_root, async (client, project) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LIST_SESSIONS_TIMEOUT_MS);
        let raw;
        try {
          raw = await client.listSessions(controller.signal);
        } catch (err) {
          if (controller.signal.aborted) {
            return errorResult(listSessionsTimedOut(LIST_SESSIONS_TIMEOUT_MS));
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }

        const sessions = raw.map((s) => ({
          sessionId: s.sessionId,
          owner: s.sessionId.startsWith('mcp:') ? ('mcp' as const) : ('other' as const),
          status: s.status ?? null,
          currentUrl: s.currentUrl ?? null,
          pageTitle: s.pageTitle ?? null,
          totalStepsExecuted: s.totalStepsExecuted ?? null,
          // `?? null` rather than passed through: an older server omits the
          // field entirely, and a MISSING key fails `structuredContent`
          // validation where a null one is fine.
          cdp: s.cdp ?? null,
          tab: s.tab ?? null,
        }));
        return validated(
          schemas.listSessionsOutput,
          { sessions },
          `${sessions.length} open session(s)` +
            // Reported, never silent (stories/mcp-no-project.md): a project-less
            // resolution talks to the user-root server (127.0.0.1:3141), and a
            // caller who expected their project's sessions should see why the
            // list looks unfamiliar rather than read "0 open" off the wrong one.
            (project.scope === 'user'
              ? ` on the user-root server at ${normalizeBaseUrl(project.serverUrl)} (project-less)`
              : ''),
        );
      }),
  );

  // -- close_session --------------------------------------------------------
  server.registerTool(
    'close_session',
    {
      title: 'Close a session',
      description:
        'Close a session and its browser. Closing an unknown session succeeds. Use this to ' +
        'reset a session whose config you want to change, since config is only accepted when ' +
        'a session is first created. Sessions belonging to another client are refused unless ' +
        'allow_foreign_session is set.',
      inputSchema: schemas.closeSessionInput,
      outputSchema: schemas.closeSessionOutput,
    },
    async (args) =>
      withProject(deps, args.project_root, async (client) => {
        // `list_sessions` hands out ids labelled `owner: 'other'`, so without
        // this an agent can close a developer's live TestBench browser mid-run
        // — while the same id would be refused by run_steps. Closing is not
        // less destructive than running; it is more.
        checkSessionOwnership(args.session_id, args.allow_foreign_session === true);
        await client.closeSession(args.session_id);
        return validated(
          schemas.closeSessionOutput,
          { sessionId: args.session_id, closed: true },
          `Closed ${args.session_id}`,
        );
      }),
  );

  // -- get_last_run ---------------------------------------------------------
  server.registerTool(
    'get_last_run',
    {
      title: 'Get last run report',
      description:
        'Report path and token totals for the last finished run on a session. Polls briefly, ' +
        'because the report is written after a run ends — this is the way to recover the ' +
        'report of a run you cancelled.',
      inputSchema: schemas.getLastRunInput,
      outputSchema: schemas.getLastRunOutput,
    },
    async (args) =>
      withProject(deps, args.project_root, async (client, project) => {
        const info = await pollLastRun(client, args.session_id, LAST_RUN_POLL_BUDGET_MS);
        const value = {
          finalized: info !== null,
          reportPath: info?.reportPath ?? null,
          tokens: info?.tokens ?? null,
        };
        return validated(
          schemas.getLastRunOutput,
          value,
          info ? `Report: ${info.reportPath ?? '(none)'}` : 'No finalized run yet',
        );
      }),
  );

  // -- get_run_settings -----------------------------------------------------
  server.registerTool(
    'get_run_settings',
    {
      title: 'Get run settings',
      description:
        'What the next run will use: the model, what gets photographed, and ' +
        'whether the model sees screenshots — plus where each value came from ' +
        '(the server, this project, or something set on this session).\n\n' +
        'Pass session_id to ask about one session. Settings are per session, so ' +
        'the answer for the session you have been running in is the one that ' +
        'matters; without an id you get the server-wide defaults.\n\n' +
        'Reports what is there without starting anything — asking which model is ' +
        'in play should not cause a server to exist. If nothing is running you ' +
        'get running: false rather than an error.\n\n' +
        'Change any of these by passing model / capture / full_page / ' +
        'send_screenshots to run_steps or run_test_file; they stick to the ' +
        'session from then on.',
      inputSchema: schemas.getRunSettingsInput,
      outputSchema: schemas.getRunSettingsOutput,
    },
    async (args, extra) => {
      // Not `withProject`, and for `server_status`'s reason rather than its own:
      // this tool must report "nothing is running" as an ANSWER, not fail on a
      // bare ECONNREFUSED. `withProject`'s identity check would let a down
      // server through and then the fetch below would throw.
      let project: Awaited<ReturnType<McpDeps['resolveProject']>> | undefined;
      try {
        project = await deps.resolveProject({ projectRoot: args.project_root });
        const baseUrl = normalizeBaseUrl(project.serverUrl);
        // Keeps the key away from a squatter — it refuses an unidentified
        // service — while letting a stopped server through, which is the case
        // this tool has to ANSWER rather than fail on. And it never starts one.
        await deps.assertServerRecognized(project, extra.signal);

        const client = deps.createApiClient({ baseUrl: project.serverUrl, apiKey: project.apiKey });
        let report;
        try {
          report = await client.getConfig(args.session_id, extra.signal);
        } catch (err) {
          // A cancelled call is the caller's own doing and must not be reported
          // as a server that is down.
          if (extra.signal?.aborted) throw err;
          // A 404 has two causes and they need different advice, so the one
          // thing that cannot be done is to assume. `GET /config` answers 404
          // for a session it does not hold — but a Sessions API server that
          // PREDATES the endpoint 404s the route itself, and reporting that as
          // "no such session" sends the reader looking for a session when the
          // fix is to restart the server. Measured against a server left running
          // from an earlier build, which is the normal case after a rebuild.
          //
          // Without a session_id a 404 cannot mean "session not found", which
          // settles that case outright; with one, both are named.
          //
          // **If `getConfig` ever grows the `ApiRouteNotFoundError` treatment
          // `focusCdpTab` has, its narrow check goes ABOVE this one.** That
          // class extends `ApiHttpError`, so this arm would swallow it first
          // and emit the ambiguous both-causes message below in place of the
          // crisp route-missing one it would by then have the information to
          // give — a silent downgrade that still looks like it is working.
          if (err instanceof ApiHttpError && err.status === 404) {
            const olderServer =
              `${baseUrl} has no GET /config, so it predates per-session run ` +
              'settings. The server runs compiled dist/ — rebuild and restart it ' +
              '(`aiui stop`, then start it again).';
            return errorResult(
              preflightError(
                args.session_id === undefined
                  ? olderServer
                  : `Either there is no open session "${args.session_id}" on ${baseUrl} — ` +
                      'call list_sessions to see what is open — or ' +
                      olderServer.charAt(0).toLowerCase() + olderServer.slice(1) +
                      '\nCall this again without session_id to tell the two apart: if that ' +
                      'works, the session is the problem.',
              ),
            );
          }
          // An HTTP answer of any status means a server is there and replied, so
          // it goes to the normal error path. A TRANSPORT failure is the "not
          // running" answer — and reporting it as an answer rather than an error
          // is the point: `running: false` with nothing started.
          if (err instanceof ApiHttpError) throw err;
          const detail = err instanceof Error ? err.message : String(err);
          return validated(
            schemas.getRunSettingsOutput,
            {
              baseUrl,
              running: false,
              detail,
              projectRoot: project.projectRoot,
              scope: project.scope,
              sessionId: args.session_id ?? null,
              model: null,
              capture: null,
              fullPage: null,
              sendScreenshots: null,
              sources: null,
              overrides: null,
              serverDefaults: null,
            },
            `No server answered at ${baseUrl} (${detail}). Nothing was started to find out.`,
          );
        }

        // The session's values when one was named, the server's otherwise. Both
        // are reported so "is this a default or did someone change it?" is
        // answerable from one call.
        const effective = report.session?.effective ?? report.server;
        const overrides = report.session?.overrides;
        const value = {
          baseUrl,
          running: true,
          detail: null,
          projectRoot: project.projectRoot,
          scope: project.scope,
          sessionId: report.session?.sessionId ?? null,
          model: effective.model,
          capture: effective.capture,
          fullPage: effective.fullPage,
          sendScreenshots: effective.sendScreenshots,
          sources: effective.sources,
          overrides:
            overrides === undefined
              ? null
              : {
                  // `?? null` per key: an absent key means "not overridden",
                  // and a missing one would fail output validation outright.
                  model: overrides.model ?? null,
                  capture: overrides.capture === 'default' ? null : (overrides.capture ?? null),
                  fullPage: overrides.fullPage ?? null,
                  sendScreenshots: overrides.sendScreenshots ?? null,
                },
          serverDefaults: {
            model: report.server.model,
            capture: report.server.capture,
            fullPage: report.server.fullPage,
            sendScreenshots: report.server.sendScreenshots,
          },
        };
        return validated(
          schemas.getRunSettingsOutput,
          value,
          `${report.session ? `Session ${report.session.sessionId}` : 'Server defaults'}: ` +
            `model ${effective.model} (${effective.sources.model}), capture ` +
            `${effective.capture} (${effective.sources.capture}), model sees ` +
            `screenshots: ${effective.sendScreenshots ? 'yes' : 'no'}`,
        );
      } catch (err) {
        return asToolError(err, project?.envFilesConsulted ?? [], project?.serverUrl ?? '');
      }
    },
  );

  // -- get_page_content -----------------------------------------------------
  server.registerTool(
    'get_page_content',
    {
      title: 'Read a session\'s current page',
      description:
        'Read the current page of a session: its visible text, or its cleaned ' +
        'DOM. Returns the page as-is — nothing is summarised or interpreted ' +
        'for you, so budget for reading it yourself.\n\n' +
        '`format: "text"` (default) for what the page says. ' +
        '`format: "dom"` when you need element structure to pick a selector — ' +
        'it is much larger, so prefer text unless you are about to act on an ' +
        'element.\n\n' +
        'Narrow with `selector` rather than raising `max_chars`: a truncated ' +
        'result tells you it was truncated, and reading a bigger slice of the ' +
        'wrong part of the page costs context without answering anything.\n\n' +
        'The two formats differ on `aria-hidden` content: `text` includes it ' +
        '(it is on screen for a sighted user), and a whole-page `dom` read ' +
        'drops it as noise.\n\n' +
        'This reads whatever is on screen right now. It does not wait for the ' +
        'page to settle, and if a run is in flight `status` comes back ' +
        '`executing` — the page may move under you.',
      inputSchema: schemas.getPageContentInput,
      outputSchema: schemas.getPageContentOutput,
    },
    async (args, extra) =>
      withProject(
        deps,
        args.project_root,
        async (client) => {
          // A page read is not the harmless end of the foreign-session
          // question — it is the disclosing one. A developer's session may be
          // driving a CDP browser holding real logins, and this returns the
          // full text of whatever tab is open. The repo already withholds
          // foreign CDP tab titles and URLs by default; handing over the page
          // body unprompted would undo that policy through a side door.
          checkSessionOwnership(
            args.session_id,
            args.allow_foreign_session === true,
            'reading its page would disclose whatever they are signed in to',
          );

          // A screenshot needs no new capture code: `GET /sessions/:id` has
          // always carried one, and the MCP simply did not expose it
          // (stories/run-settings.md §7). Handled before the text path because
          // it is a different endpoint, not a different query parameter.
          if (args.format === 'screenshot') {
            // Refused rather than ignored. A selector says "read this element",
            // and a viewport shot is the whole screen — silently widening the
            // read is exactly what the text path 400s on for the same argument.
            if (args.selector !== undefined) {
              return errorResult(
                preflightError(
                  'selector does not apply to format: "screenshot" — a screenshot is ' +
                    'always of the whole viewport. Drop the selector, or use ' +
                    'format: "text"/"dom" to read one element.',
                ),
              );
            }
            return await screenshotResult(client, args.session_id, extra.signal);
          }

          const page = await client.getPageContent(
            args.session_id,
            {
              format: args.format,
              selector: args.selector,
              maxChars: args.max_chars,
            },
            extra.signal,
          );

          const scope = page.selector ? ` (${page.selector})` : '';
          const size = page.truncated
            ? `${page.returnedChars} of ${page.availableChars}+ chars — narrow with a selector to see the rest`
            : `${page.returnedChars} chars`;
          // Normalised the way `list_sessions` normalises: a MISSING key fails
          // `structuredContent` validation outright, so an older or partial
          // server response would cost the agent the page it just read
          // successfully. Nulling/defaulting keeps a good read usable.
          //
          // `content` is deliberately NOT defaulted. Substituting '' for a
          // missing body would tell the agent the page is empty when what
          // actually happened is that we never received it — the one confusion
          // this whole feature is built to prevent, and not a trade worth
          // making to salvage a response that is already malformed.
          if (typeof page.content !== 'string') {
            throw new Error(
              'The Sessions API returned a page-content response with no `content` field. ' +
                'This is a bug in the server, not a page that is empty.',
            );
          }
          const value = {
            sessionId: page.sessionId ?? args.session_id,
            url: page.url ?? '',
            title: page.title ?? '',
            status: page.status ?? 'active',
            format: page.format ?? 'text',
            selector: page.selector ?? null,
            content: page.content,
            truncated: page.truncated ?? false,
            returnedChars: page.returnedChars ?? 0,
            availableChars: page.availableChars ?? 0,
          };
          // No `extra` block holding the raw page. This tool used to append one
          // itself, because a host that surfaces only content blocks would
          // otherwise get `"Invoices — text, 2995 chars"` — a description of
          // the page instead of the page, with no error and a plausible count,
          // and the model then reports on a page it never saw. That reasoning
          // still stands; `validated()` now does it for every tool, so the
          // page arrives inside the serialized `structuredContent` block.
          //
          // Adding one on top would ship the page three times (raw, again
          // inside the JSON, and once more in `structuredContent`) — measured
          // at 2.05x the page against 1.05x for letting the standard block
          // carry it. The 5% is JSON escaping and keys.
          //
          // It still travels twice and still must: declaring an `outputSchema`
          // obliges the SDK to require `structuredContent`. What changed is
          // that the content-block copy is now escaped text inside an object.
          // No human reader pays for that — Claude Code records only
          // `structuredContent`, and opencode's TUI hides tool output by
          // default — so the copy that changes is the model's, on
          // content-only hosts, and a model reads escaped JSON fine.
          return validated(
            schemas.getPageContentOutput,
            value,
            `${page.title || page.url}${scope} — ${page.format}, ${size}`,
          );
        },
        { signal: extra.signal },
      ),
  );

  // -- list_cdp_browsers ----------------------------------------------------
  server.registerTool(
    'list_cdp_browsers',
    {
      title: 'List CDP browsers',
      description:
        'Persistent CDP browsers and profiles — the project\'s AND the ' +
        'user\'s machine-wide ones, every entry tagged with `scope`. Works ' +
        'with no project at all: user-root browsers (scope "user") are ' +
        'reachable from any directory, forever.\n\n' +
        '`running` — live browsers. Pass one of these ports as ' +
        'config.cdp.port to run steps in it.\n' +
        '`available` — profiles that exist but have nothing running. **These ' +
        'are directories, not browsers**; call start_cdp_browser with the ' +
        'profile name before sending steps to it. A profile keeps its logins ' +
        'while dormant.\n' +
        '`foreign` — browsers tracing back to neither root. Reported so you ' +
        'can see them; you cannot drive them unless a human sets ' +
        'mcp.cdp.allowUnowned, and their tab titles and URLs are withheld.\n\n' +
        'This covers CDP browsers only. Tests running in ordinary launch mode ' +
        'also have browsers, but those are disposable per-session ones with ' +
        'no CDP port — they appear in **list_sessions**. If the question is ' +
        'open-ended ("what browsers do I have?"), call both.',
      inputSchema: schemas.listCdpBrowsersInput,
      outputSchema: schemas.listCdpBrowsersOutput,
    },
    async (args) =>
      withProject(deps, args.project_root, async (client, project) => {
        const browsers = await client.getCdpBrowsers({
          projectRoot: project.projectRoot,
          includeForeign: true,
          includeForeignTabs: maySeeForeignTabs(project.cdpPermissions),
        });
        // `sessionId` is required-and-nullable in the output schema, so a
        // server that predates the field would fail validation outright and
        // degrade the whole listing to `isError` with nothing readable in it —
        // killing the first call of the tab flow against a Sessions API server
        // left running from an earlier build. Normalised here for the same
        // reason `list_sessions` normalises `tab`. `scope` gets the same
        // treatment: a server that predates the two-root sweep can only have
        // swept the project root, so its unlabelled entries read `project`.
        const normalized = {
          scope: project.scope,
          ...browsers,
          running: browsers.running.map((b) => ({
            ...b,
            scope: b.scope ?? 'project',
            tabs: b.tabs.map((t) => ({ ...t, sessionId: t.sessionId ?? null })),
          })),
          available: browsers.available.map((b) => ({ ...b, scope: b.scope ?? 'project' })),
        };
        const summary =
          summarizeBrowsers(normalized) +
          (project.scope === 'user'
            ? ` — project-less, so only the user root at ${project.projectRoot} was swept`
            : '');
        return validated(
          schemas.listCdpBrowsersOutput,
          normalized as unknown as Record<string, unknown>,
          summary,
        );
      }),
  );

  // -- start_cdp_browser ----------------------------------------------------
  server.registerTool(
    'start_cdp_browser',
    {
      title: 'Start a CDP browser',
      description:
        'Launch a headed Chrome or Edge and return the port to drive it ' +
        'through. It belongs to this project by default, or to the ' +
        'machine-wide user root with scope: "user" (the only option, and the ' +
        'default, when no project resolved). Returns the **already-running** ' +
        'browser if that profile has one — the profile name is what selects ' +
        'between browsers, so asking twice does not start two.\n\n' +
        'You almost never need project_root — omit it. For the user\'s own ' +
        'browser (their real logins), pass scope: "user"; do NOT invent a ' +
        'project_root such as the current or home directory — an out-of-bounds ' +
        'path is refused, and guessing is never the right move.\n\n' +
        'A profile is a directory that persists. Sign in by hand once and the ' +
        'login survives closing the browser, restarting the server, and ' +
        'restarting this agent — that is the point of the feature.\n\n' +
        'Read `outcome` and tell the user which happened, because they mean ' +
        'different things:\n' +
        '- `launched_into_new_profile` — empty browser. **A human must sign ' +
        'in before tests against a logged-in site will work.**\n' +
        '- `launched_into_existing_profile` — the profile already existed. ' +
        '**It may already be signed in, possibly as someone else.** Say so ' +
        'rather than reporting it as newly created — a permission test can ' +
        'otherwise run as the wrong user and pass for the wrong reason.\n' +
        '- `reused_running_browser` — it was already open; tabs are wherever ' +
        'they were left.\n' +
        '- `launched_after_reset` — deliberately empty; a sign-in flow will ' +
        'be exercised.\n\n' +
        'Asking for a profile that already exists is **not** an error and ' +
        'does not create anything new. To get a genuinely new browser, pass a ' +
        'new `profile` name. To get a genuinely empty one, pass `reset: true`.\n\n' +
        'Several tests can run against one browser at the same time, which is ' +
        'often what is wanted — but they share one profile and therefore one ' +
        'set of cookies. A test that signs out, or logs in as someone else, ' +
        'affects the others. Warn the user before running tests in parallel ' +
        'when that could matter; suites that need isolation should use ' +
        'ordinary launch mode, which gives every test a fresh browser.',
      inputSchema: schemas.startCdpBrowserInput,
      outputSchema: schemas.startCdpBrowserOutput,
    },
    async (args, extra) =>
      withProject(
        deps,
        args.project_root,
        async (client, project) => {
          // Refused here rather than at the server so the agent gets §7's prose
          // instead of an HTTP 400 — same rule, better message, one fewer
          // round-trip. The server validates independently; this is not the
          // only check.
          if (args.profile !== undefined && !/^[A-Za-z0-9._-]+$/.test(args.profile)) {
            return errorResult(badCdpProfileName(args.profile));
          }
          // Which root the browser lives under (stories/mcp-no-project.md).
          // Unstated keeps today's behaviour — the resolved root, which for a
          // project-less call IS the user root. `scope: "user"` from inside a
          // project reaches the machine-wide browser; `scope: "project"` with
          // no project resolved is a contradiction to refuse, not to shrug at
          // — silently landing it in the user root would put "the project's
          // admin browser" somewhere no project can claim it.
          const scope = args.scope ?? project.scope;
          if (scope === 'project' && project.scope === 'user') {
            return errorResult(
              preflightError(
                'scope: "project" was asked for, but no project resolved — this ' +
                  'call is running project-less, and only the machine-wide user ' +
                  'root is available.\n' +
                  'Run from inside a project (or pass project_root) for a ' +
                  'project-scoped browser, or drop scope to use the user root.',
              ),
            );
          }
          // When the resolution itself is user scope, its projectRoot IS the
          // canonicalized user root — prefer it over re-deriving, so there is
          // exactly one place that decides what that path is. `userRootDir()`
          // is only for the crossing case: a project-scoped call asking for
          // the machine-wide browser.
          const launchRoot =
            scope === 'project' || project.scope === 'user'
              ? project.projectRoot
              : userRootDir();
          const started = await client.startCdpBrowser({
            projectRoot: launchRoot,
            engine: args.engine,
            ...(args.profile !== undefined ? { profile: args.profile } : {}),
            ...(args.reset === true ? { reset: true } : {}),
          });
          // A Sessions API server predating the field cannot have honoured a
          // user-scope launch root any differently — the root IS the scope —
          // so the ask is the truth when the echo is missing.
          const result = { ...started, scope: started.scope ?? scope };
          return validated(
            schemas.startCdpBrowserOutput,
            result as unknown as Record<string, unknown>,
            `${result.engine} "${result.profile}"${result.scope === 'user' ? ' (user root)' : ''} ` +
              `on port ${result.port} — ${result.outcome}` +
              (result.warnings.length > 0 ? `\n${result.warnings.join('\n')}` : ''),
          );
        },
        // Auto-start is the default; a down loopback server is brought up
        // rather than failing this launch on connect.
        { signal: extra.signal },
      ),
  );

  // -- close_cdp_tab --------------------------------------------------------
  server.registerTool(
    'close_cdp_tab',
    {
      title: 'Close a CDP browser tab',
      description:
        'Close one tab in a CDP browser — normally one this project launched.\n\n' +
        'Call **list_cdp_browsers** first and match the user\'s words ("the ' +
        'openrouter tab") against the tab titles and urls **yourself**, then ' +
        'pass that tab\'s exact `targetId`. There is deliberately no fuzzy ' +
        'matching here: closing the wrong tab cannot be undone, and you are ' +
        'better at "which one did they mean" than a substring rule.\n\n' +
        'This closes a real tab in the user\'s own signed-in browser window, ' +
        'so relay what was closed rather than only that it worked.\n\n' +
        'Two refusals, both of which tell you what to do next:\n' +
        '- **A session is driving that tab.** Close it with close_session ' +
        'first, or leave the tab alone if the session is still wanted.\n' +
        '- **It is the browser\'s last tab.** Closing that closes the browser ' +
        'itself — there is no browser with zero tabs. Pass ' +
        '`allow_browser_exit: true` if that is what the user wants. For a ' +
        'browser **this project started**, nothing is lost — the profile ' +
        'keeps its logins on disk and start_cdp_browser reopens it still ' +
        'signed in. For any other browser (only reachable with ' +
        'mcp.cdp.allowUnowned) nothing here can reopen it or restore what it ' +
        'was signed into, so **ask the user first**. The result\'s `owned` ' +
        'field tells you which case you are in.\n\n' +
        'To close a whole window, close its tabs one at a time — a window ' +
        'disappears with its last tab. This tool does not touch ordinary ' +
        'launch-mode session browsers; those belong to their session and end ' +
        'with it (see close_session).',
      inputSchema: schemas.closeCdpTabInput,
      outputSchema: schemas.closeCdpTabOutput,
    },
    async (args, extra) =>
      withProject(
        deps,
        args.project_root,
        async (client, project) => {
          // Same address rule as `config.cdp`: `profile` or `port`, or both
          // when they agree. Refused only when the pair disagrees, for the
          // same reason as there — two addresses pointing at different
          // browsers have no correct winner, and this call closes something.
          const { port, gateOwed, scope: resolvedScope } = await resolveCdpTarget(
            client,
            project.projectRoot,
            {
              ...(args.profile !== undefined ? { profile: args.profile } : {}),
              ...(args.engine !== undefined ? { engine: args.engine } : {}),
              ...(args.scope !== undefined ? { scope: args.scope } : {}),
              ...(args.port !== undefined ? { port: args.port } : {}),
            },
            extra.signal,
            // The tool's own field names, so the refusal names arguments this
            // call actually has.
            cdpTabTargetAmbiguous,
          );
          // A port resolved from the caller's own `running` list is owned by
          // construction. A caller-supplied one is not, and closing tabs in a
          // browser is at least as intrusive as driving it — so it clears the
          // same gate, with the same human-held opt-in behind it.
          if (gateOwed) {
            await assertPortAttachable(
              client,
              project.projectRoot,
              port,
              project.cdpPermissions,
              project.configPath,
              extra.signal,
            );
          }

          const closed = await client.closeCdpTab(
            {
              projectRoot: project.projectRoot,
              port,
              targetId: args.target_id,
              ...(args.allow_browser_exit === true ? { allowBrowserExit: true } : {}),
              // Read directly rather than through `maySeeForeignTabs`, which
              // asks a different question (may this agent SEE a foreign
              // browser's tab titles) that happens to consult the same field.
              // Without this the gate above would let a foreign port through
              // and the server would refuse it anyway with an unrelated "not a
              // browser this project has running" — an opt-in that grants
              // nothing.
              ...(project.cdpPermissions.allowUnowned ? { allowUnowned: true } : {}),
            },
            extra.signal,
          );

          // Normalised for the same reason `list_cdp_browsers` normalises
          // `sessionId`, and it matters more here: this field is required by
          // the output schema, so a Sessions API server predating it fails
          // validation — and that lands AFTER the tab has already been closed.
          // The agent is told the tool is broken, retries, and gets "something
          // else closed it first", so the user hears the close failed twice
          // about a tab that is gone.
          //
          // **Derived, not defaulted to `true`.** An earlier version assumed a
          // server without the field could not close an unowned browser; that
          // is false for a mid-branch server that gained `allowUnowned` before
          // it gained `owned`, and the assumption failed in the dangerous
          // direction — reporting a human's just-terminated browser as ours
          // and repeating the "the profile keeps its logins" reassurance about
          // something nothing here can reopen. Two things we know locally
          // settle it without asking the server:
          //   - a port resolved from a profile came out of this project's own
          //     `running` list, so it is owned by construction;
          //   - with `allowUnowned` off, the gate above already proved the port
          //     is in `running`.
          // Anything else is genuinely unknown, and unknown resolves to
          // `false`, whose message is the cautious one.
          const certainlyOwned = !gateOwed || !project.cdpPermissions.allowUnowned;
          const result = {
            ...closed,
            owned: closed.owned ?? certainlyOwned,
            // The server's echo when it sent one; else the scope the profile
            // resolution matched; else null — "unknown" and "foreign" both
            // land there, and the summary already distinguishes via `owned`.
            scope: closed.scope ?? resolvedScope ?? null,
            warnings: closed.warnings ?? [],
          };

          // The summary is all a host that ignores structured content will
          // show, so it carries the two things a user asked "close the
          // openrouter tab" actually wants back: which tab went, and whether
          // the browser went with it.
          const what = closed.title || closed.url || closed.targetId;
          const browser = result.owned
            ? `${result.engine} "${result.profile}"${result.scope === 'user' ? ' (user root)' : ''}`
            : `the browser on port ${result.port}`;
          const aftermath = result.browserExited
            // Not "that was its last tab" — the tab count and the browser's own
            // idea of what keeps it alive can disagree (browser dialogs report
            // as page targets). What is certainly true is that the browser went.
            ? ` — ${browser} closed with it` +
              // True only of a browser we own. Claiming it for someone else's
              // browser tells the user a terminated session is recoverable
              // when nothing here can bring it back.
              (result.owned
                ? ' (the profile keeps its logins)'
                : ' — this project did not start it, so nothing here can reopen it')
            : `; ${result.remainingTabs} tab${result.remainingTabs === 1 ? '' : 's'} left`;
          return validated(
            schemas.closeCdpTabOutput,
            result as unknown as Record<string, unknown>,
            `Closed "${what}"${aftermath}` +
              (result.warnings.length > 0 ? `\n${result.warnings.join('\n')}` : ''),
          );
        },
        // Auto-start is the default; a close against a stopped server brings
        // it up rather than dying on a bare ECONNREFUSED.
        { signal: extra.signal },
      ),
  );

  // -- focus_cdp_tab --------------------------------------------------------
  server.registerTool(
    'focus_cdp_tab',
    {
      title: 'Show a CDP browser tab',
      description:
        'Bring one tab of a CDP browser to the front, so the user can see it. ' +
        'Takes the exact `targetId` from **list_cdp_browsers** — call that ' +
        'first and match the user\'s words ("the openrouter tab") against the ' +
        'titles and urls yourself.\n\n' +
        'This moves a real window on the user\'s screen. Say which tab you ' +
        'brought forward, not just that it worked — the result carries its ' +
        '`title` and `url`.\n\n' +
        '`focused: true` means the browser accepted the request. Whether the ' +
        'window actually came to the front is not something this can read ' +
        'back, and an operating system may refuse to raise a background ' +
        'application\'s window. If the user needs to see Chrome and the host ' +
        'offers an OS-level window-focus tool, match the tab title to the ' +
        'Chrome window title and use that tool. Otherwise, ask the user to ' +
        'click the browser in their taskbar rather than calling this again.\n\n' +
        'It changes nothing else: no tab is closed, no session is created, and ' +
        'a run in flight elsewhere keeps running — automation drives a tab ' +
        'whether or not it is visible. So this is for **showing a human ' +
        'something**, and it is not a way to make steps run somewhere; that is ' +
        '`config.cdp.tab` on a new session. It is safe to call on a tab a ' +
        'session is driving, which is the usual reason to want it.',
      inputSchema: schemas.focusCdpTabInput,
      outputSchema: schemas.focusCdpTabOutput,
    },
    async (args, extra) =>
      withProject(
        deps,
        args.project_root,
        async (client, project) => {
          const { port, gateOwed, scope: resolvedScope } = await resolveCdpTarget(
            client,
            project.projectRoot,
            {
              ...(args.profile !== undefined ? { profile: args.profile } : {}),
              ...(args.engine !== undefined ? { engine: args.engine } : {}),
              ...(args.scope !== undefined ? { scope: args.scope } : {}),
              ...(args.port !== undefined ? { port: args.port } : {}),
            },
            extra.signal,
            cdpFocusTargetAmbiguous,
          );
          // The same gate as attaching and closing. Non-destructive is not the
          // same as unobtrusive: focusing a tab in someone else's browser yanks
          // their screen and reveals which tab they are being shown.
          if (gateOwed) {
            await assertPortAttachable(
              client,
              project.projectRoot,
              port,
              project.cdpPermissions,
              project.configPath,
              extra.signal,
            );
          }

          let focused;
          try {
            focused = await client.focusCdpTab(
              {
                projectRoot: project.projectRoot,
                port,
                targetId: args.target_id,
                // Read directly rather than through `maySeeForeignTabs`, which
                // asks a different question that happens to consult the same
                // field. Without it the gate above would let a foreign port
                // through and the server would refuse it anyway.
                ...(project.cdpPermissions.allowUnowned ? { allowUnowned: true } : {}),
              },
              extra.signal,
            );
          } catch (err) {
            // The one status worth splitting: 404 means the tab is gone OR the
            // route is, and telling a user their tab was closed when the real
            // answer is "rebuild the server" sends them looking for a window
            // that is still sitting there. The client distinguishes them by
            // type — checked first, since it is the narrower one.
            if (err instanceof ApiRouteNotFoundError) {
              return errorResult(cdpFocusRouteMissing(normalizeBaseUrl(project.serverUrl)));
            }
            if (err instanceof ApiHttpError && err.status === 404) {
              return errorResult(cdpFocusTabNotFound(err.serverMessage));
            }
            throw err;
          }

          // Normalised for the same reason `close_cdp_tab` normalises its own:
          // `warnings` is required by the output schema, so a Sessions API
          // server that omits it would fail validation and degrade a working
          // result to `isError` with nothing readable in it.
          const result = {
            ...focused,
            scope: focused.scope ?? resolvedScope ?? null,
            warnings: focused.warnings ?? [],
          };

          const what = result.title || result.url || result.targetId;
          const browser = result.profile
            ? `${result.engine} "${result.profile}"${result.scope === 'user' ? ' (user root)' : ''}`
            : `the browser on port ${result.port}`;
          return validated(
            schemas.focusCdpTabOutput,
            result as unknown as Record<string, unknown>,
            `Requested activation of "${what}" in ${browser}` +
              (result.warnings.length > 0 ? `\n${result.warnings.join('\n')}` : ''),
          );
        },
        // Auto-start is the default; a stopped server is brought up rather
        // than surfaced as a bare ECONNREFUSED.
        { signal: extra.signal },
      ),
  );

  // -- server_status --------------------------------------------------------
  server.registerTool(
    'server_status',
    {
      title: 'Server status',
      description:
        'Health of the Sessions API server. Reports what is there without starting anything — ' +
        'asking whether a server is running should not cause one to exist.',
      inputSchema: schemas.serverStatusInput,
      outputSchema: schemas.serverStatusOutput,
    },
    async (args) => {
      // Not `withProject` either: this tool's whole job is to report what is
      // there, including "nothing" and "something unrecognised" — so it must
      // neither start a server nor refuse an unidentified one.
      let project: Awaited<ReturnType<McpDeps['resolveProject']>> | undefined;
      try {
        project = await deps.resolveProject({ projectRoot: args.project_root });
        const baseUrl = normalizeBaseUrl(project.serverUrl);
        const probe = await probeHealth(baseUrl, 2_000);
        const value =
          probe.kind === 'ok'
            ? {
                baseUrl,
                running: true,
                detail: null,
                version: probe.health.version,
                pid: probe.health.pid,
                startedAt: probe.health.startedAt,
                openSessions: probe.health.openSessions,
                runsInFlight: probe.health.runsInFlight,
                inspector: probe.health.inspector,
                idleTimeoutMinutes: probe.health.idleTimeoutMinutes,
              }
            : {
                baseUrl,
                running: false,
                detail: probe.detail,
                version: null,
                pid: null,
                startedAt: null,
                openSessions: null,
                runsInFlight: null,
                inspector: null,
                idleTimeoutMinutes: null,
              };
        return validated(
          schemas.serverStatusOutput,
          value,
          probe.kind === 'ok'
            ? `Running at ${baseUrl} (v${probe.health.version}, ${probe.health.openSessions} session(s))`
            : `Not usable at ${baseUrl}: ${probe.detail}`,
        );
      } catch (err) {
        return asToolError(err, project?.envFilesConsulted ?? [], project?.serverUrl ?? '');
      }
    },
  );
}

/**
 * Progress callback, or undefined when the host did not ask for progress.
 *
 * No token means no notifications and the call rides the host's fixed timeout —
 * which is the real risk with long runs, and nothing we can do about from here.
 */
interface ProgressNotification {
  method: 'notifications/progress';
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

function progressReporter(
  extra: {
    _meta?: { progressToken?: string | number | undefined } | undefined;
    // Narrower than the SDK's notification union on purpose: a handler that
    // accepts more is assignable to one that accepts less, so this both
    // typechecks against the real `extra` and stops anything but a progress
    // notification being sent from here.
    sendNotification?: ((n: ProgressNotification) => Promise<void>) | undefined;
  },
  assembled: AssembledRun,
): ((completed: number, text: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) return undefined;

  // `total` is only honest while the sent list and the executed list are the
  // same length. Server-side expansion breaks that, so it is omitted rather
  // than reported wrong.
  const expansionPossible =
    assembled.request.skillsDir !== undefined || assembled.request.sections !== undefined;
  const total = expansionPossible ? undefined : assembled.sentSteps.length;

  return (completed, message) => {
    void extra.sendNotification?.({
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress: completed,
        ...(total !== undefined ? { total } : {}),
        message,
      },
    });
  };
}
