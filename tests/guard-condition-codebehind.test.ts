/**
 * A guard decided by code-behind (stories/codebehind-loops-and-conditions.md,
 * "The guard" — decisions 5 to 8).
 *
 * `evaluateGuard` asks values, then code, then the model. Everything here runs
 * the REAL `evaluateGuard`, the real planner and the real `runConditionCode`
 * against hand-built bindings; only the two things that would touch a live
 * browser or a model are replaced — the condition judge (`evaluateConditions`)
 * and the settle gate (`settleBeforeConditions`), which are counted so a test
 * can say "the model was not asked" and "the page was settled first".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import type { CodeBehindContext, StepCodeEntry } from '../src/codebehind/types.js';
import {
  capBreachAt,
  createControlState,
  type ControlRecord,
  type ControlState,
} from '../src/runner/control-flow.js';
import { logger } from '../src/utils/logger.js';

const judge = vi.hoisted(() => ({
  calls: [] as string[][],
  answers: [] as Array<number | null>,
  evidence: { dom: '<main>Page 4 of 4 <button disabled>Next</button></main>', url: 'https://app.test/list?page=4' },
}));
const settle = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../src/runner/step-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runner/step-executor.js')>()),
  evaluateConditions: vi.fn(async (conditions: string[]) => {
    judge.calls.push([...conditions]);
    const selected = judge.answers.length > 0 ? judge.answers.shift()! : null;
    return {
      selected,
      reasoning: selected === null ? 'the model saw none hold' : `the model saw ${selected} hold`,
      aiInteractions: [{ purpose: 'condition-judge', response: '{}', timestamp: 'now' }],
      evidence: judge.evidence,
    };
  }),
  settleBeforeConditions: vi.fn(async () => {
    settle.calls++;
  }),
}));

import {
  CONDITION_EXIT_REFUSED,
  evaluateGuard,
  guardCodeBehindFields,
  guardResult,
  type GuardCodeBehind,
} from '../src/runner/control-runtime.js';
import {
  KEYLESS_HEAL_SKIPPED_ERROR,
  POLICY_HEAL_SKIPPED_ERROR,
  type StepExecutorOptions,
} from '../src/runner/step-executor.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FILE = '/p/tests/list.steps.ts';

function binding(
  source: string,
  entry?: Omit<StepCodeEntry, 'source'>,
): CodeBehindBinding {
  return {
    file: FILE,
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...(entry && { entry: { source, ...entry } }),
  };
}

/** A condition entry answering from a script, one value per call — the last
 *  one repeating — and counting its calls. */
function scripted(...answers: unknown[]): {
  condition: (ctx: CodeBehindContext) => Promise<boolean>;
  calls: () => number;
} {
  let n = 0;
  return {
    condition: async ({ log }) => {
      n++;
      log.info(`call ${n}`);
      return answers[Math.min(n, answers.length) - 1] as boolean;
    },
    calls: () => n,
  };
}

/** Enough `Page` for `runConditionCode`'s context builder. */
const page = {
  url: () => 'https://app.test/list',
  context: () => ({ browser: () => ({}) }),
} as unknown as Page;

const CONFIG: Config = { ...DEFAULT_CONFIG };

function options(parameters: Record<string, string> = {}, extra: Partial<StepExecutorOptions> = {}): StepExecutorOptions {
  return {
    page,
    config: CONFIG,
    aiClient: {} as AiClient,
    contextContent: '',
    testName: 'list',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: parameters,
    ...extra,
  };
}

/**
 * ```
 * 0  While the Next button is enabled, Go to the next page   body 1..1
 * 1    Go to the next page
 * ```
 */
const WHILE_TEXT = 'the Next button is enabled';
const whileControls = (cap?: number): (ControlRecord | null)[] => [
  {
    kind: 'while',
    condition: WHILE_TEXT,
    bodyStart: 1,
    bodyEnd: 1,
    label: 'Go to the next page',
    ...(cap !== undefined && { cap }),
  },
  null,
];

