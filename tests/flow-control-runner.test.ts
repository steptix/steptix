/**
 * The CLI run loop, once a step returns (stories/step-flow-control.md §Tests,
 * "CLI loop").
 *
 * Run through the real `runTest` with the browser, executor and AI mocked out
 * — the harness shape `codebehind-healed-run.test.ts` established — because
 * every claim here is about the LOOP: which results it pushes, which hooks it
 * runs, where it resumes, and what it puts on the report. None of that is
 * reachable from a unit test of the helper.
 *
 * The test documents are parsed by the real parser and expanded by the real
 * expander, so the frame table the loop reads is the one a run would get.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';
import type { ResolvedHooks } from '../src/runner/hooks.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { readLastRun } from '../src/codebehind/last-run.js';

// ─── Harness ────────────────────────────────────────────────────────────────

const launchBrowserMock = vi.fn();
const closeBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: (...args: unknown[]) => closeBrowserMock(...args),
  resolveVideoMode: () => 'off',
  finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
    await args.closeContext();
    return undefined;
  },
  // The 'no browser yet' sentinel (SPEC-use-computer.md §4.6). A mock of
  // this module must export it: api-server and session-manager both do
  // `instanceof` against it, and `instanceof undefined` throws.
  NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {
    constructor(message = 'no browser has been launched in this session') {
      super(message);
      this.name = 'NoBrowserLaunchedError';
    }
  },
  NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
  BrowserTracker: class BrowserTrackerStub {
    private session: unknown;
    private launch: (() => Promise<unknown>) | undefined;
    constructor(initial: unknown) { this.session = initial; }
    getActive() {
      if (this.session === undefined) {
        throw new Error('no browser has been launched in this session');
      }
      return this.session;
    }
    getActivePage() { return (this.getActive() as { page: unknown }).page; }
    has() { return false; }
    add() {}
    switchTo() { return this.session; }
    async close() {}
    async closeAll() { if (this.session !== undefined) closeBrowserMock(this.session); }
    list() { return []; }
    get count() { return this.session === undefined ? 0 : 1; }
    // ── Lazy launch (SPEC-use-computer.md §4.6) ──
    // Modelled rather than stubbed: the deferred tracker starts EMPTY, so a
    // runner that forgot to call ensureLaunched() fails here instead of
    // quietly getting a browser it never asked for.
    hasActive() { return this.session !== undefined; }
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

/** Every `executeStep` call the run made, in order — hooks included. */
const executeStepCalls: Array<{ index: number; instruction: string; opts: Record<string, unknown> }> = [];
const executeStepMock = vi.fn();
/** The conditional-group path. Answers with a real `StepResult[]` so the loop
 *  files the same rows a branched step has always produced — including the
 *  `skipped` one for the branch that did not match. */
const executeBranchedStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => {
    executeStepCalls.push({
      index: args[0] as number,
      instruction: args[2] as string,
      opts: args[3] as Record<string, unknown>,
    });
    return executeStepMock(...args);
  },
  executeBranchedStep: (...args: unknown[]) => executeBranchedStepMock(...args),
}));

let hooksStub: ResolvedHooks = emptyHooks();
vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: vi.fn(async () => hooksStub),
}));

vi.mock('../src/ai/diagnose.js', () => ({ diagnoseFailure: vi.fn(async () => null) }));
vi.mock('../src/ai/client.js', () => ({
  AiClient: class { setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
}));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

const generatedReports: TestReport[] = [];
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn(async (report: TestReport) => {
    generatedReports.push(report);
    return '';
  }),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));

vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn(async () => undefined),
}));

import { runTest } from '../src/runner/test-runner.js';
import { parseTestFile } from '../src/parser/markdown.js';
// The real renderer — only `generateReport`'s disk write is stubbed above.
import { renderReport } from '../src/report/generator.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** This run's own directory, made in `beforeAll`. A fixed name was shared by
 *  every run in the checkout: two at once (a `--watch` beside a full run)
 *  wrote and deleted each other's documents, and a run whose teardown lost to
 *  a Windows lock left `t0…tN` behind for the next one to write over. */
let tmpBase: string;

/** The two flow-control lines the fixtures below use, written once because
 *  every reason string now quotes the returning step's AUTHORED line back —
 *  the half a reader can find in the editor, where the expanded `step N` is
 *  not a number anything on screen carries. */
