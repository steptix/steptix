/**
 * The condition judge — `evaluateConditions` (stories/control-flow.md
 * §"Condition evaluation").
 *
 * Everything below the model is mocked (DOM snapshot, stability gate,
 * screenshot); the prompt builder, the response parser and the re-ask budget
 * are real, because those three are what the judge IS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock('../src/browser/page-state.js', () => ({
  waitForPageStability: vi.fn(async () => undefined),
  waitForPostActionSettle: vi.fn(async () => undefined),
  diagnosePageState: vi.fn(async () => ({})),
  capturePageSignal: vi.fn(async () => ({})),
  PageActivityTracker: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser/dom-cleaner.js')>()),
  captureDomSnapshot: vi.fn(async () => '<html><body>the page</body></html>'),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fake' })),
}));

import { captureDomSnapshot } from '../src/browser/dom-cleaner.js';
import {
  evaluateConditions,
  executeBranchedStep,
  CONDITION_JUDGE_BUDGET_MS,
} from '../src/runner/step-executor.js';
import type { StepExecutorOptions } from '../src/runner/step-executor.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Every prompt the judge sent, as text. */
const sentPrompts: string[] = [];

function makeClient(answers: string[]): { complete: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    complete: vi.fn(async (messages: Array<{ role: string; content: unknown }>) => {
      const user = messages[messages.length - 1]!;
      sentPrompts.push(
        typeof user.content === 'string'
          ? user.content
          : (user.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n'),
      );
      // The last answer repeats, so a "always waiting" script is one entry.
      const answer = answers[Math.min(call, answers.length - 1)]!;
      call++;
      return { text: answer, model: 'mock-model' };
    }),
  };
}

function makeConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
    browser: { ...DEFAULT_CONFIG.browser, headed: false },
  };
}

function makeOpts(
  answers: string[],
  overrides: Partial<StepExecutorOptions> = {},
): StepExecutorOptions {
  return {
    page: { url: () => 'https://example.com/pay' } as never,
    config: makeConfig(),
    aiClient: makeClient(answers) as never,
    contextContent: '',
    testName: 'judge test',
    conversationHistory: [],
    csrfTokens: {},
    ...overrides,
  };
}

