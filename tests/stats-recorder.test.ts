/**
 * The recorder: one `StepResult` in, the scoreboard's action and step lines
 * out (docs/specs/SPEC-scoreboard.md §5.1, §5.2, §5.7, §7.1), plus the run
 * line (§8.2). The results are built by hand in the shapes the step executor,
 * the guard rows and the `[use ai]` runner produce.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isFirstTry,
  newRunId,
  recordable,
  recordRun,
  recordStep,
  runToLine,
  stepToLines,
  type StatsContext,
  type StepLineMeta,
} from '../src/stats/recorder.js';
import { flushStatsWrites, readStatsLines } from '../src/stats/store.js';
import type { StatsActionLine, StatsStepLine } from '../src/stats/types.js';
import type { AIAction } from '../src/ai/types.js';
import type { AiInteraction, StepResult, SubActionResult, TurnResult } from '../src/report/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';

const NOW = new Date('2026-09-28T07:13:00.000Z');

const CTX: StatsContext = {
  runId: 'r-20260928-071250-4f1c',
  project: 'C:\\work\\templates\\init',
  test: 'tests\\recording.md',
  suite: 'user',
  enabled: true,
};

const META: StepLineMeta = {
  stepText: 'Select "{{title}}" from the Title Select list',
  exec: 7,
  prompt: 'p-3f9a1c',
  fw: '1.0.0+b700473',
  now: NOW,
};

function interaction(over: Partial<AiInteraction> = {}): AiInteraction {
  return {
    purpose: 'action-plan',
    attemptNumber: 1,
    response: '{"actions":[]}',
    model: 'openai/gpt-6-luna',
    usage: { inputTokens: 4000, outputTokens: 120 },
    ...over,
  };
}

function subAction(
  action: Partial<AIAction> & { action: string },
  over: Partial<SubActionResult> = {},
): SubActionResult {
  return {
    index: 1,
    action: { description: 'do it', ...action } as AIAction,
    durationMs: 250,
    pageUrl: 'https://secure.super.test/join?step=2',
    timestamp: '2026-09-28T07:12:57.000Z',
    ...over,
  };
}

function turn(subActions: SubActionResult[], over: Partial<TurnResult> = {}): TurnResult {
  return {
    turnNumber: 1,
    attemptNumber: 1,
    timestamp: '2026-09-28T07:12:55.000Z',
    aiInteractions: [interaction()],
    subActions,
    ...over,
  };
}

function stepResult(over: Partial<StepResult> = {}): StepResult {
  return {
    index: 11,
    instruction: 'Select "Mr" from the Title Select list',
    status: 'passed',
    turns: [],
    durationMs: 1234,
    retried: false,
    ...over,
  };
}

const actions = (lines: ReturnType<typeof stepToLines>) =>
  lines.filter((line): line is StatsActionLine => line.kind === 'action');
const stepOf = (lines: ReturnType<typeof stepToLines>) => {
  const steps = lines.filter((line): line is StatsStepLine => line.kind === 'step');
  expect(steps).toHaveLength(1);
  return steps[0]!;
};

describe('newRunId (§8.1)', () => {
  it('is r-YYYYMMDD-HHMMSS-xxxx in UTC', () => {
    expect(newRunId(new Date('2026-09-28T07:12:50.999Z'), () => '4f1c')).toBe('r-20260928-071250-4f1c');
    // 17:12:50 at UTC+10 is 07:12:50 UTC.
    expect(newRunId(new Date('2026-09-28T17:12:50+10:00'), () => '4f1c')).toBe('r-20260928-071250-4f1c');
  });

  it('draws four random hex digits by default', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newRunId(NOW)));
    for (const id of ids) expect(id).toMatch(/^r-20260928-071300-[0-9a-f]{4}$/);
    expect(ids.size).toBeGreaterThan(1);
  });

  it('stays well-formed on a clock that is not a date', () => {
    expect(newRunId(new Date(Number.NaN), () => 'beef')).toMatch(/^r-\d{8}-\d{6}-beef$/);
  });
});

describe('stepToLines', () => {
  it('a first-try pass: an action line per action, then the step line', () => {
    const result = stepResult({
      turns: [
        turn([
          subAction(
            { action: 'click', selector: 'role=option[name="Mr"]' },
            { targeting: { matchCount: 1, visibleMatchCount: 1 } },
          ),
          subAction(
            { action: 'wait', waitType: 'selector', condition: '#summary' },
            { index: 2, durationMs: 400, timestamp: '2026-09-28T07:12:58.000Z' },
          ),
        ]),
      ],
    });

    const lines = stepToLines(result, CTX, META);
    expect(lines.map((line) => line.kind)).toEqual(['action', 'action', 'step']);

    expect(lines[0]).toEqual({
      v: 1,
      kind: 'action',
      t: '2026-09-28T07:12:57.000Z',
      run: 'r-20260928-071250-4f1c',
      project: 'C:\\work\\templates\\init',
      test: 'tests/recording.md',
      step: 11,
      exec: 7,
      stepText: 'Select "{{title}}" from the Title Select list',
      attempt: 1,
      turn: 1,
      action: 'click',
      selector: 'role=option[name="Mr"]',
      form: 'role',
      outcome: 'ok',
      matchCount: 1,
      ms: 250,
      site: 'secure.super.test',
      model: 'openai/gpt-6-luna',
      prompt: 'p-3f9a1c',
      fw: '1.0.0+b700473',
      suite: 'user',
      source: 'ai',
    });

    expect(stepOf(lines)).toEqual({
      v: 1,
      kind: 'step',
      t: '2026-09-28T07:13:00.000Z',
      run: 'r-20260928-071250-4f1c',
      project: 'C:\\work\\templates\\init',
      test: 'tests/recording.md',
      step: 11,
      exec: 7,
      stepText: 'Select "{{title}}" from the Title Select list',
      status: 'passed',
      attempts: 1,
      turns: 1,
      firstTry: true,
      ms: 1234,
      calls: 1,
      tokensIn: 4000,
      tokensOut: 120,
      // The step's first action line's site and model (contract B).
      site: 'secure.super.test',
      model: 'openai/gpt-6-luna',
      prompt: 'p-3f9a1c',
      fw: '1.0.0+b700473',
      suite: 'user',
      source: 'ai',
    });
    // One execution: every line of the step carries its number.
    for (const line of lines) expect((line as { exec?: number }).exec).toBe(7);
  });

  it('a retried step: an action line per attempt, and both attempts’ calls and tokens on the step', () => {
    const result = stepResult({
      retried: true,
      durationMs: 23000,
      turns: [
        turn([
          subAction(
            { action: 'click', selector: '[role="listbox"] [role="option"]:text-is("Mr")' },
            {
              durationMs: 10012,
              error: "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('[role=\"listbox\"] [role=\"option\"]:text-is(\"Mr\")').filter({ visible: true }).first()\n",
              errorSource: 'playwright',
            },
          ),
        ]),
        turn(
          [
            subAction(
              { action: 'click', selector: 'role=option[name="Mr"]' },
              { timestamp: '2026-09-28T07:13:09.000Z' },
            ),
          ],
          {
            attemptNumber: 2,
            aiInteractions: [
              interaction({ attemptNumber: 2, usage: { inputTokens: 4500, outputTokens: 150, estimated: true } }),
              // A readTable structure question rides the same turn.
              interaction({ purpose: 'grid-structure', attemptNumber: 2, usage: { inputTokens: 900, outputTokens: 40 } }),
            ],
          },
        ),
      ],
      assertions: [
        {
          assertIndex: 0,
          turnNumber: 1,
          subActionIndex: 2,
          description: 'Title shows Mr',
          condition: 'the Title field shows Mr',
          expected: 'Mr',
          pass: true,
          actual: 'Mr',
          aiInteraction: interaction({
            purpose: 'assertion[0]',
            attemptNumber: 2,
            usage: { inputTokens: 800, outputTokens: 60, cachedInputTokens: 500 },
          }),
        } as NonNullable<StepResult['assertions']>[number],
      ],
    });

    const lines = stepToLines(result, CTX, META);
    expect(actions(lines).map((line) => [line.attempt, line.turn, line.form, line.outcome])).toEqual([
      [1, 1, 'text-is', 'no-match'],
      [2, 1, 'role', 'ok'],
    ]);
    expect(stepOf(lines)).toMatchObject({
      status: 'passed',
      attempts: 2,
      turns: 2,
      firstTry: false,
      ms: 23000,
      calls: 4,
      tokensIn: 4000 + 4500 + 900 + 800,
      tokensOut: 120 + 150 + 40 + 60,
      tokensCached: 500,
      tokensEstimated: true,
    });
  });

  it('actions with no selector are recorded, with selector and form null', () => {
    const result = stepResult({
      turns: [
        turn([
          subAction({ action: 'navigate', url: 'https://www.super.test/' }),
          subAction({ action: 'keypress', value: 'Enter' }, { index: 2 }),
          subAction({ action: 'wait', waitType: 'url', condition: '**/join' }, { index: 3 }),
          subAction({ action: 'click', selector: '   ' }, { index: 4 }),
        ]),
      ],
    });
    const lines = actions(stepToLines(result, CTX, META));
    expect(lines.map((line) => [line.action, line.selector, line.form])).toEqual([
      ['navigate', null, null],
      ['keypress', null, null],
      ['wait', null, null],
      ['click', null, null],
    ]);
    for (const line of lines) expect(line.outcome).toBe('ok');
  });

  it('a code-behind step writes a step line only, tagged code, with no calls — and no rules fingerprint', () => {
    const lines = stepToLines(stepResult({ fromCodeBehind: true, durationMs: 80 }), CTX, META);
    expect(lines).toHaveLength(1);
    expect(stepOf(lines)).toMatchObject({
      source: 'code',
      status: 'passed',
      attempts: 1,
      turns: 0,
      firstTry: true,
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      exec: 7,
    });
    expect(stepOf(lines)).not.toHaveProperty('tokensCached');
    // It was never shown the rules, so it is not counted under them (contract D).
    expect(stepOf(lines)).not.toHaveProperty('prompt');
    expect(stepOf(lines)).toHaveProperty('fw');
  });

  it('a code-behind replay that reports its own actions writes them as code, with no model', () => {
    const result = stepResult({
      fromCodeBehind: true,
      turns: [turn([subAction({ action: 'click', selector: '#join' })], { aiInteractions: [] })],
    });
    const lines = stepToLines(result, CTX, META);
    const [action] = actions(lines);
    expect(action).toMatchObject({ source: 'code', form: 'id', outcome: 'ok' });
    expect(action).not.toHaveProperty('model');
    expect(stepOf(lines)).toMatchObject({ source: 'code', calls: 0 });
  });

  it('masks a secret in the selector, the step text and the site; the placeholder stays', () => {
    const result = stepResult({
      turns: [
        turn([
          subAction(
            { action: 'click', selector: 'role=row[name="alice@example.com"] >> role=button[name="Edit"]' },
            { pageUrl: 'https://corp-secret.example.com/accounts' },
          ),
        ]),
      ],
    });
    const ctx: StatsContext = { ...CTX, maskValues: ['alice@example.com', 'corp-secret'] };
    const meta: StepLineMeta = { ...META, stepText: 'Edit the row for alice@example.com using {{password}}' };

    const lines = stepToLines(result, ctx, meta);
    const [action] = actions(lines);
    expect(action!.selector).toBe('role=row[name="***"] >> role=button[name="Edit"]');
    expect(action!.form).toBe('role');
    expect(action!.site).toBe('***.example.com');
    expect(action!.stepText).toBe('Edit the row for *** using {{password}}');
    expect(stepOf(lines).stepText).toBe('Edit the row for *** using {{password}}');

    const written = JSON.stringify(lines);
    expect(written).not.toContain('alice@example.com');
    expect(written).not.toContain('corp-secret');
  });

  it('never records what an action typed', () => {
    // No mask set at all: the value must be absent because it is never read.
    const result = stepResult({
      turns: [
        turn([
          subAction({ action: 'type', selector: '#password', value: 'hunter2', description: 'Type hunter2 into the password field' }),
          subAction({ action: 'select', selector: '#title', value: 'Dr Who' }, { index: 2 }),
        ]),
      ],
    });
    const lines = stepToLines(result, CTX, META);
    for (const line of lines) expect(line).not.toHaveProperty('value');
    const written = JSON.stringify(lines);
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('Dr Who');
  });

  it('the row comes from the context, or from the step’s own data-row marker', () => {
    const one = turn([subAction({ action: 'click', selector: '#go' })]);
    const inRow = stepToLines(stepResult({ turns: [one] }), { ...CTX, row: 3 }, META);
    for (const line of inRow) expect(line).toMatchObject({ row: 3 });

    const marked = stepToLines(
      stepResult({ turns: [one], loop: { kind: 'row', index: 2, count: 4, values: {} } }),
      CTX,
      META,
    );
    for (const line of marked) expect(line).toMatchObject({ row: 2 });

    // A section loop's iteration is not a data row.
    const iteration = stepToLines(
      stepResult({ turns: [one], loop: { kind: 'iteration', label: 'Each order', index: 2, values: {} } }),
      CTX,
      META,
    );
    for (const line of iteration) expect(line).not.toHaveProperty('row');
  });

  it('tags a hook’s step, which shares the number of the step it wraps', () => {
    const one = turn([subAction({ action: 'click', selector: '#accept-cookies' })]);
    const hook = stepToLines(stepResult({ turns: [one], hookScope: 'beforeEach' }), CTX, META);
    for (const line of hook) expect(line).toMatchObject({ step: 11, hook: 'beforeEach' });

    const main = stepToLines(stepResult({ turns: [one] }), CTX, META);
    for (const line of main) expect(line).not.toHaveProperty('hook');
  });

  it('copies tolerated and interrupted only when set', () => {
    const tolerated = stepOf(stepToLines(stepResult({ status: 'failed', tolerated: true }), CTX, META));
    expect(tolerated).toMatchObject({ status: 'failed', tolerated: true, firstTry: false });
    expect(tolerated).not.toHaveProperty('interrupted');

    const stopped = stepOf(stepToLines(stepResult({ status: 'failed', interrupted: true }), CTX, META));
    expect(stopped).toMatchObject({ interrupted: true });

    const plain = stepOf(stepToLines(stepResult({ tolerated: false, interrupted: false }), CTX, META));
    expect(plain).not.toHaveProperty('tolerated');
    expect(plain).not.toHaveProperty('interrupted');
  });

  it('counts every call once, with usage or without', () => {
    const shared = interaction({ usage: { inputTokens: 100, outputTokens: 10 } });
    const result = stepResult({
      turns: [
        turn([subAction({ action: 'click', selector: '#go' })], {
          // A call whose usage was not carried through still happened.
          aiInteractions: [shared, interaction({ purpose: 'clarification', usage: undefined })],
        }),
      ],
      // The same interaction filed on an assertion too is still one call.
      assertions: [
        {
          assertIndex: 0,
          turnNumber: 1,
          subActionIndex: 2,
          description: 'd',
          condition: 'c',
          expected: 'e',
          pass: true,
          actual: 'e',
          aiInteraction: shared,
        } as NonNullable<StepResult['assertions']>[number],
      ],
    });
    expect(stepOf(stepToLines(result, CTX, META))).toMatchObject({ calls: 2, tokensIn: 100, tokensOut: 10 });
  });

  it('takes the model from the turn’s first call that names one', () => {
    const result = stepResult({
      turns: [
        turn([subAction({ action: 'click', selector: '#go' })], {
          aiInteractions: [interaction({ model: undefined }), interaction({ model: 'anthropic/claude-x' })],
        }),
      ],
    });
    expect(actions(stepToLines(result, CTX, META))[0]!.model).toBe('anthropic/claude-x');
  });

  it('dates an action by its own completion time, else when the step ended', () => {
    const result = stepResult({
      turns: [
        turn([
          subAction({ action: 'click', selector: '#a' }, { timestamp: undefined }),
          subAction({ action: 'click', selector: '#b' }, { index: 2, timestamp: 'not a time' }),
        ]),
      ],
    });
    for (const line of actions(stepToLines(result, CTX, META))) expect(line.t).toBe(NOW.toISOString());
  });

  it('leaves out what it does not know rather than guessing', () => {
    const result = stepResult({
      turns: [
        turn([subAction({ action: 'click', selector: '#go' }, { pageUrl: 'about:blank' })], { aiInteractions: [] }),
      ],
    });
    const lines = stepToLines(result, { ...CTX, test: null }, { stepText: 'Click Go', exec: 1 });
    const [action] = actions(lines);
    for (const key of ['site', 'model', 'prompt', 'fw', 'matchCount', 'row', 'card']) {
      expect(action, key).not.toHaveProperty(key);
    }
    expect(action!.test).toBeNull();
    for (const key of ['prompt', 'site', 'model', 'card']) expect(stepOf(lines), key).not.toHaveProperty(key);
  });

  it('a step line with no action line takes its site and model from its first model call that has one', () => {
    // A `[use ai]` step's shape, and a step whose only turn asked a question:
    // no actions, so the calls are all there is.
    const result = stepResult({
      turns: [
        turn([], {
          aiInteractions: [
            interaction({ purpose: 'clarification', model: undefined, pageUrl: undefined }),
            interaction({ model: 'anthropic/claude-x', pageUrl: 'https://corp-secret.example.com/login' }),
          ],
        }),
      ],
    });
    const lines = stepToLines(result, { ...CTX, maskValues: ['corp-secret'] }, META);
    expect(actions(lines)).toHaveLength(0);
    // Masked as an action line's site is.
    expect(stepOf(lines)).toMatchObject({ site: '***.example.com', model: 'anthropic/claude-x', calls: 2 });

    // A model call on no page (a `[use ai]` call) gives a model and no site.
    const useAi = stepToLines(
      stepResult({ turns: [turn([], { aiInteractions: [interaction({ purpose: 'use-ai', pageUrl: undefined })] })] }),
      CTX,
      META,
    );
    expect(stepOf(useAi)).toMatchObject({ model: 'openai/gpt-6-luna' });
    expect(stepOf(useAi)).not.toHaveProperty('site');
  });

  it('a step line prefers its first action line’s site and model over its calls', () => {
    const result = stepResult({
      turns: [
        turn([subAction({ action: 'click', selector: '#go' }, { pageUrl: 'https://shop.test/cart' })], {
          aiInteractions: [interaction({ model: 'm-plan', pageUrl: 'https://other.test/' })],
        }),
      ],
    });
    expect(stepOf(stepToLines(result, CTX, META))).toMatchObject({ site: 'shop.test', model: 'm-plan' });
  });

  it('files an action that moved the page under the page it ran on, not the one it led to', () => {
    // Measured on www.super.test: "Click Join super" ran on www.super.test and
    // landed on secure.super.test, and was filed under the latter.
    const result = stepResult({
      turns: [
        turn([
          subAction(
            { action: 'click', selector: 'role=link[name="Join super"]' },
            { pageUrl: 'https://secure.super.test/join', actionPageUrl: 'https://www.super.test/' },
          ),
          subAction({ action: 'click', selector: '#next' }, { pageUrl: 'https://secure.super.test/join' }),
        ]),
      ],
    });
    const lines = stepToLines(result, CTX, META);
    expect(actions(lines).map((line) => line.site)).toEqual(['www.super.test', 'secure.super.test']);
    expect(stepOf(lines)).toMatchObject({ site: 'www.super.test' });
  });

  it('card: false on every line of a step the report has no card for, and absent otherwise', () => {
    const result = stepResult({ turns: [turn([subAction({ action: 'click', selector: '#not-now' })])] });
    for (const line of stepToLines(result, { ...CTX, card: false }, META)) expect(line).toMatchObject({ card: false });
    for (const line of stepToLines(result, CTX, META)) expect(line).not.toHaveProperty('card');
  });

  it('a skill body’s step text is recorded as authored: the __skill<N>_ renames come off, and masking still applies', () => {
    const result = stepResult({ turns: [turn([subAction({ action: 'type', selector: '#code' })])] });
    const lines = stepToLines(result, { ...CTX, maskValues: ['s3cret'] }, {
      ...META,
      stepText: 'Type {{__skill1_code}} for s3cret, then read the total [store as: __skill2___skill1_total]',
    });
    expect(stepOf(lines).stepText).toBe('Type {{code}} for ***, then read the total [store as: total]');
    // Only the prefix the expander adds, and only in a placeholder.
    const plain = stepToLines(result, CTX, { ...META, stepText: 'Find __skill1_x in {{ __skill3_order.id }}' });
    expect(stepOf(plain).stepText).toBe('Find __skill1_x in {{ order.id }}');
  });

  it('a wait on an element records its selector and form from `condition` (prompt rule 12)', () => {
    const result = stepResult({
      turns: [
        turn([
          subAction({ action: 'wait', waitType: 'selector', condition: 'role=dialog[name="alice@example.com"]' }),
          subAction({ action: 'wait', waitType: 'hidden', condition: '#spinner' }, { index: 2 }),
          subAction({ action: 'wait', waitType: 'count', condition: 'ul.results > li:nth-child(3)', expected: '3' }, { index: 3 }),
          subAction({ action: 'wait', waitType: 'attribute', selector: '[data-testid="save"]', expected: '!disabled' }, { index: 4 }),
          subAction({ action: 'wait', waitType: 'url', condition: '**/done' }, { index: 5 }),
        ]),
      ],
    });
    const lines = actions(stepToLines(result, { ...CTX, maskValues: ['alice@example.com'] }, META));
    expect(lines.map((line) => [line.selector, line.form])).toEqual([
      ['role=dialog[name="***"]', 'role'],
      ['#spinner', 'id'],
      ['ul.results > li:nth-child(3)', 'positional'],
      ['[data-testid="save"]', 'testid'],
      [null, null],
    ]);
  });

  it('outcomes by structure: a concession, a page assertion, and a computer verdict', () => {
    const concession = subAction(
      { action: 'assert', holds: false, evidence: 'no Title list' } as never,
      { error: 'The model reported that this step cannot be done: no Title list' },
    );
    const failedAssert = subAction(
      { action: 'assert', condition: 'total is 3' },
      { index: 2, error: 'Assertion failed: Total — got "Timeout 5000ms exceeded"' },
    );
    const page = stepToLines(stepResult({ status: 'failed', turns: [turn([concession, failedAssert])] }), CTX, META);
    expect(actions(page).map((line) => line.outcome)).toEqual(['conceded', 'assert-failed']);

    // The same concession-shaped action on the computer surface is the model's
    // verdict on the screen.
    const computer = stepToLines(
      stepResult({ status: 'failed', surface: 'computer', turns: [turn([concession])] }),
      CTX,
      META,
    );
    expect(actions(computer)[0]!.outcome).toBe('assert-failed');
  });

  it('counts the calls a step discarded — a failed attempt’s assertion code', () => {
    const discarded = interaction({ purpose: 'assertion[0]', usage: { inputTokens: 9000, outputTokens: 300 } });
    const result = stepResult({
      status: 'failed',
      turns: [turn([subAction({ action: 'assert', condition: 'c' }, { error: 'Assertion failed: c — got "x"' })])],
      discardedAiInteractions: [discarded],
    });
    expect(stepOf(stepToLines(result, CTX, META))).toMatchObject({ calls: 2, tokensIn: 13000, tokensOut: 420 });
  });
});

