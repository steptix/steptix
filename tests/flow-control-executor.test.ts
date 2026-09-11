/**
 * The executor half of `If … then return` (stories/step-flow-control.md,
 * decisions 2 and 6) — and of its third verb, `If … then fail the test with
 * error "…"` (stories/step-failure-outcomes.md, decisions 1–3), which rides
 * the same claim through the same seam and ends the run instead of the flow.
 *
 * Two claims, and the second is the one the whole design rests on: a `return`
 * action is honoured ONLY on a step whose authored text claims the form. On any
 * other step it is refused and the model is told why — without that, a model
 * could end a run early from any line and the report would be green for work
 * that never happened.
 *
 * Same harness as `tests/step-executor-placeholders.test.ts`: fake page, stub
 * client, the real `executeStep`, with `../src/browser/actions.js` mocked so a
 * test can see exactly what did and did not reach the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepCache } from '../src/cache/step-cache.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';

const actions = vi.hoisted(() => ({ received: [] as AIAction[] }));

/**
 * Lines the clarification REPL will "read" from the console.
 *
 * `promptUserWithReplEscape` opens its own readline when the caller hands it
 * no reader — and the caller under test here is `executeStepAttempt`, which
 * hands it none. Mocking the module is what lets the REPL be driven through
 * the REAL `executeStep` rather than around it.
 */
const replLines = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock('node:readline/promises', () => {
  const createInterface = () => ({
    question: async (): Promise<string> => {
      const next = replLines.queue.shift();
      if (next === undefined) throw new Error('scripted REPL input exhausted');
      return next;
    },
    close: () => {},
  });
  return { default: { createInterface }, createInterface };
});

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      actions.received.push(action);
      return { success: true };
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<html><body>dom</body></html>') };
});

/** The settle gate is the one page-state helper under test here, so it is
 *  counted rather than stubbed away silently. */
const settles = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false,
    loadingIndicators: [],
    hasErrorOverlay: false,
    errorMessages: [],
    hasModal: false,
    documentLoading: false,
  }),
  waitForPageStability: async (_page: unknown, opts: Record<string, unknown>) => {
    settles.calls.push(opts);
  },
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://app.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean { return true; }
    dispose(): void {}
  },
}));

import {
  executeBranchedStep,
  executeStep,
  FAIL_NOT_CLAIMED,
  RETURN_NOT_CLAIMED,
} from '../src/runner/step-executor.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/dashboard',
    context: () => ({ browser: () => ({}) }),
    evaluate: async (arg: unknown) => {
      if (typeof arg === 'string') return { pass: true, actual: 'ok' };
      throw new Error('no DOM in this test');
    },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 3, promptOnAmbiguity: false },
};

function scriptedClient(responses: string[]): AiClient & { requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  let turn = 0;
  return {
    requests,
    complete: async (messages: ChatMessage[]) => {
      requests.push(messages);
      const text = responses[turn] ?? responses[responses.length - 1]!;
      turn++;
      return { text, model: 'stub' };
    },
  } as unknown as AiClient & { requests: ChatMessage[][] };
}

function plan(acts: AIAction[], needsReeval = false): string {
  return JSON.stringify({ actions: acts, reasoning: 'because', needs_reeval: needsReeval });
}

/** Run one step. `claim: true` sends the claim the CLI loop would compute from
 *  the very same line, so the two can never disagree in this file. */
