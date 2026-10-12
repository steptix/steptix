/**
 * `steptix run` with nobody to answer, and its test timeout as a real deadline
 * (steptix/steptix#47).
 *
 * Under `steptix run`, the AI's clarification question used to be asked at the
 * terminal whatever stdin was. In CI, a script or a scheduled job nothing
 * answers; the open browser keeps Node alive, and the run waited 7.6 hours past
 * a 600 s `timeout:`, which was only checked between steps.
 *
 * Real `runTest`, the REAL step executor and the REAL AI client. Stubbed: the
 * browser and its page, the DOM reader, the gateway library under the client
 * (scripted per test, and handed the request's signal, so a reply can hang
 * until something aborts it), and the terminal — `createLineReader` reads from
 * a stream each test owns, while `canAskUser` stays real and reads
 * `process.stdin.isTTY`, which each test sets and puts back.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Config } from '../src/config/types.js';
import type { ResolvedHooks } from '../src/runner/hooks.js';
import type { TestReport } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── The model: a scripted gateway under the real AiClient ───────────────────

const gw = vi.hoisted(() => ({
  /** Answers one request; `signal` is what the client handed the gateway. */
  respond: (_text: string, _signal?: AbortSignal): string | Promise<string> => {
    throw new Error('no responder set');
  },
  requests: [] as string[],
}));

vi.mock('@pkent/aigateway', () => {
  const textOf = (messages: Array<{ content: unknown }>): string =>
    messages
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'),
      )
      .join('\n');
  class FakeGateway {
    static providers(): unknown[] {
      return [];
    }
    async chat(messages: Array<{ content: unknown }>, options?: { signal?: AbortSignal }) {
      const text = textOf(messages);
      gw.requests.push(text);
      const reply = await gw.respond(text, options?.signal);
      return { model: 'aibroker/test/model', content: [{ type: 'text', text: reply }] };
    }
    stream(): never {
      throw new Error('this suite does not stream');
    }
  }
  return { AIGateway: FakeGateway, default: FakeGateway };
});

// ─── The terminal: a stream per test, behind the real reader ────────────────

const term = vi.hoisted(() => ({
  current: undefined as { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } | undefined,
  opened: 0,
}));

vi.mock('../src/utils/ask-user.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ask-user.js')>();
  return {
    ...actual,
    createLineReader: (opts: Parameters<typeof actual.createLineReader>[0] = {}) => {
      term.opened++;
      if (!term.current) throw new Error('this test opened no terminal');
      return actual.createLineReader({
        ...opts,
        input: term.current.input as never,
        output: term.current.output as never,
      });
    },
  };
});

// ─── The browser: a page with no DOM, and actions that always succeed ────────

const mockPage = {
  url: () => 'https://shop.test/cart',
  title: async () => 'Cart',
  goto: async () => null,
  on: () => {},
  off: () => {},
  context: () => ({ browser: () => ({}) }),
  evaluate: async () => {
    throw new Error('no DOM in this test');
  },
  screenshot: async () => {
    throw new Error('no screenshot in this test');
  },
  waitForLoadState: async () => {},
};
const mockSession = {
  browser: { isConnected: () => true },
  context: {},
  page: mockPage,
  pageTracker: { getActive: () => mockPage, count: 1 },
};

vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: async () => mockSession,
  closeBrowser: async () => {},
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
  NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {},
  NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
  BrowserTracker: class BrowserTrackerStub {
    private session: unknown;
    private launch: (() => Promise<unknown>) | undefined;
    constructor(initial: unknown) {
      this.session = initial;
    }
    getActive() {
      if (this.session === undefined) throw new Error('no browser has been launched in this session');
      return this.session;
    }
    getActivePage() {
      return (this.getActive() as { page: unknown }).page;
    }
    has() {
      return false;
    }
    add() {}
    switchTo() {
      return this.session;
    }
    async close() {}
    async closeAll() {}
    list() {
      return [];
    }
    get count() {
      return this.session === undefined ? 0 : 1;
    }
    hasActive() {
      return this.session !== undefined;
    }
    static deferred(launch: () => Promise<unknown>) {
      const tracker = new BrowserTrackerStub(undefined);
      tracker.launch = launch;
      return tracker;
    }
    async ensureLaunched() {
      if (this.session === undefined) this.session = await this.launch!();
      return this.session;
    }
  },
}));

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async () => ({ success: true, targeting: { matchCount: 1, visibleMatchCount: 1 } })),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: async () => '<html><body><button>Save</button></body></html>' };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false,
    loadingIndicators: [],
    hasErrorOverlay: false,
    errorMessages: [],
    hasModal: false,
    documentLoading: false,
  }),
  waitForPageStability: async () => {},
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://shop.test/cart', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean {
      return true;
    }
    dispose(): void {}
  },
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: async () => null,
  toDataUri: (b: string) => `data:image/png;base64,${b}`,
}));
vi.mock('../src/utils/run-log.js', () => ({ openRunLogFile: () => null, attachRunLogBridges: () => () => {} }));

/** The hooks a run resolves: none, unless a test sets `before`. */
function hooksWith(before: string[] = []): ResolvedHooks {
  return {
    before,
    beforeEach: [],
    afterEach: [],
    after: [],
    hasAny: before.length > 0,
    toolCalls: { before: before.map(() => null), beforeEach: [], afterEach: [], after: [] },
    sourceSkills: { before: before.map(() => null), beforeEach: [], afterEach: [], after: [] },
  } as unknown as ResolvedHooks;
}
const hooksState = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../src/runner/hooks.js', () => ({ resolveHooks: vi.fn(async () => hooksState.current) }));

/** The failure REPL and `[interactive]`, counted rather than opened. */
const replMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'exit' as const })));
vi.mock('../src/runner/interactive-repl.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/interactive-repl.js')>()),
  runInteractiveRepl: replMock,
}));

import { runTest } from '../src/runner/test-runner.js';
import { parseTestFile } from '../src/parser/markdown.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const QUESTION = 'Which Save button did you mean — the header or the footer one?';

const plan = (actions: Array<Record<string, unknown>>): string =>
  JSON.stringify({ actions: actions.map((a) => ({ description: 'do it', ...a })), reasoning: 'planned', needs_reeval: false });

const ask = (): string =>
  JSON.stringify({
    actions: [{ action: 'prompt', question: QUESTION, description: 'two Save buttons' }],
    reasoning: 'There are two Save buttons; I need to know which one.',
  });

/** The step a step prompt asks about — the line under `## Current Step`. */
function currentStep(text: string): string | undefined {
  const marker = '## Current Step\n';
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  return text.slice(at + marker.length).split('\n', 1)[0]!.trim();
}

/** A model call in flight: it answers only by failing, when its signal aborts. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const stop = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

/** A terminal: what the run reads, and what it printed — with a promise for
 *  the first time `text` is printed. */
function openTerminal(): {
  input: PassThrough;
  output: PassThrough;
  printed: (text: string) => Promise<void>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = '';
  const waiting: Array<{ text: string; resolve: () => void }> = [];
  output.on('data', (chunk: Buffer) => {
    seen += chunk.toString();
    for (const w of [...waiting]) {
      if (seen.includes(w.text)) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve();
      }
    }
  });
  const printed = (text: string): Promise<void> =>
    seen.includes(text) ? Promise.resolve() : new Promise((resolve) => waiting.push({ text, resolve }));
  term.current = { input, output };
  return { input, output, printed };
}

let tmp: string;
let counter = 0;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-no-terminal-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

/** What stdin and stdout said about being terminals before a test forced them. */
let savedStdin: PropertyDescriptor | undefined;
let savedStdout: PropertyDescriptor | undefined;