const STOP_STEP = 'If the page title contains "Dashboard" then stop running the remaining steps';
const RETURN_STEP = 'If the page title contains "Dashboard" then return';

function emptyHooks(): ResolvedHooks {
  return {
    before: [], beforeEach: [], afterEach: [], after: [],
    hasAny: false,
    toolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    sourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  };
}

function makeConfig(): Config {
  return { ...DEFAULT_CONFIG, browser: { ...DEFAULT_CONFIG.browser, headed: false } };
}

/** Write a test document, parse it for real, and hand back a runnable
 *  instance — so `test.expansion` is the expander's own table.
 *
 *  `parameters` seeds the live variable map the way a capture would have: the
 *  loop tests below need a list in scope before step 1, and `## Parameters`
 *  is not resolved on this path (`resolvedParameters` arrives from the
 *  caller, which in a real run is `resolveParameters`). */
async function instanceOf(
  name: string,
  markdown: string,
  parameters: Record<string, string> = {},
): Promise<TestInstance> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, markdown);
  const test: ParsedTest = await parseTestFile(filePath);
  return { test, resolvedParameters: { ...parameters } };
}

function passed(index: number, instruction: string): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

/** What the executor returns for a conditional flow-control step whose
 *  condition held: passed, with the signal and the model's own words. */
function returned(index: number, instruction: string, detail: string): StepResult {
  return {
    ...passed(index, instruction),
    aiExplanation: detail,
    flowControl: { kind: 'return', verb: 'return' },
  };
}

/** Answer every step by its 1-based index, with named exceptions. */
function respond(overrides: Record<number, (instruction: string) => StepResult>): void {
  executeStepMock.mockImplementation(
    async (index: number, _total: number, instruction: string) =>
      (overrides[index] ?? ((s: string) => passed(index, s)))(instruction),
  );
}

/** `index → status` for the real steps of the run (hooks excluded). */
function statuses(report: TestReport): Array<[number, string]> {
  return report.steps
    .filter((s) => !s.hookScope)
    .map((s) => [s.index, s.status] as [number, string]);
}

let dir: string;
let counter = 0;

beforeAll(async () => {
  tmpBase = await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-flow-control-runner-'));
});

beforeEach(async () => {
  executeStepMock.mockReset();
  executeBranchedStepMock.mockReset();
  executeStepCalls.length = 0;
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  generatedReports.length = 0;
  hooksStub = emptyHooks();
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'https://app.test/', goto: vi.fn(async () => undefined) },
  });
  closeBrowserMock.mockResolvedValue(undefined);
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  if (tmpBase) await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ─── A return in the main flow ──────────────────────────────────────────────

describe('a main-flow return', () => {
  const doc = `# t

## Steps
1. Navigate to /
2. If the page title contains "Dashboard" then stop running the remaining steps
3. Click "Sign out"
4. Verify the login form is shown
`;

  it('ends the run as a PASS, with the rest skipped and a reason on each', async () => {
    respond({ 2: (s) => returned(2, s, 'the title already reads Dashboard') });
    const report = await runTest(await instanceOf('main.md', doc), makeConfig());

    expect(report.status).toBe('passed');
    expect(statuses(report)).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [3, 'skipped'],
      [4, 'skipped'],
    ]);
    expect(report.steps[2]!.aiExplanation).toBe(`Not run: step 2 ended the run — ${STOP_STEP}`);
    expect(report.steps[3]!.aiExplanation).toBe(`Not run: step 2 ended the run — ${STOP_STEP}`);
    // The returning step names the flow it left and keeps the model's words.
    expect(report.steps[1]!.aiExplanation).toBe(
      'Ended the run: the title already reads Dashboard',
    );
    expect(report.steps[1]!.flowControl).toEqual({ kind: 'return', verb: 'return' });
  });

  it('never runs the skipped steps — the model is asked twice, not four times', async () => {
    respond({ 2: (s) => returned(2, s, 'done') });
    await runTest(await instanceOf('main.md', doc), makeConfig());
    expect(executeStepCalls.map((c) => c.index)).toEqual([1, 2]);
  });

  it('does NOT read as a timeout, and counts skipped separately', async () => {
    // The count-based `timedOut` inference would have flipped this run to
    // failed: two of four steps never produced an executed result.
    respond({ 2: (s) => returned(2, s, 'done') });
    const report = await runTest(await instanceOf('main.md', doc), makeConfig());

    expect(report.status).toBe('passed');
    expect(report.totalSteps).toBe(4);
    expect(report.passedSteps).toBe(2);
    expect(report.failedSteps).toBe(0);
    expect(report.skippedSteps).toBe(2);
  });

  it('omits skippedSteps entirely on a run that returned nothing', async () => {
    respond({});
    const report = await runTest(await instanceOf('main.md', doc), makeConfig());
    expect(report.status).toBe('passed');
    expect(report.skippedSteps).toBeUndefined();
  });

  it('passes the claim to the executor for the conditional form only', async () => {
    respond({ 2: (s) => returned(2, s, 'done') });
    await runTest(await instanceOf('main.md', doc), makeConfig());

    expect(executeStepCalls[0]!.opts.flowControlClaim).toBeUndefined();
    expect(executeStepCalls[1]!.opts.flowControlClaim).toEqual({
      verb: 'stop',
      body: 'the page title contains "Dashboard"',
    });
  });
});

