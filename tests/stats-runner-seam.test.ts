/**
 * The scoreboard at the CLI runner's seam (docs/specs/SPEC-scoreboard.md §15,
 * "At the seam"; acceptance 1, 3, 5, 7, 10, 11).
 *
 * Real `runTests`, real `runTest`, the REAL step executor, the REAL AI client
 * and the REAL report generator. Stubbed: the browser and its page, the DOM
 * reader, and the gateway library underneath the client — which answers each
 * request from a script and reports usage the way the v2 envelope does, so the
 * token path from `complete()` to the step line is the production one.
 *
 * Every line lands in a temporary user root; the suite-wide `STEPTIX_STATS=off`
 * (vitest.config.ts) is lifted for this file only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AIAction } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { ResolvedHooks } from '../src/runner/hooks.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── The model: a scripted gateway under the real AiClient ───────────────────

interface Reply {
  text: string;
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number };
}
const gw = vi.hoisted(() => ({
  /** Answers one request. `signal` is the one the client handed the gateway —
   *  the run's Stop combined with the request timeout — so a responder can
   *  hang until a Stop lands, the way a real call in flight does. */
  respond: (
    _text: string,
    _signal?: AbortSignal,
  ): { text: string; usage?: Reply['usage'] } | Promise<{ text: string; usage?: Reply['usage'] }> => {
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
      return {
        model: 'aibroker/test/model',
        content: [{ type: 'text', text: reply.text }],
        ...(reply.usage && { usage: reply.usage }),
      };
    }
    stream(): never {
      throw new Error('this suite does not stream');
    }
  }
  return { AIGateway: FakeGateway, default: FakeGateway };
});

// ─── The browser: a page with no DOM, and actions scripted by selector ───────

const acted = vi.hoisted(() => ({ actions: [] as AIAction[] }));

const mockPage = {
  url: () => 'https://secure.bank.test/accounts',
  title: async () => 'Accounts',
  goto: async () => null,
  on: () => {},
  off: () => {},
  context: () => ({ browser: () => ({}) }),
  // The scripts this page runs: assertion code the model is scripted to write.
  // `ASSERT_OK` holds, `ASSERT_FAIL` does not, and anything else throws — code
  // that never runs to a verdict.
  evaluate: async (code: unknown) => {
    if (code === 'ASSERT_OK') return { pass: true, actual: 'Paid' };
    if (code === 'ASSERT_FAIL') return { pass: false, actual: 'Unpaid' };
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

/** Playwright's own words for a selector that matched nothing. */
const NO_MATCH_ERROR =
  'locator.click: Timeout 10000ms exceeded.\nCall log:\n' +
  "  - waiting for locator('[role=\"listbox\"] [role=\"option\"]:text-is(\"Mr\")').first()\n";

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      acted.actions.push(action);
      // A read whose region holds no table: the SHAPE refusal a readTable
      // carries a sketch for, which is what asks the model the structure
      // question (SPEC-structured-table-reads.md §7.10).
      if (action.action === 'readTable') {
        return {
          success: false,
          error: `No table or grid with rows was found under "${action.selector}"`,
          failedSelector: action.selector,
          sketch: { region: { selector: action.selector ?? '' }, candidates: [] },
        };
      }
      if (action.selector?.includes(':text-is(')) {
        return {
          success: false,
          error: NO_MATCH_ERROR,
          failedSelector: action.selector,
          targeting: { matchCount: 0, visibleMatchCount: 0 },
        };
      }
      return { success: true, targeting: { matchCount: 1, visibleMatchCount: 1 } };
    }),
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
  capturePageSignal: async () => ({ url: 'https://secure.bank.test/', domLength: 1 }),
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
vi.mock('../src/context/loader.js', () => ({ loadContextFiles: async () => ({ files: [], combined: '' }) }));
vi.mock('../src/utils/run-log.js', () => ({ openRunLogFile: () => null, attachRunLogBridges: () => () => {} }));

let hooksStub: ResolvedHooks;
vi.mock('../src/runner/hooks.js', () => ({ resolveHooks: vi.fn(async () => hooksStub) }));

import { runTest, runTests } from '../src/runner/test-runner.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { readStatsLines, flushStatsWrites } from '../src/stats/store.js';
import type { StatsActionLine, StatsLine, StatsRunLine, StatsStepLine } from '../src/stats/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';
import type { RunSummary } from '../src/report/types.js';
import { stepAnchor } from '../src/report/anchors.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let tmp: string;
let userRoot: string;
let deps: UserRootDeps;
const savedEnv: Record<string, string | undefined> = {};
let counter = 0;

function hooks(over: Partial<Record<'before' | 'beforeEach' | 'afterEach' | 'after', string[]>> = {}): ResolvedHooks {
  const scopes = { before: [], beforeEach: [], afterEach: [], after: [], ...over } as Record<string, string[]>;
  const slots = () => Object.fromEntries(Object.entries(scopes).map(([s, lines]) => [s, lines.map(() => null)]));
  return {
    ...(scopes as unknown as Pick<ResolvedHooks, 'before' | 'beforeEach' | 'afterEach' | 'after'>),
    hasAny: Object.values(scopes).some((lines) => lines.length > 0),
    toolCalls: slots() as ResolvedHooks['toolCalls'],
    sourceSkills: slots() as ResolvedHooks['sourceSkills'],
  };
}

/** A project of its own per test: a `steptix.config.json` marks the root, and
 *  holds `config` when one is given. */
function project(config: Record<string, unknown> = {}): { root: string; reports: string } {
  const root = path.join(tmp, `proj-${counter++}`);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'steptix.config.json'), JSON.stringify(config));
  return { root, reports: path.join(root, 'reports') };
}