function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): void {
  Object.defineProperty(stream, 'isTTY', { value, configurable: true });
}

function restoreTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, saved: PropertyDescriptor | undefined): void {
  if (saved) Object.defineProperty(stream, 'isTTY', saved);
  else delete (stream as { isTTY?: boolean }).isTTY;
}

beforeEach(() => {
  gw.requests = [];
  gw.respond = () => {
    throw new Error('no responder set');
  };
  term.current = undefined;
  term.opened = 0;
  hooksState.current = hooksWith();
  replMock.mockClear();
  savedStdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  savedStdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
});

afterEach(() => {
  restoreTTY(process.stdin, savedStdin);
  restoreTTY(process.stdout, savedStdout);
  vi.useRealTimers();
});

function config(over: Partial<Config['execution']> = {}, headed = false): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: {
      ...DEFAULT_CONFIG.ai,
      apiKey: 'run-no-terminal-test-key',
      model: 'aibroker/test/model',
      // An aibroker/ model needs a URL; the gateway above is scripted, so it is
      // never contacted.
      gatewayUrl: 'https://gateway.test',
      streamResponses: false,
      sendScreenshots: false,
      diagnoseFailures: false,
    },
    browser: { ...DEFAULT_CONFIG.browser, headed, captureScreenshotsPerAction: false },
    execution: {
      ...DEFAULT_CONFIG.execution,
      retries: 1,
      screenshotOnFailure: false,
      promptOnAmbiguity: true,
      interactiveOnFailure: false,
      ...over,
    },
    reports: {
      ...DEFAULT_CONFIG.reports,
      outputDir: path.join(tmp, 'reports'),
      openInBrowserAfterRun: false,
      appendRunHistoryToTestFile: false,
    },
    logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  };
}

/** Run a test written as markdown, from a file of its own under the temp dir
 *  (the last-run sidecar is written beside it). Parsed the way the CLI parses
 *  a file, so an `If … then` line becomes the guard it is. */