describe('recordable (contract D)', () => {
  it('a step that asked the model, or a code-behind replay — nothing else', () => {
    expect(recordable(stepResult({ turns: [turn([subAction({ action: 'click', selector: '#go' })])] }))).toBe(true);
    expect(recordable(stepResult({ fromCodeBehind: true }))).toBe(true);
    // A flow-control condition the run's values answered: no turns, no call.
    expect(recordable(stepResult({ flowControl: { kind: 'return', verb: 'return' } }))).toBe(false);
    // A `[use ai]` refusal, a keyless failure: failed before any call.
    expect(recordable(stepResult({ status: 'failed', error: 'AI is not configured' }))).toBe(false);
    // A failed attempt whose only record of its calls is the discarded list.
    expect(recordable(stepResult({ status: 'failed', discardedAiInteractions: [interaction()] }))).toBe(true);
  });
});

describe('isFirstTry', () => {
  it('only a pass on attempt 1 with no failed action', () => {
    const ok = turn([subAction({ action: 'click', selector: '#go' })]);
    const failedAction = turn([subAction({ action: 'click', selector: '#go' }, { error: 'boom' })]);
    const secondTurn = turn([subAction({ action: 'click', selector: '#go2' })], { turnNumber: 2 });

    expect(isFirstTry(stepResult({ turns: [ok] }))).toBe(true);
    // The model recovered inside its first attempt: a pass, not a first try.
    expect(isFirstTry(stepResult({ turns: [failedAction, secondTurn] }))).toBe(false);
    expect(isFirstTry(stepResult({ turns: [ok], retried: true }))).toBe(false);
    expect(isFirstTry(stepResult({ turns: [ok], status: 'failed' }))).toBe(false);
    expect(isFirstTry(stepResult({ turns: [], status: 'skipped' }))).toBe(false);
  });
});

