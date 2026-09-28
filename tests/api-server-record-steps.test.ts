/**
 * Record Steps through the real HTTP entry, with a REAL browser
 * (stories/testbench-record-steps.md §Tests, "End to end on the server";
 * live drafting, decision 9 and docs/specs/SPEC-record-steps.md §8, §9).
 *
 * The app is `createApiServer` on a real `node:http` listener, the session
 * manager, the recorder and the draft engine are real, and the browser is a
 * real Chromium the server launches through its own deferred launcher. Two
 * edges are replaced:
 *
 *  - `launchBrowser` starts that Chromium HEADLESS. The route refuses a
 *    headless SERVER (`browser.headed: false`), and this suite's config says
 *    headed — but a test run must not open windows on the developer's desktop,
 *    and nothing the recorder does depends on a visible window.
 *  - the AI client is a script that records every request and answers each
 *    draft call — by default by echoing the new actions as steps, so a test can
 *    read exactly which actions each call was shown and what the draft became.
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

type Answer = string | Error;

const launches = vi.hoisted(() => ({
  count: 0,
  pages: [] as unknown[],
  closers: [] as Array<() => Promise<void>>,
  /** What the launched browser says it is — false stands for `openBrowser` opening a headless one. */
  headed: true,
}));
const ai = vi.hoisted(() => ({
  requests: [] as ChatMessage[][],
  /** Answers taken first, in order — for a run's own steps or a scripted call. */
  responses: [] as Array<string | Error>,
  /** Answers every call the queue does not: (messages, 1-based call number). */
  responder: null as null | ((messages: ChatMessage[], call: number) => string | Error),
  policyAtCall: [] as boolean[],
  clients: [] as Array<{ aiPolicyAllowed: boolean }>,
  gate: null as Promise<void> | null,
  openGate: null as (() => void) | null,
  /** Calls whose abort signal fired while they waited. */
  aborted: 0,
  /** Calls running right now, and the most ever at once. */
  inFlight: 0,
  maxInFlight: 0,
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
      return { browser, context, page, pageTracker, engine: 'chromium' as const, headed: launches.headed };
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
    async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<{ text: string; model: string }> {
      ai.inFlight++;
      ai.maxInFlight = Math.max(ai.maxInFlight, ai.inFlight);
      try {
        return await this.answer(messages, signal);
      } finally {
        ai.inFlight--;
      }
    }
    private async answer(messages: ChatMessage[], signal?: AbortSignal): Promise<{ text: string; model: string }> {
      ai.requests.push(messages);
      const call = ai.requests.length;
      ai.policyAtCall.push(this.allowed);
      if (!this.allowed) throw new actual.AiForbiddenByPolicyError();
      if (ai.gate) {
        const gate = ai.gate;
        await new Promise<void>((resolve, reject) => {
          void gate.then(resolve);
          signal?.addEventListener(
            'abort',
            () => {
              ai.aborted++;
              reject(new Error('The operation was aborted.'));
            },
            { once: true },
          );
        });
      }
      if (signal?.aborted) throw new Error('The operation was aborted.');
      const scripted = ai.responses.shift();
      const next = scripted !== undefined ? scripted : ai.responder ? ai.responder(messages, call) : undefined;
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
import { clickDrawer, clickToolbar, readDrawer, readToolbar, stepBoxValue, until } from './record-toolbar-cdp.js';
import { addLogCallback, getLogLevel, logger, setLogLevel } from '../src/utils/logger.js';
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
  '/board.html': `<!doctype html><html><head><title>Board</title></head><body>
    <section aria-label="To do"><h2>To do</h2><div id="card" draggable="true" style="width:120px">Invoice 1043</div></section>
    <section aria-label="Paid" id="paid" style="min-height:80px"><h2>Paid</h2></section>
    <script>
      const card = document.getElementById('card');
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'));
      const paid = document.getElementById('paid');
      paid.addEventListener('dragover', (e) => e.preventDefault());
      paid.addEventListener('drop', (e) => { e.preventDefault(); paid.appendChild(card); });
    </script></body></html>`,
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

/** The settle window most tests run with: short, so a test waits little, and
 *  long enough that one Playwright gesture's actions land in one call. */
const QUICK_SETTLE_MS = 150;
/** Long enough that no draft call happens during the test's actions. */
const NEVER_SETTLES_MS = 60_000;

async function startApp(
  opts: { headed?: boolean; apiKey?: string | null; draftSettleMs?: number } = {},
): Promise<void> {
  const built = createApiServer(testConfig(opts.headed ?? true, opts.apiKey === undefined ? 'test-key' : opts.apiKey), undefined, undefined, {
    // A typed navigation needs no real-time wait here, and the tap is not used.
    recorder: {
      typedNavigationWindowMs: 200,
      historyCausedWindowMs: 200,
      draftSettleMs: opts.draftSettleMs ?? QUICK_SETTLE_MS,
    },
  });
  sessionManager = built.sessionManager;
  await listen(built.app);
}

async function restartApp(opts: Parameters<typeof startApp>[0]): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await startApp(opts);
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

/** The actions one call was shown. */
function recordingOf(messages: ChatMessage[]): Array<Record<string, any>> {
  const text = textOf(messages);
  // The last occurrences: the system rules name the fences too (rule D1).
  const start = text.lastIndexOf('--- BEGIN RECORDING ---');
  const end = text.lastIndexOf('--- END RECORDING ---');
  return JSON.parse(text.slice(start + '--- BEGIN RECORDING ---'.length, end));
}

/** The draft so far one call was shown — [] for a full (re)draft. A call
 *  that inserts shows where its steps go; that marker is not a step. */
function draftOf(messages: ChatMessage[]): string[] {
  return draftEntriesOf(messages)
    .filter((s) => typeof s['step'] === 'string')
    .map((s) => s['step'] as string);
}

/** The draft so far as one call was shown it, flags and marker included. */
function draftEntriesOf(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const text = textOf(messages);
  const m = /## The draft so far: [^\n]*\n(?:[^\n]*\n)*?```json\n([\s\S]*?)\n```/.exec(text);
  if (!m) {
    expect(text).toContain('## The draft so far\nEmpty:');
    return [];
  }
  return (JSON.parse(m[1]!) as { steps: Array<Record<string, unknown>> }).steps;
}

function imagesIn(messages: ChatMessage[]): number {
  return (messages[1]!.content as MessageContentBlock[]).filter((b) => b.type === 'image_url').length;
}

/** The default model: append one step per new action, naming it. */
function echo(messages: ChatMessage[]): string {
  const draft = draftOf(messages);
  const actions = recordingOf(messages);
  return JSON.stringify({
    replaceFrom: draft.length,
    steps: actions.map((a) => `Did ${a['kind']} ${a['target']?.name ?? a['target']?.text ?? ''}`.trim()),
    parameters: [],
  });
}

beforeEach(async () => {
  launches.count = 0;
  launches.pages.length = 0;
  launches.closers.length = 0;
  launches.headed = true;
  ai.requests.length = 0;
  ai.responses.length = 0;
  ai.responder = (messages) => echo(messages);
  ai.policyAtCall.length = 0;
  ai.clients.length = 0;
  ai.gate = null;
  ai.aborted = 0;
  ai.inFlight = 0;
  ai.maxInFlight = 0;
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

  /** Wait until a draft covers the `n`th action — and return that draft. */
  async draftThrough(n: number): Promise<Frame> {
    const actions = await this.waitForCount('record:action', n);
    const id = actions[n - 1]!.data.id as string;
    return this.waitFor((f) => f.event === 'record:draft' && f.data.through === id, `a draft through ${id}`);
  }

  of(event: string): any[] {
    return this.frames.filter((f) => f.event === event).map((f) => f.data);
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

/** Start a recording and wait for `record:started`. */
async function started(sessionId: string, body: Record<string, unknown> = recordBody()): Promise<Stream> {
  const r = await record(sessionId, body);
  expect(r.status).toBe(200);
  await r.stream!.waitFor((f) => f.event === 'record:started', 'record:started');
  return r.stream!;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('live drafting — a whole recording', () => {
  it('drafts after each burst; each call sees only the new actions and the draft so far; Stop with a current draft makes no extra call', async () => {
    const id = 'rec-whole';
    const s = await started(id);
    expect(s.frames[0]!.data).toEqual({ type: 'record:started', url: `${origin}/form.html`, title: 'SecureBank sign in' });
    expect(launches.count).toBe(1);
    const page = pageOf();

    await page.click('#reports');
    const first = await s.draftThrough(1);
    expect(first.data).toMatchObject({ type: 'record:draft', revision: 1, steps: ['Did click Reports'], parameters: [] });

    // Typing is an EVENT: it sends nothing on its own…
    await page.fill('#email', 'demo@securebank.com');
    await page.fill('#pw', SECRET); // finishes the email field
    await s.waitForCount('record:action', 2);
    await sleep(QUICK_SETTLE_MS + 300);
    expect(ai.requests).toHaveLength(1);
    // …the Tab that follows is an ACTION, and its call carries the typing too.
    await page.press('#pw', 'Tab');
    await s.draftThrough(4);
    expect(recordingOf(ai.requests[1]!).map((a) => a['kind'])).toEqual(['type', 'type', 'key']);

    // A choice in a list rides with the next action; a click on a checkbox is
    // the action, and its tick rides with it.
    await page.selectOption('#freq', { label: 'Monthly' });
    await page.check('#cash');
    await s.draftThrough(7);
    expect(recordingOf(ai.requests[2]!).map((a) => a['kind'])).toEqual(['select', 'click', 'tick']);
    expect((await control(id, { action: 'check' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:pick' && f.data.armed === true, 'pick armed');
    await page.click('#pm-text');
    const last = await s.draftThrough(8);
    // Every frame says whether it was an action.
    expect(s.of('record:action').map((a) => [a.kind, a.action])).toEqual([
      ['click', true], ['type', false], ['type', false], ['key', true],
      ['select', false], ['click', true], ['tick', false], ['check', true],
    ]);

    // Every call saw only what the drafts before it had not covered, in order,
    // beside the draft the previous call produced.
    const drafts = s.of('record:draft');
    expect(drafts.map((d) => d.revision)).toEqual(drafts.map((_, i) => i + 1));
    let seen = 0;
    ai.requests.forEach((req, i) => {
      const numbers = recordingOf(req).map((a) => a['n']);
      expect(numbers[0], `call ${i + 1} starts where the last one ended`).toBe(seen + 1);
      expect(numbers).toEqual(numbers.map((_, k) => seen + 1 + k));
      seen = numbers[numbers.length - 1];
      expect(draftOf(req)).toEqual(i === 0 ? [] : drafts[i - 1].steps);
    });
    expect(seen).toBe(8);
    // Never two draft calls at once for one recording.
    expect(ai.maxInFlight).toBe(1);
    expect(ai.requests).toHaveLength(drafts.length);
    // Each call was bracketed for the panel's "updating…".
    expect(s.of('record:drafting').map((d) => d.busy)).toEqual(ai.requests.flatMap(() => [true, false]));
    // A draft never arrives ahead of the action it covers.
    const at = (pred: (f: Frame) => boolean): number => s.frames.findIndex(pred);
    expect(at((f) => f.event === 'record:draft' && f.data.revision === 1)).toBeGreaterThan(
      at((f) => f.event === 'record:action' && f.data.id === 'a1'),
    );
    // Crops go with the call that covers their action.
    expect(ai.requests.some((r) => imagesIn(r) > 0)).toBe(true);
    for (const r of ai.requests) expect(imagesIn(r)).toBeLessThanOrEqual(recordingOf(r).length);
    // The secret field: `secret`, no value, and its value nowhere.
    const typed = ai.requests.flatMap(recordingOf).filter((a) => a['kind'] === 'type');
    expect(typed.map((a) => [a['target'].name, a['value'], a['secret']])).toEqual([
      ['Email', 'demo@securebank.com', undefined],
      ['Password', undefined, true],
    ]);
    expect(JSON.stringify(ai.requests)).not.toContain(SECRET);

    // Stop: the draft covers every action, so no further call.
    const calls = ai.requests.length;
    expect((await control(id, { action: 'stop' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:writing', 'record:writing');
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'passed' });
    await s.closed;
    expect(ai.requests).toHaveLength(calls);
    expect(result.data.steps).toEqual(last.data.steps);
    expect(JSON.stringify(s.frames)).not.toContain(SECRET);
    // Nothing about drafting after record:writing.
    const writingAt = at((f) => f.event === 'record:writing');
    expect(s.frames.slice(writingAt).some((f) => f.event.startsWith('record:draft'))).toBe(false);

    expect((await control(id, { action: 'stop' })).status).toBe(404);
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
    expect(sessionManager.runsInFlight()).toBe(0);
  }, 90_000);

  it('a quick burst of actions goes in ONE call', async () => {
    await restartApp({ draftSettleMs: 500 });
    const s = await started('rec-burst');
    await pageOf().click('#email');
    await pageOf().check('#cash');
    await s.draftThrough(3);
    await sleep(700);
    expect(ai.requests).toHaveLength(1);
    expect(recordingOf(ai.requests[0]!).map((a) => a['kind'])).toEqual(['click', 'click', 'tick']);
    await control('rec-burst', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('actions that arrive while a call is running wait for it, and go together in the next call', async () => {
    const s = await started('rec-batch-inflight');
    let open!: () => void;
    ai.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    ai.openGate = open;
    await pageOf().click('#reports');
    await s.waitFor((f) => f.event === 'record:drafting' && f.data.busy === true, 'the first call');
    await pageOf().click('#signin');
    await pageOf().check('#cash');
    await s.waitForCount('record:action', 4);
    await sleep(QUICK_SETTLE_MS + 300); // well past the settle window
    expect(ai.requests).toHaveLength(1);

    ai.gate = null;
    open();
    await s.draftThrough(4);
    expect(ai.requests).toHaveLength(2);
    expect(recordingOf(ai.requests[1]!).map((a) => a['n'])).toEqual([2, 3, 4]);
    expect(draftOf(ai.requests[1]!)).toEqual(['Did click Reports']);
    expect(ai.maxInFlight).toBe(1);
    await control('rec-batch-inflight', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('a replaceFrom reaching back more than three steps is refused and retried once as a full redraft', async () => {
    ai.responder = (messages, call) => {
      if (call === 1) {
        return JSON.stringify({ replaceFrom: 0, steps: ['s1', 's2', 's3', 's4', 's5'], parameters: [] });
      }
      if (call === 2) {
        // Five steps in the draft: the furthest back allowed is 2.
        return JSON.stringify({ replaceFrom: 1, steps: ['rewritten'], parameters: [] });
      }
      return echo(messages);
    };
    const s = await started('rec-too-far');
    await pageOf().click('#reports');
    await s.draftThrough(1);
    await pageOf().click('#signin');
    const redraft = await s.draftThrough(2);
    expect(ai.requests).toHaveLength(3);
    // The retry: an empty draft, and every remaining action.
    expect(draftOf(ai.requests[2]!)).toEqual([]);
    expect(recordingOf(ai.requests[2]!).map((a) => a['n'])).toEqual([1, 2]);
    expect(redraft.data).toMatchObject({ revision: 2, steps: ['Did click Reports', 'Did click Sign in'] });
    expect(s.of('record:draft').some((d) => d.steps.includes('rewritten'))).toBe(false);
    await control('rec-too-far', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('a failed draft call is a warning, the draft stands, and the next call covers those actions again', async () => {
    ai.responder = (messages, call) => (call === 1 ? 'Sure! Here you go: click Reports' : echo(messages));
    const s = await started('rec-fail');
    await pageOf().click('#reports');
    const warning = await s.waitFor((f) => f.event === 'output' && f.data.kind === 'warn', 'a warning');
    expect(warning.data.msg).toMatch(/^The draft could not be updated: .*JSON/);
    await sleep(400);
    expect(s.of('record:draft')).toHaveLength(0);
    expect(ai.requests).toHaveLength(1); // no retry of its own

    await pageOf().click('#signin');
    const recovered = await s.draftThrough(2);
    expect(ai.requests).toHaveLength(2);
    expect(recordingOf(ai.requests[1]!).map((a) => a['n'])).toEqual([1, 2]);
    expect(recovered.data.steps).toEqual(['Did click Reports', 'Did click Sign in']);
    await control('rec-fail', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('drop and restore redraft the whole recording, without and then with the action', async () => {
    const id = 'rec-drop';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.draftThrough(1);
    await pageOf().click('#signin');
    await s.draftThrough(2);
    const before = ai.requests.length;

    expect((await control(id, { action: 'drop', id: 'a1' })).status).toBe(202);
    const without = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision === 3,
      'the redraft without a1',
    );
    expect(without.data.steps).toEqual(['Did click Sign in']);
    expect(ai.requests).toHaveLength(before + 1);
    expect(draftOf(ai.requests[before]!)).toEqual([]);
    expect(recordingOf(ai.requests[before]!).map((a) => a['target'].name)).toEqual(['Sign in']);

    expect((await control(id, { action: 'restore', id: 'a1' })).status).toBe(202);
    const withIt = await s.waitFor((f) => f.event === 'record:draft' && f.data.revision === 4, 'the redraft with a1');
    expect(withIt.data.steps).toEqual(['Did click Reports', 'Did click Sign in']);
    expect(recordingOf(ai.requests[before + 1]!).map((a) => a['target'].name)).toEqual(['Reports', 'Sign in']);

    // An id the recording does not have, or a restore of what is not dropped:
    // 202, nothing happens, and it says so.
    const unknown = await control(id, { action: 'drop', id: 'a99' });
    expect(unknown).toMatchObject({ status: 202, json: { ok: true } });
    expect(unknown.json.ignored).toMatch(/a99/);
    expect((await control(id, { action: 'restore', id: 'a2' })).json.ignored).toMatch(/not dropped/);
    await sleep(300);
    expect(ai.requests).toHaveLength(before + 2);

    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('a drop while a call is in flight throws its answer away: no draft with the dropped action', async () => {
    const id = 'rec-drop-inflight';
    const s = await started(id);
    let open!: () => void;
    ai.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    ai.openGate = open;
    await pageOf().click('#reports');
    await s.waitFor((f) => f.event === 'record:drafting' && f.data.busy === true, 'the call in flight');
    expect((await control(id, { action: 'drop', id: 'a1' })).status).toBe(202);
    ai.gate = null;
    open();
    // The in-flight call was abandoned, and the redraft of nothing is empty.
    const empty = await s.waitFor((f) => f.event === 'record:draft', 'a draft');
    expect(empty.data.steps).toEqual([]);
    expect(ai.aborted).toBe(1);
    expect(s.of('record:draft').some((d) => d.steps.includes('Did click Reports'))).toBe(false);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe('what is an action (decision 4)', () => {
  it('a drag is one drag action and one draft call', async () => {
    const s = await started('rec-drag', recordBody({ config: { baseUrl: `${origin}/board.html` } }));
    await pageOf().locator('#card').dragTo(pageOf().locator('#paid'));
    const draft = await s.draftThrough(1);
    await sleep(QUICK_SETTLE_MS + 300);
    expect(s.of('record:action').map((a) => [a.kind, a.action])).toEqual([['drag', true]]);
    expect(ai.requests).toHaveLength(1);
    const [drag] = recordingOf(ai.requests[0]!);
    expect(drag).toMatchObject({ kind: 'drag', target: { text: 'Invoice 1043' } });
    expect(drag!['dropTarget']).toBeDefined();
    // Two pictures for a drag: where it was picked up and where it landed.
    expect(imagesIn(ai.requests[0]!)).toBe(2);
    expect(textOf(ai.requests[0]!)).toContain('(drag — where it was dropped)');
    expect(draft.data.steps).toEqual(['Did drag Invoice 1043']);
    await control('rec-drag', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  /**
   * `page.goBack()`, `goForward()` and `reload()` are Playwright calls, not
   * the toolbar — but over CDP they are the same browser-initiated navigations
   * the toolbar makes, so what the recorder reads (nothing in the page asked;
   * the tab's history moved to an existing entry, or reloaded the current one)
   * is exactly what a person's click produces.
   */
  it('Back, Forward and Refresh are each an action, with a draft call — and none is a typed navigation', async () => {
    const id = 'rec-history';
    const s = await started(id);
    const page = pageOf();
    await page.goto(`${origin}/other.html`); // the address bar: a typed navigation
    await s.draftThrough(1);
    await sleep(300);
    await page.goBack();
    await s.draftThrough(2);
    await sleep(300);
    await page.goForward();
    await s.draftThrough(3);
    await sleep(300);
    await page.reload();
    await s.draftThrough(4);
    expect(s.of('record:action').map((a) => [a.kind, a.action])).toEqual([
      ['navigate', true], ['back', true], ['forward', true], ['reload', true],
    ]);
    expect(ai.requests).toHaveLength(4);
    expect(ai.requests.map((r) => recordingOf(r).map((a) => a['kind']))).toEqual([
      ['navigate'], ['back'], ['forward'], ['reload'],
    ]);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('Escape is not recorded and sends nothing', async () => {
    const s = await started('rec-escape');
    await pageOf().focus('#email');
    await pageOf().keyboard.press('Escape');
    await sleep(QUICK_SETTLE_MS + 400);
    expect(s.of('record:action')).toEqual([]);
    expect(ai.requests).toHaveLength(0);
    await control('rec-escape', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe('Stop', () => {
  it('with actions the draft does not cover yet: exactly one more call, over those only (and the Stop\'s dropped left out)', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'rec-stop-late';
    const s = await started(id);
    await pageOf().click('#reports');
    await pageOf().click('#signin');
    await s.waitForCount('record:action', 2);
    await sleep(300);
    expect(ai.requests).toHaveLength(0);

    expect((await control(id, { action: 'stop', dropped: ['a1'] })).status).toBe(202);
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    await s.waitFor((f) => f.event === 'done', 'done');
    expect(ai.requests).toHaveLength(1);
    expect(recordingOf(ai.requests[0]!).map((a) => a['target'].name)).toEqual(['Sign in']);
    expect(result.data.steps).toEqual(['Did click Sign in']);
    // The final call is not narrated as drafting: Stop reads "Finishing…".
    expect(s.of('record:drafting')).toHaveLength(0);
    expect(s.of('record:draft')).toHaveLength(0);
  }, 60_000);

  it('drops at Stop that touch the draft: one full redraft, not an append', async () => {
    const id = 'rec-stop-drop';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.draftThrough(1);
    await pageOf().click('#signin');
    await s.draftThrough(2);
    const before = ai.requests.length;
    await control(id, { action: 'stop', dropped: ['a2'] });
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(ai.requests).toHaveLength(before + 1);
    expect(draftOf(ai.requests[before]!)).toEqual([]);
    expect(result.data.steps).toEqual(['Did click Reports']);
  }, 60_000);

  it('an unreadable final answer ends the recording with an error, and nothing is inserted', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'rec-bad-json';
    const s = await started(id);
    await pageOf().click('#signin');
    await s.waitForCount('record:action', 1);
    ai.responses.push('Sure! Here are your steps: 1. Click Sign in');
    await control(id, { action: 'stop' });
    const out = await s.waitFor((f) => f.event === 'output' && f.data.kind === 'error', 'error output');
    expect(out.data.msg).toMatch(/^The steps could not be written: .*JSON.*\. Nothing was inserted\.$/);
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data.status).toBe('error');
    expect(done.data.error).toBe(out.data.msg);
    expect(s.frames.some((f) => f.event === 'record:result')).toBe(false);
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
  }, 60_000);

  it('with every action dropped: an empty result and no model call', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'rec-all-dropped';
    const s = await started(id);
    await pageOf().click('#signin');
    await s.waitForCount('record:action', 1);
    await control(id, { action: 'stop', dropped: ['a1'] });
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual([]);
    expect(result.data.notes[0]).toMatch(/Nothing was recorded/);
    expect(ai.requests).toHaveLength(0);
  }, 60_000);
});

describe('ending a recording without writing', () => {
  it('cancel during an in-flight draft call: aborted, the call abandoned, no draft after', async () => {
    const id = 'rec-cancel';
    const s = await started(id);
    let open!: () => void;
    ai.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    ai.openGate = open;
    await pageOf().click('#signin');
    await s.waitFor((f) => f.event === 'record:drafting' && f.data.busy === true, 'the call in flight');
    expect((await control(id, { action: 'cancel' })).status).toBe(202);
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'aborted' });
    expect(ai.aborted).toBe(1);
    open();
    await sleep(300);
    expect(s.of('record:draft')).toHaveLength(0);
    expect(s.frames.some((f) => f.event === 'record:writing' || f.event === 'record:result')).toBe(false);
    expect(ai.requests).toHaveLength(1);
  }, 60_000);

  it('closing the stream stops the recording and frees the session', async () => {
    const id = 'rec-close';
    const s = await started(id);
    s.abort();
    const until = Date.now() + 10_000;
    while (sessionManager.isRecordingSteps(id) && Date.now() < until) await sleep(25);
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
    expect((await control(id, { action: 'stop' })).status).toBe(404);
    expect(sessionManager.runsInFlight()).toBe(0);

    // The slot is free: the same session records again, in the same browser.
    const again = await started(id, recordBody({ config: undefined }));
    await control(id, { action: 'cancel' });
    await again.waitFor((f) => f.event === 'done', 'done');
    expect(launches.count).toBe(1);
  }, 60_000);
});

describe('the model', () => {
  it('each draft call runs with the AI switch lifted, and the veil goes back as it was', async () => {
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

    const s = await started(id, recordBody({ config: undefined }));
    await pageOf().click('#signin');
    await s.draftThrough(1);
    expect(client.aiPolicyAllowed).toBe(false);
    await control(id, { action: 'stop' });
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data.status).toBe('passed');
    expect(ai.policyAtCall).toEqual([true]);
    expect(client.aiPolicyAllowed).toBe(false);
  }, 60_000);

  it('a model that rejects images is asked again without them, warned once, and not sent them again', async () => {
    const rejection = Object.assign(new Error('400 this model does not accept images'), {
      code: 'image_input_unsupported',
    });
    ai.responses.push(rejection);
    const s = await started('rec-no-images');
    await pageOf().click('#signin');
    await s.draftThrough(1);
    await pageOf().click('#reports');
    await s.draftThrough(2);
    expect(ai.requests).toHaveLength(3);
    expect(imagesIn(ai.requests[0]!)).toBeGreaterThan(0);
    expect(imagesIn(ai.requests[1]!)).toBe(0);
    expect(imagesIn(ai.requests[2]!)).toBe(0);
    expect(s.of('output').filter((o) => o.kind === 'warn' && /images/.test(o.msg))).toHaveLength(1);
    await control('rec-no-images', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe('the session', () => {
  it('launches a browser only when the session has none', async () => {
    const id = 'rec-reuse';
    const one = await started(id);
    await pageOf().goto(`${origin}/other.html`);
    expect((await control(id, { action: 'cancel' })).status).toBe(202);
    await one.waitFor((f) => f.event === 'done', 'first done');
    expect(launches.count).toBe(1);

    // No `config` the second time: the session exists. It records from where
    // the browser IS, not from baseUrl.
    const two = await started(id, recordBody({ config: undefined }));
    expect(two.frames[0]!.data.url).toBe(`${origin}/other.html`);
    expect(launches.count).toBe(1);
    await control(id, { action: 'cancel' });
    await two.waitFor((f) => f.event === 'done', 'second done');
  }, 90_000);
});

describe('refusals', () => {
  it('400 on a headless server, with the reason', async () => {
    await restartApp({ headed: false });
    const res = await record('rec-headless', recordBody());
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(RECORD_STEPS_HEADLESS_MESSAGE);
    expect(launches.count).toBe(0);
  }, 30_000);

  it('400 when no model is configured — before any browser is launched (SPEC §8)', async () => {
    await restartApp({ apiKey: null });
    const res = await record('rec-no-model', recordBody());
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(RECORD_STEPS_NO_MODEL_MESSAGE);
    expect(launches.count).toBe(0);
    // An .env that brings a key is enough.
    const keyed = await started('rec-no-model', recordBody({ env: { AI_API_KEY: 'from-env' } }));
    await control('rec-no-model', { action: 'cancel' });
    await keyed.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('400 for `config` on a session that already has one — the steps route\'s rule', async () => {
    const id = 'rec-config';
    const one = await started(id);
    await control(id, { action: 'cancel' });
    await one.waitFor((f) => f.event === 'done', 'done');

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
    const one = await started(id);

    const second = await record(id, recordBody({ config: undefined }));
    expect(second.status).toBe(409);

    // The documented choice: a run is refused, not queued behind the recording.
    const steps = await post(`/sessions/${id}/steps?stream=1`, { steps: ['Click Sign in'], testFilePath });
    expect(steps.status).toBe(409);
    expect(steps.json.error).toMatch(/Record Steps recording is running/);

    await control(id, { action: 'cancel' });
    await one.waitFor((f) => f.event === 'done', 'done');
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
    while (ai.requests.length === 0 && Date.now() < until) await sleep(25);
    expect(ai.requests.length).toBe(1);

    const refused = await record(id, recordBody({ config: undefined }));
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe(RECORD_STEPS_RUN_EXECUTING_MESSAGE);

    ai.gate = null;
    open();
    await run;
  }, 90_000);
});

describe('POST /sessions/:id/record-steps/control', () => {
  it('404 when no recording is running; 400 on an unknown action, a bad dropped list, or a drop with no id', async () => {
    expect((await control('nobody', { action: 'stop' })).status).toBe(404);
    expect((await control('nobody', { action: 'rewind' })).status).toBe(400);
    // Pause is an action now (stories/testbench-record-toolbar.md): no recording, 404.
    expect((await control('nobody', { action: 'pause' })).status).toBe(404);
    expect((await control('nobody', { action: 'stop', dropped: [1, 2] })).status).toBe(400);
    expect((await control('nobody', { action: 'drop' })).status).toBe(400);
    expect((await control('nobody', { action: 'restore', id: '' })).status).toBe(400);
  });
});

// ── The fix round (review of the server half) ─────────────────────────────

const SESSION_CLOSED = 'The session was closed while recording.';

/** Hold every model call at its start until the returned opener is called. */
function holdCalls(): () => void {
  let open!: () => void;
  ai.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  ai.openGate = open;
  return open;
}

async function callInFlight(): Promise<void> {
  const until = Date.now() + 10_000;
  while (ai.inFlight === 0 && Date.now() < until) await sleep(25);
  expect(ai.inFlight).toBe(1);
}

function closeSession(id: string): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
}

describe('Cancel wins until the result is out (review, finding 2)', () => {
  it('Cancel after Stop, while the final call runs: no result, done aborted, the call abandoned', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'rec-cancel-finishing';
    const s = await started(id);
    await pageOf().click('#signin');
    await s.waitForCount('record:action', 1);
    const open = holdCalls();
    expect((await control(id, { action: 'stop' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:writing', 'record:writing');
    await callInFlight();

    expect((await control(id, { action: 'cancel' })).status).toBe(202);
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'aborted' });
    expect(ai.aborted).toBe(1);
    open();
    await sleep(300);
    expect(s.of('record:result')).toHaveLength(0);
    expect(ai.requests).toHaveLength(1);
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
  }, 60_000);

  it('a session closed under a recording ends it aborted, saying why', async () => {
    const id = 'rec-closed';
    const s = await started(id);
    await pageOf().click('#signin');
    await s.waitForCount('record:action', 1);
    expect((await closeSession(id)).status).toBe(200);
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'aborted', error: SESSION_CLOSED });
    expect(s.of('record:result')).toHaveLength(0);
  }, 60_000);

  it('... and one closed while the final draft is being written, the same way', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'rec-closed-finishing';
    const s = await started(id);
    await pageOf().click('#signin');
    await s.waitForCount('record:action', 1);
    const open = holdCalls();
    await control(id, { action: 'stop' });
    await s.waitFor((f) => f.event === 'record:writing', 'record:writing');
    await callInFlight();

    const closing = closeSession(id);
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'aborted', error: SESSION_CLOSED });
    expect(ai.aborted).toBe(1);
    open();
    expect((await closing).status).toBe(200);
    await sleep(300);
    expect(s.of('record:result')).toHaveLength(0);
  }, 60_000);
});

describe("secrets from the request's .env (review, finding 7)", () => {
  it('a value typed from .env is withheld from the panel and the model — through a $VAR parameter, and by key name', async () => {
    const id = 'rec-env-secrets';
    const s = await started(id, recordBody({ env: { PASSWORD: 'pw-from-env-77', STRIPE_API_KEY: 'sk-env-SECRET-42' } }));
    // The file says `- password: $PASSWORD`; the field is only an email box.
    await pageOf().fill('#email', 'pw-from-env-77');
    await pageOf().click('#signin');
    await s.draftThrough(2);
    await pageOf().fill('#email', 'Bearer sk-env-SECRET-42');
    await pageOf().click('#reports');
    await s.draftThrough(4);

    const everything = JSON.stringify([s.frames, ai.requests]);
    expect(everything).not.toContain('pw-from-env-77');
    expect(everything).not.toContain('sk-env-SECRET-42');
    const first = recordingOf(ai.requests[0]!);
    expect(first[0]).toMatchObject({ kind: 'type', secret: true, knownSecret: 'password' });
    const second = recordingOf(ai.requests[1]!);
    // A value that CONTAINS a known secret is withheld whole (review 2,
    // finding 2) — not spliced into "Bearer ***", a parameter holding a mask.
    expect(second[0]).toMatchObject({ kind: 'type', secret: true });
    expect(second[0]!['value']).toBeUndefined();
    expect(second[0]!['knownSecret']).toBeUndefined();
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe('a browser opened headless (review, finding 12)', () => {
  it('is refused though the server is headed — on the stream when the recording launches it, then with a 400', async () => {
    launches.headed = false;
    const id = 'rec-headless-browser';
    const r = await record(id, recordBody());
    expect(r.status).toBe(200);
    const done = await r.stream!.waitFor((f) => f.event === 'done', 'done');
    expect(done.data.status).toBe('error');
    expect(done.data.error).toMatch(/opened headless/);
    expect(r.stream!.of('record:started')).toHaveLength(0);

    // The session now HAS that browser: refused before any stream opens.
    const again = await record(id, recordBody({ config: undefined }));
    expect(again.status).toBe(400);
    expect(again.json.error).toMatch(/opened headless/);
  }, 60_000);
});

describe("the log bridge (review, finding 15)", () => {
  it("forwards this recording's warnings masked, and not another session's", async () => {
    const id = 'rec-log-bridge';
    const s = await started(id, recordBody({ env: { STRIPE_API_KEY: 'sk-env-SECRET-42' } }));
    const previous = getLogLevel();
    setLogLevel('warn');
    try {
      logger.warn('Session "someone-else": a warning of theirs');
      logger.warn(`Session "${id}": upstream answered with sk-env-SECRET-42`);
      logger.warn('A warning that names no session, holding sk-env-SECRET-42');
      await sleep(100);
    } finally {
      setLogLevel(previous);
    }
    const warns = s.of('output').filter((o) => o.kind === 'warn').map((o) => o.msg as string);
    expect(warns.some((m) => m.includes('someone-else'))).toBe(false);
    expect(warns).toContain(`Session "${id}": upstream answered with ***`);
    expect(warns).toContain('A warning that names no session, holding ***');
    expect(JSON.stringify(s.frames)).not.toContain('sk-env-SECRET-42');
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe('the log lines a recording writes (review 2, finding 10)', () => {
  it("are masked with the recording's secrets — the address it started on included", async () => {
    const lines: string[] = [];
    const remove = addLogCallback((_level, message) => lines.push(message));
    try {
      const id = 'rec-log-mask';
      const s = await started(
        id,
        recordBody({
          config: { baseUrl: `${origin}/form.html?token=tok-START-SECRET-9` },
          env: { API_TOKEN: 'tok-START-SECRET-9' },
        }),
      );
      expect(s.of('record:started')[0].url).toContain('token=***');
      await control(id, { action: 'cancel' });
      await s.waitFor((f) => f.event === 'done', 'done');
    } finally {
      remove();
    }
    const startedOn = lines.filter((l) => l.includes('Record Steps started on'));
    expect(startedOn).toHaveLength(1);
    expect(startedOn[0]).toContain('token=***');
    expect(lines.filter((l) => l.includes('Record Steps') || l.includes('record-steps')).join('\n')).not.toContain(
      'tok-START-SECRET-9',
    );
  }, 60_000);
});

// ── Controls in the browser (stories/testbench-record-toolbar.md) ─────────

async function toolbarShows(page: Page, words: string, timeoutMs = 8_000): Promise<string> {
  const seen = await until(
    () => readToolbar(page),
    (t) => t !== null && (t.sub.includes(words) || t.all.includes(words)),
    `the toolbar to show "${words}"`,
    timeoutMs,
  );
  return seen!.all;
}

describe('the browser toolbar — on the wire', () => {
  it('is in the page by default, honours dock and minimised from the start body, and says when it moves; none with enabled false', async () => {
    const s = await started('tb-default', recordBody({ toolbar: { enabled: true, dock: 'tl', minimised: true } }));
    const page = pageOf();
    const bar = await until(() => readToolbar(page), (t) => t !== null && t.minimised, 'the pill');
    expect(bar!.shadowType).toBe('closed');
    const box = await page.evaluate(() => {
      const r = document.querySelector('aiui-recorder')!.getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
    expect(box.x).toBeLessThan(40);
    expect(box.y).toBeLessThan(40);
    // Opening it from the pill: TestBench is told, so it can remember.
    await clickToolbar(page, 'expand');
    const moved = await s.waitFor((f) => f.event === 'record:toolbar', 'record:toolbar');
    expect(moved.data).toEqual({ type: 'record:toolbar', dock: 'tl', minimised: false });
    await control('tb-default', { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');

    const off = await started('tb-off', recordBody({ toolbar: { enabled: false } }));
    await pageOf(1).goto(`${origin}/other.html`);
    await sleep(400);
    expect(await pageOf(1).evaluate(() => document.querySelector('aiui-recorder') === null)).toBe(true);
    await pageOf(1).click('h1');
    await off.waitForCount('record:action', 1);
    await control('tb-off', { action: 'cancel' });
    await off.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('Pause and Resume from the toolbar: record:paused, nothing recorded and no draft call while paused, the waiting action drafted on Resume', async () => {
    await restartApp({ draftSettleMs: 700 });
    const id = 'tb-pause';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.waitForCount('record:action', 1);
    await page.keyboard.press('Alt+Shift+P');
    const paused = await s.waitFor((f) => f.event === 'record:paused', 'record:paused');
    expect(paused.data).toMatchObject({ type: 'record:paused', paused: true, source: 'toolbar' });
    await toolbarShows(page, 'Paused. Nothing you do is recorded.');
    // Nothing is recorded, and the call the settle window had queued waits.
    await page.click('#signin');
    await page.fill('#email', 'while@paused.test');
    await page.goto(`${origin}/other.html`);
    await page.goBack();
    await sleep(1_500);
    expect(s.of('record:action')).toHaveLength(1);
    expect(ai.requests).toHaveLength(0);

    await page.keyboard.press('Alt+Shift+P');
    await s.waitForCount('record:paused', 2);
    expect(s.of('record:paused')[1]).toMatchObject({ paused: false, source: 'toolbar' });
    // Resumed: the action that waited is drafted…
    await s.draftThrough(1);
    expect(ai.requests).toHaveLength(1);
    // …and the first action after the pause says so to the model.
    await page.click('#signin');
    await s.draftThrough(2);
    expect(recordingOf(ai.requests[1]!)[0]).toMatchObject({ kind: 'click', afterPause: true });
    expect(JSON.stringify([s.frames, ai.requests])).not.toContain('while@paused.test');
    // The model is told what a pause means.
    expect(textOf(ai.requests[1]!)).toContain('I9. An action marked afterPause');
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('pause and resume from the panel; a second pause, a resume while recording, or Add check while paused do nothing, and say so', async () => {
    const id = 'tb-panel-pause';
    const s = await started(id);
    expect((await control(id, { action: 'pause' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:paused', 'record:paused');
    expect(s.of('record:paused')[0]).toMatchObject({ paused: true, source: 'panel' });
    expect((await control(id, { action: 'pause' })).json.ignored).toMatch(/already paused/);
    expect((await control(id, { action: 'check' })).json.ignored).toMatch(/resume it to add a check/);
    await toolbarShows(pageOf(), 'Paused. Nothing you do is recorded.');
    expect((await control(id, { action: 'resume' })).status).toBe(202);
    await s.waitForCount('record:paused', 2);
    expect((await control(id, { action: 'resume' })).json.ignored).toMatch(/not paused/);
    expect(s.of('record:pick')).toEqual([]);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('Add step from the toolbar: the draft is caught up in one call, the line goes in exactly as typed and locks the steps above it', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'tb-add-step';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await page.click('#signin');
    await s.waitForCount('record:action', 2);
    expect(ai.requests).toHaveLength(0);

    await page.keyboard.press('Alt+Shift+S');
    await toolbarShows(page, 'Enter to add');
    await page.keyboard.type('8. Verify the balance shows "$1,234.56"');
    await page.keyboard.press('Enter');
    const step = await s.waitFor((f) => f.event === 'record:step', 'record:step');
    expect(step.data).toMatchObject({
      type: 'record:step',
      id: 's1',
      // Exactly as typed: only the leading "8." is the recording's to replace.
      text: 'Verify the balance shows "$1,234.56"',
      source: 'toolbar',
      afterStep: 1,
    });
    // One catch-up call, over the two actions waiting, BEFORE the step.
    expect(ai.requests).toHaveLength(1);
    expect(recordingOf(ai.requests[0]!).map((a) => a['target'].name)).toEqual(['Reports', 'Sign in']);
    const withStep = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.authored?.length === 1,
      'the draft with the step',
    );
    expect(withStep.data).toMatchObject({
      steps: ['Did click Reports', 'Did click Sign in', 'Verify the balance shows "$1,234.56"'],
      locked: 3,
      authored: [2],
      authoredIds: ['s1'],
    });
    // record:step arrives before the draft that holds it.
    const at = (pred: (f: Frame) => boolean): number => s.frames.findIndex(pred);
    expect(at((f) => f.event === 'record:step')).toBeLessThan(at((f) => f === withStep));
    // Nothing is locked against the author (stories/testbench-record-edit-steps.md): no "locked" on the bar.
    await toolbarShows(page, 'Added as step 3');
    expect((await readToolbar(page))!.all).not.toContain('locked');

    // The next call is shown the locks and the author's step, and the rules for them.
    await page.check('#cash');
    await s.waitForCount('record:action', 4);
    expect((await control(id, { action: 'stop' })).status).toBe(202);
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(ai.requests).toHaveLength(2);
    const prompt = textOf(ai.requests[1]!);
    expect(prompt).toContain('Steps 0 to 2 are LOCKED');
    expect(prompt).toContain('Steps marked "author": true were written by hand by the author');
    expect(prompt).toContain('the furthest back you may start is 3');
    expect(prompt).toContain('A2. A step marked "author" was written by hand');
    expect(prompt).toContain('A3. Never write a Verify that repeats one of the author');
    expect(draftEntriesOf(ai.requests[1]!)[2]).toEqual({
      index: 2,
      step: 'Verify the balance shows "$1,234.56"',
      locked: true,
      author: true,
    });
    expect(result.data.steps).toEqual([
      'Did click Reports',
      'Did click Sign in',
      'Verify the balance shows "$1,234.56"',
      'Did click Cash',
      'Did tick Cash',
    ]);
    await s.waitFor((f) => f.event === 'done', 'done');
    await toolbarShows(page, 'Done · 5 steps written to pay-by-cash.md');
  }, 60_000);

  it('a replaceFrom that reaches into a lock is refused, and retried once as a redraft of the open steps only', async () => {
    ai.responder = (messages, call) =>
      call === 2 ? JSON.stringify({ replaceFrom: 0, steps: ['Rewrote everything'], parameters: [] }) : echo(messages);
    const id = 'tb-lock-refused';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.draftThrough(1);
    expect((await control(id, { action: 'add-step', text: 'Verify the page says "Sign in"', source: 'panel' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:draft' && f.data.locked === 2, 'the locked draft');
    expect(ai.requests).toHaveLength(1); // nothing to catch up
    await pageOf().click('#signin');
    const redrafted = await s.draftThrough(2);
    expect(ai.requests).toHaveLength(3);
    // The retry: the locked steps as they are, and where the open steps go.
    const retry = ai.requests[2]!;
    expect(textOf(retry)).toContain('answer with replaceFrom 2');
    expect(draftEntriesOf(retry)).toEqual([
      { index: 0, step: 'Did click Reports', locked: true, actions: [1] },
      { index: 1, step: 'Verify the page says "Sign in"', locked: true, author: true },
      { yourStepsGoHere: true },
    ]);
    expect(recordingOf(retry).map((a) => a['target'].name)).toEqual(['Sign in']);
    expect(redrafted.data).toMatchObject({
      steps: ['Did click Reports', 'Verify the page says "Sign in"', 'Did click Sign in'],
      locked: 2,
      authored: [1],
    });
    expect(s.of('record:draft').some((d) => d.steps.includes('Rewrote everything'))).toBe(false);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('Add step from the editor between two recorded steps: everything so far locked on both sides, and undrafted actions go after the block', async () => {
    ai.responder = (messages, call) => (call === 3 ? new Error('scripted: this call fails') : echo(messages));
    const id = 'tb-editor-step';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.draftThrough(1);
    await pageOf().click('#signin');
    const two = await s.draftThrough(2);
    // An action the draft does not cover yet: its call fails.
    await pageOf().click('#email');
    await s.waitFor((f) => f.event === 'output' && f.data.kind === 'warn', 'the failed call');
    const r = await control(id, {
      action: 'add-step',
      text: 'Wait for the sign-in form',
      source: 'editor',
      afterStep: 0,
      revision: two.data.revision,
    });
    expect(r.status).toBe(202);
    const step = await s.waitFor((f) => f.event === 'record:step', 'record:step');
    expect(step.data).toMatchObject({ id: 's1', source: 'editor', afterStep: 0, text: 'Wait for the sign-in form' });
    const locked = await s.waitFor((f) => f.event === 'record:draft' && f.data.authored?.length === 1, 'the draft with it');
    expect(locked.data).toMatchObject({
      steps: ['Did click Reports', 'Wait for the sign-in form', 'Did click Sign in'],
      locked: 3,
      authored: [1],
    });
    // No catch-up for a step between two recorded ones.
    expect(ai.requests).toHaveLength(3);
    // The next action: the one left undrafted goes after the whole block, with it.
    await pageOf().click('#reports');
    const after = await s.draftThrough(4);
    expect(recordingOf(ai.requests[3]!).map((a) => a['target'].name)).toEqual(['Email', 'Reports']);
    expect(after.data.steps).toEqual([
      'Did click Reports',
      'Wait for the sign-in form',
      'Did click Sign in',
      'Did click Email',
      'Did click Reports',
    ]);
    expect(after.data.locked).toBe(3);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('Undo and Restore from the toolbar; an author step undone and restored as it was', async () => {
    const id = 'tb-undo';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await page.click('#signin');
    await s.draftThrough(2);
    const calls = ai.requests.length;

    // Undo: the most recent entry, struck through for the panel, redrafted without it.
    await page.keyboard.press('Alt+Shift+Z');
    const dropped = await s.waitFor((f) => f.event === 'record:dropped', 'record:dropped');
    expect(dropped.data).toEqual({ type: 'record:dropped', id: 'a2', dropped: true, source: 'toolbar' });
    await toolbarShows(page, 'Removed: Clicked button "Sign in"');
    const without = await s.waitFor((f) => f.event === 'record:draft' && f.data.steps.length === 1, 'the redraft without a2');
    expect(ai.requests).toHaveLength(calls + 1);
    // Restore puts it back.
    await clickToolbar(page, 'restore');
    await s.waitForCount('record:dropped', 2);
    expect(s.of('record:dropped')[1]).toEqual({ type: 'record:dropped', id: 'a2', dropped: false, source: 'toolbar' });
    await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.steps.length === 2 && f.data.revision > without.data.revision,
      'the redraft with a2',
    );

    // A step of the author's, then Undo straight away: out, and the lock lifted.
    await page.keyboard.press('Alt+Shift+S');
    await toolbarShows(page, 'Enter to add');
    await page.keyboard.type('Verify the Sign in button is shown');
    await page.keyboard.press('Enter');
    const lockedDraft = await s.waitFor((f) => f.event === 'record:draft' && f.data.locked === 3, 'locked');
    const before = ai.requests.length;
    await page.keyboard.press('Alt+Shift+Z');
    await s.waitForCount('record:dropped', 3);
    expect(s.of('record:dropped')[2]).toMatchObject({ id: 's1', dropped: true, source: 'toolbar' });
    const unlocked = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.locked === 0 && f.data.revision > lockedDraft.data.revision,
      'unlocked',
    );
    expect(unlocked.data).toMatchObject({ steps: ['Did click Reports', 'Did click Sign in'], authored: [] });
    await toolbarShows(page, 'Removed your step: Verify the Sign in button is shown');
    // Restore: back exactly as it was — no call needed.
    await clickToolbar(page, 'restore');
    const relocked = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.locked === 3 && f.data.revision > unlocked.data.revision,
      'relocked',
    );
    expect(relocked.data).toMatchObject({
      steps: ['Did click Reports', 'Did click Sign in', 'Verify the Sign in button is shown'],
      authored: [2],
    });
    await sleep(300);
    expect(ai.requests).toHaveLength(before);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('dropping an action inside a locked stretch redrafts only that stretch; dropping the author step lifts its lock', async () => {
    const id = 'tb-stretch';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await page.click('#signin');
    await s.draftThrough(2);
    expect((await control(id, { action: 'add-step', text: 'Check the form', source: 'panel' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:draft' && f.data.locked === 3, 'locked');
    await page.click('#email');
    await s.draftThrough(3);
    const calls = ai.requests.length;

    // a1 is inside the locked stretch: that stretch alone is redrafted.
    expect((await control(id, { action: 'drop', id: 'a1' })).status).toBe(202);
    const stretch = await s.waitFor(
      (f) => f.event === 'record:draft' && !f.data.steps.includes('Did click Reports'),
      'the stretch redrafted',
    );
    expect(ai.requests).toHaveLength(calls + 1);
    const call = ai.requests[calls]!;
    expect(recordingOf(call).map((a) => a['target'].name)).toEqual(['Sign in']);
    expect(draftEntriesOf(call)).toEqual([
      { yourStepsGoHere: true },
      { index: 0, step: 'Check the form', locked: true, author: true },
      { index: 1, step: 'Did click Email', actions: [2] },
    ]);
    expect(stretch.data).toMatchObject({
      steps: ['Did click Sign in', 'Check the form', 'Did click Email'],
      locked: 2,
      authored: [1],
    });
    // The panel's drop is the panel's own: no record:dropped for it.
    expect(s.of('record:dropped')).toEqual([]);

    // Dropping the author's step lifts its lock; what the model wrote after it
    // is redrafted with the steps before it, as if it had never been added.
    expect((await control(id, { action: 'drop', id: 's1' })).status).toBe(202);
    const lifted = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision > stretch.data.revision,
      'the lock lifted',
    );
    // At once, before any call: the line is out and nothing is locked.
    expect(lifted.data).toMatchObject({
      steps: ['Did click Sign in', 'Did click Email'],
      locked: 0,
      authored: [],
    });
    const redraft = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision > lifted.data.revision,
      'the redraft over both sides',
    );
    expect(redraft.data.steps).toEqual(['Did click Sign in', 'Did click Email']);
    expect(recordingOf(ai.requests[ai.requests.length - 1]!).map((a) => a['target'].name)).toEqual(['Sign in', 'Email']);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('Cancel from the toolbar asks first; Discard ends done aborted cancelledBy browser, with no model call', async () => {
    const id = 'tb-cancel';
    const s = await started(id);
    const page = pageOf();
    await until(() => readToolbar(page), (t) => t !== null, 'the toolbar');
    await clickToolbar(page, 'cancel');
    await toolbarShows(page, "Discard this recording? The steps won't be written.");
    await clickToolbar(page, 'keep');
    await until(() => readToolbar(page), (t) => t !== null && !t.sub.includes('Discard'), 'kept');
    expect(s.of('done')).toEqual([]);
    await clickToolbar(page, 'cancel');
    await toolbarShows(page, 'Discard this recording?');
    await clickToolbar(page, 'discard');
    const done = await s.waitFor((f) => f.event === 'done', 'done');
    expect(done.data).toEqual({ type: 'done', status: 'aborted', cancelledBy: 'browser' });
    expect(ai.requests).toHaveLength(0);
    expect(s.of('record:writing')).toEqual([]);
    await toolbarShows(page, 'Recording cancelled. Nothing was written.');
    expect(sessionManager.isRecordingSteps(id)).toBe(false);
  }, 60_000);

  it('Stop from the toolbar writes the steps: record:writing, record:result, done', async () => {
    const id = 'tb-stop';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await clickToolbar(page, 'stop');
    await s.waitFor((f) => f.event === 'record:writing', 'record:writing');
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Did click Reports']);
    expect((await s.waitFor((f) => f.event === 'done', 'done')).data).toEqual({ type: 'done', status: 'passed' });
    await toolbarShows(page, 'Done · 1 step written to pay-by-cash.md');
  }, 60_000);

  it('a recording ended elsewhere says why in the page', async () => {
    const id = 'tb-ended';
    const s = await started(id);
    const page = pageOf();
    await until(() => readToolbar(page), (t) => t !== null, 'the toolbar');
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
    expect(s.of('done')[0]).toEqual({ type: 'done', status: 'aborted' });
    await toolbarShows(page, 'Recording ended: it was cancelled in VS Code. Nothing was written.');
  }, 60_000);

  it('400 for a bad toolbar in the start body, and for an add-step without text or a source it knows', async () => {
    const badToolbar = await record('tb-bad', recordBody({ toolbar: { dock: 'tl' } }));
    expect(badToolbar.status).toBe(400);
    expect(badToolbar.json.error).toMatch(/toolbar.enabled/);
    expect((await record('tb-bad', recordBody({ toolbar: { enabled: true, dock: 'middle' } }))).status).toBe(400);
    expect((await control('nobody', { action: 'add-step', source: 'editor' })).status).toBe(400);
    expect((await control('nobody', { action: 'add-step', text: 'x', source: 'toolbar' })).status).toBe(400);
    expect((await control('nobody', { action: 'add-step', text: 'x', source: 'editor', afterStep: -1 })).status).toBe(400);
    expect((await control('nobody', { action: 'add-step', text: 'x', source: 'panel' })).status).toBe(404);
    // A running recording answers a blank add-step with "ignored".
    const id = 'tb-blank';
    const s = await started(id);
    const blank = await control(id, { action: 'add-step', text: '  \n\n', source: 'panel' });
    expect(blank).toMatchObject({ status: 202, json: { ok: true } });
    expect(blank.json.ignored).toMatch(/every line is blank/);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

// ── The fix round (review of the toolbar's server half) ───────────────────

/** Every spelling a value could leak in: as is, inside JSON, inside HTML. */
function spellings(value: string): string[] {
  const html = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [...new Set([value, JSON.stringify(value).slice(1, -1), JSON.stringify(JSON.stringify(value)).slice(1, -1), html])];
}

describe('what is accepted before Stop is carried out (finding 1)', () => {
  it('a step accepted while the one before it waits for its catch-up is written; one sent after Stop is refused, and says so', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'fix-before-stop';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.waitForCount('record:action', 1);
    const open = holdCalls();
    expect((await control(id, { action: 'add-step', text: 'Verify A', source: 'panel' })).json).toEqual({ ok: true });
    await callInFlight(); // A's catch-up, held
    expect((await control(id, { action: 'add-step', text: 'Verify B', source: 'panel' })).json).toEqual({ ok: true });
    expect((await control(id, { action: 'stop' })).json).toEqual({ ok: true });
    const late = await control(id, { action: 'add-step', text: 'Verify C', source: 'panel' });
    expect(late.json.ignored).toMatch(/already been stopped/);
    open();
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Did click Reports', 'Verify A', 'Verify B']);
    expect(s.of('record:step').map((f) => f.text)).toEqual(['Verify A', 'Verify B']);
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('from the toolbar: a step entered just before Stop is written; one entered after it is not, and the author is told', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'fix-before-stop-toolbar';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.waitForCount('record:action', 1);
    const open = holdCalls();
    expect((await control(id, { action: 'add-step', text: 'Verify A', source: 'panel' })).status).toBe(202);
    await callInFlight();
    await page.keyboard.press('Alt+Shift+S');
    await toolbarShows(page, 'Enter to add');
    await page.keyboard.type('Verify B');
    await page.keyboard.press('Enter');
    await clickToolbar(page, 'stop');
    // Stop is in; the bar has not been told yet. A step now is too late.
    await sleep(300);
    await page.keyboard.press('Alt+Shift+S');
    await toolbarShows(page, 'Enter to add');
    await page.keyboard.type('Verify C');
    await page.keyboard.press('Enter');
    await sleep(300);
    open();
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Did click Reports', 'Verify A', 'Verify B']);
    expect(s.of('record:step').map((f) => f.text)).toEqual(['Verify A', 'Verify B']);
    const warned = s.of('output').filter((o) => o.kind === 'warn').map((o) => o.msg as string);
    expect(warned).toEqual([
      'A step typed in the browser after Stop was not added to the recording: "Verify C". Add it to the test by hand.',
    ]);
    await s.waitFor((f) => f.event === 'done', 'done');
    await toolbarShows(page, 'Done · 3 steps written to pay-by-cash.md');
    expect((await readToolbar(page))!.sub).toContain('not added');
  }, 60_000);
});

describe('the step box while "Adding…" (finding 3)', () => {
  it('reopened, it is empty: the step just sent is not offered again', async () => {
    await restartApp({ draftSettleMs: NEVER_SETTLES_MS });
    const id = 'fix-box-text';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.waitForCount('record:action', 1);
    const open = holdCalls();
    await page.keyboard.press('Alt+Shift+S');
    await toolbarShows(page, 'Enter to add');
    await page.keyboard.type('Verify the balance');
    await sleep(700); // the box's unsent text reaches the server
    await page.keyboard.press('Enter');
    await callInFlight();
    await toolbarShows(page, 'Adding…');
    await page.keyboard.press('Alt+Shift+S');
    await toolbarShows(page, 'Enter to add');
    expect(await stepBoxValue(page)).toBe('');
    await page.keyboard.press('Escape');
    open();
    await s.waitFor((f) => f.event === 'record:step', 'record:step');
    await sleep(300);
    expect(s.of('record:step')).toHaveLength(1);
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe("a secret in a step of the author's (finding 5)", () => {
  const PW = 'pw-from-env-77';
  const KEY = 'sk-env<&"SECRET>-42';

  it('is written as {{name}} with its .env reference — from the panel and the toolbar — and never crosses in clear; from the editor it is refused', async () => {
    const lines: string[] = [];
    const remove = addLogCallback((_level, message) => lines.push(message));
    try {
      const id = 'fix-author-secret';
      const s = await started(id, recordBody({ env: { PASSWORD: PW, STRIPE_API_KEY: KEY } }));
      const page = pageOf();
      expect(
        (await control(id, { action: 'add-step', text: `Type ${PW} into the Password field`, source: 'panel' })).json,
      ).toEqual({ ok: true });
      await s.waitForCount('record:step', 1);
      expect(s.of('record:step')[0].text).toBe('Type {{password}} into the Password field');
      await page.keyboard.press('Alt+Shift+S');
      await toolbarShows(page, 'Enter to add');
      await page.keyboard.type(`Verify the key reads ${KEY}`);
      await page.keyboard.press('Enter');
      await s.waitForCount('record:step', 2);
      // A line typed in the file is the author's own text: refused, and why.
      const editor = await control(id, { action: 'add-step', text: `Type ${PW} again`, source: 'editor' });
      expect(editor.status).toBe(202);
      expect(editor.json).toMatchObject({ ok: true, ignored: expect.stringContaining('{{password}}') });
      await page.click('#signin');
      await s.waitForCount('record:action', 1);
      await control(id, { action: 'stop' });
      const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
      await s.waitFor((f) => f.event === 'done', 'done');

      const written = ['Type {{password}} into the Password field', 'Verify the key reads {{STRIPE_API_KEY}}'];
      expect(s.of('record:step').map((f) => f.text)).toEqual(written);
      expect(result.data.steps).toEqual([...written, 'Did click Sign in']);
      // A name the file has no parameter for gets one reading the .env; the
      // file's own `- password: $PASSWORD` already defines {{password}}.
      expect(result.data.parameters).toEqual([{ name: 'STRIPE_API_KEY', value: '$STRIPE_API_KEY' }]);
      expect(JSON.stringify(result.data.notes ?? [])).not.toContain('no parameter defines');
      const everything = JSON.stringify([s.frames, ai.requests, lines]);
      for (const secret of [PW, KEY]) {
        for (const spelling of spellings(secret)) expect(everything).not.toContain(spelling);
      }
    } finally {
      remove();
    }
  }, 60_000);
});

describe('a run after the recording (finding 6)', () => {
  it("the Done bar is gone before the run's first step: the model never sees it", async () => {
    const id = 'fix-done-bar-run';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await control(id, { action: 'stop' });
    await s.waitFor((f) => f.event === 'done', 'done');
    const doneAt = Date.now();
    await toolbarShows(page, 'Done · 1 step written');
    ai.responder = () => new Error('scripted: no model for this run');
    const open = holdCalls();
    const run = post(`/sessions/${id}/steps`, { steps: ['Click the Sign in button'], testFilePath });
    await callInFlight();
    expect(Date.now() - doneAt).toBeLessThan(5_000); // not the bar's own six seconds
    expect(await page.evaluate(() => document.querySelector('aiui-recorder') === null)).toBe(true);
    open();
    await run;
  }, 60_000);
});

// ── Editing and deleting steps (stories/testbench-record-edit-steps.md) ────

/** The model, saying which actions each step stands for: one step per
 *  ACTION, the events before it riding along, `stepActions` beside them. */
function echoMapped(messages: ChatMessage[]): string {
  const draft = draftOf(messages);
  const insert = /answer with replaceFrom (\d+)/.exec(textOf(messages));
  const steps: string[] = [];
  const stepActions: number[][] = [];
  let pending: number[] = [];
  for (const a of recordingOf(messages)) {
    pending.push(a['n'] as number);
    if (['type', 'select', 'tick', 'untick', 'upload', 'tab'].includes(a['kind'] as string)) continue;
    steps.push(`Did ${a['kind']} ${a['target']?.name ?? a['target']?.text ?? ''}`.trim());
    stepActions.push(pending);
    pending = [];
  }
  if (pending.length > 0 && stepActions.length > 0) stepActions[stepActions.length - 1]!.push(...pending);
  return JSON.stringify({ replaceFrom: insert ? Number(insert[1]) : draft.length, steps, stepActions, parameters: [] });
}

/** Frames of one type from index `from` on. */
function framesAfter(s: Stream, from: number): Frame[] {
  return s.frames.slice(from);
}

describe('edit-step, and drop / restore of a step, through the control route', () => {
  it('an edit is the author\'s at once — record:edited, then the draft, same id, no call; the next call is shown it; Stop writes it', async () => {
    ai.responder = (m) => echoMapped(m);
    const id = 'edit-route';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.draftThrough(1);
    await pageOf().click('#signin');
    const two = await s.draftThrough(2);
    expect(two.data.steps).toEqual(['Did click Reports', 'Did click Sign in']);
    expect(two.data.ids).toEqual(['d1', 'd2']);
    expect(two.data.edited).toEqual([]);
    const calls = ai.requests.length;
    const mark = s.frames.length;
    const r = await control(id, {
      action: 'edit-step',
      id: 'd1',
      text: '1. Open Reports from the main menu',
      source: 'editor',
      revision: two.data.revision,
    });
    expect(r).toEqual({ status: 202, json: { ok: true } });
    const edited = await s.waitFor((f) => f.event === 'record:edited', 'record:edited');
    expect(edited.data).toEqual({ type: 'record:edited', id: 'd1', text: 'Open Reports from the main menu', source: 'editor' });
    const after = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision > two.data.revision,
      'the draft with the edit',
    );
    expect(after.data).toMatchObject({
      steps: ['Open Reports from the main menu', 'Did click Sign in'],
      ids: ['d1', 'd2'],
      edited: [0],
      authored: [],
    });
    const order = framesAfter(s, mark).map((f) => f.event);
    expect(order.indexOf('record:edited')).toBeLessThan(order.indexOf('record:draft'));
    await sleep(300);
    expect(ai.requests).toHaveLength(calls);

    await pageOf().click('#email');
    await s.draftThrough(3);
    const next = ai.requests[calls]!;
    expect(draftEntriesOf(next)[0]).toEqual({ index: 0, step: 'Open Reports from the main menu', edited: true, actions: [1] });
    expect(recordingOf(next).map((a) => a['target'].name)).toEqual(['Email']);
    expect(textOf(next)).toContain('A4. A step marked "edited"');
    await control(id, { action: 'stop' });
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Open Reports from the main menu', 'Did click Sign in', 'Did click Email']);
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('drop of a step id deletes it and the actions behind it — record:dropped with them, before the draft, no call; restore puts both back', async () => {
    ai.responder = (m) => echoMapped(m);
    const id = 'delete-route';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await page.fill('#email', 'someone@example.test');
    await page.click('#signin');
    const two = await s.draftThrough(3);
    expect(two.data.steps).toEqual(['Did click Reports', 'Did click Sign in']);
    const behind = s.of('record:action').slice(1).map((a) => a.id);
    expect(behind).toHaveLength(2); // the typing, and the click it rode with
    const calls = ai.requests.length;
    const mark = s.frames.length;
    expect((await control(id, { action: 'drop', id: 'd2', source: 'editor' })).json).toEqual({ ok: true });
    const dropped = await s.waitFor((f) => f.event === 'record:dropped', 'record:dropped');
    expect(dropped.data).toEqual({ type: 'record:dropped', id: 'd2', dropped: true, source: 'editor', actions: behind });
    const without = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision > two.data.revision,
      'the draft without it',
    );
    expect(without.data).toMatchObject({ steps: ['Did click Reports'], ids: ['d1'] });
    const order = framesAfter(s, mark).map((f) => f.event);
    expect(order.indexOf('record:dropped')).toBeLessThan(order.indexOf('record:draft'));
    // The bar says so, with Restore.
    await toolbarShows(page, 'Removed "Did click Sign in"');
    expect((await readToolbar(page))!.all).toContain('Restore');
    await sleep(300);
    expect(ai.requests).toHaveLength(calls);
    // Twice: nothing more to do.
    expect((await control(id, { action: 'drop', id: 'd2' })).json.ignored).toBeDefined();

    expect((await control(id, { action: 'restore', id: 'd2' })).json).toEqual({ ok: true });
    await s.waitForCount('record:dropped', 2);
    expect(s.of('record:dropped')[1]).toEqual({ type: 'record:dropped', id: 'd2', dropped: false, source: 'panel', actions: behind });
    const back = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision > without.data.revision,
      'the draft with it back',
    );
    expect(back.data).toMatchObject({ steps: ['Did click Reports', 'Did click Sign in'], ids: ['d1', 'd2'] });
    await sleep(300);
    expect(ai.requests).toHaveLength(calls);
    await control(id, { action: 'stop' });
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Did click Reports', 'Did click Sign in']);
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('a deleted step stays out of the result, and no later redraft brings it back', async () => {
    ai.responder = (m) => echoMapped(m);
    const id = 'delete-stays';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.draftThrough(1);
    await pageOf().click('#signin');
    await s.draftThrough(2);
    await pageOf().click('#email');
    await s.draftThrough(3);
    await control(id, { action: 'drop', id: 'd2' });
    const without = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.steps.join('|') === 'Did click Reports|Did click Email',
      'the draft without it',
    );
    // An action dropped from the panel: a redraft of everything left.
    const calls = ai.requests.length;
    await control(id, { action: 'drop', id: s.of('record:action')[0].id });
    await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision > without.data.revision && f.data.steps.length === 1,
      'the redraft',
    );
    expect(recordingOf(ai.requests[calls]!).map((a) => a['target'].name)).toEqual(['Email']);
    await control(id, { action: 'stop' });
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Did click Email']);
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('says why it did nothing, and refuses a body that is none of these', async () => {
    const id = 'edit-refusals';
    const s = await started(id);
    await pageOf().click('#reports');
    await s.draftThrough(1);
    expect((await control(id, { action: 'edit-step', id: 'd9', text: 'x', source: 'panel' })).json).toEqual({
      ok: true,
      ignored: 'The recording has no step with that id.',
    });
    expect((await control(id, { action: 'edit-step', id: 'd1', text: '  ', source: 'panel' })).json.ignored).toMatch(
      /delete the step instead/,
    );
    expect((await control(id, { action: 'edit-step', id: 'd1', text: 'Did click Reports', source: 'panel' })).json.ignored).toBe(
      'The step already reads that way.',
    );
    expect((await control(id, { action: 'edit-step', text: 'x', source: 'panel' })).status).toBe(400);
    expect((await control(id, { action: 'edit-step', id: 'd1', source: 'panel' })).status).toBe(400);
    expect((await control(id, { action: 'edit-step', id: 'd1', text: 'x', source: 'toolbar' })).status).toBe(400);
    expect((await control(id, { action: 'edit-step', id: 'd1', text: 'x', source: 'panel', revision: -1 })).status).toBe(400);
    expect((await control(id, { action: 'drop', id: 'd1', source: 'toolbar' })).status).toBe(400);
    expect((await control('nobody', { action: 'edit-step', id: 'd1', text: 'x', source: 'panel' })).status).toBe(404);
    expect((await control(id, { action: 'drop', id: 'd9' })).json.ignored).toMatch(/no action or step d9/);
    // After Stop: refused up front, with the reason.
    expect((await control(id, { action: 'stop' })).json).toEqual({ ok: true });
    expect((await control(id, { action: 'edit-step', id: 'd1', text: 'Late', source: 'editor' })).json.ignored).toMatch(
      /already been stopped/,
    );
    expect((await control(id, { action: 'drop', id: 'd1' })).json.ignored).toMatch(/already been stopped/);
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Did click Reports']);
    expect(s.of('record:edited')).toEqual([]);
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});

describe("a secret in an edit (the story's \"Secrets\")", () => {
  const PW = 'pw-edit-<&"77>';
  const KEY = "sk-edit'&<SECRET>\"-42";

  it('is written as {{name}} — from the panel and from the drawer — and refused from the editor; in no frame, prompt or log line, in any spelling', async () => {
    const lines: string[] = [];
    const remove = addLogCallback((_level, message) => lines.push(message));
    try {
      ai.responder = (m) => echoMapped(m);
      const id = 'edit-secret';
      const s = await started(id, recordBody({ env: { PASSWORD: PW, STRIPE_API_KEY: KEY } }));
      const page = pageOf();
      await page.click('#reports');
      await s.draftThrough(1);
      await page.click('#signin');
      await s.draftThrough(2);
      // From the panel: {{password}}, which the file already defines.
      expect(
        (await control(id, { action: 'edit-step', id: 'd1', text: `Type ${PW} into the Password field`, source: 'panel' })).json,
      ).toEqual({ ok: true });
      await s.waitForCount('record:edited', 1);
      expect(s.of('record:edited')[0].text).toBe('Type {{password}} into the Password field');
      // From the editor: that line is the author's own text — refused, saying what to write.
      const editor = await control(id, { action: 'edit-step', id: 'd2', text: `Use ${KEY} here`, source: 'editor' });
      expect(editor.json).toMatchObject({ ok: true, ignored: expect.stringContaining('{{STRIPE_API_KEY}}') });
      // From the drawer: {{STRIPE_API_KEY}}, with a parameter reading the .env.
      await clickToolbar(page, 'drawer');
      await until(() => readDrawer(page), (d) => d !== null && d.open && d.rows.length === 2, 'the drawer');
      await clickDrawer(page, 'd2', 'row-edit');
      await until(() => readDrawer(page), (d) => d !== null && d.rows[1]!.editing, 'the step in a box');
      await page.keyboard.press('Control+A');
      await page.keyboard.type(`Send ${KEY} as the key`);
      await page.keyboard.press('Enter');
      await s.waitForCount('record:edited', 2);
      expect(s.of('record:edited')[1]).toEqual({
        type: 'record:edited', id: 'd2', text: 'Send {{STRIPE_API_KEY}} as the key', source: 'toolbar',
      });
      const draft = await s.waitFor(
        (f) => f.event === 'record:draft' && f.data.steps[1] === 'Send {{STRIPE_API_KEY}} as the key',
        'the draft with both',
      );
      expect(draft.data.parameters).toEqual([{ name: 'STRIPE_API_KEY', value: '$STRIPE_API_KEY' }]);
      // A call after: the model is shown the steps as {{…}}.
      await page.click('#email');
      await s.draftThrough(3);
      expect(textOf(ai.requests[ai.requests.length - 1]!)).toContain('Type {{password}} into the Password field');
      await control(id, { action: 'stop' });
      const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
      expect(result.data.steps.slice(0, 2)).toEqual([
        'Type {{password}} into the Password field',
        'Send {{STRIPE_API_KEY}} as the key',
      ]);
      await s.waitFor((f) => f.event === 'done', 'done');
      const everything = JSON.stringify([s.frames, ai.requests, lines]);
      for (const secret of [PW, KEY]) {
        for (const spelling of spellings(secret)) expect(everything).not.toContain(spelling);
      }
    } finally {
      remove();
    }
  }, 60_000);
});

describe('the drawer in the recorded page, over the wire', () => {
  it('an edit, a delete and its Restore, and + between two steps — each through the bar, none of them recorded', async () => {
    ai.responder = (m) => echoMapped(m);
    const id = 'drawer-wire';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await page.click('#signin');
    const two = await s.draftThrough(2);
    expect(two.data.ids).toEqual(['d1', 'd2']);
    await clickToolbar(page, 'drawer');
    await until(() => readDrawer(page), (d) => d !== null && d.open && d.rows.length === 2, 'the drawer');

    // Edit step 1 in place.
    await clickDrawer(page, 'd1', 'row-edit');
    await until(() => readDrawer(page), (d) => d !== null && d.rows[0]!.editing, 'the step in a box');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Open Reports');
    await page.keyboard.press('Enter');
    const edited = await s.waitFor((f) => f.event === 'record:edited', 'record:edited');
    expect(edited.data).toEqual({ type: 'record:edited', id: 'd1', text: 'Open Reports', source: 'toolbar' });
    await s.waitFor((f) => f.event === 'record:draft' && f.data.steps[0] === 'Open Reports', 'the draft');

    // ✕ on step 2: out with its click, struck in the drawer, Restore on the bar.
    await clickDrawer(page, 'd2', 'row-delete');
    const dropped = await s.waitFor((f) => f.event === 'record:dropped', 'record:dropped');
    expect(dropped.data).toEqual({
      type: 'record:dropped', id: 'd2', dropped: true, source: 'toolbar', actions: [s.of('record:action')[1].id],
    });
    const out = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.steps.join('|') === 'Open Reports',
      'the draft without it',
    );
    await toolbarShows(page, 'Removed "Did click Sign in"');
    await until(
      () => readDrawer(page),
      (d) => d !== null && d.rows.map((r) => r.kind).join() === 'live,deleted',
      'the struck row',
    );
    await clickToolbar(page, 'restore');
    await s.waitForCount('record:dropped', 2);
    expect(s.of('record:dropped')[1]).toMatchObject({ id: 'd2', dropped: false, source: 'toolbar' });
    const back = await s.waitFor(
      (f) => f.event === 'record:draft' && f.data.revision > out.data.revision,
      'the step back',
    );
    expect(back.data).toMatchObject({ steps: ['Open Reports', 'Did click Sign in'], ids: ['d1', 'd2'] });

    // + below step 1: a step of the author's, between the two.
    await until(() => readDrawer(page), (d) => d !== null && d.open && d.rows.length === 2, 'the drawer again');
    await clickDrawer(page, 'd1', 'row-insert');
    await toolbarShows(page, 'Goes after step 1');
    await page.keyboard.type('Verify the Reports page is shown');
    await page.keyboard.press('Enter');
    const step = await s.waitFor((f) => f.event === 'record:step', 'record:step');
    expect(step.data).toMatchObject({ text: 'Verify the Reports page is shown', source: 'toolbar', afterStep: 0 });
    const between = await s.waitFor((f) => f.event === 'record:draft' && f.data.authored?.length === 1, 'the draft with it');
    expect(between.data.steps).toEqual(['Open Reports', 'Verify the Reports page is shown', 'Did click Sign in']);

    // None of it was an action.
    expect(s.of('record:action')).toHaveLength(2);
    await control(id, { action: 'stop' });
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Open Reports', 'Verify the Reports page is shown', 'Did click Sign in']);
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('a struck row stays until the next step lands', async () => {
    ai.responder = (m) => echoMapped(m);
    const id = 'drawer-struck';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await page.click('#signin');
    await s.draftThrough(2);
    await clickToolbar(page, 'drawer');
    await control(id, { action: 'drop', id: 'd1' });
    await until(
      () => readDrawer(page),
      (d) => d !== null && d.rows.map((r) => `${r.kind}:${r.text}`).join('|') === 'deleted:Did click Reports|live:Did click Sign in',
      'struck where it was',
    );
    await page.click('#email');
    await s.draftThrough(3);
    await until(
      () => readDrawer(page),
      (d) => d !== null && d.rows.every((r) => r.kind === 'live') && d.rows.length === 2,
      'gone once the next step landed',
    );
    await control(id, { action: 'cancel' });
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);

  it('a change made in the drawer after Stop is refused, and its words go to the panel', async () => {
    ai.responder = (m) => echoMapped(m);
    const id = 'drawer-late';
    const s = await started(id);
    const page = pageOf();
    await page.click('#reports');
    await s.draftThrough(1);
    await clickToolbar(page, 'drawer');
    await until(() => readDrawer(page), (d) => d !== null && d.open && d.rows.length === 1, 'the drawer');
    // A call held open, and a step waiting behind it: Stop waits for the
    // step, and the bar has not been told yet.
    const open = holdCalls();
    await page.click('#signin');
    await callInFlight();
    // The drawer shows "updating…" as a row of its own, and — docked at the
    // bottom — grows upward by it: wait for it, so the rows stay put for the click.
    await until(() => readDrawer(page), (d) => d !== null && d.rows.some((r) => r.kind === 'pending'), 'updating…');
    expect((await control(id, { action: 'add-step', text: 'Verify A', source: 'panel' })).status).toBe(202);
    expect((await control(id, { action: 'stop' })).json).toEqual({ ok: true });
    await clickDrawer(page, 'd1', 'row-edit');
    await until(() => readDrawer(page), (d) => d !== null && d.rows[0]!.editing, 'the step in a box');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Too late to change');
    await page.keyboard.press('Enter');
    await toolbarShows(page, 'Your change came after Stop, so it was not made.');
    await until(
      () => readDrawer(page),
      (d) => d === null || !d.open || d.rows[0]!.text === 'Did click Reports',
      'the words taken back in the page',
    );
    open();
    const result = await s.waitFor((f) => f.event === 'record:result', 'record:result');
    expect(result.data.steps).toEqual(['Did click Reports', 'Did click Sign in', 'Verify A']);
    expect(s.of('record:edited')).toEqual([]);
    const warned = s.of('output').filter((o) => o.kind === 'warn').map((o) => o.msg as string);
    expect(warned).toContain(
      'A change to a step made in the browser after Stop was not made: "Too late to change". Change the step in the test by hand.',
    );
    await s.waitFor((f) => f.event === 'done', 'done');
  }, 60_000);
});