const REPEAT_TEXT = 'the Load more button is gone';
const repeatControls = (cap?: number): (ControlRecord | null)[] => [
  {
    kind: 'repeat',
    condition: REPEAT_TEXT,
    bodyStart: 1,
    bodyEnd: 1,
    label: 'Click Load more',
    ...(cap !== undefined && { cap }),
  },
  null,
];

/**
 * ```
 * 0  If A, then …             body 1..1   chain ends 7
 * 1    …
 * 2  Else if B, then …        body 3..3
 * 3    …
 * 4  Else if C, then …        body 5..5
 * 5    …
 * 6  Otherwise, …             body 7..7
 * 7    …
 * ```
 */
const A = 'the Cash checkbox is ticked';
const B = 'the Card checkbox is ticked';
const C = 'the Voucher checkbox is ticked';
const CHAIN: (ControlRecord | null)[] = [
  { kind: 'if', chainId: 'c', condition: A, bodyStart: 1, bodyEnd: 1, chainEnd: 7 },
  null,
  { kind: 'elseif', chainId: 'c', condition: B, bodyStart: 3, bodyEnd: 3, chainEnd: 7 },
  null,
  { kind: 'elseif', chainId: 'c', condition: C, bodyStart: 5, bodyEnd: 5, chainEnd: 7 },
  null,
  { kind: 'else', chainId: 'c', bodyStart: 7, bodyEnd: 7, chainEnd: 7 },
  null,
];

function registry(bindings: Record<number, CodeBehindBinding>, extra: Partial<GuardCodeBehind> = {}): GuardCodeBehind {
  return { bindingFor: (k) => bindings[k], ...extra };
}

async function visit(args: {
  controls: (ControlRecord | null)[];
  state: ControlState;
  codeBehind?: GuardCodeBehind;
  parameters?: Record<string, string>;
  extra?: Partial<StepExecutorOptions>;
  index?: number;
}) {
  const parameters = args.parameters ?? {};
  return evaluateGuard({
    controls: args.controls,
    index: args.index ?? 0,
    state: args.state,
    resolvedParameters: parameters,
    executorOptions: options(parameters, args.extra),
    ...(args.codeBehind && { codeBehind: args.codeBehind }),
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  judge.calls.length = 0;
  judge.answers = [];
  settle.calls = 0;
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Loops ───────────────────────────────────────────────────────────────────

describe('a While decided by its condition entry', () => {
  it('runs its passes with no model call, and ends when the code says false', async () => {
    const code = scripted(true, true, false);
    const cb = registry({ 0: binding(`While ${WHILE_TEXT}, Go to the next page`, { condition: code.condition }) });
    const state = createControlState();
    const controls = whileControls();

    const first = await visit({ controls, state, codeBehind: cb });
    expect(first.error).toBeUndefined();
    expect(first.plan.pass).toEqual({ iteration: 1 });
    expect(first.fromCodeBehind).toBe(true);
    expect(first.guard).toEqual({ decidedBy: 'code', holds: true });
    expect(first.reasoning).toBe(`Decided by code-behind: "${WHILE_TEXT}" → true`);
    expect(first.aiInteractions).toEqual([]);
    // The code block is the entry that ran, with its logs.
    expect(first.codeBehind?.file).toBe(FILE);
    expect(first.codeBehind?.code).toContain('call');
    expect(first.codeBehind?.logs).toEqual([{ level: 'info', message: 'call 1' }]);

    expect((await visit({ controls, state, codeBehind: cb })).plan.pass).toEqual({ iteration: 2 });
    const last = await visit({ controls, state, codeBehind: cb });
    expect(last.plan.loopEnded).toEqual({ guard: 0, count: 2 });
    expect(last.guard).toEqual({ decidedBy: 'code', holds: false });

    expect(judge.calls).toEqual([]);
    expect(code.calls()).toBe(3);
    // The page settled before every read — the gate the model would have had.
    expect(settle.calls).toBe(3);
  });

  it('leaves the guard on the model when no binding has a condition entry', async () => {
    judge.answers = [0];
    const ev = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({ 0: binding(`While ${WHILE_TEXT}, Go to the next page`) }),
    });
    expect(judge.calls).toEqual([[WHILE_TEXT]]);
    expect(ev.fromCodeBehind).toBeUndefined();
    expect(ev.guard).toEqual({ decidedBy: 'model', holds: true });
    // No code ran, so nothing waited for the page on the code's behalf.
    expect(settle.calls).toBe(0);
  });

  it('does not use code on the computer surface', async () => {
    const code = scripted(true);
    judge.answers = [0];
    await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({ 0: binding('w', { condition: code.condition }) }),
      extra: { computer: {} as StepExecutorOptions['computer'] },
    });
    expect(code.calls()).toBe(0);
    expect(judge.calls).toHaveLength(1);
  });
});

