import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, BrowserContext, Browser } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { executeStep } from '../src/runner/step-executor.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { buildFileReviewPrompt } from '../src/codebehind/review.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { generationRefusal } from '../src/codebehind/live-compile.js';
import { runCodeBehindEntry, EXIT_NOT_CLAIMED } from '../src/codebehind/execute.js';
import { buildCodeBehindRegistry, type CodeBehindBinding } from '../src/codebehind/loader.js';
import { readRecording, spliceRecording, writeRecording } from '../src/codebehind/recording.js';
import {
  compileTest,
  notRunOnRecordingReason,
  type CompileEvent,
  type CompileRunOutcome,
  type CompileRunner,
} from '../src/codebehind/compile.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * Code-behind for the `If … then return` step form
 * (stories/step-flow-control.md, decisions 11 and 12).
 *
 * Two halves, and they fail in opposite directions if either is wrong:
 *
 *  - **Execution** — `step.exit()` is a PASS that ends the flow, not a throw.
 *    Read as a throw it would be "broken code", so every compiled return would
 *    heal under AI and discard its entry on the first run that took the branch.
 *    The claim guard is the other direction: an entry may only exit on a step
 *    whose markdown says it returns, because the markdown is what a reader
 *    sees.
 *  - **Compile** — a step a return SKIPPED has no transcript, and no transcript
 *    is no evidence. It must not end the usable prefix (the steps after the
 *    returned flow ran and are worth compiling), it must not be generated from
 *    (that writes an `ai: true` entry claiming something nobody tested), and a
 *    replay that returns proves only what it reached.
 */

/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

const noPage = {} as unknown as Page;
const noContext = {} as unknown as BrowserContext;
const noBrowser = {} as unknown as Browser;

let counter = 0;
let dir: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-flow-control');
});

beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

const RETURN_STEP = 'If the page title contains "Dashboard" then return';

/** The claim every runner computes off the authored line before anything else. */
const claimFor = (text: string): NonNullable<ReturnType<typeof parseFlowControlStep>> =>
  parseFlowControlStep(text)!;

// ───────────────────────────────────────────────────────────────────────────
// 1. `step.exit()` — the entry API
// ───────────────────────────────────────────────────────────────────────────

/** A binding with no scope and no file behind it: `runCodeBehindEntry` needs
 *  the entry and the scope, and these tests turn on neither. */
