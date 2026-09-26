/**
 * Record Steps through the real HTTP entry, with a REAL browser
 * (stories/testbench-record-steps.md §Tests, "End to end on the server").
 *
 * The app is `createApiServer` on a real `node:http` listener, the session
 * manager and the recorder are real, and the browser is a real Chromium the
 * server launches through its own deferred launcher. Two edges are replaced:
 *
 *  - `launchBrowser` starts that Chromium HEADLESS. The route refuses a
 *    headless SERVER (`browser.headed: false`), and this suite's config says
 *    headed — but a test run must not open windows on the developer's desktop,
 *    and nothing the recorder does depends on a visible window.
 *  - the AI client is a script that records every request, so the prompt can
 *    be read and no network is touched.
 *
 * The page is driven with Playwright input — trusted events, as a person's are.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Config } from '../src/config/types.js';
import type { ChatMessage, MessageContentBlock } from '../src/ai/types.js';

const launches = vi.hoisted(() => ({ count: 0, pages: [] as unknown[], closers: [] as Array<() => Promise<void>> }));
const ai = vi.hoisted(() => ({
  requests: [] as ChatMessage[][],
  responses: [] as Array<string | Error>,
  policyAtCall: [] as boolean[],
  clients: [] as Array<{ aiPolicyAllowed: boolean }>,
  gate: null as Promise<void> | null,
  openGate: null as (() => void) | null,
}));

vi.mock('../src/browser/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/manager.js')>();
  return {
    ...actual,
    launchBrowser: async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page = await context.newPage();
      const pageTracker = new actual.PageTracker(page);
      context.on('page', (p) => pageTracker.addPage(p));
      launches.count++;
      launches.pages.push(page);
      launches.closers.push(() => browser.close());
      return { browser, context, page, pageTracker, engine: 'chromium' as const, headed: true };
    },
  };
});

vi.mock('../src/ai/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/client.js')>();
  class AiClient {
    private allowed = true;
    constructor() {
      ai.clients.push(this);
    }
    setAiPolicy(allowed: boolean): void {
      this.allowed = allowed;
    }
    get aiPolicyAllowed(): boolean {
      return this.allowed;
    }
    syncAuth(): null {
      return null;
    }
    isConfigured(): boolean {
      return true;
    }
    async complete(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
      ai.requests.push(messages);
      ai.policyAtCall.push(this.allowed);
      if (!this.allowed) throw new actual.AiForbiddenByPolicyError();
      if (ai.gate) await ai.gate;
      const next = ai.responses.shift();
      if (next === undefined) throw new Error('the model was asked more times than scripted');
      if (next instanceof Error) throw next;
      return { text: next, model: 'stub' };
    }
  }
  return { ...actual, AiClient };
});

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: async () => ({ files: [], combined: '' }),
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: async () => '/tmp/fake-report.html',
  getPrimaryModel: () => 'stub',
  buildReportBaseName: (report: { testName: string }) => report.testName,
  videoBaseNameFor: () => 'v',
  countStepOrigins: () => ({}),
}));

import { createApiServer } from '../src/server/api-server.js';
import {
  RECORD_STEPS_HEADLESS_MESSAGE,
  RECORD_STEPS_NO_MODEL_MESSAGE,
  RECORD_STEPS_RUN_EXECUTING_MESSAGE,
} from '../src/server/session-manager.js';

const API_KEY = 'record-steps-key';
const SECRET = 'Sup3r-Secret-Value!';

const PAGES: Record<string, string> = {
  '/form.html': `<!doctype html><html><head><title>SecureBank sign in</title></head><body>
    <nav aria-label="Main menu"><a href="/other.html" id="reports" onclick="event.preventDefault()">Reports</a></nav>
    <main><h1>Sign in</h1>
      <form onsubmit="event.preventDefault()">
        <label for="email">Email</label><input id="email" name="email" type="email">
        <label for="pw">Password</label><input id="pw" name="password" type="password">
        <label>Frequency <select id="freq"><option>Weekly</option><option>Monthly</option></select></label>
        <input type="checkbox" id="cash"><label for="cash">Cash</label>
        <button type="submit" id="signin">Sign in</button>
      </form>
      <section aria-labelledby="pm"><h2 id="pm">Payment method</h2><p id="pm-text">Paid in cash</p></section>
    </main></body></html>`,
  '/other.html': '<!doctype html><html><head><title>Other</title></head><body><h1>Other</h1></body></html>',
};

const FILE_TEXT = [
  '# Pay by cash',
  '',
  '## Config',
  '- baseUrl: PLACEHOLDER',
  '',
  '## Parameters',
  '- existing_user: someone@example.test',
  '- password: $PASSWORD',
  '',
  '## Steps',
  '1. Navigate to form.html',
  '',
  '### Pay with cash',
  '1. Click Pay now',
].join('\n');

let pageServer: Server;
let origin: string;
let projectRoot: string;
let testFilePath: string;

beforeAll(async () => {
  pageServer = createServer((req, res) => {
    const body = PAGES[(req.url ?? '/').split('?')[0]!];
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(body);
  });
  await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = pageServer.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  projectRoot = mkdtempSync(path.join(tmpdir(), 'aiui-record-steps-'));
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  testFilePath = path.join(projectRoot, 'tests', 'pay-by-cash.md');
});

afterAll(async () => {
  await new Promise<void>((resolve) => pageServer?.close(() => resolve()));
  rmSync(projectRoot, { recursive: true, force: true });
});

function testConfig(headed: boolean, apiKey: string | null = 'test-key'): Config {
  return {
    ai: {
      gatewayUrl: 'https://ai.test', model: 'test-model', maxInputTokens: 100_000, streamResponses: false,
      sendScreenshots: true, ...(apiKey !== null && { apiKey }),
    },
    browser: {
      headed, viewport: { width: 1000, height: 800 }, windowSize: { width: 1000, height: 800 },
      slowMo: 0, browser: 'chromium', fullPageScreenshots: false, captureScreenshotsPerAction: false,
    },
    tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
    execution: { timeout: 30_000, retries: 0, screenshotOnFailure: false, promptOnAmbiguity: false, maxTurns: 2 },
    reports: {
      outputDir: path.join(projectRoot, 'reports'),
      includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: true, embedScreenshots: false,
    },
    api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
    server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
    logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  } as unknown as Config;
}

let server: Server;
let baseUrl: string;
let sessionManager: ReturnType<typeof createApiServer>['sessionManager'];

async function listen(app: Express): Promise<void> {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

async function startApp(headed = true, apiKey: string | null = 'test-key'): Promise<void> {
  const built = createApiServer(testConfig(headed, apiKey), undefined, undefined, {
    // A typed navigation needs no real-time wait here, and the tap is not used.
    recorder: { typedNavigationWindowMs: 200 },
  });
  sessionManager = built.sessionManager;
  await listen(built.app);
}

beforeEach(async () => {
  launches.count = 0;
  launches.pages.length = 0;
  launches.closers.length = 0;
  ai.requests.length = 0;
  ai.responses.length = 0;
  ai.policyAtCall.length = 0;
  ai.clients.length = 0;
  ai.gate = null;
  await startApp();
});

afterEach(async () => {
  ai.openGate?.();
  ai.openGate = null;
  await sessionManager?.closeAll().catch(() => {});
  for (const close of launches.closers) await close().catch(() => {});
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

interface Frame {
  event: string;
  data: any;
}

/** A live SSE reader: frames accumulate as they arrive, and a test can wait
 *  for the one it needs. */