async function runStep(
  instruction: string,
  responses: string[],
  opts: {
    claim?: boolean;
    config?: Config;
    stepCache?: StepCache;
    cacheEnabled?: boolean;
    adHocResults?: StepResult[];
    /** The run's parameter map — `runSecrets` reads the SECRET-NAMED values out
     *  of it, and those are what a composed error must come back without. */
    parameters?: Record<string, string>;
    /** The line as WRITTEN when it differs from the interpolated `instruction`,
     *  as every loop hands it over for a `{{placeholder}}` step. The claim is
     *  computed from THIS, as the loops compute it. Defaults to `instruction`. */
    authored?: string;
  } = {},
) {
  const client = scriptedClient(responses);
  const authored = opts.authored ?? instruction;
  const claim = opts.claim ? parseFlowControlStep(authored) : null;
  const result = await executeStep(
    1,
    3,
    instruction,
    {
      page: fakePage(),
      config: opts.config ?? CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'flow control',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: opts.parameters ?? {},
      testSteps: [instruction],
      ...(claim && { flowControlClaim: claim }),
      ...(opts.stepCache && { stepCache: opts.stepCache }),
      ...(opts.cacheEnabled !== undefined && { cacheEnabled: opts.cacheEnabled }),
    },
    authored,
  ).catch((err: unknown) => err as Error);
  return { result, client };
}

/** One cached turn, in the shape `StepCache.read` answers with. */
function cachedTurn(action: AIAction) {
  return {
    rawResponse: JSON.stringify({ actions: [action], reasoning: 'cached' }),
    actions: [action],
    reasoning: 'cached',
  };
}

/** A `StepCache` that counts what the executor asked of it. `hit` is the turn
 *  list a read answers with, or null for a miss.
 *
 * The ASSERTION half is counted separately because it is a separate seam: it
 * is read and written from `executeStepAttempt`, several hundred lines and one
 * function away from the action cache, and it consulted `opts.cacheEnabled`
 * raw until this round. */
function recordingCache(hit: ReturnType<typeof cachedTurn>[] | null) {
  const seen = { reads: 0, writes: 0, assertionReads: 0, assertionWrites: 0 };
  const cache = {
    read: async () => {
      seen.reads++;
      return hit;
    },
    write: async () => {
      seen.writes++;
    },
    readAssertion: async () => {
      seen.assertionReads++;
      return null;
    },
    writeAssertion: async () => {
      seen.assertionWrites++;
    },
    invalidateAssertion: async () => {},
    invalidateStep: async () => {},
  } as unknown as StepCache;
  return { cache, seen };
}

/** The two AI turns an `assert` sub-action costs: the plan, then the assertion
 *  code. `fakePage.evaluate` answers a string with `{pass:true}`, so the code
 *  itself only has to parse. */
const ASSERTION_CODE = JSON.stringify({ code: '() => ({ pass: true, actual: "ok" })' });

beforeEach(() => {
  actions.received = [];
  settles.calls = [];
  replLines.queue = [];
});

// ── The claimed step ────────────────────────────────────────────────────────

