/**
 * HTTP+SSE client for the ai-ui-automation API server.
 *
 * Transport-only: no error formatting, no .env parsing. Callers map the
 * `ApiClientError` codes below into the user-facing TBxxx catalogue.
 */

import { SseParser, type SseFrame } from './sse-parser.js';
import type {
  CompileEvent,
  CompileRequest,
  RecordControlRequest,
  RecordStepsEvent,
  RecordStepsRequest,
  RunEvent,
  StepMode,
} from './protocol.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export type LogFileMode = 'off' | 'compact' | 'full';

/** Per-run token totals (frozen snapshot from the server). */
export interface RunTokens {
  total: number;
  input: number;
  output: number;
}

/**
 * Last finalized run for a session — report path + token totals. Returned by
 * `getLastRun` so a client that stopped a run can recover what the dropped
 * `done` event carried (issue 021). `tokens` is absent only on a malformed/older
 * payload; `reportPath` is absent when no report was written.
 */
export interface LastRunInfo {
  finalized: boolean;
  tokens?: RunTokens;
  reportPath?: string;
}

export interface StreamStepsRequest {
  steps: string[];
  /** Per-line break indices (1-based step indices into `steps`). */
  breakpoints?: number[];
  /**
   * Per-URI breakpoint sets keyed by absolute file path. Used by the server
   * to pause execution before any step whose origin (test file OR an
   * expanded skill/section body line) matches a breakpoint. The pause
   * surfaces as a `step:awaiting` event so the client treats it like a
   * step-paused state — same yellow ▶ + Continue / StepOver / StepInto /
   * StepOut machinery as the stepMode flow.
   *
   * The server skips a test-file breakpoint only for ROOT-frame (main-flow)
   * steps — those the client already trimmed at before sending, so pausing
   * again would double-trigger. A breakpoint on a SECTION BODY line is a
   * test-file entry too, but the body doesn't exist until server-side
   * expansion, so the client's `trimAtBreakpoint` can't see it; the server
   * honours it, along with skill-file breakpoints (also expansion-only).
   * Those non-root cases are the primary motivation for this field.
   */
  breakpointsByUri?: Record<string, number[]>;
  /** Per-request env (e.g. AI_API_KEY). Server applies these to the session, not its own process.env. */
  env?: Record<string, string>;
  /**
   * Active environment name. The server uses it to load `.env.<envName>` and
   * `<dataDir>/<envName>.json` (`dataDir` = `tests.dataDir` in the project's
   * `aiui.config.json`, default `data`) from the **test file's project root**
   * (resolved from `testFilePath`, not the server's cwd) and apply `${env.X}` /
   * `${data.X.Y}` interpolation to each step. Empty/omitted ⇒ no env-data
   * interpolation (steps with `${...}` placeholders will fail).
   */
  envName?: string;
  /**
   * The test's own frontmatter `dataSources` (name → path). Forwarded so the
   * server can resolve `${<name>.X}` test-level named sources (relative to the
   * test file's dir) on the server path, not just the CLI parse path.
   */
  dataSources?: Record<string, string>;
  parameters?: Record<string, string>;
  /**
   * Per-session config, write-once: the server refuses a batch that carries
   * `config` for a session it already created, so clients send it on the
   * first request of a session and omit it thereafter.
   *
   * `viewport` is the RAW `## Config: viewport:` string as authored — a
   * preset name (`mobile` | `tablet` | `desktop`) or `<width>x<height>`
   * (stories/per-test-viewport.md §3). The client does not resolve or
   * validate it: the server owns the one resolver and the one error message,
   * so a client that pre-parsed it could only disagree with the server. `$VAR`
   * resolution still happens client-side (TestBench's `.env` overlay), same as
   * `baseUrl` — what travels is the post-`$VAR`, pre-preset string.
   */
  config?: { baseUrl?: string; timeout?: string; viewport?: string };
  /** Map of 1-based step index → original source line in the test file. Echoed back in events. */
  sourceLines?: number[];
  /**
   * Write the DOM either side of every step to the recording beside the test
   * when the run ends (stories/codebehind-recording-on-disk.md). How a
   * compile's own Record asks for its input; nothing sends it on an ordinary
   * run.
   */
  captureStepContext?: boolean;
  /**
   * Compile the steps this run executes, as it executes them
   * (stories/compile-as-you-go.md).
   *
   * `'run'` is **Run & Compile**: an ordinary run of the whole test that also
   * generates an entry for every step that ran under AI, reviews the files at
   * the end, and returns the proposal on `compile:result`. `'steps'` is
   * **Compile This Step**: the sent steps only, with code-behind execution
   * disabled so a broken entry re-records under AI, no Review, and the
   * recording spliced rather than replaced.
   *
   * Either value turns capture on server-side, so `captureStepContext` need
   * not be sent alongside. The server never writes a `.steps.ts` on this
   * path — the proposal rides the stream and the client applies it.
   */
  compile?: 'run' | 'steps';
  /**
   * This request continues a compile already open in the session, rather than
   * starting one.
   *
   * A logical run is several requests whenever an `[input:]` or
   * `[interactive]` step splits it, or a breakpoint ends one batch and leaves
   * Continue to send the rest. Every block after the first sets this, so the
   * server keeps ONE candidate and one step numbering for the run instead of
   * giving each block its own and letting the last overwrite the recording.
   */
  compileContinues?: boolean;
  /**
   * Attribution for a `compile: 'steps'` request whose steps come from a
   * `### Section` body. Execution is unchanged — the steps still run
   * detached, at the root frame, as Run Step Here runs them — but the entry
   * binds under this section's scope, which is where the runtime looks for it.
   */
  compileScope?: { section: string };
  /**
   * This batch belongs to a compile of MODE `x`, but asks for no compile of
   * its own.
   *
   * Rows 2..N of a data-driven Run & Compile, or of a Compile This Step in a
   * table file. One entry serves every row, so only the first row carries
   * `compile` — but every row is part of the run the author asked to compile,
   * and the server decides two things per BATCH from that field:
   *
   * - the AI switch (`ai.allowInRuns`, `runSettings.ai`), which carves out a
   *   compile. Without this field a project with AI off in runs gives row 1 a
   *   diff and fails rows 2..N with "this run forbids AI".
   * - whether code-behind EXECUTES. A `'steps'` compile runs its steps under
   *   AI so a broken entry re-records, and rows 2..N of one have to run the
   *   same way: a row that ran the existing (broken) entry would throw, heal,
   *   and paint ⚠ on the very step being repaired.
   *
   * Hence the mode rather than `true`: it is the same two answers as
   * `compile`, minus the compile. It opens no compiler, proposes no file, and
   * cannot turn a plain run into a compile — and the server refuses it
   * alongside `compile`, and without a `testFilePath`.
   */
  withinCompileRun?: 'run' | 'steps';
  /**
   * Absolute path of the file each step in `steps` was authored in. Parallel
   * to `steps`; defaults to the test file when omitted per-step. Used by the
   * server to attribute frame origins when a request is sent already-expanded
   * (rare today; reserved for client-side expansion paths).
   */
  sourceUris?: string[];
  /**
   * Absolute path to the project's skills directory (`skillsDir` in
   * `aiui.config.*`). When supplied, the server runs `expandSkills` over the
   * incoming `steps`, dispatches the flattened result, and emits
   * `frame:push` / `frame:pop` events around each skill body. Omit to use
   * the legacy behaviour (raw steps shipped straight to the runner — fine
   * for tests with no `[skill: ...]` lines).
   */
  skillsDir?: string;
  /**
   * Inline section definitions from the test file, keyed by `matchText(name)`
   * (stories/test-script-sections-contract.md §2). Required whenever `steps`
   * (or `fullSteps`) may contain bare-name section calls — the server cannot
   * read the file, since the buffer may be unsaved. Line numbers are 1-based
   * in the same document as `sourceLines`. Requires `testFilePath`: section
   * frames and cycle keys derive from it, and the server answers 400 without
   * it.
   *
   * Omit when there are no sections. `{}` is truthy in JS and several server
   * gates read `request.sections` directly, so an empty map sent where the
   * field could have been omitted risks flipping a sectionless run onto the
   * expansion path.
   */
  sections?: Record<
    string,
    {
      /**
       * As authored, casing preserved. Display only — never re-derive the
       * key from it; the server uses the incoming keys verbatim.
       */
      name: string;
      headingLine: number;
      /**
       * The raw line with `/^\s*\d+\.\s+/` removed and `.trim()` applied,
       * with `[no-hooks]` markers preserved **verbatim** — the expander
       * strips them when it inlines a body, and stripping here as well would
       * hide a body step's opt-out from the server's hook logic.
       * Empty-after-strip items are culled, so this never contains a
       * marker-only entry.
       */
      steps: string[];
      /** Parallel to `steps`. */
      stepLines: number[];
      /** Rows from a table under the `### Name` heading: the section`s body
       *  runs once per row, in the same session (part B). Absent when the
       *  section has no table. */
      rows?: Array<Record<string, string>>;
    }
  >;
  /**
   * Absolute path of the test file the steps were authored in. Used as the
   * URI for the top-level (test) frame when the server emits frame events.
   * Optional; servers without frame support ignore it.
   */
  testFilePath?: string;
  /**
   * Absolute path to the project's tools directory (`toolsDir` in
   * `aiui.config.*`). When supplied, the server loads the tool catalogue
   * once per session and dispatches `[tool: ...]` steps through
   * `executeToolStep` — without it, tool lines reach the AI as plain text.
   */
  toolsDir?: string;
  /**
   * Initial step-mode for the run. `continue` (default) runs to completion
   * or the next breakpoint; `into` / `over` / `out` start the run paused
   * between steps so the client can drive step-by-step execution via the
   * `runControl` endpoint. Servers that don't support stepMode ignore the
   * field — the run executes as a normal `continue`.
   */
  stepMode?: StepMode;
  /**
   * One-shot tool step-into trigger (Phase 5). When true, the server emits
   * `tool:awaiting-debugger` before the next `[tool: ...]` step and parks
   * for the debugger-attach ack. Seeded on the initial body when the run is
   * relaunched from a breakpoint pause; the step-paused path sends the same
   * flag via `runControl` instead.
   */
  pauseAtNextTool?: boolean;
  /**
   * One-shot code-behind step-into trigger (stories/codebehind-debugging.md).
   * Consumed at the next executed step: if that step has a bound code-behind
   * entry the server emits `codebehind:awaiting-debugger`, parks for the ack,
   * then pauses on a `debugger;` right before the entry's `run()`. A step
   * with no entry consumes the flag silently.
   */
  pauseAtNextCodeBehind?: boolean;
  /**
   * Per-request logging override. Each field falls back to the server's
   * configured default when omitted. Override scope is this request only —
   * the server restores its default after the run completes.
   */
  logging?: {
    consoleLogLevel?: LogLevel;
    serverFileLogLevel?: LogFileMode;
  };
  /**
   * Which data row of a data-driven run this batch is, 1-based
   * (stories/data-driven-rows.md, part A). The client owns the loop; the
   * server owns the report.
   *
   * A batch carrying `dataRow` writes no report and its `done` carries no
   * `reportPath`: the results join a row accumulator, and `finalizeRowReport`
   * renders the one report the run gets when the loop ends.
   */
  dataRow?: number;
  /** How many rows the run has. Required alongside `dataRow`. */
  dataRowCount?: number;
  /**
   * The row's own cells, for the report's matrix table and loop bands. Not
   * recoverable from `parameters`, which is the row already merged over the
   * test's `## Parameters`.
   */
  dataRowValues?: Record<string, string>;
  /**
   * Full post-expansion step list for the test. A multi-batch run
   * (breakpoint pause + Continue, an `[input:]` split, a subset run) sends
   * only a slice in `steps`, and the server still needs the whole document:
   * `runStart` resolves the surface the run starts on from it, dead-section
   * liveness scans it rather than the slice, and comparing it with `steps`
   * is how the server tells a subset batch from a full-document one.
   * Single-batch runs can omit it; the server falls back to `steps`.
   */
  fullSteps?: string[];
  /**
   * Partial / bounded re-run anchors ("re-run a skill step" and "debug a skill
   * after Stop"). `startAt` skips every expanded step before the first in file
   * `startAt.uri` at/after `startAt.line`; `endAt` stops after the last step in
   * `endAt.uri` at/before `endAt.line` (omit ⇒ run to the end of the skill body).
   * Both are qualified by `uri` so a recurring line can't false-match.
   */
  startAt?: { uri: string; line: number };
  endAt?: { uri: string; line: number };
  /**
   * Captured/runtime vars to inject into the session scope before a partial
   * re-run, so steps that read values a skipped earlier step produced still
   * resolve. `__skill*`-namespaced internals are ignored server-side.
   */
  seedScope?: Record<string, string>;
  /**
   * This batch STARTS a run rather than continuing one, and where in the file
   * it starts (SPEC-use-computer.md §4.5; `StepRequest.runStart` in
   * src/server/session-manager.ts, which this mirrors — nothing links the two
   * copies, so change both together).
   *
   * The server resets the session's surface to the one the run's first step
   * is on: the last top-level `[use …]` line in `fullSteps` above
   * `stepIndex` (the 0-based position, in `fullSteps`, of the first step this
   * run executes — see `runStartFor`), or `browser` when there is none. Sent
   * on the first block of every run the user started — Run, Run From Here,
   * Run Step Here, each row of a kept-session row loop — and NEVER on a
   * Continue, a step command from a pause, the later blocks of a split run,
   * or a re-run injected against the paused page: those continue the surface
   * the run left. Without it, a run that failed inside `[use computer]` hands
   * the next Run the real mouse.
   *
   * "First block" is the first batch the run SENDS, so a started run that
   * parked before sending one (a breakpoint on its first step, an `[input:]`
   * then a breakpoint) owes it to its Continue's first block — the one
   * Continue that does carry it — and an `[interactive]` REPL turn is a batch
   * like any other.
   */
  runStart?: { stepIndex?: number };
}