function config(reports: string, over: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: {
      ...DEFAULT_CONFIG.ai,
      apiKey: 'test-key',
      model: 'aibroker/test/model',
      // An aibroker/ model needs a URL; the gateway above is scripted, so it is
      // never contacted.
      gatewayUrl: 'https://gateway.test',
      streamResponses: false,
      sendScreenshots: false,
      diagnoseFailures: false,
    },
    browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false },
    execution: {
      ...DEFAULT_CONFIG.execution,
      retries: 1,
      screenshotOnFailure: false,
      promptOnAmbiguity: false,
      interactiveOnFailure: false,
    },
    reports: { ...DEFAULT_CONFIG.reports, outputDir: reports, openInBrowserAfterRun: false, appendRunHistoryToTestFile: false },
    logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
    ...over,
  };
}

const plan = (actions: Array<Record<string, unknown>>): string =>
  JSON.stringify({ actions: actions.map((a) => ({ description: 'do it', ...a })), reasoning: 'planned', needs_reeval: false });

/** The judge's answer for a condition: `A` holds, `none` does not. */
const verdict = (matched: 'A' | 'none'): string => JSON.stringify({ matched, reasoning: 'looked', actions: [] });

/** The step a step prompt asks about — the line under `## Current Step`; the
 *  prior-steps history above it may mention other steps. `undefined` for any
 *  other request (a judge, a diagnosis). */
function currentStep(text: string): string | undefined {
  const marker = '## Current Step\n';
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  return text.slice(at + marker.length).split('\n', 1)[0]!.trim();
}

async function run(root: string, reports: string, name: string, markdown: string, over: Partial<Config> = {}): Promise<RunSummary> {
  const file = path.join(root, 'tests', name);
  fs.writeFileSync(file, markdown);
  const test = await parseTestFile(file);
  return runTests([test], config(reports, over));
}

/** {@link run}, with a Stop the caller can press: the real `runTest` handed
 *  `signal`, which is how a stopping caller (a compile's cancel) reaches it. */
async function runStoppable(
  root: string,
  reports: string,
  name: string,
  markdown: string,
  signal: AbortSignal,
): Promise<RunSummary> {
  const file = path.join(root, 'tests', name);
  fs.writeFileSync(file, markdown);
  const test = await parseTestFile(file);
  return runTests([test], config(reports), {
    runTestFn: (instance, cfg, context, extras) => runTest(instance, cfg, context, { ...extras, signal }),
  });
}

/** A model call in flight when the Stop lands: it answers only by failing,
 *  the way the gateway's request does when its signal aborts. */