describe('a step that claims the form', () => {
  const line = 'If the page title contains "Dashboard" then return';

  it('passes with `flowControl` and the model`s own words when the model returns', async () => {
    const { result } = await runStep(
      line,
      [plan([{ action: 'return', description: 'the title reads Dashboard' }])],
      { claim: true },
    );

    expect((result as { status: string }).status).toBe('passed');
    expect((result as { flowControl?: unknown }).flowControl).toEqual({
      kind: 'return',
      verb: 'return',
    });
    // The bare detail — the run loop prefixes it with the flow's name, which
    // the executor has no expansion to know.
    expect((result as { aiExplanation?: string }).aiExplanation).toBe(
      'the title reads Dashboard',
    );
    // The verb is the AUTHORED one, so `… then stop` reports as `stop`.
    const stopped = await runStep(
      'If the dashboard is shown then stop',
      [plan([{ action: 'return', description: 'shown' }])],
      { claim: true },
    );
    expect((stopped.result as { flowControl?: { verb: string } }).flowControl?.verb).toBe('stop');
  });

  it('records the return as a sub-action, and reaches the page with nothing', async () => {
    const { result } = await runStep(
      line,
      [plan([{ action: 'return', description: 'the title reads Dashboard' }])],
      { claim: true },
    );
    const subs = (result as { turns: Array<{ subActions: Array<{ action: AIAction; error?: string }> }> })
      .turns[0]!.subActions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.action.action).toBe('return');
    expect(subs[0]!.error).toBeUndefined();
    // `executeAction` is never called for it — the decision is the executor's.
    expect(actions.received).toHaveLength(0);
  });

  it('stops the step dead: nothing after the return in the same turn runs', async () => {
    const { result } = await runStep(
      'If the Save button is visible, click it and return',
      [
        plan([
          { action: 'click', selector: '#save', description: 'Click Save' },
          { action: 'return', description: 'saved, so return' },
          { action: 'click', selector: '#next', description: 'a step that must not run' },
        ]),
      ],
      { claim: true },
    );

    expect((result as { status: string }).status).toBe('passed');
    // The compound step's own click ran; the one after the return did not.
    expect(actions.received.map((a) => a.selector)).toEqual(['#save']);
  });

  it('ignores needs_reeval: a returned flow has nothing left to re-evaluate', async () => {
    const { result, client } = await runStep(
      line,
      [
        plan([{ action: 'return', description: 'done' }], true),
        plan([{ action: 'click', selector: '#next', description: 'must not happen' }]),
      ],
      { claim: true },
    );
    expect((result as { flowControl?: unknown }).flowControl).toBeDefined();
    expect(client.requests).toHaveLength(1);
    expect(actions.received).toHaveLength(0);
  });

  it('does nothing at all when the condition does not hold', async () => {
    const { result } = await runStep(
      line,
      [plan([{ action: 'noop', description: 'the title reads Sign In' }])],
      { claim: true },
    );
    expect((result as { status: string }).status).toBe('passed');
    expect((result as { flowControl?: unknown }).flowControl).toBeUndefined();
  });
});

// ── The guard ───────────────────────────────────────────────────────────────

describe('a step that does NOT claim the form', () => {
  it('refuses the return, names the rule, and does not end the step as a pass', async () => {
    const { result } = await runStep(
      'Click the details link',
      [plan([{ action: 'return', description: 'I think we are done' }])],
    );

    // With retries at 0 this surfaces as the step failure. What matters is
    // that it is NOT a passed step carrying `flowControl`: a model must not be
    // able to end a run from a line that did not ask to.
    const failed = result as { status?: string; error?: string; flowControl?: unknown } & Error;
    expect(failed.flowControl).toBeUndefined();
    expect(failed.status).not.toBe('passed');
    expect(String(failed.message ?? failed.error)).toContain(RETURN_NOT_CLAIMED);
  });

  it('refuses it on a NEAR-MISS line too — the grammar, not the wording, decides', async () => {
    // `then return to the dashboard` reads as navigate-back and is not a
    // claim, so the same refusal applies even though the word is there.
    const line = 'If the old layout is shown then return to the dashboard';
    expect(parseFlowControlStep(line)).toBeNull();
    const { result } = await runStep(line, [plan([{ action: 'return', description: 'x' }])], {
      claim: true, // the loop would compute null here; prove it does
    });
    const failed = result as { status?: string; error?: string; flowControl?: unknown } & Error;
    expect(failed.flowControl).toBeUndefined();
    expect(failed.status).not.toBe('passed');
    expect(String(failed.error ?? failed.message)).toContain(RETURN_NOT_CLAIMED);
  });

  it('tells the MODEL why, on the next attempt', async () => {
    // The refusal is retryable on purpose: it comes back as prior-failure
    // context so the model learns the rule mid-step rather than after the run.
    const retryConfig: Config = {
      ...CONFIG,
      execution: { ...CONFIG.execution, retries: 1 },
    };
    const { result, client } = await runStep(
      'Click the details link',
      [
        plan([{ action: 'return', description: 'I think we are done' }]),
        plan([{ action: 'click', selector: '#details', description: 'Click details' }]),
      ],
      { config: retryConfig },
    );

    expect((result as { status: string }).status).toBe('passed');
    expect(actions.received.map((a) => a.selector)).toEqual(['#details']);
    const secondAttempt = client.requests[1]!
      .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')))
      .join('\n');
    expect(secondAttempt).toContain('this step does not say to return');
  });
});

