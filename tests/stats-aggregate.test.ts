/**
 * The scoreboard's arithmetic (docs/specs/SPEC-scoreboard.md §9): the window,
 * the filters and their defaults, every grouping, the Steps and Cost lines,
 * and the two lists with their links to the report. Every input is a hand-built
 * line in the shape the recorder writes.
 */
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  defaultStatsQuery,
  listCostly,
  listFailures,
  reportAnchor,
  reportHref,
  selectStatsLines,
  stepKey,
  summarizeStats,
  UNFINISHED_AFTER_MS,
  wholePercents,
  type StatsGroup,
  type StatsQuery,
} from '../src/stats/aggregate.js';
import type { StatsActionLine, StatsLine, StatsRunLine, StatsStepLine } from '../src/stats/types.js';

const NOW = new Date('2026-09-29T10:00:00.000Z');
// A space in the path, as under "C:\Users\Paul Kent": the link must survive it.
const PROJECT = 'C:\\work\\my templates\\init';
const REPORT = 'C:\\work\\my templates\\init\\reports\\2026-09-28_07-12-50-recording.html';
const ROWS_REPORT = 'C:\\work\\my templates\\init\\reports\\2026-09-27_08-00-00-signup-rows.html';

/** The link a terminal or editor can open: the report's file: URL and the anchor. */
function url(file: string, anchor: string): string {
  return `${pathToFileURL(file).href}#${anchor}`;
}

function action(over: Partial<StatsActionLine> = {}): StatsActionLine {
  return ({
    v: 1,
    kind: 'action',
    t: '2026-09-28T07:12:57.000Z',
    run: 'r-20260928-071250-4f1c',
    project: PROJECT,
    test: 'tests/recording.md',
    step: 11,
    stepText: 'Select "{{title}}" from the Title Select list',
    attempt: 1,
    turn: 1,
    action: 'click',
    selector: 'role=option[name="Mr"]',
    form: 'role',
    outcome: 'ok',
    ms: 250,
    site: 'www.super.test',
    model: 'openai/gpt-6-luna',
    prompt: 'p-3f9a1c',
    suite: 'user',
    source: 'ai',
    ...over,
    // Lines written before `exec` existed, unless a test gives one.
  }) as StatsActionLine;
}

function step(over: Partial<StatsStepLine> = {}): StatsStepLine {
  return ({
    v: 1,
    kind: 'step',
    t: '2026-09-28T07:13:10.000Z',
    run: 'r-20260928-071250-4f1c',
    project: PROJECT,
    test: 'tests/recording.md',
    step: 11,
    stepText: 'Select "{{title}}" from the Title Select list',
    status: 'passed',
    attempts: 1,
    turns: 1,
    firstTry: true,
    ms: 4000,
    calls: 1,
    tokensIn: 4000,
    tokensOut: 100,
    prompt: 'p-3f9a1c',
    suite: 'user',
    source: 'ai',
    ...over,
  }) as StatsStepLine;
}

function runLine(over: Partial<StatsRunLine> = {}): StatsRunLine {
  return {
    v: 1,
    kind: 'run',
    t: '2026-09-28T07:14:00.000Z',
    run: 'r-20260928-071250-4f1c',
    project: PROJECT,
    test: 'tests/recording.md',
    suite: 'user',
    status: 'passed',
    steps: 1,
    firstTry: 1,
    failed: 0,
    report: REPORT,
    ...over,
  };
}

function select(lines: StatsLine[], over: Partial<StatsQuery> = {}) {
  return selectStatsLines(lines, { ...defaultStatsQuery(NOW), ...over });
}

/** Groups by key, with `null` spelled "null". */
function byKey(groups: StatsGroup[]): Record<string, StatsGroup> {
  return Object.fromEntries(groups.map((group) => [String(group.key), group]));
}

const everyReport = (): boolean => true;

describe('the default view (§9)', () => {
  it('is the last 30 days of the user’s own AI steps, imported lines included', () => {
    expect(defaultStatsQuery(NOW)).toEqual({
      since: new Date('2026-08-30T10:00:00.000Z'),
      suites: ['user'],
      sources: ['ai'],
    });
    const lines = [
      action({ run: 'mine' }),
      action({ run: 'too-old', t: '2026-08-30T09:59:59.999Z' }),
      action({ run: 'just-in', t: '2026-08-30T10:00:00.000Z' }),
      action({ run: 'live', suite: 'live' }),
      action({ run: 'bench', suite: 'bench' }),
      action({ run: 'compile', suite: 'compile' }),
      action({ run: 'code', source: 'code' }),
      action({ run: 'imported', imported: true, prompt: null }),
      step({ run: 'mine' }),
      step({ run: 'live', suite: 'live' }),
      step({ run: 'code', source: 'code' }),
    ];
    const selection = select(lines);
    expect(selection.actions.map((line) => line.run)).toEqual(['mine', 'just-in', 'imported']);
    expect(selection.steps.map((line) => line.run)).toEqual(['mine']);
    expect(selection.inWindow).toEqual({ actions: 7, steps: 3 });
    expect(selection.leftOut).toEqual({
      suites: { live: { actions: 1, steps: 1 }, bench: { actions: 1, steps: 0 }, compile: { actions: 1, steps: 0 } },
      sources: { code: { actions: 1, steps: 1 } },
      filters: { actions: 0, steps: 0 },
    });
  });

  it('the window starts inclusive and ends exclusive', () => {
    const lines = [
      action({ run: 'start', t: '2026-09-01T00:00:00.000Z' }),
      action({ run: 'inside', t: '2026-09-09T23:59:59.999Z' }),
      action({ run: 'end', t: '2026-09-10T00:00:00.000Z' }),
    ];
    const selection = select(lines, { since: new Date('2026-09-01T00:00:00.000Z'), until: new Date('2026-09-10T00:00:00.000Z') });
    expect(selection.actions.map((line) => line.run)).toEqual(['start', 'inside']);
  });

  it('keeps every run line whatever the window and filters, the last per run', () => {
    const lines = [
      action({ run: 'r1', t: '2026-09-28T07:12:57.000Z' }),
      // Written when the run ended, after the window closed.
      runLine({ run: 'r1', t: '2026-09-28T07:14:00.000Z', report: 'first.html' }),
      runLine({ run: 'r1', t: '2026-09-28T07:15:00.000Z', report: 'second.html' }),
      runLine({ run: 'r2', suite: 'live', t: '2026-08-01T00:00:00.000Z' }),
    ];
    const selection = select(lines, { until: new Date('2026-09-28T07:13:00.000Z') });
    expect([...selection.runs.keys()]).toEqual(['r1', 'r2']);
    expect(selection.runs.get('r1')!.report).toBe('second.html');
    expect(selection.inWindow).toEqual({ actions: 1, steps: 0 });
  });
});

