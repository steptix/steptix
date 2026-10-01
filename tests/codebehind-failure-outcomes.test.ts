import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, BrowserContext, Browser } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult, TurnResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';
import { executeStep } from '../src/runner/step-executor.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { buildFileReviewPrompt } from '../src/codebehind/review.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { isNonRetryable } from '../src/browser/upload-paths.js';
import {
  generationRefusal,
  DISPATCHED_NOT_COMPILED,
  TOLERATED_CODE_BEHIND_REFUSAL,
  TOLERATED_FAILURE_REFUSAL,
} from '../src/codebehind/live-compile.js';
import {
  runCodeBehindEntry,
  CodeBehindDeliberateFailure,
  CodeBehindExpectationError,
  EXIT_NOT_CLAIMED,
  FAIL_WITHOUT_MESSAGE,
} from '../src/codebehind/execute.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { actionsOf, readRecording, spliceRecording, writeRecording } from '../src/codebehind/recording.js';
import {
  compileTest,
  type CompileEvent,
  type CompileRunOutcome,
  type CompileRunner,
} from '../src/codebehind/compile.js';

/**
 * The two failure outcomes of stories/step-failure-outcomes.md — `step.fail()`
 * (decision 10: a real failure, never healed, in the author's words) and a step
 * that failed and was TOLERATED (decision 11) — through the entry points
 * production uses, since an input nothing produces proves nothing.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-failure-outcomes');

const noPage = {} as unknown as Page;
const noContext = {} as unknown as BrowserContext;
const noBrowser = {} as unknown as Browser;

let counter = 0;
let dir: string;

beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

const FAIL_STEP =
  'If the booking is cancelled then fail the test with error "The booking was cancelled"';
const FAIL_MESSAGE = 'The booking was cancelled';
const TOLERATED_STEP = 'Dismiss the promo banner otherwise continue';

/** The claim every runner computes off the authored line before anything else. */
const claimFor = (text: string): NonNullable<ReturnType<typeof parseFlowControlStep>> =>
  parseFlowControlStep(text)!;

/** Enough `Page` for the executor's bookkeeping — the one test that goes through
 *  `executeStep` runs an entry that never touches a DOM. */