// ── The settle gate ─────────────────────────────────────────────────────────

describe('the settle gate before the judgement', () => {
  it('waits for stability on a CONDITIONAL flow-control step, with the branched budget', async () => {
    await runStep(
      'If the page title contains "Dashboard" then return',
      [plan([{ action: 'noop', description: 'not yet' }])],
      { claim: true },
    );
    // A title read a millisecond after the click that changes it is the stale
    // answer that makes the return miss (decision 6). Same budget
    // `executeBranchedStep` uses: up to 10 s, 1 s quiet.
    expect(settles.calls).toEqual([{ timeoutMs: 10_000, quiesceMs: 1000 }]);
  });

  it('caps the wait at the test`s own timeout when that is shorter', async () => {
    const shortConfig: Config = {
      ...CONFIG,
      execution: { ...CONFIG.execution, timeout: 4 }, // seconds
    };
    await runStep(
      'If the dashboard is shown then stop',
      [plan([{ action: 'noop', description: 'not yet' }])],
      { claim: true, config: shortConfig },
    );
    expect(settles.calls).toEqual([{ timeoutMs: 4000, quiesceMs: 1000 }]);
  });

  it('does not pay for it on an ordinary step', async () => {
    await runStep('Click the details link', [
      plan([{ action: 'click', selector: '#details', description: 'Click details' }]),
    ]);
    expect(settles.calls).toEqual([]);
  });
});

// ── The action cache ────────────────────────────────────────────────────────

