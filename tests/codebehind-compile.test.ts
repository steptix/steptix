import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import type { StepResult } from '../src/report/types.js';
import {
  compileTest,
  outcomeRows,
  reportToOutcome,
  type CompileEvent,
  type CompileRunOutcome,
  type CompileRunRequest,
  type CompileRunner,
} from '../src/codebehind/compile.js';
import { buildCodeBehindRegistry } from '../src/codebehind/loader.js';
import { lastRunPathFor, readLastRun, writeLastRun } from '../src/codebehind/last-run.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * The compile pipeline (stories/codebehind-compile.md, "The compile
 * pipeline"), driven with a stub AI client and a scripted runner.
 *
 * No browser: what is under test is the pipeline's decisions — which steps get
 * generated, what a replay failure does, when an entry becomes `ai: true`, and
 * what reaches disk — and every one of those is decided before a page is
 * touched. The `.steps.ts` files are real, though, because splicing entries
 * into an existing file and esbuild-validating the result is exactly the part
 * that must not be faked.
 */

/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

let counter = 0;
let dir: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-compile');
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

const CONFIG: Config = { ...DEFAULT_CONFIG };

const TEST_MD = [
  '# Booking',
  '',
  '## Steps',
  '1. Enter the booking code',
  '2. Confirm the booking',
].join('\n');

const THREE_STEP_MD = [
  '# Booking',
  '',
  '## Steps',
  '1. Enter the booking code',
  '2. Confirm the booking',
  '3. Read the reference',
].join('\n');

/**
 * A review response that hands the candidate back verbatim.
 *
 * Echoing the prompt's own file is the only way a stub can be a genuine no-op
 * review: the candidate is assembled inside the pipeline, so the test cannot
 * know it in advance, and any fixed string would exercise the *rejection* path
 * instead of the accept-with-no-change one.
 */
const REVIEW_NOOP = '<<review: echo the file back>>';

