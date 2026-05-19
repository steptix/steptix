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
    return { port, engine: 'unknown', tabs: null, error: errorMessage(err) };
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
    return { port, engine, tabs: null, error: errorMessage(err) };
  }

  if (!Array.isArray(listJson)) {
    return { port, engine, tabs: null, error: 'malformed /json/list' };
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
  return { port, engine, tabs };
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

function classifyEngine(browser: string): CdpEngine {
  if (browser.startsWith('Edge/')) return 'edge';
  if (browser.startsWith('HeadlessChrome/')) return 'chrome';
  if (browser.startsWith('Chrome/')) return 'chrome';
  if (browser.startsWith('Chromium/')) return 'chromium';
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
