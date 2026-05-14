// A real HTTP server that implements the subset of the ai-ui-automation
// Sessions API (SPEC-SESSIONS-API.md) that Flick calls. Tests drive the
// controller against this so the API client, fetch, JSON handling and
// screenshot decoding all run for real.

import * as http from 'node:http';

/** A 1x1 transparent PNG — small but a genuine decodable image. */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface RecordedRequest {
  method: string;
  path: string;
  apiKey: string | undefined;
  body: unknown;
}

interface StepsResponse {
  status?: number;
  json?: unknown;
}

export class FakeApiServer {
  /** Every request the server received, in order. */
  readonly requests: RecordedRequest[] = [];

  /** Override to control the POST /sessions/:id/steps response. */
  stepsResponse: (sessionId: string, body: any) => StepsResponse = (sessionId, body) => ({
    json: passedBatch(sessionId, body?.steps ?? []),
  });

  /** Status returned by GET /sessions/:id (200 = active, 404 = stale). */
  sessionStateStatus = 200;

  /** Status returned by GET /sessions (the connectivity ping). */
  pingStatus = 200;

  private server: http.Server | undefined;
  private boundPort = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const url = req.url ?? '';
      this.requests.push({
        method: req.method ?? 'GET',
        path: url,
        apiKey: req.headers['x-api-key'] as string | undefined,
        body,
      });
      this.route(req.method ?? 'GET', url, body, res);
    });
  }

  private route(method: string, url: string, body: unknown, res: http.ServerResponse): void {
    // POST /sessions/:id/steps
    const stepsMatch = /^\/sessions\/([^/]+)\/steps$/.exec(url);
    if (method === 'POST' && stepsMatch) {
      const sessionId = decodeURIComponent(stepsMatch[1]);
      const result = this.stepsResponse(sessionId, body);
      return send(res, result.status ?? 200, result.json ?? passedBatch(sessionId, []));
    }

    // GET /sessions/:id
    const stateMatch = /^\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && stateMatch) {
      const sessionId = decodeURIComponent(stateMatch[1]);
      if (this.sessionStateStatus === 404) {
        return send(res, 404, { error: 'not found' });
      }
      return send(res, this.sessionStateStatus, {
        sessionId,
        status: 'active',
        currentUrl: 'http://localhost:3000/',
        pageTitle: 'Fake',
        screenshot: TINY_PNG,
        outputs: {},
        totalStepsExecuted: 0,
      });
    }

    // GET /sessions
    if (method === 'GET' && url === '/sessions') {
      return send(res, this.pingStatus, { sessions: [] });
    }

    send(res, 404, { error: 'unknown route' });
  }
}

function send(res: http.ServerResponse, status: number, json: unknown): void {
  const payload = JSON.stringify(json);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** Default "everything passed" batch response, echoing the submitted steps. */
export function passedBatch(sessionId: string, steps: string[]): unknown {
  return {
    sessionId,
    status: 'passed',
    stepsCompleted: steps.length,
    stepsTotal: steps.length,
    results: steps.map((step) => ({
      step,
      status: 'passed',
      actions: [{ type: 'noop' }],
      reasoning: 'fake: ok',
      outputs: {},
      screenshot: TINY_PNG,
    })),
    outputs: {},
    error: null,
  };
}

/** A batch where the step at `failIndex` failed. */
export function failedBatch(sessionId: string, steps: string[], failIndex: number): unknown {
  return {
    sessionId,
    status: 'failed',
    stepsCompleted: failIndex,
    stepsTotal: steps.length,
    results: steps.slice(0, failIndex + 1).map((step, i) => ({
      step,
      status: i === failIndex ? 'failed' : 'passed',
      actions: [{ type: 'assert' }],
      reasoning: i === failIndex ? 'fake: assertion failed' : 'fake: ok',
      outputs: {},
      screenshot: TINY_PNG,
    })),
    outputs: {},
    error: { step: failIndex, message: 'Assertion failed: expected X but found Y' },
  };
}