beforeEach(() => {
  sentPrompts.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── The prompt ───────────────────────────────────────────────────────────

describe('the judge prompt', () => {
  it('labels the conditions A, B, C… in order and offers none and waiting', async () => {
    await evaluateConditions(
      ['the Cash checkbox is ticked', 'the Card checkbox is ticked'],
      makeOpts(['{"matched":"A","actions":[],"reasoning":"Cash is ticked"}']),
    );

    const prompt = sentPrompts[0]!;
    expect(prompt).toContain('A) the Cash checkbox is ticked');
    expect(prompt).toContain('B) the Card checkbox is ticked');
    expect(prompt).toMatch(/Answer with a single label \(A, B\)/);
    expect(prompt).toContain('Answer "none" when none of them is true');
    expect(prompt).toContain('Answer "waiting" ONLY when the page is visibly mid-transition');
  });

  it('forbids acting, in the instructions and in the response format', async () => {
    await evaluateConditions(
      ['the cart is empty'],
      makeOpts(['{"matched":"none","actions":[],"reasoning":"three items"}']),
    );
    const prompt = sentPrompts[0]!;
    expect(prompt).toContain('You are NOT performing a step');
    expect(prompt).toContain('"actions": []');
  });

  it('carries the ## Values block with placeholders intact and secrets masked', async () => {
    await evaluateConditions(
      ['{{plan}} is "pro" and the field holds {{password}}'],
      makeOpts(['{"matched":"A","actions":[],"reasoning":"pro"}'], {
        resolvedParameters: { plan: 'pro', password: 'hunter2' },
      }),
    );

    const prompt = sentPrompts[0]!;
    // The condition itself is AUTHORED — the model reads the placeholder, not
    // the value (stories/placeholder-preserving-actions.md, decision 1).
    expect(prompt).toContain('A) {{plan}} is "pro" and the field holds {{password}}');
    expect(prompt).toContain('## Values');
    expect(prompt).toContain('- {{plan}} resolved to "pro" on this run');
    // …and a secret-named value is masked in the block that carries it.
    expect(prompt).toContain('- {{password}} resolved to "***" on this run');
    expect(prompt).not.toContain('hunter2');
  });

  it('omits the Values block when no condition references anything', async () => {
    await evaluateConditions(
      ['the Load more button is gone'],
      makeOpts(['{"matched":"none","actions":[],"reasoning":"still there"}']),
    );
    expect(sentPrompts[0]).not.toContain('## Values');
  });
});

// ── The answers ──────────────────────────────────────────────────────────

describe('what the judge does with an answer', () => {
  it('returns the index of the labelled condition', async () => {
    const verdict = await evaluateConditions(
      ['a', 'b', 'c'],
      makeOpts(['{"matched":"B","actions":[],"reasoning":"b holds"}']),
    );
    expect(verdict.selected).toBe(1);
    expect(verdict.reasoning).toBe('b holds');
    expect(verdict.aiInteractions).toHaveLength(1);
    expect(verdict.aiInteractions[0]!.purpose).toBe('condition-judge');
  });

  it('returns null for "none"', async () => {
    const verdict = await evaluateConditions(
      ['a', 'b'],
      makeOpts(['{"matched":"none","actions":[],"reasoning":"neither"}']),
    );
    expect(verdict.selected).toBeNull();
  });

  it('accepts an answer with no actions array at all', async () => {
    // The judge is told to send `"actions": []`; a model that simply omits the
    // key has obeyed, and counting that as malformed would burn the budget.
    const verdict = await evaluateConditions(
      ['a'],
      makeOpts(['{"matched":"A","reasoning":"it holds"}']),
    );
    expect(verdict.selected).toBe(0);
  });

  it('re-asks on "waiting" and takes the answer that follows', async () => {
    vi.useFakeTimers();
    const opts = makeOpts([
      '{"matched":"waiting","actions":[],"reasoning":"still loading"}',
      '{"matched":"A","actions":[],"reasoning":"now visible"}',
    ]);
    const promise = evaluateConditions(['a'], opts);
    await vi.advanceTimersByTimeAsync(4000);
    const verdict = await promise;
    expect(verdict.selected).toBe(0);
    expect(verdict.reasoning).toBe('now visible');
    // Both turns are recorded: the cost of the wait is visible in the report.
    expect(verdict.aiInteractions).toHaveLength(2);
  });

  it('treats a malformed answer as a waiting answer', async () => {
    vi.useFakeTimers();
    const promise = evaluateConditions(
      ['a'],
      makeOpts([
        'not json at all',
        '{"matched":"none","actions":[],"reasoning":"decided"}',
      ]),
    );
    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).resolves.toMatchObject({ selected: null });
  });

  it('treats a label naming no condition as malformed rather than guessing', async () => {
    vi.useFakeTimers();
    const promise = evaluateConditions(
      ['a'],
      makeOpts([
        '{"matched":"Z","actions":[],"reasoning":"?"}',
        '{"matched":"A","actions":[],"reasoning":"a holds"}',
      ]),
    );
    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).resolves.toMatchObject({ selected: 0 });
  });
});

// ── The budget ───────────────────────────────────────────────────────────