describe('a Repeat … until decided by its condition entry', () => {
  it('reads the condition as written: true STOPS the loop', async () => {
    const code = scripted(false, true);
    const cb = registry({ 0: binding('r', { condition: code.condition }) });
    const state = createControlState();
    const controls = repeatControls();

    // Pass 1 runs before there is anything to decide — no code, no row.
    const opening = await visit({ controls, state, codeBehind: cb });
    expect(opening.evaluated).toBe(false);
    expect(opening.guard).toBeUndefined();
    expect(code.calls()).toBe(0);

    // "Not gone yet" → another pass.
    const again = await visit({ controls, state, codeBehind: cb });
    expect(again.plan.pass).toEqual({ iteration: 2 });
    expect(again.guard).toEqual({ decidedBy: 'code', holds: false });

    // "Gone" → the loop ends.
    const done = await visit({ controls, state, codeBehind: cb });
    expect(done.plan.loopEnded).toEqual({ guard: 0, count: 2 });
    expect(done.guard).toEqual({ decidedBy: 'code', holds: true });
    expect(judge.calls).toEqual([]);
  });
});

// ─── Chains ──────────────────────────────────────────────────────────────────

describe('a chain decided by code', () => {
  it('stops at the first member that holds; later members are not run', async () => {
    const a = scripted(false);
    const b = scripted(true);
    const c = scripted(true);
    const ev = await visit({
      controls: CHAIN,
      state: createControlState(),
      codeBehind: registry({
        0: binding(`If ${A}, then x`, { condition: a.condition }),
        2: binding(`Else if ${B}, then y`, { condition: b.condition }),
        4: binding(`Else if ${C}, then z`, { condition: c.condition }),
      }),
    });

    expect(ev.plan.selected).toBe(2);
    expect(ev.guard).toEqual({ decidedBy: 'code', selected: 2 });
    expect(ev.reasoning).toBe(`Decided by code-behind: "${A}" → false, "${B}" → true`);
    expect([a.calls(), b.calls(), c.calls()]).toEqual([1, 1, 0]);
    expect(judge.calls).toEqual([]);
    // Both members' code is in the block, each under its own source line.
    expect(ev.codeBehind?.code).toContain(`// If ${A}, then x`);
    expect(ev.codeBehind?.code).toContain(`// Else if ${B}, then y`);
    expect(settle.calls).toBe(1);
  });

  it('selects the Otherwise when every coded member answers false', async () => {
    const ev = await visit({
      controls: CHAIN,
      state: createControlState(),
      codeBehind: registry({
        0: binding('a', { condition: scripted(false).condition }),
        2: binding('b', { condition: scripted(false).condition }),
        4: binding('c', { condition: scripted(false).condition }),
      }),
    });
    expect(ev.plan.selected).toBe(6);
    expect(ev.guard).toEqual({ decidedBy: 'code', selected: null });
  });

  it('goes to the model WHOLE when one member has no entry, and runs no code', async () => {
    const a = scripted(true);
    judge.answers = [1];
    const ev = await visit({
      controls: CHAIN,
      state: createControlState(),
      codeBehind: registry({
        0: binding('a', { condition: a.condition }),
        2: binding('b'),
        4: binding('c', { condition: scripted(false).condition }),
      }),
    });
    expect(judge.calls).toEqual([[A, B, C]]);
    expect(a.calls()).toBe(0);
    expect(ev.plan.selected).toBe(2);
    expect(ev.guard).toEqual({ decidedBy: 'model', selected: 2 });
    expect(ev.fromCodeBehind).toBeUndefined();
  });

  it('answers a literal member from its values and a coded one from its code, with no model', async () => {
    const controls: (ControlRecord | null)[] = [
      { kind: 'if', chainId: 'c', condition: '{{plan}} is "pro"', bodyStart: 1, bodyEnd: 1, chainEnd: 3 },
      null,
      { kind: 'elseif', chainId: 'c', condition: B, bodyStart: 3, bodyEnd: 3, chainEnd: 3 },
      null,
    ];
    const ev = await visit({
      controls,
      state: createControlState(),
      parameters: { plan: 'free-tier-secret' },
      codeBehind: registry({ 2: binding('b', { condition: scripted(true).condition }) }),
    });
    expect(judge.calls).toEqual([]);
    expect(ev.plan.selected).toBe(2);
    expect(ev.guard).toEqual({ decidedBy: 'code', selected: 2 });
    // The AUTHORED text, never the value it was decided from.
    expect(ev.reasoning).toBe(
      `Decided by code-behind: "{{plan}} is "pro"" → false (from its values), "${B}" → true`,
    );
    expect(ev.reasoning).not.toContain('free-tier-secret');
  });

  it('leaves an all-literal chain to decideLocally: decidedBy values, no code run', async () => {
    const code = scripted(true);
    const controls: (ControlRecord | null)[] = [
      { kind: 'if', chainId: 'c', condition: '{{plan}} is "pro"', bodyStart: 1, bodyEnd: 1, chainEnd: 1 },
      null,
    ];
    const ev = await visit({
      controls,
      state: createControlState(),
      parameters: { plan: 'pro' },
      codeBehind: registry({ 0: binding('a', { condition: code.condition }) }),
    });
    expect(ev.guard).toEqual({ decidedBy: 'values', selected: 0 });
    expect(ev.reasoning).toMatch(/^decided from the values:/);
    expect(code.calls()).toBe(0);
    expect(settle.calls).toBe(0);
  });
});