function hangUntilStopped(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const stop = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

/** The assertion code prompt, told apart from a step's action plan. */
const ASSERTION_PROMPT = 'Write a self-executing JavaScript function that evaluates the following assertion.';

async function lines(): Promise<StatsLine[]> {
  await flushStatsWrites();
  const read = await readStatsLines({ deps });
  expect(read.skipped).toBe(0);
  return read.lines;
}
const actionLines = (all: StatsLine[]) => all.filter((l): l is StatsActionLine => l.kind === 'action');
const stepLines = (all: StatsLine[]) => all.filter((l): l is StatsStepLine => l.kind === 'step');
const runLines = (all: StatsLine[]) => all.filter((l): l is StatsRunLine => l.kind === 'run');

/** The report a run line links to, read off the disk. */
function reportHtml(runLine: StatsRunLine | undefined): string {
  expect(runLine?.report).toBeTruthy();
  expect(fs.existsSync(runLine!.report!)).toBe(true);
  return fs.readFileSync(runLine!.report!, 'utf-8');
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-stats-runner-seam-')));
  userRoot = path.join(tmp, 'user-root');
  fs.mkdirSync(userRoot, { recursive: true });
  for (const key of ['STEPTIX_STATS', 'STEPTIX_STATS_SUITE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
  delete process.env['STEPTIX_STATS'];
  delete process.env['STEPTIX_STATS_SUITE'];
  process.env['LOCALAPPDATA'] = userRoot;
  process.env['XDG_CONFIG_HOME'] = userRoot;
  deps = { env: { LOCALAPPDATA: userRoot, XDG_CONFIG_HOME: userRoot }, platform: process.platform };
});

afterAll(async () => {
  await flushStatsWrites();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await flushStatsWrites();
  fs.rmSync(path.join(userRoot, 'steptix', 'stats'), { recursive: true, force: true });
  hooksStub = hooks();
  gw.requests = [];
  acted.actions = [];
});

// ─── The cases ───────────────────────────────────────────────────────────────

describe('a CLI run records its actions, steps and run (acceptance 1, 10, 11)', () => {
  it('a text-is selector that matched nothing, retried to role=: the lines, the tokens, the link', async () => {
    const { root, reports } = project();
    let titleCalls = 0;
    gw.respond = (text) => {
      const step = currentStep(text);
      if (step === 'Select "Mr" from the Title list') {
        titleCalls++;
        return titleCalls === 1
          ? {
              text: plan([{ action: 'click', selector: '[role="listbox"] [role="option"]:text-is("Mr")' }]),
              usage: { input_tokens: 4000, output_tokens: 120 },
            }
          : {
              text: plan([{ action: 'click', selector: 'role=option[name="Mr"]' }]),
              usage: { input_tokens: 4500, output_tokens: 150, cached_input_tokens: 3000 },
            };
      }
      if (step === 'Click Save') {
        return { text: plan([{ action: 'click', selector: '#save' }]), usage: { input_tokens: 3900, output_tokens: 80 } };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const summary = await run(root, reports, 'recording.md', '# Recording\n\n## Steps\n1. Select "Mr" from the Title list\n2. Click Save\n');
    expect(summary.reports[0]!.status).toBe('passed');

    const all = await lines();
    const actions = actionLines(all);
    const steps = stepLines(all);
    const runs = runLines(all);
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.run;
    expect(runId).toMatch(/^r-\d{8}-\d{6}-[0-9a-f]{4}$/);

    // Action lines: the failed first try, the retry, the second step (§5.1).
    expect(actions.map((a) => [a.step, a.attempt, a.turn, a.action, a.form, a.outcome, a.matchCount])).toEqual([
      [1, 1, 1, 'click', 'text-is', 'no-match', 0],
      [1, 2, 1, 'click', 'role', 'ok', 1],
      [2, 1, 1, 'click', 'id', 'ok', 1],
    ]);
    for (const line of all) {
      expect(line.run).toBe(runId);
      expect(line.project).toBe(root);
      expect(line.test).toBe('tests/recording.md');
      expect(line.suite).toBe('user');
    }
    for (const line of [...actions, ...steps]) {
      expect(line.prompt).toMatch(/^p-[0-9a-f]{6}$/);
      expect(line.source).toBe('ai');
    }
    expect(actions[0]).toMatchObject({ site: 'secure.bank.test', model: 'aibroker/test/model' });

    // One step line per executed step; the retried one is not a first try, and
    // its line carries BOTH attempts' calls and tokens (acceptance 11).
    expect(steps.map((s) => [s.step, s.status, s.firstTry, s.attempts, s.calls])).toEqual([
      [1, 'passed', false, 2, 2],
      [2, 'passed', true, 1, 1],
    ]);
    expect(steps[0]).toMatchObject({ tokensIn: 8500, tokensOut: 270, tokensCached: 3000, stepText: 'Select "Mr" from the Title list' });
    expect(steps[0]).not.toHaveProperty('tokensEstimated');

    // The run line: counts, and the report's own token totals — which are the
    // step lines' sum, since this run made no call outside a step (acceptance 10).
    const report = summary.reports[0]!;
    expect(runs[0]).toMatchObject({ status: 'passed', steps: 2, firstTry: 1, failed: 0 });
    expect(runs[0]!.tokensIn).toBe(report.inputTokens);
    expect(runs[0]!.tokensOut).toBe(report.outputTokens);
    expect(steps.reduce((n, s) => n + s.tokensIn, 0)).toBe(runs[0]!.tokensIn);
    expect(steps.reduce((n, s) => n + s.tokensOut, 0)).toBe(runs[0]!.tokensOut);

    // The link: the run line names the report written, and the anchor built
    // from the failing action's line exists in it (acceptance 1).
    expect(path.isAbsolute(runs[0]!.report!)).toBe(true);
    const html = reportHtml(runs[0]);
    expect(html).toContain(`id="${stepAnchor({ step: actions[0]!.step })}"`);
    expect(html).toContain('id="step-2"');
  });

  it('a failed run: the diagnosis is the one call outside a step, and the totals still add up', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      if (text.includes('post-mortem root-cause analysis')) {
        return {
          text: JSON.stringify({
            rootCause: 'The option text is inside a span.',
            faultCategory: 'test-spec',
            evidence: [],
            suggestedFix: 'Use the role selector.',
            confidence: 'medium',
          }),
          usage: { input_tokens: 7000, output_tokens: 300 },
        };
      }
      if (currentStep(text) === 'Select "Mr" from the Title list') {
        return {
          text: plan([{ action: 'click', selector: '[role="option"]:text-is("Mr")' }]),
          usage: { input_tokens: 4000, output_tokens: 100 },
        };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const summary = await run(root, reports, 'fails.md', '# Fails\n\n## Steps\n1. Select "Mr" from the Title list\n', {
      ai: { ...config(reports).ai, diagnoseFailures: true },
    });
    const report = summary.reports[0]!;
    expect(report.status).toBe('failed');
    expect(report.diagnosis?.rootCause).toBe('The option text is inside a span.');

    const all = await lines();
    const [step] = stepLines(all);
    const [runLine] = runLines(all);
    expect(stepLines(all)).toHaveLength(1);
    expect(step).toMatchObject({ status: 'failed', firstTry: false, attempts: 2, calls: 2, tokensIn: 8000, tokensOut: 200 });
    expect(runLine).toMatchObject({ status: 'failed', steps: 1, firstTry: 0, failed: 1 });
    // Step tokens plus the diagnosis — the call that belongs to no step — are
    // the run line's totals, and those are the report's.
    expect(runLine!.tokensIn).toBe(8000 + 7000);
    expect(runLine!.tokensOut).toBe(200 + 300);
    expect(runLine!.tokensIn).toBe(report.inputTokens);
    expect(runLine!.tokensOut).toBe(report.outputTokens);
  });
});

describe('every call a step makes is counted on its line (§7.1)', () => {
  it('an assertion whose first code did not parse: the regenerated call and the first both count', async () => {
    const { root, reports } = project();
    let codeCalls = 0;
    gw.respond = (text) => {
      if (text.includes('Write a self-executing JavaScript function that evaluates the following assertion.')) {
        codeCalls++;
        return codeCalls === 1
          ? { text: '{"not": "code"}', usage: { input_tokens: 6000, output_tokens: 200 } }
          : { text: '{"code": "ASSERT_OK"}', usage: { input_tokens: 6100, output_tokens: 210 } };
      }
      if (currentStep(text) === 'Verify the receipt says Paid') {
        return {
          text: plan([{ action: 'assert', condition: 'the receipt says Paid', expected: 'Paid' }]),
          usage: { input_tokens: 3000, output_tokens: 50 },
        };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const summary = await run(root, reports, 'assert.md', '# Assert\n\n## Steps\n1. Verify the receipt says Paid\n');
    expect(summary.reports[0]!.status).toBe('passed');
    expect(codeCalls).toBe(2);

    const all = await lines();
    const [step] = stepLines(all);
    expect(step).toMatchObject({ status: 'passed', calls: 3, tokensIn: 3000 + 6000 + 6100, tokensOut: 50 + 200 + 210 });
    // Nothing else was asked, so the step's tokens are the whole run's.
    const [runLine] = runLines(all);
    expect([runLine!.tokensIn, runLine!.tokensOut]).toEqual([step!.tokensIn, step!.tokensOut]);
    // The report counts both code generations as calls too.
    const assertion = summary.reports[0]!.steps[0]!.assertions![0]!;
    expect(assertion.supersededAiInteractions).toHaveLength(1);
    expect(assertion.aiInteraction?.usage).toEqual({ inputTokens: 6100, outputTokens: 210 });
  });
});

describe('exactly one step line per executed step (acceptance 7)', () => {
  it('While and If bodies, and every line of a beforeEach hook, each once — none twice', async () => {
    const { root, reports } = project();
    hooksStub = hooks({ beforeEach: ['Dismiss the cookie banner', 'Close the chat bubble'] });
    let nextButtonAsked = 0;
    gw.respond = (text) => {
      const usage = { input_tokens: 1000, output_tokens: 10 };
      if (text.includes('## Decision — Which Condition Holds?')) {
        if (text.includes('A) the Next button is enabled')) {
          nextButtonAsked++;
          return { text: verdict(nextButtonAsked <= 2 ? 'A' : 'none'), usage };
        }
        if (text.includes('A) the Cash checkbox is ticked')) return { text: verdict('A'), usage };
        throw new Error(`unscripted judge request: ${text.slice(0, 300)}`);
      }
      if (currentStep(text) === undefined) throw new Error(`unscripted request: ${text.slice(0, 300)}`);
      return { text: plan([{ action: 'click', selector: '#it' }]), usage };
    };

    const summary = await run(
      root,
      reports,
      'control.md',
      [
        '# Control',
        '',
        '## Steps',
        '1. Open the statements page',
        '2. While the Next button is enabled, Go to the next page',
        '3. If the Cash checkbox is ticked, then Pay with cash',
        '4. Verify the last page is shown',
        '',
        '### Go to the next page',
        '1. Click Next',
        '',
        '### Pay with cash',
        '1. Click Pay now',
        '',
      ].join('\n'),
    );
    const report = summary.reports[0]!;
    expect(report.status).toBe('passed');

    const all = await lines();
    const steps = stepLines(all);
    const key = (s: { step: number; hook?: string; hookIndex?: number }) => `${s.hook ?? 'main'}:${s.hookIndex ?? '-'}:${s.step}`;

    // Every card the report shows for a step that RAN — not a guard, not a
    // skipped row — has its line, and nothing else has one.
    const guards = new Set(['While the Next button is enabled, Go to the next page', 'If the Cash checkbox is ticked, then Pay with cash']);
    const ran = report.steps.filter((s) => s.status !== 'skipped' && !guards.has(s.instruction));
    expect(steps.map(key).sort()).toEqual(ran.map((s) => key({ step: s.index, hook: s.hookScope, hookIndex: s.hookIndex })).sort());

    // The shape, spelled out: four page steps — the While body twice, the If
    // body once — and two hook lines before each.
    const main = steps.filter((s) => s.hook === undefined);
    expect(main.map((s) => s.stepText)).toEqual([
      'Open the statements page',
      'Click Next',
      'Click Next',
      'Click Pay now',
      'Verify the last page is shown',
    ]);
    const hookLines = steps.filter((s) => s.hook === 'beforeEach');
    expect(hookLines).toHaveLength(main.length * 2);
    expect(hookLines.map((s) => s.hookIndex)).toEqual(main.flatMap(() => [1, 2]));

    // Nothing recorded twice: each step line's actions appear once, and the
    // run line counts exactly the step lines.
    expect(actionLines(all)).toHaveLength(steps.length);
    const [runLine] = runLines(all);
    expect(runLine!.steps).toBe(steps.length);

    // Each hook line's anchor — its place in the scope included — exists, and
    // the second pass of the loop body keeps an id of its own.
    const html = reportHtml(runLine);
    for (const s of hookLines) {
      expect(html).toContain(`id="${stepAnchor({ step: s.step, hook: s.hook, hookIndex: s.hookIndex })}"`);
    }
    const body = main.find((s) => s.stepText === 'Click Next')!;
    expect(html).toContain(`id="${stepAnchor({ step: body.step })}"`);
    expect(html).toContain(`id="${stepAnchor({ step: body.step })}-2"`);
  });

  it('a watch group: its matched step and its continuation, each once, under the numbers the report shows', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      if (text.includes('## Branched Step — Determine Which Outcome Applies')) {
        return {
          text: JSON.stringify({ matched: 'A', reasoning: 'the prompt is up', actions: [{ action: 'click', selector: '#not-now', description: 'x' }] }),
          usage: { input_tokens: 700, output_tokens: 7 },
        };
      }
      if (currentStep(text) === undefined) throw new Error(`unscripted request: ${text.slice(0, 300)}`);
      return { text: plan([{ action: 'click', selector: '#it' }]), usage: { input_tokens: 100, output_tokens: 1 } };
    };

    const summary = await run(
      root,
      reports,
      'watch.md',
      '# Watch\n\n## Steps\n1. Open the login page\n2. If a Remember this device prompt appears, click Not now\n3. Open the dashboard\n',
    );
    expect(summary.reports[0]!.status).toBe('passed');

    const all = await lines();
    const steps = stepLines(all);
    // The group's steps arrive 0-based from the executor and the runner makes
    // them 1-based after — the lines are filed under the report's numbers.
    expect(steps.map((s) => [s.step, s.stepText])).toEqual([
      [1, 'Open the login page'],
      [2, 'If a Remember this device prompt appears, click Not now'],
      [3, 'Open the dashboard'],
    ]);
    const [runLine] = runLines(all);
    expect(runLine!.steps).toBe(3);
    // The poll that chose the outcome belongs to no step (a known gap: it
    // builds no interaction), so it shows only in the run's totals.
    expect(runLine!.tokensIn).toBe(3 * 100 + 700);
    const html = reportHtml(runLine);
    for (const s of steps) expect(html).toContain(`id="${stepAnchor({ step: s.step })}"`);
  });

  it('data rows: one run id for every row, a row on every line, one run line, row anchors in the one report', async () => {
    const { root, reports } = project();
    gw.respond = () => ({ text: plan([{ action: 'click', selector: '#go' }]), usage: { input_tokens: 500, output_tokens: 5 } });

    const summary = await run(
      root,
      reports,
      'rows.md',
      '# Rows\n\n## Steps\n| customer |\n|---|\n| Alice |\n| Bob |\n\n1. Search for {{customer}}\n2. Open the first result\n',
    );
    expect(summary.reports).toHaveLength(1);

    const all = await lines();
    const steps = stepLines(all);
    const runs = runLines(all);
    expect(runs).toHaveLength(1);
    expect(new Set(all.map((l) => l.run))).toEqual(new Set([runs[0]!.run]));
    expect(steps.map((s) => [s.row, s.step])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ]);
    // The placeholder, never the row's value (§5.7).
    expect(steps[0]!.stepText).toBe('Search for {{customer}}');
    expect(runs[0]).toMatchObject({ steps: 4, firstTry: 4, failed: 0 });

    const html = reportHtml(runs[0]);
    for (const s of steps) expect(html).toContain(`id="${stepAnchor({ step: s.step, row: s.row })}"`);
  });
});

describe('masking (acceptance 3)', () => {
  it('a secret-named parameter\'s value is masked in the selector; the step text keeps the placeholder', async () => {
    const { root, reports } = project();
    gw.respond = () => ({
      text: plan([{ action: 'click', selector: 'role=row[name="hunter2-Secret"] >> role=button[name="Edit"]' }]),
      usage: { input_tokens: 100, output_tokens: 1 },
    });
    await run(
      root,
      reports,
      'secret.md',
      '# Secret\n\n## Parameters\n- password: hunter2-Secret\n\n## Steps\n1. Edit the row for {{password}}\n',
    );

    const all = await lines();
    const [action] = actionLines(all);
    expect(action!.selector).toBe('role=row[name="***"] >> role=button[name="Edit"]');
    expect(action!.form).toBe('role');
    expect(stepLines(all)[0]!.stepText).toBe('Edit the row for {{password}}');
    const onDisk = fs.readFileSync(path.join(userRoot, 'steptix', 'stats', fs.readdirSync(path.join(userRoot, 'steptix', 'stats'))[0]!), 'utf-8');
    expect(onDisk).not.toContain('hunter2-Secret');
  });
});

describe('the off switches (acceptance 5)', () => {
  const answer = () => ({ text: plan([{ action: 'click', selector: '#go' }]), usage: { input_tokens: 10, output_tokens: 1 } });

  it('STEPTIX_STATS=off writes nothing', async () => {
    const { root, reports } = project();
    gw.respond = answer;
    process.env['STEPTIX_STATS'] = 'off';
    try {
      await run(root, reports, 'off.md', '# Off\n\n## Steps\n1. Click Go\n');
    } finally {
      delete process.env['STEPTIX_STATS'];
    }
    await flushStatsWrites();
    expect(fs.existsSync(path.join(userRoot, 'steptix', 'stats'))).toBe(false);
  });

  it('a project with stats.enabled false writes nothing, and the next project still records', async () => {
    gw.respond = answer;
    const quiet = project({ stats: { enabled: false } });
    await run(quiet.root, quiet.reports, 'quiet.md', '# Quiet\n\n## Steps\n1. Click Go\n');
    await flushStatsWrites();
    expect(fs.existsSync(path.join(userRoot, 'steptix', 'stats'))).toBe(false);

    const loud = project();
    await run(loud.root, loud.reports, 'loud.md', '# Loud\n\n## Steps\n1. Click Go\n');
    const all = await lines();
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((l) => l.project))).toEqual(new Set([loud.root]));
  });

  it('the switch is the TEST’s project’s, not the working directory’s config (finding 12)', async () => {
    gw.respond = answer;
    // `steptix run` loaded a config that says off — the working directory's — but
    // the test lives in a project that says nothing: its lines are filed under
    // that project, so that project's switch decides.
    const loud = project();
    await run(loud.root, loud.reports, 'loud.md', '# Loud\n\n## Steps\n1. Click Go\n', { stats: { enabled: false } });
    const all = await lines();
    expect(new Set(all.map((l) => l.project))).toEqual(new Set([loud.root]));

    // And the other way round: a run config that records, over a test whose
    // project said never.
    fs.rmSync(path.join(userRoot, 'steptix', 'stats'), { recursive: true, force: true });
    const quiet = project({ stats: { enabled: false } });
    await run(quiet.root, quiet.reports, 'quiet.md', '# Quiet\n\n## Steps\n1. Click Go\n', { stats: { enabled: true } });
    await flushStatsWrites();
    expect(fs.existsSync(path.join(userRoot, 'steptix', 'stats'))).toBe(false);
  });
});

describe('a Stop mid-call (finding 2, contract E)', () => {
  it('stopped during its retry: an interrupted step line, attempts as they happened, and no failure on the run line', async () => {
    const { root, reports } = project();
    const controller = new AbortController();
    let payCalls = 0;
    gw.respond = (text, signal) => {
      if (currentStep(text) === 'Pay for the order') {
        payCalls++;
        if (payCalls === 1) {
          return { text: plan([{ action: 'click', selector: 'button:text-is("Pay")' }]), usage: { input_tokens: 3000, output_tokens: 90 } };
        }
        // The retry's call is in flight when the user presses Stop.
        controller.abort();
        return hangUntilStopped(signal);
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const summary = await runStoppable(root, reports, 'stop.md', '# Stop\n\n## Steps\n1. Pay for the order\n2. Open the receipt\n', controller.signal);
    expect(summary.reports[0]!.aborted).toBe(true);

    const all = await lines();
    const [step] = stepLines(all);
    expect(stepLines(all)).toHaveLength(1);
    expect(step).toMatchObject({
      step: 1,
      status: 'failed',
      interrupted: true,
      attempts: 2,
      firstTry: false,
      calls: 1,
      tokensIn: 3000,
      tokensOut: 90,
    });
    // The first attempt's action is on the record; the stopped call made none.
    expect(actionLines(all).map((a) => [a.exec, a.attempt, a.outcome])).toEqual([[step!.exec, 1, 'no-match']]);
    const [runLine] = runLines(all);
    expect(runLine).toMatchObject({ aborted: true, steps: 1, firstTry: 0, failed: 0 });
  });

  it('stopped during its first attempt\'s assertion code: one attempt, not two — and the plan it made is counted', async () => {
    const { root, reports } = project();
    const controller = new AbortController();
    gw.respond = (text, signal) => {
      if (text.includes(ASSERTION_PROMPT)) {
        controller.abort();
        return hangUntilStopped(signal);
      }
      if (currentStep(text) === 'Verify the receipt says Paid') {
        return {
          text: plan([{ action: 'assert', condition: 'the receipt says Paid', expected: 'Paid' }]),
          usage: { input_tokens: 2000, output_tokens: 40 },
        };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    await runStoppable(root, reports, 'stop-assert.md', '# Stop\n\n## Steps\n1. Verify the receipt says Paid\n', controller.signal);
    const all = await lines();
    const [step] = stepLines(all);
    // `retried: true` was hard-coded on a stop, which read as two attempts.
    expect(step).toMatchObject({ interrupted: true, attempts: 1, calls: 1, tokensIn: 2000, tokensOut: 40 });
    expect(runLines(all)[0]).toMatchObject({ aborted: true, failed: 0 });
  });
});

describe('every call a failing step made is on its line (finding 3)', () => {
  it('an assertion that fails on both attempts: four calls, and all their tokens', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      if (text.includes(ASSERTION_PROMPT)) {
        return { text: '{"code": "ASSERT_FAIL"}', usage: { input_tokens: 8000, output_tokens: 150 } };
      }
      if (currentStep(text) === 'Verify the receipt says Paid') {
        return {
          text: plan([{ action: 'assert', condition: 'the receipt says Paid', expected: 'Paid' }]),
          usage: { input_tokens: 2000, output_tokens: 40 },
        };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const summary = await run(root, reports, 'assert-fails.md', '# Assert\n\n## Steps\n1. Verify the receipt says Paid\n');
    expect(summary.reports[0]!.status).toBe('failed');

    const all = await lines();
    const [step] = stepLines(all);
    expect(step).toMatchObject({ status: 'failed', attempts: 2, calls: 4, tokensIn: 2 * 2000 + 2 * 8000, tokensOut: 2 * 40 + 2 * 150 });
    // Each attempt's verdict, as the structure it is (contract C).
    expect(actionLines(all).map((a) => [a.attempt, a.action, a.outcome])).toEqual([
      [1, 'assert', 'assert-failed'],
      [2, 'assert', 'assert-failed'],
    ]);
    // Step tokens plus the run's own calls (none: diagnosis is off) are the
    // run line's, which are the report's (acceptance 10).
    const [runLine] = runLines(all);
    expect([runLine!.tokensIn, runLine!.tokensOut]).toEqual([step!.tokensIn, step!.tokensOut]);
    expect(runLine!.tokensIn).toBe(summary.reports[0]!.inputTokens);
  });

  it('assertion code that throws twice per attempt: six calls, not none', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      if (text.includes(ASSERTION_PROMPT)) {
        return { text: '{"code": "ASSERT_THROW"}', usage: { input_tokens: 7000, output_tokens: 120 } };
      }
      if (currentStep(text) === 'Verify the receipt says Paid') {
        return {
          text: plan([
            { action: 'click', selector: '#receipt' },
            { action: 'assert', condition: 'the receipt says Paid', expected: 'Paid' },
          ]),
          usage: { input_tokens: 2500, output_tokens: 60 },
        };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };

    const summary = await run(root, reports, 'assert-throws.md', '# Assert\n\n## Steps\n1. Verify the receipt says Paid\n');
    expect(summary.reports[0]!.status).toBe('failed');

    const all = await lines();
    const [step] = stepLines(all);
    expect(step).toMatchObject({
      status: 'failed',
      attempts: 2,
      calls: 2 + 4,
      tokensIn: 2 * 2500 + 4 * 7000,
      tokensOut: 2 * 60 + 4 * 120,
    });
    // The click each attempt ran before its assertion threw is on the record.
    expect(actionLines(all).map((a) => [a.attempt, a.action, a.outcome])).toEqual([
      [1, 'click', 'ok'],
      [2, 'click', 'ok'],
    ]);
    const [runLine] = runLines(all);
    expect([runLine!.tokensIn, runLine!.tokensOut]).toEqual([step!.tokensIn, step!.tokensOut]);
    expect(runLine!.tokensIn).toBe(summary.reports[0]!.inputTokens);
  });
});

describe('a step that asked the model nothing writes no line (finding 4, contract D)', () => {
  it('a flow-control condition this run\'s values answered', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      if (currentStep(text) === 'Open the payments page') {
        return { text: plan([{ action: 'click', selector: '#payments' }]), usage: { input_tokens: 100, output_tokens: 1 } };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };
    const summary = await run(
      root,
      reports,
      'local.md',
      '# Local\n\n## Parameters\n- status: Overdue\n\n## Steps\n1. Open the payments page\n2. If {{status}} is "Overdue", then return\n3. Pay the invoice\n',
    );
    // The return was taken, and step 3 skipped.
    expect(summary.reports[0]!.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'skipped']);
    const all = await lines();
    expect(stepLines(all).map((s) => s.stepText)).toEqual(['Open the payments page']);
    expect(runLines(all)[0]).toMatchObject({ steps: 1, firstTry: 1, failed: 0 });
  });

  it('a [use ai] step refused before it was sent', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      throw new Error(`the model must not be asked: ${text.slice(0, 200)}`);
    };
    const summary = await run(root, reports, 'refused.md', '# Refused\n\n## Steps\n1. [use ai] Repeat {{nothing_here}} exactly [store as: copy]\n');
    expect(summary.reports[0]!.steps[0]!.status).toBe('failed');
    expect(gw.requests).toEqual([]);
    const all = await lines();
    expect(stepLines(all)).toEqual([]);
    expect(actionLines(all)).toEqual([]);
    // The run still links its report, and counts no step.
    expect(runLines(all)[0]).toMatchObject({ steps: 0, failed: 0 });
  });

  it('a run with no AI key: every step fails before a call, and none is recorded', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      throw new Error(`the model must not be asked: ${text.slice(0, 200)}`);
    };
    const keyless = config(reports);
    const summary = await runTests(
      [await writeAndParse(root, 'keyless.md', '# Keyless\n\n## Steps\n1. Click Go\n')],
      { ...keyless, ai: { ...keyless.ai, apiKey: undefined } as unknown as Config['ai'] },
    );
    expect(summary.reports[0]!.status).toBe('failed');
    expect(gw.requests).toEqual([]);
    const all = await lines();
    expect(stepLines(all)).toEqual([]);
    expect(runLines(all)[0]).toMatchObject({ steps: 0 });
  });

  it('a run that forbids AI (ai.allowInRuns: false): the same', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      throw new Error(`the model must not be asked: ${text.slice(0, 200)}`);
    };
    const forbidding = config(reports);
    const summary = await runTests(
      [await writeAndParse(root, 'policy.md', '# Policy\n\n## Steps\n1. Click Go\n')],
      { ...forbidding, ai: { ...forbidding.ai, allowInRuns: false } },
    );
    expect(summary.reports[0]!.status).toBe('failed');
    expect(gw.requests).toEqual([]);
    const all = await lines();
    expect(stepLines(all)).toEqual([]);
  });
});