describe('filters', () => {
  const lines = [
    action({ run: 'r1', step: 1, stepText: 'A', site: 'www.SUPER.test', model: 'openai/gpt-6-luna' }),
    step({ run: 'r1', step: 1, stepText: 'A' }),
    action({ run: 'r1', step: 2, stepText: 'B', site: 'localhost:8787', model: 'anthropic/claude-x' }),
    step({ run: 'r1', step: 2, stepText: 'B' }),
    action({ run: 'r2', step: 1, stepText: 'C', site: 'example.org', test: 'tests/sub/signup.md' }),
    step({ run: 'r2', step: 1, stepText: 'C', test: 'tests/sub/signup.md' }),
    action({ run: 'r3', step: 1, stepText: 'D', site: 'example.org', test: null }),
    step({ run: 'r3', step: 1, stepText: 'D', test: null }),
  ];
  const texts = (found: Array<StatsActionLine | StatsStepLine>) => found.map((line) => line.stepText);

  it('--site is part of the host, in any case; a step goes with the site of its actions', () => {
    const selection = select(lines, { site: 'super.TEST' });
    expect(texts(selection.actions)).toEqual(['A']);
    expect(texts(selection.steps)).toEqual(['A']);
    expect(selection.leftOut.filters).toEqual({ actions: 3, steps: 3 });
  });

  it('--model is the whole id, in any case', () => {
    expect(select(lines, { model: 'gpt-6-luna' }).actions).toEqual([]);
    const selection = select(lines, { model: 'OpenAI/GPT-6-Luna' });
    expect(texts(selection.actions)).toEqual(['A', 'C', 'D']);
    expect(texts(selection.steps)).toEqual(['A', 'C', 'D']);
  });

  it('--test is part of the path, or a longer path that ends in it, either slash, any case', () => {
    for (const test of [
      'recording',
      'tests/recording.md',
      'TESTS\\Recording.md',
      './tests/recording.md',
      'templates/init/tests/recording.md',
      'C:\\work\\my templates\\init\\tests\\recording.md',
    ]) {
      const selection = select(lines, { test });
      expect(texts(selection.actions), test).toEqual(['A', 'B']);
      expect(texts(selection.steps), test).toEqual(['A', 'B']);
    }
    expect(texts(select(lines, { test: 'sub/' }).steps)).toEqual(['C']);
    // An ad hoc step has no test, so no --test matches it.
    expect(texts(select(lines, { test: '.md' }).steps)).toEqual(['A', 'B', 'C']);
  });

  it('--suite and --source take several', () => {
    const mixed = [
      action({ run: 'user' }),
      action({ run: 'live', suite: 'live' }),
      action({ run: 'bench', suite: 'bench' }),
      action({ run: 'code', source: 'code' }),
    ];
    const runs = (over: Partial<StatsQuery>) => select(mixed, over).actions.map((line) => line.run);
    expect(runs({ suites: ['user', 'live'] })).toEqual(['user', 'live']);
    expect(runs({ sources: ['ai', 'code'] })).toEqual(['user', 'code']);
    expect(runs({ suites: ['bench'], sources: ['ai', 'code'] })).toEqual(['bench']);
  });
});

describe('grouping by form', () => {
  it('counts every action, rates the first attempt, names the commonest failure; most actions first', () => {
    const lines = [
      action({ form: 'role', outcome: 'ok' }),
      action({ form: 'role', outcome: 'ok', turn: 2 }),
      action({ form: 'role', outcome: 'ok', step: 12 }),
      action({ form: 'text-is', selector: ':text-is("Mr")', outcome: 'no-match' }),
      action({ form: 'text-is', selector: ':text-is("Mr")', outcome: 'no-match', step: 12 }),
      // A retry's action is an action, but not a first try.
      action({ form: 'text-is', selector: ':text-is("Mr.")', outcome: 'ok', attempt: 2 }),
      // A tie between failures goes to §5.4's order.
      action({ form: 'has-text', outcome: 'other' }),
      action({ form: 'has-text', outcome: 'timeout' }),
      action({ form: 'css-role-name', outcome: 'no-match', attempt: 2 }),
      action({ form: null, selector: null, action: 'navigate', outcome: 'ok' }),
    ];
    const summary = summarizeStats(select(lines), 'form');
    expect(summary.by).toBe('form');
    expect(summary.groups.map((group) => group.key)).toEqual(['role', 'text-is', 'has-text', 'css-role-name', null]);
    const groups = byKey(summary.groups);
    expect(groups['text-is']!.actions).toEqual({
      actions: 3,
      firstTryActions: 2,
      firstTryOk: 0,
      firstTryOkRate: 0,
      outcomes: { 'no-match': 2, ok: 1 },
      topFailure: { outcome: 'no-match', count: 2 },
    });
    expect(groups['role']!.actions).toMatchObject({ actions: 3, firstTryOkRate: 1, topFailure: null });
    expect(groups['has-text']!.actions.topFailure).toEqual({ outcome: 'timeout', count: 1 });
    // Nothing on a first attempt to rate.
    expect(groups['css-role-name']!.actions).toMatchObject({ firstTryActions: 0, firstTryOkRate: null });
    // Actions with no selector are counted too (§5.1).
    expect(groups['null']!.actions).toMatchObject({ actions: 1, firstTryOkRate: 1 });
    // A step uses several forms, so a form has no steps of its own.
    for (const group of summary.groups) expect(group).not.toHaveProperty('steps');
    expect(summary.actions).toMatchObject({ actions: 10, firstTryActions: 8, firstTryOk: 4 });
    expect(summary.groups[0]).toMatchObject({ firstSeen: '2026-09-28T07:12:57.000Z', lastSeen: '2026-09-28T07:12:57.000Z' });
  });

  it("leaves out the actions of a step the user stopped, as it leaves out the step", () => {
    const lines: StatsLine[] = [
      // Step 1 ran to an end.
      action({ exec: 1, step: 1, form: 'role', outcome: 'ok' } as Partial<StatsActionLine>),
      step({ exec: 1, step: 1 } as Partial<StatsStepLine>),
      // Step 2 was cut short by a Stop: its half-done action read as `other`.
      action({ exec: 2, step: 2, form: 'text-is', selector: ':text-is("Save")', outcome: 'other' } as Partial<StatsActionLine>),
      step({ exec: 2, step: 2, status: 'failed', firstTry: false, interrupted: true } as Partial<StatsStepLine>),
      // An older line with no exec cannot be matched to its step, so it still counts.
      action({ step: 3, form: 'has-text', outcome: 'ok' }),
    ];
    const summary = summarizeStats(select(lines), 'form');
    const groups = byKey(summary.groups);
    expect(groups['text-is']).toBeUndefined();
    expect(groups['role']!.actions).toMatchObject({ actions: 1, firstTryOk: 1 });
    expect(groups['has-text']!.actions).toMatchObject({ actions: 1 });
    expect(summary.steps).toMatchObject({ executed: 1 });
  });
});

