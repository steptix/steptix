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

const launches = vi.hoisted(() => ({ count: 0, pages: [] as unknown[], closers: [] as Array<() => Promise<void>> }));
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
    recorder: { typedNavigationWindowMs: 200, draftSettleMs: opts.draftSettleMs ?? QUICK_SETTLE_MS },
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

/** The draft so far one call was shown — [] for a full (re)draft. */
function draftOf(messages: ChatMessage[]): string[] {
  const text = textOf(messages);
  const m = /## The draft so far: [^\n]*\n[^\n]*\n```json\n([\s\S]*?)\n```/.exec(text);
  if (!m) {
    expect(text).toContain('## The draft so far\nEmpty:');
    return [];
  }
  return (JSON.parse(m[1]!) as { steps: Array<{ index: number; step: string }> }).steps.map((s) => s.step);
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

    await page.fill('#email', 'demo@securebank.com');
    await page.fill('#pw', SECRET); // finishes the email field
    await page.selectOption('#freq', { label: 'Monthly' }); // finishes the password field
    await s.draftThrough(4);
    await page.check('#cash');
    await s.draftThrough(5);
    expect((await control(id, { action: 'check' })).status).toBe(202);
    await s.waitFor((f) => f.event === 'record:pick' && f.data.armed === true, 'pick armed');
    await page.click('#pm-text');
    const last = await s.draftThrough(6);

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
    expect(seen).toBe(6);
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
    await pageOf().selectOption('#freq', { label: 'Monthly' });
    await pageOf().check('#cash');
    await s.draftThrough(2);
    await sleep(700);
    expect(ai.requests).toHaveLength(1);
    expect(recordingOf(ai.requests[0]!).map((a) => a['kind'])).toEqual(['select', 'tick']);
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
    await s.waitForCount('record:action', 3);
    await sleep(QUICK_SETTLE_MS + 300); // well past the settle window
    expect(ai.requests).toHaveLength(1);

    ai.gate = null;
    open();
    await s.draftThrough(3);
    expect(ai.requests).toHaveLength(2);
    expect(recordingOf(ai.requests[1]!).map((a) => a['n'])).toEqual([2, 3]);
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
    expect((await control('nobody', { action: 'pause' })).status).toBe(400);
    expect((await control('nobody', { action: 'stop', dropped: [1, 2] })).status).toBe(400);
    expect((await control('nobody', { action: 'drop' })).status).toBe(400);
    expect((await control('nobody', { action: 'restore', id: '' })).status).toBe(400);
  });
});
