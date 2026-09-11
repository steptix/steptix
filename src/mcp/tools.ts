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
import path from 'node:path';
import {
  isCodeStep,
  assembleSteps,
  assembleTestFile,
  unresolvablePlaceholderWarning,
} from './assemble.js';
import {
  badCdpProfileName,
  cdpFocusRouteMissing,
  cdpFocusTabNotFound,
  cdpFocusTargetAmbiguous,
  cdpTabHeldByErrand,
  cdpTabTargetAmbiguous,
  describeBrowser,
  errandCodeSteps,
  errandDidNotAttach,
  errandTabAmbiguous,
  errandTabHeldByErrand,
  errandTabHeldBySession,
  errandTabNotFound,
  errandsHaveNoSessions,
  listSessionsTimedOut,
  pageContentSessionGone,
  navigateNeedsExactTarget,
  peekRouteMissing,
  peekScreenshotArgConflict,
  peekScreenshotMissing,
  peekScreenshotTooLarge,
  peekSessionsAreForGetPageContent,
  peekTabAmbiguous,
  peekTabGoneNow,
  peekTabNotFound,
  preflightError,
  unauthorized,
  type McpToolError,
} from './errors.js';
import {
  assertPortAttachable,
  matchTabsByName,
  maySeeForeignTabs,
  resolveCdpTarget,
  summarizeBrowsers,
} from './cdp.js';
import { configuredRoots, canonicalize, isInsideRoot, resolveTestsGlob } from './project.js';
import { userRootDir } from '../env/user-root.js';
import { discoverTestFiles } from '../parser/markdown.js';
import {
  DATA_URI_PREFIX,
  MAX_SCREENSHOT_BASE64,
  STREAM_DROPPED_WARNING,
  foldRun,
  readErrandSummary,
  type FoldedEffectiveSettings,
  type FoldedRun,
  type FoldedStep,
} from './run-fold.js';
import { withSession } from './registry.js';
import * as schemas from './schemas.js';
import { probeHealth, normalizeBaseUrl } from '../server/health.js';
import {
  ApiHttpError,
  ApiRouteNotFoundError,
  DEFAULT_SCREENSHOTS_RETURN,
  PreflightFailure,
  type AiMode,
  type ApiClient,
  type AssembledRun,
  type CaptureMode,
  type CdpTab,
  type ErrandRequestBody,
  type ErrandTab,
  type McpDeps,
  type PeekedTab,
  type ProjectContext,
  type RunEvent,
  type RunSettings,
  type ScreenshotsReturn,
  type StreamResult,
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
  ai?: AiMode | undefined;
  screenshots_return?: ScreenshotsReturn | 'default' | undefined;
}): { runSettings: RunSettings; screenshotsReturn: ScreenshotsReturn } {
  const runSettings: RunSettings = {};
  if (args.model !== undefined) runSettings.model = args.model;
  if (args.capture !== undefined) runSettings.capture = args.capture;
  if (args.full_page !== undefined) runSettings.fullPage = args.full_page;
  if (args.send_screenshots !== undefined) runSettings.sendScreenshots = args.send_screenshots;
  if (args.ai !== undefined) runSettings.ai = args.ai;
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
    //
    // `step:skip` is a terminal event too — the only one a step a return left
    // behind ever gets (stories/step-flow-control.md, decision 9). Without it
    // a run that returns stalls the progress bar wherever the return happened
    // and never reaches `total`, which reads as a run that hung.
    let completed = 0;
    const onEvent = (event: RunEvent): void => {
      if (event.type === 'step:pass' || event.type === 'step:fail' || event.type === 'step:skip') {
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
  //
  // The ending is the story's "wrong doors redirect" layer (stories/errands.md
  // §Routing 4): this warning fires on exactly the request errands were built
  // for — "use my open tab" — so it names the door that would have worked.
  if (request.config?.cdp !== undefined && !outcome.configApplied) {
    outcome.warnings = [
      ...outcome.warnings,
      `config.cdp was ignored: session "${sessionId}" already existed, and a ` +
        "session's browser is fixed when the session is created. These steps ran " +
        "in that session's existing browser, NOT the CDP one. To use the CDP " +
        `browser: close_session "${sessionId}", then run again — or use ` +
        'run_errand if you just want to drive that tab.',
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
  opts: {
    autoStart?: boolean;
    /** Layers `.env.<name>` the same way the run tools do. Only `run_errand`
     *  passes one — every other tool through here reads no environment. */
    envName?: string | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<ToolResult> {
  let project: Awaited<ReturnType<McpDeps['resolveProject']>> | undefined;
  try {
    project = await deps.resolveProject({
      projectRoot,
      ...(opts.envName !== undefined && { envName: opts.envName }),
    });
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

/**
 * The step count on the one line a host that ignores structured output shows.
 *
 * `3/7 steps passed` for as long as nothing is skipped — byte for byte the
 * sentence this line has always carried. Once a return leaves steps unrun
 * (stories/step-flow-control.md), that sentence is a lie by omission: a run
 * that returned reports `PASSED — 3/7 steps passed`, which reads as four
 * failures on a run that is green, and the agent reading it has no way to tell
 * this from a genuinely partial run. So the skipped ones are counted out loud,
 * and named as deliberate.
 *
 * `verb` is the word that follows a plain `N/M steps` count in the caller's own
 * sentence — `passed` for a run, empty for the errand receipt, whose frame
 * supplies `in "<tab>"`. It is dropped once the tally spells the statuses out,
 * because `… of 7 passed` would say "passed" twice.
 *
 * Three different things reach the fold as `skipped` and the clause names
 * whichever actually happened, counted apart. A return, and a branch a
 * decision did not choose, are both the test doing what it was told and need
 * nothing from the reader; an `[input:]` / `[interactive]` step the server
 * declined to run unattended needs a human before it can ever pass, and the
 * fold already warns about it in those words. One clause for all three would
 * send the agent after the wrong thing most of the time, so a run that managed
 * several says several.
 *
 * A TOLERATED failure earns a clause of its own for the same reason
 * (stories/step-failure-outcomes.md, decision 9): it is `failed` and it is not why
 * the run is not green, so both halves have to be said — `7 passed, 1 failed
 * (tolerated) of 8`. Counted as neither a pass nor a plain failure.
 */
function stepTally(
  steps: readonly Pick<FoldedStep, 'status' | 'skipCause' | 'tolerated'>[],
  verb: string,
): string {
  const passed = steps.filter((s) => s.status === 'passed').length;
  const skipped = steps.filter((s) => s.status === 'skipped');
  const tolerated = steps.filter((s) => s.status === 'failed' && s.tolerated === true).length;
  if (skipped.length === 0 && tolerated === 0) {
    return `${passed}/${steps.length} steps${verb ? ` ${verb}` : ''}`;
  }
  // An older server sends no `step:skip` and no `skipKind`, so a row can be
  // `skipped` with no cause recorded. It came from `output: 'skipped'` — the
  // only other source — which on such a server is the unattended one.
  const returned = skipped.filter((s) => s.skipCause === 'returned').length;
  const notTaken = skipped.filter((s) => s.skipCause === 'not-taken').length;
  const unattended = skipped.length - returned - notTaken;
  const clauses = [
    returned > 0 ? `${returned} skipped (a step returned early)` : '',
    notTaken > 0 ? `${notTaken} skipped (a branch that was not taken)` : '',
    unattended > 0 ? `${unattended} skipped (need a human)` : '',
    tolerated > 0 ? `${tolerated} failed (tolerated)` : '',
  ].filter((c) => c !== '');
  return `${passed} passed, ${clauses.join(', ')} of ${steps.length}`;
}

/**
 * The author's own sentence for each tolerated failure, one line apiece
 * (stories/step-failure-outcomes.md, decision 6).
 *
 * The tally above says a step failed and was tolerated; only this says WHY the
 * author expected it. On the content lines rather than the row alone, because a
 * host that renders only content blocks sees nothing of `structuredContent` — and
 * the warning is the one thing on a tolerated row an agent should read instead of
 * the error. Rows with no warning are silent: the tally has counted them, and
 * `error` is the framework's account, which is not what to act on here.
 */
function toleratedWarningLines(steps: readonly FoldedStep[]): string[] {
  return steps
    .filter((s) => s.status === 'failed' && s.tolerated === true && s.warning !== undefined)
    .map((s) => `Tolerated on line ${s.line}: ${s.warning ?? ''}`);
}

/** One-line headline plus the first failure — what a host that ignores
 *  structured output will show, and what a human skimming a transcript reads.
 *  The SDK synthesizes nothing from `structuredContent`. */
function summarize(outcome: RunOutcome): string {
  const lines = [
    `${outcome.status.toUpperCase()} — ${stepTally(outcome.steps, 'passed')} ` +
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
  lines.push(...toleratedWarningLines(outcome.steps));
  if (outcome.reportPath) lines.push(`Report: ${outcome.reportPath}`);
  if (outcome.warnings.length > 0) lines.push(`Warnings: ${outcome.warnings.length}`);
  const settings = settingsLine(outcome.effectiveSettings);
  if (settings !== null) lines.push(settings);
  return lines.join('\n');
}

/** The echo, on the line a host that ignores structured output will show. A
 *  retained setting is invisible otherwise — and "why is there no screenshot?"
 *  is answered here rather than several turns later. Shared with the errand
 *  receipt, which runs under the same chain minus the session layer. */
function settingsLine(settings: FoldedEffectiveSettings | null): string | null {
  if (!settings) return null;
  return (
    `Settings: model ${settings.model ?? '(not reported)'}, capture ` +
    `${settings.capture ?? '(not reported)'}, return ${settings.screenshotsReturn}` +
    (settings.sendScreenshots ? ', model sees screenshots' : '') +
    aiSaid(settings.ai, settings.aiOffReason)
  );
}

/**
 * The AI half of the echo. Silent when AI was on — that is the ordinary case and
 * the line is already long — and explicit about WHY when it was off, because
 * "off (policy)" and "off (no key)" call for opposite responses: one was asked
 * for, the other means this machine cannot run AI at all.
 */
function aiSaid(
  ai: FoldedEffectiveSettings['ai'],
  reason: FoldedEffectiveSettings['aiOffReason'],
): string {
  if (ai !== 'off') return '';
  return `, AI: off (${offBecause(reason)})`;
}

/** Why `ai` is off, in the echo's words. */
function offBecause(reason: FoldedEffectiveSettings['aiOffReason']): string {
  return reason === 'policy' ? 'policy' : reason === 'no-key' ? 'no key' : 'reason not reported';
}

/**
 * The AI half of the `get_run_settings` echo, which has one thing the run echo
 * does not: a retained override that can DISAGREE with the last run's result.
 *
 * Two ways to get there — a compile bypasses the switch outright, so a session
 * holding `ai: off` still reports `ai: 'on'` from that run; and setting the
 * override after a run leaves the previous run's answer standing. Either way
 * {@link aiSaid} alone would fall silent on the `on` side, and a host that
 * renders only content blocks would see nothing saying the switch is still
 * down for the next run.
 *
 * One clause when they agree, so the ordinary line is unchanged.
 */
function aiSaidWithOverride(
  ai: FoldedEffectiveSettings['ai'],
  reason: FoldedEffectiveSettings['aiOffReason'],
  override: 'on' | 'off' | null,
): string {
  if (override === null || ai === null || override === ai) return aiSaid(ai, reason);
  const last = ai === 'on' ? 'on for the last run' : `off for the last run (${offBecause(reason)})`;
  return `, AI: ${last}; session override ai: ${override} stands for the next run`;
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
// Errands (stories/errands.md)
// ---------------------------------------------------------------------------

/**
 * `run_steps` has `.aiui-mcp-steps.md`; an errand has this.
 *
 * Load-bearing rather than cosmetic: the server resolves the project root, the
 * env/data bundle and the step-plan cache anchor entirely from `testFilePath`,
 * so without one the project layer of `effectiveSettings` falls back to server
 * defaults with nothing saying so. It is never read from disk and never exists.
 */
const SYNTHETIC_ERRAND_BASENAME = '.aiui-errand.md';

/** `start_cdp_browser`'s own default, spelled here rather than imported: the
 *  MCP process is deliberately browser-free (tests/mcp-entry-graph.test.ts
 *  pins the import graph) and `cdp-registry.ts` is on the other side of that
 *  line. */
const DEFAULT_CDP_PROFILE = 'default';

/** The receipt, as `runErrandOutput` declares it. Named rather than inferred so
 *  the summary and the degraded fallback are describing the same object. */
interface ErrandReceipt {
  status: FoldedRun['status'];
  streamDropped: boolean;
  errandId: string;
  root: string;
  scope: 'project' | 'user';
  steps: FoldedStep[];
  captures: Record<string, string>;
  finalUrl: string;
  finalTitle: string;
  openedTabs: { targetId: string | null; url: string; title: string }[];
  keptOpen: { targetId: string | null; url: string; title: string }[];
  messages: FoldedRun['messages'];
  warnings: string[];
  error: string | null;
  effectiveSettings: FoldedEffectiveSettings | null;
}

/** What `run_errand` reads off its own call. */
interface ErrandArgs {
  tab: string;
  profile?: string | undefined;
  engine?: 'chrome' | 'edge' | undefined;
  scope?: 'project' | 'user' | undefined;
  env_name?: string | undefined;
  steps: string[];
  keep_open?: boolean | undefined;
}

/**
 * Attach → act → return, from the MCP side.
 *
 * Both halves of the attach happen here rather than server-side, exactly as
 * `close_cdp_tab`/`focus_cdp_tab` resolve theirs: the browser by profile +
 * engine + scope, then the tab by name against THAT browser's listing. Only
 * the winner's target id goes on the wire, so the first-match-wins arm of the
 * server's own tab resolver is never asked to arbitrate.
 */
async function runErrand(
  client: ApiClient,
  project: ProjectContext,
  args: ErrandArgs,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const { port } = await resolveCdpTarget(
    client,
    project.projectRoot,
    {
      // Always a profile, never a port: `run_errand` has no `port` argument at
      // all, so the no-address refusal family is unreachable here and must
      // stay that way (stories/errands.md §Tool surface). That also settles the
      // §6 gate by construction — a port resolved out of this call's own
      // `running` list is owned — which is why `gateOwed` is not consulted.
      profile: args.profile?.trim() || DEFAULT_CDP_PROFILE,
      ...(args.engine !== undefined ? { engine: args.engine } : {}),
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
    },
    signal,
  );

  // Re-read rather than reuse the resolution's listing: an errand resolves the
  // tab fresh every time, and the tab list is the half that moves. Foreign
  // browsers are not asked for — an errand cannot reach one.
  const browsers = await client.getCdpBrowsers(
    { projectRoot: project.projectRoot, includeForeign: false },
    signal,
  );
  const browser = browsers.running.find((b) => b.port === port);
  const where =
    browser === undefined
      ? `the browser on port ${port}`
      : describeBrowser({ engine: browser.engine, profile: browser.profile, scope: browser.scope });

  // Already page-type-filtered by the server, which is what stops an iframe,
  // a `browser_ui` target or a dialog ever being a candidate.
  const tabs = browser?.tabs ?? [];
  const matches = matchTabsByName(args.tab, tabs);
  if (matches.length === 0) throw new PreflightFailure(errandTabNotFound(args.tab, where, tabs));
  if (matches.length > 1) throw new PreflightFailure(errandTabAmbiguous(args.tab, matches));
  const borrowed = matches[0]!;

  const warnings: string[] = [];
  // The server builds no env bundle without a name (`if (envName)`), so
  // `${env.X}` would reach the AI as literal text. Same diagnostic, same
  // wording, as `run_steps` — one problem should not read as two.
  if (project.envName === null) {
    const warning = unresolvablePlaceholderWarning(args.steps);
    if (warning !== null) warnings.push(warning);
  }

  const body: ErrandRequestBody = {
    port,
    targetId: borrowed.targetId,
    steps: args.steps,
    testFilePath: path.join(project.projectRoot, SYNTHETIC_ERRAND_BASENAME),
    root: project.projectRoot,
    scope: project.scope,
    env: project.env,
    ...(project.envName !== null && { envName: project.envName }),
    // Omitted when off, like `cacheEnabled` on a step request: an absent flag
    // and an explicit `false` mean the same thing server-side.
    ...(args.keep_open === true && { keepOpen: true }),
  };

  // The route answers a turn-lock collision before any SSE header flushes, so
  // it arrives as an ordinary HTTP error rather than as a stream with no errand
  // on its `done` frame. Recognised HERE rather than in the generic mapping
  // because the alternative is `errandDidNotAttach`'s "the tab may have been
  // closed" — the wrong story, and the wrong next action, for a tab that is
  // very much open and busy (stories/errands.md §The wheel).
  let stream: StreamResult;
  try {
    stream = await client.runErrand(body, signal);
  } catch (err) {
    if (err instanceof ApiHttpError && err.holder !== null) {
      const { holder } = err;
      throw new PreflightFailure(
        holder.kind === 'errand'
          ? errandTabHeldByErrand(holder.errandId, holder.tabRole, args.tab)
          : errandTabHeldBySession(holder.sessionId, args.tab),
      );
    }
    throw err;
  }
  const folded = foldRun({
    events: stream.events,
    receivedAt: stream.receivedAt,
    streamDropped: stream.streamDropped,
    dropped: stream.dropped,
    sentSteps: args.steps,
    // The runner emits `line` as the 1-based step index, and nothing expands,
    // so this maps back exactly.
    sourceLines: args.steps.map((_step, index) => index + 1),
    testFilePath: body.testFilePath,
    expansionPossible: false,
    // The one client-side run setting an errand has, and it is not an argument:
    // there is no session to retain an override, so the shipped default stands.
    screenshotsReturn: DEFAULT_SCREENSHOTS_RETURN,
  });

  const errand = readErrandSummary(stream.events);
  // No errand block covers two opposite stories, and the step events are the
  // only thing that tells them apart.
  //
  // No step event ever arrived: the request died before the tab was borrowed —
  // the attach refused, or the route's own catch answered — and `isError`
  // ("nothing ran") is the honest report.
  //
  // Step events and then no `done` block: the stream died MID-errand (a force
  // shutdown, a crash, a proxy timeout). The tab HAS been driven, and answering
  // that with "nothing ran" throws away the folded steps and captures, which
  // are by then the only surviving record of what happened to the user's page.
  if (errand === null) {
    if (!tabWasDriven(stream.events)) {
      return errorResult(errandDidNotAttach(args.tab, folded.error ?? firstError(folded)));
    }
    return unfinishedErrandResult({ folded, tab: args.tab, project, warnings, borrowed, where });
  }

  const receipt: ErrandReceipt = {
    status: folded.status,
    streamDropped: folded.streamDropped,
    errandId: errand.errandId,
    // The server's echo of what we sent, not our copy of it: the receipt is
    // the errand's own claim about which root it ran under.
    root: errand.root,
    scope: errand.scope,
    steps: folded.steps,
    captures: folded.captures,
    finalUrl: errand.finalUrl,
    finalTitle: errand.finalTitle,
    openedTabs: errand.openedTabs.map(receiptTab),
    keptOpen: errand.keptOpen.map(receiptTab),
    messages: folded.messages,
    warnings: [...warnings, ...errandWarnings(folded)],
    error: folded.error,
    effectiveSettings: folded.effectiveSettings,
  };

  return validated(
    schemas.runErrandOutput,
    receipt as unknown as Record<string, unknown>,
    summarizeErrand(receipt, borrowed, where),
    screenshotBlock(folded.screenshotBase64),
    // Keeps what nothing else can recover: which errand it was, which tab it
    // left behind, and that it ran at all.
    (detail) => ({
      ...receipt,
      status: 'error',
      steps: [],
      captures: {},
      messages: [],
      warnings: [`The errand finished, but its result could not be encoded: ${detail}`],
      error: detail,
      effectiveSettings: null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tab peek (stories/tab-peek.md)
// ---------------------------------------------------------------------------

/**
 * `run_errand` has `.aiui-errand.md`; a peek has this.
 *
 * Load-bearing rather than cosmetic, and for a peek it is the whole of
 * verification item (2): the server resolves the project root — and with it
 * `domSnapshotCharLimit`, `maxIframeDepth` and the noise-reduction settings —
 * entirely from `testFilePath`. Without one the capture silently runs under
 * library defaults that DIFFER from the project's, so a peek and
 * `get_page_content` would disagree about the same page with nothing saying
 * why. It is never read from disk and never exists.
 */
const SYNTHETIC_PEEK_BASENAME = '.aiui-peek.md';

/** What `peek_tab` reads off its own call. */
interface PeekArgs {
  tab: string;
  format?: 'text' | 'dom' | 'screenshot' | undefined;
  selector?: string | undefined;
  max_chars?: number | undefined;
  /** Screenshot only (stories/cdp-tab-screenshot.md). */
  full_page?: boolean | undefined;
  profile?: string | undefined;
  engine?: 'chrome' | 'edge' | undefined;
  scope?: 'project' | 'user' | undefined;
}

/**
 * Attach → extract → detach, from the MCP side.
 *
 * The attach's two stages happen here, exactly as `run_errand`'s do and
 * through the SAME two functions: the browser by profile + engine + scope
 * (`resolveCdpTarget`, its ambiguity refusals reused as-is), then the tab by
 * name against THAT browser's page-type-filtered listing (`matchTabsByName`,
 * shared rather than copied). Only the winner's target id goes on the wire.
 *
 * There is no `port` argument, which settles the ownership question by
 * construction: a profile-resolved port came out of this call's own `running`
 * list, so the browser is registry-owned and mcp-cdp-browser §6's foreign-port
 * gate is unreachable from here.
 */
async function peekTab(
  client: ApiClient,
  project: ProjectContext,
  args: PeekArgs,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const { port } = await resolveCdpTarget(
    client,
    project.projectRoot,
    {
      // Always a profile, never a port — same reasoning as `run_errand`'s.
      profile: args.profile?.trim() || DEFAULT_CDP_PROFILE,
      ...(args.engine !== undefined ? { engine: args.engine } : {}),
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
    },
    signal,
  );

  // Re-read rather than reuse the resolution's listing: a peek resolves the tab
  // fresh every time, and the tab list is the half that moves. Foreign browsers
  // are not asked for — a peek cannot reach one.
  const browsers = await client.getCdpBrowsers(
    { projectRoot: project.projectRoot, includeForeign: false },
    signal,
  );
  const browser = browsers.running.find((b) => b.port === port);
  const where =
    browser === undefined
      ? `the browser on port ${port}`
      : describeBrowser({ engine: browser.engine, profile: browser.profile, scope: browser.scope });

  // Already page-type-filtered by the server, which is what stops an iframe,
  // a `browser_ui` target or a dialog ever being a candidate.
  const tabs = browser?.tabs ?? [];
  const matches = matchTabsByName(args.tab, tabs);
  if (matches.length === 0) throw new PreflightFailure(peekTabNotFound(args.tab, where, tabs));
  if (matches.length > 1) throw new PreflightFailure(peekTabAmbiguous(args.tab, matches));
  const target = matches[0]!;

  let peeked;
  try {
    peeked = await client.peekCdpTab(
      {
        port,
        targetId: target.targetId,
        testFilePath: path.join(project.projectRoot, SYNTHETIC_PEEK_BASENAME),
        ...(args.format !== undefined ? { format: args.format } : {}),
        ...(args.selector !== undefined ? { selector: args.selector } : {}),
        ...(args.max_chars !== undefined ? { maxChars: args.max_chars } : {}),
        ...(args.full_page !== undefined ? { fullPage: args.full_page } : {}),
      },
      signal,
    );
  } catch (err) {
    // The 404 split cdp-tab-focus §6 locked. Route-missing is checked FIRST
    // because it is the narrower type: "rebuild dist/" and "your tab is gone"
    // are opposite remedies, and getting it backwards sends a user hunting for
    // a window that is still sitting on their screen.
    if (err instanceof ApiRouteNotFoundError) {
      return errorResult(peekRouteMissing(normalizeBaseUrl(project.serverUrl)));
    }
    if (err instanceof ApiHttpError && err.status === 404) {
      // The tab closed between our listing and the server's. Its row is dropped
      // from the candidate list the refusal offers, because the server has just
      // proved that entry stale — re-offering it would invite the same failed
      // call again.
      //
      // A DIFFERENT refusal from the pre-flight miss, not the same one over a
      // shorter list: the caller named a tab that was there, and the list they
      // are handed back is one this arm emptied itself — which in a one-tab
      // browser turns "no tab matches" into "that browser reports no tabs at
      // all", both halves false (see `peekTabGoneNow`).
      return errorResult(
        peekTabGoneNow(
          args.tab,
          where,
          tabs.filter((tab) => tab.targetId !== target.targetId),
        ),
      );
    }
    throw err;
  }

  // Which half of the response to read is decided by what THIS CALL asked for,
  // never by what came back (stories/cdp-tab-screenshot.md). A server that
  // answered a picture request with text is a version skew, and folding its
  // text in as the answer would quietly hand back the wrong KIND of thing — a
  // server too old to know the format refuses the query outright instead, which
  // arrives above as an error already.
  if (args.format === 'screenshot') {
    return screenshotPeek(peeked, target.targetId, where, project, args.full_page === true);
  }

  // Not defaulted the way `list_cdp_browsers` defaults its optionals: a page
  // read that arrived without content has nothing usable to degrade to, and
  // substituting '' would tell the agent the page is empty when what actually
  // happened is that we never received it — the one confusion this whole
  // feature exists to prevent.
  if (typeof peeked.content !== 'string') {
    throw new Error(
      'The Sessions API returned a tab-content response with no `content` field. ' +
        'This is a bug in the server, not a page that is empty.',
    );
  }

  const value = {
    targetId: peeked.targetId ?? target.targetId,
    url: peeked.url ?? '',
    title: peeked.title ?? '',
    format: peeked.format ?? 'text',
    selector: peeked.selector ?? null,
    content: peeked.content,
    truncated: peeked.truncated ?? false,
    // A text or DOM read has no pixels to report, and null says that rather
    // than 0 — which would read as a zero-sized picture.
    width: null,
    height: null,
    returnedChars: peeked.returnedChars ?? 0,
    availableChars: peeked.availableChars ?? 0,
    // The server's own claim about which root its capture settings came from.
    // Null means no `aiui.config.json` stood above the synthetic path and it
    // used its defaults — the root this call addressed is then the honest
    // thing to report, since that is the root the path was built from.
    root: peeked.root ?? project.projectRoot,
    scope: project.scope,
  };

  const narrowed = value.selector ? ` (${value.selector})` : '';
  const size = value.truncated
    ? `${value.returnedChars} of ${value.availableChars}+ chars — narrow with a selector to see the rest`
    : `${value.returnedChars} chars`;
  return validated(
    schemas.peekTabOutput,
    value,
    // `where` carries the "(user root)" tag the way `close_cdp_tab`'s summary
    // does: a project-scope call that read a machine-wide browser is the one
    // thing a reader will not expect from the arguments they passed.
    `Read "${value.title || value.url}"${narrowed} in ${where} — ${value.format}, ${size}`,
  );
}

// Navigate (stories/navigate-tab.md)
// ---------------------------------------------------------------------------

/** `run_errand` has `.aiui-errand.md` and a peek has `.aiui-peek.md`; this has
 *  its own, for the same reason: it is the only thing the server resolves a
 *  project from, and it is never read from disk and never exists. */
const SYNTHETIC_NAVIGATE_BASENAME = '.aiui-navigate.md';

/** What `navigate_tab` reads off its own call. */
interface NavigateArgs {
  url: string;
  target_id?: string | undefined;
  profile?: string | undefined;
  engine?: 'chrome' | 'edge' | undefined;
  scope?: 'project' | 'user' | undefined;
}

/**
 * Point a tab at a URL, or open a new one there.
 *
 * The browser is resolved exactly as a peek's is — `resolveCdpTarget` over
 * profile/engine/scope, no `port`, so only a registry-owned browser is
 * reachable. The TAB is resolved as `close_cdp_tab`'s is: an exact id, or
 * nothing at all. That split is the whole story (§Locked).
 */
async function navigateTab(
  client: ApiClient,
  project: ProjectContext,
  args: NavigateArgs,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const { port } = await resolveCdpTarget(
    client,
    project.projectRoot,
    {
      profile: args.profile?.trim() || DEFAULT_CDP_PROFILE,
      ...(args.engine !== undefined ? { engine: args.engine } : {}),
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
    },
    signal,
  );

  const requestedTarget = args.target_id?.trim() ?? '';

  if (requestedTarget !== '') {
    // The exact-id gate, MCP-side and BEFORE the wire, so a name never reaches a
    // route that would have to interpret it. Anything the tab list does not
    // contain verbatim is refused with the ids offered — including "current",
    // whose whole problem is that it sounds resolvable.
    const browsers = await client.getCdpBrowsers(
      { projectRoot: project.projectRoot, includeForeign: false },
      signal,
    );
    const browser = browsers.running.find((b) => b.port === port);
    const where =
      browser === undefined
        ? `the browser on port ${port}`
        : describeBrowser({
            engine: browser.engine,
            profile: browser.profile,
            scope: browser.scope,
          });
    const tabs = browser?.tabs ?? [];
    if (!tabs.some((tab) => tab.targetId === requestedTarget)) {
      throw new PreflightFailure(navigateNeedsExactTarget(requestedTarget, where, tabs));
    }
  }

  const navigated = await client.navigateCdpTab(
    {
      port,
      url: args.url.trim(),
      testFilePath: path.join(project.projectRoot, SYNTHETIC_NAVIGATE_BASENAME),
      ...(requestedTarget !== '' ? { targetId: requestedTarget } : {}),
    },
    signal,
  );

  const value = {
    requestedUrl: navigated.requestedUrl ?? args.url.trim(),
    url: navigated.url ?? '',
    title: navigated.title ?? '',
    targetId: navigated.targetId ?? null,
    openedNewTab: navigated.openedNewTab ?? requestedTarget === '',
    root: navigated.root ?? project.projectRoot,
    scope: project.scope,
    warnings: navigated.warnings ?? [],
  };

  const redirected = value.url !== '' && value.url !== value.requestedUrl;
  const lines = [
    `${value.openedNewTab ? 'Opened' : 'Navigated'} ${value.requestedUrl} in a ` +
      `${value.openedNewTab ? 'new tab' : 'tab you already had open'}`,
    // Named on its own line rather than folded into the sentence above: a
    // redirect to a sign-in page is the thing worth noticing, and it should not
    // read like a detail of a success.
    ...(redirected ? [`Landed on: ${value.url}${value.title ? ` — "${value.title}"` : ''}`] : []),
    ...value.warnings,
  ];
  return validated(schemas.navigateTabOutput, value, lines.join('\n'));
}

/**
 * The same peek, when what was asked for was a picture
 * (stories/cdp-tab-screenshot.md).
 *
 * Its own function rather than a branch inside `peekTab`'s fold, because almost
 * nothing is shared: every character field here is a constant, the payload
 * travels in an image block instead of `content`, and the check worth making on
 * the response is a different check.
 */
function screenshotPeek(
  peeked: PeekedTab,
  fallbackTargetId: string,
  where: string,
  project: ProjectContext,
  fullPage: boolean,
): ToolResult {
  // Our own route sends bare base64 and `get_page_content`'s source sends a
  // data URI. Accepting both costs one call, and means a server that starts
  // wrapping it produces a smaller image rather than an unrenderable block.
  const base64 = (typeof peeked.screenshot === 'string' ? peeked.screenshot : '').replace(
    DATA_URI_PREFIX,
    '',
  );
  // The sibling of the text path's `content` check, and load-bearing for the
  // same reason: an empty image is not a blank page.
  if (base64 === '') throw peekScreenshotMissing();
  if (base64.length > MAX_SCREENSHOT_BASE64) {
    return errorResult(
      peekScreenshotTooLarge(where, base64.length, MAX_SCREENSHOT_BASE64, fullPage),
    );
  }

  const value = {
    targetId: peeked.targetId ?? fallbackTargetId,
    url: peeked.url ?? '',
    title: peeked.title ?? '',
    format: 'screenshot' as const,
    // Nothing narrowed this picture, and nothing could: `selector` is refused
    // alongside a screenshot rather than ignored.
    selector: null,
    // Empty on purpose — the picture is in the image block, and `format` says
    // which half of this result carries the payload. The same split
    // `get_page_content` already makes for a session's screenshot.
    content: '',
    // An image that did not fit is the error above, never a partial picture.
    truncated: false,
    width: peeked.width ?? null,
    height: peeked.height ?? null,
    returnedChars: base64.length,
    availableChars: base64.length,
    root: peeked.root ?? project.projectRoot,
    scope: project.scope,
  };

  const pixels = value.width !== null && value.height !== null ? `${value.width}×${value.height}, ` : '';
  return validated(
    schemas.peekTabOutput,
    value,
    `Photographed "${value.title || value.url}" in ${where} — ` +
      `${fullPage ? 'full page' : 'viewport'}, ${pixels}${Math.round(base64.length / 1024)}KB`,
    [{ type: 'image', data: base64, mimeType: 'image/png' }],
  );
}

/**
 * Did anything actually reach the tab?
 *
 * Any step or capture event says yes: the runner emits `step:start` before it
 * touches the page and cannot emit one before the attach has returned a
 * borrowed tab. `output` frames do NOT count — the log bridge and the route's
 * own error arm both emit them for an errand that never got past the attach.
 */
function tabWasDriven(events: readonly RunEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'step:start' ||
      event.type === 'step:pass' ||
      event.type === 'step:fail' ||
      event.type === 'capture',
  );
}

/**
 * What a truncated errand stream can actually be done about.
 *
 * The session-shaped remedy this replaces (`STREAM_DROPPED_WARNING`) is not
 * merely unhelpful here — `get_last_run` takes a `session_id` and an errand
 * creates none, so a caller that follows it has nothing to pass. What IS
 * reachable is the browser itself, which is the same place the receipt's own
 * error text sends the caller for the tab's end state.
 *
 * The re-run caveat is the other half: the errand may have gone on driving the
 * tab after the stream died, so "just run it again" can be the second click of
 * two on somebody's real page.
 */
const ERRAND_STREAM_DROPPED =
  'The connection to the server ended without a completion event, and there is ' +
  'no get_last_run for an errand — it has no session to look up. Call ' +
  'list_cdp_browsers to see the tab and what else is open now. The errand may ' +
  'have kept driving the tab after the stream died, so re-running the same ' +
  'steps is only safe if they are idempotent.';

/**
 * The fold's warnings with the session-shaped remedy swapped for the errand's.
 *
 * Both receipt paths run this, because a dropped stream is not the truncated
 * path's private problem: the client sets `streamDropped` in its catch arm too
 * (src/mcp/api-client.ts), so a stream that dies AFTER the `done` frame folds
 * into a FINISHED receipt that still carries `STREAM_DROPPED_WARNING` — and
 * that line tells the caller to call `get_last_run`, which takes a `session_id`
 * the errand never created.
 *
 * Dropped by identity against the exported constant rather than by matching its
 * prose, and the substitute is pushed on the SAME condition (something was
 * actually removed), so the two cannot drift apart.
 */
function errandWarnings(folded: FoldedRun): string[] {
  const kept = folded.warnings.filter((w) => w !== STREAM_DROPPED_WARNING);
  if (kept.length !== folded.warnings.length) kept.push(ERRAND_STREAM_DROPPED);
  return kept;
}

/** The one image block a receipt ever carries, built the same way on both the
 *  finished and the truncated path — a screenshot the fold kept is a picture of
 *  the user's real page, and which path returned it changes nothing about that. */
function screenshotBlock(base64: string | null): ToolResult['content'] {
  return base64 ? [{ type: 'image', data: base64, mimeType: 'image/png' }] : [];
}

/**
 * The stream carried steps and then ended without the errand's accounting.
 *
 * A receipt rather than an `isError`, for the reason the whole `isError`
 * contract exists (src/mcp/errors.ts): the tab was driven, so the steps and
 * captures are the caller's only record of what an errand did to a real page,
 * and an `isError` result carries no `structuredContent` to keep them in.
 *
 * Everything the `done` frame owns is missing and is reported missing rather
 * than guessed: `status` is `error` whatever the fold made of a truncated
 * stream, the final url and title are empty, and `openedTabs`/`keptOpen` are
 * empty because nothing counted them — not because nothing was opened, which is
 * what the warning says. `root` and `scope` are the only two fields answered
 * from the request instead of the server's echo, and they are honest to answer
 * that way: the tool resolved them and sent them, and the server does not
 * re-derive them.
 */
function unfinishedErrandResult(input: {
  folded: FoldedRun;
  /** The `tab` spelling the caller used, so the message names the page in the
   *  caller's own words rather than in a target id they never wrote. */
  tab: string;
  project: ProjectContext;
  warnings: string[];
  borrowed: CdpTab;
  where: string;
}): ToolResult {
  const { folded, project, tab } = input;
  const detail = folded.error ?? firstError(folded);

  // The fold's own stream-dropped warning sends the caller to `get_last_run`,
  // which is addressed by `session_id` (`getLastRunInput`) — an errand has
  // none, so that line names the one call this caller provably cannot make.
  const foldWarnings = errandWarnings(folded);

  const receipt: ErrandReceipt = {
    status: 'error',
    streamDropped: folded.streamDropped,
    // Never reported: the errand id is minted server-side and rides the `done`
    // frame that never came. Empty is the one honest value — inventing one
    // would hand back a handle onto nothing.
    errandId: '',
    root: project.projectRoot,
    scope: project.scope,
    steps: folded.steps,
    captures: folded.captures,
    finalUrl: '',
    finalTitle: '',
    openedTabs: [],
    keptOpen: [],
    messages: folded.messages,
    warnings: [
      ...input.warnings,
      ...foldWarnings,
      'openedTabs and keptOpen are empty because the errand never reported ' +
        'them, not because it opened nothing. A tab it opened may still be ' +
        'open — call list_cdp_browsers to see what is there now.',
    ],
    error:
      `The errand DROVE tab "${tab}" and then the stream ended without a ` +
      'completion event, so its final state is unknown' +
      (detail !== null && detail !== '' ? `: ${detail}` : '.') +
      '\n' +
      'The steps and captures below really happened. What is missing is what ' +
      'the errand did on the way out — where the tab ended up, and whether the ' +
      'tabs it opened were closed. Read the page before assuming either.',
    effectiveSettings: folded.effectiveSettings,
  };

  return validated(
    schemas.runErrandOutput,
    receipt as unknown as Record<string, unknown>,
    summarizeErrand(receipt, input.borrowed, input.where),
    // The same image block the finished path returns. A stream that died after
    // a failing step still folded that step's screenshot, and it is a picture
    // of the user's real page taken at the moment things went wrong — the one
    // artefact this degraded receipt least deserves to drop.
    screenshotBlock(folded.screenshotBase64),
    (detailText) => ({
      ...receipt,
      steps: [],
      captures: {},
      messages: [],
      warnings: [`The errand's partial result could not be encoded: ${detailText}`],
      error: detailText,
      effectiveSettings: null,
    }),
  );
}

/**
 * `close_cdp_tab`'s call, with the turn-lock 409 turned into its own refusal.
 *
 * A session-held tab already has a good message from the server, which the
 * generic HTTP arm relays intact. An errand-held one does not: it needs to say
 * that the holder cannot be closed, only waited for, and — for a tab the errand
 * opened — that the retry will probably find nothing to close.
 */
async function closeTabOrExplainHolder(
  client: ApiClient,
  args: Parameters<ApiClient['closeCdpTab']>[0],
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ApiClient['closeCdpTab']>>> {
  try {
    return await client.closeCdpTab(args, signal);
  } catch (err) {
    if (err instanceof ApiHttpError && err.holder?.kind === 'errand') {
      // Read off the same object the call was made with, so the tab the refusal
      // names is by construction the tab the close was aimed at.
      throw new PreflightFailure(
        cdpTabHeldByErrand(err.holder.errandId, err.holder.tabRole, args.targetId),
      );
    }
    throw err;
  }
}

/** `ErrandTab` as the schema wants it: an unresolved target id is `null`, never
 *  a missing key — a missing required key is fatal to `validateToolOutput`. */
function receiptTab(tab: ErrandTab): { targetId: string | null; url: string; title: string } {
  return { targetId: tab.targetId ?? null, url: tab.url, title: tab.title };
}

/** The first error-level message, for the attach refusal — `folded.error` is
 *  null on a run the fold considers passed, and an attach failure that emitted
 *  only an `output` frame would otherwise report no reason at all. */
function firstError(folded: FoldedRun): string | null {
  return folded.messages.find((m) => m.level === 'error')?.text ?? null;
}

/** One-line headline plus what a user who said "drive my tab" actually wants
 *  back: which tab was driven, where it ended up, and what else was opened. */
function summarizeErrand(
  receipt: ErrandReceipt,
  borrowed: CdpTab,
  browser: string,
): string {
  const lines = [
    `${receipt.status.toUpperCase()} — ${stepTally(receipt.steps, '')} in ` +
      `"${borrowed.title || borrowed.url}" (${browser}, ` +
      // Empty only on the stream-died-mid-errand path: the id rides the `done`
      // frame that never arrived, and "errand " followed by nothing reads as a
      // formatting bug rather than as a missing fact.
      `errand ${receipt.errandId || 'id not reported'})`,
  ];
  if (receipt.scope === 'user') {
    lines.push(`Ran project-less against the user root (${receipt.root}).`);
  }
  if (receipt.error) lines.push(`Error: ${receipt.error}`);
  // The same sentences a run's summary carries: an errand's steps take the
  // `otherwise continue` tail too, and its receipt is the only place they land.
  lines.push(...toleratedWarningLines(receipt.steps));
  // Skipped rather than printed empty when the detach never reported one —
  // "Tab left at: (untitled) — " states nothing and looks like a lost value.
  if (receipt.finalUrl !== '' || receipt.finalTitle !== '') {
    lines.push(`Tab left at: ${receipt.finalTitle || '(untitled)'} — ${receipt.finalUrl}`);
  }
  if (receipt.openedTabs.length > 0) {
    // Counted from the two lists the server sent, not from `keep_open`. "The
    // rest closed on the way out" was a claim about the user's screen that the
    // receipt cannot support twice over: a tab another errand took the wheel of
    // is spared the close and is still open, and a tab a STEP closed mid-run
    // was never the detach's to close. So the second half says what is knowable
    // — no longer open — and not who closed it.
    const gone = receipt.openedTabs.length - receipt.keptOpen.length;
    lines.push(
      `Opened ${receipt.openedTabs.length} tab(s); ${receipt.keptOpen.length} still open` +
        (gone > 0 ? `, ${gone} no longer open.` : '.'),
    );
  }
  if (receipt.warnings.length > 0) lines.push(`Warnings: ${receipt.warnings.length}`);
  const settings = settingsLine(receipt.effectiveSettings);
  if (settings !== null) lines.push(settings);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Shared syntax crib. An agent with no reference writes prose that half-works
 *  — the AI executes it, so the failure is a wrong run rather than an error. */
const STEP_SYNTAX = `
Step syntax: plain English, one action per step. Also supported:
  [skill: name arg=value]   run a reusable skill from the project's skills dir
                            (sub/name for one kept in a subfolder of it)
  [tool: name arg=value]    call a project tool (JS/TS) directly
  [input: label]            needs a human — SKIPPED in an unattended run
  Set {{name}} to "text"    assign a variable from ones you already have,
                            no AI call: Set {{ref}} to "Ref: {{order_id}}"
  Section Name              call an inline "### Section Name" from the same file
  \${env.VAR} / \${data.key} substituted from the selected environment
  {{param}}                 substituted from ## Parameters
  Upload file attachments/x.png   a file path is relative to the test file
                            (run_steps / run_errand: the project root)`.trim();

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
Whose browser? Ours to open — this tool opens one, or reuses one this
framework already owns, and owns everything it touches until the session
closes. Theirs to borrow — "my tab", "the one I have open", "my signed-in
browser" — is not this tool, and splits by what you are doing to it: only
READING it is peek_tab, which returns the page — as text, or as a screenshot
when the ask is to SEE it — and changes nothing; ACTING in
it — clicking, typing, navigating — is run_errand, which drives an
already-open tab for one request and hands it back. Ownership words decide it,
not the word "test": "test the checkout on my open tab" is an errand.

Browser: steps run in a fresh, signed-out, disposable browser UNLESS you say
otherwise. Persistent CDP browsers holding real logins may also be running —
the project's, and the user's machine-wide ones (scope "user", reachable from
any directory, project or not). To use one, pass config.cdp:
{profile: "<name>"} (call list_cdp_browsers if unsure which exist; add
scope/engine if the name is ambiguous). Config is read only when a session is
CREATED, so pass it on the first call for a session; passing it later is
ignored.

Tab: attaching opens a NEW tab by default. config.cdp: {profile: "<name>",
tab: "targetId:<id>"} — the id comes from list_cdp_browsers — BINDS this
session to a tab the user already has open, which is what you want when a
whole test file has to run there, or when later calls on this session must
stay in that tab. For a one-off "just drive that tab for me", reach for
run_errand instead: it takes the tab by name, creates no session, and leaves
nothing behind. Naming the profile alone leaves their tab untouched and runs
somewhere else.`.trim();

/**
 * The syntax crib, minus what an errand cannot do.
 *
 * `STEP_SYNTAX` teaches `[skill:]` and `[tool:]`, which `run_errand` refuses —
 * an errand carries no skills or tools directory — so handing it the same text
 * would teach the one thing the handler then rejects.
 */
const ERRAND_STEP_SYNTAX = `
Step syntax: plain English, one action per step. Also supported:
  \${env.VAR} / \${data.key} substituted from env_name's environment — pass
                            env_name, or they reach the AI as literal text
  {{name}}                  substituted from a capture made EARLIER IN THIS
                            errand; never from a previous one
  Set {{name}} to "text"    assign a variable from ones you already have,
                            no AI call: Set {{ref}} to "Ref: {{order_id}}"
  Upload file attachments/x.png   a file path is relative to the project root
[skill: ...] and [tool: ...] are refused here — those need run_steps in a
project, which is what carries the skills and tools directories.`.trim();

/**
 * The two couplings between the settings, on the tools themselves.
 *
 * A tool description is the only text guaranteed to be in front of the model at
 * the moment it calls, and both of these are the kind of thing that otherwise
 * produces a confident wrong report: asking for an image nobody captured, or
 * being surprised that `capture: "none"` still took pictures.
 */
const SETTINGS_NOTE = `
Settings: model, capture, full_page, send_screenshots and ai stick to the
session until changed — set one once and later calls inherit it. Each run tells
you what it actually used in effectiveSettings; read that rather than assuming,
since a preference set earlier in a conversation is easy to lose track of. That
includes effectiveSettings.ai: "off" with aiOffReason "policy" means somebody
asked for a run that spends nothing, "no-key" means this machine has none.

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

/**
 * `run_errand`'s description — which is the routing layer that matters.
 *
 * A tool description is read only after the model is already considering the
 * tool, so the first paragraph is the one-question decision rule
 * (stories/errands.md §Routing 1) rather than a feature list: *whose browser?*
 * The counter-example is there because it is the case a model gets wrong —
 * "test the checkout on my open tab" is an errand, and a model that keys on the
 * word "test" picks the session door and drives a fresh signed-out browser.
 */
const ERRAND_DESCRIPTION = `
Drive a tab the user ALREADY has open — one request, then hand it back.

Whose browser? That question picks the tool. Ours to open — a fresh browser,
or one this framework already owns — is run_steps. Theirs to borrow is this
one: "my tab", "the one I have open", "my signed-in browser", "that
OpenRouter tab". Ownership words decide it, not the word "test":
"test the checkout on my open tab" is an errand.

Then one more question, because borrowing splits: are you only READING that
tab? "What's on my OpenRouter tab?" — and "show me a screenshot of it" — is
peek_tab, which returns the page and changes nothing. ACTING in it — clicking,
typing, navigating — is this one.
A drive-then-read is still ONE errand, because steps can capture.

Name the tab and it is resolved fresh, right now, against the live tab list.
Nothing matches, or several do, and the call is refused with the candidates
named — so a rough name is safe to try, and no wrong tab is ever picked for
you. There is no fallback browser: an errand reaches only the persistent CDP
browsers list_cdp_browsers reports.

What comes back is a receipt: per-step outcomes, every capture, where the tab
ended up, and any tabs the errand opened. What does NOT come back is a
handle — there is no session, no report file, no server-side variable scope,
and nothing answering to the errandId once the call returns. A second errand
starts from nothing, so pass anything you need again in the step text.

It borrows, it does not take over. The tab it was given is never closed and
never signed out; tabs it opened itself go with it unless keep_open; and it
ends by asking the browser to bring the borrowed tab forward, so the user is
left looking at what happened. The user can also type into that tab while it
runs — nothing stops them — which is the other reason to read the receipt
rather than assume.

This drives a real, signed-in browser belonging to a human. Say what you did
in it, not just that it worked.

${ERRAND_STEP_SYNTAX}`.trim();

/**
 * `peek_tab`'s description — the three-door rule, first.
 *
 * A tool description is read only after the model is already considering the
 * tool, so what leads is the question that tells this door from its two
 * neighbours (stories/tab-peek.md §Routing): what are you reading, and are you
 * only reading it? The alternative was measured live — a model that wanted a
 * tab's contents reached for `get_page_content`, got an honest 404 about a
 * session it never created, and had no third door to fall back to.
 */
const PEEK_DESCRIPTION = `
Read a tab the user ALREADY has open — its visible text, its cleaned DOM, or a
SCREENSHOT of it — without changing anything on it.

Three doors, one question each:
  - Reading a tab you can name ("what's on my OpenRouter tab?", "show me my
    OpenRouter tab", "take a screenshot of it") — this one.
  - Driving a tab: clicking, typing, navigating — run_errand. Its steps can
    also capture ("read the balance, store as balance"), so a drive-then-read
    is ONE errand, not an errand and then a peek.
  - Reading the page a run_steps SESSION is sitting on — get_page_content.

Name the tab and it is resolved fresh, right now, against the live tab list.
Nothing matches, or several do, and the call is refused with the candidates
named — so a rough name is safe to try, and no wrong tab is ever read for you.
There is no fallback browser: a peek reaches only the persistent CDP browsers
list_cdp_browsers reports.

It changes nothing at all. No click, no navigation, no tab opened or closed,
no session created, nothing written — and it does NOT bring the tab forward,
so the user keeps looking at whatever they were looking at. Use focus_cdp_tab
if they should see it. A screenshot is no exception: the tab is photographed
where it sits, backgrounded or even minimised, and still comes back as a live
frame rather than a stale one.

It is safe to call on a tab something else is driving. A run in flight may
move the page under you, so what comes back is what was there at the moment of
the read: the content plus the url and title read alongside it.

Returns the page as-is — nothing is summarised or interpreted for you, so
budget for reading it yourself. format "text" (default) for what the page
says; "dom" when you need element structure to pick a selector, and it is much
larger. Narrow with selector rather than raising max_chars: a truncated result
tells you it was truncated, and reading a bigger slice of the wrong part of
the page costs context without answering anything.

format "screenshot" when the ask is to SEE the page rather than read it —
"show me", "what does it look like", anything about layout or rendering. It
comes back as an image; full_page: true captures the whole scrollable page
instead of the viewport, and an image too large to return is an error saying
so, never a silent drop. selector and max_chars do not apply to a picture and
are refused alongside it rather than quietly ignored. Prefer "text" when you
only need to know what the page SAYS — it is a fraction of the context.

This reads a real, signed-in browser belonging to a human. Say what you read
and where you read it.`.trim();

/**
 * `navigate_tab`'s description — the fourth door, and the two things a caller
 * has to get right (stories/navigate-tab.md §Routing, §Locked).
 */
const NAVIGATE_DESCRIPTION = `
Open a URL in a CDP browser the user has running. No model, no session, no run —
this is the cheap deterministic way to get a tab somewhere.

BY DEFAULT IT OPENS A NEW TAB, and that is almost always what you want: "open
openrouter" means open it, and a new tab cannot destroy anything. Pass
target_id ONLY when the user asked for a particular tab to be reused — that
REPLACES what is on it, including anything unsaved, with no undo.

Four doors, one question each:
  - Opening a URL — this one.
  - Reading a tab (text, DOM or a screenshot) — peek_tab.
  - Acting in a tab: clicking, typing, choosing — run_errand.
  - Reading the page a run_steps SESSION is sitting on — get_page_content.

The line between this and run_errand is whether the instruction contains a
DECISION. "Go to openrouter.ai" has none, so it belongs here. "Find the pricing
page and open it" does, so it is an errand.

target_id is an exact id from list_cdp_browsers or nothing at all. A title, a
url fragment, "active" or "current" are refused — nothing marks which tab is in
front, and the tab someone is looking at is the one most likely to hold work
they care about. If they meant a specific tab and you cannot tell which, list
the tabs and ask.

Compare url against requestedUrl in the result. A difference is a redirect, and
arriving at a sign-in page is worth reporting rather than calling it done. A
warning means the call worked but the page had not finished loading, or moved
again while its address was read.

This drives a real, signed-in browser belonging to a human. If the URL came out
of a page you just read rather than from them, say so and confirm first.`.trim();

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
          (args.session_id?.trim() ? args.session_id : undefined) ??
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
          (args.session_id?.trim() ? args.session_id : undefined) ??
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

  // -- run_errand -----------------------------------------------------------
  server.registerTool(
    'run_errand',
    {
      title: 'Drive a tab the user already has open',
      description: ERRAND_DESCRIPTION,
      inputSchema: schemas.runErrandInput,
      outputSchema: schemas.runErrandOutput,
    },
    async (args, extra) => {
      // Both refusals happen here, before `withProject` — so before a server is
      // started, a registry is read or a browser is touched. Neither needs a
      // project to decide, and the story's "refused before any browser work"
      // is a property of where they sit, not of what they say.
      //
      // The refusal fires only on a NON-EMPTY session_id. Some provider layers
      // serialize every declared optional as "" — the model cannot omit the
      // key, so refusing "" strands it in a loop the redirect sentence cannot
      // break (measured live, OpenCode + gpt-5.6-luna, 2026-08-13). An empty
      // id names no session, so there is no wrong door to redirect from.
      if (args.session_id !== undefined && args.session_id.trim() !== '') {
        return errorResult(errandsHaveNoSessions(args.session_id));
      }
      const codeSteps = args.steps.filter((step) => isCodeStep(step));
      if (codeSteps.length > 0) return errorResult(errandCodeSteps(codeSteps));

      return withProject(
        deps,
        args.project_root,
        async (client, project) => runErrand(client, project, args, extra.signal),
        // Auto-start is the default: an errand against a stopped server brings
        // it up rather than dying on a bare ECONNREFUSED.
        {
          signal: extra.signal,
          // Same normalisation the run tools apply: `""` is an absent argument,
          // not an environment named the empty string.
          ...(args.env_name?.trim() ? { envName: args.env_name.trim() } : {}),
        },
      );
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
        'What the next run will use: the model, what gets photographed, ' +
        'whether the model sees screenshots, and whether AI may be used at ' +
        'all — plus where each value came from (the server, this project, or ' +
        'something set on this session).\n\n' +
        'Pass session_id to ask about one session. Settings are per session, so ' +
        'the answer for the session you have been running in is the one that ' +
        'matters; without an id you get the server-wide defaults.\n\n' +
        'Reports what is there without starting anything — asking which model is ' +
        'in play should not cause a server to exist. If nothing is running you ' +
        'get running: false rather than an error.\n\n' +
        'Change any of these by passing model / capture / full_page / ' +
        'send_screenshots / ai to run_steps or run_test_file; they stick to the ' +
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
              ai: null,
              aiOffReason: null,
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
          // `?? null` on the §9 pair, and only there: a Sessions API server that
          // predates the AI switch answers `GET /config` without them, and a
          // missing key fails output validation outright.
          ai: effective.ai ?? null,
          aiOffReason: effective.aiOffReason ?? null,
          sources: effective.sources ? { ...effective.sources, ai: effective.sources.ai ?? null } : null,
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
                  ai: overrides.ai === 'default' ? null : (overrides.ai ?? null),
                },
          serverDefaults: {
            model: report.server.model,
            capture: report.server.capture,
            fullPage: report.server.fullPage,
            sendScreenshots: report.server.sendScreenshots,
            ai: report.server.ai ?? null,
          },
        };
        return validated(
          schemas.getRunSettingsOutput,
          value,
          `${report.session ? `Session ${report.session.sessionId}` : 'Server defaults'}: ` +
            `model ${effective.model} (${effective.sources.model}), capture ` +
            `${effective.capture} (${effective.sources.capture}), model sees ` +
            `screenshots: ${effective.sendScreenshots ? 'yes' : 'no'}` +
            // `value.overrides`, not `overrides`: already folded to
            // `'on' | 'off' | null`, so "default" cannot read as a divergence.
            aiSaidWithOverride(
              effective.ai ?? null,
              effective.aiOffReason ?? null,
              value.overrides?.ai ?? null,
            ),
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
        '`executing` — the page may move under you.\n\n' +
        'This reads a run_steps SESSION. To read a tab the user has open — one ' +
        'no session is sitting on — that is **peek_tab**, which takes the tab ' +
        'by name and creates nothing. That includes photographing it: peek_tab ' +
        'answers `format: "screenshot"` too, so a tab with no session is never ' +
        'a reason to reach for some other tool to get a picture.\n\n' +
        'An errand leaves no session behind either, so there is nothing here ' +
        'to read after run_errand: read the tab it drove with peek_tab. When ' +
        'the drive and the read are one job, have the errand capture what you ' +
        'need as a step instead ("read the balance, store as balance") — its ' +
        'receipt returns the captures and the final url and title, in one call.',
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
            try {
              return await screenshotResult(client, args.session_id, extra.signal);
            } catch (err) {
              // The server's honest 404 reads as a mystery to a model that just
              // watched its errand succeed — swap in the two working doors.
              // Route-missing 404s (ApiRouteNotFoundError) fall through: "rebuild
              // the server" and "no such session" are opposite remedies.
              if (err instanceof ApiHttpError && !(err instanceof ApiRouteNotFoundError) && err.status === 404) {
                return errorResult(pageContentSessionGone(args.session_id));
              }
              throw err;
            }
          }

          let page;
          try {
            page = await client.getPageContent(
              args.session_id,
              {
                format: args.format,
                selector: args.selector,
                maxChars: args.max_chars,
              },
              extra.signal,
            );
          } catch (err) {
            if (err instanceof ApiHttpError && !(err instanceof ApiRouteNotFoundError) && err.status === 404) {
              return errorResult(pageContentSessionGone(args.session_id));
            }
            throw err;
          }

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

  // -- log_into_site (SPEC 29) ----------------------------------------------
  //
  // The description is doing real work here, and two of its sentences are the
  // feature's whole safety posture restated for the reader who will actually
  // act on it: never ask the user to type a password into the chat, and never
  // retry a denial. A model that does either has undone the design regardless
  // of what the code enforces.
  server.registerTool(
    'log_into_site',
    {
      title: 'Sign in to the page you are on',
      description:
        'Sign in to the site in this session\'s current tab, using the ' +
        'credential the user has saved in Bitwarden for it.\n\n' +
        '**There is no site argument — the page you are already on IS the ' +
        'site.** Navigate to the sign-in page first, then call this. You never ' +
        'see the username or password: this fills the form itself and tells ' +
        'you only what happened.\n\n' +
        'Call it when you land on a sign-in page for a site the user asked you ' +
        'to work in — either because they asked you to log in, or because a ' +
        'login wall interrupted an errand. Calling it on a page with no form ' +
        'is free and harmless: it answers `not-a-login-page` without reading ' +
        'the vault or interrupting anyone. The user is asked to approve every ' +
        'sign-in, once per site.\n\n' +
        'Multi-page sign-ins (email, then password, then a code) take several ' +
        'calls: when `continues` is true, wait for the next page to load and ' +
        'call again.\n\n' +
        '**If it answers `no-credential-for-this-site`, tell the user to add ' +
        'the login to Bitwarden — never ask them to type a password to you, ' +
        'and never type one into a page yourself. If it answers `denied`, ' +
        'stop; do not call again for that site.**',
      inputSchema: schemas.logIntoSiteInput,
      outputSchema: schemas.logIntoSiteOutput,
    },
    async (args, extra) =>
      withProject(
        deps,
        args.project_root,
        async (client) => {
          // The same gate `get_page_content` applies, for a stronger reason:
          // that one discloses what a developer's session is signed in to,
          // and this one would SIGN IT IN — driving their browser and
          // spending an approval on a tab they are using.
          checkSessionOwnership(
            args.session_id,
            args.allow_foreign_session === true,
            'signing in would drive their browser and use their saved credentials',
          );

          const hint =
            args.hint_username_selector || args.hint_password_selector || args.hint_otp_selector
              ? {
                  username: args.hint_username_selector,
                  password: args.hint_password_selector,
                  otp: args.hint_otp_selector,
                }
              : undefined;

          let login;
          try {
            login = await client.logIntoSite(args.session_id, { hint }, extra.signal);
          } catch (err) {
            if (err instanceof ApiHttpError && !(err instanceof ApiRouteNotFoundError) && err.status === 404) {
              return errorResult(pageContentSessionGone(args.session_id));
            }
            throw err;
          }

          // Normalised to the schema's required-and-nullable shape, the way
          // `list_cdp_browsers` normalises: a server from a build that predates
          // a field would otherwise fail validation and cost the agent the
          // result of a login that already happened.
          const value = {
            outcome: login.outcome,
            domain: login.domain ?? '',
            framedBy: login.framedBy ?? null,
            item: login.item ?? null,
            candidates: login.candidates ?? null,
            detail: login.detail ?? '',
            continues: login.continues ?? false,
          };
          return validated(schemas.logIntoSiteOutput, value, `${login.outcome} — ${login.detail}`);
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
        'Some sites refuse a browser that reports itself as automated ' +
        '(`navigator.webdriver`), which a remote-debuggable Chrome does by ' +
        'default. `browser.cdp.hideAutomation: true` in `aiui.config.json` ' +
        'launches it without that signal. The file is the one for the root ' +
        'this browser lands in: for `scope: "user"` (the user\'s own browser) ' +
        'that is the user-level `aiui.config.json` (`%LOCALAPPDATA%\\aiui\\` on ' +
        'Windows, `~/.aiui/` elsewhere); for a project browser it is the ' +
        'project\'s. It is deliberately a config setting and not an argument ' +
        'here — a human holds it, an agent cannot set it. If a site turns the ' +
        'browser away, tell the user to add that setting (naming the file ' +
        'above) rather than looking for a way around the site. It applies at ' +
        'launch only; a browser already running keeps whatever it was started ' +
        'with, and `warnings` says when the running browser and the config ' +
        'disagree — relay that warning, since the fix is to close and restart ' +
        'the browser.\n\n' +
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
        'Three refusals, each of which tells you what to do next:\n' +
        '- **A session is driving that tab.** Close it with close_session ' +
        'first, or leave the tab alone if the session is still wanted.\n' +
        '- **An errand is driving that tab.** Wait for it and retry — an ' +
        'errand is one request, there is no way to end one early, and a tab it ' +
        'opened itself will normally be gone by then anyway.\n' +
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

          // The close route's 409 can now come from the errand turn lock as
          // well as from a session, and the two need different sentences — this
          // wrapper is where the holder shape picks one.
          const closed = await closeTabOrExplainHolder(client, {
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
          }, extra.signal);

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

  // -- peek_tab -------------------------------------------------------------
  server.registerTool(
    'peek_tab',
    {
      title: 'Read or photograph a tab the user already has open',
      description: PEEK_DESCRIPTION,
      inputSchema: schemas.peekTabInput,
      outputSchema: schemas.peekTabOutput,
    },
    async (args, extra) => {
      // Here, before `withProject` — so before a server is started, a registry
      // is read or a browser is touched. It needs no project to decide, and
      // the story's "refused before any browser work" is a property of where
      // this sits, not of what it says.
      //
      // The refusal fires only on a NON-EMPTY session_id. Some provider layers
      // serialize every declared optional as "", so a model told to call again
      // without it physically cannot — refusing "" strands it in a loop the
      // redirect sentence cannot break (measured live, OpenCode +
      // gpt-5.6-luna, 2026-08-13, on run_errand's identical argument).
      if (args.session_id !== undefined && args.session_id.trim() !== '') {
        return errorResult(peekSessionsAreForGetPageContent(args.session_id));
      }

      // Same place, same reasoning: an impossible combination should not start
      // a server to be told no (stories/cdp-tab-screenshot.md §Locked). The
      // route refuses these independently — it is reachable without this tool —
      // so this is the fast copy, not the only one.
      if (args.format === 'screenshot') {
        if (args.selector !== undefined) return errorResult(peekScreenshotArgConflict('selector'));
        if (args.max_chars !== undefined) return errorResult(peekScreenshotArgConflict('max_chars'));
      }

      return withProject(
        deps,
        args.project_root,
        async (client, project) => peekTab(client, project, args, extra.signal),
        // Auto-start is the default; a peek against a stopped server brings it
        // up rather than dying on a bare ECONNREFUSED.
        { signal: extra.signal },
      );
    },
  );

  // -- navigate_tab ---------------------------------------------------------
  server.registerTool(
    'navigate_tab',
    {
      title: 'Open a URL in a tab',
      description: NAVIGATE_DESCRIPTION,
      inputSchema: schemas.navigateTabInput,
      outputSchema: schemas.navigateTabOutput,
    },
    async (args, extra) =>
      withProject(
        deps,
        args.project_root,
        async (client, project) => navigateTab(client, project, args, extra.signal),
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