/** An AI client that answers from a queue and records every prompt. */
function scriptedClient(responses: string[]): {
  client: AiClient;
  prompts: string[];
} {
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

/** `{"entry": "..."}` for a one-liner that fills a field and waits for it. */
function entryEnvelope(source: string, body = `await page.locator('#code').waitFor();`): string {
  return JSON.stringify({
    entry: `{\n  source: ${JSON.stringify(source)},\n  async run({ page, step, log }) {\n    ${body}\n  },\n}`,
  });
}

function stepResult(index: number, over: Partial<StepResult> = {}): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: new Date().toISOString(),
        aiInteractions: [],
        subActions: [
          {
            index: 1,
            action: { action: 'type', selector: '#code', value: '220826' },
            durationMs: 5,
          },
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

function recordOutcome(count: number, over: Record<number, Partial<StepResult>> = {}): CompileRunOutcome {
  return {
    status: 'passed',
    steps: Array.from({ length: count }, (_, i) => stepResult(i + 1, over[i + 1] ?? {})),
    resolvedParameters: {},
    tokensUsed: 1_000,
  };
}

type RunScript = Array<'pass' | { failAt: number; error: string }>;

/** A runner that plays a script: one entry per run the compiler asks for. */
function scriptedRunner(
  totalSteps: number,
  script: RunScript,
  record?: CompileRunOutcome,
): { runner: CompileRunner; requests: CompileRunRequest[] } {
  const requests: CompileRunRequest[] = [];
  const queue = [...script];
  const runner: CompileRunner = async (request) => {
    requests.push(request);
    if (request.purpose === 'record') return record ?? recordOutcome(totalSteps);
    const next = queue.shift();
    if (next === undefined) throw new Error('replayed more times than the test scripted');
    // A prefix replay runs the first N steps; the outcome is sparse past them,
    // and a run that fails stops at the failure.
    const ran = request.throughStep ?? totalSteps;
    const steps: (StepResult | undefined)[] = new Array(totalSteps).fill(undefined);
    if (next === 'pass') {
      for (let i = 0; i < ran; i++) steps[i] = stepResult(i + 1, { fromCodeBehind: true });
      return { status: 'passed', steps, resolvedParameters: {}, tokensUsed: 0 };
    }
    for (let i = 0; i < Math.min(ran, next.failAt); i++) {
      steps[i] = stepResult(i + 1, {
        fromCodeBehind: true,
        ...(i + 1 === next.failAt && {
          status: 'failed' as const,
          error: next.error,
          domSnapshot: '<input id="code">',
          screenshotBase64: 'AAAA',
        }),
      });
    }
    return { status: 'failed', steps, resolvedParameters: {}, tokensUsed: 0 };
  };
  return { runner, requests };
}

function collect(): { events: CompileEvent[]; onEvent: (e: CompileEvent) => void } {
  const events: CompileEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const generatedSteps = (events: CompileEvent[]): number[] =>
  events
    .filter((e) => e.kind === 'step' && e.phase === 'generate' && e.message === 'generated')
    .map((e) => (e as { step: number }).step);

describe('compileTest — the happy path', () => {
  it('records, generates, reviews, replays green, and writes', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking', `await page.locator('#confirmed').waitFor();`),
      REVIEW_NOOP,
    ]);
    const { runner, requests } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    expect(generatedSteps(events)).toEqual([1, 2]);
    // Record captured the page state either side of each step, with
    // code-behind left on — nothing selected has an entry an existing
    // code-behind could hide — and the replay ran the candidate as strict code.
    expect(requests[0]).toMatchObject({ purpose: 'record', strict: false, captureContext: true });
    expect(requests[0]!.disableCodeBehind).toBeUndefined();
    // Each step event names the line the step is on, for a gutter mark.
    expect(events.find((e) => e.kind === 'step' && e.step === 1)).toMatchObject({ line: 4 });
    expect(events.find((e) => e.kind === 'step' && e.step === 2)).toMatchObject({ line: 5 });
    expect(result.summary.unproven).toEqual([]);
    expect(result.summary.writtenOffAi).toEqual([]);
    expect(requests[1]).toMatchObject({ purpose: 'replay', strict: true, round: 1 });
    // …and the replay was pointed at a candidate, never the real file.
    expect(Object.keys(requests[1]!.candidateFiles ?? {})).toEqual([
      path.join(dir, 'booking.steps.ts'),
    ]);

    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).toContain(`source: 'Enter the booking code'`);
    expect(written).toContain(`source: 'Confirm the booking'`);
    expect(written).toContain(`import { defineSteps } from 'steptix/codebehind';`);
    // Formatted as an author would write it, not the model's one line per
    // entry: the entry's fields and its body on their own lines, no line past
    // 100 columns.
    expect(written).toContain(
      [
        '  {',
        "    source: 'Enter the booking code',",
        '    async run({ page, step, log }) {',
        "      await page.locator('#code').waitFor();",
        '    },',
        '  },',
      ].join('\n'),
    );
    expect(written.split('\n').every((line) => line.length <= 100)).toBe(true);
    expect(result.summary.compiled).toBe(2);
    expect(result.summary.written).toEqual([path.join(dir, 'booking.steps.ts')]);
    // The candidate trail survives a green compile: it is the proposal, and it
    // is the file (stories/codebehind-recording-on-disk.md).
    expect(
      await fs.readFile(path.join(dir, '.steptix-codebehind-cache', 'booking.steps.ts.candidate'), 'utf-8'),
    ).toBe(written);
    expect(result.summary.recordingDir).toBe(path.join(dir, '.steptix-codebehind-cache', 'booking.recording'));
    // Step 2's prompt saw the whole test and step 1's entry in the candidate.
    expect(prompts[1]).toContain('## The whole test');
    expect(prompts[1]).toContain('## The code-behind file as it stands');
    expect(prompts[1]).toContain('Enter the booking code');
    // Review announces the file BEFORE its model call — the boxed pipeline
    // inherits that from `reviewCandidate` for free
    // (stories/compile-tail-progress.md), and it is the longest single call
    // this pipeline makes.
    const reviewMessages = events
      .filter((e) => e.kind === 'phase' && e.phase === 'review')
      .map((e) => e.message);
    expect(reviewMessages[0]).toBe('reviewing booking.steps.ts…');
    // Review ran over the assembled file and changed nothing.
    expect(reviewMessages.some((m) => m.startsWith('no changes'))).toBe(true);
    // Tokens: the record run's, plus whatever the prompts cost (0 with a stub).
    expect(result.summary.tokensUsed).toBe(1_000);
  });

  it('gives generation the DOM either side of the step', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { runner } = scriptedRunner(2, ['pass']);
    await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });
    expect(prompts[0]).toContain('<input id="code">');
    expect(prompts[0]).toContain('<input id="code" value="220826">');
  });

  it('writes nothing on --dry-run but still reports the files', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { runner } = scriptedRunner(2, ['pass']);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true,
    });

    expect(result.status).toBe('green');
    expect(result.summary.written).toEqual([]);
    expect(Object.keys(result.files)).toEqual([path.join(dir, 'booking.steps.ts')]);
    await expect(fs.access(path.join(dir, 'booking.steps.ts'))).rejects.toThrow();
  });
});

