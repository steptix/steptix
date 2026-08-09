/**
 * HTTP client for the Sessions API, including the SSE reader.
 *
 * Written here rather than reused from `runner-core` (which the VS Code
 * extensions share) because taking that dependency would put a CommonJS
 * package inside this ESM one, add a second copy of `matchText` to the
 * process, and pull in an error catalogue whose text names VS Code settings
 * that mean nothing to an MCP client. The wire format is small; the coupling
 * was not.
 */
import {
  ApiHttpError,
  type ApiClient,
  type ApiClientOptions,
  type CdpBrowsers,
  type ClosedCdpTab,
  type FocusedCdpTab,
  type LastRunInfo,
  type PageContent,
  type RunEvent,
  type ServerConfigReport,
  type SessionStateSnapshot,
  type SessionSummary,
  type StartedCdpBrowser,
  type StreamResult,
} from './types.js';
import { normalizeBaseUrl } from '../server/health.js';

/** Event types we know how to fold. Anything else is recorded and dropped
 *  rather than failing the run — a server that grows a new event type should
 *  not break an older client mid-run. */
const KNOWN_EVENTS = new Set([
  'step:start',
  'step:pass',
  'step:fail',
  'output',
  'capture',
  'done',
  'frame:push',
  'frame:pop',
  'frame:scope',
  'step:awaiting',
  'tool:awaiting-debugger',
]);

/**
 * Incremental SSE parser.
 *
 * The wire rules are the fiddly part and each line below corresponds to one:
 * frames are separated by a blank line, `:`-prefixed lines are comments (the
 * server sends `: keep-alive` every 25s to stop intermediaries timing the
 * connection out), one optional space after the field colon is part of the
 * framing rather than the value, and repeated `data:` lines concatenate with
 * newlines.
 *
 * Dispatch is on the payload's own `type`, not the `event:` field. The server
 * sends both and they agree today; the payload is the one the type system
 * knows about.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  /** Feed a chunk; returns whatever complete frames it completed. */
  push(chunk: string): { events: RunEvent[]; dropped: string[] } {
    const events: RunEvent[] = [];
    const dropped: string[] = [];

    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is either an incomplete line or '' — keep it buffered.
    this.buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        this.flush(events, dropped);
        continue;
      }
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      let value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'data') this.dataLines.push(value);
      // `event:` and `id:` are deliberately ignored — see the class comment.
    }

    return { events, dropped };
  }

  private flush(events: RunEvent[], dropped: string[]): void {
    if (this.dataLines.length === 0) return;
    const payload = this.dataLines.join('\n');
    this.dataLines = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      dropped.push(`unparseable frame: ${truncate(payload)}`);
      return;
    }
    const type = (parsed as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !KNOWN_EVENTS.has(type)) {
      dropped.push(`unrecognised event "${String(type)}"`);
      return;
    }
    const malformed = shapeProblem(type, parsed as Record<string, unknown>);
    if (malformed) {
      dropped.push(`malformed ${type} frame: ${malformed}`);
      return;
    }
    events.push(parsed as RunEvent);
  }
}

function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Check the fields the fold will actually read, returning a reason or null.
 *
 * Checking only `type` is not enough. The fold indexes into `event.msg`,
 * `event.frame.id` and friends without guarding, so a frame with the right
 * `type` and a wrong payload throws *after* the run has already completed —
 * and a throw there is indistinguishable, at the handler, from a pre-flight
 * failure. The run then reports as though it never happened.
 *
 * Rejecting here instead means a bad frame becomes a warning on an otherwise
 * good result, which is the honest outcome.
 */
function shapeProblem(type: string, event: Record<string, unknown>): string | null {
  const isFrame = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { uri?: unknown }).uri === 'string';

  switch (type) {
    case 'step:start':
    case 'step:pass':
    case 'step:fail':
      if (typeof event['line'] !== 'number') return 'line is not a number';
      if (event['frame'] !== undefined && !isFrame(event['frame'])) return 'frame is malformed';
      if (type === 'step:fail' && typeof event['error'] !== 'string') {
        return 'error is not a string';
      }
      return null;
    case 'output':
      return typeof event['msg'] === 'string' ? null : 'msg is not a string';
    case 'capture':
      return typeof event['name'] === 'string' && typeof event['value'] === 'string'
        ? null
        : 'name or value is not a string';
    case 'done':
      return typeof event['status'] === 'string' ? null : 'status is not a string';
    case 'frame:push':
      return isFrame(event['frame']) ? null : 'frame is malformed';
    default:
      // frame:pop, frame:scope, step:awaiting, tool:awaiting-debugger — the
      // fold ignores these entirely, so their shape cannot hurt it.
      return null;
  }
}