describe('grouping by site and model: steps join their actions', () => {
  // Step 1 ran two actions on a.example and one on b.example, step 2 one on
  // b.example, and step 3 (an assertion, say) none at all.
  const lines = [
    action({ step: 1, stepText: 'one', site: 'a.example', model: 'm-x' }),
    action({ step: 1, stepText: 'one', site: 'b.example', model: 'm-x', turn: 2 }),
    action({ step: 1, stepText: 'one', site: 'a.example', model: 'm-y', turn: 3 }),
    step({ step: 1, stepText: 'one', turns: 3, calls: 3, tokensIn: 1000, tokensOut: 100 }),
    action({ step: 2, stepText: 'two', site: 'b.example', model: 'm-y' }),
    step({ step: 2, stepText: 'two', calls: 2, tokensIn: 3000, tokensOut: 0 }),
    step({ step: 3, stepText: 'three', turns: 0, calls: 1, tokensIn: 500, tokensOut: 50 }),
  ];

  it('a step counts once, under the site most of its actions ran on', () => {
    const summary = summarizeStats(select(lines), 'site');
    expect(summary.groups.map((group) => group.key)).toEqual(['a.example', 'b.example', null]);
    const groups = byKey(summary.groups);
    // Actions go by their own site...
    expect(groups['a.example']!.actions.actions).toBe(2);
    expect(groups['b.example']!.actions.actions).toBe(2);
    // ...and each step by its actions' commonest.
    expect(groups['a.example']!.steps).toMatchObject({
      executed: 1,
      calls: 3,
      tokensIn: 1000,
      tokensOut: 100,
      tokensPerStep: 1100,
      callsPerStep: 3,
    });
    expect(groups['b.example']!.steps).toMatchObject({ executed: 1, tokensPerStep: 3000, callsPerStep: 2 });
    // The step that chose no action has no site.
    expect(groups['null']!.actions).toMatchObject({ actions: 0, firstTryOkRate: null });
    expect(groups['null']!.steps).toMatchObject({ executed: 1, tokensPerStep: 550, callsPerStep: 1 });
    // So the groups add up to the whole.
    expect(summary.groups.reduce((n, group) => n + group.steps!.executed, 0)).toBe(summary.steps.executed);
  });

  it('and under the model that chose most of them', () => {
    const groups = byKey(summarizeStats(select(lines), 'model').groups);
    expect(groups['m-x']!.actions.actions).toBe(2);
    expect(groups['m-x']!.steps).toMatchObject({ executed: 1, tokensIn: 1000 });
    expect(groups['m-y']!.actions.actions).toBe(2);
    expect(groups['m-y']!.steps).toMatchObject({ executed: 1, tokensIn: 3000 });
    expect(groups['null']!.steps).toMatchObject({ executed: 1, tokensIn: 500 });
  });

  it('a tie goes to the site seen first', () => {
    const tied = [
      action({ step: 1, stepText: 'one', site: 'first.example' }),
      action({ step: 1, stepText: 'one', site: 'second.example', turn: 2 }),
      step({ step: 1, stepText: 'one' }),
    ];
    const groups = byKey(summarizeStats(select(tied), 'site').groups);
    expect(groups['first.example']!.steps!.executed).toBe(1);
    expect(groups['second.example']!.steps!.executed).toBe(0);
  });

  it('never joins across runs or rows', () => {
    const joined = [
      action({ run: 'r1', step: 1, stepText: 'same', site: 'one.example' }),
      step({ run: 'r1', step: 1, stepText: 'same', tokensIn: 100, tokensOut: 0 }),
      action({ run: 'r2', step: 1, stepText: 'same', site: 'two.example' }),
      step({ run: 'r2', step: 1, stepText: 'same', tokensIn: 200, tokensOut: 0 }),
      action({ run: 'r3', row: 1, step: 1, stepText: 'same', site: 'three.example' }),
      step({ run: 'r3', row: 1, step: 1, stepText: 'same', tokensIn: 300, tokensOut: 0 }),
      action({ run: 'r3', row: 2, step: 1, stepText: 'same', site: 'four.example' }),
      step({ run: 'r3', row: 2, step: 1, stepText: 'same', tokensIn: 400, tokensOut: 0 }),
    ];
    const groups = byKey(summarizeStats(select(joined), 'site').groups);
    expect(groups['one.example']!.steps!.tokensIn).toBe(100);
    expect(groups['two.example']!.steps!.tokensIn).toBe(200);
    expect(groups['three.example']!.steps!.tokensIn).toBe(300);
    expect(groups['four.example']!.steps!.tokensIn).toBe(400);
  });

  it('a skipped step opens no group of its own', () => {
    const groups = summarizeStats(select([...lines, step({ step: 4, stepText: 'four', status: 'skipped', firstTry: false })]), 'site').groups;
    expect(groups.map((group) => group.key)).toEqual(['a.example', 'b.example', null]);
    expect(byKey(groups)['null']!.steps!.executed).toBe(1);
  });
});

