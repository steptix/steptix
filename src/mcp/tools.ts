/**
 * The seven tools, and the run pipeline behind the two that matter.
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
import { allowedRoots, canonicalize, isInsideRoot, resolveTestsGlob } from './project.js';
import { discoverTestFiles } from '../parser/markdown.js';
import { foldRun, type FoldedRun } from './run-fold.js';
import { withSession } from './registry.js';
import * as schemas from './schemas.js';
import { probeHealth, normalizeBaseUrl } from '../server/health.js';
import {
  ApiHttpError,
  PreflightFailure,
  type ApiClient,
  type AssembledRun,
  type McpDeps,
  type RunEvent,
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
    return {
      content: [{ type: 'text', text: summary }, ...extra],
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
    return {
      content: [{ type: 'text', text: `${summary}\n\n(result validation failed: ${detail})` }],
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
      return preflightError(`${baseUrl} rejected the request (HTTP ${err.status}): ${err.serverMessage}`);
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
  sessionCreated: boolean;
  configApplied: boolean;
  queuedForMs: number;
  tokens: { total: number; input: number; output: number } | null;
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
): Promise<{ engine: string; profile: string }[]> {
  try {
    const browsers = await client.getCdpBrowsers({ projectRoot, includeForeign: false }, signal);
    return browsers.running.map((b) => ({ engine: b.engine, profile: b.profile }));
  } catch {
    return [];
  }
}

interface RunContext {
  deps: McpDeps;
  assembled: AssembledRun;
  sessionId: string;
  includeScreenshot: boolean;
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
    // A profile was resolved out of this project's own `running` list, so the
    // port is owned by construction and there is nothing for the gate to check.
    // A caller-supplied port has cleared no such thing and still owes one.
    if (gateOwed) {
      await assertPortAttachable(
        client,
        project.projectRoot,
        port,
        project.cdpPermissions,
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
      includeScreenshot: ctx.includeScreenshot,
    });

    return {
      ...folded,
      warnings: [...assembled.warnings, ...folded.warnings],
      reportPath: folded.reportPath,
      tokens: null,
      sessionId,
      projectRoot: project.projectRoot,
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
      const named = idle.map((b) => `${b.engine} "${b.profile}"`).join(', ');
      outcome.warnings = [
        ...outcome.warnings,
        `This run launched a fresh, signed-out browser, but this project has ` +
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
 * Resolve a project, make the server usable, and hand the body a client.
 *
 * Exists so the non-run tools report failures as well as the run tools do:
 * with `project` scoped inside each handler's own `try`, a 401 was caught
 * with no `envFilesConsulted` and no base URL — rendering §7's row as
 * " rejected our SERVER_API_KEY. Ours came from:  (or the environment)",
 * which names neither of the two things it exists to name.
 *
 * `autoStart` picks which guarantee the caller needs, and the split is by what
 * the tool is *for*, not by whether it happens to talk to the server:
 *
 *  - **off (the default)** — `assertServerRecognized`. For tools that report
 *    on what is already there. Asking "what is running?" must not cause a
 *    server to exist, and a `down` server is deliberately let through so the
 *    caller's own request fails with an ordinary connect error.
 *  - **on** — `ensureServerReady`, the same auto-start the run tools get. For
 *    tools whose whole purpose is to make something exist. `start_cdp_browser`
 *    reached this helper with the default and inherited a rule written for
 *    read-only probes: against a stopped server it died on a bare
 *    ECONNREFUSED, while `run_test_file` from the same agent a second earlier
 *    would have started the server for itself.
 *
 * Turning it on trades nothing away: `ensureServerReady`'s `unrecognized` arm
 * throws the same refusal, so the key still never reaches a squatter.
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
    // Before the key goes anywhere: without one of these an agent calling
    // `list_sessions` as a harmless "what's running?" probe would hand the
    // project's key to whatever holds the port.
    await (opts.autoStart === true
      ? deps.ensureServerReady(project, opts.signal)
      : deps.assertServerRecognized(project, opts.signal));
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
  if (outcome.error) lines.push(`Error: ${outcome.error}`);
  if (outcome.reportPath) lines.push(`Report: ${outcome.reportPath}`);
  if (outcome.warnings.length > 0) lines.push(`Warnings: ${outcome.warnings.length}`);
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
otherwise. This project may also have a persistent CDP browser running that
holds real logins — to use it, pass config.cdp: {profile: "<name>"} (call
list_cdp_browsers if unsure which exist). Config is read only when a session is
CREATED, so pass it on the first call for a session; passing it later is
ignored.

Tab: attaching opens a NEW tab by default. To run in a tab that is already
open — one the user set up by hand — take its targetId from
list_cdp_browsers and pass config.cdp: {profile: "<name>", tab:
"targetId:<id>"}. Naming the profile alone leaves their tab untouched and
runs somewhere else.`.trim();

export function registerTools(server: McpServer, deps: McpDeps): void {
  // -- run_steps ------------------------------------------------------------
  server.registerTool(
    'run_steps',
    {
      title: 'Run steps',
      description:
        'Run natural-language steps in a real browser session and return per-step results.\n' +
        'Reuses one browser per project unless you pass a session_id, so successive calls ' +
        'share page state and captured variables. Calls on one session run one at a time.\n\n' +
        CDP_NOTE +
        '\n\n' +
        STEP_SYNTAX,
      inputSchema: schemas.runStepsInput,
      outputSchema: schemas.runResultOutput,
    },
    async (args, extra) => {
      const envFiles: string[] = [];
      let baseUrl = '';
      try {
        const assembled = await assembleSteps({
          resolveProject: deps.resolveProject,
          steps: args.steps,
          projectRoot: args.project_root,
          envName: args.env_name,
          parameters: args.parameters,
          config: args.config,
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
          includeScreenshot: args.include_screenshot === true,
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
        STEP_SYNTAX,
      inputSchema: schemas.runTestFileInput,
      outputSchema: schemas.runResultOutput,
    },
    async (args, extra) => {
      const envFiles: string[] = [];
      let baseUrl = '';
      try {
        const assembled = await assembleTestFile({
          resolveProject: deps.resolveProject,
          path: args.path,
          projectRoot: args.project_root,
          envName: args.env_name,
          parameters: args.parameters,
          config: args.config,
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
          includeScreenshot: args.include_screenshot === true,
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
        project = await deps.resolveProject({ projectRoot: args.project_root });
        const { dir, pattern } = resolveTestsGlob(project);
        // `tests.dir` is confined, but the pattern is not and glob honours
        // `../` inside it — so a hostile or simply wrong `aiui.config.json`
        // could enumerate .md paths outside every allowed root. Filtering the
        // results also covers a symlinked tests directory.
        const roots = allowedRoots();
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
          `${sessions.length} open session(s)`,
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
          // The page goes in a CONTENT BLOCK, not only in `structuredContent`.
          //
          // Every other tool here can get away with a one-line summary over
          // structured data, because for them the structure IS the answer — a
          // run's status, a list of sessions. This tool's entire answer is
          // verbatim text, and a client that surfaces only the content blocks
          // (many do) would hand the model `"Invoices — text, 2995 chars"`: a
          // description of the page instead of the page, with no error and a
          // plausible count. The model then reports on a page it never saw.
          // That is the confidently-wrong failure this whole feature exists to
          // prevent, and it was reintroduced at the last layer.
          //
          // The cost is that the page travels twice — once here, once in
          // `structuredContent`, which cannot be dropped because declaring an
          // `outputSchema` obliges the SDK to require it. Worth it: a payload
          // that is twice as large beats one the reader never receives.
          return validated(
            schemas.getPageContentOutput,
            value,
            `${page.title || page.url}${scope} — ${page.format}, ${size}`,
            [{ type: 'text', text: page.content }],
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
        'Persistent CDP browsers and profiles for this project.\n\n' +
        '`running` — live browsers. Pass one of these ports as ' +
        'config.cdp.port to run steps in it.\n' +
        '`available` — profiles that exist but have nothing running. **These ' +
        'are directories, not browsers**; call start_cdp_browser with the ' +
        'profile name before sending steps to it. A profile keeps its logins ' +
        'while dormant.\n' +
        '`foreign` — browsers this project did not start. Reported so you can ' +
        'see them; you cannot drive them unless a human sets ' +
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
        // reason `list_sessions` normalises `tab`.
        const normalized = {
          ...browsers,
          running: browsers.running.map((b) => ({
            ...b,
            tabs: b.tabs.map((t) => ({ ...t, sessionId: t.sessionId ?? null })),
          })),
        };
        return validated(
          schemas.listCdpBrowsersOutput,
          normalized as unknown as Record<string, unknown>,
          summarizeBrowsers(browsers),
        );
      }),
  );

  // -- start_cdp_browser ----------------------------------------------------
  server.registerTool(
    'start_cdp_browser',
    {
      title: 'Start a CDP browser',
      description:
        'Launch a headed Chrome or Edge this project owns, and return the port ' +
        'to drive it through. Returns the **already-running** browser if that ' +
        'profile has one — the profile name is what selects between browsers, ' +
        'so asking twice does not start two.\n\n' +
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
          const started = await client.startCdpBrowser({
            projectRoot: project.projectRoot,
            engine: args.engine,
            ...(args.profile !== undefined ? { profile: args.profile } : {}),
            ...(args.reset === true ? { reset: true } : {}),
          });
          return validated(
            schemas.startCdpBrowserOutput,
            started as unknown as Record<string, unknown>,
            `${started.engine} "${started.profile}" on port ${started.port} — ${started.outcome}` +
              (started.warnings.length > 0 ? `\n${started.warnings.join('\n')}` : ''),
          );
        },
        // The one tool here whose job is to make something exist, so it gets
        // the run tools' auto-start rather than the probes' identity check.
        { autoStart: true, signal: extra.signal },
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
          // Same exactly-one rule as `config.cdp`, and refused for the same
          // reason: two addresses that disagree have no correct winner, and
          // this call closes something.
          const { port, gateOwed } = await resolveCdpTarget(
            client,
            project.projectRoot,
            {
              ...(args.profile !== undefined ? { profile: args.profile } : {}),
              ...(args.engine !== undefined ? { engine: args.engine } : {}),
              ...(args.port !== undefined ? { port: args.port } : {}),
            },
            extra.signal,
            // The tool's own field names, so the refusal names arguments this
            // call actually has.
            cdpTabTargetAmbiguous,
          );
          // A port resolved from this project's `running` list is owned by
          // construction. A caller-supplied one is not, and closing tabs in a
          // browser is at least as intrusive as driving it — so it clears the
          // same gate, with the same human-held opt-in behind it.
          if (gateOwed) {
            await assertPortAttachable(
              client,
              project.projectRoot,
              port,
              project.cdpPermissions,
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
            warnings: closed.warnings ?? [],
          };

          // The summary is all a host that ignores structured content will
          // show, so it carries the two things a user asked "close the
          // openrouter tab" actually wants back: which tab went, and whether
          // the browser went with it.
          const what = closed.title || closed.url || closed.targetId;
          const browser = result.owned
            ? `${result.engine} "${result.profile}"`
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
        // Acts on live browser state, like the run tools — not a read-only
        // probe. Kept off `ensureServerReady` would mean a close against a
        // stopped server died on a bare ECONNREFUSED.
        { autoStart: true, signal: extra.signal },
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