export const createApiClient = (opts: ApiClientOptions): ApiClient => {
  const base = normalizeBaseUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { 'x-api-key': opts.apiKey };

  /** Turn a non-2xx into an `ApiHttpError` carrying the server's own message,
   *  which is usually more specific than anything we could invent. */
  async function assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // Non-JSON error body; the status alone will have to do.
    }
    throw new ApiHttpError(res.status, message);
  }

  return {
    async streamSteps(sessionId, body, signal, onEvent): Promise<StreamResult> {
      const url = `${base}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
      const res = await doFetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });

      // Validation failures, auth failures and the shutdown gate all answer
      // before the SSE headers flush, so they arrive as ordinary HTTP even
      // though we asked for a stream.
      await assertOk(res);
      if (!res.body) {
        return { events: [], receivedAt: [], streamDropped: true, dropped: [] };
      }

      const parser = new SseParser();
      const events: RunEvent[] = [];
      // Stamped here, at arrival, because it is unrecoverable afterwards: the
      // fold walks the finished array, where every clock read is the same
      // instant.
      const receivedAt: number[] = [];
      const dropped: string[] = [];
      let sawDone = false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const result = parser.push(chunk);
          dropped.push(...result.dropped);
          const now = Date.now();
          for (const event of result.events) {
            if (event.type === 'done') sawDone = true;
            events.push(event);
            receivedAt.push(now);
            onEvent?.(event);
          }
        }
      } catch (err) {
        // Our own cancellation is not a dropped stream — the caller asked for
        // this, and the tool returns nothing to the host either way. Checking
        // the signal first is what keeps the two apart.
        if (signal?.aborted) throw err;
        return { events, receivedAt, streamDropped: true, dropped };
      } finally {
        reader.releaseLock();
      }

      // A stream that ends without `done` means the server went away
      // mid-run — killed, force-stopped, or reaped. The run may still be
      // executing over there, which is why this is not simply a failure.
      return { events, receivedAt, streamDropped: !sawDone, dropped };
    },

    async getLastRun(sessionId): Promise<LastRunInfo> {
      const res = await doFetch(
        `${base}/sessions/${encodeURIComponent(sessionId)}/last-run`,
        { headers },
      );
      await assertOk(res);
      return (await res.json()) as LastRunInfo;
    },

    async getPageContent(sessionId, args, signal): Promise<PageContent> {
      const params = new URLSearchParams();
      if (args.format !== undefined) params.set('format', args.format);
      if (args.selector !== undefined) params.set('selector', args.selector);
      if (args.maxChars !== undefined) params.set('max_chars', String(args.maxChars));
      const query = params.toString();
      const res = await doFetch(
        `${base}/sessions/${encodeURIComponent(sessionId)}/content${query ? `?${query}` : ''}`,
        { headers, ...(signal ? { signal } : {}) },
      );
      // Not defaulted the way `getCdpBrowsers` defaults its lists: a page read
      // that came back without content has nothing usable to degrade to, and
      // inventing `''` here would recreate the "unreadable reads as empty"
      // confusion the server side goes out of its way to prevent.
      await assertOk(res);
      return (await res.json()) as PageContent;
    },

    async getSessionState(sessionId, signal): Promise<SessionStateSnapshot> {
      const res = await doFetch(`${base}/sessions/${encodeURIComponent(sessionId)}`, {
        headers,
        ...(signal ? { signal } : {}),
      });
      // Not defaulted, for the same reason `getPageContent` is not: a missing
      // `screenshot` and an empty one both mean "no picture", and inventing one
      // here would hand the caller something it cannot tell apart from a real
      // capture. The tool layer decides what an empty value means.
      await assertOk(res);
      return (await res.json()) as SessionStateSnapshot;
    },

    async getConfig(sessionId, signal): Promise<ServerConfigReport> {
      const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`;
      const res = await doFetch(`${base}/config${query}`, {
        headers,
        ...(signal ? { signal } : {}),
      });
      // A 404 here means the named session is not on the server, which is the
      // caller's mistake and worth its own message — so it propagates as an
      // `ApiHttpError` rather than being smoothed into an empty report.
      await assertOk(res);
      const body = (await res.json()) as Partial<ServerConfigReport>;
      return {
        config: body.config ?? {},
        // `server` is the one field with nothing safe to default to, so a server
        // that did not send it fails loudly here rather than reporting invented
        // settings as though they were in force.
        server: body.server as ServerConfigReport['server'],
        session: body.session ?? null,
      };
    },

    async closeSession(sessionId): Promise<void> {
      const res = await doFetch(`${base}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers,
      });
      await assertOk(res);
    },

    async listSessions(signal): Promise<SessionSummary[]> {
      const res = await doFetch(`${base}/sessions`, {
        headers,
        ...(signal ? { signal } : {}),
      });
      await assertOk(res);
      const body = (await res.json()) as { sessions?: SessionSummary[] };
      return body.sessions ?? [];
    },

    async getCdpBrowsers(args, signal): Promise<CdpBrowsers> {
      const params = new URLSearchParams({ projectRoot: args.projectRoot });
      if (args.includeForeign) params.set('includeForeign', 'true');
      // Only sent when §6 permits. The server honours whatever it is asked —
      // it cannot tell an agent from a human, and constraining TestBench or
      // flick would be wrong — so NOT asking is the withholding.
      if (args.includeForeignTabs) params.set('includeForeignTabs', 'true');
      const res = await doFetch(`${base}/cdp/browsers?${params.toString()}`, {
        headers,
        ...(signal ? { signal } : {}),
      });
      await assertOk(res);
      const body = (await res.json()) as Partial<CdpBrowsers>;
      // Defaulted rather than trusted: a missing list must read as empty, not
      // as `undefined` reaching a `.map` in a tool handler.
      return {
        running: body.running ?? [],
        available: body.available ?? [],
        foreign: body.foreign ?? [],
      };
    },

    async closeCdpTab(args, signal): Promise<ClosedCdpTab> {
      const params = new URLSearchParams({ projectRoot: args.projectRoot });
      if (args.allowBrowserExit) params.set('allowBrowserExit', 'true');
      if (args.allowUnowned) params.set('allowUnowned', 'true');
      // A target id is opaque hex today, but it is a path segment either way —
      // encoded so a future id containing `/`, `?` or `#` addresses the tab it
      // names rather than a different route.
      const res = await doFetch(
        `${base}/cdp/browsers/${args.port}/tabs/${encodeURIComponent(args.targetId)}` +
          `?${params.toString()}`,
        { method: 'DELETE', headers, ...(signal ? { signal } : {}) },
      );
      await assertOk(res);
      return (await res.json()) as ClosedCdpTab;
    },

    async focusCdpTab(args, signal): Promise<FocusedCdpTab> {
      const params = new URLSearchParams({ projectRoot: args.projectRoot });
      if (args.allowUnowned) params.set('allowUnowned', 'true');
      const res = await doFetch(
        `${base}/cdp/browsers/${args.port}/tabs/${encodeURIComponent(args.targetId)}/focus` +
          `?${params.toString()}`,
        { method: 'POST', headers, ...(signal ? { signal } : {}) },
      );

      // A 404 has two readings here and only one of them is about the tab. Our
      // route answers with a JSON `error`; a Sessions API server from a build
      // that predates the route has no such route at all, so Express answers
      // its own 404 with an HTML body — which `assertOk` would flatten into the
      // status text, telling the agent its tab is gone when the truth is that
      // the server needs rebuilding. An empty `serverMessage` is how the tool
      // tells the two apart.
      if (res.status === 404) {
        let serverMessage = '';
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === 'string') serverMessage = body.error;
        } catch {
          // Not our JSON — the route is missing.
        }
        throw new ApiHttpError(404, serverMessage);
      }

      await assertOk(res);
      return (await res.json()) as FocusedCdpTab;
    },

    async startCdpBrowser(body, signal): Promise<StartedCdpBrowser> {
      const res = await doFetch(`${base}/cdp/browsers`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      await assertOk(res);
      return (await res.json()) as StartedCdpBrowser;
    },
  };
};