describe('hook steps', () => {
  // A `before` scope's steps all carry step 0, and a `beforeEach` step the
  // number of the step it runs before: only the hook and the text tell them
  // apart from each other and from that step.
  const lines = [
    action({ step: 0, hook: 'before', stepText: 'Open the app', site: 'open.example' }),
    step({ step: 0, hook: 'before', stepText: 'Open the app', tokensIn: 100, tokensOut: 0 }),
    action({ step: 0, hook: 'before', stepText: 'Sign in', site: 'signin.example', outcome: 'blocked' }),
    action({ step: 0, hook: 'before', stepText: 'Sign in', site: 'signin.example', turn: 2 }),
    step({ step: 0, hook: 'before', stepText: 'Sign in', firstTry: false, tokensIn: 900, tokensOut: 0 }),
    action({ step: 1, hook: 'beforeEach', stepText: 'Dismiss the banner', site: 'banner.example' }),
    step({ step: 1, hook: 'beforeEach', stepText: 'Dismiss the banner', tokensIn: 50, tokensOut: 0 }),
    action({ step: 1, stepText: 'Dismiss the banner', site: 'main.example' }),
    step({ step: 1, stepText: 'Dismiss the banner', tokensIn: 2000, tokensOut: 0 }),
    runLine(),
  ];

  it('are told apart by hook and step text', () => {
    const steps = lines.filter((line): line is StatsStepLine => line.kind === 'step');
    expect(new Set(steps.map((line) => stepKey(line))).size).toBe(4);
    const groups = byKey(summarizeStats(select(lines), 'site').groups);
    expect(Object.keys(groups).sort()).toEqual(['banner.example', 'main.example', 'open.example', 'signin.example']);
    expect(groups['open.example']!.steps!.tokensIn).toBe(100);
    expect(groups['signin.example']!.steps!.tokensIn).toBe(900);
    expect(groups['banner.example']!.steps!.tokensIn).toBe(50);
    expect(groups['main.example']!.steps!.tokensIn).toBe(2000);
  });

  it('link to their own anchor', () => {
    const [failure] = listFailures(select(lines), { limit: 20, reportExists: everyReport }).entries;
    expect(failure).toMatchObject({ step: 0, hook: 'before', stepText: 'Sign in', outcome: 'blocked' });
    expect(failure!.report).toEqual({
      state: 'linked',
      path: REPORT,
      anchor: 'hook-before-step-0',
      href: url(REPORT, 'hook-before-step-0'),
    });
  });
});

describe('grouping by prompt, test and outcome', () => {
  it('prompt: rules versions oldest first, each with its first and last line; no fingerprint last', () => {
    const bare = action({ run: 'bare', t: '2026-09-29T09:00:00.000Z' });
    delete bare.prompt;
    const lines = [
      action({ run: 'imported', prompt: null, imported: true, t: '2026-09-05T00:00:00.000Z' }),
      step({ run: 'imported', prompt: null, imported: true, t: '2026-09-05T00:00:01.000Z' }),
      action({ run: 'new', prompt: 'p-7b20e4', t: '2026-09-28T09:00:00.000Z' }),
      step({ run: 'new', prompt: 'p-7b20e4', t: '2026-09-28T09:00:01.000Z', tokensIn: 3000, tokensOut: 0 }),
      action({ run: 'old1', prompt: 'p-3f9a1c', t: '2026-09-10T00:00:00.000Z', form: 'text-is', outcome: 'no-match' }),
      step({ run: 'old1', prompt: 'p-3f9a1c', t: '2026-09-10T00:00:01.000Z', status: 'failed', firstTry: false, tokensIn: 9000, tokensOut: 0 }),
      action({ run: 'old2', prompt: 'p-3f9a1c', t: '2026-09-28T07:00:00.000Z' }),
      step({ run: 'old2', prompt: 'p-3f9a1c', t: '2026-09-28T07:00:01.000Z', tokensIn: 5000, tokensOut: 0 }),
      bare,
    ];
    const summary = summarizeStats(select(lines), 'prompt');
    expect(summary.groups.map((group) => [group.key, group.keyless])).toEqual([
      ['p-3f9a1c', undefined],
      ['p-7b20e4', undefined],
      [null, 'imported'],
      [null, 'not-step-prompt'],
    ]);
    const [old, current, imported, other] = summary.groups;
    expect(old).toMatchObject({ firstSeen: '2026-09-10T00:00:00.000Z', lastSeen: '2026-09-28T07:00:01.000Z' });
    expect(old!.actions).toMatchObject({ actions: 2, firstTryOk: 1, firstTryOkRate: 0.5, topFailure: { outcome: 'no-match', count: 1 } });
    expect(old!.steps).toMatchObject({ executed: 2, firstTry: 1, failed: 1, tokensPerStep: 7000 });
    expect(current).toMatchObject({ firstSeen: '2026-09-28T09:00:00.000Z', lastSeen: '2026-09-28T09:00:01.000Z' });
    // Imported history (prompt: null) is not today's [use ai] or computer
    // step, which carries no prompt at all: two groups, not one.
    expect(imported!.actions.actions).toBe(1);
    expect(imported!.steps!.executed).toBe(1);
    expect(other!.actions.actions).toBe(1);
    expect(other!.steps!.executed).toBe(0);
  });

  it('prompt: a line marked imported is imported history even without prompt: null', () => {
    const bare = action({ run: 'imported', imported: true });
    delete bare.prompt;
    const groups = summarizeStats(select([bare]), 'prompt').groups;
    expect(groups.map((group) => [group.key, group.keyless])).toEqual([[null, 'imported']]);
  });

  it('test: ad hoc steps (no test) are their own group', () => {
    const lines = [
      action({ test: 'tests/a.md' }),
      action({ test: 'tests/a.md', step: 2 }),
      step({ test: 'tests/a.md' }),
      action({ run: 'errand', test: null }),
      step({ run: 'errand', test: null, tokensIn: 10, tokensOut: 0 }),
    ];
    const summary = summarizeStats(select(lines), 'test');
    expect(summary.groups.map((group) => [group.key, group.actions.actions, group.steps!.executed])).toEqual([
      ['tests/a.md', 2, 1],
      [null, 1, 1],
    ]);
  });

  it('outcome: one group per outcome, no step columns', () => {
    const lines = [
      action({ outcome: 'ok' }),
      action({ outcome: 'ok', step: 2 }),
      action({ outcome: 'no-match', step: 3 }),
      action({ outcome: 'blocked', step: 4 }),
      step(),
    ];
    const summary = summarizeStats(select(lines), 'outcome');
    expect(summary.groups.map((group) => [group.key, group.actions.actions])).toEqual([
      ['ok', 2],
      ['blocked', 1],
      ['no-match', 1],
    ]);
    for (const group of summary.groups) expect(group).not.toHaveProperty('steps');
  });
});

