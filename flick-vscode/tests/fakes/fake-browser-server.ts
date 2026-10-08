// A real HTTP server that pretends to be a Chromium-based browser exposing
// CDP HTTP discovery endpoints (`/json/version` + `/json/list`). Tests point
// cdp-discovery / the controller at one of these instead of spawning a real
// browser, so every probe — fetch, JSON parsing, classifyEngine, the
// type-filter — runs against the genuine code path.
//
// Sibling to FakeApiServer: same listen-on-127.0.0.1-port-0 idiom, same
// start/stop contract, same minimal behaviour with knobs flipped per test.

import * as http from 'node:http';
import { listenFetchable } from '../../../tests/listen-fetchable.cjs';

export interface FakeBrowserTab {
  id: string;
  /** Defaults to 'page'. Set to 'background_page' / 'iframe' to verify the
   *  discovery module filters non-page targets out. */
  type?: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

export class FakeBrowserServer {
  /** Set BEFORE start() (or any time before a discovery call) to control the
   *  `Browser` field returned by /json/version. e.g. 'Chrome/120.0.6099.130'
   *  or 'Edg/151.0.4129.78' (the spelling a real Edge sends — NOT 'Edge/').
   *  Empty string → engine classified as 'unknown'. */
  browserField = 'Chrome/120.0.6099.130';

  /** Tabs returned from /json/list. Mutable so tests can swap mid-flight. */
  tabs: FakeBrowserTab[] = [];

  private server: http.Server | undefined;
  private boundPort = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.boundPort = await listenFetchable(this.server, '127.0.0.1');
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    if (url === '/json/version') {
      return send(res, 200, { Browser: this.browserField });
    }
    if (url === '/json/list' || url === '/json') {
      const wire = this.tabs.map((t) => ({
        id: t.id,
        type: t.type ?? 'page',
        url: t.url,
        title: t.title,
        ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}),
      }));
      return send(res, 200, wire);
    }
    send(res, 404, { error: 'unknown route' });
  }
}

function send(res: http.ServerResponse, status: number, json: unknown): void {
  const payload = JSON.stringify(json);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}
