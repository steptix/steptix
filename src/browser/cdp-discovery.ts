/**
 * CDP discovery — probe debug ports, identify which Chromium engine is on
 * each (via `/json/version`), and enumerate its open page-type tabs (via
 * `/json/list`). Per-port failures are captured as `error` on that port's
 * result; the call itself never throws.
 *
 * Ported from `flick-vscode/src/extension/cdp-discovery.ts`; that copy is
 * unmaintained pending a decision on flick's future
 * (stories/mcp-cdp-browser.md §10). This module is canonical.
 *
 * Two distinct callers, and the difference matters:
 *
 *   - **Ownership** (`cdp-registry.ts`) probes a port it learned from a
 *     profile's `DevToolsActivePort`. It needs `/json/version` to confirm the
 *     port is alive AND that the engine matches the profile's name, because a
 *     stale file can point at a port some *other* process has since taken.
 *   - **The foreign scan** (§4) sweeps a fixed conventional port list, since a
 *     browser we did not launch cannot be found any other way — ours are on
 *     OS-assigned ports nothing can guess.
 */

/** Conventional ports a browser someone else started is likely to be on.
 *  Inherited from flick. 9229 is here to be *classified*, not attached to —
 *  see `classifyEngine`. */
export const DEFAULT_CDP_PORTS = [9222, 9223, 9229] as const;

/** Default timeout per port (fetch is aborted after this). */
export const DEFAULT_TIMEOUT_MS = 1500;

export type CdpEngine = 'chrome' | 'edge' | 'chromium' | 'node' | 'unknown';

/** The engines this framework can launch. A strict subset of `CdpEngine`. */
export type LaunchableEngine = 'chrome' | 'edge';

export interface CdpDiscoveryTab {
  targetId: string;
  title: string;
  url: string;
}

export interface CdpDiscoveryPort {
  port: number;
  reachable: boolean;
  engine: CdpEngine;
  tabs: CdpDiscoveryTab[] | null;
  error?: string;
}

export interface DiscoverOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface RawTab {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
}

export async function discoverCdpPorts(
  ports: readonly number[] = DEFAULT_CDP_PORTS,
  options?: DiscoverOptions,
): Promise<CdpDiscoveryPort[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options?.fetchFn ?? fetch;
  return Promise.all(ports.map((port) => probePort(port, timeoutMs, fetchFn)));
}

export async function probePort(
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch,
): Promise<CdpDiscoveryPort> {
  // Each fetch gets its own deadline so a slow /json/version doesn't starve
  // /json/list (sharing one timer produced spurious tabs:null errors against
  // an otherwise healthy browser).
  let versionJson: unknown;
  try {
    versionJson = await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs, fetchFn);
  } catch (err) {
    // Alive-check failed — nothing usable is listening here. For the registry
    // this is the signal that a `DevToolsActivePort` file is stale, which is
    // the ONLY thing that ever cleans one up: W0 confirmed Chromium never
    // deletes the file, on orderly exit or on crash (§2).
    return { port, reachable: false, engine: 'unknown', tabs: null, error: errorMessage(err) };
  }

  const browserField =
    versionJson && typeof versionJson === 'object' &&
    typeof (versionJson as { Browser?: unknown }).Browser === 'string'
      ? (versionJson as { Browser: string }).Browser
      : '';
  const engine = classifyEngine(browserField);

  let listJson: unknown;
  try {
    listJson = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs, fetchFn);
  } catch (err) {
    return { port, reachable: true, engine, tabs: null, error: errorMessage(err) };
  }

  if (!Array.isArray(listJson)) {
    return { port, reachable: true, engine, tabs: null, error: 'malformed /json/list' };
  }

  return { port, reachable: true, engine, tabs: toPageTabs(listJson) };
}

