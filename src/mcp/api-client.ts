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
  ApiRouteNotFoundError,
  type ApiClient,
  type ApiClientOptions,
  type CdpBrowsers,
  type ClosedCdpTab,
  type FocusedCdpTab,
  type LastRunInfo,
  type PageContent,
  type NavigatedTab,
  type PeekedTab,
  type RunEvent,
  type ServerConfigReport,
  type SessionStateSnapshot,
  type SessionSummary,
  type StartedCdpBrowser,
  type StreamResult,
  type TabHolder,
} from './types.js';
import type { ErrandRequestBody, McpStepRequest } from './types.js';
import type { LoginResult } from '../credentials/types.js';
import { normalizeBaseUrl } from '../server/health.js';

/** Event types we know how to fold. Anything else is recorded and dropped
 *  rather than failing the run — a server that grows a new event type should
 *  not break an older client mid-run. */
const KNOWN_EVENTS = new Set([
  'step:start',
  'step:pass',
  'step:fail',
  // A step an `If … then return` left behind (stories/step-flow-control.md,
  // decision 9). It has to be listed here or the fold never sees one: an
  // unknown type is recorded in `dropped[]`, which surfaces as a run WARNING —
  // so a `run_test` of a test that returned would report "N unrecognised
  // event" warnings, no rows for the skipped steps, and a step tally counting
  // only what executed.
  'step:skip',
  'output',
  'capture',
  'done',
  'frame:push',
  'frame:pop',
  'frame:scope',
  'step:awaiting',
  'tool:awaiting-debugger',
  'codebehind:awaiting-debugger',
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
      // `reason` rides a `step:pass` that carries `output: 'skipped'`, and the
      // fold assigns it straight into `row.output` — a field `schemas.ts`
      // declares `z.string().nullable()`, so a non-string here fails
      // `validated()` at the end and degrades the whole tool result. Optional,
      // unlike `step:skip`'s: an older server sends none. Checked in the same
      // place and for the same reason as that one.
      if (event['reason'] !== undefined && typeof event['reason'] !== 'string') {
        return 'reason is not a string';
      }
      return null;
    case 'step:skip':
      // The fold reads all three: `line` to open the row, `frame` to attribute
      // it, `reason` as the row's output. `frame` is optional on the wire —
      // the server omits it when nothing expanded — and `beginRow` already
      // handles its absence, so only a MALFORMED one is a problem.
      if (typeof event['line'] !== 'number') return 'line is not a number';
      if (typeof event['reason'] !== 'string') return 'reason is not a string';
      if (event['frame'] !== undefined && !isFrame(event['frame'])) return 'frame is malformed';
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
      // frame:pop, frame:scope, step:awaiting, tool:awaiting-debugger,
      // codebehind:awaiting-debugger — the fold ignores these entirely, so
      // their shape cannot hurt it.
      return null;
  }
}

/**
 * Read one SSE run stream to the end.
 *
 * Shared by the two streaming routes rather than written twice, for the same
 * reason the server shares its own SSE plumbing between them: almost every line
 * here exists because of a specific failure — arrival timestamps that cannot be
 * recovered later, our own cancellation being distinguishable from a dropped
 * stream, a missing `done` meaning the run may still be executing over there —
 * and two copies is how one of them quietly loses a fix.
 */
async function consumeRunStream(
  res: Response,
  signal: AbortSignal | undefined,
  onEvent: ((event: RunEvent) => void) | undefined,
): Promise<StreamResult> {
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
}

/**
 * The `holder` of a turn-lock 409 (stories/errands.md §The wheel), read field
 * by field.
 *
 * Wire data from a server that may be older than this client, so anything that
 * is not exactly one of the two shapes degrades to `null` — which lands the
 * caller on the generic HTTP message carrying the server's own prose. A partly
 * trusted holder would put an empty errand id into a refusal that tells the
 * model to wait for it.
 */