describe('the action cache and a flow-control step', () => {
  const line = 'If the page title contains "Dashboard" then return';

  it('never reads a cached turn for a claiming step — the condition is re-judged', async () => {
    // The scenario the exemption exists for. Run 1 signs in, the condition
    // holds, and a `return` turn lands in `step-N.json`. Run 2 lands on a
    // different page. Replayed, the cache would end the flow with no model
    // call and no page read, and the report would be green for work nobody
    // did. So: the model IS asked, and when it says the condition does not
    // hold, nothing is returned.
    const { cache, seen } = recordingCache([
      cachedTurn({ action: 'return', description: 'the title read Dashboard last time' }),
    ]);
    const { result, client } = await runStep(
      line,
      [plan([{ action: 'noop', description: 'the title reads Sign In today' }])],
      { claim: true, stepCache: cache, cacheEnabled: true },
    );

    expect(client.requests.length).toBeGreaterThanOrEqual(1);
    expect(seen.reads).toBe(0);
    const passed = result as { status: string; flowControl?: unknown; fromCache?: boolean };
    expect(passed.status).toBe('passed');
    expect(passed.flowControl).toBeUndefined();
    expect(passed.fromCache).toBeUndefined();
  });

  it('still replays that very cache for an ordinary step — the fake is not the reason', async () => {
    // The control the test above needs to mean anything: the same cache, the
    // same `cacheEnabled: true`, and a step with no claim. If this one also
    // called the model, the assertion above would pass for the wrong reason.
    const { cache, seen } = recordingCache([
      cachedTurn({ action: 'noop', description: 'nothing to do' }),
    ]);
    const { result, client } = await runStep(
      'Open the dashboard',
      [plan([{ action: 'click', selector: '#never', description: 'must not be asked for' }])],
      { stepCache: cache, cacheEnabled: true },
    );

    expect(seen.reads).toBe(1);
    expect(client.requests).toHaveLength(0);
    expect((result as { fromCache?: boolean }).fromCache).toBe(true);
  });

  it('writes no cache entry after a claiming step runs', async () => {
    // Read AND write, or the exemption leaks across runs: run 1 with the
    // feature on would leave the `return` on disk for run 2 to replay.
    const { cache, seen } = recordingCache(null);
    const { result } = await runStep(
      line,
      [plan([{ action: 'return', description: 'the title reads Dashboard' }])],
      { claim: true, stepCache: cache, cacheEnabled: true },
    );

    expect((result as { flowControl?: unknown }).flowControl).toEqual({
      kind: 'return',
      verb: 'return',
    });
    expect(seen.reads).toBe(0);
    expect(seen.writes).toBe(0);
  });

  it('still writes for an ordinary step under the same cache', async () => {
    const { cache, seen } = recordingCache(null);
    const { result } = await runStep(
      'Click the details link',
      [plan([{ action: 'click', selector: '#details', description: 'Click details' }])],
      { stepCache: cache, cacheEnabled: true },
    );
    expect((result as { status: string }).status).toBe('passed');
    expect(seen.reads).toBe(1);
    expect(seen.writes).toBe(1);
  });

  it('touches the ASSERTION cache no more than the action cache, on a claiming step', async () => {
    // "Read AND write, at one seam" was not true of the assertion cache: it
    // lives in a different function and consulted `opts.cacheEnabled` directly,
    // so a compound flow-control step (`If the Save button is visible, click it
    // and return`) whose model emitted an `assert` cached a judgement about a
    // live page under a comment saying it could not — and replayed it on the
    // next run without looking.
    const { cache, seen } = recordingCache(null);
    const { result } = await runStep(
      line,
      [
        plan([
          { action: 'assert', condition: 'document.title', expected: 'Dashboard', description: 'the title reads Dashboard' },
          { action: 'return', description: 'so we are done here' },
        ]),
        ASSERTION_CODE,
      ],
      { claim: true, stepCache: cache, cacheEnabled: true },
    );

    expect((result as { flowControl?: unknown }).flowControl).toEqual({
      kind: 'return',
      verb: 'return',
    });
    expect(seen).toMatchObject({ reads: 0, writes: 0, assertionReads: 0, assertionWrites: 0 });
  });

  it('still uses the assertion cache for an ordinary step with the same action', async () => {
    // The control: same cache, same `assert`, no claim. Without it the
    // assertion above would pass for a fake that simply never gets there.
    const { cache, seen } = recordingCache(null);
    const { result } = await runStep(
      'Check the dashboard title',
      [
        plan([
          { action: 'assert', condition: 'document.title', expected: 'Dashboard', description: 'the title reads Dashboard' },
        ]),
        ASSERTION_CODE,
      ],
      { stepCache: cache, cacheEnabled: true },
    );

    expect((result as { status: string }).status).toBe('passed');
    expect(seen).toMatchObject({ assertionReads: 1, assertionWrites: 1 });
  });
});

// ── The claim does not travel ───────────────────────────────────────────────