async function run(
  markdown: string,
  cfg: Config = config(),
  extras: Parameters<typeof runTest>[3] = {},
): Promise<TestReport> {
  const dir = path.join(tmp, `t${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'test.md');
  fs.writeFileSync(file, markdown);
  const test = await parseTestFile(file);
  return runTest({ test, resolvedParameters: {} }, cfg, '', extras);
}

/** A promise the test opens from inside a responder — "the model was asked". */
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const doc = (steps: string[], frontmatter = ''): string =>
  `${frontmatter ? `---\n${frontmatter}\n---\n` : ''}# No terminal\n\n## Steps\n${steps
    .map((s, n) => `${n + 1}. ${s}`)
    .join('\n')}\n`;

// ─── No terminal: fail fast ─────────────────────────────────────────────────

describe('steptix run with no terminal on stdin (#47)', () => {
  beforeEach(() => {
    setTTY(process.stdin, false);
  });

  it("fails the AI's question as its step, with the question in the error, and the run finishes", async () => {
    gw.respond = (text) => (currentStep(text) === 'Click the Save button' ? ask() : plan([{ action: 'click', selector: '#next' }]));

    const report = await run(doc(['Click the Save button', 'Click Next']));

    expect(report.status).toBe('failed');
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.status).toBe('failed');
    expect(report.steps[0]!.error).toContain('no interactive prompt');
    expect(report.steps[0]!.error).toContain(QUESTION);
    // Asked once, not retried: asking again cannot be answered either.
    expect(gw.requests).toHaveLength(1);
    // Nothing was opened on stdin at all.
    expect(term.opened).toBe(0);
    expect(report.aborted).toBeUndefined();
  });

  it('`otherwise continue` tolerates it, and the next step runs', async () => {
    gw.respond = (text) => (currentStep(text)?.startsWith('Click the Save button') ? ask() : plan([{ action: 'click', selector: '#next' }]));

    const report = await run(doc(['Click the Save button, otherwise continue', 'Click Next']));

    expect(report.steps.map((s) => s.status)).toEqual(['failed', 'passed']);
    expect(report.steps[0]!.tolerated).toBe(true);
    expect(report.steps[0]!.error).toContain(QUESTION);
    expect(report.steps[1]!.instruction).toBe('Click Next');
    expect(report.status).toBe('passed');
    expect(report.toleratedSteps).toBe(1);
  });

  it('opens no failure REPL, even with a terminal on stdout', async () => {
    setTTY(process.stdout, true);
    gw.respond = () => ask();

    const report = await run(doc(['Click the Save button']), config({ interactiveOnFailure: true }, true));

    expect(report.status).toBe('failed');
    expect(replMock).not.toHaveBeenCalled();
    expect(term.opened).toBe(0);
  });

  it('fails an `[input:]` step, naming its prompt, and the run finishes', async () => {
    gw.respond = () => plan([{ action: 'click', selector: '#order' }]);

    const report = await run(doc(['[input: order] Enter the order id you were given', 'Open order {{order}}']));

    expect(report.status).toBe('failed');
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.status).toBe('failed');
    expect(report.steps[0]!.error).toContain('[input: order]');
    expect(report.steps[0]!.error).toContain('Enter the order id you were given');
    expect(report.steps[0]!.error).toContain('no terminal');
    expect(gw.requests).toHaveLength(0);
    expect(term.opened).toBe(0);
  });

  it('skips an `[interactive]` step, and the run carries on', async () => {
    gw.respond = () => plan([{ action: 'click', selector: '#save' }]);

    const report = await run(doc(['[interactive] look around', 'Click Save']));

    expect(report.steps.map((s) => s.status)).toEqual(['skipped', 'passed']);
    expect(report.steps[0]!.aiExplanation).toContain('stdin is not a terminal');
    expect(replMock).not.toHaveBeenCalled();
    expect(report.status).toBe('passed');
    expect(report.humanIntervened).toBeUndefined();
  });
});

// ─── A terminal whose input ends ────────────────────────────────────────────

describe('a terminal whose input ends before an answer (#47)', () => {
  beforeEach(() => {
    setTTY(process.stdin, true);
  });

  it("the AI's question rejects instead of hanging, and fails its step", async () => {
    const t = openTerminal();
    t.input.end();
    gw.respond = () => ask();

    const report = await run(doc(['Click the Save button', 'Click Next']));

    expect(report.status).toBe('failed');
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.error).toContain('input ended');
    expect(report.steps[0]!.error).toContain(QUESTION);
    expect(term.opened).toBe(1);
    expect(gw.requests).toHaveLength(1);
  });

  it('an `[input:]` step fails naming its prompt', async () => {
    const t = openTerminal();
    t.input.end();

    const report = await run(doc(['[input: order] Enter the order id you were given', 'Open order {{order}}']));

    expect(report.status).toBe('failed');
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.error).toContain('[input: order]');
    expect(report.steps[0]!.error).toContain('Enter the order id you were given');
    expect(report.steps[0]!.error).toContain('input ended');
  });
});

// ─── With a terminal: unchanged ─────────────────────────────────────────────

describe('with a terminal, the question is still asked', () => {
  beforeEach(() => {
    setTTY(process.stdin, true);
  });

  it('asks at the terminal and hands the answer back to the model', async () => {
    const t = openTerminal();
    void t.printed('Your answer:').then(() => t.input.write('the header one\n'));
    gw.respond = (text) => (text.includes('Answer: the header one') ? plan([{ action: 'click', selector: 'header #save' }]) : ask());

    const report = await run(doc(['Click the Save button']));

    expect(report.status).toBe('passed');
    expect(gw.requests).toHaveLength(2);
    expect(gw.requests[1]).toContain(`Question: ${QUESTION}`);
    expect(term.opened).toBe(1);
  });
});

// ─── The test timeout is a real deadline ────────────────────────────────────

describe("the test's timeout ends a step that never returns (#47)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  it('as a timeout — a failed test, not a stopped one', async () => {
    setTTY(process.stdin, false);
    let calledModel!: () => void;
    const modelCalled = new Promise<void>((resolve) => { calledModel = resolve; });
    gw.respond = (_text, signal) => {
      calledModel();
      return hangUntilAborted(signal);
    };

    const running = run(doc(['Click the Save button', 'Click Next'], 'timeout: 5s'));
    await modelCalled;
    await vi.advanceTimersByTimeAsync(5000);
    const report = await running;

    expect(report.status).toBe('failed');
    expect(report.aborted).toBeUndefined();
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.status).toBe('failed');
    expect(report.steps[0]!.interrupted).toBeUndefined();
    expect(report.steps[0]!.error).toBe('Test timeout after 5000ms at step 1');
    expect(report.failedSteps).toBe(1);
    // Step 2 never ran, and the deadline's timer is gone with the run.
    expect(gw.requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a `before` hook that never returns, as a timeout', async () => {
    setTTY(process.stdin, false);
    hooksState.current = hooksWith(['Open the dashboard']);
    let calledModel!: () => void;
    const modelCalled = new Promise<void>((resolve) => { calledModel = resolve; });
    gw.respond = (_text, signal) => {
      calledModel();
      return hangUntilAborted(signal);
    };

    const running = run(doc(['Click the Save button'], 'timeout: 5s'));
    await modelCalled;
    await vi.advanceTimersByTimeAsync(5000);
    const report = await running;

    expect(report.status).toBe('failed');
    expect(report.aborted).toBeUndefined();
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.hookScope).toBe('before');
    expect(report.steps[0]!.interrupted).toBeUndefined();
    expect(report.steps[0]!.error).toBe('Test timeout after 5000ms at the before hook');
    // The step after it never ran.
    expect(gw.requests).toHaveLength(1);
  });

  it('a question asked at a terminal nobody answers ends at the timeout too', async () => {
    setTTY(process.stdin, true);
    const t = openTerminal();
    gw.respond = () => ask();

    const running = run(doc(['Click the Save button'], 'timeout: 5s'));
    await t.printed('Your answer:');
    await vi.advanceTimersByTimeAsync(5000);
    const report = await running;

    expect(report.status).toBe('failed');
    expect(report.aborted).toBeUndefined();
    expect(report.steps[0]!.error).toBe('Test timeout after 5000ms at step 1');
  });

  it('does not bill the time a person takes to answer an `[input:]` step', async () => {
    setTTY(process.stdin, true);
    const t = openTerminal();
    gw.respond = () => plan([{ action: 'click', selector: '#order' }]);

    const running = run(doc(['[input: order] Enter the order id', 'Open order {{order}}'], 'timeout: 5s'));
    await t.printed('Enter the order id');
    // A minute at the keyboard, against a five-second budget.
    await vi.advanceTimersByTimeAsync(60_000);
    t.input.write('A-42\n');
    const report = await running;

    expect(report.status).toBe('passed');
    expect(report.steps.map((s) => s.status)).toEqual(['passed', 'passed']);
    // The answer reached the next step: the model is shown the authored line,
    // with the value it holds beside it.
    expect(currentStep(gw.requests[0]!)).toBe('Open order {{order}}');
    expect(gw.requests[0]).toContain('A-42');
  });

  it("a Stop is still a Stop: the caller's signal keeps its meaning", async () => {
    // Fake timers that are never advanced: the deadline stays armed and can
    // never fire, however slowly a loaded runner reaches the model — so the
    // only abort is the Stop, and it must not read as a timeout.
    setTTY(process.stdin, false);
    const stop = new AbortController();
    gw.respond = (_text, signal) => {
      stop.abort();
      return hangUntilAborted(signal);
    };

    const report = await run(doc(['Click the Save button', 'Click Next'], 'timeout: 5s'), config(), {
      signal: stop.signal,
    });

    expect(report.aborted).toBe(true);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.interrupted).toBe(true);
    expect(report.steps[0]!.error).not.toContain('Test timeout');
  });
});

// ─── Decisions and watch groups under the deadline ──────────────────────────
//
// Neither returns an `interrupted` row: the judge behind an `If … then` guard
// and a watch group's poll both THROW an abort, which the run loop catches.
// Each is asked once, and that one model call hangs until its signal aborts.

describe('a decision or a watch group that never returns (#47)', () => {
  /** An `If … then` line: a guard the judge decides. */
  const GUARD = 'If the Save button is shown, then Click Save';
  /** A watch: an `If … appears` line grouped with the step after it. */
  const WATCH = 'If a cookie banner appears, dismiss it';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    setTTY(process.stdin, false);
  });

  /** Every model call hangs until aborted; `asked` opens at the first. */
  function hangEveryCall(onCall: () => void = () => {}): Promise<void> {
    const asked = gate();
    gw.respond = (_text, signal) => {
      asked.open();
      onCall();
      return hangUntilAborted(signal);
    };
    return asked.opened;
  }

  /** The row a timeout leaves: failed, named, and not a Stop. */
  function expectTimedOut(report: TestReport): void {
    expect(report.status).toBe('failed');
    expect(report.aborted).toBeUndefined();
    const row = report.steps[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Test timeout after 5000ms at step 1');
    expect(row.interrupted).toBeUndefined();
    // Built by the guard / watch-group catch, not the step path's relabel —
    // which keeps the step's real duration and turns. Without this, a guard
    // parsed as an ordinary step would pass the assertions above unchanged.
    expect(row.durationMs).toBe(0);
    expect(row.turns).toEqual([]);
    // Nothing after it ran: the one call is the one that hung.
    expect(gw.requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  }

  it('an `If … then` judge ends at the timeout, as a timeout', async () => {
    const asked = hangEveryCall();

    const running = run(doc([GUARD, 'Click Next'], 'timeout: 5s'));
    await asked;
    await vi.advanceTimersByTimeAsync(5000);
    const report = await running;

    expectTimedOut(report);
    expect(report.steps[0]!.instruction).toBe(GUARD);
  });

  it('a watch group ends at the timeout, as a timeout', async () => {
    const asked = hangEveryCall();

    const running = run(doc([WATCH, 'Click Save'], 'timeout: 5s'));
    await asked;
    await vi.advanceTimersByTimeAsync(5000);
    const report = await running;

    expectTimedOut(report);
    expect(report.steps[0]!.instruction).toBe(WATCH);
  });

  // The watch group ran under no signal before #47, so a Stop reaches it here
  // for the first time; the timer is never advanced, so it cannot be the cause.
  it('a Stop in a watch group is a Stop, not a timeout', async () => {
    const stop = new AbortController();
    hangEveryCall(() => stop.abort());

    const report = await run(doc([WATCH, 'Click Save'], 'timeout: 5s'), config(), { signal: stop.signal });

    expect(report.aborted).toBe(true);
    expect(report.failedSteps).toBe(0);
    const row = report.steps[0]!;
    expect(row.interrupted).toBe(true);
    expect(row.error).toBeUndefined();
    expect(row.aiExplanation).toBe('Stopped by user (run aborted).');
    expect(gw.requests).toHaveLength(1);
  });

  it('a Stop in an `If … then` judge is a Stop, not a timeout', async () => {
    const stop = new AbortController();
    hangEveryCall(() => stop.abort());

    const report = await run(doc([GUARD, 'Click Next'], 'timeout: 5s'), config(), { signal: stop.signal });

    expect(report.aborted).toBe(true);
    expect(report.failedSteps).toBe(0);
    expect(report.steps[0]!.interrupted).toBe(true);
    expect(report.steps[0]!.error).toBeUndefined();
  });
});