export type ApiErrorKind =
  | 'connect-failed'
  | 'unauthorized'
  | 'not-found'
  /** The server refused because the same work is already running (409). */
  | 'conflict'
  | 'server-error'
  | 'stream-dropped'
  | 'aborted';

export class ApiClientError extends Error {
  override readonly name = 'ApiClientError';
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly bodyExcerpt?: string;

  constructor(
    kind: ApiErrorKind,
    message: string,
    extras: { status?: number; bodyExcerpt?: string } = {},
  ) {
    super(message);
    this.kind = kind;
    if (extras.status !== undefined) this.status = extras.status;
    if (extras.bodyExcerpt !== undefined) this.bodyExcerpt = extras.bodyExcerpt;
  }
}

/**
 * True when the error represents a user-initiated abort (e.g. Stop button)
 * rather than a network failure. Callers use this to suppress the noisy
 * "connection lost" error toast on intentional cancellation.
 *
 * Cross-bundle safe: when runner-core is bundled into a consumer (e.g.
 * esbuild bundles it into the testbench extension), `instanceof` against
 * an ApiClientError thrown by a different copy of this module returns
 * false. Fall back to duck-typing by name + kind so test fakes and any
 * non-bundled callers also signal aborts correctly.
 */
export function isUserAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof ApiClientError && err.kind === 'aborted') return true;
  const e = err as { name?: unknown; kind?: unknown };
  return e.name === 'ApiClientError' && e.kind === 'aborted';
}

