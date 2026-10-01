/**
 * The runner half of keyless mode
 * (stories/keyless-replay-and-gateway-env.md §Part B): where the "this run has
 * no AI" answer comes FROM, and what a failed keyless run puts in the
 * report's diagnosis slot.
 *
 * Two things are proven here that a unit test of either piece could not:
 *
 *  1. the post-failure diagnosis pass is skipped BEFORE calling AI, and says
 *     so in the slot the analysis would have filled — so the report states an
 *     intention rather than surfacing a caught auth error;
 *  2. the flag reaches the executor, which is the wiring the heal skip in
 *     `keyless-replay.test.ts` depends on and cannot see for itself.
 *
 * Driven through the real `runTest` with the browser, executor and AI mocked
 * out — the harness shape `codebehind-healed-run.test.ts` uses.
 *
 * Minimum scenario: every config here is built from `DEFAULT_CONFIG` in
 * memory. `runTest` never calls `loadConfig`, so neither a machine-wide
 * `%LOCALAPPDATA%\steptix\.env` nor a real `AI_API_KEY` in the process env can
 * reach it and quietly un-keyless the run — asserted below rather than
 * assumed, because that leak is exactly what would condition the bug out of
 * the test path.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config/types.js';
import type { ParsedTest, TestInstance } from '../src/parser/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { aiConfigured } from '../src/config/loader.js';

/** The story's copy, restated rather than imported — a silent edit to the
 *  constant must fail here, not agree with itself. */
const SKIP_NOTE = 'Diagnosis skipped: AI is not configured.';

/** The policy twin. A keyed run told not to spend the key is NOT unconfigured,
 *  and telling its operator otherwise sends them to add a key they already have
 *  — or, on Bedrock SigV4, one that would break the run by outranking the AWS
 *  credential chain. */
const POLICY_SKIP_NOTE =
  'Diagnosis skipped: this run was asked to make no AI calls (ai.allowInRuns: false).';

// ─── Runner harness ─────────────────────────────────────────────────────────

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

/** Records the options each step was executed with — that is where `keyless`
 *  has to arrive for the heal skip to ever fire. */
const executeStepMock = vi.fn();
const stepOptions: Array<Record<string, unknown>> = [];
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => {
    stepOptions.push(args[3] as Record<string, unknown>);
    return executeStepMock(...args);
  },
  executeBranchedStep: vi.fn(),
}));

vi.mock('../src/runner/hooks.js', () => ({
  resolveHooks: vi.fn(async () => ({
    before: [], beforeEach: [], afterEach: [], after: [], hasAny: false,
  })),
}));

const diagnoseFailureMock = vi.fn();
vi.mock('../src/ai/diagnose.js', () => ({
  diagnoseFailure: (...args: unknown[]) => diagnoseFailureMock(...args),
}));
/** Every `setAiPolicy` the runner made, in order. Recorded because
 *  `opts.keyless` cannot stand for it: the flag tells the executor how to treat
 *  a broken code-behind entry, while the veil is what makes a direct AI call
 *  refuse with the policy error instead of "AI is not configured". */
const aiPolicyCalls: boolean[] = [];
vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy = vi.fn((allowed: boolean) => { aiPolicyCalls.push(allowed); });
    syncAuth = vi.fn(() => null);
  },
}));
vi.mock('../src/utils/run-log.js', () => ({
  openRunLogFile: () => null,
  attachRunLogBridges: () => () => {},
}));

vi.mock('../src/utils/tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/tokens.js')>()),
  TokenTracker: class {
    addUsage(): void {}
    resetStep(): void {}
    markRunStart(): void {}
    checkStepBudget(): void {}
    get total(): number { return 0; }
    get inputTotal(): number { return 0; }
    get outputTotal(): number { return 0; }
    get runTotal(): number { return 0; }
    get runInputTotal(): number { return 0; }
    get runOutputTotal(): number { return 0; }
    getSummary(): string { return 'Total: 0'; }
  },
}));

// The real generator is kept: the point of putting the note in the diagnosis
// slot is that the existing rendering shows it with no change, and only a real
// `renderReport` can say whether that is true.
vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn(async () => ''),
  getPrimaryModel: () => undefined,
  buildReportBaseName: (report: { testName: string }) => report.testName,
}));

vi.mock('../src/report/history-appender.js', () => ({
  appendRunHistory: vi.fn(async () => undefined),
}));

import { runTest } from '../src/runner/test-runner.js';
import { createTestFileRunner } from '../src/codebehind/compile.js';
import { renderReport } from '../src/report/generator.js';
import { readLastRun } from '../src/codebehind/last-run.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-keyless-diagnosis');