function readTabHolder(value: unknown): TabHolder | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'errand') {
    const { errandId, tabRole } = record;
    if (typeof errandId !== 'string' || errandId === '') return null;
    if (tabRole !== 'borrowed' && tabRole !== 'opened') return null;
    return { kind: 'errand', errandId, tabRole };
  }
  if (record.kind === 'session') {
    const { sessionId } = record;
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    return { kind: 'session', sessionId };
  }
  return null;
}

export const createApiClient = (opts: ApiClientOptions): ApiClient => {
  const base = normalizeBaseUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  // A null key reaches here only on `assertServerRecognized`'s down path,
  // where the request dies on connect before any header is read. Omitting the
  // header beats sending the string "null", which a live server would 401
  // with a misleading "wrong key" instead of "no key".
  const headers: Record<string, string> =
    opts.apiKey === null ? {} : { 'x-api-key': opts.apiKey };

  /** Turn a non-2xx into an `ApiHttpError` carrying the server's own message,
   *  which is usually more specific than anything we could invent. */
  async function assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    // `statusText` is empty over HTTP/2, and from any server that sends a bare
    // reason phrase — so seeding from it alone yields an ApiHttpError with
    // nothing in it, which §7's default arm then renders as "rejected the
    // request (HTTP 404): " with a dangling colon and no cause. The status is
    // always worth something; say it rather than going quiet.
    let message = res.statusText || `HTTP ${res.status}`;
    let holder: TabHolder | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; holder?: unknown };
      if (typeof body.error === 'string' && body.error !== '') message = body.error;
      holder = readTabHolder(body.holder);
    } catch {
      // Non-JSON error body; the status alone will have to do.
    }
    throw new ApiHttpError(res.status, message, holder);
  }

  /**
   * Throw the right error for a 404 on a tab route, or return and let the
   * normal path continue.
   *
   * A 404 has two readings and only one of them is about the tab. Our routes
   * answer with a JSON `error`; a Sessions API server from a build that
   * predates the route has no such route at all, so Express answers its own
   * 404 with an HTML body — which `assertOk` would flatten into the status
   * text, telling the agent its tab is gone when the truth is that the server
   * needs rebuilding.
   *
   * The distinction is carried by the error TYPE, not by an empty message: a
   * body that parses as JSON but carries a non-string `error` is a response
   * from something, and reporting it as a stale build would be a confident
   * lie. Only a body we could not read as our own envelope means the route is
   * not there.
   *
   * Shared by `focusCdpTab` and `peekCdpTab` rather than written twice — this
   * is a rule about the SERVER's builds, and two copies is how one of them
   * ends up telling a user their tab was closed after a rebuild they forgot.
   */
  async function splitTabOrRoute404(res: Response, path: string): Promise<void> {
    if (res.status !== 404) return;
    const raw = await res.text();
    // **Whether it PARSED is a separate fact from what it parsed to**, and
    // conflating the two reopens the hole this whole branch exists to close. A
    // body of `null`, a bare JSON scalar, or an empty string all yield a
    // falsy/non-object value while still being a deliberate answer from
    // something — an empty-body 404 from a load balancer is the realistic case
    // — and reporting those as a missing route is the same confident lie in a
    // new costume.
    let parsed = false;
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
      parsed = true;
    } catch {
      // Not JSON at all — Express's own 404 page. THIS is a missing route.
    }
    if (!parsed) throw new ApiRouteNotFoundError(path);

    const error =
      envelope !== null && typeof envelope === 'object'
        ? (envelope as { error?: unknown }).error
        : undefined;
    // Prefer the server's own prose, and fall back to the status rather than
    // to silence — an empty message reads as "the route is missing", which
    // this is not.
    throw new ApiHttpError(
      404,
      typeof error === 'string' && error !== ''
        ? error
        : res.statusText || `HTTP ${res.status}`,
    );
  }

  /** The two streaming POSTs send the same headers and read the same stream;
   *  only the URL and the body differ. */
  async function postForStream(
    url: string,
    body: McpStepRequest | ErrandRequestBody,
    signal: AbortSignal | undefined,
    onEvent: ((event: RunEvent) => void) | undefined,
  ): Promise<StreamResult> {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    // Validation failures, auth failures and the shutdown gate all answer
    // before the SSE headers flush, so they arrive as ordinary HTTP even
    // though we asked for a stream. For an errand that also covers the attach
    // refusal, which is why a tab that vanished reaches the tool as a real
    // error rather than as an empty receipt.
    await assertOk(res);
    return consumeRunStream(res, signal, onEvent);
  }

  return {
    async streamSteps(sessionId, body, signal, onEvent): Promise<StreamResult> {
      return postForStream(
        `${base}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`,
        body,
        signal,
        onEvent,
      );
    },

    async runErrand(body, signal, onEvent): Promise<StreamResult> {
      // Not under /sessions, because an errand creates none — the URL is the
      // first place that has to say so.
      return postForStream(`${base}/errands?stream=1`, body, signal, onEvent);
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
      const path =
        `/cdp/browsers/${args.port}/tabs/${encodeURIComponent(args.targetId)}/focus` +
        `?${params.toString()}`;
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers,
        ...(signal ? { signal } : {}),
      });

      await splitTabOrRoute404(res, path);
      await assertOk(res);
      return (await res.json()) as FocusedCdpTab;
    },

    async peekCdpTab(args, signal): Promise<PeekedTab> {
      const params = new URLSearchParams({ testFilePath: args.testFilePath });
      if (args.format !== undefined) params.set('format', args.format);
      if (args.selector !== undefined) params.set('selector', args.selector);
      if (args.maxChars !== undefined) params.set('max_chars', String(args.maxChars));
      // Sent only when asked for, so a text peek's query is byte-identical to
      // what it was before screenshots existed — and so `full_page: false`
      // reaches a server that would otherwise default it (there is no such
      // server today; there is no reason to depend on that).
      if (args.fullPage !== undefined) params.set('full_page', String(args.fullPage));
      const path =
        `/cdp/browsers/${args.port}/tabs/${encodeURIComponent(args.targetId)}/content` +
        `?${params.toString()}`;
      const res = await doFetch(`${base}${path}`, {
        headers,
        ...(signal ? { signal } : {}),
      });

      // The same split, for the same reason: "your tab is gone" and "rebuild
      // the server" are opposite remedies, and only the body shape tells them
      // apart.
      await splitTabOrRoute404(res, path);
      // Not defaulted the way `getCdpBrowsers` defaults its lists: a page read
      // that came back without content has nothing usable to degrade to.
      await assertOk(res);
      return (await res.json()) as PeekedTab;
    },

    async navigateCdpTab(args, signal): Promise<NavigatedTab> {
      const path = `/cdp/browsers/${args.port}/navigate`;
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: args.url,
          testFilePath: args.testFilePath,
          // Omitted rather than sent empty, so "open a new tab" is expressed by
          // absence on the wire exactly as it is in the tool's arguments.
          ...(args.targetId !== undefined ? { targetId: args.targetId } : {}),
        }),
        ...(signal ? { signal } : {}),
      });

      // The same 404 split the peek makes, for the same reason: "your tab is
      // gone" and "rebuild the server" are opposite remedies.
      await splitTabOrRoute404(res, path);
      await assertOk(res);
      return (await res.json()) as NavigatedTab;
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

    async logIntoSite(sessionId, args, signal): Promise<LoginResult> {
      const res = await doFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/login`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        // `hint` and nothing else. There is no site, username or password field
        // on this request by design — see `ApiClient.logIntoSite`.
        body: JSON.stringify(args.hint ? { hint: args.hint } : {}),
        ...(signal ? { signal } : {}),
      });
      // Not defaulted, for the reason `getPageContent` is not: a login answer
      // with no `outcome` is not "nothing happened", it is an answer we failed
      // to read — and reporting that as a no-op would tell the agent no fill
      // occurred when one may well have.
      await assertOk(res);
      return (await res.json()) as LoginResult;
    },
  };
};