/**
 * The sentence a refusal carried, for a caller that shows it to a person.
 *
 * An express route refuses with `{ "error": "…" }`, and `postSse` keeps the
 * first 240 characters of that body as `bodyExcerpt` while its `message` is
 * only `HTTP 400`. A long reason is therefore truncated JSON that
 * `JSON.parse` rejects, so the `"error"` string is also read by pattern
 * before falling back to the message. Duck-typed like `isUserAbort`, for the
 * same cross-bundle reason.
 */
export function apiErrorReason(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { message?: unknown; bodyExcerpt?: unknown };
  const excerpt = typeof e.bodyExcerpt === 'string' ? e.bodyExcerpt : undefined;
  const parsed = errorFrom(excerpt);
  if (parsed) return parsed;
  const partial = excerpt ? /"error"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(excerpt) : null;
  if (partial && partial[1]) return partial[1].replace(/\\(.)/g, '$1');
  return typeof e.message === 'string' && e.message !== '' ? e.message : String(err);
}

/**
 * What a `fetch()` rejection actually says, with the cause Node hides.
 *
 * Undici reports every transport failure — connection refused, DNS miss, TLS
 * rejection, proxy failure — as `TypeError: fetch failed` and parks the real
 * error on `cause`. A log line carrying only the outer message leaves the
 * reader with nothing to act on (which host? refused, or unresolvable, or a
 * bad certificate?). This walks the `cause` chain and joins each link with
 * `: `, so the line reads `fetch failed: connect ECONNREFUSED 127.0.0.1:3100`
 * or `fetch failed: getaddrinfo ENOTFOUND build-box`.
 *
 * A `localhost` URL is the common case and the awkward one: Node connects to
 * `::1` and `127.0.0.1` in turn and wraps both failures in an `AggregateError`
 * whose own message is EMPTY, so the chain has to descend into `errors[]`
 * (`connect ECONNREFUSED ::1:3100; connect ECONNREFUSED 127.0.0.1:3100`)
 * or the line would end in a bare `fetch failed: `.
 *
 * Mid-stream drops take the same shape (`terminated` with a `SocketError`
 * cause), so the stream-dropped path uses it too. Non-Error values stringify.
 */
