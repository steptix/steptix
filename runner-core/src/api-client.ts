/**
 * HTTP+SSE client for the ai-ui-automation API server.
 *
 * Transport-only: no error formatting, no .env parsing. Callers map the
 * `ApiClientError` codes below into the user-facing TBxxx catalogue.
 */

import { SseParser, type SseFrame } from './sse-parser.js';
import type { CompileEvent, CompileRequest, RunEvent, StepMode } from './protocol.js';

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
  config?: { baseUrl?: string; timeout?: string };
  /** Map of 1-based step index → original source line in the test file. Echoed back in events. */
  sourceLines?: number[];
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
   * Per-request logging override. Each field falls back to the server's
   * configured default when omitted. Override scope is this request only —
   * the server restores its default after the run completes.
   */
  logging?: {
    consoleLogLevel?: LogLevel;
    serverFileLogLevel?: LogFileMode;
  };
  /**
   * Step-cache control. Opt-in: the server only caches when this is
   * explicitly `true` (and a `testFilePath` is present). Absent
   * (`undefined`) or `false` means every step goes through the AI.
   */
  cacheEnabled?: boolean;
  /**
   * Full post-expansion step list for the test. Required for multi-batch
   * runs (breakpoint pause + Continue) so the server's cache-bundle hash
   * stays stable across batches. Single-batch runs can omit it; the
   * server falls back to hashing `steps` directly.
   */
  fullSteps?: string[];
  /**
   * Partial / bounded re-run anchors ("re-run a skill step" and "debug a skill
   * after Stop"). `startAt` skips every expanded step before the first in file
   * `startAt.uri` at/after `startAt.line`; `endAt` stops after the last step in
   * `endAt.uri` at/before `endAt.line` (omit ⇒ run to the end of the skill body).
   * Both are qualified by `uri` so a recurring line can't false-match. Sending
   * `startAt` forces the per-step cache off server-side.
   */
  startAt?: { uri: string; line: number };
  endAt?: { uri: string; line: number };
  /**
   * Captured/runtime vars to inject into the session scope before a partial
   * re-run, so steps that read values a skipped earlier step produced still
   * resolve. `__skill*`-namespaced internals are ignored server-side.
   */
  seedScope?: Record<string, string>;
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
   * POST a JSON body, read the SSE response, yield one parsed event per frame.
   *
   * Shared by the two streaming clients rather than written twice: the error
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
      const reason = err instanceof Error ? err.message : String(err);
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
          const reason = err instanceof Error ? err.message : String(err);
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
      const reason = err instanceof Error ? err.message : String(err);
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
      const reason = err instanceof Error ? err.message : String(err);
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
    opts?: { pauseAtNextTool?: boolean },
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
        }),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
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
   * may now hit its `debugger;` pause at the tool dispatcher. Resolves
   * the per-session debugger-attach Promise the step loop is awaiting.
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
      const reason = err instanceof Error ? err.message : String(err);
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
