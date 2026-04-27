/**
 * HTTP+SSE client for the ai-ui-automation API server.
 *
 * Transport-only: no error formatting, no .env parsing. Callers map the
 * `ApiClientError` codes below into the user-facing TBxxx catalogue.
 */

import { SseParser, type SseFrame } from './sse-parser.js';
import type { RunEvent } from './protocol.js';

export interface StreamStepsRequest {
  steps: string[];
  /** Per-line break indices (1-based step indices into `steps`). */
  breakpoints?: number[];
  /** Per-request env (e.g. AI_API_KEY). Server applies these to the session, not its own process.env. */
  env?: Record<string, string>;
  parameters?: Record<string, string>;
  config?: { baseUrl?: string; timeout?: string };
  /** Map of 1-based step index → original source line in the test file. Echoed back in events. */
  sourceLines?: number[];
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