// ─── Broken code ─────────────────────────────────────────────────────────────

describe('a condition entry that throws', () => {
  it('discards the entry, asks the model about the WHOLE chain, and flags the right member', async () => {
    const a = scripted(false);
    const bBinding = binding(`Else if ${B}, then y`, {
      condition: async () => { throw new Error('getByRole(Card) resolved to 2 elements'); },
    });
    const cb = registry({
      0: binding(`If ${A}, then x`, { condition: a.condition }),
      2: bBinding,
      4: binding(`Else if ${C}, then z`, { condition: scripted(true).condition }),
    });
    judge.answers = [2, 2];

    const ev = await visit({ controls: CHAIN, state: createControlState(), codeBehind: cb });
    expect(judge.calls).toEqual([[A, B, C]]);
    expect(ev.plan.selected).toBe(4);
    expect(ev.error).toBeUndefined();
    expect(ev.codeBehindStale).toEqual({
      file: FILE,
      source: `Else if ${B}, then y`,
      error: 'getByRole(Card) resolved to 2 elements',
    });
    expect(ev.guard).toEqual({ decidedBy: 'model', selected: 4, staleMember: 2 });
    // Healed, so no code mark — the model's turns are the row's.
    expect(ev.fromCodeBehind).toBeUndefined();
    expect(ev.codeBehind).toBeUndefined();
    expect(ev.aiInteractions).toHaveLength(1);
    expect(bBinding.entry).toBeUndefined();

    // The next visit goes straight to the model: B has no entry any more, so
    // the chain is no longer answerable by code at all.
    const again = await visit({ controls: CHAIN, state: createControlState(), codeBehind: cb });
    expect(judge.calls).toHaveLength(2);
    expect(a.calls()).toBe(1);
    expect(again.codeBehindStale).toBeUndefined();
  });

  it('treats a value that is not a boolean as broken code', async () => {
    const w = binding('w', { condition: (async () => undefined) as unknown as StepCodeEntry['condition'] });
    judge.answers = [null];
    const ev = await visit({ controls: whileControls(), state: createControlState(), codeBehind: registry({ 0: w }) });
    expect(ev.codeBehindStale?.error).toBe('returned undefined; a condition must return true or false');
    expect(ev.plan.loopEnded).toEqual({ guard: 0, count: 0 });
    expect(ev.guard).toEqual({ decidedBy: 'model', holds: false, staleMember: 0 });
    expect(w.entry).toBeUndefined();
  });

  it('fails the guard under strict mode instead of asking the model', async () => {
    const w = binding('w', { condition: async () => { throw new Error('boom'); } });
    const ev = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({ 0: w }, { strict: true }),
    });
    expect(ev.error).toBe("the condition's code-behind threw: boom");
    expect(ev.reasoning).toContain('strict mode is on');
    expect(ev.fromCodeBehind).toBe(true);
    // The member whose code failed, so a compile replay repairs the right entry.
    expect(ev.guard).toEqual({ decidedBy: 'code', failedMember: 0 });
    expect(ev.codeBehindStale).toBeUndefined();
    expect(judge.calls).toEqual([]);
    // A strict replay heals nothing, so nothing is discarded either.
    expect(w.entry).toBeDefined();
  });

  it('fails the guard on a keyless run, with the advice a broken step gets', async () => {
    const w = binding('While the Next button is enabled, Go to the next page', {
      condition: async () => { throw new Error('boom'); },
    });
    const ev = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({ 0: w }, { keyless: true }),
    });
    expect(ev.error).toBe(KEYLESS_HEAL_SKIPPED_ERROR);
    expect(ev.reasoning).toContain('this machine has no AI configured');
    expect(ev.reasoning).toContain('boom');
    expect(ev.codeBehindHealSkipped).toEqual({ file: FILE, source: w.source, error: 'boom' });
    expect(ev.codeBehindStale).toBeUndefined();
    expect(ev.guard).toEqual({ decidedBy: 'code', staleMember: 0 });
    expect(judge.calls).toEqual([]);

    const policy = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({ 0: w }, { keyless: true, keylessReason: 'policy' }),
    });
    expect(policy.error).toBe(POLICY_HEAL_SKIPPED_ERROR);
  });
});