describe('the claim belongs to one line and does not travel', () => {
  const line = 'If the page title contains "Dashboard" then return';

  it('does not lend it to an ad-hoc step typed at the clarification REPL', async () => {
    // The whole chain, through the real `executeStep`: a claiming step asks a
    // clarifying question, the user escapes to `/repl`, and the line they type
    // there is executed with the claiming step's options. Handed over whole,
    // those options let a model end the flow from a line the framework never
    // read the form off — which is exactly the hole the claim closes.
    //
    // `/exit` rather than `/continue` only because that is the decision that
    // carries the ad-hoc results back out on `runnerControl` — with
    // `/continue` they are dropped, and the step under test would have no
    // observable result at all.
    replLines.queue = ['/repl', 'Click the details link', '/exit'];
    const interactive: Config = {
      ...CONFIG,
      execution: { ...CONFIG.execution, promptOnAmbiguity: true },
    };
    const { result } = await runStep(
      line,
      [
        // 1. the claiming step asks a question
        plan([{ action: 'prompt', description: 'which dashboard?', question: 'which one?' }]),
        // 2. the REPL's ad-hoc step tries to return
        plan([{ action: 'return', description: 'I think we are done' }]),
      ],
      { claim: true, config: interactive },
    );

    // Every scripted line was consumed, so the REPL really ran.
    expect(replLines.queue).toHaveLength(0);
    const outer = result as StepResult;
    const adHoc = outer.runnerControl?.adHocResults?.[0];
    expect(adHoc).toBeDefined();
    // The ad-hoc line is the one under test: it refused, and refused by name.
    expect(adHoc!.flowControl).toBeUndefined();
    expect(adHoc!.status).not.toBe('passed');
    expect(String(adHoc!.error ?? '')).toContain(RETURN_NOT_CLAIMED);
    // The claiming step ended on the user's exit, not on a return it never
    // made: nothing the REPL did put `flowControl` on it either.
    expect(outer.flowControl).toBeUndefined();
  });

  it('does not lend it to a step run inside executeBranchedStep', async () => {
    // The grouper never puts a flow-control step in a group (decision 7), so a
    // claim reaching this call is a claim about a DIFFERENT line — and the
    // group member must not be able to spend it.
    const client = scriptedClient([
      JSON.stringify({
        matched: 'B',
        actions: [{ action: 'click', selector: '#go', description: 'go' }],
        reasoning: 'the dashboard is already up',
      }),
      plan([{ action: 'return', description: 'I think we are done' }]),
    ]);
    const results = await executeBranchedStep(
      {
        conditionalSteps: [{ index: 1, instruction: 'If prompted for MFA, enter the code' }],
        continuationStep: { index: 2, instruction: 'Wait for the dashboard' },
      },
      3,
      {
        page: fakePage(),
        config: CONFIG,
        aiClient: client,
        contextContent: '',
        testName: 'flow control',
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters: {},
        // The leak, made explicit: someone forwards a claim into the group.
        flowControlClaim: parseFlowControlStep(line)!,
      },
    );

    const continuation = results.find((r) => r.index === 2)!;
    expect(continuation.flowControl).toBeUndefined();
    expect(continuation.status).not.toBe('passed');
    expect(String(continuation.error ?? '')).toContain(RETURN_NOT_CLAIMED);
  });
});

// ── The `fail` verb ─────────────────────────────────────────────────────────

/** Retries ON, which for a deliberate failure is the interesting setting. */
const RETRY_CONFIG: Config = { ...CONFIG, execution: { ...CONFIG.execution, retries: 1 } };

/** The `fail` sub-action's own copy of the composed error. */
function failSubError(result: StepResult): string | undefined {
  return result.turns.flatMap((t) => t.subActions).find((s) => s.action.action === 'fail')?.error;
}

const FAIL_LINE =
  'If {{a}} is "peanuts" then fail the test with error ' +
  '"The variable value was peanuts. Expected apples"';