class Stream {
  readonly frames: Frame[] = [];
  readonly closed: Promise<void>;

  constructor(res: globalThis.Response, private readonly controller: AbortController) {
    this.closed = (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            let event = '';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (event) this.frames.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        // aborted by the test
      }
    })();
  }

  async waitFor(pred: (f: Frame) => boolean, what: string, timeoutMs = 15_000): Promise<Frame> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() > until) {
        throw new Error(`timed out waiting for ${what}; frames so far: ${JSON.stringify(this.frames.map((f) => f.data))}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async waitForCount(event: string, n: number, timeoutMs = 15_000): Promise<Frame[]> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hits = this.frames.filter((f) => f.event === event);
      if (hits.length >= n) return hits;
      if (Date.now() > until) {
        throw new Error(`timed out waiting for ${n} ${event}; frames so far: ${JSON.stringify(this.frames.map((f) => f.data))}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  abort(): void {
    this.controller.abort();
  }
}

function recordBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    testFilePath,
    config: { baseUrl: `${origin}/form.html` },
    target: { mode: 'cursor', fileText: FILE_TEXT.replace('PLACEHOLDER', `${origin}/`), cursorLine: 11 },
    ...extra,
  };
}

async function record(sessionId: string, body: Record<string, unknown>): Promise<{ status: number; json?: any; stream?: Stream }> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/record-steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return { status: res.status, stream: new Stream(res, controller) };
  }
  return { status: res.status, json: await res.json() };
}

