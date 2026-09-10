import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiClient } from '../src/ai/client.js';
import type { StepResult } from '../src/report/types.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import {
  generationRefusal,
  LiveCompiler,
  type LiveCompileEvent,
  type LiveCompileProgressEvent,
  type LiveCompileStepEvent,
} from '../src/codebehind/live-compile.js';

/**
 * Compiling as the run goes (stories/compile-as-you-go.md), at the unit the
 * run loop calls: which steps are offered to the model, in what order, and
 * what the run gets back when one of them fails.
 *
 * The rules under test are the ones a seam test cannot see cheaply — the
 * eligibility table, the serialization that lets entry k reuse a helper entry
 * k−1 introduced, and the invariant that a run must never fail over its own
 * bookkeeping.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-live-compile');
let counter = 0;
let dir: string;
let testFile: string;
let stepsFile: string;

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
  testFile = path.join(dir, 'checkout.md');
  stepsFile = path.join(dir, 'checkout.steps.ts');
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

function binding(source: string, over: Partial<CodeBehindBinding> = {}): CodeBehindBinding {
  return {
    file: stepsFile,
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...over,
  };
}

function result(index: number, instruction: string, over: Partial<StepResult> = {}): StepResult {
  return {
    index,
    instruction,
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: '2026-08-24T00:00:00.000Z',
        aiInteractions: [],
        subActions: [{ index: 1, action: { action: 'click', selector: '#go' }, durationMs: 1 }],
      },
    ],
    durationMs: 4,
    retried: false,
    stepContext: { domBefore: '<b>before</b>', domAfter: '<b>after</b>' },
    ...over,
  };
}

describe('which steps a compile-mode run generates from', () => {
  const passed = { text: 'Sign in', status: 'passed' as const };

  it('takes a step that passed under AI with a binding and no entry', () => {
    expect(generationRefusal({ ...passed, binding: binding('Sign in') })).toBeUndefined();
  });

  it('skips a step that ran as code — its code already is the answer', () => {
    expect(
      generationRefusal({
        ...passed,
        binding: binding('Sign in', { entry: { source: 'Sign in', run: async () => {} } }),
        fromCodeBehind: true,
      }),
    ).toBe('the step ran as code');
  });

  it('takes a step whose entry threw and healed under AI', () => {
    // ⚠ stale: the entry failed, the step passed under AI, and there IS a
    // transcript. This is what the default compile selection exists for.
    expect(
      generationRefusal({
        ...passed,
        binding: binding('Sign in', { entry: { source: 'Sign in', run: async () => {} } }),
        fromCodeBehind: false,
        codeBehindStale: { file: stepsFile, source: 'Sign in', error: 'locator timeout' },
      }),
    ).toBeUndefined();
  });

  it('skips an `ai: true` entry — the author opted out', () => {
    expect(
      generationRefusal({
        ...passed,
        binding: binding('Sign in', { entry: { source: 'Sign in', ai: true } }),
      }),
    ).toBe('the entry is marked `ai: true`');
  });

  it('skips a step that did not pass', () => {
    expect(
      generationRefusal({ text: 'Sign in', status: 'failed', binding: binding('Sign in') }),
    ).toBe('the step did not pass');
  });

  it('skips a step with no binding — there is nowhere to write it', () => {
    expect(generationRefusal({ ...passed, binding: undefined })).toBe(
      'the step has no code-behind file to bind into',
    );
  });

  it('skips a [skill:] or [tool:] call — those are expanded or dispatched, never generated', () => {
    // Both spellings: the colon after the keyword is optional in the
    // invocation grammar, so `[skill sign_in]` is as much a call as
    // `[skill: sign in]`.
    for (const text of [
      '[skill: sign in]',
      '[tool: seedOrder]',
      '[skill sign_in]',
      '[tool seedOrder count=2]',
      // Labelled calls too. These used to slip through — the rule was
      // anchored at `^` while labels are a documented feature — so the
      // compiler paid to generate a Playwright entry for a step that is
      // always dispatched to the tool.
      'Seed the cart [tool: seedOrder items=2]',
      'Log in as admin [skill login role="admin"]',
    ]) {
      expect(generationRefusal({ text, status: 'passed', binding: binding(text) })).toMatch(
        /expanded or dispatched/,
      );
    }
  });

  it('does NOT skip lines the runner treats as prose, however bracket-ish', () => {
    // The rule now asks the real parser, so it agrees with the runner by
    // construction. Each of these is prose to the scanner — an uppercase
    // keyword (the scanner is case-sensitive), a space before the keyword,
    // a non-breaking space separator, or a markdown link — and refusing
    // them told the author "expanded or dispatched", which was false, and
    // left the step permanently ineligible for code-behind.
    for (const text of [
      '  [SKILL: x]',
      '[ skill: x]',
      `[skill${String.fromCharCode(160)}login]`,
      'Read the [tool reference](./ref.md) page',
    ]) {
      expect(
        generationRefusal({ text, status: 'passed', binding: binding(text) }),
        `should not be refused as a call: ${JSON.stringify(text)}`,
      ).toBeUndefined();
    }
    // The other bracket markers DO reach generation, where `refuseReason`
    // declines them with a reason that lands in the file as an `ai: true`
    // entry — a different, deliberate outcome.
    expect(
      generationRefusal({ text: '[output: total]', status: 'passed', binding: binding('[output: total]') }),
    ).toBeUndefined();
  });
});

/** An AI client that answers generation with an entry and review with the
 *  file it was given, and records every prompt. */
function fakeClient(over: { generate?: (prompt: string) => string } = {}): {
  client: AiClient;
  prompts: string[];
} {
  const prompts: string[] = [];
  const client = {
    complete: vi.fn(async (messages: { role: string; content: string }[]) => {
      const last = messages[messages.length - 1]?.content ?? '';
      prompts.push(last);
      if (/Review a generated Playwright code-behind file/.test(last)) {
        const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(last);
        return { text: JSON.stringify({ file: fenced?.[1] ?? 'export default defineSteps([]);\n' }) };
      }
      if (over.generate) return { text: over.generate(last) };
      const source = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(last);
      const text = source?.[1] ? (JSON.parse(source[1]) as string) : 'step';
      return {
        text: JSON.stringify({
          entry: `{ source: ${JSON.stringify(text)}, async run(ctx) { await ctx.page.click('#go'); } }`,
        }),
      };
    }),
  } as unknown as AiClient;
  return { client, prompts };
}

