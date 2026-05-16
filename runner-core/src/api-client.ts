/**
 * HTTP+SSE client for the ai-ui-automation API server.
 *
 * Transport-only: no error formatting, no .env parsing. Callers map the
 * `ApiClientError` codes below into the user-facing TBxxx catalogue.
 */

import { SseParser, type SseFrame } from './sse-parser.js';
import type { RunEvent, StepMode } from './protocol.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export type LogFileMode = 'off' | 'compact' | 'full';

export interface StreamStepsRequest {
  steps: string[];
  /** Per-line break indices (1-based step indices into `steps`). */
  breakpoints?: number[];
  /** Per-request env (e.g. AI_API_KEY). Server applies these to the session, not its own process.env. */
  env?: Record<string, string>;
  /**
   * Active environment name. The server uses it to load `.env.<envName>` and
   * `fixtures/data/<envName>.json` (or the path in `AIUI_DATA_DIR`) from its
   * working directory and apply `${env.X}` /
   * `${data.X.Y}` interpolation to each step. Empty/omitted ⇒ no
   * env-data interpolation (steps with `${...}` placeholders will fail).
   */
  envName?: string;
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
   * Absolute path of the test file the steps were authored in. Used as the
   * URI for the top-level (test) frame when the server emits frame events.
   * Optional; servers without frame support ignore it.
   */
  testFilePath?: string;
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
}

export type ApiErrorKind =
  | 'connect-failed'
  | 'unauthorized'
  | 'not-found'
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
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
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
          const event = frameToRunEvent(frame);
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
  async runControl(sessionId: string, mode: StepMode): Promise<void> {
    const url = `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({ mode }),
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
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function frameToRunEvent(frame: SseFrame): RunEvent | null {
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
  return obj as RunEvent;
}

async function safeReadBodyExcerpt(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.slice(0, 240);
  } catch {
    return undefined;
  }
}