describe('a condition entry that fails for real', () => {
  it('fails the guard on step.expect, never healed', async () => {
    const w = binding('w', {
      condition: async ({ step }) => { step.expect(false, 'the list never loaded'); return true; },
    });
    const ev = await visit({ controls: whileControls(), state: createControlState(), codeBehind: registry({ 0: w }) });
    expect(ev.error).toBe('the list never loaded');
    expect(ev.reasoning).toContain('`step.expect`');
    expect(ev.fromCodeBehind).toBe(true);
    expect(ev.guard).toEqual({ decidedBy: 'code', failedMember: 0 });
    expect(judge.calls).toEqual([]);
    expect(w.entry).toBeDefined();
  });

  it('fails the guard on step.fail, in the author\'s words', async () => {
    const w = binding('w', { condition: async ({ step }) => step.fail('no statements at all') });
    const ev = await visit({ controls: whileControls(), state: createControlState(), codeBehind: registry({ 0: w }) });
    expect(ev.error).toBe('no statements at all');
    expect(ev.reasoning).toContain('step.fail');
  });

  it('refuses step.exit() — a condition answers, it does not end the flow', async () => {
    const w = binding('w', { condition: async ({ step }) => step.exit() });
    const ev = await visit({ controls: whileControls(), state: createControlState(), codeBehind: registry({ 0: w }) });
    expect(ev.error).toBe(CONDITION_EXIT_REFUSED);
    expect(judge.calls).toEqual([]);
    expect(w.entry).toBeDefined();
  });
});