function compilerFor(
  steps: string[],
  options: {
    mode?: 'run' | 'steps';
    client?: AiClient;
    signal?: AbortSignal;
    events?: LiveCompileEvent[];
    notes?: string[];
    /** Indices the framework dispatches — a control line's guard. */
    dispatched?: number[];
  } = {},
): LiveCompiler {
  const events = options.events ?? [];
  const notes = options.notes ?? [];
  const dispatched = new Set(options.dispatched ?? []);
  return new LiveCompiler({
    mode: options.mode ?? 'run',
    testFilePath: testFile,
    aiClient: options.client ?? fakeClient().client,
    contextContent: '',
    testName: 'checkout.md',
    plan: steps.map((text, i) => ({
      text,
      inScope: !dispatched.has(i),
      ...(dispatched.has(i) && { dispatched: true }),
      line: 10 + i,
    })),
    ...(options.signal && { signal: options.signal }),
    emit: (event) => events.push(event),
    note: (message) => notes.push(message),
  });
}

describe('the trailing generation queue', () => {
  it('generates an entry per eligible step and proposes one file', async () => {
    const events: LiveCompileEvent[] = [];
    const compiler = compilerFor(['Sign in', 'Add to cart'], { events });

    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });

    const outcome = await compiler.finish({ tokensUsed: 120 });

    // A start frame BEFORE each model call and the completion frame after
    // (stories/compile-tail-progress.md): the gap between the two is the
    // silence the tail used to be.
    const stepFrames = events.filter(
      (e): e is LiveCompileStepEvent => e.type === 'compile:step' && e.phase === 'generate',
    );
    expect(stepFrames.map((e) => [e.step, e.line, e.message])).toEqual([
      [1, 10, 'generating…'],
      [1, 10, 'generated'],
      [2, 11, 'generating…'],
      [2, 11, 'generated'],
    ]);
    expect(Object.keys(outcome.files)).toEqual([stepsFile]);
    expect(outcome.files[stepsFile]).toContain("source: 'Sign in'");
    expect(outcome.files[stepsFile]).toContain("source: 'Add to cart'");
    expect(outcome.summary).toMatchObject({
      compiled: 2,
      rounds: 0,
      // Born unproven: there is no Replay, and the next run is the proof.
      unproven: [1, 2],
      writtenOffAi: [],
      written: [],
      tokensUsed: 120,
    });
    expect(outcome.status).toBe('partial');
  });

  it('is serialized in step order, so entry k sees the candidate entry k−1 wrote', async () => {
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Sign in', 'Add to cart'], { client });

    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });
    await compiler.finish({ tokensUsed: 0 });

    const generatePrompts = prompts.filter((p) => !/Review a generated/.test(p));
    expect(generatePrompts).toHaveLength(2);
    // The second prompt carries the first entry — which is the whole reason
    // the queue is one-at-a-time rather than parallel.
    expect(generatePrompts[0]).not.toContain("source: 'Sign in',");
    expect(generatePrompts[1]).toContain("source: 'Sign in'");
  });

  it('a generation error does not stop anything — the step stays AI and the rest are proposed', async () => {
    const notes: string[] = [];
    const events: LiveCompileEvent[] = [];
    const { client } = fakeClient({
      generate: (prompt) => {
        if (/source:\s*"Add to cart"/.test(prompt)) throw new Error('model exploded');
        const source = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(prompt);
        const text = source?.[1] ? (JSON.parse(source[1]) as string) : 'step';
        return JSON.stringify({ entry: `{ source: ${JSON.stringify(text)}, async run() {} }` });
      },
    });
    const compiler = compilerFor(['Sign in', 'Add to cart', 'Check out'], { client, events, notes });

    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });
    compiler.offer({ index: 2, binding: binding('Check out'), result: result(3, 'Check out'), resolvedParameters: {} });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.summary.compiled).toBe(2);
    expect(outcome.summary.error).toMatch(/1 step\(s\) could not be generated/);
    expect(notes.join('\n')).toMatch(/generation failed for step 2: model exploded/i);
    // NO entry for the failed step — not even an `ai: true` one, which would
    // make the next compile's default selection skip it.
    expect(outcome.files[stepsFile]).not.toContain("source: 'Add to cart'");
    expect(outcome.files[stepsFile]).toContain("source: 'Check out'");
  });

  it('a link that throws does not poison the rest of the queue', async () => {
    // `.then` on a rejected promise is skipped, so one unexpected throw would
    // otherwise lose every later step silently.
    const notes: string[] = [];
    const { client } = fakeClient({
      generate: (prompt) => {
        if (/source:\s*"Add to cart"/.test(prompt)) throw new Error('boom');
        const source = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(prompt);
        const text = source?.[1] ? (JSON.parse(source[1]) as string) : 'step';
        return JSON.stringify({ entry: `{ source: ${JSON.stringify(text)}, async run() {} }` });
      },
    });
    const compiler = compilerFor(['Sign in', 'Add to cart', 'Check out'], { client, notes });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });
    compiler.offer({ index: 2, binding: binding('Check out'), result: result(3, 'Check out'), resolvedParameters: {} });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.summary.compiled).toBe(2);
    expect(outcome.files[stepsFile]).toContain("source: 'Check out'");
  });

  it('a decline becomes an `ai: true` entry carrying the reason', async () => {
    const { client } = fakeClient({
      generate: () => JSON.stringify({ entry: null, reason: 'needs a human to read the screen' }),
    });
    const compiler = compilerFor(['Sign in'], { client });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.summary.compiled).toBe(0);
    expect(outcome.summary.keptAi).toBe(1);
    expect(outcome.files[stepsFile]).toContain('ai: true');
    expect(outcome.files[stepsFile]).toContain('needs a human to read the screen');
  });

  it('reviews the whole file on the Run & Compile path and never on the single-step one', async () => {
    for (const mode of ['run', 'steps'] as const) {
      const { client, prompts } = fakeClient();
      const compiler = compilerFor(['Sign in'], { mode, client });
      compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
      await compiler.finish({ tokensUsed: 0 });
      const reviewed = prompts.some((p) => /Review a generated Playwright code-behind file/.test(p));
      expect(reviewed, `mode ${mode}`).toBe(mode === 'run');
    }
  });

  it('reports nothing to compile as green, and says so with no files', async () => {
    const compiler = compilerFor(['Sign in']);
    compiler.offer({
      index: 0,
      binding: binding('Sign in', { entry: { source: 'Sign in', run: async () => {} } }),
      result: result(1, 'Sign in', { fromCodeBehind: true }),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.status).toBe('green');
    expect(outcome.files).toEqual({});
    expect(outcome.summary.kept).toBe(1);
    expect(outcome.summary.compiled).toBe(0);
  });

  it('carries the run\'s stopping point and what it never reached into the summary', async () => {
    const compiler = compilerFor(['Sign in', 'Add to cart', 'Check out']);
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    const outcome = await compiler.finish({
      tokensUsed: 0,
      stoppedAt: { step: 2, error: '"Add to cart" button not found' },
      notAttempted: [3],
    });

    expect(outcome.summary.stoppedAt).toEqual({ step: 2, error: '"Add to cart" button not found' });
    expect(outcome.summary.notAttempted).toEqual([3]);
    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.status).toBe('partial');
  });

  it('a stop skips generations that have not started, and names them as not attempted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const { client } = fakeClient({
      generate: (prompt) => {
        calls += 1;
        // The first generation is in flight when the stop lands; it finishes,
        // because its model call is already paid for.
        controller.abort();
        const source = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(prompt);
        const text = source?.[1] ? (JSON.parse(source[1]) as string) : 'step';
        return JSON.stringify({ entry: `{ source: ${JSON.stringify(text)}, async run() {} }` });
      },
    });
    const compiler = compilerFor(['Sign in', 'Add to cart'], { client, signal: controller.signal });

    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });
    const outcome = await compiler.finish({ tokensUsed: 0, aborted: true });

    expect(calls).toBe(1);
    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.summary.notAttempted).toEqual([2]);
    // What did generate is still proposed: a stop composes the way "write
    // what passed" already composes.
    expect(outcome.files[stepsFile]).toContain("source: 'Sign in'");
  });

  it('carries one candidate and one numbering across a split run\'s blocks', async () => {
    // A logical run is several requests whenever an `[input:]` step or a
    // breakpoint splits it. The compiler is retained on the session, so block
    // 2's entries join block 1's rather than starting a fresh file, and its
    // steps keep the RUN's numbers rather than restarting at 1.
    const events: LiveCompileEvent[] = [];
    const compiler = compilerFor(['Sign in', 'Add to cart'], { events });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    const first = await compiler.finish({ tokensUsed: 10 });
    expect(first.summary.compiled).toBe(1);

    // …and now block 2, as the server hands it over.
    compiler.beginBlock([{ text: 'Check out', inScope: true, line: 20 }]);
    compiler.offer({ index: 0, binding: binding('Check out'), result: result(1, 'Check out'), resolvedParameters: {} });
    const second = await compiler.finish({ tokensUsed: 20 });

    // Block 2's step is step 3 of the run, on ITS line — not step 1 on line 10.
    const generated = events
      .filter((e) => e.type === 'compile:step' && e.message === 'generated')
      .map((e) => [e.step, e.line]);
    expect(generated).toEqual([[1, 10], [3, 20]]);
    // One file, both entries: block 2 did not start from the unapplied file.
    expect(second.summary.compiled).toBe(2);
    expect(second.files[stepsFile]).toContain("source: 'Sign in'");
    expect(second.files[stepsFile]).toContain("source: 'Check out'");
    expect(second.summary.totalSteps).toBe(3);
    expect(second.summary.unproven).toEqual([1, 3]);
  });

  it('a dispatched guard is not in the compile`s denominator', async () => {
    // A chain's guards are performed by the framework, not by the model, so
    // there is no transcript to write from and no entry a compile could ever
    // produce for one. Counting them made a two-branch chain report "2 of 4"
    // for a test with exactly two compilable steps in it
    // (stories/control-flow.md, decision 12).
    const compiler = compilerFor(
      [
        'If cash, then Pay with cash',
        'Click Pay now',
        'Otherwise, Pay by card',
        'Enter the card details',
      ],
      { dispatched: [0, 2] },
    );
    compiler.offer({
      index: 1,
      binding: binding('Click Pay now'),
      result: result(2, 'Click Pay now'),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });
    expect(outcome.summary.totalSteps).toBe(2);
    expect(outcome.summary.compiled).toBe(1);
  });

  it('and a slice counts only the compilable steps inside it', async () => {
    const compiler = compilerFor(
      ['Sign in', 'If cash, then Pay with cash', 'Click Pay now', 'Sign out'],
      { dispatched: [1] },
    );
    compiler.setSlice(1, 2);
    compiler.offer({
      index: 2,
      binding: binding('Click Pay now'),
      result: result(3, 'Click Pay now'),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });
    // Two steps in the slice, one of them dispatched.
    expect(outcome.summary.totalSteps).toBe(1);
  });

  it('but a step that merely already HAS an entry still counts', async () => {
    // `inScope: false` says both "dispatched" and "already written", and only
    // the first is out of the denominator — the second is exactly a step this
    // compile is about and chose not to redo.
    const compiler = compilerFor(['Sign in', 'Click Pay now']);
    compiler.setSlice(1, 1);
    compiler.offer({
      index: 1,
      binding: binding('Click Pay now'),
      result: result(2, 'Click Pay now'),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });
    expect(outcome.summary.totalSteps).toBe(1);
  });

  it('re-reviews only what a later block changed', async () => {
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Sign in'], { client });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    await compiler.finish({ tokensUsed: 0 });
    const afterFirst = prompts.filter((p) => /Review a generated/.test(p)).length;
    expect(afterFirst).toBe(1);

    // A block that generates nothing leaves the file untouched — and the
    // reviewer, which is a whole-file model call, is not asked again.
    compiler.beginBlock([{ text: 'Read the total', inScope: false, line: 20 }]);
    await compiler.finish({ tokensUsed: 0 });
    expect(prompts.filter((p) => /Review a generated/.test(p)).length).toBe(afterFirst);
  });

  it('dispose abandons the queue without proposing anything', async () => {
    // The run threw. The queue is still spending model calls with nobody left
    // to receive the answer.
    let calls = 0;
    const { client } = fakeClient({
      generate: (prompt) => {
        calls += 1;
        const source = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(prompt);
        const text = source?.[1] ? (JSON.parse(source[1]) as string) : 'step';
        return JSON.stringify({ entry: `{ source: ${JSON.stringify(text)}, async run() {} }` });
      },
    });
    const compiler = compilerFor(['Sign in', 'Add to cart', 'Check out'], { client });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });
    compiler.offer({ index: 2, binding: binding('Check out'), result: result(3, 'Check out'), resolvedParameters: {} });
    await compiler.dispose();

    // The in-flight call finishes — it is already paid for — and nothing else
    // starts. Certainly not all three.
    expect(calls).toBeLessThan(3);
    await expect(fs.access(stepsFile)).rejects.toThrow();
  });

  it('never writes the .steps.ts — only the gitignored candidate beside it', async () => {
    const compiler = compilerFor(['Sign in']);
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    await compiler.finish({ tokensUsed: 0 });

    await expect(fs.access(stepsFile)).rejects.toThrow();
    const candidate = path.join(dir, '.aiui-codebehind-cache', 'checkout.steps.ts.candidate');
    expect(await fs.readFile(candidate, 'utf-8')).toContain("source: 'Sign in'");
  });
});