// ─── The unconditional form ─────────────────────────────────────────────────

describe('a bare `Return` step', () => {
  it('costs no model call at all and still ends the flow', async () => {
    respond({});
    const report = await runTest(
      await instanceOf('bare.md', `# t

## Steps
1. Navigate to /
2. Stop
3. Click "Sign out"
`),
      makeConfig(),
    );

    // Step 2 never reached the executor (decision 3).
    expect(executeStepCalls.map((c) => c.index)).toEqual([1]);
    expect(statuses(report)).toEqual([[1, 'passed'], [2, 'passed'], [3, 'skipped']]);
    expect(report.steps[1]!.aiExplanation).toBe('Ended the run');
    expect(report.steps[1]!.flowControl).toEqual({ kind: 'return', verb: 'stop' });
    expect(report.status).toBe('passed');
  });
});

// ─── A return inside a section ──────────────────────────────────────────────

describe('a return inside a section', () => {
  const doc = `# t

## Steps
1. Navigate to /
2. Sign in
3. Click "Sign out"

### Sign in
1. If the page title contains "Dashboard" then return
2. Enter the username
3. Enter the password
4. Click Sign in
`;

  it('ends the section body and the main flow carries on after the call', async () => {
    // Flat list: [Navigate, body1..body4, Click "Sign out"]
    respond({ 2: (s) => returned(2, s, 'already signed in') });
    const report = await runTest(await instanceOf('section.md', doc), makeConfig());

    expect(statuses(report)).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [3, 'skipped'],
      [4, 'skipped'],
      [5, 'skipped'],
      [6, 'passed'],
    ]);
    // The reason names the section, not the run.
    expect(report.steps[2]!.aiExplanation).toBe(`Not run: step 2 returned from "Sign in" — ${RETURN_STEP}`);
    expect(report.steps[1]!.aiExplanation).toBe(
      'Returned from "Sign in": already signed in',
    );
    expect(report.status).toBe('passed');
    // The step after the section really ran.
    expect(executeStepCalls.map((c) => c.index)).toEqual([1, 2, 6]);
  });
});

// ─── A return inside a looped section ───────────────────────────────────────

describe('a return inside a looped section', () => {
  it('ends ONE iteration; the next iteration starts', async () => {
    const doc = `# t

## Steps
1. Check each

### Check each

| term |
| --- |
| shoes |
| hats |

1. Search for {{term}}
2. If there are no results then return
3. Open the first result
`;
    // Iteration 1 returns at its second step; iteration 2 runs in full.
    respond({ 2: (s) => returned(2, s, 'no results for shoes') });
    const report = await runTest(await instanceOf('loop.md', doc), makeConfig());

    expect(statuses(report)).toEqual([
      [1, 'passed'],   // Search for shoes
      [2, 'passed'],   // returned
      [3, 'skipped'],  // Open the first result — iteration 1 only
      [4, 'passed'],   // Search for hats
      [5, 'passed'],   // If there are no results then return (did not hold)
      [6, 'passed'],   // Open the first result
    ]);
    expect(report.status).toBe('passed');
  });
});

// ─── Hooks ──────────────────────────────────────────────────────────────────