describe('runToLine (§8.2)', () => {
  it('summarises the run and links its report', () => {
    const line = runToLine(CTX, {
      status: 'failed',
      aborted: true,
      steps: 14,
      firstTry: 11,
      failed: 1,
      tokensIn: 52000,
      tokensOut: 2100,
      report: 'C:\\work\\templates\\init\\reports\\2026-09-28_07-12-50-recording.html',
      now: NOW,
    });
    expect(line).toEqual({
      v: 1,
      kind: 'run',
      t: '2026-09-28T07:13:00.000Z',
      run: 'r-20260928-071250-4f1c',
      project: 'C:\\work\\templates\\init',
      test: 'tests/recording.md',
      suite: 'user',
      status: 'failed',
      aborted: true,
      steps: 14,
      firstTry: 11,
      failed: 1,
      tokensIn: 52000,
      tokensOut: 2100,
      report: 'C:\\work\\templates\\init\\reports\\2026-09-28_07-12-50-recording.html',
    });
  });

  it('a run with no report and no totals says so by absence and null', () => {
    const line = runToLine({ ...CTX, test: null }, { status: 'passed', aborted: false, steps: 2, firstTry: 2, failed: 0, report: null, now: NOW });
    expect(line.report).toBeNull();
    expect(line.test).toBeNull();
    for (const key of ['aborted', 'tokensIn', 'tokensOut']) expect(line, key).not.toHaveProperty(key);
  });
});