describe('a step healing a broken entry', () => {
  /** The entry the runtime loaded and that threw, as it sits in the file. */
  const BROKEN = [
    "import { defineSteps } from 'ai-ui-automation/codebehind';",
    'export default defineSteps([',
    "  { source: 'Sign in', async run(ctx) { await ctx.page.click('a[href=\"/login\"]'); } },",
    ']);',
    '',
  ].join('\n');

  it('regenerates through the repair prompt, showing the model the code and the error', async () => {
    // The parity the boxed pipeline always had. Without it the plain prompt
    // sees the same page and writes the same broken selector — which is what
    // happened live: `a[href="/login"]` resolved to 2 elements.
    await fs.writeFile(stepsFile, BROKEN, 'utf-8');
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Sign in'], { client });
    compiler.offer({
      index: 0,
      binding: binding('Sign in', { entry: { source: 'Sign in', run: async () => {} } }),
      result: result(1, 'Sign in', {
        codeBehindStale: {
          file: stepsFile,
          source: 'Sign in',
          error: 'strict mode violation: locator resolved to 2 elements',
        },
      }),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    const asked = prompts.filter((p) => !/Review a generated/.test(p));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('A generated code-behind entry was replayed and it failed');
    expect(asked[0]).toContain('strict mode violation: locator resolved to 2 elements');
    // The code that failed, verbatim from the author's file — not a rebuilt
    // approximation of it.
    expect(asked[0]).toContain("ctx.page.click('a[href=\"/login\"]')");
    expect(outcome.summary.compiled).toBe(1);
  });

  it('a step that is NOT stale still uses the plain generation prompt', async () => {
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Sign in'], { client });
    compiler.offer({
      index: 0,
      binding: binding('Sign in'),
      result: result(1, 'Sign in'),
      resolvedParameters: {},
    });
    await compiler.finish({ tokensUsed: 0 });

    const asked = prompts.filter((p) => !/Review a generated/.test(p));
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('A generated code-behind entry was replayed');
    expect(asked[0]).toContain('## The whole test');
  });

  it('falls back to plain generation when the failed entry cannot be found', async () => {
    // The author edited the step text, so nothing in the file binds to it any
    // more. There is nothing to repair FROM; generating is still right.
    await fs.writeFile(stepsFile, "export default defineSteps([]);\n", 'utf-8');
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Sign in'], { client });
    compiler.offer({
      index: 0,
      binding: binding('Sign in'),
      result: result(1, 'Sign in', {
        codeBehindStale: { file: stepsFile, source: 'Sign in', error: 'boom' },
      }),
      resolvedParameters: {},
    });
    await compiler.finish({ tokensUsed: 0 });

    const asked = prompts.filter((p) => !/Review a generated/.test(p));
    expect(asked[0]).not.toContain('A generated code-behind entry was replayed');
  });
});

/**
 * The tail's own progress (stories/compile-tail-progress.md).
 *
 * The numbers are the contract: a client draws a determinate bar off them and
 * must never derive one by matching the prose the compiler also emits. So what
 * is pinned here is the arithmetic — that `done` and `total` agree with the
 * summary the same compile ends with, on the ordinary path and on the paths
 * where an entry ends without an outcome.
 */
describe('the tail reports its progress', () => {
  const progress = (events: LiveCompileEvent[]): LiveCompileProgressEvent[] =>
    events.filter((e): e is LiveCompileProgressEvent => e.type === 'compile:progress');

  it('forecasts at run end: the final total, and that a review pass follows', () => {
    const events: LiveCompileEvent[] = [];
    const notes: string[] = [];
    const compiler = compilerFor(['Sign in', 'Add to cart'], { events, notes });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });

    // The run's last step has just ended; nothing has been generated yet.
    compiler.runStepsEnded();

    const forecast = progress(events).filter((e) => e.runEnded === true);
    expect(forecast).toHaveLength(1);
    expect(forecast[0]).toMatchObject({ done: 0, total: 2, phase: 'generate', reviewPending: true });
    expect(notes).toEqual(['Run finished — 2 entries still to generate, then a review pass']);
  });

  it('says nothing at run end when there is no tail to wait for', () => {
    const events: LiveCompileEvent[] = [];
    const notes: string[] = [];
    const compiler = compilerFor(['Sign in'], { events, notes });
    // Offered, but ineligible: the step already ran as code, so nothing was
    // enqueued and no Review is owed. "0 entries still to generate" would be
    // noise, and a strip raised on it would spin over an empty queue.
    compiler.offer({
      index: 0,
      binding: binding('Sign in'),
      result: result(1, 'Sign in', { fromCodeBehind: true }),
      resolvedParameters: {},
    });
    compiler.runStepsEnded();
    expect(progress(events)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('a single-step compile forecasts no review pass — that path runs none', () => {
    const events: LiveCompileEvent[] = [];
    const notes: string[] = [];
    const compiler = compilerFor(['Sign in'], { mode: 'steps', events, notes });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.runStepsEnded();

    expect(progress(events)[0]).toMatchObject({ done: 0, total: 1 });
    expect(progress(events)[0]!.reviewPending).toBeUndefined();
    expect(notes).toEqual(['Run finished — 1 entry still to generate']);
  });

  it('counts up to the summary: attempted = generated + kept AI + errored', async () => {
    // One of each terminal outcome, so the arithmetic the acceptance names is
    // exercised end to end rather than on the happy path alone.
    const { client } = fakeClient({
      generate: (prompt) => {
        if (/source:\s*"Add to cart"/.test(prompt)) {
          return JSON.stringify({ entry: null, reason: 'the transcript is not reproducible' });
        }
        if (/source:\s*"Check out"/.test(prompt)) return 'not json and not a fence';
        return JSON.stringify({ entry: `{ source: 'Sign in', async run() {} }` });
      },
    });
    const events: LiveCompileEvent[] = [];
    const compiler = compilerFor(['Sign in', 'Add to cart', 'Check out'], { client, events });
    for (const [i, text] of ['Sign in', 'Add to cart', 'Check out'].entries()) {
      compiler.offer({ index: i, binding: binding(text), result: result(i + 1, text), resolvedParameters: {} });
    }
    compiler.runStepsEnded();
    const outcome = await compiler.finish({ tokensUsed: 0 });

    const generation = progress(events).filter((e) => e.phase === 'generate');
    const last = generation[generation.length - 1]!;
    expect(last.total).toBe(3);
    // One generated, one kept as AI, one errored — every enqueued entry
    // settled, and the bar reached the end.
    expect(last.done).toBe(3);
    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.summary.keptAi).toBe(1);
    expect(outcome.summary.error).toMatch(/could not be generated/);
  });

  it('names the step it is generating right now, and only while generating', async () => {
    const events: LiveCompileEvent[] = [];
    const compiler = compilerFor(['Sign in'], { events });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    await compiler.finish({ tokensUsed: 0 });

    const withStep = progress(events).filter((e) => e.step !== undefined);
    expect(withStep).toHaveLength(1);
    expect(withStep[0]).toMatchObject({ step: 1, line: 10, phase: 'generate' });
    // Review announces itself as a phase, never as a step: it belongs to the
    // file, not to any one entry.
    const review = progress(events).filter((e) => e.phase === 'review');
    expect(review).toHaveLength(1);
    expect(review[0]!.step).toBeUndefined();
  });

  it('a stop still settles what it skipped, so the bar never stalls', async () => {
    const controller = new AbortController();
    const events: LiveCompileEvent[] = [];
    const notes: string[] = [];
    const compiler = compilerFor(['Sign in', 'Add to cart'], { events, notes, signal: controller.signal });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });
    controller.abort();
    compiler.runStepsEnded();
    const outcome = await compiler.finish({ tokensUsed: 0, aborted: true });

    const last = progress(events)[progress(events).length - 1]!;
    expect(last).toMatchObject({ done: 2, total: 2 });
    // A stopped run promises no review pass — an aborted compile runs none —
    // and names what will not be generated rather than what is still coming.
    expect(notes).toEqual([`Run stopped — 2 queued entries will not be generated`]);
    // …and the log names WHICH steps got nothing, since the summary carries
    // only a list a client renders as a count.
    const skipped = events.filter(
      (e) => e.type === 'compile:step' && e.message === 'skipped — the run was stopped',
    );
    expect(skipped.map((e) => e.step)).toEqual([1, 2]);
    // Nothing was generated: both were skipped, and the summary says so.
    expect(outcome.summary.compiled).toBe(0);
    expect(outcome.summary.notAttempted).toEqual([1, 2]);
  });

  it('marks only the run-end frame — the ones during the run are not it', async () => {
    const events: LiveCompileEvent[] = [];
    const compiler = compilerFor(['Sign in'], { events });
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    // In the run's own order. It used to force the drain first and call that
    // "the same ordering from the frames' point of view"; it is not, now that
    // the forecast asks whether a Review is still owed — after `finish` it
    // never is, so the frame this test is about would not be emitted at all.
    expect(progress(events).filter((e) => e.runEnded === true)).toEqual([]);
    compiler.runStepsEnded();
    expect(progress(events).filter((e) => e.runEnded === true)).toHaveLength(1);

    const atRunEnd = progress(events).length;
    await compiler.finish({ tokensUsed: 0 });
    // The drain's own frames — generation, then review — are frames, and none
    // of them is a run-end frame.
    expect(progress(events).length).toBeGreaterThan(atRunEnd);
    expect(progress(events).filter((e) => e.runEnded === true)).toHaveLength(1);
  });

  it('forecasts nothing for a block whose steps were all entries it already wrote', async () => {
    // Row 2 of a data-driven Run & Compile from a client that keeps one
    // session across the rows and sends the later ones with
    // `compileContinues`. tests/api-server-rows-compile.test.ts drives that
    // shape; no shipped client does — TestBench puts the compile fields on the
    // first planned row's batches only and recycles the session between rows,
    // and the server clears a `'steps'` compile off the session after every
    // request, so neither route can continue one compiler across rows. Every
    // step of the block dedupes against an entry block 1 wrote, so the queue
    // is empty AND the candidate is unchanged — `finish` will review nothing.
    // Forecasting "then a review pass" off the instance's `enqueued` announced
    // a pass that never ran.
    const events: LiveCompileEvent[] = [];
    const notes: string[] = [];
    /** The run-end forecast only — `finish` says other things (the
     *  placeholder-compliance line) that are not what this is about. */
    const forecasts = (): string[] => notes.filter((n) => /^Run (finished|stopped)/.test(n));
    const compiler = compilerFor(['Enter {{email}}', 'Submit'], { events, notes });
    for (const [i, text] of ['Enter {{email}}', 'Submit'].entries()) {
      compiler.offer({ index: i, binding: binding(text), result: result(i + 1, text), resolvedParameters: {} });
    }
    compiler.runStepsEnded();
    await compiler.finish({ tokensUsed: 0 });
    expect(forecasts()).toEqual(['Run finished — 2 entries still to generate, then a review pass']);

    const beforeRow2 = events.length;
    notes.length = 0;
    compiler.beginBlock([
      { text: 'Enter {{email}}', inScope: true, line: 10 },
      { text: 'Submit', inScope: true, line: 11 },
    ]);
    for (const [i, text] of ['Enter {{email}}', 'Submit'].entries()) {
      compiler.offer({ index: i, binding: binding(text), result: result(i + 1, text), resolvedParameters: {} });
    }
    compiler.runStepsEnded();
    const second = await compiler.finish({ tokensUsed: 0 });

    expect(forecasts()).toEqual([]);
    expect(progress(events.slice(beforeRow2))).toEqual([]);
    // And the claim the silence rests on: row 2 wrote nothing new.
    expect(second.summary.compiled).toBe(2);
  });
});