function makeInstance(steps: string[], filePath: string): TestInstance {
  const test: ParsedTest = {
    filePath,
    title: 'transfers',
    frontmatter: { tags: [] },
    config: {},
    parameters: {},
    steps,
    stepLines: steps.map((_, i) => i + 1),
    skipHooks: steps.map(() => false),
    toolCalls: steps.map(() => null),
    sourceSkills: steps.map(() => null),
    sourceSections: steps.map(() => null),
    sections: {},
    rawSteps: [...steps],
    hooks: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookToolCalls: { before: [], beforeEach: [], afterEach: [], after: [] },
    hookSourceSkills: { before: [], beforeEach: [], afterEach: [], after: [] },
  };
  return { test, resolvedParameters: {} };
}

/** `apiKey: undefined` is the whole point — `DEFAULT_CONFIG` carries none, and
 *  nothing in `runTest` reads the environment to fill it. */
function keylessConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, diagnoseFailures: true },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
  };
}

function keyedConfig(): Config {
  const config = keylessConfig();
  return { ...config, ai: { ...config.ai, apiKey: 'sk-present' } };
}

function passed(index: number, instruction: string): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

function failed(index: number, instruction: string, error: string): StepResult {
  return { index, instruction, status: 'failed', turns: [], durationMs: 1, retried: false, error };
}

/** The story's copy, restated for the same reason `SKIP_NOTE` is: the module
 *  that exports it is mocked in this file, so importing it would read
 *  `undefined` and agree with anything. */
const HEAL_SKIPPED_ERROR =
  'replay failed and was not healed: AI is not configured on this machine. ' +
  'Recompile or repair this step where AI is available.';

/** What the entry actually threw — the thing a later repair has to work from,
 *  and the thing that is NOT in the step's `error`. */
const ENTRY_ERROR = '#transfers-tab went away in a redesign';

/** What `executeStep` returns for a step whose entry broke on a keyless run:
 *  failed, ran as code, and carrying the entry's failure structurally but NOT
 *  as `codeBehindStale` — nothing healed it. */
function healSkipped(index: number, instruction: string): StepResult {
  return {
    ...failed(index, instruction, HEAL_SKIPPED_ERROR),
    fromCodeBehind: true,
    codeBehindHealSkipped: {
      file: path.join(dir, 'transfers.steps.ts'),
      source: instruction,
      error: ENTRY_ERROR,
    },
  };
}

/** What it returns for a step that DID heal, on a machine with a key. */
function healed(index: number, instruction: string): StepResult {
  return {
    ...passed(index, instruction),
    codeBehindStale: {
      file: path.join(dir, 'transfers.steps.ts'),
      source: instruction,
      error: ENTRY_ERROR,
    },
  };
}

let dir: string;
let counter = 0;

beforeEach(async () => {
  executeStepMock.mockReset();
  diagnoseFailureMock.mockReset();
  launchBrowserMock.mockReset();
  closeBrowserMock.mockReset();
  stepOptions.length = 0;
  aiPolicyCalls.length = 0;
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'https://bank.test/', goto: vi.fn(async () => undefined) },
  });
  closeBrowserMock.mockResolvedValue(undefined);
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ─── The diagnosis gate ─────────────────────────────────────────────────────