describe('hooks around a return', () => {
  const doc = `# t

## Steps
1. Navigate to /
2. Stop
3. Click "Sign out"
4. Verify the login form is shown
`;

  it('runs afterEach for the returning step and for NO skipped step, and still runs `after`', async () => {
    hooksStub = {
      ...emptyHooks(),
      hasAny: true,
      beforeEach: ['dismiss any banner'],
      afterEach: ['snapshot the page'],
      after: ['log out of the API'],
      toolCalls: { before: [], beforeEach: [null], afterEach: [null], after: [null] },
      sourceSkills: { before: [], beforeEach: [null], afterEach: [null], after: [null] },
    };
    respond({});

    const report = await runTest(await instanceOf('hooks.md', doc), makeConfig());

    const hookRuns = report.steps
      .filter((s) => s.hookScope)
      .map((s) => `${s.hookScope}@${s.index}`);
    // Steps 1 and 2 each get their pair; steps 3 and 4 never ran, so they get
    // nothing. `after` runs once, at totalSteps + 1.
    expect(hookRuns).toEqual([
      'beforeEach@1', 'afterEach@1',
      'beforeEach@2', 'afterEach@2',
      'after@5',
    ]);
    expect(report.status).toBe('passed');
  });

  // SPEC-structured-table-reads.md §7.10: ONE structure question per
  // structure per RUN. The memo is the layer that makes that true across
  // STEPS, and it is keyed by the region and the columns asked of it — not
  // by where the read sits. So a `before` hook that reads a
  // legacy grid to establish a starting state, and step 1 that reads the same
  // grid, are one structure and must cost one question; the hook call site
  // was the one that passed no memo, so they cost two.
  it('gives a hook step the same run-wide structure memo as an ordinary step', async () => {
    hooksStub = {
      ...emptyHooks(),
      hasAny: true,
      before: ['read the holdings grid'],
      afterEach: ['snapshot the page'],
      toolCalls: { before: [null], beforeEach: [], afterEach: [null], after: [] },
      sourceSkills: { before: [null], beforeEach: [], afterEach: [null], after: [] },
    };
    respond({});

    await runTest(await instanceOf('hookmemo.md', doc), makeConfig());

    const memos = executeStepCalls.map((c) => c.opts['structureMemo']);
    // Every call has one...
    expect(memos.every((m) => m instanceof Map)).toBe(true);
    // ...and it is the SAME one. A memo per call site would be a memo per
    // step, and ask the same structure question again at every one.
    expect(new Set(memos).size).toBe(1);
  });

  it('fails the hook when a flow-control line reaches a hook scope anyway', async () => {
    // `## Hooks` and project `defaultHooks` are refused earlier; this is the
    // backstop for a hook that arrived some other way (decision 8).
    hooksStub = {
      ...emptyHooks(),
      hasAny: true,
      before: ['If we are already signed in then return'],
      toolCalls: { before: [null], beforeEach: [], afterEach: [], after: [] },
      sourceSkills: { before: [null], beforeEach: [], afterEach: [], after: [] },
    };
    respond({});

    const report = await runTest(await instanceOf('hookflow.md', doc), makeConfig());

    expect(report.status).toBe('failed');
    const hook = report.steps.find((s) => s.hookScope === 'before')!;
    expect(hook.status).toBe('failed');
    expect(hook.error).toContain('flow control is not allowed in hooks');
    // The hook never reached the model.
    expect(executeStepCalls).toHaveLength(0);
  });

  it('hands no claim to a hook, even one wrapped around a step that has one', async () => {
    // Negative space. The hook loop builds its own executor options rather
    // than forwarding the step's, so a `return` action arriving on a hook step
    // meets no claim and is refused with RETURN_NOT_CLAIMED — the refusal
    // itself is pinned against the real executor in
    // `tests/flow-control-executor.test.ts`. What is checkable here is the
    // input to that decision: whether a claim ever reaches the hook.
    hooksStub = {
      ...emptyHooks(),
      hasAny: true,
      beforeEach: ['dismiss any banner'],
      afterEach: ['snapshot the page'],
      toolCalls: { before: [], beforeEach: [null], afterEach: [null], after: [] },
      sourceSkills: { before: [], beforeEach: [null], afterEach: [null], after: [] },
    };
    respond({});

    await runTest(
      await instanceOf('hookclaim.md', `# t

## Steps
1. Navigate to /
2. ${STOP_STEP}
3. Click "Sign out"
`),
      makeConfig(),
    );

    // Step 2 is the only line that claims the form. Every other call — both
    // hooks around it included — must arrive without one, or a hook could end
    // the run from a line nobody wrote as flow control.
    const claimed = executeStepCalls
      .filter((c) => c.opts['flowControlClaim'] !== undefined)
      .map((c) => c.instruction);
    expect(claimed).toEqual([STOP_STEP]);
    // And the hooks really ran, so the assertion above is not vacuous.
    expect(executeStepCalls.map((c) => c.instruction)).toContain('dismiss any banner');
    expect(executeStepCalls.map((c) => c.instruction)).toContain('snapshot the page');
  });
});