/**
 * The page-tab filter, shared by every caller that counts or names tabs.
 *
 * Exported rather than inlined because two callers must agree exactly:
 * `probePort` (what a caller is shown) and the close path (what may be closed,
 * and whether a tab is the *last* one). If they drifted, a browser whose only
 * other target is an extension page would be listed as having one tab and
 * refuse the close as "not the last tab" — or worse, permit a close that
 * silently exits the browser. One filter, one truth.
 *
 * `devtools://` and `chrome-extension://` pages are excluded; `chrome://newtab`
 * is NOT — W0 confirmed a fresh browser's new-tab page is an ordinary,
 * closable `type: 'page'` target, and a user looking at their window counts it.
 *
 * **Browser dialogs are excluded, and that was measured, not predicted.** Edge
 * reports `edge://sync-confirmation-dialog/` as `type: 'page'`, but it is a
 * modal, not a tab: it does not appear in the tab strip and it does not keep
 * the browser alive. Counting it made a two-entry list out of one real tab, so
 * the last-tab guard concluded it was not closing the last tab and the browser
 * exited without anyone passing `allow_browser_exit` — the exact failure that
 * guard exists to prevent, seen in live testing.
 *
 * Only `*-dialog` surfaces are dropped, not internal pages generally:
 * `edge://settings` and `chrome://history` are real tabs a user opened and
 * must still be counted. The asymmetry is deliberate — over-counting risks
 * killing a browser, while under-counting only produces an unnecessary refusal.
 */
export function toPageTabs(listJson: unknown): CdpDiscoveryTab[] {
  if (!Array.isArray(listJson)) return [];
  const tabs: CdpDiscoveryTab[] = [];
  for (const raw of listJson as RawTab[]) {
    if (!raw || raw.type !== 'page') continue;
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) continue;
    if (isBrowserDialog(url)) continue;
    const targetId = typeof raw.id === 'string' ? raw.id : '';
    if (!targetId) continue;
    tabs.push({
      targetId,
      title: typeof raw.title === 'string' ? raw.title : '',
      url,
    });
  }
  return tabs;
}

/**
 * A browser-UI modal masquerading as a page target.
 *
 * Matched on the `-dialog` path segment of an internal scheme, which is how
 * Chromium names these surfaces (`sync-confirmation-dialog`,
 * `signin-email-confirmation-dialog`, …). A heuristic, and stated as one — but
 * one whose failure mode is an extra refusal rather than a dead browser.
 */
function isBrowserDialog(url: string): boolean {
  if (!url.startsWith('chrome://') && !url.startsWith('edge://')) return false;
  const host = url.slice(url.indexOf('://') + 3).split('/')[0] ?? '';
  return host.endsWith('-dialog');
}

/** Page tabs on a port, or null when the browser could not be reached. Thin
 *  wrapper over `/json/list` for callers that already know the port is ours
 *  and do not need the engine re-confirmed. */
export async function listPageTabs(
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch,
): Promise<CdpDiscoveryTab[] | null> {
  try {
    return toPageTabs(await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs, fetchFn));
  } catch {
    return null;
  }
}

/**
 * Ask the browser to close one tab: `GET /json/close/<targetId>`.
 *
 * **The acknowledgement is not the outcome, and the gap is real.** W0 measured
 * the browser answering `200 "Target is closing"` in 1–5 ms while the tab took
 * 7 ms (Chrome) / 41 ms (Edge) to leave `/json/list`. A caller that reports
 * success on this return value is reporting an intention. Poll
 * `listPageTabs` until the id is absent — that is what `closed: true` means.
 *
 * An unknown id answers **404 `No such target id: …`**, which is the browser
 * itself distinguishing "already closed" from "closed just now". Reported as
 * `notFound` so the caller can say which happened rather than swallowing it as
 * an idempotent success.
 *
 * Both behaviours verified on Chrome 150 and Edge 151; the DevTools HTTP
 * surface needs no WebSocket, so this stays as cheap as the probe beside it.
 */