describe('compileTest — selection', () => {
  const EXISTING = `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  {
    source: 'Enter the booking code',
    async run({ page }) { await page.locator('#code').waitFor(); },
  },
]);
`;

  it('generates only the steps with no entry', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Confirm the booking'), REVIEW_NOOP]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    expect(generatedSteps(events)).toEqual([2]);
    expect(result.summary.kept).toBe(1);
    // The kept entry survived byte-for-byte inside the rewritten file.
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).toContain(`source: 'Enter the booking code',`);
  });

  /** A stale flag as a *supplied* run carries it — "Compile from this run".
   *  Compile's own Record can't produce one: it runs with code-behind off, so
   *  no entry gets the chance to fail. */
  const staleRecord = (): CompileRunOutcome =>
    recordOutcome(2, {
      1: {
        codeBehindStale: {
          file: path.join(dir, 'booking.steps.ts'),
          source: 'Enter the booking code',
          error: '#code went away',
        },
      },
    });

  it('adds a step the supplied run flagged stale to the default selection', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { runner, requests } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
      recorded: staleRecord(),
    });
    expect(generatedSteps(events)).toEqual([1, 2]);
    // The supplied run replaced Record entirely.
    expect(requests.map((r) => r.purpose)).toEqual(['replay']);
  });

  it('--only-stale regenerates just the flagged step', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
      recorded: staleRecord(),
      select: { onlyStale: true },
    });
    expect(result.status).toBe('green');
    expect(generatedSteps(events)).toEqual([1]);
  });

  it('reads stale steps off the last-run sidecar, and clears the flag once written', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    await writeLastRun(md, [
      {
        index: 1,
        source: 'Enter the booking code',
        status: 'passed',
        fromCodeBehind: false,
        stale: true,
        error: '#code went away',
      },
    ]);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
      select: { onlyStale: true },
    });
    expect(generatedSteps(events)).toEqual([1]);
    // Otherwise the next `--only-stale` would regenerate the same step again.
    const after = await readLastRun(md);
    expect(after?.steps[0]?.stale).toBe(false);
    expect(after?.steps[0]?.error).toBeUndefined();
  });

  it('selects a step a keyless run failed on, from the row that run wrote', async () => {
    // The remedy the keyless failure recommends — "recompile or repair this
    // step where AI is available" — is only true if the row a keyless run
    // leaves is selectable here (stories/keyless-replay-and-gateway-env.md
    // §Part B). The row is an ordinary stale row plus `healSkipped`, which
    // exists to keep the heal streak from advancing and must not change what
    // selection sees.
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    await writeLastRun(md, [
      {
        index: 1,
        source: 'Enter the booking code',
        status: 'failed',
        fromCodeBehind: true,
        stale: true,
        error: '#code went away',
        healSkipped: true,
      },
    ]);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
      select: { onlyStale: true },
    });
    expect(generatedSteps(events)).toEqual([1]);
    // And the repair clears both flags, so a second `--only-stale` does not
    // regenerate a step that is now fixed.
    const after = await readLastRun(md);
    expect(after?.steps[0]?.stale).toBe(false);
    expect(after?.steps[0]?.healSkipped).toBeUndefined();
  });

  it('--steps names the steps, and --all takes every eligible one', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    const test = await parseTestFile(md);

    const named = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const a = collect();
    await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: named.client,
      runner: scriptedRunner(2, ['pass']).runner, onEvent: a.onEvent, select: { steps: [1] },
    });
    expect(generatedSteps(a.events)).toEqual([1]);

    const all = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const b = collect();
    await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: all.client,
      runner: scriptedRunner(2, ['pass']).runner, onEvent: b.onEvent, select: { all: true },
    });
    expect(generatedSteps(b.events)).toEqual([1, 2]);
  });

  it('turns code-behind off for Record only when the selection includes a working entry', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { runner, requests } = scriptedRunner(2, ['pass']);

    // --all re-generates step 1's working entry, whose transcript only exists
    // if the entry does not run.
    await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, select: { all: true }, dryRun: true,
    });
    expect(requests[0]).toMatchObject({ purpose: 'record', disableCodeBehind: true });
  });

  it('adds a step whose entry failed during Record to the selection', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', EXISTING);
    const test = await parseTestFile(md);
    // Record (code-behind on) ran step 1's entry, which threw; the step healed
    // under AI and so has a transcript to regenerate from.
    const record = staleRecord();
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code', `await page.locator('#code-v2').waitFor();`),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { runner } = scriptedRunner(2, ['pass'], record);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    expect(generatedSteps(events)).toEqual([1, 2]);
    expect(
      events.some((e) => e.kind === 'step' && e.step === 1 && e.message.includes('joined the selection')),
    ).toBe(true);
    expect(await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8')).toContain('#code-v2');
  });

  it('never compiles over an `ai: true` entry, even with --all', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', ai: true },
]);
`);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Confirm the booking'), REVIEW_NOOP]);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client,
      runner: scriptedRunner(2, ['pass']).runner, onEvent, select: { all: true },
    });
    expect(result.status).toBe('green');
    expect(generatedSteps(events)).toEqual([2]);
    expect(result.summary.keptAi).toBe(1);
  });

  it('is green — and never records — when every step already has code', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ page }) { await page.locator('#a').waitFor(); } },
  { source: 'Confirm the booking', async run({ page }) { await page.locator('#b').waitFor(); } },
]);
`);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([]);
    const { runner, requests } = scriptedRunner(2, []);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner,
    });
    expect(result.status).toBe('green');
    expect(result.summary.compiled).toBe(0);
    expect(result.summary.kept).toBe(2);
    // Never ran anything. Record is a full AI run of the test, and running one
    // to discover there was nothing to compile is the worst way to learn that.
    expect(requests).toEqual([]);
    expect(result.summary.tokensUsed).toBe(0);
  });

  it('refuses a --steps number the test does not have', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: scriptedClient([]).client,
      runner: scriptedRunner(2, []).runner, select: { steps: [7] },
    });
    expect(result.status).toBe('failed');
    expect(result.summary.error).toContain('--steps names step 7');
  });

  // ── Control flow (stories/control-flow.md, decision 12) ──────────────────

  it('compiles a chain: the tails, the If as a condition, never the Otherwise', async () => {
    const md = await write(
      'decide.md',
      [
        '# Decide',
        '',
        '## Steps',
        '1. If the Cash checkbox is ticked, then Confirm the booking',
        '2. Otherwise, Enter the booking code',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    // Four expanded steps: guard, tail, guard, tail. The If held, so its tail
    // ran and the Otherwise's did not — the recording a real run makes. The If
    // is a condition line the model decided, so it compiles too (decision 4);
    // the Otherwise has no condition and stays dispatched.
    const guard = (over: Partial<StepResult>): StepResult => ({
      index: 1, instruction: 'If the Cash checkbox is ticked, then Confirm the booking',
      status: 'passed', turns: [], durationMs: 1, retried: false, ...over,
    });
    const skipped = (index: number): StepResult => ({
      index, instruction: `step ${index}`, status: 'skipped', turns: [], durationMs: 0, retried: false,
      aiExplanation: 'Skipped: another branch of this decision was taken',
    });
    const record: CompileRunOutcome = {
      status: 'passed',
      ...outcomeRows(
        [
          guard({
            guard: {
              decidedBy: 'model',
              selected: 0,
              evidence: { dom: '<input id="cash" checked>', url: 'https://app.test/pay', members: [{ index: 0, holds: true }] },
            },
          }),
          stepResult(2),
          skipped(3),
          skipped(4),
        ],
        4,
      ),
      resolvedParameters: {},
      tokensUsed: 0,
    };
    const replay: CompileRunOutcome = {
      status: 'passed',
      ...outcomeRows(
        [
          guard({ guard: { decidedBy: 'code', selected: 0 }, fromCodeBehind: true }),
          stepResult(2, { fromCodeBehind: true }),
          skipped(3),
          skipped(4),
        ],
        4,
      ),
      resolvedParameters: {},
      tokensUsed: 0,
    };
    const runner: CompileRunner = async (request) => (request.purpose === 'record' ? record : replay);
    const { client } = scriptedClient([
      JSON.stringify({
        entry:
          "{ source: 'If the Cash checkbox is ticked, then Confirm the booking', async condition({ page }) { " +
          "return (await page.locator('#cash:checked').count()) > 0; } }",
      }),
      entryEnvelope('Confirm the booking', `await page.locator('#confirmed').waitFor();`),
      REVIEW_NOOP,
    ]);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    // Partial: the untaken tail never ran, so it has nothing to compile from.
    expect(result.status).toBe('partial');
    expect(result.summary.notAttempted).toEqual([4]);
    // Step 1 — the If's condition — and step 2, its tail. Never the Otherwise.
    expect(generatedSteps(events)).toEqual([1, 2]);
    const written = await fs.readFile(path.join(dir, 'decide.steps.ts'), 'utf-8');
    expect(written).toContain("source: 'If the Cash checkbox is ticked, then Confirm the booking'");
    expect(written).not.toContain('Otherwise');
    expect(result.summary.unproven).toEqual([]);
  });
});

