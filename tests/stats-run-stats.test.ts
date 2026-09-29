/**
 * The run loops' side of the scoreboard (src/runner/run-stats.ts;
 * docs/specs/SPEC-scoreboard.md §7, §8, §12): who a run is, the one call a
 * step's lines go through, the run line — and what recording costs a step
 * (acceptance 8: under 5 ms a step, measured on a 20-step run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  adHocStats,
  openRunStats,
  projectStatsSwitch,
  recordExecutedStep,
  recordRunEnd,
  statsEnabledIn,
  type RunStats,
} from '../src/runner/run-stats.js';
import { logger } from '../src/utils/logger.js';
import { flushStatsWrites, readStatsLines } from '../src/stats/store.js';
import type { StatsActionLine, StatsRunLine, StatsStepLine } from '../src/stats/types.js';
import type { AIAction } from '../src/ai/types.js';
import type { StepResult, SubActionResult, TurnResult } from '../src/report/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';

let tmp: string;
let deps: UserRootDeps;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-run-stats-')));
  deps = { env: { LOCALAPPDATA: tmp, XDG_CONFIG_HOME: tmp }, platform: process.platform };
});

afterEach(async () => {
  await flushStatsWrites();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sub(action: Partial<AIAction> & { action: string }, over: Partial<SubActionResult> = {}): SubActionResult {
  return {
    index: 1,
    action: { description: 'do it', ...action } as AIAction,
    durationMs: 120,
    pageUrl: 'https://shop.test/cart',
    timestamp: '2026-09-29T01:00:00.000Z',
    ...over,
  };
}

function turn(subActions: SubActionResult[], over: Partial<TurnResult> = {}): TurnResult {
  return {
    turnNumber: 1,
    attemptNumber: 1,
    timestamp: '2026-09-29T01:00:00.000Z',
    aiInteractions: [
      { purpose: 'action-plan', attemptNumber: 1, response: '{}', model: 'm', usage: { inputTokens: 1000, outputTokens: 20 } },
    ],
    subActions,
    ...over,
  };
}

function result(over: Partial<StepResult> = {}): StepResult {
  return {
    index: 4,
    instruction: 'Click Pay',
    status: 'passed',
    turns: [turn([sub({ action: 'click', selector: '#pay' })])],
    durationMs: 900,
    retried: false,
    ...over,
  };
}

async function written() {
  await flushStatsWrites();
  const { lines } = await readStatsLines({ deps });
  return {
    actions: lines.filter((l): l is StatsActionLine => l.kind === 'action'),
    steps: lines.filter((l): l is StatsStepLine => l.kind === 'step'),
    runs: lines.filter((l): l is StatsRunLine => l.kind === 'run'),
  };
}

describe('openRunStats', () => {
  it('names the project root and the test relative to it, with a fresh run id and an empty tally', () => {
    const root = path.join(tmp, 'proj');
    const stats = openRunStats({ projectRoot: root, testFilePath: path.join(root, 'tests', 'a.md'), deps });
    expect(stats).toMatchObject({
      project: root,
      test: path.join('tests', 'a.md'),
      suite: 'user',
      enabled: true,
      tally: { steps: 0, firstTry: 0, failed: 0 },
    });
    expect(stats.runId).toMatch(/^r-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(openRunStats({ projectRoot: root, deps }).runId).not.toBe(stats.runId);
  });

  it('keeps a test outside the root absolute, and an ad hoc run has no test', () => {
    const outside = path.join(tmp, 'elsewhere', 'b.md');
    expect(openRunStats({ projectRoot: path.join(tmp, 'proj'), testFilePath: outside, deps }).test).toBe(outside);
    expect(openRunStats({ projectRoot: path.join(tmp, 'proj'), testFilePath: null, deps }).test).toBeNull();
    // No root resolved: the test's own folder stands in.
    expect(openRunStats({ projectRoot: null, testFilePath: outside, deps })).toMatchObject({
      project: path.dirname(outside),
      test: 'b.md',
    });
  });

  it('a forced suite wins over STEPTIX_STATS_SUITE; the project switch and STEPTIX_STATS both turn it off', () => {
    const live: UserRootDeps = { ...deps, env: { ...deps.env, STEPTIX_STATS_SUITE: 'live' } };
    expect(openRunStats({ projectRoot: tmp, deps: live }).suite).toBe('live');
    expect(openRunStats({ projectRoot: tmp, suite: 'compile', deps: live }).suite).toBe('compile');
    expect(openRunStats({ projectRoot: tmp, projectEnabled: false, deps }).enabled).toBe(false);
    expect(openRunStats({ projectRoot: tmp, deps: { ...deps, env: { ...deps.env, STEPTIX_STATS: 'off' } } }).enabled).toBe(false);
  });

  it('continues a run id, and carries the row', () => {
    expect(openRunStats({ projectRoot: tmp, runId: 'r-20260929-010000-abcd', row: 3, deps })).toMatchObject({
      runId: 'r-20260929-010000-abcd',
      row: 3,
    });
  });
});

describe('recordExecutedStep', () => {
  it('writes the step under the number the report shows, in its hook scope and place', async () => {
    const stats: RunStats = {
      ...openRunStats({ projectRoot: tmp, deps }),
      hook: 'beforeEach',
      hookIndex: 2,
      reportIndex: (n) => n + 1,
    };
    recordExecutedStep(result({ index: 0 }), stats, { stepText: 'Dismiss the banner' });
    const { actions, steps } = await written();
    for (const line of [...actions, ...steps]) {
      expect(line).toMatchObject({ step: 1, hook: 'beforeEach', hookIndex: 2, stepText: 'Dismiss the banner' });
    }
  });

  it('masks with the context\'s set and the step\'s own, and fingerprints only a step-prompt step', async () => {
    const stats: RunStats = { ...openRunStats({ projectRoot: tmp, deps }), maskValues: ['alice@example.com'] };
    const step = result({
      turns: [turn([sub({ action: 'click', selector: 'role=row[name="alice@example.com"] >> text="hunter2"' })])],
    });
    recordExecutedStep(step, stats, {
      stepText: 'Edit the row for alice@example.com with {{password}}',
      rules: { dismissalGuidance: false },
      maskValues: ['hunter2'],
    });
    recordExecutedStep(result(), stats, { stepText: '[use ai] Make up a name' });
    const { actions, steps } = await written();
    expect(actions[0]!.selector).toBe('role=row[name="***"] >> text="***"');
    expect(steps[0]!.stepText).toBe('Edit the row for *** with {{password}}');
    expect(steps[0]!.prompt).toMatch(/^p-[0-9a-f]{6}$/);
    // Asked through its own prompt: no fingerprint rather than the wrong one.
    expect(steps[1]).not.toHaveProperty('prompt');
    expect(JSON.stringify([...actions, ...steps])).not.toMatch(/alice@example\.com|hunter2/);
  });

  it('counts each step toward the run line: a first try, a failure, a stop — shared by every copy', async () => {
    const stats = openRunStats({ projectRoot: tmp, deps });
    recordExecutedStep(result(), { ...stats, maskValues: [] }, { stepText: 'a' });
    recordExecutedStep(result({ retried: true }), { ...stats }, { stepText: 'b' });
    recordExecutedStep(result({ status: 'failed', tolerated: true }), stats, { stepText: 'c' });
    recordExecutedStep(result({ status: 'failed', interrupted: true }), adHocStats(stats), { stepText: 'd' });
    expect(stats.tally).toEqual({ steps: 4, firstTry: 1, failed: 1 });
  });

  it('records nothing with no context, or with recording off', async () => {
    recordExecutedStep(result(), undefined, { stepText: 'a' });
    recordExecutedStep(result(), openRunStats({ projectRoot: tmp, projectEnabled: false, deps }), { stepText: 'a' });
    await flushStatsWrites();
    expect(fs.existsSync(path.join(tmp, 'steptix', 'stats'))).toBe(false);
  });

  it('a malformed result costs its lines, never the step', async () => {
    const stats = openRunStats({ projectRoot: tmp, deps });
    expect(() => recordExecutedStep({ index: 1 } as StepResult, stats, { stepText: 'x' })).not.toThrow();
  });

  it('numbers each recorded execution 1, 2, 3… across every copy — a step line and its actions share one', async () => {
    const stats = openRunStats({ projectRoot: tmp, deps });
    // The same step twice (a loop body's two passes), then another, each
    // through a fresh copy as the loops pass it.
    recordExecutedStep(result({ index: 3 }), { ...stats, maskValues: [] }, { stepText: 'Click Next' });
    recordExecutedStep(result({ index: 3 }), { ...stats }, { stepText: 'Click Next' });
    recordExecutedStep(result({ index: 4 }), adHocStats(stats), { stepText: 'Click Pay' });
    const { actions, steps } = await written();
    expect(steps.map((s) => [s.step, s.exec])).toEqual([
      [3, 1],
      [3, 2],
      [4, 3],
    ]);
    expect(actions.map((a) => [a.step, a.exec])).toEqual([
      [3, 1],
      [3, 2],
      [4, 3],
    ]);
    expect(stats.tally!.steps).toBe(3);
  });

  it('a step that asked the model nothing writes no line, takes no number and is not counted (contract D)', async () => {
    const stats = openRunStats({ projectRoot: tmp, deps });
    // A condition the run's values answered: no turn, no call.
    recordExecutedStep(result({ turns: [], flowControl: { kind: 'return', verb: 'return' } }), stats, { stepText: 'If {{s}} is "x", then return' });
    // A step the run's lack of AI failed before any call.
    recordExecutedStep(result({ turns: [], status: 'failed', error: 'AI is not configured' }), stats, { stepText: 'Click Pay' });
    expect(stats.tally).toEqual({ steps: 0, firstTry: 0, failed: 0 });
    // A code-behind replay makes no call and IS a step (§5.6).
    recordExecutedStep(result({ turns: [], fromCodeBehind: true }), stats, { stepText: 'Click Pay', rules: { dismissalGuidance: false } });
    const { steps } = await written();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ source: 'code', exec: 1, calls: 0 });
    // Never shown the rules, so no fingerprint — even with rules in hand.
    expect(steps[0]).not.toHaveProperty('prompt');
    expect(stats.tally).toEqual({ steps: 1, firstTry: 1, failed: 0 });
  });

  it('a stopped step is counted as a step and not as a failure', async () => {
    const stats = openRunStats({ projectRoot: tmp, deps });
    recordExecutedStep(result({ status: 'failed', interrupted: true, retried: false }), stats, { stepText: 'Click Pay' });
    const { steps } = await written();
    expect(steps[0]).toMatchObject({ status: 'failed', interrupted: true, attempts: 1, firstTry: false });
    expect(stats.tally).toEqual({ steps: 1, firstTry: 0, failed: 0 });
  });

  it('a loop-set `stepText` wins over the text the runner reports — a hook line, authored', async () => {
    const stats: RunStats = { ...openRunStats({ projectRoot: tmp, deps }), hook: 'before', hookIndex: 1, stepText: 'Sign in as ${env.USER}' };
    recordExecutedStep(result({ index: 0 }), stats, { stepText: 'Sign in as alice' });
    const { steps } = await written();
    expect(steps[0]!.stepText).toBe('Sign in as ${env.USER}');
  });
});

describe('the project switch fails closed (finding 5)', () => {
  it('statsEnabledIn: only an absent section, an absent `enabled` or exactly `true` records', () => {
    expect(statsEnabledIn(undefined)).toBe(true);
    expect(statsEnabledIn({})).toBe(true);
    expect(statsEnabledIn({ stats: {} })).toBe(true);
    expect(statsEnabledIn({ stats: { enabled: true } })).toBe(true);
    for (const stats of [false, 'off', 0, null, [], { enabled: false }, { enabled: 'false' }, { enabled: 0 }, { enabled: 'off' }, { enabled: 'true' }]) {
      expect(statsEnabledIn({ stats }), JSON.stringify(stats)).toBe(false);
    }
  });

  it('openRunStats: a switch that is not the JSON boolean does not record', () => {
    for (const projectEnabled of ['false', 0, 'off', null] as unknown as boolean[]) {
      expect(openRunStats({ projectRoot: tmp, projectEnabled, deps }).enabled, String(projectEnabled)).toBe(false);
    }
    expect(openRunStats({ projectRoot: tmp, projectEnabled: true, deps }).enabled).toBe(true);
    expect(openRunStats({ projectRoot: tmp, deps }).enabled).toBe(true);
  });

  it('projectStatsSwitch: the test root’s own config decides, not the run’s', async () => {
    const quiet = path.join(tmp, 'quiet');
    fs.mkdirSync(quiet);
    fs.writeFileSync(path.join(quiet, 'steptix.config.json'), '{ "stats": { "enabled": false } }');
    expect(await projectStatsSwitch(quiet, { stats: { enabled: true } })).toBe(false);

    const loud = path.join(tmp, 'loud');
    fs.mkdirSync(loud);
    fs.writeFileSync(path.join(loud, 'steptix.config.json'), '{}');
    expect(await projectStatsSwitch(loud, { stats: { enabled: false } })).toBe(true);

    // No root, or no config file at the root: the run's own config.
    expect(await projectStatsSwitch(null, { stats: { enabled: false } })).toBe(false);
    expect(await projectStatsSwitch(path.join(tmp, 'nowhere'), {})).toBe(true);
  });

  it('projectStatsSwitch: a switch that cannot be read is off, with a warning naming the file', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      for (const [name, body] of [
        ['string', '{ "stats": { "enabled": "false" } }'],
        ['section', '{ "stats": false }'],
        ['json', '{ "stats": '],
      ] as const) {
        const root = path.join(tmp, `bad-${name}`);
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, 'steptix.config.json'), body);
        expect(await projectStatsSwitch(root, {}), name).toBe(false);
      }
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(3);
      expect(messages[0]).toContain('bad-string');
      expect(messages[0]).toContain('stats.enabled');
      expect(messages[1]).toContain('"stats"');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('adHocStats', () => {
  it('drops the interrupted step\'s hook and numbering, and keeps the run and its tally', () => {
    const stats = openRunStats({ projectRoot: tmp, deps });
    const copy = adHocStats({ ...stats, hook: 'after', hookIndex: 1, reportIndex: () => 99, stepText: 'x', card: false })!;
    expect(copy).not.toHaveProperty('hook');
    expect(copy).not.toHaveProperty('hookIndex');
    expect(copy).not.toHaveProperty('reportIndex');
    expect(copy).not.toHaveProperty('stepText');
    expect(copy).not.toHaveProperty('card');
    expect(copy.runId).toBe(stats.runId);
    expect(copy.tally).toBe(stats.tally);
    expect(adHocStats(undefined)).toBeUndefined();
  });
});

describe('recordRunEnd', () => {
  it('writes the run line from the tally, with the report and the totals it is handed', async () => {
    const stats = openRunStats({ projectRoot: tmp, testFilePath: path.join(tmp, 't.md'), deps });
    recordExecutedStep(result(), stats, { stepText: 'a' });
    recordExecutedStep(result({ status: 'failed' }), stats, { stepText: 'b' });
    recordRunEnd(stats, { status: 'failed', aborted: false, tokensIn: 2500, tokensOut: 60, report: path.join(tmp, 'r.html') });
    const { runs } = await written();
    expect(runs).toEqual([
      expect.objectContaining({
        run: stats.runId,
        test: 't.md',
        status: 'failed',
        steps: 2,
        firstTry: 1,
        failed: 1,
        tokensIn: 2500,
        tokensOut: 60,
        report: path.join(tmp, 'r.html'),
      }),
    ]);
    expect(runs[0]).not.toHaveProperty('aborted');
  });

  it('a run with no step lines and no report writes nothing; with a report it still links it', async () => {
    recordRunEnd(openRunStats({ projectRoot: tmp, deps }), { status: 'passed', report: null });
    await flushStatsWrites();
    expect(fs.existsSync(path.join(tmp, 'steptix', 'stats'))).toBe(false);

    recordRunEnd(openRunStats({ projectRoot: tmp, deps }), { status: 'passed', report: path.join(tmp, 'r.html') });
    expect((await written()).runs).toHaveLength(1);
  });
});

describe('what recording costs a step (acceptance 8)', () => {
  it('a 20-step run: the recorder adds well under 5 ms a step, and no step waits on the disk', async () => {
    /** A realistic step: a retry, three actions a turn, the call's usage, a
     *  mask set to run over. */
    const heavy = (i: number): StepResult =>
      result({
        index: i + 1,
        retried: i % 4 === 0,
        turns: [1, 2].map((attempt) =>
          turn(
            [
              sub({ action: 'click', selector: `[role="listbox"] [role="option"]:text-is("Option ${i}")` }, { error: attempt === 1 ? 'locator.click: Timeout 10000ms exceeded.' : undefined, targeting: { matchCount: 0, visibleMatchCount: 0 } }),
              sub({ action: 'type', selector: '#name', value: 'secret-value' }, { index: 2 }),
              sub({ action: 'wait', waitType: 'selector', condition: '#done' }, { index: 3 }),
            ],
            { attemptNumber: attempt },
          ),
        ),
      });
    const steps = Array.from({ length: 20 }, (_, i) => heavy(i));
    const stats: RunStats = {
      ...openRunStats({ projectRoot: tmp, testFilePath: path.join(tmp, 'tests', 'perf.md'), deps }),
      maskValues: ['secret-value', 'alice@example.com', 'hunter2'],
    };

    const costs: number[] = [];
    for (const step of steps) {
      const started = performance.now();
      // The first call computes the rules fingerprint and the framework
      // version; it is counted, as a real run's first step pays it.
      recordExecutedStep(step, stats, {
        stepText: `Select "Option {{n}}" from the list`,
        rules: { dismissalGuidance: false },
        maskValues: ['more-secret'],
      });
      costs.push(performance.now() - started);
    }
    const average = costs.reduce((a, b) => a + b, 0) / costs.length;
    const worstAfterFirst = Math.max(...costs.slice(1));
    // The figure the report quotes, printed where a reader of the run sees it.
    console.log(
      `stats overhead: ${average.toFixed(3)} ms/step average over 20 steps ` +
        `(first ${costs[0]!.toFixed(3)} ms, worst after it ${worstAfterFirst.toFixed(3)} ms)`,
    );
    expect(average).toBeLessThan(5);

    // Nothing was awaited: the lines arrive once the queue drains.
    const { actions, steps: stepLines } = await written();
    expect(stepLines).toHaveLength(20);
    expect(actions).toHaveLength(120);
  });
});