describe('the Steps and Cost lines count executed steps', () => {
  it('passed first try, after a retry, failed; skipped and stopped steps do not count', () => {
    const lines = [
      step({ step: 1, firstTry: true, calls: 1, tokensIn: 1000, tokensOut: 100 }),
      step({ step: 2, firstTry: true, calls: 1, tokensIn: 1000, tokensOut: 100 }),
      step({ step: 3, firstTry: false, attempts: 2, calls: 3, tokensIn: 5000, tokensOut: 300 }),
      step({ step: 4, status: 'failed', firstTry: false, calls: 2, tokensIn: 3000, tokensOut: 200, tokensEstimated: true }),
      step({ step: 5, status: 'failed', firstTry: false, tolerated: true, calls: 1, tokensIn: 900, tokensOut: 100 }),
      // Never ran — its firstTry is false only because it did not pass.
      step({ step: 6, status: 'skipped', firstTry: false, turns: 0, calls: 0, tokensIn: 0, tokensOut: 0 }),
      // Cut short by a Stop.
      step({ step: 7, status: 'failed', firstTry: false, interrupted: true, calls: 4, tokensIn: 99000, tokensOut: 900 }),
    ];
    expect(summarizeStats(select(lines), 'form').steps).toEqual({
      executed: 5,
      firstTry: 2,
      afterRetry: 1,
      afterFailedAction: 0,
      failed: 2,
      calls: 8,
      tokensIn: 10900,
      tokensOut: 800,
      tokensPerStep: 11700 / 5,
      callsPerStep: 8 / 5,
      estimated: true,
    });
  });

  it('only an executed step’s estimate marks the average', () => {
    const lines = [
      step({ step: 1 }),
      step({ step: 2, status: 'skipped', firstTry: false, tokensEstimated: true }),
    ];
    expect(summarizeStats(select(lines), 'form').steps.estimated).toBe(false);
  });

  it('with nothing executed there is no average', () => {
    const { steps } = summarizeStats(select([step({ status: 'skipped', firstTry: false })]), 'form');
    expect(steps).toMatchObject({ executed: 0, tokensPerStep: null, callsPerStep: null });
  });
});