describe('recordStep and recordRun', () => {
  let tmp: string;
  let deps: UserRootDeps;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-stats-recorder-')));
    deps = { env: { LOCALAPPDATA: tmp, XDG_CONFIG_HOME: tmp }, platform: process.platform };
  });

  afterEach(async () => {
    await flushStatsWrites();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const result = () => stepResult({ turns: [turn([subAction({ action: 'click', selector: '#go' })])] });

  it('write the lines stepToLines makes, then the run line', async () => {
    const ctx: StatsContext = { ...CTX, deps };
    recordStep(result(), ctx, META);
    recordRun(ctx, { status: 'passed', steps: 1, firstTry: 1, failed: 0, report: null, now: NOW });
    await flushStatsWrites();

    const { lines, skipped } = await readStatsLines({ deps });
    expect(skipped).toBe(0);
    expect(lines).toEqual([
      ...stepToLines(result(), ctx, META),
      runToLine(ctx, { status: 'passed', steps: 1, firstTry: 1, failed: 0, report: null, now: NOW }),
    ]);
  });

  it('write nothing for a step that asked the model nothing', async () => {
    recordStep(stepResult({ flowControl: { kind: 'return', verb: 'return' } }), { ...CTX, deps }, META);
    await flushStatsWrites();
    expect(fs.existsSync(path.join(tmp, 'steptix', 'stats'))).toBe(false);
  });

  it('write nothing when recording is off', async () => {
    const ctx: StatsContext = { ...CTX, deps, enabled: false };
    recordStep(result(), ctx, META);
    recordRun(ctx, { status: 'passed', steps: 1, firstTry: 1, failed: 0, report: null, now: NOW });
    await flushStatsWrites();
    expect(fs.existsSync(path.join(tmp, 'steptix', 'stats'))).toBe(false);
  });

  it('a malformed result costs its lines, never the step', async () => {
    const broken = { ...result(), turns: undefined } as unknown as StepResult;
    expect(() => recordStep(broken, { ...CTX, deps }, META)).not.toThrow();
    expect(() => recordRun({ ...CTX, deps }, { status: 'passed', steps: 1, firstTry: 1, failed: 0, report: null, now: new Date(Number.NaN) })).not.toThrow();
    await flushStatsWrites();
    expect(fs.existsSync(path.join(tmp, 'steptix', 'stats'))).toBe(false);
  });
});