/**
 * Finding the failure a repeated entry left behind.
 *
 * The sidecar holds a row per EXECUTED step, so a looped body writes one per
 * iteration; the compile is offered one iteration (an entry serves every row)
 * and asks about occurrence N. Positionally those agree for iteration 1 and
 * nothing else, which is why the rows carry their `occurrence` and the reader
 * matches on it.
 *
 * `'steps'` mode throughout: it is the mode where nothing throws in band, so
 * the sidecar is the only thing that can route a generation through the repair
 * prompt (`priorFailure`).
 */
describe('a looped entry that failed on a later row', () => {
  const BROKEN = [
    "import { defineSteps } from 'ai-ui-automation/codebehind';",
    'export default defineSteps([',
    "  { source: 'Upload {{file}}', async run(ctx) { await ctx.page.click('a[href=\"/x\"]'); } },",
    ']);',
    '',
  ].join('\n');

  /** Rows for ONE identity, in execution order — iteration-major, which is how
   *  a run writes them. */
  async function writeSidecar(
    rows: Array<{ occurrence?: number; stale: boolean; error?: string }>,
  ): Promise<void> {
    await fs.mkdir(path.join(dir, '.aiui-codebehind-cache'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.aiui-codebehind-cache', 'checkout.last-run.json'),
      JSON.stringify({
        test: testFile,
        ranAt: new Date().toISOString(),
        steps: rows.map((row, i) => ({
          index: i + 1,
          source: 'Upload {{file}}',
          file: stepsFile,
          status: 'passed',
          fromCodeBehind: !row.stale,
          ...(row.occurrence !== undefined && { occurrence: row.occurrence }),
          stale: row.stale,
          ...(row.error && { error: row.error }),
        })),
      }),
      'utf-8',
    );
  }

  async function compileFirstIteration(): Promise<string[]> {
    await fs.writeFile(stepsFile, BROKEN, 'utf-8');
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Upload {{file}}'], { mode: 'steps', client });
    compiler.offer({
      index: 0,
      binding: binding('Upload {{file}}', { entry: { source: 'Upload {{file}}', run: async () => {} } }),
      result: result(1, 'Upload a.png'),
      resolvedParameters: {},
    });
    await compiler.finish({ tokensUsed: 0 });
    return prompts.filter((p) => !/Review a generated/.test(p));
  }

  it('repairs from row 3, which is the only row that failed', async () => {
    // The dedupe means only iteration 1 is offered, and iteration 1 passed.
    // Read positionally, that row says "clean" and the step regenerates from
    // scratch — handing the model the same page that produced the selector
    // that broke, with nothing to say it broke.
    await writeSidecar([
      { occurrence: 0, stale: false },
      { occurrence: 0, stale: false },
      { occurrence: 0, stale: true, error: 'strict mode violation: resolved to 2 elements' },
    ]);
    const asked = await compileFirstIteration();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('A generated code-behind entry was replayed and it failed');
    expect(asked[0]).toContain('strict mode violation: resolved to 2 elements');
    expect(asked[0]).toContain("ctx.page.click('a[href=\"/x\"]')");
  });

  it('does not repair occurrence 0 from occurrence 1\'s failure', async () => {
    // A body that says the same thing twice. Both occurrences exist in every
    // iteration, and only the second one broke — so occurrence 0 has nothing
    // to repair, and "any stale row of this identity" would put the wrong
    // step's error in front of the model.
    await writeSidecar([
      { occurrence: 0, stale: false },
      { occurrence: 1, stale: true, error: 'the OTHER step broke' },
      { occurrence: 0, stale: false },
      { occurrence: 1, stale: true, error: 'the OTHER step broke' },
    ]);
    const asked = await compileFirstIteration();

    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('A generated code-behind entry was replayed');
    expect(asked[0]).not.toContain('the OTHER step broke');
  });

  it('reads a sidecar written before the field the way it always did', async () => {
    // No `occurrence` anywhere: the positional match, which is right for
    // iteration 1 — every non-looped test, and every sidecar on disk today.
    await writeSidecar([{ stale: true, error: 'the first row broke' }, { stale: false }]);
    const asked = await compileFirstIteration();

    expect(asked[0]).toContain('A generated code-behind entry was replayed and it failed');
    expect(asked[0]).toContain('the first row broke');
  });

  it('does not fall back positionally when the rows DO carry occurrences', async () => {
    // The narrow case the pre-`occurrence` fallback also caught, wrongly: the
    // body gained a second identically-worded line and was COMPILED (a compile
    // writes entries and no sidecar) without being re-run since. Occurrence 1
    // therefore has an entry in the file and no row in the sidecar — and the
    // positional read `same[1]` is the second ITERATION's occurrence-0 row, so
    // the second line would be repaired from the first line's failure.
    await fs.writeFile(
      stepsFile,
      [
        "import { defineSteps } from 'ai-ui-automation/codebehind';",
        'export default defineSteps([',
        "  { source: 'Upload {{file}}', async run(ctx) { await ctx.page.click('#first'); } },",
        "  { source: 'Upload {{file}}', async run(ctx) { await ctx.page.click('#second'); } },",
        ']);',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeSidecar([
      { occurrence: 0, stale: true, error: 'the FIRST line broke' },
      { occurrence: 0, stale: true, error: 'the FIRST line broke' },
    ]);
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Upload {{file}}', 'Upload {{file}}'], { mode: 'steps', client });
    compiler.offer({
      index: 1,
      binding: binding('Upload {{file}}', {
        occurrence: 1,
        entry: { source: 'Upload {{file}}', run: async () => {} },
      }),
      result: result(2, 'Upload b.png'),
      resolvedParameters: {},
    });
    await compiler.finish({ tokensUsed: 0 });

    const asked = prompts.filter((p) => !/Review a generated/.test(p));
    expect(asked).toHaveLength(1);
    // No row for this occurrence means no prior failure — generate from
    // scratch, rather than repair the second line from the first's error.
    expect(asked[0]).not.toContain('A generated code-behind entry was replayed');
    expect(asked[0]).not.toContain('the FIRST line broke');
  });
});

/**
 * "Kept" means the entry stands as it is (stories/compile-as-you-go.md's
 * summary line, and the boxed pipeline's `keptExistingFor`).
 *
 * A looped body makes the question ambiguous for the first time: one entry,
 * offered once per iteration, and the iterations need not agree about it. The
 * rule is the boxed one — a key the compile generates is not kept, whatever
 * any other iteration of it did — and the two facts arrive in either order.
 */
describe('what a repeated entry counts as', () => {
  const withEntry = (source: string): CodeBehindBinding =>
    binding(source, { entry: { source, run: async () => {} } });

  const ranAsCode = (index: number, instruction: string): Parameters<LiveCompiler['offer']>[0] => ({
    index,
    binding: withEntry('Upload {{file}}'),
    result: result(index + 1, instruction, { fromCodeBehind: true }),
    resolvedParameters: {},
  });

  const healedStale = (index: number, instruction: string): Parameters<LiveCompiler['offer']>[0] => ({
    index,
    binding: withEntry('Upload {{file}}'),
    result: result(index + 1, instruction, {
      fromCodeBehind: false,
      codeBehindStale: { file: stepsFile, source: 'Upload {{file}}', error: 'locator timeout' },
    }),
    resolvedParameters: {},
  });

  it('is not kept when a LATER iteration generated it', async () => {
    // Iteration 1 ran the entry cleanly, iteration 2 hit the row that breaks
    // it. `compiled 1, kept 1` for a single entry counted it twice — the boxed
    // pipeline excludes every step whose key is in the selection and says 0.
    const compiler = compilerFor(['Upload {{file}}', 'Upload {{file}}']);
    compiler.offer(ranAsCode(0, 'Upload a.png'));
    compiler.offer(healedStale(1, 'Upload b.png'));
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.summary.kept).toBe(0);
  });

  it('is not kept when an EARLIER iteration generated it either', async () => {
    // The other order, which is the one a Set could not fix by itself: the key
    // is already taken when the "ran as code" refusal arrives.
    const compiler = compilerFor(['Upload {{file}}', 'Upload {{file}}']);
    compiler.offer(healedStale(0, 'Upload a.png'));
    compiler.offer(ranAsCode(1, 'Upload b.png'));
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.summary.kept).toBe(0);
  });

  it('counts every iteration when NO iteration generated it', async () => {
    // Parity in the other direction, and the reason `kept` counts steps rather
    // than keys: the boxed pipeline's `keptExistingFor` filters `steps`, so a
    // body run twice with a clean entry is 2 there and must be 2 here.
    const compiler = compilerFor(['Upload {{file}}', 'Upload {{file}}']);
    compiler.offer(ranAsCode(0, 'Upload a.png'));
    compiler.offer(ranAsCode(1, 'Upload b.png'));
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.summary.compiled).toBe(0);
    expect(outcome.summary.kept).toBe(2);
  });
});