describe('--failures', () => {
  const lines: StatsLine[] = [
    action({ run: 'r1', t: '2026-09-28T07:12:57.000Z', form: 'text-is', selector: ':text-is("Mr")', outcome: 'no-match' }),
    action({ run: 'r1', t: '2026-09-28T07:13:00.000Z', turn: 2 }),
    action({ run: 'r1', t: '2026-09-28T07:13:30.000Z', attempt: 2, form: 'css-role-name', selector: '[role="option"][name="Mr"]', outcome: 'no-match' }),
    runLine({ run: 'r1' }),
    action({ run: 'rows', t: '2026-09-27T08:05:00.000Z', row: 3, step: 2, stepText: 'Click Create account', outcome: 'timeout' }),
    action({ run: 'rows', t: '2026-09-27T08:01:00.000Z', row: 1, step: 0, hook: 'before', stepText: 'Sign in', outcome: 'blocked' }),
    runLine({ run: 'rows', t: '2026-09-27T08:10:00.000Z', report: ROWS_REPORT }),
    // Still running, or crashed: no run line.
    action({ run: 'open', t: '2026-09-25T00:00:00.000Z', outcome: 'other' }),
    // An errand writes no report.
    action({ run: 'errand', t: '2026-09-24T00:00:00.000Z', test: null, outcome: 'invalid-selector' }),
    runLine({ run: 'errand', t: '2026-09-24T00:01:00.000Z', test: null, report: null }),
  ];

  it('lists failed actions newest first, each linked to its step in the report', () => {
    const list = listFailures(select(lines), { limit: 20, reportExists: everyReport });
    expect(list.total).toBe(6);
    expect(list.entries.map((entry) => [entry.run, entry.outcome, entry.attempt])).toEqual([
      ['r1', 'no-match', 2],
      ['r1', 'no-match', 1],
      ['rows', 'timeout', 1],
      ['rows', 'blocked', 1],
      ['open', 'other', 1],
      ['errand', 'invalid-selector', 1],
    ]);
    expect(list.entries[0]).toMatchObject({
      t: '2026-09-28T07:13:30.000Z',
      test: 'tests/recording.md',
      step: 11,
      stepText: 'Select "{{title}}" from the Title Select list',
      action: 'click',
      selector: '[role="option"][name="Mr"]',
      form: 'css-role-name',
      site: 'www.super.test',
      report: { state: 'linked', path: REPORT, anchor: 'step-11', href: url(REPORT, 'step-11') },
    });
    expect(list.entries[2]!.report).toEqual({
      state: 'linked',
      path: ROWS_REPORT,
      anchor: 'row-3-step-2',
      href: url(ROWS_REPORT, 'row-3-step-2'),
    });
    expect(list.entries[3]!.report).toMatchObject({ anchor: 'row-1-hook-before-step-0' });
    expect(list.entries[4]!.report).toEqual({ state: 'pending' });
    expect(list.entries[5]!.report).toEqual({ state: 'none' });
  });

  it('marks a report that is gone, asking the disk once per report (§8.4)', () => {
    const asked: string[] = [];
    const list = listFailures(select(lines), {
      limit: 20,
      reportExists: (file) => {
        asked.push(file);
        return file !== REPORT;
      },
    });
    expect(list.entries[0]!.report).toEqual({ state: 'deleted', path: REPORT });
    expect(list.entries[1]!.report).toEqual({ state: 'deleted', path: REPORT });
    expect(list.entries[2]!.report.state).toBe('linked');
    expect(asked.sort()).toEqual([REPORT, ROWS_REPORT].sort());
    // A check that throws reads as gone rather than failing the command.
    const thrown = listFailures(select(lines), { limit: 1, reportExists: () => { throw new Error('EPERM'); } });
    expect(thrown.entries[0]!.report).toEqual({ state: 'deleted', path: REPORT });
  });

  it('keeps the newest up to the limit and counts the rest; equal times go to the line written later', () => {
    const list = listFailures(select(lines), { limit: 2, reportExists: everyReport });
    expect(list.total).toBe(6);
    expect(list.entries.map((entry) => entry.t)).toEqual(['2026-09-28T07:13:30.000Z', '2026-09-28T07:12:57.000Z']);

    const same = '2026-09-28T07:12:57.000Z';
    const tied = listFailures(
      select([action({ t: same, outcome: 'no-match', turn: 1 }), action({ t: same, outcome: 'timeout', turn: 2 })]),
      { limit: 20, reportExists: everyReport },
    );
    expect(tied.entries.map((entry) => entry.turn)).toEqual([2, 1]);
  });

  it('lists only what the filters let through', () => {
    expect(listFailures(select(lines, { site: 'nowhere' }), { limit: 20, reportExists: everyReport })).toEqual({ total: 0, entries: [] });
  });
});

describe('--costly', () => {
  it('lists steps by tokens, newest first among equals, with their report; tokenless steps are left out', () => {
    const lines = [
      step({ run: 'r1', step: 1, t: '2026-09-20T00:00:00.000Z', tokensIn: 1000, tokensOut: 0 }),
      step({
        run: 'r1',
        step: 2,
        t: '2026-09-21T00:00:00.000Z',
        status: 'failed',
        firstTry: false,
        attempts: 2,
        turns: 3,
        calls: 3,
        tokensIn: 30000,
        tokensOut: 500,
        tokensCached: 12000,
        tokensEstimated: true,
      }),
      step({ run: 'r2', step: 1, t: '2026-09-22T00:00:00.000Z', tokensIn: 900, tokensOut: 100 }),
      step({ run: 'r2', step: 2, t: '2026-09-23T00:00:00.000Z', calls: 0, tokensIn: 0, tokensOut: 0 }),
      runLine({ run: 'r1' }),
    ];
    const list = listCostly(select(lines), { limit: 20, reportExists: everyReport });
    expect(list.total).toBe(3);
    expect(list.entries.map((entry) => [entry.run, entry.step, entry.tokens])).toEqual([
      ['r1', 2, 30500],
      ['r2', 1, 1000],
      ['r1', 1, 1000],
    ]);
    expect(list.entries[0]).toMatchObject({
      status: 'failed',
      firstTry: false,
      attempts: 2,
      calls: 3,
      tokensIn: 30000,
      tokensOut: 500,
      tokensCached: 12000,
      estimated: true,
      report: { state: 'linked', href: url(REPORT, 'step-2') },
    });
    expect(list.entries[1]!.report).toEqual({ state: 'pending' });
    expect(list.entries[2]).toMatchObject({ estimated: false, firstTry: true });
    expect(listCostly(select(lines), { limit: 1, reportExists: everyReport })).toMatchObject({ total: 3, entries: [{ tokens: 30500 }] });
  });
});

describe('reportAnchor (§8.3)', () => {
  it('step-N, row-R-step-N in a data-row report, and a hook step by scope and place', () => {
    expect(reportAnchor({ step: 11 })).toBe('step-11');
    expect(reportAnchor({ step: 11, row: 3 })).toBe('row-3-step-11');
    expect(reportAnchor({ step: 5, hook: 'beforeEach', hookIndex: 2 })).toBe('hook-beforeEach-2-step-5');
    expect(reportAnchor({ step: 0, row: 3, hook: 'before', hookIndex: 1 })).toBe('row-3-hook-before-1-step-0');
    // A line written before hookIndex existed still gets the scope's plain id.
    expect(reportAnchor({ step: 0, hook: 'before' })).toBe('hook-before-step-0');
  });
});