describe('the post-failure diagnosis pass on a keyless run', () => {
  it('is skipped, and the report says so where the analysis would have been', async () => {
    // The trap this guards: a real key in the process env or the machine-wide
    // .env would make this run keyed and the test would pass by never
    // exercising the branch.
    const config = keylessConfig();
    expect(aiConfigured(config.ai)).toBe(false);

    executeStepMock.mockImplementationOnce(async () => passed(1, 'Sign in'));
    executeStepMock.mockImplementationOnce(async () =>
      failed(2, 'Click the "Transfers" tab', 'replay failed and was not healed'),
    );

    const report = await runTest(
      makeInstance(['Sign in', 'Click the "Transfers" tab'], path.join(dir, 'transfers.md')),
      config,
      '',
    );

    expect(report.status).toBe('failed');
    // Proactive: no request was built, so there is no auth error to report.
    expect(diagnoseFailureMock).not.toHaveBeenCalled();
    expect(report.diagnosis?.rootCause).toBe(SKIP_NOTE);
    // `diagnoseFailures` is still on — keyless is a runtime condition, not a
    // setting the user had to know to turn off.
    expect(config.ai.diagnoseFailures).toBe(true);

    // And the existing report rendering shows it, unchanged.
    const html = renderReport(report);
    expect(html).toContain(SKIP_NOTE);
    // ...without an empty "Suggested fix" box under it: a diagnosis that never
    // ran has nothing to suggest, and a labelled empty box reads as a
    // rendering bug rather than as a skip.
    expect(html).not.toContain('Suggested fix');
    // Nothing in the report reads as a broken API key.
    expect(JSON.stringify(report)).not.toMatch(/invalid_api_key/i);
  });

  it('claims nothing it did not determine', async () => {
    // The slot is a placeholder, not an analysis: no invented root cause, no
    // evidence, no confident category.
    executeStepMock.mockImplementationOnce(async () => failed(1, 'Sign in', 'boom'));

    const report = await runTest(
      makeInstance(['Sign in'], path.join(dir, 'transfers.md')),
      keylessConfig(),
      '',
    );

    expect(report.diagnosis).toEqual({
      rootCause: SKIP_NOTE,
      faultCategory: 'unknown',
      evidence: [],
      suggestedFix: '',
      confidence: 'low',
    });
  });

  it('leaves a passing keyless run with no diagnosis slot at all', async () => {
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'Sign in'));

    const report = await runTest(
      makeInstance(['Sign in', 'Read the balance'], path.join(dir, 'green.md')),
      keylessConfig(),
      '',
    );

    expect(report.status).toBe('passed');
    expect(report.diagnosis).toBeUndefined();
    expect(diagnoseFailureMock).not.toHaveBeenCalled();
  });

  it('still diagnoses a failed run on a machine that HAS a key', async () => {
    // The control. Without it a gate that skipped unconditionally would pass
    // every case above while silently ending diagnosis for everyone.
    const config = keyedConfig();
    expect(aiConfigured(config.ai)).toBe(true);

    diagnoseFailureMock.mockResolvedValue({
      rootCause: 'The Transfers tab was renamed',
      faultCategory: 'application',
      evidence: ['no element matched #transfers-tab'],
      suggestedFix: 'Update the selector',
      confidence: 'high',
    });
    executeStepMock.mockImplementationOnce(async () => failed(1, 'Sign in', 'boom'));

    const report = await runTest(
      makeInstance(['Sign in'], path.join(dir, 'keyed.md')),
      config,
      '',
    );

    expect(diagnoseFailureMock).toHaveBeenCalledTimes(1);
    expect(report.diagnosis?.rootCause).toBe('The Transfers tab was renamed');
    expect(report.diagnosis?.rootCause).not.toBe(SKIP_NOTE);
  });
});

// ─── The flag the executor acts on ──────────────────────────────────────────

describe('the keyless flag the runner hands each step', () => {
  it('is set on every step when the run has no key', async () => {
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in', 'Read the balance'], path.join(dir, 'flagged.md')),
      keylessConfig(),
      '',
    );

    expect(stepOptions).toHaveLength(2);
    expect(stepOptions.every((o) => o['keyless'] === true)).toBe(true);
  });

  it('is absent on a keyed run — the options are what they always were', async () => {
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in'], path.join(dir, 'unflagged.md')),
      keyedConfig(),
      '',
    );

    expect(stepOptions).toHaveLength(1);
    // Absent, not `false`: `exactOptionalPropertyTypes` refuses an explicit
    // undefined, and "no key set" is how every caller that predates this
    // feature behaves.
    expect('keyless' in stepOptions[0]!).toBe(false);
  });

  it('does not turn a whitespace-only key into a usable one', async () => {
    // `AI_API_KEY=` with a stray space is the same "no key" the author meant;
    // letting it through would only move the failure to the gateway.
    const config = keylessConfig();
    config.ai = { ...config.ai, apiKey: '   ' };
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in'], path.join(dir, 'blank-key.md')),
      config,
      '',
    );

    expect(stepOptions[0]!['keyless']).toBe(true);
  });
});

// ─── The CLI's own AI switch ────────────────────────────────────────────────
//
// `ai.allowInRuns: false` used to be server-path-only, and the CLI's answer to
// "should this run spend AI?" was key presence alone. Blanking `AI_API_KEY=`
// was a workable substitute right up until a provider that authenticates
// itself: there is no key to blank, and a CI user in exactly the setup
// stories/bedrock-provider.md markets would lose their only way to force a
// no-AI run.
//
// Asserted on a KEYED config throughout — against a keyless one every case
// below would pass for the wrong reason.