describe('a step that claims the `fail` verb', () => {
  const line = FAIL_LINE;

  it('fails with the author\'s message, marks it deliberate, and spends ONE attempt', async () => {
    // Retries are ALLOWED here and none is spent (decision 2): a retry would
    // hand the model "this failed, try something else".
    const { result, client } = await runStep(
      line,
      [
        plan([{ action: 'fail', description: 'the value reads peanuts' }]),
        plan([{ action: 'noop', description: 'a second attempt that must not happen' }]),
      ],
      { claim: true, config: RETRY_CONFIG },
    );

    const failed = result as StepResult;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('The variable value was peanuts. Expected apples');
    expect(failed.deliberate).toBe(true);
    // The explanation is about the CONDITION, not a framework diagnostic.
    expect(failed.aiExplanation).toContain('the value reads peanuts');
    expect(failed.aiExplanation).not.toContain('Failed to execute step');
    expect(client.requests).toHaveLength(1);
    expect(failed.retried).toBe(false);
    // A `fail` reaches the page with nothing, exactly as a `return` does.
    expect(actions.received).toHaveLength(0);
    // ONE recorded turn: `withRetry` hands a failure it declines to retry to
    // `onFailure` as well as throwing it, and the catch used to merge that
    // attempt's turns a second time, so the report showed the whole turn twice.
    expect(failed.turns).toHaveLength(1);
    const subs = failed.turns.flatMap((t) => t.subActions);
    expect(subs.some((s) => s.action.action === 'fail')).toBe(true);
    expect(failSubError(failed)).toBe('The variable value was peanuts. Expected apples');
  });

  // How the error is WORDED, for every shape of message (decisions 2 and 3).
  // The claim is read off the AUTHORED line — it must answer the same on every
  // run — so the message has to be re-read off the INTERPOLATED one, which is
  // where the values are, and masked at that same one seam.
  it.each<[string, { instruction: string; description: string; authored?: string;
    parameters?: Record<string, string>; explanation?: string; explanationExcludes?: string }, string]>([
    [
      'no message named: the model`s description words it',
      { instruction: 'If {{a}} is "peanuts" then fail the test', description: 'the value reads peanuts' },
      'Failed by the step: the value reads peanuts',
    ],
    [
      'no message and no description: a fixed phrase, and an explanation without an empty parenthesis',
      { instruction: 'If {{a}} is "peanuts" then fail the test', description: '',
        explanation: 'The step\'s condition held and the step says to fail the test.' },
      'Failed by the step: the condition held',
    ],
    [
      '`{{placeholder}}` in the message: resolved off the interpolated line, not off the claim',
      { instruction: 'If 7 is wrong then fail the test with error "Expected 10, got 7"',
        description: 'the total reads 7',
        authored: 'If {{total}} is wrong then fail the test with error "Expected 10, got {{total}}"' },
      'Expected 10, got 7',
    ],
    [
      'a resolved value that turned out to be a secret: masked',
      { instruction: 'If the sign-in failed then fail the test with error "Sign-in refused hunter2"',
        description: 'the form still shows an error',
        parameters: { password: 'hunter2' },
        authored: 'If the sign-in failed then fail the test with error "Sign-in refused {{password}}"' },
      'Sign-in refused ***',
    ],
    [
      // A value carrying the quote that ends the message leaves the interpolated
      // line no longer a `fail` at all; the authored words beat none.
      'a value that broke the re-parse: back to the authored message',
      { instruction: 'If a "quoted" value is wrong then fail the test with error '
          + '"Expected 10, got a "quoted" value"',
        description: 'the total is quoted',
        authored: 'If {{total}} is wrong then fail the test with error "Expected 10, got {{total}}"' },
      'Expected 10, got {{total}}',
    ],
    [
      'a secret the author put in the message: masked once, where the error is composed',
      { instruction: 'If the sign-in failed then fail the test with error '
          + '"Sign-in refused hunter2 for the demo account"',
        description: 'the form still shows an error',
        parameters: { password: 'hunter2' } },
      'Sign-in refused *** for the demo account',
    ],
    [
      // The explanation is built from the description, so masking the message
      // alone would leave the hole open one field along.
      'a secret the MODEL echoed into its description: masked there too',
      { instruction: 'If the sign-in failed then fail the test',
        description: 'the field still holds hunter2',
        parameters: { password: 'hunter2' }, explanationExcludes: 'hunter2' },
      'Failed by the step: the field still holds ***',
    ],
  ])('composes the error — %s', async (_label, spec, expected) => {
    const { result } = await runStep(
      spec.instruction,
      [plan([{ action: 'fail', description: spec.description }])],
      {
        claim: true,
        ...(spec.authored && { authored: spec.authored }),
        ...(spec.parameters && { parameters: spec.parameters }),
      },
    );
    const failed = result as StepResult;
    expect(failed.error).toBe(expected);
    expect(failed.deliberate).toBe(true);
    // The sub-action carries the same composed string into the report's
    // execution-order list.
    expect(failSubError(failed)).toBe(expected);
    if (spec.explanation) expect(failed.aiExplanation).toBe(spec.explanation);
    if (spec.explanationExcludes) {
      expect(failed.aiExplanation ?? '').not.toContain(spec.explanationExcludes);
    }
  });

  it('does nothing at all when the condition does not hold', async () => {
    const { result } = await runStep(
      line,
      [plan([{ action: 'noop', description: 'the value reads apples' }])],
      { claim: true },
    );
    expect((result as StepResult).status).toBe('passed');
    expect((result as StepResult).deliberate).toBeUndefined();
  });

  it('pays the settle gate before judging, exactly as a return does', async () => {
    await runStep(line, [plan([{ action: 'noop', description: 'not yet' }])], { claim: true });
    expect(settles.calls).toEqual([{ timeoutMs: 10_000, quiesceMs: 1000 }]);
  });
});