describe('a hook step is recorded as authored (finding 9)', () => {
  it('its ${…} intact, not the value the parse baked in — and the value never reaches the file', async () => {
    const { root, reports } = project();
    // What `resolveHooks` hands the runner for `- before: Sign in as ${env.USER_NAME}`
    // parsed under an environment: the line baked, and the line as written.
    hooksStub = {
      ...hooks({ before: ['Sign in as alice-SECRET-name'] }),
      authored: { before: ['Sign in as ${env.USER_NAME}'], beforeEach: [], afterEach: [], after: [] },
    };
    gw.respond = () => ({ text: plan([{ action: 'click', selector: '#go' }]), usage: { input_tokens: 10, output_tokens: 1 } });
    await run(root, reports, 'hook.md', '# Hook\n\n## Steps\n1. Click Go\n');
    const all = await lines();
    const hook = stepLines(all).find((s) => s.hook === 'before')!;
    expect(hook).toMatchObject({ hookIndex: 1, stepText: 'Sign in as ${env.USER_NAME}' });
    const onDisk = fs.readFileSync(path.join(userRoot, 'steptix', 'stats', fs.readdirSync(path.join(userRoot, 'steptix', 'stats'))[0]!), 'utf-8');
    expect(onDisk).not.toContain('alice-SECRET-name');
  });
});