// ─── The report ─────────────────────────────────────────────────────────────

describe('the HTML report of a run that returned', () => {
  it('counts skipped separately and says why each step never ran', async () => {
    respond({ 2: (s) => returned(2, s, 'the title already reads Dashboard') });
    const report = await runTest(
      await instanceOf('report.md', `# t

## Steps
1. Navigate to /
2. If the page title contains "Dashboard" then stop
3. Click "Sign out"
`),
      makeConfig(),
    );
    const html = renderReport(report);

    // A green banner, and a Skipped stat beside Passed and Failed — the header
    // must not imply the skipped step passed.
    expect(html).toMatch(/badge badge-pass">✓ PASSED</);
    expect(html).toMatch(/stat-skip">1</);
    expect(html).toContain('>Skipped<');
    // The reason is on the row. A skipped step has no turns, so without it the
    // body would be empty and "SKIPPED" alone would be the whole story.
    expect(html).toContain('Not run: step 2 ended the run —');
    // …and the returning step's own line rides along, so a reader with only the
    // report can find the step that ended the run. HTML-escaped in the cell,
    // which is why the quotes are not matched literally.
    expect(html).toMatch(/Not run: step 2 ended the run — If the page title contains [^<]*Dashboard[^<]*then stop/);
  });

  it('shows no Skipped stat at all on an ordinary run', async () => {
    // The fixture is deliberately conditional-free: `skippedSteps` counts EVERY
    // skipped row, and a conditional group produces one of its own (see the
    // test below). A fixture with an `If …` in it would pass this assertion
    // only by accident of the branch that happened to match.
    respond({});
    const report = await runTest(
      await instanceOf('plain.md', `# t

## Steps
1. Navigate to /
2. Click "Sign out"
`),
      makeConfig(),
    );
    expect(renderReport(report)).not.toContain('>Skipped<');
  });

  it('counts the unmatched branch of a conditional group, which nothing counted before', async () => {
    // Not a return, and not new behaviour: `executeBranchedStep` has always
    // filed the branch that did not match as `status: 'skipped'`, and the
    // header simply left it out. Counting every skipped row is what makes the
    // returned-run tile honest, and it makes this one appear too — a change to
    // reports of tests that have no flow-control step in them at all.
    //
    // Deliberate, and the more honest of the two: the row already said SKIPPED,
    // so the old header was printing "2/3 passed" over a report whose third row
    // contradicted it. Pinned here because it is the kind of change a later
    // reader would otherwise "fix" back.
    respond({});
    // 0-BASED, which is what the real `executeBranchedStep` emits: its indices
    // come straight off `identifyStepGroups`, whose `index` is an offset into
    // the step array. The runner converts once, on entry to the branched
    // block, and everything downstream of that is the display number
    // (stories/control-flow.md, review round 3 finding 6 — before the
    // conversion the block's own rows read `1, 1, 2, 4`). This mock used to
    // send 1-based indices and pass only because nothing converted them.
    executeBranchedStepMock.mockImplementation(async () => [
      // The conditional the model matched — step 2, index 1…
      { index: 1, instruction: 'If a cookie banner is shown, dismiss it', status: 'passed', turns: [], durationMs: 1, retried: false },
      // …and the continuation it therefore did not take — step 3, index 2.
      { index: 2, instruction: 'Click "Sign in"', status: 'skipped', turns: [], durationMs: 0, retried: false, aiExplanation: 'Conditional branch not taken' },
    ]);

    const report = await runTest(
      await instanceOf('branched.md', `# t

## Steps
1. Navigate to /
2. If a cookie banner is shown, dismiss it
3. Click "Sign in"
`),
      makeConfig(),
    );

    expect(executeBranchedStepMock).toHaveBeenCalledTimes(1);
    expect(report.status).toBe('passed');
    expect(report.skippedSteps).toBe(1);
    expect(statuses(report)).toEqual([[1, 'passed'], [2, 'passed'], [3, 'skipped']]);
    const html = renderReport(report);
    expect(html).toContain('>Skipped<');
    expect(html).toMatch(/stat-skip">1</);
  });
});

// ─── Interaction with the prefix bound and the sidecar ──────────────────────

describe('the jump respects the run`s own bounds', () => {
  it('never reports a step past `stopAfterStep` as skipped', async () => {
    respond({ 2: (s) => returned(2, s, 'done') });
    const report = await runTest(
      await instanceOf('prefix.md', `# t

## Steps
1. Navigate to /
2. If the dashboard is shown then stop
3. Click "Sign out"
4. Verify the login form is shown
5. Close the browser
`),
      makeConfig(),
      undefined,
      { stopAfterStep: 3 },
    );

    // Only steps 1–3 were ever in this run, so only step 3 is skipped.
    expect(statuses(report)).toEqual([[1, 'passed'], [2, 'passed'], [3, 'skipped']]);
  });

  it('keeps skipped steps out of the code-behind sidecar', async () => {
    // The sidecar answers "which entries does the next compile need to
    // regenerate". A step that never ran is no evidence either way
    // (decision 12), and recording it would file a verdict on code nobody ran.
    respond({ 2: (s) => returned(2, s, 'done') });
    const instance = await instanceOf('sidecar.md', `# t

## Steps
1. Navigate to /
2. If the dashboard is shown then stop
3. Click "Sign out"
`);
    await runTest(instance, makeConfig());

    const sidecar = await readLastRun(instance.test.filePath);
    expect(sidecar?.steps.map((s) => s.index)).toEqual([1, 2]);
  });
});

// ─── A dotted reference the pass cannot answer ──────────────────────────────

/**
 * `{{order.missing}}` inside a `For each` body, through the CLI loop
 * (docs/specs/SPEC-structured-table-reads.md §8.3).
 *
 * The rule is "fail before the model is asked", and only a loop-level test can
 * say that: the helper on its own proves the sentence, not that the refusal
 * happens early enough to matter. So every assertion below is about
 * `executeStepMock` — what the model was handed, and what it was never handed.
 *
 * Seeded through `resolvedParameters` rather than by a `readTable` step,
 * because the planner's contract is with the JSON in the variable map and not
 * with the action that wrote it. A tool returning an array puts the same
 * string there.
 */
describe('a dotted reference inside a For each body', () => {
  const ROWS = '[{"id":"ORD-1001","status":"Completed"},{"id":"ORD-1002","status":"Pending"}]';

  const doc = (bodyStep: string): string => `# t

## Steps
1. Navigate to /
2. For each {{order}} in {{orders}}, Check the order
3. Sign out

### Check the order
1. ${bodyStep}
`;

  /** Every instruction the executor was actually given. */
  const asked = (): string[] => executeStepCalls.map((c) => c.instruction);

  it('fails the step before any model call, naming the pass and the properties', async () => {
    respond({});
    const report = await runTest(
      await instanceOf('dotted-missing.md', doc('Verify {{order.missing}} is shown'), {
        orders: ROWS,
      }),
      makeConfig(),
    );

    const message =
      '{{order.missing}} has no value in For each item 1; available properties are id, status';
    const failed = report.steps.find((s) => s.status === 'failed');
    expect(failed?.error).toBe(message);
    expect(failed?.aiExplanation).toBe(message);

    // The point of the test: the body step never reached the executor, so the
    // model was never asked to plan an action for a line carrying six literal
    // braces — which is what the failure would otherwise have looked like,
    // three steps from the typo.
    expect(asked()).toEqual(['Navigate to /']);
    expect(report.status).toBe('failed');
  });

  it('substitutes a real property into the text the model receives, per pass', async () => {
    respond({});
    const report = await runTest(
      await instanceOf('dotted-ok.md', doc('Verify the row for "{{order.id}}" is {{order.status}}'), {
        orders: ROWS,
      }),
      makeConfig(),
    );

    // One pass per row, each carrying THAT row's values — not the row's JSON
    // text, and not the placeholder.
    expect(asked()).toEqual([
      'Navigate to /',
      'Verify the row for "ORD-1001" is Completed',
      'Verify the row for "ORD-1002" is Pending',
      'Sign out',
    ]);
    expect(report.status).toBe('passed');
  });
});