// ── The guard, for the third verb ───────────────────────────────────────────

describe('a `fail` action on a step that did not ask for one', () => {
  it('is refused on an ordinary step, and the model is told why on the next attempt', async () => {
    const { result, client } = await runStep(
      'Click the details link',
      [
        plan([{ action: 'fail', description: 'I do not like this page' }]),
        plan([{ action: 'click', selector: '#details', description: 'Click details' }]),
      ],
      { config: RETRY_CONFIG },
    );

    // Retryable, so the step recovers — and the refusal reached the model.
    expect((result as StepResult).status).toBe('passed');
    expect((result as StepResult).deliberate).toBeUndefined();
    expect(actions.received.map((a) => a.selector)).toEqual(['#details']);
    const secondAttempt = client.requests[1]!
      .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')))
      .join('\n');
    expect(secondAttempt).toContain('this step does not say to fail');
  });

  // The verbs are not interchangeable, which a bare truth test on the claim
  // would let through: `return` ends the flow as a pass, `fail` ends the run as
  // a failure, so a swap could fail a run the author only asked to leave early.
  it.each([
    ['a `fail` on a step claiming RETURN', 'If the page title contains "Dashboard" then return',
      'fail' as const, FAIL_NOT_CLAIMED],
    ['a `return` on a step claiming FAIL',
      'If {{a}} is "peanuts" then fail the test with error "not apples"',
      'return' as const, RETURN_NOT_CLAIMED],
  ])('refuses %s', async (_label, line, action, refusal) => {
    const { result } = await runStep(line, [plan([{ action, description: 'the claim held' }])], {
      claim: true,
    });
    const failed = result as StepResult;
    expect(failed.status).toBe('failed');
    expect(failed.deliberate).toBeUndefined();
    expect(failed.flowControl).toBeUndefined();
    expect(String(failed.error)).toContain(refusal);
  });
});

// ── The generator prompt, for the third verb ────────────────────────────────

describe('the generation prompt for a `fail`-claiming step', () => {
  const promptText = (rawStepText: string, actions: AIAction[]) =>
    contentBlocksToText(buildStepCodePrompt({ rawStepText, parameters: [], actions }).content);

  it('offers `step.fail` and states the rule — and offers `step.exit` to nobody here', () => {
    // The two verbs are swapped, not stacked (decision 10).
    const text = promptText(FAIL_LINE, [{ action: 'fail', description: 'the value reads peanuts' }]);
    expect(text).toContain('`step.fail(message)`');
    expect(text).toContain('deliberate-failure step');
    // The message is the author's, and paraphrasing it is the failure mode.
    expect(text).toContain('VERBATIM');
    expect(text).toContain("step.getVar('name')");
    // Same trap as the return rule: a recording shows one branch, the entry
    // has to carry both.
    expect(text).toContain('a `noop` means it did NOT');
    expect(text).toContain('needs NO post-condition');
    expect(text).not.toContain('step.exit');
    expect(text).not.toContain('flow-control step');
  });

  it('leaves an ordinary step`s prompt with neither verb in it', () => {
    const text = promptText('Check that the balance is not peanuts', [
      { action: 'read', selector: '#balance' },
    ]);
    expect(text).not.toContain('step.fail');
    expect(text).not.toContain('deliberate-failure step');
    expect(text).toContain('End with a post-condition');
  });
});