describe('the CLI honouring ai.allowInRuns', () => {
  function forbiddenConfig(): Config {
    const config = keyedConfig();
    return { ...config, ai: { ...config.ai, allowInRuns: false } };
  }

  it('makes a keyed run keyless, and says the reason is policy', async () => {
    const config = forbiddenConfig();
    // The trap: a config that had drifted keyless would produce the same flag
    // without the switch ever being read.
    expect(aiConfigured(config.ai)).toBe(true);

    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in', 'Read the balance'], path.join(dir, 'no-ai.md')),
      config,
      '',
    );

    expect(stepOptions).toHaveLength(2);
    expect(stepOptions.every((o) => o['keyless'] === true)).toBe(true);
    // 'no-key' would send the reader to fix a line that is correct.
    expect(stepOptions.every((o) => o['keylessReason'] === 'policy')).toBe(true);
    // …and the client refuses with the policy error rather than the reactive
    // "AI is not configured", which the flag alone does not cover.
    expect(aiPolicyCalls).toContain(false);
  });

  it('leaves a keyed run that never mentioned the switch exactly as it was', async () => {
    // The control. Without it, a gate that fired unconditionally would pass the
    // case above while quietly ending AI for everyone on the CLI.
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in'], path.join(dir, 'still-on.md')),
      keyedConfig(),
      '',
    );

    expect('keyless' in stepOptions[0]!).toBe(false);
    expect('keylessReason' in stepOptions[0]!).toBe(false);
    expect(aiPolicyCalls).not.toContain(false);
  });

  it('reports policy rather than no-key when the run has neither a key nor permission', async () => {
    // Both true, one useful — the same precedence the server keeps.
    const config = keylessConfig();
    const forbidden: Config = { ...config, ai: { ...config.ai, allowInRuns: false } };
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(makeInstance(['Sign in'], path.join(dir, 'neither.md')), forbidden, '');

    expect(stepOptions[0]!['keyless']).toBe(true);
    expect(stepOptions[0]!['keylessReason']).toBe('policy');
  });

  it('skips the post-failure diagnosis pass, the same as any keyless run', async () => {
    // The switch reuses keyless rather than inventing a mode, so everything
    // hanging off that flag has to follow — including the pass that would
    // otherwise spend a model call on a run told to spend none.
    executeStepMock.mockImplementationOnce(async () => failed(1, 'Sign in', 'boom'));

    const report = await runTest(
      makeInstance(['Sign in'], path.join(dir, 'no-ai-diagnosis.md')),
      forbiddenConfig(),
      '',
    );

    expect(report.status).toBe('failed');
    expect(diagnoseFailureMock).not.toHaveBeenCalled();
    // The POLICY note, not the no-key one: forbiddenConfig() is KEYED and merely
    // forbidden. Asserting the no-key text here locked in the false claim.
    expect(report.diagnosis?.rootCause).toBe(POLICY_SKIP_NOTE);
    expect(report.diagnosis?.rootCause).not.toContain('not configured');
  });

  it('does not gate the runs `steptix compile` makes — a compile is a request FOR AI', async () => {
    // The switch and the compiler share one `runTest`, so honouring the switch
    // there took `steptix compile` down with it: every step refused, nothing
    // recorded, nothing written — on precisely the projects that set
    // `allowInRuns: false` in order to HAVE compiled steps to replay. Both the
    // config type and the JSON schema promise the opposite in as many words,
    // and the server has always honoured it via `bypassAiPolicy`.
    //
    // Driven through the compiler's own runner rather than by passing the flag
    // to `runTest` directly: the flag existing and the compile path setting it
    // are two claims, and only the join is the bug.
    const config = forbiddenConfig();
    expect(aiConfigured(config.ai)).toBe(true);

    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    const instance = makeInstance(['Sign in', 'Read the balance'], path.join(dir, 'compile-me.md'));
    const runner = createTestFileRunner({
      test: instance.test,
      config,
      contextContent: '',
      aiClient: {} as never,
    });

    const outcome = await runner({
      purpose: 'record',
      parameters: {},
      strict: false,
      captureContext: true,
      disableCodeBehind: true,
    });

    expect(outcome.status).toBe('passed');
    expect(stepOptions).toHaveLength(2);
    // Not keyless, no policy reason, and the veil never lowered — the three
    // ways the refusal reaches a step.
    expect(stepOptions.every((o) => !('keyless' in o))).toBe(true);
    expect(stepOptions.every((o) => !('keylessReason' in o))).toBe(true);
    expect(aiPolicyCalls).not.toContain(false);
  });

  it('still refuses an ordinary run of the same project', async () => {
    // The control for the bypass. Without it, a flag that leaked into every run
    // would pass the case above by turning the switch off altogether.
    executeStepMock.mockImplementation(async (index: number) => passed(index, 'step'));

    await runTest(
      makeInstance(['Sign in'], path.join(dir, 'not-a-compile.md')),
      forbiddenConfig(),
      '',
    );

    expect(stepOptions[0]!['keyless']).toBe(true);
    expect(stepOptions[0]!['keylessReason']).toBe('policy');
    expect(aiPolicyCalls).toContain(false);
  });
});