/**
 * Which iteration of a repeated entry repairs it.
 *
 * The dedupe (`takenKeys`) exists because one entry serves every iteration of a
 * looped body, so the second inlining is the same entry arriving again. Which
 * iteration takes the key is settled by the refusals ABOVE the dedupe rather
 * than by arrival order: a clean code run is refused as "ran as code" and takes
 * none, so the holder is the first iteration whose entry BROKE. Its repair
 * therefore reads that iteration's code, its error and its page together, for
 * one model call.
 *
 * Offering the later breaks as well looks like a way to keep more of the run's
 * evidence and is not: by then the first repair has rewritten the entry, so
 * `askForRepair` would read the NEW code and pair it with what the OLD one
 * threw, and the last and least-informed answer would win — at one model call
 * per row for the common shape, an entry broken identically on every row. The
 * cost of skipping is the narrow case: an iteration that breaks DIFFERENTLY
 * later in the loop contributes nothing.
 *
 * `'run'` mode throughout: it is the only mode where an entry runs at all.
 */
describe('a repeated entry, and which iteration repairs it', () => {
  const BROKEN_FILE = [
    "import { defineSteps } from 'ai-ui-automation/codebehind';",
    'export default defineSteps([',
    "  { source: 'Upload {{file}}', async run(ctx) { await ctx.page.click('a[href=\"/x\"]'); } },",
    ']);',
    '',
  ].join('\n');

  /**
   * A model that always answers with an entry bound to the AUTHORED text.
   *
   * The default fake reads the source out of the prompt's `source: "…"` line,
   * which a REPAIR prompt does not have (it embeds the entry as code, single
   * quotes and all) — so a repair's answer would come back bound to the
   * fallback text `step`, and the file assertions below would be describing a
   * quirk of the fake rather than the splice.
   */
  const entryEcho = (): { client: AiClient; prompts: string[] } =>
    fakeClient({
      generate: () =>
        JSON.stringify({
          entry:
            "{ source: 'Upload {{file}}', async run(ctx) { " +
            "await ctx.page.getByRole('button', { name: 'Save' }).click(); } }",
        }),
    });

  /** One iteration of a looped body whose entry threw and healed under AI. */
  const staleIteration = (
    index: number,
    over: { instruction: string; error: string; dom: string },
  ): Parameters<LiveCompiler['offer']>[0] => ({
    index,
    binding: binding('Upload {{file}}', {
      entry: { source: 'Upload {{file}}', run: async () => {} },
    }),
    result: result(index + 1, over.instruction, {
      fromCodeBehind: false,
      codeBehindStale: { file: stepsFile, source: 'Upload {{file}}', error: over.error },
      stepContext: { domBefore: over.dom, domAfter: '<b>after</b>' },
    }),
    resolvedParameters: {},
  });

  it('asks ONCE, and repairs from the first iteration that broke', async () => {
    // The common shape — an ambiguous selector, so the entry breaks the same
    // way on every row. Iteration 1 holds the key and its repair is the
    // well-founded one: the code that ran, the error it threw and the page it
    // threw on, all iteration 1's, for one model call. Asking again for
    // iteration 3 would read the entry iteration 1's repair just WROTE and
    // hand the model the error the old one threw — the least-informed answer
    // winning, at one call per row.
    await fs.writeFile(stepsFile, BROKEN_FILE, 'utf-8');
    const { client, prompts } = entryEcho();
    const compiler = compilerFor(['Upload {{file}}', 'Upload {{file}}'], { client });

    compiler.offer(
      staleIteration(0, {
        instruction: 'Upload a.png',
        error: 'strict mode violation: resolved to 2 elements',
        dom: '<b>row 1 page</b>',
      }),
    );
    compiler.offer(
      staleIteration(1, {
        instruction: 'Upload c.png',
        error: 'strict mode violation: resolved to 2 elements',
        dom: '<b>row 3 page</b>',
      }),
    );
    const outcome = await compiler.finish({ tokensUsed: 0 });

    const asked = prompts.filter((p) => !/Review a generated/.test(p));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('A generated code-behind entry was replayed and it failed');
    expect(asked[0]).toContain('strict mode violation: resolved to 2 elements');
    // The pairing: iteration 1's page, and the entry exactly as it stood on
    // disk — which is the code that actually threw.
    expect(asked[0]).toContain('row 1 page');
    expect(asked[0]).not.toContain('row 3 page');
    expect(asked[0]).toContain("ctx.page.click('a[href=\"/x\"]')");

    const file = outcome.files[stepsFile]!;
    expect([...file.matchAll(/\bsource:/g)]).toHaveLength(1);
    expect(file).toContain("source: 'Upload {{file}}'");
    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.summary.unproven).toEqual([1]);
    expect(outcome.summary.kept).toBe(0);
    expect(outcome.summary.keptAi).toBe(0);
  });

  it('repairs from a LATER iteration when the earlier one ran clean', async () => {
    // The key was free. Iteration 1 ran the entry successfully and is refused
    // as "ran as code" WITHOUT taking it, so the holder is iteration 3 — the
    // first that broke — and the repair is again fully paired, this time with
    // row 3's error and row 3's page.
    await fs.writeFile(stepsFile, BROKEN_FILE, 'utf-8');
    const { client, prompts } = entryEcho();
    const compiler = compilerFor(['Upload {{file}}', 'Upload {{file}}'], { client });

    compiler.offer({
      index: 0,
      binding: binding('Upload {{file}}', {
        entry: { source: 'Upload {{file}}', run: async () => {} },
      }),
      result: result(1, 'Upload a.png', {
        fromCodeBehind: true,
        stepContext: { domBefore: '<b>row 1 page</b>', domAfter: '<b>after</b>' },
      }),
      resolvedParameters: {},
    });
    compiler.offer(
      staleIteration(1, {
        instruction: 'Upload c.png',
        error: 'locator.click: no element matches',
        dom: '<b>row 3 page</b>',
      }),
    );
    const outcome = await compiler.finish({ tokensUsed: 0 });

    const asked = prompts.filter((p) => !/Review a generated/.test(p));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('A generated code-behind entry was replayed and it failed');
    expect(asked[0]).toContain('locator.click: no element matches');
    expect(asked[0]).toContain('row 3 page');
    expect(asked[0]).not.toContain('row 1 page');
    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.summary.unproven).toEqual([2]);
    // And the clean iteration is not `kept`: the compile took its key.
    expect(outcome.summary.kept).toBe(0);
  });

  it('skips a repeat that did NOT break — the entry is the same one again', async () => {
    // The same rule at the same seam, with no entry in play at all: an
    // iteration that ran under AI has nothing the first one did not, and
    // paying for it is one model call per row.
    const { client, prompts } = fakeClient();
    const compiler = compilerFor(['Upload {{file}}', 'Upload {{file}}'], { client });
    for (const [i, instruction] of ['Upload a.png', 'Upload c.png'].entries()) {
      compiler.offer({
        index: i,
        binding: binding('Upload {{file}}'),
        result: result(i + 1, instruction),
        resolvedParameters: {},
      });
    }
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(prompts.filter((p) => !/Review a generated/.test(p))).toHaveLength(1);
    expect(outcome.summary.compiled).toBe(1);
    expect(outcome.summary.unproven).toEqual([1]);
  });
});
