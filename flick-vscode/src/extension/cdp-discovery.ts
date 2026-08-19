// CDP discovery — probes a small set of debug ports, identifies which Chromium
// engine is on each (via `/json/version`), and enumerates its open page-type
// tabs (via `/json/list`). Per-port failures are captured as `error` on that
// port's result; the call itself never throws. See spec at
// stories/flick-vscode-cdp-attach.md "Extension: CDP discovery".

import type { CdpDiscoveryPort, CdpDiscoveryTab, CdpEngine } from '../shared/protocol';

export const DEFAULT_CDP_PORTS = [9222, 9223, 9229] as const;

/** Default timeout per port (fetch is aborted after this). */
export const DEFAULT_TIMEOUT_MS = 1500;

interface DiscoverOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface RawTab {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  faviconUrl?: unknown;
}

export async function discoverCdpPorts(
  ports: readonly number[] = DEFAULT_CDP_PORTS,
  options?: DiscoverOptions,
): Promise<CdpDiscoveryPort[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options?.fetchFn ?? fetch;
  return Promise.all(ports.map((port) => probePort(port, timeoutMs, fetchFn)));
}

async function probePort(
  port: number,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<CdpDiscoveryPort> {
  // Each fetch gets its own deadline so a slow /json/version doesn't starve
  // /json/list (sharing one timer would have produced spurious tabs:null
  // errors against an otherwise healthy browser).
  let versionJson: unknown;
  try {
    versionJson = await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs, fetchFn);
  } catch (err) {
    // Alive-check failed — nothing usable is listening here. `reachable: false`
    // tells the dropdown to omit this port entirely.
    return { port, reachable: false, engine: 'unknown', tabs: null, error: errorMessage(err) };
  }

  // /json/version answered 2xx — a CDP browser is here, even if the next call
  // fails. Everything below carries `reachable: true`.
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

  const tabs: CdpDiscoveryTab[] = [];
  for (const raw of listJson as RawTab[]) {
    if (!raw || raw.type !== 'page') continue;
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) continue;
    const targetId = typeof raw.id === 'string' ? raw.id : '';
    if (!targetId) continue;
    const tab: CdpDiscoveryTab = {
      targetId,
      title: typeof raw.title === 'string' ? raw.title : '',
      url,
    };
    if (typeof raw.faviconUrl === 'string' && raw.faviconUrl) {
      tab.faviconUrl = raw.faviconUrl;
    }
    tabs.push(tab);
  }
  return { port, reachable: true, engine, tabs };
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
 * **Edge reports `Edg/`, not `Edge/`** — measured against Edge 151.0.4129.78,
 * whose `/json/version` returns `Browser: "Edg/151.0.4129.78"`. Checking only
 * `Edge/` classified every modern Edge as `unknown`, because that string
 * matches none of the arms below either. The `Edge/` arm is kept for older
 * builds that did use it.
 *
 * The ordering is load-bearing: Edge must be tested before Chrome. It is not
 * needed for the strings above (Edge's contains no "Chrome/" prefix) but a
 * future Edge reporting `Chrome/… Edg/…` would otherwise classify as Chrome.
 *
 * Kept in step with `src/browser/cdp-discovery.ts`'s copy, which carries the
 * same table.
 */
function classifyEngine(browser: string): CdpEngine {
  if (browser.startsWith('Edg/') || browser.startsWith('Edge/')) return 'edge';
  if (browser.startsWith('HeadlessChrome/')) return 'chrome';
  if (browser.startsWith('Chrome/')) return 'chrome';
  if (browser.startsWith('Chromium/')) return 'chromium';
  // A Node.js --inspect endpoint also serves /json/version (Browser:
  // "node.js/v22.x") but isn't an attachable browser. Classify it so the
  // dropdown can hide it — port 9229 is the Node inspector default.
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