async function post(route: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function control(sessionId: string, body: unknown): Promise<{ status: number; json: any }> {
  return post(`/sessions/${encodeURIComponent(sessionId)}/record-steps/control`, body);
}

function pageOf(n = 0): Page {
  return launches.pages[n] as Page;
}

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as MessageContentBlock[]).map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n'),
    )
    .join('\n');
}

function recordingOf(messages: ChatMessage[]): Array<Record<string, any>> {
  const text = textOf(messages);
  // The last occurrences: the system rules name the fences too (rule D1).
  const start = text.lastIndexOf('--- BEGIN RECORDING ---');
  const end = text.lastIndexOf('--- END RECORDING ---');
  return JSON.parse(text.slice(start + '--- BEGIN RECORDING ---'.length, end));
}

const ANSWER = JSON.stringify({
  steps: [
    'Type {{email}} into the Email field',
    'Type {{password}} into the Password field',
    'Select "Monthly" from the Frequency list',
    'Tick the Cash checkbox',
    'Verify the Payment method panel says "Paid in cash"',
  ],
  parameters: [
    { name: 'email', value: 'demo@securebank.com' },
    { name: 'password', value: '$PASSWORD' },
  ],
});

describe('POST /sessions/:id/record-steps — a whole recording', () => {
  it('launches the browser, streams actions live, and writes the steps at Stop', async () => {
    const id = 'rec-whole';
    const started = await record(id, recordBody());
    expect(started.status).toBe(200);
    const s = started.stream!;
    const first = await s.waitFor((f) => f.event === 'record:started', 'record:started');
    expect(first.data).toEqual({ type: 'record:started', url: `${origin}/form.html`, title: 'SecureBank sign in' });
    expect(launches.count).toBe(1);

    const page = pageOf();
    await page.click('#reports');
    await s.waitForCount('record:action', 1);
    await page.fill('#email', 'demo@securebank.com');
    await page.fill('#pw', SECRET);
    await page.selectOption('#freq', { label: 'Monthly' });
    await page.check('#cash');
    // The select and the tick arrive at once; the typing is reported when the
    // author moves on from each field.
    const live = await s.waitForCount('record:action', 5);
    expect(live.map((f) => f.data.kind)).toEqual(['click', 'type', 'type', 'select', 'tick']);
    expect(live[0]!.data).toMatchObject({ type: 'record:action', id: 'a1', summary: 'Clicked link "Reports"' });
    expect(live[0]!.data.tab).toBeUndefined();
    expect(live[2]!.data.summary).toBe('Typed *** into textbox "Password"');
    for (let i = 1; i < live.length; i++) expect(live[i]!.data.atMs).toBeGreaterThanOrEqual(live[i - 1]!.data.atMs);

    // Add check: armed, the pick lands on the panel's text, and disarms.
    expect((await control(id, { action: 'check' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:pick' && f.data.armed === true, 'pick armed');
    await page.click('#pm-text');
    const check = await s.waitFor((f) => f.event === 'record:action' && f.data.kind === 'check', 'check action');
    expect(check.data.summary).toContain('Paid in cash');
    await s.waitFor((f) => f.event === 'record:pick' && f.data.armed === false, 'pick disarmed');

    // Stop, dropping the misclick on Reports.
    ai.responses.push(ANSWER);
    expect((await control(id, { action: 'stop', dropped: ['a1'] })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:writing', 'record:writing');
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data).toEqual({ type: 'record:result', ...JSON.parse(ANSWER) });
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'passed' });
    await s.closed;

    // What the model was given.
    expect(ai.requests).toHaveLength(1);
    const prompt = ai.requests[0]!;
    const text = textOf(prompt);
    const actions = recordingOf(prompt);
    expect(actions.map((a) => a['kind'])).toEqual(['type', 'type', 'select', 'tick', 'check']);
    expect(actions.some((a) => a['target']?.name === 'Reports')).toBe(false); // dropped
    expect(actions[0]).toMatchObject({ value: 'demo@securebank.com', target: { name: 'Email' } });
    expect(actions[1]).toMatchObject({ secret: true, target: { name: 'Password' } });
    expect(actions[1]!['value']).toBeUndefined();
    expect(actions[2]).toMatchObject({ options: ['Monthly'], target: { name: 'Frequency' } });
    expect(actions[4]!['check']).toMatchObject({ text: 'Paid in cash', container: { name: 'Payment method' } });
    // The file's context.
    expect(text).toContain(`"baseUrl": "${origin}/"`);
    expect(text).toContain('existing_user');
    expect(text).toContain('$PASSWORD');
    expect(text).toContain('Pay with cash');
    expect(text).toContain('>>  11  1. Navigate to form.html');
    // Crops, because ai.sendScreenshots is on.
    const images = (prompt[1]!.content as MessageContentBlock[]).filter((b) => b.type === 'image_url');
    expect(images.length).toBeGreaterThanOrEqual(3);
    // The secret is nowhere: not in the prompt, not on the stream.
    expect(JSON.stringify(prompt)).not.toContain(SECRET);
    expect(JSON.stringify(s.frames)).not.toContain(SECRET);

    // The recording is over: control has nothing to reach, and the session's
    // queue is free for a run.
    expect((await control(id, { action: 'stop' })).status).toBe(404);
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
    expect(sessionManager.runsInFlight()).toBe(0);
  }, 90_000);

  it('launches a browser only when the session has none', async () => {
    const id = 'rec-reuse';
    const one = await record(id, recordBody());
    await one.stream!.waitFor((f) => f.event === 'record:started', 'first start');
    await pageOf().goto(`${origin}/other.html`);
    expect((await control(id, { action: 'cancel' })).status).toBe(202);
    await one.stream!.waitFor((f) => f.event === 'done', 'first done');
    expect(launches.count).toBe(1);

    // No `config` the second time: the session exists. It records from where
    // the browser IS, not from baseUrl.
    const two = await record(id, recordBody({ config: undefined }));
    expect(two.status).toBe(200);
    const started = await two.stream!.waitFor((f) => f.event === 'record:started', 'second start');
    expect(started.data.url).toBe(`${origin}/other.html`);
    expect(launches.count).toBe(1);
    await control(id, { action: 'cancel' });
    await two.stream!.waitFor((f) => f.event === 'done', 'second done');
  }, 90_000);
});

describe('refusals', () => {
  it('400 on a headless server, with the reason', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startApp(false);
    const res = await record('rec-headless', recordBody());
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(RECORD_STEPS_HEADLESS_MESSAGE);
    expect(launches.count).toBe(0);
  }, 30_000);

  it('400 when no model is configured — before any browser is launched (SPEC §8)', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startApp(true, null);
    const res = await record('rec-no-model', recordBody());
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(RECORD_STEPS_NO_MODEL_MESSAGE);
    expect(launches.count).toBe(0);
    // An .env that brings a key is enough.
    const keyed = await record('rec-no-model', recordBody({ env: { AI_API_KEY: 'from-env' } }));
    expect(keyed.status).toBe(200);
    await keyed.stream!.waitFor((f) => f.event === 'record:started', 'start');
    await control('rec-no-model', { action: 'cancel' });
    await keyed.stream!.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('400 for `config` on a session that already has one — the steps route\'s rule', async () => {
    const id = 'rec-config';
    const one = await record(id, recordBody());
    await one.stream!.waitFor((f) => f.event === 'record:started', 'start');
    await control(id, { action: 'cancel' });
    await one.stream!.waitFor((f) => f.event === 'done', 'done');

    const again = await record(id, recordBody());
    expect(again.status).toBe(400);
    expect(again.json.error).toMatch(/Config can only be provided on the first request/);
  }, 60_000);

  it('400 for a malformed body, and for a cursor with no line', async () => {
    expect((await record('rec-bad', { target: { mode: 'new', fileText: '' } })).status).toBe(400);
    const noLine = await record('rec-bad', { testFilePath, target: { mode: 'cursor', fileText: '' } });
    expect(noLine.status).toBe(400);
    expect(noLine.json.error).toMatch(/cursorLine/);
    expect((await record('rec-bad', { testFilePath, target: { mode: 'sideways', fileText: '' } })).status).toBe(400);
  });

  it('409 while a recording holds the queue — for a second recording and for a steps request', async () => {
    const id = 'rec-busy';
    const one = await record(id, recordBody());
    await one.stream!.waitFor((f) => f.event === 'record:started', 'start');

    const second = await record(id, recordBody({ config: undefined }));
    expect(second.status).toBe(409);

    // The documented choice: a run is refused, not queued behind the recording.
    const steps = await post(`/sessions/${id}/steps?stream=1`, { steps: ['Click Sign in'], testFilePath });
    expect(steps.status).toBe(409);
    expect(steps.json.error).toMatch(/Record Steps recording is running/);

    await control(id, { action: 'cancel' });
    await one.stream!.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('409 when a run holds the session\'s queue', async () => {
    const id = 'rec-run-busy';
    let open!: () => void;
    ai.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    ai.openGate = open;
    ai.responses.push(new Error('scripted failure: end the step'));
    const run = post(`/sessions/${id}/steps`, {
      steps: ['Click the Sign in button'],
      testFilePath,
      config: { baseUrl: `${origin}/form.html` },
    });
    // Wait until the run is at its model call, holding the queue.
    const until = Date.now() + 30_000;
    while (ai.requests.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(ai.requests.length).toBe(1);

    const refused = await record(id, recordBody({ config: undefined }));
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe(RECORD_STEPS_RUN_EXECUTING_MESSAGE);

    open();
    ai.gate = null;
    await run;
  }, 90_000);
});

describe('ending a recording without writing', () => {
  it('cancel ends it with `aborted` and no model call', async () => {
    const id = 'rec-cancel';
    const r = await record(id, recordBody());
    await r.stream!.waitFor((f) => f.event === 'record:started', 'start');
    await pageOf().fill('#email', 'x@y.test');
    await pageOf().click('#signin');
    await r.stream!.waitForCount('record:action', 2);
    expect((await control(id, { action: 'cancel' })).status).toBe(202);
    const done = await r.stream!.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'aborted' });
    expect(r.stream!.frames.some((f) => f.event === 'record:writing')).toBe(false);
    expect(ai.requests).toHaveLength(0);
  }, 60_000);

  it('closing the stream stops the recording and frees the session', async () => {
    const id = 'rec-close';
    const r = await record(id, recordBody());
    await r.stream!.waitFor((f) => f.event === 'record:started', 'start');
    r.stream!.abort();
    const until = Date.now() + 10_000;
    while (sessionManager.isRecordingSteps(id) && Date.now() < until) await new Promise((res) => setTimeout(res, 25));
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
    expect((await control(id, { action: 'stop' })).status).toBe(404);
    expect(sessionManager.runsInFlight()).toBe(0);
    expect(ai.requests).toHaveLength(0);

    // The slot is free: the same session records again, in the same browser.
    const again = await record(id, recordBody({ config: undefined }));
    expect(again.status).toBe(200);
    await again.stream!.waitFor((f) => f.event === 'record:started', 'restart');
    await control(id, { action: 'cancel' });
    await again.stream!.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe('the model call', () => {
  it('a malformed answer is an error frame and done: error — not a crash', async () => {
    const id = 'rec-bad-json';
    const r = await record(id, recordBody());
    await r.stream!.waitFor((f) => f.event === 'record:started', 'start');
    await pageOf().click('#signin');
    await r.stream!.waitForCount('record:action', 1);
    ai.responses.push('Sure! Here are your steps: 1. Click Sign in');
    await control(id, { action: 'stop' });
    const out = await r.stream!.waitFor((f) => f.event === 'output' && f.data.kind === 'error', 'error output');
    expect(out.data.msg).toMatch(/JSON/);
    const done = await r.stream!.waitFor((f) => f.event === 'done', 'done');
    expect(done.data.status).toBe('error');
    expect(done.data.error).toMatch(/JSON/);
    expect(r.stream!.frames.some((f) => f.event === 'record:result')).toBe(false);
    // The server is fine: the session records again.
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
  }, 60_000);

  it('runs with the AI switch lifted, and puts the veil back as it was', async () => {
    const id = 'rec-policy';
    // A batch that runs with `ai: off` leaves the session's client veiled.
    const batch = await post(`/sessions/${id}/steps`, {
      steps: ['Set {{x}} to "y"'],
      testFilePath,
      config: { baseUrl: `${origin}/form.html` },
      runSettings: { ai: 'off' },
    });
    expect(batch.status).toBe(200);
    const client = ai.clients[ai.clients.length - 1]!;
    expect(client.aiPolicyAllowed).toBe(false);

    const r = await record(id, recordBody({ config: undefined }));
    await r.stream!.waitFor((f) => f.event === 'record:started', 'start');
    await pageOf().click('#signin');
    await r.stream!.waitForCount('record:action', 1);
    ai.responses.push(JSON.stringify({ steps: ['Click Sign in'], parameters: [] }));
    await control(id, { action: 'stop' });
    const done = await r.stream!.waitFor((f) => f.event === 'done', 'done');
    expect(done.data.status).toBe('passed');
    expect(ai.policyAtCall).toEqual([true]);
    expect(client.aiPolicyAllowed).toBe(false);
  }, 60_000);

  it('a model that rejects images is asked again without them, with a warning', async () => {
    const id = 'rec-no-images';
    const r = await record(id, recordBody());
    await r.stream!.waitFor((f) => f.event === 'record:started', 'start');
    await pageOf().click('#signin');
    await r.stream!.waitForCount('record:action', 1);
    const rejection = Object.assign(new Error('400 this model does not accept images'), {
      code: 'image_input_unsupported',
    });
    ai.responses.push(rejection, JSON.stringify({ steps: ['Click Sign in'], parameters: [] }));
    await control(id, { action: 'stop' });
    const done = await r.stream!.waitFor((f) => f.event === 'done', 'done');
    expect(done.data.status).toBe('passed');
    expect(ai.requests).toHaveLength(2);
    const imagesIn = (m: ChatMessage[]): number =>
      (m[1]!.content as MessageContentBlock[]).filter((b) => b.type === 'image_url').length;
    expect(imagesIn(ai.requests[0]!)).toBeGreaterThan(0);
    expect(imagesIn(ai.requests[1]!)).toBe(0);
    expect(r.stream!.frames.some((f) => f.event === 'output' && f.data.kind === 'warn' && /images/.test(f.data.msg))).toBe(true);
  }, 60_000);
});

describe('POST /sessions/:id/record-steps/control', () => {
  it('404 when no recording is running; 400 on an unknown action or a bad dropped list', async () => {
    expect((await control('nobody', { action: 'stop' })).status).toBe(404);
    expect((await control('nobody', { action: 'pause' })).status).toBe(400);
    expect((await control('nobody', { action: 'stop', dropped: [1, 2] })).status).toBe(400);
  });
});