// ─── The cap net (decision 8) ───────────────────────────────────────────────

describe('a coded loop that reaches its cap', () => {
  async function toTheCap(cb: GuardCodeBehind, cap = 2): Promise<{ state: ControlState; controls: (ControlRecord | null)[] }> {
    const state = createControlState();
    const controls = whileControls(cap);
    for (let pass = 1; pass <= cap; pass++) {
      expect((await visit({ controls, state, codeBehind: cb })).plan.pass).toEqual({ iteration: pass });
    }
    return { state, controls };
  }

  it('asks the model once; if it agrees, the cap failure stands and says code decided', async () => {
    const cb = registry({ 0: binding('w', { condition: scripted(true).condition }) });
    const { state, controls } = await toTheCap(cb);
    judge.answers = [0];
    const ev = await visit({ controls, state, codeBehind: cb });
    expect(judge.calls).toEqual([[WHILE_TEXT]]);
    expect(ev.plan.capBreached).toEqual({ cap: 2, source: 'line' });
    expect(ev.error).toContain('the loop reached its cap of 2 passes');
    expect(ev.error).toContain("decided by this line's code-behind");
    expect(ev.error).toContain('agrees the condition still holds');
    expect(ev.guard?.decidedBy).toBe('code');
    expect(ev.codeBehindStale).toBeUndefined();
    // The planner was advanced once, on the answer that stands.
    expect(state.passes.get(0)).toBe(2);
  });

  it('ends the loop where the model says when it disagrees, and flags the entry with both answers', async () => {
    const w = binding('While the Next button is enabled, Go to the next page', {
      condition: scripted(true).condition,
    });
    const cb = registry({ 0: w });
    const { state, controls } = await toTheCap(cb);
    judge.answers = [null];
    const ev = await visit({ controls, state, codeBehind: cb });
    expect(ev.error).toBeUndefined();
    expect(ev.plan.loopEnded).toEqual({ guard: 0, count: 2 });
    expect(ev.codeBehindStale).toEqual({
      file: FILE,
      source: w.source,
      error: `the code said "${WHILE_TEXT}" still held at pass 2; the page says it does not`,
    });
    expect(ev.guard).toEqual({ decidedBy: 'model', holds: false, staleMember: 0 });
    expect(ev.fromCodeBehind).toBeUndefined();
    expect(ev.reasoning).toBe('the model saw none hold');
    expect(w.entry).toBeUndefined();
  });

  it('cannot ask on a strict or keyless run, and fails at the cap saying why', async () => {
    const cb = registry({ 0: binding('w', { condition: scripted(true).condition }) }, { keyless: true });
    const { state, controls } = await toTheCap(cb);
    const ev = await visit({ controls, state, codeBehind: cb });
    expect(judge.calls).toEqual([]);
    expect(ev.error).toContain('the loop reached its cap of 2 passes');
    expect(ev.error).toContain('no model to check it with');
  });

  it('applies to a Repeat in its own sense: code that keeps saying "not yet"', async () => {
    const r = binding('r', { condition: scripted(false).condition });
    const cb = registry({ 0: r });
    const state = createControlState();
    const controls = repeatControls(2);
    await visit({ controls, state, codeBehind: cb }); // pass 1, no decision
    await visit({ controls, state, codeBehind: cb }); // code: not yet → pass 2
    judge.answers = [0]; // the model: it IS gone
    const ev = await visit({ controls, state, codeBehind: cb });
    expect(ev.plan.loopEnded).toEqual({ guard: 0, count: 2 });
    expect(ev.codeBehindStale?.error).toBe(
      `the code said "${REPEAT_TEXT}" still did not hold at pass 2; the page says it does`,
    );
    expect(ev.guard).toEqual({ decidedBy: 'model', holds: true, staleMember: 0 });
  });

  it('capBreachAt answers the planner\'s own question without moving it', () => {
    const state = createControlState();
    const controls = whileControls(2);
    expect(capBreachAt(controls, 0, state)).toBeUndefined();
    state.passes.set(0, 2);
    expect(capBreachAt(controls, 0, state)).toEqual({ cap: 2, source: 'line', passes: 2 });
    expect(state.passes.get(0)).toBe(2);
    expect(capBreachAt(CHAIN, 0, state)).toBeUndefined();
  });
});