function bareBinding(source: string, run: CodeBehindBinding['entry']): CodeBehindBinding {
  return {
    file: path.join(dir, 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    entry: run,
  };
}

describe('step.exit()', () => {
  it('ends the entry as a PASS carrying flowControl, and runs nothing after it', async () => {
    let after = false;
    const outcome = await runCodeBehindEntry({
      binding: bareBinding(RETURN_STEP, {
        source: RETURN_STEP,
        run({ step }) {
          step.exit();
          // Unreachable: `exit` throws. If it ever stops throwing, this line
          // makes the difference visible instead of leaving a compiled return
          // that also ran the rest of its entry.
          after = true;
        },
      }),
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      flowControlClaim: claimFor(RETURN_STEP),
      label: 'test',
    });

    expect(outcome.status).toBe('passed');
    expect(outcome.flowControl).toEqual({ kind: 'return' });
    expect(outcome.error).toBeUndefined();
    expect(outcome.expectationFailed).toBe(false);
    expect(after).toBe(false);
  });

  it('exits from inside a helper, not only from the entry body', async () => {
    // The reason it is a throw rather than a return value: "nothing after it
    // runs" has to hold from anywhere inside the entry.
    const outcome = await runCodeBehindEntry({
      binding: bareBinding(RETURN_STEP, {
        source: RETURN_STEP,
        run({ step }) {
          const leave = (): never => step.exit();
          [1].forEach(() => leave());
        },
      }),
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      flowControlClaim: claimFor(RETURN_STEP),
      label: 'test',
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.flowControl).toEqual({ kind: 'return' });
  });

  it('leaves an entry that never exits exactly as it was — a passed step with no flowControl', async () => {
    // The `noop` branch: the condition did not hold, so the entry does nothing
    // and the next step runs.
    const outcome = await runCodeBehindEntry({
      binding: bareBinding(RETURN_STEP, { source: RETURN_STEP, run() { /* condition false */ } }),
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      flowControlClaim: claimFor(RETURN_STEP),
      label: 'test',
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.flowControl).toBeUndefined();
  });

  it('fails NON-RETRYABLY, naming the rule, when the step does not claim the form', async () => {
    const outcome = await runCodeBehindEntry({
      binding: bareBinding('Enter the booking code', {
        source: 'Enter the booking code',
        run({ step }) { step.exit(); },
      }),
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      // No `flowControlClaim` — this step's markdown says nothing about
      // returning, so its entry may not end the flow.
      label: 'test',
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.flowControl).toBeUndefined();
    // Non-retryable is the load-bearing half: the entry is not broken, so
    // healing it under AI would spend a turn and discard working code over a
    // rule no re-planning can satisfy. The fix is one line of markdown.
    expect(outcome.nonRetryable).toBe(true);
    expect(outcome.expectationFailed).toBe(false);
    expect(outcome.error).toBe(EXIT_NOT_CLAIMED);
    expect(outcome.error).toContain('does not say to return');
    expect(outcome.error).toContain('"If <condition> then return"');
  });

  it('reports a genuine throw as a failure, not as an exit', async () => {
    const outcome = await runCodeBehindEntry({
      binding: bareBinding(RETURN_STEP, {
        source: RETURN_STEP,
        run() { throw new Error('#title went away in a redesign'); },
      }),
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      flowControlClaim: claimFor(RETURN_STEP),
      label: 'test',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.flowControl).toBeUndefined();
    expect(outcome.nonRetryable).toBeUndefined();
    expect(outcome.error).toContain('redesign');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The runner seam — `runCodeBehindStep`, through the real `executeStep`
// ───────────────────────────────────────────────────────────────────────────

/** Enough `Page` for the executor's bookkeeping, plus a title to read. */
function fakePage(title: string): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/dashboard',
    title: async () => title,
    context: () => ({ browser: () => ({}) }),
    evaluate: async () => { throw new Error('no DOM in this test'); },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

/** An AI client that fails the test if it is called at all — which is how
 *  "the step was not healed" is asserted. */
function forbiddenClient(): AiClient {
  return {
    complete: async () => { throw new Error('the AI must not be called for this step'); },
  } as unknown as AiClient;
}

async function registryFor(testPath: string): Promise<{
  steps: string[];
  bindingFor: (i: number) => CodeBehindBinding;
}> {
  const parsed = await parseTestFile(testPath);
  const registry = await buildCodeBehindRegistry(
    {
      steps: parsed.steps,
      rawSteps: parsed.expansion!.rawSteps,
      origins: parsed.expansion!.origins,
      frames: parsed.expansion!.frames,
    },
    { testFilePath: parsed.filePath, onWarn: () => {} },
  );
  return { steps: parsed.steps, bindingFor: (i) => registry.bindingFor(i)! };
}

const FLOW_TEST_MD = [
  '# Booking',
  '',
  '## Steps',
  '1. Enter the booking code',
  `2. ${RETURN_STEP}`,
].join('\n');

describe('runCodeBehindStep and a compiled return', () => {
  it('maps the exit onto the StepResult, keeps the entry, and never heals', async () => {
    const md = await write('booking.md', FLOW_TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  {
    source: ${JSON.stringify(RETURN_STEP)},
    async run({ page, step }) {
      if ((await page.title()).includes('Dashboard')) step.exit();
      throw new Error('unreachable: step.exit() must end the entry');
    },
  },
]);
`);

    const { steps, bindingFor } = await registryFor(md);
    const binding = bindingFor(1);
    expect(binding.entry).toBeDefined();

    const result = await executeStep(2, steps.length, steps[1]!, {
      page: fakePage('Dashboard — Acme'),
      config: CONFIG,
      aiClient: forbiddenClient(),
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: binding,
      flowControlClaim: claimFor(steps[1]!),
    });

    expect(result.status).toBe('passed');
    expect(result.fromCodeBehind).toBe(true);
    // The verb comes from the CLAIM, not from the outcome: `return` and `stop`
    // are one meaning and only the report echoes which was written.
    expect(result.flowControl).toEqual({ kind: 'return', verb: 'return' });
    // The bare detail, for the loop to prefix with the flow's name — the
    // executor holds no expansion and cannot know whether this was a section
    // or the whole test.
    expect(result.aiExplanation).toBe('via code-behind');
    // Not healed: no stale flag, and the entry is still on the binding. Read as
    // broken code this would be discarded on the first run that returned.
    expect(result.codeBehindStale).toBeUndefined();
    expect(binding.entry).toBeDefined();
    expect(result.turns).toEqual([]);
  });

  it('passes with no flowControl when the condition does not hold', async () => {
    const md = await write('booking.md', FLOW_TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  {
    source: ${JSON.stringify(RETURN_STEP)},
    async run({ page, step }) {
      if ((await page.title()).includes('Dashboard')) step.exit();
    },
  },
]);
`);

    const { steps, bindingFor } = await registryFor(md);
    const result = await executeStep(2, steps.length, steps[1]!, {
      page: fakePage('Sign in — Acme'),
      config: CONFIG,
      aiClient: forbiddenClient(),
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: bindingFor(1),
      flowControlClaim: claimFor(steps[1]!),
    });

    expect(result.status).toBe('passed');
    expect(result.flowControl).toBeUndefined();
    expect(result.aiExplanation).toContain('no AI call');
  });

  it('fails the step, without healing it, when an unclaimed entry calls exit', async () => {
    const md = await write('booking.md', FLOW_TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  {
    source: 'Enter the booking code',
    async run({ step }) { step.exit(); },
  },
]);
`);

    const { steps, bindingFor } = await registryFor(md);
    const binding = bindingFor(0);
    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage('Dashboard — Acme'),
      config: CONFIG,
      aiClient: forbiddenClient(),
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: binding,
      // Step 1's text claims nothing, so the run loop passes no claim.
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe(EXIT_NOT_CLAIMED);
    expect(result.flowControl).toBeUndefined();
    // The AI was never called (the client would have thrown) and the entry was
    // kept: this is a rule the author fixes in markdown, not broken code.
    expect(result.fromCodeBehind).toBe(true);
    expect(binding.entry).toBeDefined();
    expect(result.codeBehindStale).toBeUndefined();

    // The explanation is what the report cell and the Steptix hover show,
    // and it has to name the rule that was broken. This case used to fall into
    // the branch written for `step.filePath` — the only non-retryable failure
    // there was when it was written — and told the author a file could not be
    // resolved, on a step that names no file at all.
    expect(result.aiExplanation).toContain('step.exit()');
    expect(result.aiExplanation).toContain('does not say it returns');
    expect(result.aiExplanation).not.toContain('file');
  });

  it('still blames the FILE when a missing file is what failed', async () => {
    // The control for the assertion above: two different non-retryable facts
    // reach one branch in `runCodeBehindStep`, and separating them must not
    // cost the original its sentence.
    const md = await write('booking.md', FLOW_TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  {
    source: 'Enter the booking code',
    async run({ step }) { step.filePath('no-such-file.pdf'); },
  },
]);
`);

    const { steps, bindingFor } = await registryFor(md);
    const binding = bindingFor(0);
    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage('Booking — Acme'),
      config: CONFIG,
      aiClient: forbiddenClient(),
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: binding,
      uploadPaths: { baseDir: dir, projectRoot: dir },
    });

    expect(result.status).toBe('failed');
    expect(result.aiExplanation).toContain('The file this step names could not be resolved');
    expect(result.aiExplanation).not.toContain('step.exit()');
    expect(binding.entry).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Generation, review and repair prompts
// ───────────────────────────────────────────────────────────────────────────

describe('the generation prompt', () => {
  const RETURN_ACTION = [{ action: 'return' as const, description: 'the title is Dashboard' }];

  it('lists step.exit() and states the rule for a step that claims the form', () => {
    const text = contentBlocksToText(
      buildStepCodePrompt({ rawStepText: RETURN_STEP, parameters: [], actions: RETURN_ACTION }).content,
    );
    expect(text).toContain('`step.exit()` — end the flow this step is in');
    expect(text).toContain('This step is a flow-control step');
    expect(text).toContain("if ((await page.title()).includes('Dashboard')) step.exit();");
    // The trap the rule exists for: a recording shows only the branch this run
    // took, and the entry has to write both.
    expect(text).toContain('a `noop` means it did NOT');
    expect(text).toContain('the entry you write is the same `if` either way');
    expect(text).toContain('needs NO post-condition');
  });

  it('states the rule for a `stop` tail too — one meaning, two verbs', () => {
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'If the page title contains "Dashboard" then stop running the remaining steps',
        parameters: [],
        actions: RETURN_ACTION,
      }).content,
    );
    expect(text).toContain('This step is a flow-control step');
  });

  it('leaves an ordinary step\'s prompt exactly as it was', () => {
    // Both additions are single gated inserts, so "no mention of either" is
    // the whole of "byte-identical to the prompt before this existed".
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click the details link then return',
        parameters: [],
        actions: [{ action: 'click', selector: '#details' }],
      }).content,
    );
    // Not flow control: after an action, "then return" reads as navigate back.
    expect(parseFlowControlStep('Click the details link then return')).toBeNull();
    expect(text).not.toContain('step.exit');
    expect(text).not.toContain('flow-control step');
    // …and the post-condition rule it would have excepted is still there.
    expect(text).toContain('End with a post-condition');
  });
});

describe('the review prompt', () => {
  const FILE = `export default defineSteps([{ source: ${JSON.stringify(RETURN_STEP)} }]);`;

  it('excepts a flow-control entry from the post-condition item', () => {
    const text = buildFileReviewPrompt({
      markdownName: 'booking.md',
      file: FILE,
      steps: ['Enter the booking code', RETURN_STEP],
    }).content as string;
    expect(text).toContain('The one exception is a **flow-control step**');
    expect(text).toContain('`if (…) step.exit();` and nothing else is complete');
  });

  it('says nothing about it for a test with no flow-control step', () => {
    const text = buildFileReviewPrompt({
      markdownName: 'booking.md',
      file: FILE,
      steps: ['Enter the booking code', 'Confirm the booking'],
    }).content as string;
    expect(text).toContain('Every entry ends with a post-condition');
    expect(text).not.toContain('step.exit');
  });
});

describe('the repair prompt', () => {
  it('replaces the post-condition rule for a flow-control step', () => {
    const text = buildRepairPrompt({
      rawStepText: RETURN_STEP,
      stepIndex: 2,
      entryCode: '{ source: "…", async run() {} }',
      error: 'the title read empty',
      parameters: [],
    }).content as string;
    expect(text).toContain('It needs NO post-condition');
    expect(text).not.toContain('5. End with a post-condition');
  });

  it('keeps the ordinary rule for an ordinary step', () => {
    const text = buildRepairPrompt({
      rawStepText: 'Confirm the booking',
      stepIndex: 2,
      entryCode: '{ source: "…", async run() {} }',
      error: 'timed out',
      parameters: [],
    }).content as string;
    expect(text).toContain('5. End with a post-condition');
    expect(text).not.toContain('step.exit');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Compile — the recording, the selection and the proving replay
// ───────────────────────────────────────────────────────────────────────────

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

/** A passed step whose transcript is one ordinary action. */
function passed(index: number, over: Partial<StepResult> = {}): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: '2026-09-09T00:00:00.000Z',
        aiInteractions: [],
        subActions: [
          { index: 1, action: { action: 'type', selector: '#code', value: '220826' }, durationMs: 5 },
        ],
      },
    ],
    durationMs: 10,
    retried: false,
    pageUrl: 'https://app.test/booking',
    stepContext: {
      domBefore: '<input id="code">',
      urlBefore: 'https://app.test/booking',
      domAfter: '<input id="code" value="220826">',
      urlAfter: 'https://app.test/booking',
    },
    ...over,
  };
}

/** The returning step: a `return` sub-action, and `flowControl` on the result. */
function returned(index: number): StepResult {
  return {
    ...passed(index),
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: '2026-09-09T00:00:00.000Z',
        aiInteractions: [],
        subActions: [
          {
            index: 1,
            action: { action: 'return', description: 'the title is Dashboard' },
            durationMs: 2,
          },
        ],
      },
    ],
    flowControl: { kind: 'return', verb: 'return' },
    aiExplanation: 'Ended the run: the title is Dashboard',
  };
}