describe('site, model and exec on step lines (contracts A and B)', () => {
  it('each execution numbered once, shared by the step line and its actions', async () => {
    const { root, reports } = project();
    gw.respond = () => ({
      text: plan([{ action: 'click', selector: '#go' }, { action: 'click', selector: '#next' }]),
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    await run(root, reports, 'exec.md', '# Exec\n\n## Steps\n1. Click Go\n2. Click Next\n');
    const all = await lines();
    const steps = stepLines(all);
    expect(steps.map((s) => [s.step, s.exec])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(actionLines(all).map((a) => [a.step, a.exec])).toEqual([
      [1, 1],
      [1, 1],
      [2, 2],
      [2, 2],
    ]);
    for (const s of steps) expect(s).toMatchObject({ site: 'secure.bank.test', model: 'aibroker/test/model' });
  });
});

/** Write a test file into a project and parse it, as `run` does. */
async function writeAndParse(root: string, name: string, markdown: string) {
  const file = path.join(root, 'tests', name);
  fs.writeFileSync(file, markdown);
  return parseTestFile(file);
}

describe('a skill body\'s steps are recorded as authored (finding 9)', () => {
  it('without the __skill<N>_ renames the expander put on their placeholders', async () => {
    const { root, reports } = project();
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'skills', 'find_order.md'),
      '---\ntype: skill\n---\n\n# find_order\n\n## Steps\n1. Read the order number [store as: order]\n2. Search for {{order}}\n',
    );
    const file = path.join(root, 'tests', 'skill.md');
    fs.writeFileSync(file, '# Skill\n\n## Steps\n1. [skill: find_order]\n');
    const test = await parseTestFile(file, { skillsDir: path.join(root, 'skills') });
    // The premise: the expander renamed the skill's own variable.
    expect(test.steps.join('\n')).toContain('__skill1_order');

    gw.respond = () => ({ text: plan([{ action: 'click', selector: '#search' }]), usage: { input_tokens: 10, output_tokens: 1 } });
    await runTests([test], config(reports));
    const all = await lines();
    expect(stepLines(all).map((s) => s.stepText)).toEqual([
      'Read the order number [store as: order]',
      'Search for {{order}}',
    ]);
    const dir = path.join(userRoot, 'steptix', 'stats');
    expect(fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf-8')).join('')).not.toContain('__skill');
  });
});

describe('more Stops, and an error the model wrote (findings 2 and 10)', () => {
  it('a Stop inside a hook step: the run reports as stopped, and counts no failure', async () => {
    // A `[use ai]` hook line: the one hook path the CLI hands its Stop signal
    // (a prose hook's `executeStep` is given none, a gap that predates this).
    const { root, reports } = project();
    const controller = new AbortController();
    hooksStub = hooks({ beforeEach: ['[use ai] Make up a banner id [store as: banner]'] });
    let hookCalls = 0;
    gw.respond = (_text, signal) => {
      hookCalls++;
      // Its first reply could not be used…
      if (hookCalls === 1) return { text: 'not json at all', usage: { input_tokens: 500, output_tokens: 5 } };
      // …and the retry is in flight when the user stops.
      controller.abort();
      return hangUntilStopped(signal);
    };
    const summary = await runStoppable(root, reports, 'hook-stop.md', '# Hook stop\n\n## Steps\n1. Open the dashboard\n', controller.signal);
    // The hook row, not the main loop, came back interrupted — the report
    // still reads as stopped.
    expect(summary.reports[0]!.aborted).toBe(true);
    const all = await lines();
    const [hook] = stepLines(all);
    expect(stepLines(all)).toHaveLength(1);
    expect(hook).toMatchObject({ hook: 'beforeEach', interrupted: true, attempts: 2, calls: 1 });
    expect(runLines(all)[0]).toMatchObject({ aborted: true, steps: 1, failed: 0 });
  });

  it('a Stop inside a [use ai] step whose first reply could not be used: interrupted, both attempts, one call', async () => {
    const { root, reports } = project();
    const controller = new AbortController();
    let calls = 0;
    gw.respond = (text, signal) => {
      calls++;
      if (calls === 1) return { text: 'not json at all', usage: { input_tokens: 40, output_tokens: 4 } };
      controller.abort();
      return hangUntilStopped(signal);
    };
    await runStoppable(root, reports, 'use-ai-stop.md', '# Use ai stop\n\n## Steps\n1. [use ai] Make up a customer name [store as: name]\n', controller.signal);
    const all = await lines();
    const [step] = stepLines(all);
    expect(step).toMatchObject({ interrupted: true, attempts: 2, calls: 1, tokensIn: 40 });
    expect(step).not.toHaveProperty('prompt');
    expect(runLines(all)[0]).toMatchObject({ aborted: true, failed: 0 });
  });

  it('a readTable refusal that quotes the model\'s structure answer is not read for Playwright\'s wording', async () => {
    const { root, reports } = project();
    gw.respond = (text) => {
      if (text.includes('You are reading the STRUCTURE of one region of a web page')) {
        // The model's own words — which happen to say "timed out" and "while
        // parsing selector".
        return {
          text: JSON.stringify({ kind: 'none', reason: 'the grid timed out while parsing selector input' }),
          usage: { input_tokens: 900, output_tokens: 20 },
        };
      }
      if (currentStep(text) === 'Read the statement dates') {
        return {
          text: plan([{ action: 'readTable', selector: '#grid', columns: [{ header: 'Date', key: 'date' }], as: 'dates' }]),
          usage: { input_tokens: 1200, output_tokens: 30 },
        };
      }
      throw new Error(`unscripted request: ${text.slice(0, 300)}`);
    };
    const summary = await run(root, reports, 'read-table.md', '# Read table\n\n## Steps\n1. Read the statement dates\n');
    expect(summary.reports[0]!.status).toBe('failed');
    // The premise: the recorded error does quote the model.
    const sub = summary.reports[0]!.steps[0]!.turns[0]!.subActions[0]!;
    expect(sub.error).toContain('the grid timed out while parsing selector input');
    const all = await lines();
    expect(actionLines(all).map((a) => [a.action, a.outcome])).toEqual([['readTable', 'other']]);
    // Both calls — the plan and the structure question — on the step.
    expect(stepLines(all)[0]).toMatchObject({ calls: 2, tokensIn: 2100 });
  });
});