// ─── Evidence (decision 9) ──────────────────────────────────────────────────

describe('captureEvidence', () => {
  it('keeps the judge\'s page, with every asked member\'s verdict, when the model decided', async () => {
    judge.answers = [1];
    const ev = await visit({
      controls: CHAIN,
      state: createControlState(),
      codeBehind: registry({}, { captureEvidence: true }),
    });
    expect(ev.guard).toEqual({
      decidedBy: 'model',
      selected: 2,
      evidence: {
        dom: judge.evidence.dom,
        url: judge.evidence.url,
        // Before the one that held: false. The one: true. After it: not asked.
        members: [{ index: 0, holds: false }, { index: 2, holds: true }, { index: 4 }],
      },
    });
  });

  it('records a loop condition as one member, the guard itself', async () => {
    judge.answers = [null];
    const ev = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({}, { captureEvidence: true }),
    });
    expect(ev.guard?.evidence?.members).toEqual([{ index: 0, holds: false }]);
  });

  it('keeps nothing when code decided, and nothing when the run is not compiling', async () => {
    const byCode = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({ 0: binding('w', { condition: scripted(true).condition }) }, { captureEvidence: true }),
    });
    expect(byCode.guard).toEqual({ decidedBy: 'code', holds: true });

    judge.answers = [0];
    const notCompiling = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({}),
    });
    expect(notCompiling.guard).toEqual({ decidedBy: 'model', holds: true });
  });
});

// ─── An entry in the wrong place ─────────────────────────────────────────────

describe('a run entry bound to a guard', () => {
  it('warns once, lets the model decide, and flags nothing stale', async () => {
    const w = binding('While the Next button is enabled, Go to the next page', {
      run: async () => {},
    });
    const cb = registry({ 0: w });
    const state = createControlState();
    judge.answers = [0, 0];
    await visit({ controls: whileControls(), state, codeBehind: cb });
    const ev = await visit({ controls: whileControls(), state, codeBehind: cb });

    expect(judge.calls).toHaveLength(2);
    expect(ev.codeBehindStale).toBeUndefined();
    expect(w.entry).toBeDefined();
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('its line is a condition'));
    expect(said).toHaveLength(1);
  });
});

// ─── The row ────────────────────────────────────────────────────────────────

describe('guardResult', () => {
  it('carries the code-behind fields onto the StepResult', async () => {
    const ev = await visit({
      controls: whileControls(),
      state: createControlState(),
      codeBehind: registry({ 0: binding('w', { condition: scripted(true).condition }) }),
    });
    const row = guardResult({
      index: 1,
      instruction: 'While …',
      status: 'passed',
      durationMs: ev.durationMs,
      reasoning: ev.reasoning,
      aiInteractions: ev.aiInteractions,
      ...guardCodeBehindFields(ev),
    });
    expect(row.fromCodeBehind).toBe(true);
    expect(row.codeBehind?.file).toBe(FILE);
    expect(row.guard).toEqual({ decidedBy: 'code', holds: true });
    expect(row.aiExplanation).toBe(`Decided by code-behind: "${WHILE_TEXT}" → true`);
    expect(row.turns).toEqual([]);
  });

  it('adds nothing to a row with no code-behind', () => {
    const row = guardResult({ index: 1, instruction: 'x', status: 'passed', durationMs: 0 });
    expect(Object.keys(row).sort()).toEqual(['durationMs', 'index', 'instruction', 'retried', 'status', 'turns']);
  });
});