describe('compileTest — replay, repair and the never-converging step', () => {
  it('repairs a failing step from the failure and goes green next round', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
      entryEnvelope('Confirm the booking', `await page.locator('#confirm-v2').waitFor();`),
    ]);
    const { runner } = scriptedRunner(2, [
      { failAt: 2, error: 'locator.click: Timeout 30000ms exceeded' },
      'pass',
    ]);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    expect(result.summary.rounds).toBe(2);
    expect(
      events.some((e) => e.kind === 'step' && e.phase === 'repair' && e.step === 2),
    ).toBe(true);
    // The repair prompt carried the entry, the error, the DOM and a screenshot.
    const repairPrompt = prompts[3]!;
    expect(repairPrompt).toContain('Timeout 30000ms exceeded');
    expect(repairPrompt).toContain('<input id="code">');
    expect(repairPrompt).toContain('A screenshot of the page at the failure is attached');
    expect(await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8')).toContain('#confirm-v2');
  });

  it('writes a step off as `ai: true` after the rounds run out, then confirms the rest', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
      entryEnvelope('Confirm the booking', `await page.locator('#try2').waitFor();`),
    ]);
    // Rounds 1 and 2 fail at step 2; the confirming round (3) passes.
    const { runner, requests } = scriptedRunner(2, [
      { failAt: 2, error: 'still nothing there' },
      { failAt: 2, error: 'still nothing there' },
      'pass',
    ]);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
      maxRounds: 2,
    });

    expect(result.status).toBe('green');
    expect(requests.filter((r) => r.purpose === 'replay')).toHaveLength(3);
    expect(
      events.some((e) => e.kind === 'step' && e.message.startsWith('kept as AI after 2 round')),
    ).toBe(true);
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).toContain('ai: true');
    expect(written).toContain('replay kept failing — still nothing there');
    expect(result.summary.compiled).toBe(1);
    expect(result.summary.keptAi).toBe(1);
  });

  it('stops on a failure in an entry it did not generate, and says how to recompile it', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ page }) { await page.locator('#hand-written').waitFor(); } },
]);
`);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Confirm the booking'), REVIEW_NOOP]);
    const { runner } = scriptedRunner(2, [{ failAt: 1, error: 'the author\'s selector broke' }]);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent, dryRun: true,
    });

    // Partial, not failed: the compiler does not rewrite the author's entry,
    // and it does not throw away step 2's either — that one never ran, and is
    // proposed as unproven code.
    expect(result.status).toBe('partial');
    expect(result.summary.error).toContain('existing entry for step 1 fails');
    expect(result.summary.error).toContain('--steps 1');
    expect(result.summary.unproven).toEqual([2]);
    expect(result.summary.writtenOffAi).toEqual([]);
    const proposed = result.files[path.join(dir, 'booking.steps.ts')]!;
    expect(proposed).toContain('#hand-written');
    expect(proposed).toContain("source: 'Confirm the booking'");
    // And only one replay round: the author's code is not the compiler's to repair.
    expect(result.summary.rounds).toBe(1);
    // Nothing reached disk — dry run — and the author's file is as they left it.
    expect(await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8')).not.toContain('Confirm the booking');
  });

  it('writes what it has when replay never goes green — the failing steps as AI', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
      entryEnvelope('Confirm the booking', `await page.locator('#retry').waitFor();`),
    ]);
    // Rounds 1 and 2 fail at step 2, which is written off; the confirming
    // round then fails at step 1, which gets the same answer — and the rounds
    // are spent, so no further repair.
    const { runner, requests } = scriptedRunner(2, [
      { failAt: 2, error: 'nope' },
      { failAt: 2, error: 'nope' },
      { failAt: 1, error: 'and now step 1 too' },
    ]);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, maxRounds: 2,
    });

    expect(result.status).toBe('partial');
    expect(requests.filter((r) => r.purpose === 'replay')).toHaveLength(3);
    expect(result.summary.writtenOffAi).toEqual([2, 1]);
    expect(result.summary.unproven).toEqual([]);
    expect(result.summary.compiled).toBe(0);
    expect(result.summary.keptAi).toBe(2);
    expect(result.summary.error).toContain('step 1 still fails as code');
    // The CLI path writes the partial file. The candidate trail is the same
    // content, beside the recording — the compile's last proposal.
    expect(result.summary.candidatePath).toBeUndefined();
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written.match(/ai: true/g)).toHaveLength(2);
    expect(written).toContain('replay kept failing — nope');
    expect(written).toContain('replay kept failing — and now step 1 too');
    expect(
      await fs.readFile(path.join(dir, '.steptix-codebehind-cache', 'booking.steps.ts.candidate'), 'utf-8'),
    ).toBe(written);
    // Each failed round left its evidence beside the recording.
    const recordingDir = path.join(dir, '.steptix-codebehind-cache', 'booking.recording');
    expect(result.summary.recordingDir).toBe(recordingDir);
    const failures = (await fs.readdir(recordingDir)).filter((f) => f.endsWith('.failure.json')).sort();
    expect(failures).toEqual(['replay-1.failure.json', 'replay-2.failure.json', 'replay-3.failure.json']);
    expect(JSON.parse(await fs.readFile(path.join(recordingDir, 'replay-1.failure.json'), 'utf-8'))).toMatchObject({
      round: 1, step: 2, line: 5, error: 'nope', files: { screenshot: 'replay-1.failure.png', dom: 'replay-1.failure.html' },
    });
  });

  it('proposes an entry no round reached as unproven code, and keeps its stale flag', async () => {
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    // The sidecar says every step is stale. After the compile: 1 proven
    // (cleared), 2 written off (cleared — it is `ai: true` now), 3 unproven
    // (kept — the next run decides).
    await writeLastRun(md, [
      { index: 1, source: 'Enter the booking code', status: 'passed', fromCodeBehind: false, stale: true },
      { index: 2, source: 'Confirm the booking', status: 'passed', fromCodeBehind: false, stale: true },
      { index: 3, source: 'Read the reference', status: 'passed', fromCodeBehind: false, stale: true },
    ]);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      entryEnvelope('Read the reference', `await page.locator('#ref').waitFor();`),
      REVIEW_NOOP,
    ]);
    // One round, failing at 2: step 2 is written off, and the confirming
    // round fails at 2 again — under AI this time, so the compiler has nothing
    // left to try. Step 3 was never reached.
    const { runner } = scriptedRunner(3, [
      { failAt: 2, error: 'no confirm button' },
      { failAt: 2, error: 'no confirm button' },
    ]);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, maxRounds: 1,
    });

    expect(result.status).toBe('partial');
    expect(result.summary.writtenOffAi).toEqual([2]);
    expect(result.summary.unproven).toEqual([3]);
    expect(result.summary.compiled).toBe(2);
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    // Step 3's entry is real code, not a write-off.
    expect(written).toContain('#ref');
    expect(written.match(/ai: true/g)).toHaveLength(1);
    const sidecar = await readLastRun(md);
    expect(sidecar!.steps.map((s) => [s.index, s.stale])).toEqual([[1, false], [2, false], [3, true]]);
  });

  it('compiles the steps before the failure when the recording run is red', async () => {
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    const record: CompileRunOutcome = {
      status: 'failed',
      steps: [stepResult(1), stepResult(2, { status: 'failed', error: 'the page never loaded' }), undefined],
      resolvedParameters: {},
      tokensUsed: 500,
    };
    const { client, prompts } = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const { runner, requests } = scriptedRunner(3, ['pass'], record);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    // A prefix compile: step 1 has a transcript, steps 2 and 3 do not.
    expect(result.status).toBe('partial');
    expect(generatedSteps(events)).toEqual([1]);
    expect(result.summary.stoppedAt).toEqual({ step: 2, error: 'the page never loaded' });
    expect(result.summary.notAttempted).toEqual([2, 3]);
    expect(result.summary.compiled).toBe(1);
    expect(result.summary.unproven).toEqual([]);
    // The replay ran the prefix, not the whole test.
    expect(requests.find((r) => r.purpose === 'replay')).toMatchObject({ throughStep: 1 });
    // Generation still saw the whole test — it is the context — but only step 1 in scope.
    expect(prompts[0]).toContain('Read the reference');
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).toContain("source: 'Enter the booking code'");
    expect(written).not.toContain('Confirm the booking');
    expect(
      events.some((e) => e.kind === 'phase' && e.phase === 'record' && e.message.includes('stopped at step 2')),
    ).toBe(true);
  });

  it('reports a replay that could not load the candidate as that, not as a step failure', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const requests: CompileRunRequest[] = [];
    const runner: CompileRunner = async (request) => {
      requests.push(request);
      if (request.purpose === 'record') return recordOutcome(2);
      // The strict replay refused before its first step: the file did not load.
      return {
        status: 'failed',
        error: "code-behind file booking.steps.ts could not be loaded: Cannot find package 'steptix'",
        steps: [],
        resolvedParameters: {},
        tokensUsed: 0,
      };
    };

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });

    expect(result.status).toBe('failed');
    expect(result.files).toEqual({});
    expect(result.summary.error).toContain("Cannot find package 'steptix'");
    expect(result.summary.error).toContain('could not be loaded');
    expect(requests.filter((r) => r.purpose === 'replay')).toHaveLength(1);
  });

  it('fails with nothing to compile when the recording stops at step 1', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const record: CompileRunOutcome = {
      status: 'failed',
      steps: [stepResult(1, { status: 'failed', error: 'the page never loaded' }), undefined],
      resolvedParameters: {},
      tokensUsed: 500,
    };
    const { client } = scriptedClient([]);
    const { runner } = scriptedRunner(2, [], record);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner,
    });
    expect(result.status).toBe('failed');
    expect(result.summary.error).toContain('stopped at step 1');
    expect(result.summary.error).toContain('the page never loaded');
    expect(result.summary.stoppedAt).toEqual({ step: 1, error: 'the page never loaded' });
    expect(result.files).toEqual({});
  });

  it('treats a supplied run that stopped early as a prefix, green or not', async () => {
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    // A breakpoint-truncated run: steps 1–2 passed, 3 never ran.
    const recorded: CompileRunOutcome = {
      status: 'passed',
      steps: [stepResult(1), stepResult(2), undefined],
      resolvedParameters: {},
      tokensUsed: 0,
    };
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { runner, requests } = scriptedRunner(3, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, recorded, onEvent, dryRun: true,
    });

    expect(result.status).toBe('partial');
    expect(generatedSteps(events)).toEqual([1, 2]);
    expect(result.summary.stoppedAt).toEqual({ step: 3, error: 'the run stopped before this step' });
    expect(result.summary.notAttempted).toEqual([3]);
    expect(requests.filter((r) => r.purpose === 'record')).toHaveLength(0);
    expect(requests[0]).toMatchObject({ purpose: 'replay', throughStep: 2 });
  });
});

describe('compileTest — declines and review', () => {
  it('turns a decline into an `ai: true` entry carrying the reason', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      JSON.stringify({ entry: null, reason: 'needs the operator to read the confirmation' }),
      entryEnvelope('Confirm the booking'),
      REVIEW_NOOP,
    ]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).toContain('ai: true');
    expect(written).toContain('needs the operator to read the confirmation');
    expect(result.summary.keptAi).toBe(1);
    expect(result.summary.compiled).toBe(1);
    expect(
      events.some((e) => e.kind === 'step' && e.message.startsWith('kept as AI:')),
    ).toBe(true);
  });

  it('applies a review revision that compiles', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const revised = `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: "Enter the booking code", async run({ page }) { await page.locator('#reviewed').waitFor(); } },
  { source: "Confirm the booking", async run({ page }) { await page.locator('#b').waitFor(); } },
]);
`;
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      JSON.stringify({ file: revised }),
    ]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    expect(await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8')).toContain('#reviewed');
    expect(
      events.some((e) => e.kind === 'phase' && e.phase === 'review' && e.message.startsWith('revised')),
    ).toBe(true);
  });

  it('rejects a review revision that does not compile, and the generated file stands', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const broken = `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: "Enter the booking code", async run({ page }) { await page.locator('#x'.waitFor(); } },
  { source: "Confirm the booking", async run({ page }) { await page.locator('#code').waitFor(); } },
]);
`;
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      JSON.stringify({ file: broken }),
    ]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).not.toContain(`'#x'.waitFor`);
    expect(written).toContain('Confirm the booking');
    expect(
      events.some(
        (e) => e.kind === 'phase' && e.phase === 'review' && e.message.includes('does not compile'),
      ),
    ).toBe(true);
  });

  it('rejects a review revision that inlines a parameter value', async () => {
    const md = await write('booking.md', [
      '# Booking',
      '',
      '## Parameters',
      '- password: hunter2-correct-horse',
      '',
      '## Steps',
      '1. Enter the booking code',
    ].join('\n'));
    const test = await parseTestFile(md);
    const leaky = `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: "Enter the booking code", async run({ page }) { await page.fill('#p', 'hunter2-correct-horse'); } },
]);
`;
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      JSON.stringify({ file: leaky }),
    ]);
    const { runner } = scriptedRunner(1, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('green');
    expect(await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8'))
      .not.toContain('hunter2-correct-horse');
    expect(
      events.some((e) => e.kind === 'phase' && e.message.includes('inlines {{password}}')),
    ).toBe(true);
  });

  it('rejects a review revision that adds an entry for a step it was not given', async () => {
    // Caught live in a prefix compile: the reviewer, shown the whole test,
    // wrote an entry for the step the recording never reached — code for a
    // step nobody recorded, which the next compile would then skip as
    // "already has one". The set of entries is the compiler's decision.
    const md = await write('booking.md', THREE_STEP_MD);
    const test = await parseTestFile(md);
    const record: CompileRunOutcome = {
      status: 'failed',
      steps: [stepResult(1), stepResult(2), stepResult(3, { status: 'failed', error: 'no such button' })],
      resolvedParameters: {},
      tokensUsed: 0,
    };
    const inventive = `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: "Enter the booking code", async run({ page }) { await page.locator('#code').waitFor(); } },
  { source: "Confirm the booking", async run({ page }) { await page.locator('#code').waitFor(); } },
  { source: "Read the reference", async run({ page }) { await page.locator('#invented').click(); } },
]);
`;
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      JSON.stringify({ file: inventive }),
    ]);
    const { runner } = scriptedRunner(3, ['pass'], record);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });

    expect(result.status).toBe('partial');
    const written = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');
    expect(written).not.toContain('Read the reference');
    expect(written).not.toContain('#invented');
    expect(
      events.some((e) => e.kind === 'phase' && e.message.includes('adds an entry for "Read the reference"')),
    ).toBe(true);
  });

  it('starts every run from $VAR parameters resolved against the env, and guards the resolved secret', async () => {
    // The parser keeps `$GITHUB_PASSWORD` as written; a Run resolves it before
    // it starts, and so must the compile — for its runs, and for the review's
    // leak guard, which would otherwise look for the literal and wave the real
    // password through.
    const md = await write('booking.md', [
      '# Booking',
      '',
      '## Parameters',
      '- username: $GITHUB_USERNAME',
      '- password: $GITHUB_PASSWORD',
      '',
      '## Steps',
      '1. Enter the booking code',
    ].join('\n'));
    const test = await parseTestFile(md);
    expect(test.parameters).toEqual({ username: '$GITHUB_USERNAME', password: '$GITHUB_PASSWORD' });
    const leaky = `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: "Enter the booking code", async run({ page }) { await page.fill('#p', 'correct-horse-battery'); } },
]);
`;
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      JSON.stringify({ file: leaky }),
    ]);
    const { runner, requests } = scriptedRunner(1, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
      env: { GITHUB_USERNAME: 'octocat', GITHUB_PASSWORD: 'correct-horse-battery', UNRELATED: 'x' },
    });

    expect(result.status).toBe('green');
    // Record and Replay both started from the resolved map.
    expect(requests.map((r) => r.parameters)).toEqual([
      { username: 'octocat', password: 'correct-horse-battery' },
      { username: 'octocat', password: 'correct-horse-battery' },
    ]);
    // The review inlined the RESOLVED password, and was caught.
    expect(
      events.some((e) => e.kind === 'phase' && e.message.includes('inlines {{password}}')),
    ).toBe(true);
    expect(await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8')).not.toContain('correct-horse-battery');
    expect(events.some((e) => e.kind === 'note')).toBe(false);
  });

  it('says so when a $VAR parameter resolves to nothing, and runs with the literal', async () => {
    const md = await write('booking.md', [
      '# Booking',
      '',
      '## Parameters',
      '- username: $GITHUB_USERNAME',
      '',
      '## Steps',
      '1. Enter the booking code',
    ].join('\n'));
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const { runner, requests } = scriptedRunner(1, ['pass']);
    const { events, onEvent } = collect();

    await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent, env: {} });

    expect(requests[0]!.parameters).toEqual({ username: '$GITHUB_USERNAME' });
    const note = events.find((e) => e.kind === 'note');
    expect(note).toMatchObject({ kind: 'note', level: 'warn' });
    expect(note!.kind === 'note' && note!.message).toContain('parameter "username" is $GITHUB_USERNAME');
  });

  it('applies a data row over the parameters, as a data-driven run would', async () => {
    const md = await write('booking.md', [
      '# Booking',
      '',
      '## Parameters',
      '- username: $GITHUB_USERNAME',
      '- code: {{code}}',
      '',
      '## Steps',
      '1. Enter the booking code',
    ].join('\n'));
    const test = await parseTestFile(md);
    const { client } = scriptedClient([entryEnvelope('Enter the booking code'), REVIEW_NOOP]);
    const { runner, requests } = scriptedRunner(1, ['pass']);

    await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner,
      env: { GITHUB_USERNAME: 'octocat' },
      dataRow: { code: '220826', username: 'row-user' },
    });

    // The row outranks the env for `username`, fills `code`, and nothing is
    // left as a placeholder.
    expect(requests[0]!.parameters).toEqual({ username: 'row-user', code: '220826' });
  });

  it('survives an unparseable review and keeps the generated file', async () => {
    const md = await write('booking.md', TEST_MD);
    const test = await parseTestFile(md);
    const { client } = scriptedClient([
      entryEnvelope('Enter the booking code'),
      entryEnvelope('Confirm the booking'),
      'I have reviewed the file and it looks fine.',
    ]);
    const { runner } = scriptedRunner(2, ['pass']);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent,
    });
    expect(result.status).toBe('green');
    expect(
      events.some((e) => e.kind === 'phase' && e.phase === 'review' && e.message.startsWith('skipped')),
    ).toBe(true);
  });
});

describe('compileTest — skills span several files', () => {
  it('writes a skill body\'s entry into the skill\'s own .steps.ts', async () => {
    await write('skills/login.md', [
      '---',
      'type: skill',
      '---',
      '# Login',
      '',
      '## Steps',
      '1. Click the sign-in button',
    ].join('\n'));
    const md = await write('tests/booking.md', [
      '# Booking',
      '',
      '## Steps',
      '1. [skill: login]',
      '2. Enter the booking code',
    ].join('\n'));
    const test = await parseTestFile(md, { skillsDir: path.join(dir, 'skills') });
    expect(test.steps).toHaveLength(2);

    const { client } = scriptedClient([
      entryEnvelope('Click the sign-in button'),
      entryEnvelope('Enter the booking code'),
      REVIEW_NOOP,
      REVIEW_NOOP,
    ]);
    const { runner, requests } = scriptedRunner(2, ['pass']);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner,
    });

    expect(result.status).toBe('green');
    expect(Object.keys(result.files).sort()).toEqual([
      path.join(dir, 'skills', 'login.steps.ts'),
      path.join(dir, 'tests', 'booking.steps.ts'),
    ].sort());
    // Both files were offered to the replay as candidates.
    expect(Object.keys(requests[1]!.candidateFiles ?? {})).toHaveLength(2);
    const skillFile = await fs.readFile(path.join(dir, 'skills', 'login.steps.ts'), 'utf-8');
    expect(skillFile).toContain('code-behind for login.md');
    expect(skillFile).toContain('Click the sign-in button');
  });
});

describe('the candidate override', () => {
  it('loads entries from the override path and leaves the real file alone', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ step }) { step.setVar('from', 'real'); } },
]);
`);
    const override = await write('.steptix-codebehind-cache/candidate.steps.ts', `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ step }) { step.setVar('from', 'candidate'); } },
]);
`);
    const test = await parseTestFile(md);
    const canonical = path.join(dir, 'booking.steps.ts');

    const registry = await buildCodeBehindRegistry(
      {
        steps: test.steps,
        rawSteps: test.expansion!.rawSteps,
        origins: test.expansion!.origins,
        frames: test.expansion!.frames,
      },
      {
        testFilePath: md,
        onWarn: () => {},
        candidateFiles: { [canonical]: override },
      },
    );

    const binding = registry.bindingFor(0)!;
    // The binding still names the canonical file — that is where an entry
    // would be written, and what the report should show.
    expect(binding.file).toBe(canonical);
    const vars: Record<string, string> = {};
    await binding.entry!.run!({
      step: {
        getVar: () => undefined,
        setVar: (n, v) => { vars[n] = String(v); },
        expect: () => {},
      },
    } as never);
    expect(vars['from']).toBe('candidate');
  });
});