describe('the join between a step and its actions', () => {
  it('with exec, each run of a step joins only its own actions: two passes of a loop body are two steps', () => {
    // The same step, same number, same text, twice in one run — a loop body.
    const lines = [
      action({ exec: 4, step: 5, stepText: 'Click Next', site: 'first.example' }),
      step({ exec: 4, step: 5, stepText: 'Click Next', tokensIn: 100, tokensOut: 0 }),
      action({ exec: 5, step: 5, stepText: 'Click Next', site: 'second.example' }),
      action({ exec: 5, step: 5, stepText: 'Click Next', site: 'second.example', turn: 2 }),
      step({ exec: 5, step: 5, stepText: 'Click Next', tokensIn: 900, tokensOut: 0 }),
    ];
    const groups = byKey(summarizeStats(select(lines), 'site').groups);
    expect(groups['first.example']!.steps).toMatchObject({ executed: 1, tokensIn: 100 });
    expect(groups['second.example']!.steps).toMatchObject({ executed: 1, tokensIn: 900 });
    expect(stepKey(lines[1] as StatsStepLine)).not.toBe(stepKey(lines[4] as StatsStepLine));
  });

  it('without exec (an older line), two lines of one hook scope are told apart by hookIndex', () => {
    // Both `beforeEach` lines say the same thing and share the step number;
    // only their place in the scope separates them.
    const lines = [
      action({ step: 3, hook: 'beforeEach', hookIndex: 1, stepText: 'Dismiss the banner', site: 'one.example' }),
      step({ step: 3, hook: 'beforeEach', hookIndex: 1, stepText: 'Dismiss the banner', tokensIn: 10, tokensOut: 0 }),
      action({ step: 3, hook: 'beforeEach', hookIndex: 2, stepText: 'Dismiss the banner', site: 'two.example' }),
      step({ step: 3, hook: 'beforeEach', hookIndex: 2, stepText: 'Dismiss the banner', tokensIn: 20, tokensOut: 0 }),
    ];
    const groups = byKey(summarizeStats(select(lines), 'site').groups);
    expect(groups['one.example']!.steps).toMatchObject({ executed: 1, tokensIn: 10 });
    expect(groups['two.example']!.steps).toMatchObject({ executed: 1, tokensIn: 20 });
  });

  it('a step line’s own site and model count first; a step with no actions has only those', () => {
    const lines = [
      // An assertion-only step: no action lines, but the page it asked about.
      step({ exec: 1, step: 1, stepText: 'Check the total', site: 'shop.example', model: 'm-judge', tokensIn: 300, tokensOut: 0 }),
      // Its own site wins over its actions' (a redirect mid-step, say).
      action({ exec: 2, step: 2, stepText: 'Pay', site: 'pay.example', model: 'm-act' }),
      step({ exec: 2, step: 2, stepText: 'Pay', site: 'shop.example', model: 'm-act', tokensIn: 700, tokensOut: 0 }),
      // An older line with none of its own takes its actions'.
      action({ exec: 3, step: 3, stepText: 'Done', site: 'pay.example', model: 'm-act' }),
      step({ exec: 3, step: 3, stepText: 'Done', tokensIn: 50, tokensOut: 0 }),
    ];
    const sites = byKey(summarizeStats(select(lines), 'site').groups);
    expect(sites['shop.example']!.steps).toMatchObject({ executed: 2, tokensIn: 1000 });
    expect(sites['pay.example']!.steps).toMatchObject({ executed: 1, tokensIn: 50 });
    const models = byKey(summarizeStats(select(lines), 'model').groups);
    expect(models['m-judge']!.steps).toMatchObject({ executed: 1, tokensIn: 300 });
    // --site and --model find the assertion step by its own fields.
    expect(select(lines, { model: 'm-judge' }).steps.map((line) => line.step)).toEqual([1]);
    expect(select(lines, { site: 'shop' }).steps.map((line) => line.step)).toEqual([1, 2]);
  });
});

describe('steps that asked no model (§7)', () => {
  it('an AI step line with no call and no turn is ignored; a code-behind replay is not', () => {
    const lines = [
      step({ step: 1, calls: 1, tokensIn: 100, tokensOut: 0 }),
      // What older writers recorded for a Set, a tool or a condition that did
      // not hold: nothing the model did.
      step({ step: 2, calls: 0, turns: 0, tokensIn: 0, tokensOut: 0 }),
      step({ step: 3, status: 'skipped', firstTry: false, calls: 0, turns: 0, tokensIn: 0, tokensOut: 0 }),
      // A model turn with no usage reported is still a model step.
      step({ step: 4, calls: 0, turns: 1, tokensIn: 0, tokensOut: 0 }),
      step({ step: 5, source: 'code', calls: 0, turns: 0, tokensIn: 0, tokensOut: 0 }),
    ];
    const selection = select(lines, { sources: ['ai', 'code'] });
    expect(selection.steps.map((line) => line.step)).toEqual([1, 4, 5]);
    expect(selection.inWindow).toEqual({ actions: 0, steps: 3 });
    expect(summarizeStats(selection, 'form').steps).toMatchObject({ executed: 3, firstTry: 3 });
  });
});

describe('the Steps line splits what passed late', () => {
  it('after a retry needs a second attempt; a recovery inside the first attempt is after a failed action', () => {
    const lines = [
      step({ step: 1, firstTry: true }),
      step({ step: 2, firstTry: false, attempts: 2 }),
      step({ step: 3, firstTry: false, attempts: 3 }),
      step({ step: 4, firstTry: false, attempts: 1 }),
      step({ step: 5, status: 'failed', firstTry: false, attempts: 2 }),
    ];
    expect(summarizeStats(select(lines), 'form').steps).toMatchObject({
      executed: 5,
      firstTry: 1,
      afterRetry: 2,
      afterFailedAction: 1,
      failed: 1,
    });
  });

  it('wholePercents: shares that add up to exactly 100, largest remainder first', () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([8, 2, 1, 3])).toEqual([57, 14, 7, 22]);
    expect(wholePercents([2, 1])).toEqual([67, 33]);
    expect(wholePercents([1, 0, 0])).toEqual([100, 0, 0]);
    // A tie on the remainder goes to the larger count, then the earlier.
    expect(wholePercents([1, 2, 3, 1])).toEqual([14, 29, 43, 14]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
    for (const counts of [[3, 3, 3, 3, 3, 3, 1], [7, 11, 13], [1, 1, 1, 1, 1, 1]]) {
      expect(wholePercents(counts).reduce((a, b) => a + b, 0), String(counts)).toBe(100);
    }
  });
});