describe('the 30 s budget', () => {
  it('fails with "could not decide", naming the condition', async () => {
    vi.useFakeTimers();
    const promise = evaluateConditions(
      ['the Remember this device prompt is shown'],
      makeOpts(['{"matched":"waiting","actions":[],"reasoning":"still transitioning"}']),
    );
    // Swallow the rejection until the clock has run, or Node reports an
    // unhandled rejection before the assertion below gets to it.
    const settled = promise.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(CONDITION_JUDGE_BUDGET_MS + 5_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('could not decide: the page did not settle');
    expect((err as Error).message).toContain('30s');
    expect((err as Error).message).toContain('the Remember this device prompt is shown');
  });

  it('stops re-asking once the budget is spent', async () => {
    vi.useFakeTimers();
    const opts = makeOpts(['{"matched":"waiting","actions":[],"reasoning":"…"}']);
    const settled = evaluateConditions(['a'], opts).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(CONDITION_JUDGE_BUDGET_MS + 30_000);
    await settled;
    const client = opts.aiClient as unknown as { complete: { mock: { calls: unknown[] } } };
    // 30 s at 3 s a poll, and no more however long the clock runs on.
    expect(client.complete.mock.calls.length).toBeLessThanOrEqual(11);
    expect(client.complete.mock.calls.length).toBeGreaterThan(8);
  });
});

// ── Aborts ───────────────────────────────────────────────────────────────

describe('a stopped run', () => {
  it('throws an AbortError rather than answering', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluateConditions(['a'], makeOpts(['{"matched":"A","actions":[]}'], {
        signal: controller.signal,
      })),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ── Secrets ──────────────────────────────────────────────────────────────

/**
 * The DOM snapshot the model reads is masked on every prompt that sends one.
 *
 * Since the snapshot started reading LIVE form state, a secret this run typed
 * into an ordinary text field is IN it — and only the step prompt redacted
 * (step-executor.ts, `domForAi`). The judge and the watch-group poller handed
 * the same string over raw, so a run showed the model `••••` on one turn and
 * the value in full on the next (review 3, finding 2).
 */
describe('the DOM snapshot in a prompt', () => {
  const SECRET = 'hunter2-LIVE-VALUE';
  const withSecret =
    `<html><body><input type="text" name="who" value="${SECRET}">` +
    `<button>Continue</button></body></html>`;

  beforeEach(() => {
    vi.mocked(captureDomSnapshot).mockResolvedValue(withSecret);
  });

  afterEach(() => {
    vi.mocked(captureDomSnapshot).mockResolvedValue('<html><body>the page</body></html>');
  });

  it('is masked in the condition judge`s user message', async () => {
    await evaluateConditions(
      ['the token was accepted'],
      makeOpts(['{"matched":"A","actions":[],"reasoning":"accepted"}'], {
        // Secret by NAME — the same rule the step prompt and the report use.
        resolvedParameters: { api_token: SECRET },
      }),
    );

    const prompt = sentPrompts[0]!;
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain('value="***"');
    // Masked, not dropped: the judge still sees the page it is judging.
    expect(prompt).toContain('<button>Continue</button>');
  });

  it('is masked in the watch group`s poll message', async () => {
    const opts = makeOpts(['{"matched":"waiting","actions":[],"reasoning":"…"}'], {
      resolvedParameters: { api_token: SECRET },
    });
    // One second of budget is one poll: the group times out having asked
    // once, which is all this test needs to read.
    opts.config = {
      ...opts.config,
      execution: { ...opts.config.execution, timeout: 1 },
    };

    await executeBranchedStep(
      {
        conditionalSteps: [{ index: 3, instruction: 'If a cookie banner appears, click Reject all' }],
        continuationStep: { index: 4, instruction: 'Click Continue' },
      },
      5,
      opts,
    );

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]!).not.toContain(SECRET);
    expect(sentPrompts[0]!).toContain('value="***"');
  });

  it('leaves the snapshot alone when the run holds no secrets', async () => {
    await evaluateConditions(
      ['the field is filled'],
      makeOpts(['{"matched":"A","actions":[],"reasoning":"filled"}'], {
        resolvedParameters: { who: SECRET },
      }),
    );

    // `who` is not a secret name, so nothing is masked — the rule is the
    // parameter's NAME, exactly as it is everywhere else.
    expect(sentPrompts[0]!).toContain(SECRET);
  });
});