describe('the last-run sidecar', () => {
  it('round-trips beside the test, in the gitignored cache dir', async () => {
    const md = await write('booking.md', TEST_MD);
    expect(lastRunPathFor(md)).toBe(
      path.join(dir, '.steptix-codebehind-cache', 'booking.last-run.json'),
    );

    await writeLastRun(md, [
      { index: 1, source: 'Enter the booking code', status: 'passed', fromCodeBehind: true, stale: false },
      { index: 2, source: 'Confirm the booking', status: 'passed', fromCodeBehind: false, stale: true, error: 'boom' },
    ]);

    const read = await readLastRun(md);
    expect(read?.test).toBe(path.resolve(md));
    expect(read?.steps.map((s) => s.stale)).toEqual([false, true]);
    expect(read?.steps[1]?.error).toBe('boom');
  });

  it('reads as nothing-known when there is no sidecar or it is corrupt', async () => {
    const md = await write('booking.md', TEST_MD);
    expect(await readLastRun(md)).toBeNull();
    await write('.steptix-codebehind-cache/booking.last-run.json', 'not json');
    expect(await readLastRun(md)).toBeNull();
  });
});

describe('reportToOutcome', () => {
  it('indexes real steps and drops hook and ad-hoc rows', () => {
    const outcome = reportToOutcome(
      {
        testName: 't', filePath: 'x.md', tags: [], status: 'passed',
        steps: [
          stepResult(0, { hookScope: 'before' }),
          stepResult(1),
          stepResult(2, { interactiveAdHoc: true }),
          stepResult(2),
        ],
        totalSteps: 2, passedSteps: 2, failedSteps: 0, totalSubActions: 0,
        durationMs: 1, tokensUsed: 42, inputTokens: 20, outputTokens: 22,
        date: new Date().toISOString(), parameters: { a: 'b' },
      },
      2,
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.steps).toHaveLength(2);
    expect(outcome.steps[0]?.index).toBe(1);
    expect(outcome.steps[1]?.interactiveAdHoc).toBeUndefined();
    expect(outcome.resolvedParameters).toEqual({ a: 'b' });
    expect(outcome.tokensUsed).toBe(42);
  });
});
