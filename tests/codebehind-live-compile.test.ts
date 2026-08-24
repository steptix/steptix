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
    for (const text of ['[skill: sign in]', '[tool: seedOrder]', '  [SKILL: x]']) {
      expect(generationRefusal({ text, status: 'passed', binding: binding(text) })).toMatch(
        /expanded or dispatched/,
      );
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
    events?: LiveCompileStepEvent[];
    notes?: string[];
  } = {},
): LiveCompiler {
  const events = options.events ?? [];
  const notes = options.notes ?? [];
  return new LiveCompiler({
    mode: options.mode ?? 'run',
    testFilePath: testFile,
    aiClient: options.client ?? fakeClient().client,
    contextContent: '',
    testName: 'checkout.md',
    plan: steps.map((text) => ({ text, inScope: true })),
    sourceLines: steps.map((_, i) => 10 + i),
    ...(options.signal && { signal: options.signal }),
    emit: (event) => events.push(event),
    note: (message) => notes.push(message),
  });
}

describe('the trailing generation queue', () => {
  it('generates an entry per eligible step and proposes one file', async () => {
    const events: LiveCompileStepEvent[] = [];
    const compiler = compilerFor(['Sign in', 'Add to cart'], { events });

    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    compiler.offer({ index: 1, binding: binding('Add to cart'), result: result(2, 'Add to cart'), resolvedParameters: {} });

    const outcome = await compiler.finish({ tokensUsed: 120 });

    expect(events.filter((e) => e.phase === 'generate').map((e) => [e.step, e.line, e.message])).toEqual([
      [1, 10, 'generated'],
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
    const events: LiveCompileStepEvent[] = [];
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

  it('never writes the .steps.ts — only the gitignored candidate beside it', async () => {
    const compiler = compilerFor(['Sign in']);
    compiler.offer({ index: 0, binding: binding('Sign in'), result: result(1, 'Sign in'), resolvedParameters: {} });
    await compiler.finish({ tokensUsed: 0 });

    await expect(fs.access(stepsFile)).rejects.toThrow();
    const candidate = path.join(dir, '.aiui-codebehind-cache', 'checkout.steps.ts.candidate');
    expect(await fs.readFile(candidate, 'utf-8')).toContain("source: 'Sign in'");
  });
});