export function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  // Depth-capped: a cause chain is one or two links long in practice, and a
  // cyclic one (seen on some hand-built errors) must not spin.
  while (cursor !== undefined && cursor !== null && !seen.has(cursor) && parts.length < 6) {
    seen.add(cursor);
    parts.push(describeOneError(cursor));
    cursor = typeof cursor === 'object' ? (cursor as { cause?: unknown }).cause : undefined;
  }
  return parts.join(': ');
}

function describeOneError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { name?: unknown; message?: unknown; code?: unknown; errors?: unknown };
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    // AggregateError: the members carry the story; the wrapper's message is
    // empty (dual-stack connect) or generic ("All promises were rejected").
    return e.errors.map(describeFetchError).join('; ');
  }
  const message =
    typeof e.message === 'string' && e.message !== ''
      ? e.message
      : typeof e.name === 'string'
        ? e.name
        : String(err);
  // A `code` not already in the message (undici's UND_ERR_* codes pair with
  // prose like "Connect Timeout Error") is the greppable part — keep it.
  const code = typeof e.code === 'string' ? e.code : '';
  return code !== '' && !message.includes(code) ? `${code}: ${message}` : message;
}

export interface ApiClientOptions {
  serverUrl: string;
  apiKey: string;
  /** Test seam — defaults to global fetch. */
  fetch?: typeof fetch;
}