describe('First try ok and Most common failure count the same actions', () => {
  it('a failure on a retry does not name the commonest first-try failure', () => {
    const lines = [
      action({ form: 'role', outcome: 'ok' }),
      action({ form: 'role', outcome: 'ok', step: 2 }),
      // A retry that failed: counted as an action and in outcomes, not in the
      // first-try columns.
      action({ form: 'role', outcome: 'no-match', attempt: 2 }),
      action({ form: 'role', outcome: 'no-match', attempt: 2, step: 2 }),
      action({ form: 'role', outcome: 'timeout', step: 3 }),
    ];
    const [role] = summarizeStats(select(lines), 'form').groups;
    expect(role!.actions).toEqual({
      actions: 5,
      firstTryActions: 3,
      firstTryOk: 2,
      firstTryOkRate: 2 / 3,
      outcomes: { ok: 2, 'no-match': 2, timeout: 1 },
      topFailure: { outcome: 'timeout', count: 1 },
    });
  });

  it('the two outcomes decided by what the action was count as failures, in §5.4’s order', () => {
    const lines = [
      action({ action: 'assert', selector: null, form: null, outcome: 'assert-failed' }),
      action({ action: 'assert', selector: null, form: null, outcome: 'conceded', step: 2 }),
      action({ action: 'assert', selector: null, form: null, outcome: 'ok', step: 3 }),
    ];
    const summary = summarizeStats(select(lines), 'form');
    // One of each: §5.4 checks `conceded` first, so its order names it.
    expect(summary.actions).toMatchObject({ firstTryOk: 1, topFailure: { outcome: 'conceded', count: 1 } });
    expect(listFailures(select(lines), { limit: 20, reportExists: everyReport }).entries.map((entry) => entry.outcome)).toEqual([
      'conceded',
      'assert-failed',
    ]);
  });
});

describe('--failures and --costly entries', () => {
  it('carry the hook’s place in its scope and the execution', () => {
    const lines = [
      action({ exec: 7, step: 0, hook: 'before', hookIndex: 2, stepText: 'Sign in', outcome: 'blocked' }),
      runLine(),
    ];
    const [entry] = listFailures(select(lines), { limit: 20, reportExists: everyReport }).entries;
    expect(entry).toMatchObject({ step: 0, hook: 'before', hookIndex: 2, exec: 7 });
    expect(entry!.report).toMatchObject({ state: 'linked', anchor: 'hook-before-2-step-0' });
  });

  it('a step with no card in its report links to the report itself', () => {
    const lines = [
      // The branch of a watch group, say: its lines say so (card: false).
      action({ exec: 2, step: 4, outcome: 'timeout', card: false }),
      step({ exec: 2, step: 4, status: 'failed', firstTry: false, card: false, tokensIn: 500, tokensOut: 0 }),
      // An action line that does not say so, of a step line that does.
      action({ exec: 3, step: 5, outcome: 'no-match' }),
      step({ exec: 3, step: 5, status: 'failed', firstTry: false, card: false, tokensIn: 400, tokensOut: 0 }),
      runLine(),
    ];
    const failures = listFailures(select(lines), { limit: 20, reportExists: everyReport }).entries;
    expect(failures).toHaveLength(2);
    for (const entry of failures) {
      expect(entry.report).toEqual({ state: 'no-card', path: REPORT, anchor: null, href: pathToFileURL(REPORT).href });
    }
    const [costliest] = listCostly(select(lines), { limit: 20, reportExists: everyReport }).entries;
    expect(costliest!.report.state).toBe('no-card');
  });

  it('a run with no run line is pending for a day after its last line, then did not finish', () => {
    const lines = [
      action({ run: 'quiet', t: '2026-09-27T08:00:00.000Z', outcome: 'no-match' }),
      // The run's newest line, whatever the window: here, after it.
      step({ run: 'quiet', t: '2026-09-28T09:00:00.000Z', status: 'failed', firstTry: false }),
    ];
    const selection = select(lines, { until: new Date('2026-09-28T00:00:00.000Z') });
    const at = (ms: number) =>
      listFailures(selection, { limit: 20, reportExists: everyReport, now: new Date(ms) }).entries[0]!.report;
    const last = Date.parse('2026-09-28T09:00:00.000Z');
    expect(at(last + UNFINISHED_AFTER_MS)).toEqual({ state: 'pending' });
    expect(at(last + UNFINISHED_AFTER_MS + 1)).toEqual({ state: 'unfinished' });
    // Without a clock there is no telling.
    expect(listFailures(selection, { limit: 20, reportExists: everyReport }).entries[0]!.report).toEqual({ state: 'pending' });
  });

  it('reportHref: a file: URL a terminal can open, the space escaped, the anchor after #', () => {
    const href = reportHref(REPORT, 'step-11');
    expect(href).toBe(url(REPORT, 'step-11'));
    expect(href.startsWith('file:///')).toBe(true);
    expect(href).toContain('my%20templates');
    expect(href.endsWith('/2026-09-28_07-12-50-recording.html#step-11')).toBe(true);
    expect(reportHref(REPORT)).toBe(pathToFileURL(REPORT).href);
  });
});

describe('the models --model could have matched', () => {
  it('every model the other filters let through, most lines first', () => {
    const lines = [
      action({ run: 'a', model: 'openai/gpt-6-luna' }),
      action({ run: 'a', model: 'openai/gpt-6-luna', step: 2 }),
      step({ run: 'a', model: 'openai/gpt-6-luna' }),
      action({ run: 'b', model: 'anthropic/claude-x', site: 'elsewhere.example' }),
      action({ run: 'c', model: 'live/only', suite: 'live' }),
    ];
    const selection = select(lines, { model: 'gpt-6-luna' });
    expect(selection.actions).toEqual([]);
    expect(selection.models).toEqual([
      { model: 'openai/gpt-6-luna', lines: 3 },
      { model: 'anthropic/claude-x', lines: 1 },
    ]);
    // A --site the model's lines fail leaves it out of the list too.
    expect(select(lines, { model: 'x', site: 'elsewhere' }).models).toEqual([{ model: 'anthropic/claude-x', lines: 1 }]);
  });
});