/** A step a return left unrun, exactly as `skippedByReturn` builds it. */
function skipped(index: number, by: number): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'skipped',
    turns: [],
    durationMs: 0,
    retried: false,
    aiExplanation: `Not run: step ${by} ended the run`,
  };
}

function collect(): { events: CompileEvent[]; onEvent: (e: CompileEvent) => void } {
  const events: CompileEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const generatedSteps = (events: CompileEvent[]): number[] =>
  events
    .filter((e) => e.kind === 'step' && e.phase === 'generate' && e.message === 'generated')
    .map((e) => (e as { step: number }).step);

const THREE_STEP_MD = [
  '# Booking',
  '',
  '## Steps',
  '1. Enter the booking code',
  `2. ${RETURN_STEP}`,
  '3. Confirm the booking',
].join('\n');

describe('compile — a step the recording skipped', () => {
  it('reports it not attempted, and still compiles the steps around it', async () => {
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    // Step 2 returned, so step 3 never ran. Step 3 is inside the prefix all the
    // same: nothing failed, and there is nothing to stop at.
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [passed(1), returned(2), skipped(3, 2)],
      resolvedParameters: {},
      tokensUsed: 500,
    };
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope(RETURN_STEP, `if ((await page.title()).includes('Dashboard')) step.exit();`),
      REVIEW_NOOP,
    ]);
    const { events, onEvent } = collect();
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return record;
      return {
        status: 'passed',
        steps: [passed(1, { fromCodeBehind: true }), returned(2), skipped(3, 2)],
        resolvedParameters: {},
        tokensUsed: 0,
      };
    };

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    // Steps 1 and 2 had transcripts and compiled; step 3 had none.
    expect(generatedSteps(events)).toEqual([1, 2]);
    expect(result.summary.notAttempted).toEqual([3]);
    expect(result.summary.compiled).toBe(2);
    // Not green: step 3 still has no entry, and saying green would read as
    // "already compiled".
    expect(result.status).toBe('partial');
    // The recording did not "stop" — it ran to the end and returned.
    expect(result.summary.stoppedAt).toBeUndefined();
    // The reason is on the step, not only in a total.
    expect(
      events.some(
        (e) =>
          e.kind === 'step'
          && e.step === 3
          && e.message === 'not run on the recording run (step 2 returned)',
      ),
    ).toBe(true);

    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).toContain('step.exit();');
    expect(written).toContain("source: 'Enter the booking code'");
    // No `ai: true` entry for step 3: nothing tested whether it can be code.
    expect(written).not.toContain('Confirm the booking');
  });

  it('says so and writes nothing when every selected step was behind the return', async () => {
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ page }) { await page.locator('#code').waitFor(); } },
  { source: ${JSON.stringify(RETURN_STEP)}, async run({ page, step }) { if ((await page.title()).includes('Dashboard')) step.exit(); } },
]);
`);
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [passed(1, { fromCodeBehind: true }), returned(2), skipped(3, 2)],
      resolvedParameters: {},
      tokensUsed: 0,
    };
    // Only step 3 has no entry, and it was skipped — so there is nothing to
    // generate and no model call to make.
    const { client, prompts } = scriptedClient([]);
    const runner: CompileRunner = async () => record;

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner,
    });

    expect(prompts).toEqual([]);
    expect(result.status).toBe('partial');
    expect(result.summary.compiled).toBe(0);
    expect(result.summary.notAttempted).toEqual([3]);
    expect(result.files).toEqual({});
  });

  it('the summary asserts a return only when one actually happened', async () => {
    // The message says its cause as FACT — "a return ended the flow before
    // them" — so it may only say it when every skipped row agrees. A chain's
    // untaken half reaches this same branch and no return happened.
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    const decided = (index: number): StepResult => ({
      ...skipped(index, 1),
      aiExplanation: 'Skipped: another branch of this decision was taken',
    });
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [decided(1), decided(2), decided(3)],
      resolvedParameters: {},
      tokensUsed: 0,
    };
    const { client } = scriptedClient([]);
    const { events, onEvent } = collect();
    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client,
      runner: async () => record, onEvent,
    });

    expect(result.status).toBe('partial');
    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain('did not run on the recording run — the run decided against them');
    expect(done.message).not.toContain('a return ended the flow');
  });

  it('does not claim a return in the end-of-compile HEADLINE either', async () => {
    // The third place the sentence is written, and the most reachable of the
    // three: the "Nothing to compile" refusal above needs EVERY selected step
    // to have been skipped, while this fires whenever anything was — which is
    // the ordinary chain compile, since the untaken branch is dropped from the
    // selection and everything around it still compiles. It read "a return
    // skipped them on the recording run" over a run in which no return
    // happened, in the same breath as the per-step line said otherwise.
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    const decided = (index: number): StepResult => ({
      ...skipped(index, 1),
      aiExplanation: 'Skipped: another branch of this decision was taken',
    });
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [passed(1), decided(2), passed(3)],
      resolvedParameters: {},
      tokensUsed: 500,
    };
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { events, onEvent } = collect();
    const runner: CompileRunner = async (request) =>
      request.purpose === 'record'
        ? record
        : {
            status: 'passed',
            steps: [
              passed(1, { fromCodeBehind: true }),
              decided(2),
              passed(3, { fromCodeBehind: true }),
            ],
            resolvedParameters: {},
            tokensUsed: 0,
          };

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.summary.notAttempted).toEqual([2]);
    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain(
      'step 2 not attempted on the recording run (the run decided against them)',
    );
    expect(done.message).not.toContain('a return');
    // And the per-step line, which was already right, still agrees with it.
    expect(
      events.some(
        (e) =>
          e.kind === 'step'
          && e.step === 2
          && e.message === 'not run on the recording run (another branch of this decision was taken)',
      ),
    ).toBe(true);
  });

  it('names a return in the headline when one actually happened', async () => {
    // The other side: the clause is read off the rows, so a genuine return
    // still gets the sentence it always had.
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [passed(1), returned(2), skipped(3, 2)],
      resolvedParameters: {},
      tokensUsed: 500,
    };
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope(RETURN_STEP, `if ((await page.title()).includes('Dashboard')) step.exit();`),
      REVIEW_NOOP,
    ]);
    const { events, onEvent } = collect();
    const runner: CompileRunner = async (request) =>
      request.purpose === 'record'
        ? record
        : {
            status: 'passed',
            steps: [passed(1, { fromCodeBehind: true }), returned(2), skipped(3, 2)],
            resolvedParameters: {},
            tokensUsed: 0,
          };

    await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain(
      'step 3 not attempted on the recording run (a return ended the flow before them)',
    );
  });

  it('builds the not-attempted reason from the runner\'s own sentence', () => {
    expect(notRunOnRecordingReason(skipped(5, 3))).toBe(
      'not run on the recording run (step 3 returned)',
    );
    expect(
      notRunOnRecordingReason({ ...skipped(5, 3), aiExplanation: 'Not run: step 2 returned from "Sign in"' }),
    ).toBe('not run on the recording run (step 2 returned)');
    // A recording that carries no reason still reads — and does not quote a
    // number, or a CAUSE, out of unrelated prose. The fallback used to assert
    // "a return ended its flow", which was the wrong sentence for every skip
    // that no return produced.
    expect(notRunOnRecordingReason({ ...skipped(5, 3), aiExplanation: undefined })).toBe(
      'not run on the recording run',
    );
    expect(notRunOnRecordingReason(undefined)).toBe('not run on the recording run');
  });

  it('does not tell a chain author that a return ended their flow', () => {
    // The OTHER producer of a skipped row (stories/control-flow.md). A chain
    // compiles — only loops are refused — so this is reachable on the shape
    // control flow is mostly about, and it read "not run on the recording run
    // (a return ended its flow)" when no return had happened anywhere.
    const decided = (index: number, reason: string): StepResult => ({
      ...skipped(index, 1),
      aiExplanation: reason,
    });
    expect(
      notRunOnRecordingReason(decided(5, 'Skipped: another branch of this decision was taken')),
    ).toBe('not run on the recording run (another branch of this decision was taken)');
    expect(notRunOnRecordingReason(decided(5, 'Skipped: the loop ran no passes'))).toBe(
      'not run on the recording run (the loop ran no passes)',
    );
    expect(notRunOnRecordingReason(decided(5, 'Skipped: the list was empty'))).toBe(
      'not run on the recording run (the list was empty)',
    );
    // Anchored, like the return prefix beside it: a reason that merely
    // mentions the word is quoted whole rather than cut at the colon.
    expect(notRunOnRecordingReason(decided(5, 'The loop was skipped: no passes'))).toBe(
      'not run on the recording run',
    );
    // And a bare label says nothing rather than opening an empty parenthesis.
    expect(notRunOnRecordingReason(decided(5, 'Skipped:'))).toBe('not run on the recording run');
  });
});

describe('compile — a proving replay that returns', () => {
  it('leaves the steps it never reached unproven and ends partial, naming them', async () => {
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    // The recording ran everything: step 2's condition did not hold.
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [passed(1), passed(2), passed(3)],
      resolvedParameters: {},
      tokensUsed: 500,
    };
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope(RETURN_STEP, `if ((await page.title()).includes('Dashboard')) step.exit();`),
      entryEnvelope('Confirm the booking', `await page.locator('#confirmed').waitFor();`),
      REVIEW_NOOP,
    ]);
    // …but on the replay it did: step 3 is skipped, and the run still passes.
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return record;
      return {
        status: 'passed',
        steps: [passed(1, { fromCodeBehind: true }), returned(2), skipped(3, 2)],
        resolvedParameters: {},
        tokensUsed: 0,
      };
    };
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    // All three entries are proposed — the replay found no fault with any of
    // them — but step 3's was never executed, so it is not proven and the
    // compile does not claim the test replays as code.
    expect(result.status).toBe('partial');
    expect(result.summary.compiled).toBe(3);
    expect(result.summary.unproven).toEqual([3]);
    expect(result.summary.writtenOffAi).toEqual([]);
    expect(result.summary.error).toContain('never reached step 3');
    expect(result.summary.error).toContain('Not run: step 2 ended the run');
    // The round's own line does not claim 3/3 passed as code.
    const replayLines = events
      .filter((e) => e.kind === 'phase' && e.phase === 'replay')
      .map((e) => (e as { message: string }).message);
    expect(replayLines.some((m) => m.includes('step 3 not reached'))).toBe(true);
    expect(replayLines.some((m) => m.includes('3/3 passed as code'))).toBe(false);
  });
});

describe('compile — the unconditional form', () => {
  const RETURN_ONLY_MD = [
    '# Booking',
    '',
    '## Steps',
    '1. Enter the booking code',
    '2. Return',
  ].join('\n');

  it('refuses to compile a step the author names explicitly', async () => {
    const md = await write('booking.md', RETURN_ONLY_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = scriptedClient([]);
    const result = await compileTest({
      test,
      config: CONFIG,
      contextContent: '',
      aiClient: client,
      runner: async () => ({ status: 'passed', steps: [], resolvedParameters: {}, tokensUsed: 0 }),
      select: { steps: [2] },
    });

    expect(result.status).toBe('failed');
    expect(result.summary.error).toBe(
      'step 2 cannot be compiled: a Return/Stop/Fail step is dispatched, not compiled',
    );
    expect(prompts).toEqual([]);
  });

  it('passes over it silently in the default selection', async () => {
    const md = await write('booking.md', RETURN_ONLY_MD);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const { events, onEvent } = collect();
    const runner: CompileRunner = async () => ({
      status: 'passed',
      steps: [passed(1), passed(2)],
      resolvedParameters: {},
      tokensUsed: 0,
    });

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    // Step 2 costs no model call at run time, so there is nothing to make
    // cheaper — exactly the rule `Set` established.
    expect(generatedSteps(events)).toEqual([1]);
    expect(result.summary.compiled).toBe(1);
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).not.toContain("source: 'Return'");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Compile-as-you-go, and the recording on disk
// ───────────────────────────────────────────────────────────────────────────

/**
 * The rule `LiveCompiler.offer` applies to a return step, asked of the rule
 * directly.
 *
 * The step a return SKIPPED gets its own sentence, asked the same way in
 * `tests/codebehind-live-compile.test.ts` → "a skipped row carries its cause",
 * beside a decision's. Asked by hand is not enough there: for a while nothing
 * fed that case in production — the Sessions API's skip loop built the results
 * and never offered them, so the branch was unreachable and its unit test
 * passed against a compile that named none of the skipped steps. What
 * actually proves the path is the composition, in
 * `tests/api-server-compile-mode.test.ts` → "compile a run whose section
 * returns", which POSTs a returning run through the real HTTP entry and reads
 * `notAttempted` off the `compile:result` frame.
 */
describe('generationRefusal', () => {
  const binding = (): CodeBehindBinding => ({
    file: path.join(dir, 'booking.steps.ts'),
    source: 'x',
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
  });

  it('refuses the unconditional form, and only that one', () => {
    expect(generationRefusal({ binding: binding(), text: 'Return', status: 'passed' })).toBe(
      'a Return/Stop/Fail step is dispatched, not compiled',
    );
    expect(generationRefusal({ binding: binding(), text: 'Stop here.', status: 'passed' })).toBe(
      'a Return/Stop/Fail step is dispatched, not compiled',
    );
    // The conditional form is the one thing this story ADDS to the compiler.
    expect(generationRefusal({ binding: binding(), text: RETURN_STEP, status: 'passed' })).toBeUndefined();
  });
});

describe('the recording of a skipped step', () => {
  it('round-trips the skipped status and its reason, outside `error`', async () => {
    // The run's status is not asserted here: the loops compute it and the
    // wholesale write copies it, so reading it back would only echo the input.
    // The splice below is where a recording computes it.
    const md = path.join(dir, 'booking.md');
    await writeRecording(md, {
      steps: [passed(1), returned(2), skipped(3, 2)],
      status: 'passed',
      startedAt: '2026-09-09T00:00:00.000Z',
      parameters: {},
      source: 'cli',
    });

    const recording = await readRecording(md);
    expect(recording).not.toBeNull();
    expect(recording!.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'skipped']);
    // `error` cannot carry the reason: a skipped step did not fail, and every
    // reader of `error` renders it as one.
    expect(recording!.steps[2]!.skipReason).toBe('Not run: step 2 ended the run');
    expect(recording!.steps[2]!.error).toBeUndefined();
    // A passed step carries no reason at all.
    expect(recording!.steps[0]!.skipReason).toBeUndefined();
  });

  it('does not turn a spliced recording red because one step was skipped', async () => {
    const md = path.join(dir, 'booking.md');
    await writeRecording(md, {
      steps: [passed(1), passed(2)],
      status: 'passed',
      startedAt: '2026-09-09T00:00:00.000Z',
      parameters: {},
      source: 'cli',
    });
    await spliceRecording(md, {
      steps: [skipped(2, 1)],
      status: 'passed',
      startedAt: '2026-09-09T00:00:00.000Z',
      parameters: {},
      source: 'server',
    });

    const recording = await readRecording(md);
    // A return ends its flow as a PASS, and the run status is unchanged by it.
    expect(recording!.manifest.status).toBe('passed');
  });
});