export class ApiClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.serverUrl = stripTrailingSlash(opts.serverUrl);
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Stream a step batch and yield typed events as they arrive.
   * Aborts cleanly on `signal.abort()` — the underlying fetch is cancelled
   * and an `aborted`-kind ApiClientError is thrown if the consumer keeps
   * pulling.
   */
  async *streamSteps(
    sessionId: string,
    request: StreamStepsRequest,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    yield* this.postSse<RunEvent>(
      `/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`,
      request,
      signal,
    );
  }

  /**
   * Compile a test's code-behind and stream the phases
   * (stories/codebehind-compile.md §Server).
   *
   * The same SSE framing as `streamSteps` over a different route and a
   * different event vocabulary. The stream's last frame is `compile:result`,
   * carrying the proposed file content — the server writes nothing under the
   * project, so a caller that stops iterating before that frame has thrown the
   * compile away.
   *
   * A 409 means a compile of this test file is already running; it surfaces as
   * an `ApiClientError` of kind `conflict` so the caller can say so rather than
   * reporting a server fault.
   */
  async *compileCodeBehind(
    request: CompileRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompileEvent> {
    yield* this.postSse<CompileEvent>('/codebehind/compile', request, signal);
  }

  /**
   * Record Steps (stories/testbench-record-steps.md §On the wire): hold the
   * session while the author clicks through the app, and stream one
   * `record:action` per action, then `record:result` and `done` once
   * `controlRecordSteps({ action: 'stop' })` arrives.
   *
   * The same SSE framing as `streamSteps`. Refusals surface as the usual
   * `ApiClientError` kinds: `conflict` (409) when a run holds the session's
   * queue, `server-error` with the server's reason in `bodyExcerpt` (400) on
   * a headless server — `apiErrorReason` reads it out — and `not-found` (404)
   * from a server that predates the route.
   *
   * Aborting `signal` closes the stream, which the server takes as `cancel`.
   */
  async *streamRecordSteps(
    sessionId: string,
    request: RecordStepsRequest,
    signal: AbortSignal,
  ): AsyncIterable<RecordStepsEvent> {
    yield* this.postSse<RecordStepsEvent>(
      `/sessions/${encodeURIComponent(sessionId)}/record-steps`,
      request,
      signal,
    );
  }

  /**
   * Steer a running recording: `stop` (write the steps, leaving `dropped`
   * out), `check` / `cancel-check` (Add check), `cancel` (end, write nothing).
   * The server answers 202; what happens next arrives on the record stream.
   *
   * 404 — no recording is running — is `not-found`, which a caller racing the
   * stream's own end can ignore.
   */
  async controlRecordSteps(sessionId: string, body: RecordControlRequest): Promise<void> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/record-steps/control`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiClientError('connect-failed', describeFetchError(err));
    }
    if (response.status === 401) {
      throw new ApiClientError('unauthorized', 'Unauthorized', { status: 401 });
    }
    if (response.status === 404) {
      const excerpt = await safeReadBodyExcerpt(response);
      throw new ApiClientError('not-found', errorFrom(excerpt) ?? 'No recording is running', {
        status: 404,
        ...(excerpt !== undefined && { bodyExcerpt: excerpt }),
      });
    }
    if (response.status >= 400) {
      const excerpt = await safeReadBodyExcerpt(response);
      throw new ApiClientError('server-error', `HTTP ${response.status}`, {
        status: response.status,
        ...(excerpt !== undefined && { bodyExcerpt: excerpt }),
      });
    }
  }

  /**
   * POST a JSON body, read the SSE response, yield one parsed event per frame.
   *
   * Shared by the streaming clients rather than written twice: the error
   * mapping, the abort handling and the reader teardown are all load-bearing in
   * ways that are not obvious from reading them, and two copies is how one of
   * them quietly loses a fix.
   */
  private async *postSse<T>(
    route: string,
    request: unknown,
    signal: AbortSignal,
  ): AsyncIterable<T> {
    const url = `${this.serverUrl}${route}`;
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(request),
      });
    } catch (err) {
      if (signal.aborted) throw new ApiClientError('aborted', 'aborted');
      const reason = describeFetchError(err);
      throw new ApiClientError('connect-failed', reason);
    }

    if (response.status === 401) {
      throw new ApiClientError('unauthorized', 'Unauthorized', { status: 401 });
    }
    if (response.status === 404) {
      throw new ApiClientError('not-found', 'Not Found', { status: 404 });
    }
    // 409 is a refusal with a reason the caller can act on — a compile of this
    // test is already running. Kept out of the `server-error` bucket so the UI
    // can say "already compiling" rather than "the server broke".
    if (response.status === 409) {
      const body = await safeReadBodyExcerpt(response);
      throw new ApiClientError('conflict', errorFrom(body) ?? 'Conflict', {
        status: 409,
        ...(body !== undefined && { bodyExcerpt: body }),
      });
    }
    if (response.status >= 500 || (response.status >= 400 && response.status !== 401 && response.status !== 404)) {
      const body = await safeReadBodyExcerpt(response);
      throw new ApiClientError('server-error', `HTTP ${response.status}`, {
        status: response.status,
        ...(body !== undefined && { bodyExcerpt: body }),
      });
    }

    if (!response.body) {
      throw new ApiClientError('server-error', 'Server returned no response body', {
        status: response.status,
      });
    }

    const parser = new SseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      // Standard async iteration via getReader() — works in Node 18+ and browsers.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal.aborted) throw new ApiClientError('aborted', 'aborted');
          const reason = describeFetchError(err);
          throw new ApiClientError('stream-dropped', reason);
        }

        if (chunk.done) break;
        const frames = parser.push(decoder.decode(chunk.value, { stream: true }));
        for (const frame of frames) {
          const event = frameToEvent<T>(frame);
          if (event) yield event;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Liveness probe: `GET /sessions/:id`. Returns true if the server still
   * holds a live (non-closed) session under this id, false if it's gone
   * (404). The testbench "re-run a skill step" path calls this before reusing
   * a session — the server would otherwise silently replace a dead session
   * with a fresh blank browser and run the tail against `about:blank`.
   * Throws `ApiClientError('connect-failed')` if the server is unreachable so
   * the caller can distinguish "server down" from "session gone".
   */
  async isSessionAlive(sessionId: string): Promise<boolean> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey },
      });
    } catch (err) {
      const reason = describeFetchError(err);
      throw new ApiClientError('connect-failed', reason);
    }
    if (response.status === 401) {
      throw new ApiClientError('unauthorized', 'Unauthorized', { status: 401 });
    }
    return response.status === 200;
  }

  /**
   * Fetch the last finalized run's report path + token totals for a session
   * (issue 021). The delivery channel for a STOPPED run: stopping aborts the SSE
   * stream before the final `done` event, so the report path/tokens are dropped
   * in transit — the client polls this until `finalized` then reads both.
   *
   * Defensive about server age: an older server has no such route and 404s,
   * which we surface as `null` (caller falls back / stops polling). Body fields
   * are read tolerantly so a partial/older payload yields `undefined`, not a
   * throw. Throws `ApiClientError('connect-failed')` on a transport failure and
   * `('unauthorized')` on 401, mirroring `isSessionAlive`.
   */
  async getLastRun(sessionId: string): Promise<LastRunInfo | null> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/last-run`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey },
      });
    } catch (err) {
      const reason = describeFetchError(err);
      throw new ApiClientError('connect-failed', reason);
    }
    if (response.status === 401) {
      throw new ApiClientError('unauthorized', 'Unauthorized', { status: 401 });
    }
    if (response.status === 404) {
      return null; // older server without the route
    }
    if (response.status !== 200) {
      return null;
    }
    const body = (await response.json().catch(() => ({}))) as Partial<LastRunInfo>;
    return {
      finalized: body.finalized === true,
      ...(body.tokens && { tokens: body.tokens }),
      ...(typeof body.reportPath === 'string' && { reportPath: body.reportPath }),
    };
  }

  /**
   * Render the one report of a data-driven run and return its path.
   *
   * Posted when the client's row loop ends, however it ends — last row, Stop,
   * a pause parking the run, a thrown row. It is a separate call rather than a
   * flag on the last batch because the client cannot know which batch is the
   * last one until that batch comes back.
   *
   * `notRun` lists the rows the loop planned and never reached, so their lines
   * in the matrix table can say so; only the client knows them. Returns null
   * when the server has nothing accumulated (a 404), which is what a
   * double-post after a crash looks like and is harmless.
   */
  async finalizeRowReport(
    sessionId: string,
    notRun: Array<{ row: number; values: Record<string, string>; reason: string }> = [],
  ): Promise<{ reportPath: string } | null> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/report`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify({ notRun }),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to finalise the run's report (HTTP ${String(res.status)}).`);
    }
    const body = (await res.json()) as { reportPath?: unknown };
    return typeof body.reportPath === 'string' ? { reportPath: body.reportPath } : null;
  }

  /** Fire-and-best-effort: tells the server to drop the session and close the browser. */
  async closeSession(sessionId: string): Promise<void> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}`;
    try {
      await this.fetchImpl(url, {
        method: 'DELETE',
        headers: { 'x-api-key': this.apiKey },
      });
    } catch {
      // Best effort — ignore.
    }
  }

  /**
   * Send a step-control command to a session that is paused awaiting next-
   * step direction. Used to drive Step Into / Over / Out / Continue from
   * the UI. The server resolves the pending Promise in its step loop and
   * the SSE stream from `streamSteps` continues emitting events.
   *
   * Throws an `ApiClientError` of kind `not-found` if the session has no
   * paused run, or `server-error` for any other failure. Callers in the
   * extension translate those into a status-bar message — there's no
   * fatal-state recovery beyond surfacing the diagnostic.
   */
  async runControl(
    sessionId: string,
    mode: StepMode,
    opts?: { pauseAtNextTool?: boolean; pauseAtNextCodeBehind?: boolean },
  ): Promise<void> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          mode,
          ...(opts?.pauseAtNextTool && { pauseAtNextTool: true }),
          ...(opts?.pauseAtNextCodeBehind && { pauseAtNextCodeBehind: true }),
        }),
      });
    } catch (err) {
      const reason = describeFetchError(err);
      throw new ApiClientError('connect-failed', reason);
    }
    if (response.status === 401) {
      throw new ApiClientError('unauthorized', 'Unauthorized', { status: 401 });
    }
    // 409 (no paused run) is reported as 'not-found' so the extension's
    // existing error mapping flags it as a transient state mismatch — not
    // a connectivity failure.
    if (response.status === 404 || response.status === 409) {
      throw new ApiClientError('not-found', 'No paused run', { status: response.status });
    }
    if (response.status >= 400) {
      const body = await safeReadBodyExcerpt(response);
      throw new ApiClientError('server-error', `HTTP ${response.status}`, {
        status: response.status,
        ...(body !== undefined && { bodyExcerpt: body }),
      });
    }
  }

  /**
   * Acknowledge that VS Code's Node debugger is attached and the server
   * may now hit its `debugger;` pause — at the tool dispatcher, or at a
   * step's code-behind entry (the route name predates the second use; the
   * ack itself is generic "debugger attached, proceed"). Resolves the
   * per-session debugger-attach Promise the step loop is awaiting.
   *
   * 409 when no run is currently awaiting an ack — handled by the
   * caller via the standard `not-found` mapping.
   */
  async ackToolDebugger(sessionId: string): Promise<void> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/tool-debugger-ack`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
      });
    } catch (err) {
      const reason = describeFetchError(err);
      throw new ApiClientError('connect-failed', reason);
    }
    if (response.status === 401) {
      throw new ApiClientError('unauthorized', 'Unauthorized', { status: 401 });
    }
    if (response.status === 404 || response.status === 409) {
      throw new ApiClientError('not-found', 'No run awaiting debugger', { status: response.status });
    }
    if (response.status >= 400) {
      const body = await safeReadBodyExcerpt(response);
      throw new ApiClientError('server-error', `HTTP ${response.status}`, {
        status: response.status,
        ...(body !== undefined && { bodyExcerpt: body }),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function frameToEvent<T>(frame: SseFrame): T | null {
  if (frame.data === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // The server is the source of truth for shape; we trust it but fall through if `type` missing.
  const obj = parsed as { type?: string };
  if (typeof obj.type !== 'string') return null;
  return obj as T;
}

/** The `{ "error": "..." }` an express route sends with a 4xx, when it did. */
function errorFrom(bodyExcerpt: string | undefined): string | undefined {
  if (!bodyExcerpt) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyExcerpt);
    const message = (parsed as { error?: unknown })?.error;
    return typeof message === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
}

async function safeReadBodyExcerpt(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.slice(0, 240);
  } catch {
    return undefined;
  }
}