// ─── The last-run sidecar ───────────────────────────────────────────────────
//
// The decoupling this story needs and the run does not: the step is NOT stale
// in the result (nothing healed, so no heal counter may move) but it IS stale
// in the sidecar (the entry is broken, and a later keyed compile is the only
// thing that can fix it). Without the second half the failure's own advice —
// "recompile or repair this step where AI is available" — is a no-op:
// `--only-stale` would not select the step and Compile This Step would
// generate blind instead of repairing.

describe('the last-run sidecar after a keyless heal skip', () => {
  it('marks the broken step stale, with what the entry threw', async () => {
    executeStepMock.mockImplementationOnce(async () => passed(1, 'Sign in'));
    executeStepMock.mockImplementationOnce(async () =>
      healSkipped(2, 'Click the "Transfers" tab'),
    );

    const md = path.join(dir, 'transfers.md');
    await runTest(
      makeInstance(['Sign in', 'Click the "Transfers" tab'], md),
      keylessConfig(),
      '',
    );

    const rows = (await readLastRun(md))!.steps;
    expect(rows[0]).toMatchObject({ index: 1, stale: false });
    expect(rows[1]).toMatchObject({
      index: 2,
      status: 'failed',
      fromCodeBehind: true,
      stale: true,
      // The thrown message, not the step's error line: a repair prompt fed
      // "AI is not configured on this machine" would be repairing the wrong
      // thing.
      error: ENTRY_ERROR,
      healSkipped: true,
    });
  });

  it('still reports nothing as healed', async () => {
    // The accounting half. `healedSteps` / `healedTokens` are counted off
    // `codeBehindStale`, which this path deliberately does not set — so a
    // sidecar that says "stale" and a report that says "healed" can only
    // disagree if someone reuses the field.
    executeStepMock.mockImplementationOnce(async () =>
      healSkipped(1, 'Click the "Transfers" tab'),
    );

    const md = path.join(dir, 'transfers.md');
    const report = await runTest(
      makeInstance(['Click the "Transfers" tab'], md),
      keylessConfig(),
      '',
    );

    expect(report.status).toBe('failed');
    expect(report.healedSteps).toBeUndefined();
    expect(report.healedTokens).toBeUndefined();
    expect(report.steps[0]!.codeBehindStale).toBeUndefined();
    // ...and the sidecar still knows, which is the whole point of the split.
    expect((await readLastRun(md))!.steps[0]!.stale).toBe(true);
  });

  it('never advances the healed-under-AI streak, however many keyless runs', async () => {
    // `staleRuns` is what makes the marker read "healed under AI (3 runs in a
    // row)". A machine with no AI has healed nothing, so the count stays off
    // the row no matter how often the test is run.
    const md = path.join(dir, 'transfers.md');
    for (const _run of [1, 2, 3]) {
      executeStepMock.mockImplementationOnce(async () =>
        healSkipped(1, 'Click the "Transfers" tab'),
      );
      await runTest(
        makeInstance(['Click the "Transfers" tab'], md),
        keylessConfig(),
        '',
      );
      const row = (await readLastRun(md))!.steps[0]!;
      expect(row.stale).toBe(true);
      expect(row.staleRuns).toBeUndefined();
    }
  });

  it('records a real heal on a keyed machine exactly as it always did', async () => {
    // The control. A stale row from an actual heal keeps its streak and its
    // report accounting, and carries no `healSkipped` — the keyless path added
    // a case, it did not change this one.
    executeStepMock.mockImplementationOnce(async () => healed(1, 'Click the "Transfers" tab'));

    const md = path.join(dir, 'keyed.md');
    const report = await runTest(
      makeInstance(['Click the "Transfers" tab'], md),
      keyedConfig(),
      '',
    );

    expect(report.healedSteps).toBe(1);
    const row = (await readLastRun(md))!.steps[0]!;
    expect(row).toMatchObject({ status: 'passed', stale: true, error: ENTRY_ERROR });
    expect(row.healSkipped).toBeUndefined();
    expect(row.staleRuns).toBe(1);
  });
});