export async function closeTab(
  port: number,
  targetId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; notFound: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(
      `http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`,
      { signal: controller.signal },
    );
    if (res.ok) return { ok: true, notFound: false, error: null };
    return {
      ok: false,
      notFound: res.status === 404,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, notFound: false, error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the browser to bring one tab to the front: `GET /json/activate/<targetId>`.
 *
 * A drop-in sibling of `closeTab` above — same host, same port, same 404 shape,
 * same `encodeURIComponent` treatment of the id — and like it, plain HTTP with
 * no WebSocket, so it reaches tabs no session owns.
 *
 * **`ok` means the browser accepted it, and that is weaker than "the user can
 * see it".** Unlike a close there is nothing to poll: the DevTools HTTP surface
 * offers no read of "is this tab frontmost, and is its window in front of every
 * other application". `/json/activate` reaches `WebContents::Activate()` →
 * `Browser::ActivateContents`, which selects the tab and then asks the window
 * manager to raise the window — and on Windows the OS may decline a raise
 * requested by a background process. That is the same call `Page.bringToFront`
 * makes, so there is no louder alternative to escalate to.
 *
 * **The caller must reject anything it did not list.** Measured on Chrome
 * 150.0.7871.187: `iframe` and `browser_ui` target ids both answer
 * `200 "Target activated"` as readily as a real tab, so this function cannot be
 * the thing that decides an id is a tab. Look it up through `toPageTabs` first
 * — that is why the focus route reads the list before calling this.
 *
 * `500 Could not activate target id` is reachable (a `worker` id), so a non-404
 * failure must not fall through to "ok".
 */
export async function activateTab(
  port: number,
  targetId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; notFound: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(
      `http://127.0.0.1:${port}/json/activate/${encodeURIComponent(targetId)}`,
      { signal: controller.signal },
    );
    if (res.ok) return { ok: true, notFound: false, error: null };
    return {
      ok: false,
      notFound: res.status === 404,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, notFound: false, error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether anything still answers `/json/version` on this port. The signal that
 *  a browser has exited — used to confirm a last-tab close, where the tab list
 *  cannot be read afterwards because the server serving it is gone. */
export async function portAnswers(
  port: number,
  timeoutMs: number = 500,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs, fetchFn);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url: string, timeoutMs: number, fetchFn: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map `/json/version`'s `Browser` field onto an engine.
 *
 * **Edge reports `Edg/`, not `Edge/`** — verified in W0 against Edge
 * 151.0.4129.59, which returns `Edg/151.0.4129.59`. flick's original checked
 * `Edge/` and therefore classified every modern Edge as `unknown`; that bug is
 * fixed here rather than ported (issues/041). The `Edge/` arm is kept for
 * older builds that did use it.
 *
 * The ordering is load-bearing: Edge must be tested before Chrome. It is not
 * needed for the strings above (Edge's contains no "Chrome/" prefix) but a
 * future Edge that reported `Chrome/… Edg/…` would otherwise classify as
 * Chrome, and the registry uses this to decide whether a port belongs to the
 * profile that claimed it.
 */
export function classifyEngine(browser: string): CdpEngine {
  if (browser.startsWith('Edg/') || browser.startsWith('Edge/')) return 'edge';
  if (browser.startsWith('HeadlessChrome/')) return 'chrome';
  if (browser.startsWith('Chrome/')) return 'chrome';
  if (browser.startsWith('Chromium/')) return 'chromium';
  // A Node.js --inspect endpoint also serves /json/version (Browser:
  // "node.js/v22.x") but isn't an attachable browser. Classified so callers
  // can drop it — 9229 is the Node inspector default, and this repo's own
  // server lands there with `--inspect`.
  if (browser.startsWith('node.js/')) return 'node';
  return 'unknown';
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'AbortError') {
    return 'timeout';
  }
  if (err instanceof Error) {
    // HTTP <status> messages from fetchJson are already user-readable; pass
    // them through unprefixed.
    if (err.message.startsWith('HTTP ')) return err.message;
    return err.message ? `fetch failed: ${err.message}` : 'fetch failed';
  }
  return 'fetch failed';
}