function fakePage(): Page {
  return {
    on: () => {}, off: () => {}, url: () => 'https://app.test/dashboard',
    context: () => ({ browser: () => ({}) }),
    evaluate: async () => { throw new Error('no DOM in this test'); },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

// ── 1. `step.fail()` — the entry API ──

/** A binding with no scope and no file behind it: these tests turn on neither. */
function bareBinding(source: string, run: CodeBehindBinding['entry']): CodeBehindBinding {
  return {
    file: path.join(dir, 'x.steps.ts'), source, occurrence: 0,
    scope: { renames: {}, inputs: {} }, entry: run,
  };
}

/** Run one entry: no page, no parameters, the same label every time. `claim` is
 *  the authored line whose flow-control claim the step carries, if any. */
function runEntry(
  source: string,
  run: NonNullable<CodeBehindBinding['entry']>['run'],
  claim?: string,
) {
  return runCodeBehindEntry({
    binding: bareBinding(source, { source, run }),
    page: noPage, context: noContext, browser: noBrowser, resolvedParameters: {},
    ...(claim !== undefined && { flowControlClaim: claimFor(claim) }),
    label: 'test',
  });
}

describe('step.fail()', () => {
  it('fails the step in the author\'s words, marks it deliberate, and runs nothing after it', async () => {
    let after = false;
    const outcome = await runEntry(FAIL_STEP, ({ step }) => {
      step.fail(FAIL_MESSAGE);
      after = true; // Unreachable: `fail` throws. Kept so a `fail` that stopped would show here.
    }, FAIL_STEP);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe(FAIL_MESSAGE);
    // `expectationFailed` is what the do-not-heal rule reads, and it stays true:
    // a deliberate failure IS a real failure (decision 10).
    expect(outcome.expectationFailed).toBe(true);
    expect(outcome.deliberate).toBe(true);
    expect(outcome.flowControl).toBeUndefined();
    expect(after).toBe(false);
  });

  it('fails from inside a helper, not only from the entry body', async () => {
    const outcome = await runEntry(FAIL_STEP, ({ step }) => {
      const giveUp = (): never => step.fail(FAIL_MESSAGE);
      [1].forEach(() => giveUp());
    }, FAIL_STEP);
    expect(outcome.status).toBe('failed');
    expect(outcome.deliberate).toBe(true);
    expect(outcome.error).toBe(FAIL_MESSAGE);
  });

  it('has NO claim guard — the mirror of exit()\'s, and the reason is the direction', async () => {
    // An exit's unsafe direction is passing work that did not happen; failing has
    // none, so an ordinary step — no claim passed here at all — whose entry calls
    // `fail` has simply failed (decision 10).
    const outcome = await runEntry('Enter the booking code',
      ({ step }) => step.fail('the code field never appeared'));

    expect(outcome.status).toBe('failed');
    expect(outcome.deliberate).toBe(true);
    expect(outcome.error).toBe('the code field never appeared');
    // And not the unclaimed-exit refusal, which is what a guard would produce.
    expect(outcome.nonRetryable).toBeUndefined();
    expect(outcome.nonRetryableKind).toBeUndefined();
  });

  it('still fails, with a sentence of its own, when no message was given', async () => {
    for (const call of [
      (step: { fail: (m: string) => never }): void => { step.fail(''); },
      (step: { fail: (m: string) => never }): void => { (step as unknown as { fail: () => never }).fail(); },
      (step: { fail: (m: string) => never }): void => { step.fail('   '); },
    ]) {
      // Swallowing the call over missing words would turn a red step green — the
      // one direction this must not fail in.
      const outcome = await runEntry(FAIL_STEP, ({ step }) => { call(step); }, FAIL_STEP);
      expect(outcome.status).toBe('failed');
      expect(outcome.deliberate).toBe(true);
      expect(outcome.error).toBe(FAIL_WITHOUT_MESSAGE);
      expect(outcome.error).toContain('step.fail()');
    }
  });

  it('leaves a plain step.expect failure exactly as it was — no deliberate flag', async () => {
    // Narrowness: `deliberate` changes the WORDING of the failure, so a
    // `step.expect` that acquired it would report an assertion the author never
    // asked for as one they did.
    const outcome = await runEntry('Verify the total',
      ({ step }) => step.expect(false, 'the total read £0.00'));
    expect(outcome.status).toBe('failed');
    expect(outcome.expectationFailed).toBe(true);
    expect(outcome.deliberate).toBeUndefined();
    expect(outcome.error).toBe('the total read £0.00');
  });

  it('is masked on its way out of the executor, like every other failure message', async () => {
    // Through `executeStep`: the entry keeps the real value (the step typed it), and
    // its return is the seam where the message becomes what the wire, the report and
    // the log carry — `runCodeBehindStep` handed `outcome.error` back raw (decision 3).
    const source = 'Verify the session token';
    const result = await executeStep(1, 1, source, {
      page: fakePage(),
      config: CONFIG,
      aiClient: { complete: async () => { throw new Error('no AI in this test'); } } as unknown as AiClient,
      contextContent: '',
      testName: 'masking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: { password: 'hunter2' },
      codeBehind: bareBinding(source, {
        source,
        run({ step }) { step.fail(`got ${step.getVar('password')}`); },
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.deliberate).toBe(true);
    expect(result.error).toBe('got ***');
    expect(result.error).not.toContain('hunter2');
  });

  it('does not let step.exit() through on a fail-claiming step', async () => {
    // A `fail` claim says the step ends the RUN in the author's words, so an entry
    // that exits would end the flow as a PASS — green for work not done. Refused with
    // every other unclaimed exit (decision 1); a claim IS present, just not a return.
    const outcome = await runEntry(FAIL_STEP, ({ step }) => { step.exit(); }, FAIL_STEP);

    expect(outcome.status).toBe('failed');
    expect(outcome.flowControl).toBeUndefined();
    expect(outcome.nonRetryable).toBe(true);
    expect(outcome.nonRetryableKind).toBe('exit-unclaimed');
    expect(outcome.error).toBe(EXIT_NOT_CLAIMED);
    // Not read as an assertion either: nothing here heals, and nothing here is
    // the author's deliberate failure.
    expect(outcome.expectationFailed).toBe(false);
    expect(outcome.deliberate).toBeUndefined();
  });

  it('throws a CodeBehindExpectationError, so every existing reading of one still holds', () => {
    // The subclass, not a class beside it: an author's own `instanceof
    // CodeBehindExpectationError` and the do-not-heal rule both key on it.
    const err = new CodeBehindDeliberateFailure(FAIL_MESSAGE);
    expect(err).toBeInstanceOf(CodeBehindExpectationError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CodeBehindDeliberateFailure');
    // And NOT the upload-path "fact about the world" tag — a different
    // non-retryable family with its own report wording.
    expect(isNonRetryable(err)).toBe(false);
  });
});

// ── 2. Eligibility — both compilers, one sentence ──

describe('generationRefusal and the fail verb', () => {
  const binding = (source: string): CodeBehindBinding =>
    ({ file: path.join(dir, 'booking.steps.ts'), source, occurrence: 0, scope: { renames: {}, inputs: {} } });

  /** The refusal for one authored line, defaulting to a step that passed. An
   *  `entry` override rides on the binding, so it is lifted there. */
  const refusal = (
    text: string,
    over: Partial<Parameters<typeof generationRefusal>[0]>
      & { entry?: CodeBehindBinding['entry'] } = {},
  ): string | undefined => {
    const { entry, ...rest } = over;
    const b = binding(text);
    return generationRefusal({ binding: entry ? { ...b, entry } : b, text, status: 'passed', ...rest });
  };

  /** An entry that exists — these rules turn on its presence, never its code. */
  const anEntry = (source: string) => ({ source, run: async () => {} });

  it('refuses the UNCONDITIONAL Fail, in the same breath as Return and Stop', () => {
    for (const text of ['Fail the test with error "no balance was shown"',
      "Fail the test with message 'no balance was shown'", 'Fail', 'Fail the run.']) {
      expect(refusal(text), `should be refused: ${JSON.stringify(text)}`).toBe(DISPATCHED_NOT_COMPILED);
    }
    expect(DISPATCHED_NOT_COMPILED).toContain('Return/Stop/Fail');
  });

  it('takes the CONDITIONAL fail — it compiles to `if (…) step.fail(…)`', () => {
    expect(refusal(FAIL_STEP)).toBeUndefined();
  });

  it('refuses a tolerated failure with its own reason, ahead of "did not pass"', () => {
    // It carries `status: 'failed'`, so the general sentence is what it would
    // otherwise get — a bug hunt in a step whose own tail says it may fail (dec. 11).
    expect(refusal(TOLERATED_STEP, { status: 'failed', tolerated: true }))
      .toBe(TOLERATED_FAILURE_REFUSAL);
    expect(TOLERATED_FAILURE_REFUSAL).toContain('otherwise continue');
    // An untolerated failure still gets the general one.
    expect(refusal('Confirm the booking', { status: 'failed' })).toBe('the step did not pass');
  });

  it('says the entry stands when the tolerated failure came from the ENTRY', () => {
    // The entry ran, reported the failure (its job) and the tail let the run past it:
    // nothing is owed, so the reason must say the entry exists — ahead of this the step
    // was listed in `notAttempted` while its code sat in the author's file.
    expect(refusal(TOLERATED_STEP, {
      entry: anEntry(TOLERATED_STEP), status: 'failed', tolerated: true, fromCodeBehind: true,
    })).toBe(TOLERATED_CODE_BEHIND_REFUSAL);
    expect(TOLERATED_CODE_BEHIND_REFUSAL).toContain('ran as code');
    expect(TOLERATED_CODE_BEHIND_REFUSAL).toContain('otherwise continue');
    // A STALE entry is the other case: it threw, AI healed the step, the tail
    // tolerated the failure — no evidence to repair from, so the step keeps the
    // plain reason and is owed an entry.
    expect(refusal(TOLERATED_STEP, {
      entry: anEntry(TOLERATED_STEP), status: 'failed', tolerated: true, fromCodeBehind: false,
      codeBehindStale: { file: 'x.steps.ts', source: TOLERATED_STEP, error: 'locator timeout' },
    })).toBe(TOLERATED_FAILURE_REFUSAL);
  });

  it('takes a DELIBERATE failure — a `failed` status that means the step worked', () => {
    // The mirror of the tolerated rule on the opposite fact: the step read its
    // condition, it held, it ended the run as written, and its transcript holds `fail`
    // the way a return's holds `return` (decisions 1–3 and 10).
    expect(refusal(FAIL_STEP, { status: 'failed', deliberate: true })).toBeUndefined();
    // Without the flag it is an ordinary red step, and stays refused.
    expect(refusal(FAIL_STEP, { status: 'failed' })).toBe('the step did not pass');
  });

  it('still says "ran as code" when the ENTRY is what failed the run as written', () => {
    // The rules below the status check still apply: an entry that already fails
    // the run as written needs no transcript and no second entry — what a proving
    // replay of a compiled fail step looks like here.
    expect(refusal(FAIL_STEP, {
      entry: anEntry(FAIL_STEP), status: 'failed', deliberate: true, fromCodeBehind: true,
    })).toBe('the step ran as code');
  });

  it('leaves a step that PASSED with a tail exactly as it was', () => {
    // The tail did nothing, so this is an ordinary compilable step — a tail is the
    // runner's business, never the compiler's.
    expect(refusal(TOLERATED_STEP)).toBeUndefined();
  });
});

// ── 3. Compile — the recording, the selection and the proving replay ──

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

const REVIEW_NOOP = '<<review: echo the file back>>';

function scriptedClient(responses: string[]): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1];
      const prompt = typeof last?.content === 'string'
        ? last.content
        : (last?.content ?? []).map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
      prompts.push(prompt);
      const text = responses.shift();
      if (text === undefined) throw new Error('AI called more times than the test scripted');
      if (text === REVIEW_NOOP) {
        const file = /```ts\n([\s\S]*?)```/.exec(prompt)?.[1];
        if (!file) throw new Error('review prompt carried no file to echo');
        return { text: JSON.stringify({ file }), model: 'stub-model' };
      }
      return { text, model: 'stub-model' };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

function entryEnvelope(source: string, body = `await page.locator('#code').waitFor();`): string {
  return JSON.stringify({
    entry: `{\n  source: ${JSON.stringify(source)},\n  async run({ page, step, log }) {\n    ${body}\n  },\n}`,
  });
}

/** A test file: a title, an optional `## Parameters` block, numbered steps. */
const testMd = (title: string, steps: string[], params: string[] = []): string => [
  `# ${title}`,
  '',
  ...(params.length > 0 ? ['## Parameters', ...params.map((p) => `- ${p}`), ''] : []),
  '## Steps',
  ...steps.map((s, i) => `${i + 1}. ${s}`),
].join('\n');

const TURN_AT = '2026-09-11T00:00:00.000Z';

const turn = (subActions: TurnResult['subActions']): TurnResult =>
  ({ turnNumber: 1, attemptNumber: 1, timestamp: TURN_AT, aiInteractions: [], subActions });

/** A passed step whose transcript is one ordinary action. */
function passed(index: number, over: Partial<StepResult> = {}): StepResult {
  return {
    index, instruction: `step ${index}`, status: 'passed',
    turns: [turn([
      { index: 1, action: { action: 'type', selector: '#code', value: '220826' }, durationMs: 5 },
    ])],
    durationMs: 10, retried: false, pageUrl: 'https://app.test/booking',
    stepContext: {
      domBefore: '<input id="code">', urlBefore: 'https://app.test/booking',
      domAfter: '<input id="code" value="220826">', urlAfter: 'https://app.test/booking',
    },
    ...over,
  };
}

/** A step that failed and whose `otherwise continue` tail let the run past it —
 *  `status` stays `failed`, `tolerated` rides beside it (decision 6). */
function tolerated(index: number, error = 'the promo banner was not there'): StepResult {
  return { ...passed(index), status: 'failed', tolerated: true, error, turns: [] };
}

/** A step that failed because its own text said to (decision 2), with the transcript
 *  `executeStep` really produces: one `fail` sub-action carrying the message as its
 *  `error`, because for this action the error IS the product. An invented empty one
 *  would prove the compile against an input it is never handed. */
function deliberate(index: number, error = FAIL_MESSAGE): StepResult {
  return {
    ...passed(index),
    status: 'failed', deliberate: true, error,
    turns: [turn([
      { index: 1, action: { action: 'fail', description: 'the booking shows as cancelled' }, error, durationMs: 2 },
    ])],
  };
}

function collect(): { events: CompileEvent[]; onEvent: (e: CompileEvent) => void } {
  const events: CompileEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const generatedSteps = (events: CompileEvent[]): number[] => events
  .filter((e) => e.kind === 'step' && e.phase === 'generate' && e.message === 'generated')
  .map((e) => (e as { step: number }).step);

const phaseMessages = (events: CompileEvent[], phase: string): string[] => events
  .filter((e) => e.kind === 'phase' && e.phase === phase)
  .map((e) => (e as { message: string }).message);

/** `fromCodeBehind` — a step the replay ran as code. */
const CB = { fromCodeBehind: true } as const;

const outcome = (
  status: CompileRunOutcome['status'], steps: CompileRunOutcome['steps'],
  over: Partial<CompileRunOutcome> = {},
): CompileRunOutcome => ({ status, steps, resolvedParameters: {}, tokensUsed: 0, ...over });

/** One compile: write `md` (and any pre-existing `.steps.ts` as `existing`), script the
 *  AI with `responses`, answer the record request with `record` and every replay with
 *  `replay` — a function of the replay ordinal when the rounds differ. */
async function runCompile(opts: {
  md: string; name?: string; existing?: string;
  record: CompileRunOutcome;
  replay?: CompileRunOutcome | ((round: number) => CompileRunOutcome);
  responses?: string[]; maxRounds?: number;
}) {
  const name = opts.name ?? 'booking';
  const mdPath = await write(`${name}.md`, opts.md);
  if (opts.existing !== undefined) await write(`${name}.steps.ts`, opts.existing);
  const test = await parseTestFile(mdPath);
  const { client, prompts } = scriptedClient(opts.responses ?? []);
  const { events, onEvent } = collect();
  let replays = 0;
  const runner: CompileRunner = async (request) => {
    if (request.purpose === 'record') return opts.record;
    replays++;
    if (opts.replay === undefined) throw new Error('replayed more times than the test scripted');
    return typeof opts.replay === 'function' ? opts.replay(replays) : opts.replay;
  };
  const result = await compileTest({
    test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    ...(opts.maxRounds !== undefined && { maxRounds: opts.maxRounds }),
  });
  const stepsPath = path.join(dir, `${name}.steps.ts`);
  return { result, events, prompts, stepsPath, written: (): Promise<string> => fs.readFile(stepsPath, 'utf-8') };
}

type CompileOver = Partial<Parameters<typeof runCompile>[0]>;

const TOLERATED_MD = testMd('Booking', ['Enter the booking code', TOLERATED_STEP, 'Confirm the booking']);
/** The fail step in the middle: something comes after the run's own ending. */
const FAIL_MD = testMd('Booking', ['Enter the booking code', FAIL_STEP, 'Confirm the booking']);
/** The same step LAST, where the run ending as written leaves no gap at all. */
const FAIL_LAST_MD = testMd('Booking', ['Enter the booking code', FAIL_STEP]);

/** The entry the generator is scripted to return for `FAIL_STEP` — the one the
 *  story predicts, reading the condition and passing the author's words on. */
const FAIL_ENTRY_BODY =
  `if (await page.locator('#cancelled').isVisible()) step.fail(${JSON.stringify(FAIL_MESSAGE)});`;

/** Generation for the two ordinary steps of `TOLERATED_MD`, then the review. */
const TOLERATED_RESPONSES = [entryEnvelope('Enter the booking code'),
  entryEnvelope('Confirm the booking', `await page.locator('#confirmed').waitFor();`), REVIEW_NOOP];

/** Generation for step 1 and the fail step of `FAIL_MD`, then the review. */
const FAIL_RESPONSES = [entryEnvelope('Enter the booking code'),
  entryEnvelope(FAIL_STEP, FAIL_ENTRY_BODY), REVIEW_NOOP];

describe('compile — a step the recording tolerated', () => {
  it('reports it not attempted, and still compiles the steps after it', async () => {
    // Step 2 failed and the run carried on, so step 3 ran and has a transcript: the
    // prefix has to step OVER step 2, or the rest of the test is thrown away over a
    // failure the author declared harmless.
    const { result, events, written } = await runCompile({
      md: TOLERATED_MD,
      record: outcome('passed', [passed(1), tolerated(2), passed(3)], { tokensUsed: 500 }),
      responses: [...TOLERATED_RESPONSES],
      replay: outcome('passed', [passed(1, CB), passed(2), passed(3, CB)]),
    });

    expect(generatedSteps(events)).toEqual([1, 3]);
    expect(result.summary.compiled).toBe(2);
    expect(result.summary.notAttempted).toEqual([2]);
    expect(result.status).toBe('partial'); // Not green: step 2 still has no entry.
    // The recording did NOT stop — the point of the prefix stepping over it.
    expect(result.summary.stoppedAt).toBeUndefined();
    // The reason is on the step, by number, not only in a total.
    expect(events.some((e) => e.kind === 'step' && e.step === 2 && e.message === TOLERATED_FAILURE_REFUSAL)).toBe(true);

    const file = await written();
    expect(file).toContain("source: 'Enter the booking code'");
    expect(file).toContain("source: 'Confirm the booking'");
    // No `ai: true` entry for step 2: nothing tested whether it can be code.
    expect(file).not.toContain('Dismiss the promo banner');
  });

  it('says so and writes nothing when the only selected step was tolerated', async () => {
    const record = outcome('passed', [passed(1, CB), tolerated(2), passed(3, CB)]);
    const { result, events, prompts } = await runCompile({
      md: TOLERATED_MD,
      existing: `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ page }) { await page.locator('#code').waitFor(); } },
  { source: 'Confirm the booking', async run({ page }) { await page.locator('#confirmed').waitFor(); } },
]);
`,
      record,
      replay: record,
    });

    expect(prompts).toEqual([]);
    expect(result.status).toBe('partial');
    expect(result.summary.compiled).toBe(0);
    expect(result.summary.notAttempted).toEqual([2]);
    expect(result.files).toEqual({});
    // "Did not run on the recording run" is the skipped step's sentence and is false
    // here: this step ran, and failed.
    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain('failed on the recording run and was tolerated');
    expect(done.message).not.toContain('did not run on the recording run');
  });
});

describe('compile — a proving replay that tolerates a failure', () => {
  it('leaves the entry unproven and ends partial, naming it', async () => {
    // The recording ran everything: the banner was there and the step passed. On the
    // replay it was gone, so the entry failed and the tail let the run past it.
    const { result, events } = await runCompile({
      md: TOLERATED_MD,
      record: outcome('passed', [passed(1), passed(2), passed(3)], { tokensUsed: 500 }),
      responses: [
        entryEnvelope('Enter the booking code'),
        entryEnvelope(TOLERATED_STEP, `await page.locator('#promo .close').click();`),
        entryEnvelope('Confirm the booking', `await page.locator('#confirmed').waitFor();`),
        REVIEW_NOOP,
      ],
      replay: outcome('passed', [passed(1, CB), tolerated(2), passed(3, CB)]),
    });

    // Neither proven nor failed: the entry is proposed, and the compile does not
    // claim the test replays as code.
    expect(result.status).toBe('partial');
    expect(result.summary.compiled).toBe(3);
    expect(result.summary.unproven).toEqual([2]);
    expect(result.summary.writtenOffAi).toEqual([]);
    expect(result.summary.error).toContain('failed and was tolerated');
    expect(result.summary.error).toContain('the promo banner was not there');
    // And the round's own line does not claim 3/3 passed as code.
    const replayLines = phaseMessages(events, 'replay');
    expect(replayLines.some((m) => m.includes('step 2 failed and was tolerated'))).toBe(true);
    expect(replayLines.some((m) => m.includes('3/3 passed as code'))).toBe(false);
    // No repair round spent on it: a tolerated failure is not the replay's failure,
    // so there is nothing for the compiler to rewrite.
    expect(result.summary.rounds).toBe(1);
  });
});

/** A run that ends because a step's own text says to is EVIDENCE, not a defect
 *  (decisions 1–3 and 10). The compile used to call it "failed under AI", drop it from
 *  the prefix, and tell the author to fix a step that did what they wrote. */
describe('compile — a step the recording failed deliberately', () => {
  /** The replay ends in the same place for the same reason: the entry read the
   *  condition, it held, and it failed the run. */
  const sameEnding = (): CompileRunOutcome => outcome('failed', [passed(1, CB), deliberate(2)]);

  /** `FAIL_MD` recorded as the story predicts, replayed the same way. */
  const compileFail = (over: CompileOver = {}) => runCompile({
    md: FAIL_MD,
    record: outcome('failed', [passed(1), deliberate(2)]),
    responses: [...FAIL_RESPONSES],
    replay: sameEnding(),
    ...over,
  });

  it('compiles it from its own transcript, and names what the run never reached', async () => {
    // The run ended AT step 2. Step 3 has no result at all — nothing ran it.
    const { result, events, prompts, written } = await compileFail({
      record: outcome('failed', [passed(1), deliberate(2)], { tokensUsed: 500 }),
    });

    // The step compiled — the one step the whole feature exists for, and the live
    // compile of the fixture wrote no entry for it at all.
    expect(generatedSteps(events)).toEqual([1, 2]);
    expect(result.summary.compiled).toBe(2);
    const file = await written();
    expect(file).toContain('step.fail(');
    expect(file).toContain(FAIL_MESSAGE);

    // Step 3 is owed and named — but the recording did not STOP, so nothing in the
    // summary uses that vocabulary.
    expect(result.summary.notAttempted).toEqual([3]);
    expect(result.summary.stoppedAt).toBeUndefined();
    expect(result.status).toBe('partial');

    // The record phase says the run ended as written, and does not invite a repair
    // of a step that has nothing wrong with it.
    const recordLines = phaseMessages(events, 'record');
    expect(recordLines.some((m) => m.startsWith('ended at step 2 as its text says — The booking was cancelled'))).toBe(true);
    expect(recordLines.some((m) => m.includes('compiling 2 step(s) up to it (step 3 not attempted)'))).toBe(true);
    expect(recordLines.some((m) => m.includes('stopped at step'))).toBe(false);

    // Per step, not only as a total: step 3's own line answers "why has this no
    // entry", clipped so a long step cannot run away with the message.
    const note = events.find((e) => e.kind === 'step' && e.step === 3) as { message: string };
    expect(note.message).toContain(
      'not attempted: the run ended at step 2 as its text says (If the booking is cancelled',
    );
    expect(note.message.endsWith('…)')).toBe(true);

    // The summary's reason, which is what the CLI prints for a partial.
    expect(result.summary.error).toContain('the run ended at step 2 as its text says');
    expect(result.summary.error).toContain('not attempted: step 3');
    expect(result.summary.error).not.toContain('fix');

    // The generator really was handed the `fail` action: without it the transcript is
    // empty, `refuseReason` answers "the recorded run performed no page actions for this
    // step", and the step becomes `ai: true` for the opposite reason to what happened.
    // Matched on the authored-step block, since every prompt carries the whole test.
    const generation = prompts.find((p) => p.includes(`## The step, exactly as authored\n${FAIL_STEP}`))!;
    expect(generation).toContain('"action": "fail"');
    expect(generation).toContain('ended the run under AI control');
    expect(generation).not.toContain('just passed under AI control');
  });

  it('proves it on the replay, and spends no repair round on it', async () => {
    const { result, events } = await compileFail({ maxRounds: 2 });

    // Reproducing the recording's outcome is all a proving replay asks, so the entry
    // is PROVEN — not repaired, not written off as `ai: true` with the author's own
    // sentence buried in the comment.
    expect(result.summary.unproven).toEqual([]);
    expect(result.summary.writtenOffAi).toEqual([]);
    expect(result.summary.rounds).toBe(1);
    const replayLines = phaseMessages(events, 'replay');
    expect(replayLines.some((m) => m.includes('replayed as code — the run ended at step 2 as its text says'))).toBe(true);
    // "Passed as code" is the one thing that cannot be said about a red run.
    expect(replayLines.some((m) => m.includes('passed as code'))).toBe(false);
    expect(replayLines.some((m) => m.startsWith('✗'))).toBe(false);
  });

  it('is GREEN when the ending step is the last step — there is no gap', async () => {
    const { result, events } = await compileFail({ md: FAIL_LAST_MD });

    // Every step ran, every step compiled, and the replay did what the recording
    // did. Nothing is owed, so nothing is withheld.
    expect(result.status).toBe('green');
    expect(result.summary.notAttempted).toEqual([]);
    expect(result.summary.unproven).toEqual([]);
    expect(result.summary.error).toBeUndefined();
    expect(phaseMessages(events, 'record').some((m) => m.includes('ended at step'))).toBe(false);
  });

  it('reports it as an ended run, not a stopped one, when nothing up to it needs compiling', async () => {
    // Both prefix steps already have entries, so the selection holds only step 3 —
    // past the end, and never attempted.
    const record = outcome('failed', [passed(1, CB), deliberate(2, FAIL_MESSAGE)]);
    const { result, events, prompts } = await compileFail({
      existing: `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ page }) { await page.locator('#code').waitFor(); } },
  { source: ${JSON.stringify(FAIL_STEP)}, async run({ page, step }) { ${FAIL_ENTRY_BODY} } },
]);
`,
      record,
      replay: record,
      responses: [],
    });

    expect(prompts).toEqual([]);
    // `partial`, not `failed`: nothing went wrong. The old branch calls it a stopped
    // recording and tells the author to fix the step.
    expect(result.status).toBe('partial');
    expect(result.summary.notAttempted).toEqual([3]);
    expect(result.summary.stoppedAt).toBeUndefined();
    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain('Record ended at step 2 as its text says — The booking was cancelled');
    expect(done.message).toContain('step 3 did not run');
    expect(done.message).not.toContain('fix that step');
  });

  it('a replay that PASSES the step is a pass — the condition simply flipped', async () => {
    // Not cancelled this time, so the same entry did nothing at all — the other
    // branch of the same `if`.
    const { result, events } = await compileFail({
      replay: outcome('passed', [passed(1, CB), passed(2, CB)]),
      maxRounds: 2,
    });

    expect(result.summary.unproven).toEqual([]);
    expect(result.summary.writtenOffAi).toEqual([]);
    expect(result.summary.rounds).toBe(1);
    expect(phaseMessages(events, 'replay').some((m) => m.includes('2/2 passed as code'))).toBe(true);
  });
});

describe('compile — the done headline', () => {
  // Three causes leave a step without an entry, and each headline names its own:
  // the other two assert something that did not happen.
  it.each([
    {
      label: 'names a tolerated failure, and does not borrow the skipped cause',
      md: TOLERATED_MD, responses: TOLERATED_RESPONSES,
      record: outcome('passed', [passed(1), tolerated(2), passed(3)], { tokensUsed: 500 }),
      replay: outcome('passed', [passed(1, CB), passed(2), passed(3, CB)]),
      says: 'step 2 not attempted on the recording run (they failed on the recording run and were tolerated)',
      absent: ['a return ended the flow', 'the run decided against them'],
    },
    {
      label: 'names a deliberate ending, and borrows neither of the other two',
      md: FAIL_MD, responses: FAIL_RESPONSES,
      record: outcome('failed', [passed(1), deliberate(2)]),
      replay: outcome('failed', [passed(1, CB), deliberate(2)]),
      says: 'step 3 not attempted on the recording run (the run ended at step 2 as its text says)',
      absent: ['a return ended the flow', 'were tolerated', 'stopped at step'],
    },
  ])('$label', async ({ md, record, replay, responses, says, absent }) => {
    const { events } = await runCompile({ md, record, replay, responses: [...responses] });
    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain(says);
    for (const other of absent) expect(done.message).not.toContain(other);
  });
});

describe('compile — a proving replay that fails deliberately', () => {
  it('is a plain replay failure when the RECORDING did not fail there', async () => {
    // The recording ran everything: the booking was not cancelled. Round 1's
    // condition held, so the entry failed the run with the author's sentence; the
    // confirming round after the write-off passes.
    const { result, events, written } = await runCompile({
      md: FAIL_MD,
      record: outcome('passed', [passed(1), passed(2), passed(3)], { tokensUsed: 500 }),
      responses: [
        entryEnvelope('Enter the booking code'),
        entryEnvelope(FAIL_STEP, FAIL_ENTRY_BODY),
        entryEnvelope('Confirm the booking', `await page.locator('#confirmed').waitFor();`),
        REVIEW_NOOP,
      ],
      replay: (round) => round === 1
        ? outcome('failed', [passed(1, CB), deliberate(2)])
        : outcome('passed', [passed(1, CB), passed(2), passed(3, CB)]),
      maxRounds: 1,
    });

    // Reported like any failing replay step — no carve-out — with the author's words
    // as the error rather than a framework sentence.
    expect(phaseMessages(events, 'replay').some((m) => m === `✗ step 2 — ${FAIL_MESSAGE}`)).toBe(true);
    expect(result.summary.writtenOffAi).toEqual([2]);
    expect(await written()).toContain(FAIL_MESSAGE);
  });
});

// ── 4. The review and repair prompts ──

/** Assert on one built prompt. The negatives are the narrowness half: a prompt
 *  that also says the other thing sends the model the opposite way. */
const expectPhrases = (text: string, contains: string[], absent: string[]): void => {
  for (const phrase of contains) expect(text).toContain(phrase);
  for (const phrase of absent) expect(text).not.toContain(phrase);
};

/** What the generator is told about a `fail` TRANSCRIPT — the half of decision 10
 *  that decides whether the entry it writes is right on the next run too. A run
 *  described as anything but what it was makes the model decline a step that
 *  worked. */
describe('the generation prompt for a step the run failed deliberately', () => {
  type PromptActions = Parameters<typeof buildStepCodePrompt>[0]['actions'];
  const FAILED: PromptActions = [{ action: 'fail', description: 'the booking shows as cancelled' }];
  const NOOP: PromptActions = [{ action: 'noop', description: 'the booking is active' }];
  const promptFor = (actions: PromptActions): string =>
    contentBlocksToText(buildStepCodePrompt({ rawStepText: FAIL_STEP, parameters: [], actions }).content);

  it.each([
    {
      label: 'says the run ENDED, not that the step passed, when the transcript shows a fail',
      actions: FAILED,
      // The transcript is what the entry is written from, so it has to be in the
      // prompt at all: dropped, the model gets "(no actions recorded)" here.
      contains: ['just ended the run under AI control', '"action": "fail"'],
      absent: ['just passed under AI control'],
    },
    {
      // The same claimed step answers `noop` when the condition is false, and that run
      // really did pass. Read off the transcript, never off the claim.
      label: 'still says "passed" for the same line on a run where the condition did not hold',
      actions: NOOP,
      contains: ['just passed under AI control'], absent: ['ended the run under AI control'],
    },
    {
      label: 'explains both branches the same way for `fail` as for `return`',
      actions: FAILED,
      contains: [
        'a `fail` action in the transcript means the condition HELD',
        'a `noop` means it did NOT',
        'the same `if` either way',
      ],
      absent: [],
    },
  ])('$label', ({ actions, contains, absent }) => expectPhrases(promptFor(actions), contains, absent));
});

describe('the review prompt', () => {
  const FILE = `export default defineSteps([{ source: ${JSON.stringify(FAIL_STEP)} }]);`;
  const reviewText = (steps: string[]): string =>
    buildFileReviewPrompt({ markdownName: 'booking.md', file: FILE, steps }).content as string;

  it.each([
    {
      label: 'excepts a fail-claiming entry from the post-condition item',
      steps: ['Enter the booking code', FAIL_STEP],
      contains: [
        'The one exception is a **flow-control step**',
        "`if (…) step.fail('…');`, `step.fail` throws too",
        'nothing else is complete',
      ],
      absent: [],
    },
    {
      // The return exception stays; the fail sentence must not. A reviewer told about
      // `step.fail` over a test that has none is invited to invent one.
      label: 'says nothing about step.fail for a test with no fail step',
      steps: ['Enter the booking code', 'If the page title contains "Dashboard" then return'],
      contains: ['The one exception is a **flow-control step**'], absent: ['step.fail'],
    },
    {
      label: "tells the reviewer to keep the author's message on an `otherwise fail` tail",
      steps: ['Verify the title contains "Account details" otherwise fail the test with message "Page did not contain account details"'],
      contains: ['keeps M, verbatim', "`step.expect(…)`", 'Do not reword it'], absent: [],
    },
    {
      label: 'tells the reviewer an `otherwise continue` step is reviewed as its body',
      steps: [TOLERATED_STEP],
      contains: ['reviewed as its body alone', 'do not soften its'], absent: [],
    },
    {
      label: 'leaves a test with neither tail at nine checklist items',
      steps: ['Enter the booking code', 'Confirm the booking'],
      contains: ['9. An `ai: true` entry is a decision'], absent: ['10. ', 'otherwise continue'],
    },
  ])('$label', ({ steps, contains, absent }) => expectPhrases(reviewText(steps), contains, absent));
});

describe('the repair prompt', () => {
  const repairText = (rawStepText: string, error: string): string =>
    buildRepairPrompt({
      rawStepText, stepIndex: 2, entryCode: '{ source: "…", async run() {} }', error, parameters: [],
    }).content as string;

  it.each([
    {
      label: 'names step.fail in the post-condition carve-out for a fail step',
      step: FAIL_STEP, error: 'the cancelled flag read undefined',
      contains: ['It needs NO post-condition', 'step.fail(<the authored message>)'],
      absent: ['5. End with a post-condition'],
    },
    {
      label: 'still names step.exit for a return step',
      step: 'If the page title contains "Dashboard" then return', error: 'the title read empty',
      contains: ['`step.exit()`'], absent: ['step.fail'],
    },
    {
      // A tail is not a claim: the body is an ordinary step, and its entry ends with
      // an ordinary post-condition.
      label: 'keeps the ordinary rule for a step that merely carries a tail',
      step: TOLERATED_STEP, error: 'timed out',
      contains: ['5. End with a post-condition'], absent: ['step.fail'],
    },
  ])('$label', ({ step, error, contains, absent }) => expectPhrases(repairText(step, error), contains, absent));
});

// ── 4b. Repairing a step that quotes one of its own values ──

/**
 * The author-quoted-literal exemption at the site that asks for a REPLACEMENT entry
 * (decisions 3 and 10, §"What the compile showed"). Generation had the authored line
 * from the start and `repairStep` did not, so the shape the exemption exists for was the
 * one a repair could not touch: `If {{a}} is "peanuts" then fail …` with `{{a}}` =
 * `peanuts`, where every candidate contains `peanuts` (the entry's own `source` does) and
 * every round's answer was discarded as a leak. Through the real repair round, because
 * the guarded list is assembled inside `repairStep`.
 */
describe('compile — repairing a step that quotes one of its own values', () => {
  const QUOTED_STEP =
    'If {{a}} is "peanuts" then fail the test with error '
    + '"The variable value was peanuts. Expected apples"';
  const QUOTED_MESSAGE = 'The variable value was peanuts. Expected apples';
  const QUOTED_MD = testMd('Peanuts', ['Enter the booking code', QUOTED_STEP], ['a: peanuts']);

  /** The only entry this step HAS: the author's own two literals around a
   *  `step.getVar('a')`, parameterised by the read it probes so a repaired version
   *  is distinguishable from the first one. */
  const quotedEntry = (probe: string): string =>
    entryEnvelope(
      QUOTED_STEP,
      `if (step.getVar('a') === 'peanuts' && await page.locator(${JSON.stringify(probe)}).isVisible()) `
        + `step.fail(${JSON.stringify(QUOTED_MESSAGE)});`,
    );

  /** One replay per round: a clean pass, or a failure at one step. */
  const replayRounds = (
    record: CompileRunOutcome,
    rounds: Array<'pass' | { failAt: number; error: string }>,
  ) => (round: number): CompileRunOutcome => {
    const next = rounds[round - 1];
    if (next === undefined) throw new Error('replayed more times than the test scripted');
    const count = record.steps.length;
    const over = { resolvedParameters: record.resolvedParameters };
    if (next === 'pass') {
      return outcome('passed', Array.from({ length: count }, (_, i) => passed(i + 1, CB)), over);
    }
    const steps: (StepResult | undefined)[] = new Array(count).fill(undefined);
    for (let i = 0; i < next.failAt; i++) {
      steps[i] = passed(i + 1, {
        fromCodeBehind: true,
        ...(i + 1 === next.failAt
          && { status: 'failed' as const, error: next.error, domSnapshot: '<div id="cancelled"></div>' }),
      });
    }
    return outcome('failed', steps, over);
  };

  it('accepts a candidate carrying the literal the author quoted', async () => {
    // The recording is the fixture's own: `{{a}}` resolved to `peanuts`, the
    // condition held, and the step ended the run in the author's words.
    const record = outcome('failed', [passed(1), deliberate(2, QUOTED_MESSAGE)], {
      resolvedParameters: { a: 'peanuts' },
    });
    const { result, events, prompts, written } = await runCompile({
      md: QUOTED_MD,
      name: 'peanuts',
      record,
      responses: [
        entryEnvelope('Enter the booking code'),
        quotedEntry('#cancelled'),
        REVIEW_NOOP,
        quotedEntry('#cancelled-v2'),
      ],
      // Round 1's entry throws instead of failing as written — a code defect, not
      // the step doing its job — so the round repairs it, and round 2 is clean.
      replay: replayRounds(record, [
        { failAt: 2, error: "TypeError: Cannot read properties of null (reading 'isVisible')" },
        'pass',
      ]),
    });

    // Before the authored line reached the repair's guard this was `failed` with
    // `repair failed for step 2: … contains the resolved value of {{a}} …`, and at
    // other round counts an `ai: true` write-off instead.
    expect(result.status).toBe('green');
    expect(result.summary.rounds).toBe(2);
    expect(result.summary.writtenOffAi).toEqual([]);
    expect(result.summary.error).toBeUndefined();
    expect(events.some((e) => e.kind === 'step' && e.phase === 'repair' && e.step === 2)).toBe(true);
    // The repaired entry is in the file, `peanuts` and all.
    const file = await written();
    expect(file).toContain('#cancelled-v2');
    expect(file).toContain("step.getVar('a') === 'peanuts'");
    // And the repair really was the call that produced it.
    expect(prompts[3]).toContain('A generated code-behind entry was replayed and it failed');
  });

  it('still rejects a candidate inlining a value the author did not quote', async () => {
    // The exemption is per VALUE, read off the authored line, and a password is
    // never written into that line — so the guard at the repair site is exactly as
    // strict as it always was, and the compile stops rather than commit the secret.
    const record = outcome(
      'passed',
      // Named, not valued: a post-placeholder recording, which is what lets the
      // accounting vouch for `{{password}}`.
      [{ ...passed(1), turns: [turn([
        { index: 1, action: { action: 'type', selector: '#password', value: '{{password}}' }, durationMs: 5 },
      ])] }],
      { resolvedParameters: { password: 'hunter2-correct-horse' } },
    );
    const { result, stepsPath } = await runCompile({
      md: testMd('Sign in', ['Enter the password {{password}}'], ['password: hunter2-correct-horse']),
      name: 'signin',
      record,
      responses: [
        entryEnvelope(
          'Enter the password {{password}}',
          `await page.locator('#password').fill(String(step.getVar('password')));`,
        ),
        REVIEW_NOOP,
        entryEnvelope(
          'Enter the password {{password}}',
          `await page.locator('#password').fill('hunter2-correct-horse');`,
        ),
      ],
      replay: replayRounds(record, [{ failAt: 1, error: 'locator.fill: Timeout 30000ms exceeded' }]),
    });

    expect(result.status).toBe('failed');
    expect(result.summary.error).toContain('repair failed for step 1');
    expect(result.summary.error).toContain('the resolved value of {{password}}');
    // Nothing reached the author's file.
    await expect(fs.access(stepsPath)).rejects.toThrow();
  });
});

// ── 5. The recording on disk ──

/** Every recording here carries the same stamp and no parameters; `status` is
 *  what the loops computed for the run. */
const manifest = (steps: StepResult[], status: 'passed' | 'failed', source: 'cli' | 'server' = 'cli') =>
  ({ steps, status, startedAt: TURN_AT, parameters: {}, source });

describe('the recording of a tolerated failure', () => {
  it('round-trips the flag and does not make the run failed', async () => {
    const md = path.join(dir, 'booking.md');
    // `passed` is what the loops computed, the tolerated failure already excluded
    // (decision 6).
    await writeRecording(md, manifest([passed(1), tolerated(2), passed(3)], 'passed'));

    const recording = await readRecording(md);
    expect(recording).not.toBeNull();
    expect(recording!.manifest.status).toBe('passed');
    expect(recording!.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'passed']);
    expect(recording!.steps[1]!.tolerated).toBe(true);
    expect(recording!.steps[1]!.error).toBe('the promo banner was not there');
    // A passed step carries no flag at all.
    expect(recording!.steps[0]!.tolerated).toBeUndefined();
  });
});

describe('the recording of a deliberate failure', () => {
  it('is a FAILED recording — honest — and still carries the step as compilable', async () => {
    const md = path.join(dir, 'booking.md');
    // A deliberate failure ends the run red (decision 2), unsoftened here.
    await writeRecording(md, manifest([passed(1), deliberate(2)], 'failed'));

    const recording = await readRecording(md);
    expect(recording!.manifest.status).toBe('failed');
    expect(recording!.steps[1]!.deliberate).toBe(true);
    expect(recording!.steps[1]!.error).toBe(FAIL_MESSAGE);
    expect(recording!.steps[0]!.deliberate).toBeUndefined();
    // The flag tells this recording from one that broke, and the transcript is
    // still there — the point of keeping it.
    expect(recording!.steps[1]!.actions).toEqual([
      { action: 'fail', description: 'the booking shows as cancelled' },
    ]);
  });

  it('keeps the fail action in the transcript, and only for a deliberate step', () => {
    // `actionsOf` drops errored sub-actions — nothing to compile from an action that did
    // not happen. A deliberate `fail` carries an error because the error is its PRODUCT;
    // dropping it leaves an empty transcript and a "performed no page actions" decline.
    expect(actionsOf(deliberate(2))).toEqual([
      { action: 'fail', description: 'the booking shows as cancelled' },
    ]);
    // The same sub-action on a step the runtime did NOT mark deliberate — an
    // unclaimed `fail` the executor refused — stays dropped.
    const refused = { ...deliberate(2) };
    delete (refused as { deliberate?: boolean }).deliberate;
    expect(actionsOf(refused)).toEqual([]);
    // And an ordinary errored sub-action is unaffected in either direction.
    expect(actionsOf(passed(1))).toEqual([
      { action: 'type', selector: '#code', value: '220826' },
    ]);
  });
});

/** A splice recomputes the status from rows of mixed provenance, so it has to
 *  apply the same rule the loops did — and no reader of the manifest refuses a
 *  compile over a red one, because the compile reads the rows. */
describe('a spliced recording', () => {
  it.each([
    {
      label: 'stays green when the spliced step was tolerated',
      spliced: tolerated(2), spliceStatus: 'passed' as const, expected: 'passed', flagged: false,
    },
    {
      label: 'still turns red for an ordinary failure — the narrowness check',
      spliced: { ...tolerated(2), tolerated: false }, spliceStatus: 'failed' as const,
      expected: 'failed', flagged: false,
    },
    {
      label: 'turns red for a deliberate failure, which is not excused here either',
      spliced: deliberate(2), spliceStatus: 'failed' as const, expected: 'failed', flagged: true,
    },
  ])('$label', async ({ spliced, spliceStatus, expected, flagged }) => {
    const md = path.join(dir, 'booking.md');
    await writeRecording(md, manifest([passed(1), passed(2)], 'passed'));
    await spliceRecording(md, manifest([spliced], spliceStatus, 'server'));

    const recording = await readRecording(md);
    expect(recording!.manifest.status).toBe(expected);
    if (flagged) expect(recording!.steps[1]!.deliberate).toBe(true);
  });
});
