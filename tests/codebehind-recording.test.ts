import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepResult } from '../src/report/types.js';
import {
  readRecording,
  recordingDirFor,
  redact,
  secretValues,
  evidenceRows,
  isEvidencePass,
  spliceRecording,
  writeRecording,
  writeReplayFailure,
} from '../src/codebehind/recording.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * The recording on disk (stories/codebehind-recording-on-disk.md): a compile's
 * input as files beside the test, written by the run and readable by the
 * author — and by nobody on the server afterwards.
 */

/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-recording');
});
let counter = 0;
let dir: string;

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A splice proves it stamped its step by a `recordedAt` that differs from the
 * write before it, and both come from `new Date()`. Two real stamps taken a
 * few milliseconds apart can still share a millisecond (a timer may fire early
 * off libuv's cached loop time, and the wall clock can step back), so the
 * tests that compare them pin the clock instead. Only `Date` is faked: fs and
 * every timer stay real.
 */
const WRITTEN_AT = '2026-08-23T10:00:00.000Z';
const SPLICED_AT = '2026-08-23T10:00:01.000Z';
function clockAt(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function step(index: number, over: Partial<StepResult> = {}): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: '2026-08-23T00:00:00.000Z',
        aiInteractions: [],
        subActions: [
          { index: 1, action: { action: 'type', selector: '#email', value: 'demo@example.com' }, durationMs: 1 },
          { index: 2, action: { action: 'click', selector: '#go' }, durationMs: 1, error: 'skipped' },
        ],
      },
    ],
    durationMs: 12,
    retried: false,
    pageUrl: 'https://app.test/after',
    stepContext: {
      domBefore: `<input id="email">`,
      urlBefore: 'https://app.test/before',
      domAfter: `<input id="email" value="demo@example.com">`,
      urlAfter: 'https://app.test/after',
    },
    ...over,
  };
}

describe('the recording', () => {
  it('lives in the test\'s cache dir, named after the test', () => {
    expect(recordingDirFor(path.join(dir, 'tests', 'checkout.md'))).toBe(
      path.join(dir, 'tests', '.steptix-codebehind-cache', 'checkout.recording'),
    );
  });

  it('round-trips the steps, the DOM files and the failure screenshot, sparse where the run has nothing', async () => {
    const test = path.join(dir, 'checkout.md');
    const written = await writeRecording(test, {
      steps: [
        step(1),
        // A hook row shares the index space and is dropped.
        { ...step(1, { instruction: 'before hook' }), hookScope: 'before' } as StepResult,
        step(3, { status: 'failed', error: 'no such button', screenshotBase64: Buffer.from('png!').toString('base64') }),
      ],
      status: 'failed',
      startedAt: '2026-08-23T00:00:00.000Z',
      parameters: { username: 'octocat' },
      source: 'server',
    });
    expect(written).toBe(recordingDirFor(test));

    const files = (await fs.readdir(written!)).sort();
    expect(files).toEqual([
      'recording.json',
      'step-01.after.html',
      'step-01.before.html',
      'step-01.json',
      'step-03.after.html',
      'step-03.before.html',
      'step-03.failure.png',
      'step-03.json',
    ]);
    expect(await fs.readFile(path.join(written!, 'step-03.failure.png'))).toEqual(Buffer.from('png!'));

    const recording = (await readRecording(test))!;
    expect(recording.manifest).toMatchObject({
      test,
      status: 'failed',
      steps: 2,
      // Names, never values.
      parameters: ['username'],
      source: 'server',
      startedAt: '2026-08-23T00:00:00.000Z',
    });
    expect(recording.steps).toHaveLength(3);
    expect(recording.steps[1]).toBeUndefined();
    expect(recording.steps[0]).toMatchObject({
      index: 1,
      status: 'passed',
      urlBefore: 'https://app.test/before',
      urlAfter: 'https://app.test/after',
      pageUrl: 'https://app.test/after',
      // Only the actions that ran — the errored one is not part of the transcript.
      actions: [{ action: 'type', selector: '#email', value: 'demo@example.com' }],
      domBefore: '<input id="email">',
      domAfter: '<input id="email" value="demo@example.com">',
      files: { before: 'step-01.before.html', after: 'step-01.after.html' },
    });
    expect(recording.steps[2]).toMatchObject({
      index: 3,
      status: 'failed',
      error: 'no such button',
      files: { screenshot: 'step-03.failure.png' },
    });
  });

  it('replaces the previous recording wholesale', async () => {
    const test = path.join(dir, 'checkout.md');
    await writeRecording(test, {
      steps: [step(1), step(2)], status: 'passed', startedAt: 'a', parameters: {}, source: 'cli',
    });
    await writeRecording(test, {
      steps: [step(1)], status: 'passed', startedAt: 'b', parameters: {}, source: 'cli',
    });
    const files = await fs.readdir(recordingDirFor(test));
    expect(files.some((f) => f.startsWith('step-02'))).toBe(false);
    expect((await readRecording(test))!.manifest.startedAt).toBe('b');
  });

  it('redacts secret parameter values from the actions, the DOM and the outputs', async () => {
    const test = path.join(dir, 'login.md');
    const secrets = secretValues({ username: 'octocat', password: 'hunter2-horse', apiToken: 'tok-1', note: 'plain' });
    expect(secrets).toEqual(['hunter2-horse', 'tok-1']);
    expect(redact('typed hunter2-horse then tok-1', secrets)).toBe('typed *** then ***');

    await writeRecording(test, {
      steps: [
        step(1, {
          turns: [
            {
              turnNumber: 1, attemptNumber: 1, timestamp: 't', aiInteractions: [],
              subActions: [{ index: 1, action: { action: 'type', selector: '#pw', value: 'hunter2-horse' }, durationMs: 1 }],
            },
          ],
          stepContext: { domBefore: '<input value="hunter2-horse">', domAfter: '<p>welcome octocat</p>' },
          outputs: { password: 'hunter2-horse', greeting: 'hi hunter2-horse' },
        }),
      ],
      status: 'passed',
      startedAt: 't',
      parameters: { username: 'octocat', password: 'hunter2-horse' },
      source: 'cli',
    });
    const recording = (await readRecording(test))!;
    expect(recording.steps[0]!.actions[0]).toEqual({ action: 'type', selector: '#pw', value: '***' });
    expect(recording.steps[0]!.domBefore).toBe('<input value="***">');
    // A non-secret value is kept: the recording is for reading.
    expect(recording.steps[0]!.domAfter).toBe('<p>welcome octocat</p>');
    expect(recording.steps[0]!.outputs).toEqual({ password: '***', greeting: 'hi ***' });
    const raw = await fs.readFile(path.join(recordingDirFor(test), 'step-01.json'), 'utf-8');
    expect(raw).not.toContain('hunter2-horse');
  });

  it('redacts the assertions, which were the one field written through untouched', async () => {
    // `actual` and `expected` are page text: the value a step typed and read
    // back, a balance, a message. Every sibling field on this record is
    // redacted — `instruction`, `error`, `actions`, `outputs`, both DOM files
    // — and this one was not, so the recording on disk held the credential in
    // clear beside an `instruction` that said `***` (§7.6).
    const test = path.join(dir, 'assert.md');
    await writeRecording(test, {
      steps: [
        step(1, {
          assertions: [
            {
              assertIndex: 0,
              turnNumber: 1,
              subActionIndex: 1,
              description: 'the field kept what was typed',
              condition: 'the password field reads hunter2-horse',
              expected: 'hunter2-horse',
              actual: 'hunter2-horse',
              explanation: 'read back hunter2-horse',
              pass: true,
            },
          ],
        }),
      ],
      status: 'passed',
      startedAt: 't',
      parameters: { password: 'hunter2-horse' },
      source: 'cli',
    });

    const recording = (await readRecording(test))!;
    expect(recording.steps[0]!.assertions![0]).toMatchObject({
      condition: 'the password field reads ***',
      expected: '***',
      actual: '***',
      explanation: 'read back ***',
      pass: true,
    });
    const raw = await fs.readFile(path.join(recordingDirFor(test), 'step-01.json'), 'utf-8');
    expect(raw).not.toContain('hunter2-horse');
  });

  it('masks a dotted output name by the AUTHOR rule, not the loop-binding one', async () => {
    // A step's `[store as:]` names are author-chosen end to end. The
    // two-segment rule structured table reads introduced is for a loop's
    // `row.<column>` bindings, whose property half came off a page — split at
    // the dot, `api.key` leaves `key`, which the narrow record rule
    // deliberately does not mask, and the recording on disk held the
    // credential in clear.
    const test = path.join(dir, 'tools.md');
    await writeRecording(test, {
      steps: [
        step(1, {
          outputs: {
            customer: 'Alice Smith',
            'api.key': 'ak_live_9f2c',
            'user.apikey': 'uk_live_1234',
            'login.passkey': 'pk_live_5678',
          },
        }),
      ],
      status: 'passed',
      startedAt: 't',
      parameters: {},
      source: 'cli',
    });
    const recording = (await readRecording(test))!;
    expect(recording.steps[0]!.outputs).toEqual({
      customer: 'Alice Smith',
      'api.key': '***',
      'user.apikey': '***',
      'login.passkey': '***',
    });
    const raw = await fs.readFile(path.join(recordingDirFor(test), 'step-01.json'), 'utf-8');
    for (const leaked of ['ak_live_9f2c', 'uk_live_1234', 'pk_live_5678']) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('writes a replay failure beside the recording, with its screenshot and DOM', async () => {
    const test = path.join(dir, 'checkout.md');
    await writeReplayFailure(test, {
      round: 2,
      step: 7,
      line: 18,
      error: 'locator timeout on [data-test="promo"] for hunter2',
      url: 'https://app.test/cart',
      screenshotBase64: Buffer.from('shot').toString('base64'),
      dom: '<div>cart hunter2</div>',
    }, { password: 'hunter2' });
    const d = recordingDirFor(test);
    expect(JSON.parse(await fs.readFile(path.join(d, 'replay-2.failure.json'), 'utf-8'))).toEqual({
      round: 2,
      step: 7,
      line: 18,
      error: 'locator timeout on [data-test="promo"] for ***',
      url: 'https://app.test/cart',
      files: { screenshot: 'replay-2.failure.png', dom: 'replay-2.failure.html' },
    });
    expect(await fs.readFile(path.join(d, 'replay-2.failure.html'), 'utf-8')).toBe('<div>cart ***</div>');
    expect(await fs.readFile(path.join(d, 'replay-2.failure.png'))).toEqual(Buffer.from('shot'));
  });

  it('reads as nothing when there is no recording', async () => {
    expect(await readRecording(path.join(dir, 'nothing.md'))).toBeNull();
  });
});

/**
 * The splice (stories/compile-as-you-go.md §The recording).
 *
 * A Run & Compile replaces the recording wholesale, as a Record does. A
 * Compile This Step cannot: it knows only the steps it was sent, so replacing
 * would delete every other step's recording. It overwrites the matched step
 * and leaves the siblings — matched by the entry's own identity, authored text
 * plus section scope, and never by index.
 */
describe('splicing a single step into an existing recording', () => {
  /** Three steps recorded wholesale, then one spliced back in. */
  async function seed(test: string): Promise<void> {
    await writeRecording(test, {
      steps: [
        step(1, { instruction: 'Sign in' }),
        step(2, { instruction: 'Add to cart' }),
        step(3, { instruction: 'Check out' }),
      ],
      status: 'passed',
      startedAt: '2026-08-01T00:00:00.000Z',
      parameters: { username: 'octocat' },
      source: 'server',
      identities: {
        1: { source: 'Sign in' },
        2: { source: 'Add to cart' },
        3: { source: 'Check out' },
      },
    });
  }

  it('overwrites the matched step, stamps it, and leaves the siblings alone', async () => {
    const test = path.join(dir, 'checkout.md');
    clockAt(WRITTEN_AT);
    await seed(test);
    const before = (await readRecording(test))!;
    expect(before.steps.map((s) => s.recordedAt)).toEqual([WRITTEN_AT, WRITTEN_AT, WRITTEN_AT]);

    clockAt(SPLICED_AT);
    await spliceRecording(test, {
      steps: [
        step(1, {
          instruction: 'Add to cart',
          stepContext: {
            domBefore: '<div>cart empty</div>',
            urlBefore: 'https://app.test/cart',
            domAfter: '<div>1 item</div>',
            urlAfter: 'https://app.test/cart',
          },
        }),
      ],
      status: 'passed',
      startedAt: '2026-08-24T00:00:00.000Z',
      parameters: { username: 'octocat' },
      source: 'server',
      // The sent step is index 1 in ITS OWN request — which is exactly why
      // the match cannot be by index.
      identities: { 1: { source: 'Add to cart' } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps.map((s) => s.source)).toEqual(['Sign in', 'Add to cart', 'Check out']);
    // The spliced step kept slot 2 — its filenames, and its place in the test.
    expect(after.steps[1]!.index).toBe(2);
    expect(after.steps[1]!.domBefore).toBe('<div>cart empty</div>');
    expect(after.steps[1]!.recordedAt).toBe(SPLICED_AT);
    // …and the siblings are byte-for-byte the recording they were.
    expect(after.steps[0]!.recordedAt).toBe(WRITTEN_AT);
    expect(after.steps[2]!.recordedAt).toBe(WRITTEN_AT);
    expect(after.steps[0]!.domBefore).toBe(before.steps[0]!.domBefore);
  });

  it('matches within the section scope, not just the text', async () => {
    const test = path.join(dir, 'sectioned.md');
    await writeRecording(test, {
      steps: [step(1, { instruction: 'Press Enter' }), step(2, { instruction: 'Press Enter' })],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
      identities: {
        1: { source: 'Press Enter', section: 'Sign in' },
        2: { source: 'Press Enter', section: 'Search' },
      },
    });

    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Press Enter', pageUrl: 'https://app.test/search' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Press Enter', section: 'Search' } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/after');
    expect(after.steps[1]!.pageUrl).toBe('https://app.test/search');
  });

  it('appends a step nothing matches rather than guessing at a slot', async () => {
    const test = path.join(dir, 'grown.md');
    await seed(test);
    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Print the receipt' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Print the receipt' } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps).toHaveLength(4);
    expect(after.steps[3]!.source).toBe('Print the receipt');
    expect(after.manifest.steps).toBe(4);
  });

  it('redacts secrets exactly as a wholesale write does', async () => {
    const test = path.join(dir, 'login.md');
    await spliceRecording(test, {
      steps: [
        step(1, {
          instruction: 'Sign in',
          stepContext: { domBefore: '<i>hunter2-horse</i>', domAfter: '<i>ok</i>' },
        }),
      ],
      status: 'passed',
      startedAt: 'a',
      parameters: { password: 'hunter2-horse' },
      source: 'server',
      identities: { 1: { source: 'Sign in' } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps[0]!.domBefore).toBe('<i>***</i>');
    // Never values, in the manifest or anywhere else.
    expect(after.manifest.parameters).toEqual(['password']);
  });

  it('creates the recording when there is none — a single-step compile of a fresh test', async () => {
    const test = path.join(dir, 'fresh.md');
    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Sign in' })],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Sign in' } },
    });
    const after = (await readRecording(test))!;
    expect(after.steps).toHaveLength(1);
    expect(after.manifest.status).toBe('passed');
  });

  it('reports the dir as failed when any step in it is', async () => {
    // Mixed provenance by construction: the manifest describes what is on
    // disk now, not the run that last touched it.
    const test = path.join(dir, 'mixed.md');
    await writeRecording(test, {
      steps: [step(1, { instruction: 'Sign in' }), step(2, { instruction: 'Add to cart', status: 'failed', error: 'gone' })],
      status: 'failed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Sign in' }, 2: { source: 'Add to cart' } },
    });
    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Sign in' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Sign in' } },
    });
    expect((await readRecording(test))!.manifest.status).toBe('failed');
  });
});

describe('splicing when a test repeats a step', () => {
  it('keeps the two occurrences apart — compiling the second leaves the first alone', async () => {
    // Two identical authored steps at the top level. `section + source` alone
    // cannot tell them apart, so a splice keyed on that overwrites the FIRST
    // occurrence's files when the author compiles the second.
    const test = path.join(dir, 'repeat.md');
    clockAt(WRITTEN_AT);
    await writeRecording(test, {
      steps: [
        step(1, { instruction: 'Press Enter', pageUrl: 'https://app.test/one' }),
        step(2, { instruction: 'Type the code' }),
        step(3, { instruction: 'Press Enter', pageUrl: 'https://app.test/three' }),
      ],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
      identities: {
        1: { source: 'Press Enter', occurrence: 0 },
        2: { source: 'Type the code', occurrence: 0 },
        3: { source: 'Press Enter', occurrence: 1 },
      },
    });
    const before = (await readRecording(test))!;
    expect(before.steps[2]!.recordedAt).toBe(WRITTEN_AT);

    clockAt(SPLICED_AT);
    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Press Enter', pageUrl: 'https://app.test/spliced' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Press Enter', occurrence: 1 } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps).toHaveLength(3);
    // The SECOND occurrence took the splice…
    expect(after.steps[2]!.pageUrl).toBe('https://app.test/spliced');
    expect(after.steps[2]!.recordedAt).toBe(SPLICED_AT);
    // …and the first is exactly the recording it was.
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/one');
    expect(after.steps[0]!.recordedAt).toBe(WRITTEN_AT);
  });
});

describe('the splice identity carries the binding\'s target file', () => {
  // A test-frame step and a skill-body step can share authored text, an empty
  // section and occurrence 0 — the section/source/occurrence key is identical
  // for both, and the first slot in file order used to win. Measured victim:
  // a skill-step splice overwrote the TEST step's evidence while the skill
  // step's slot kept stale content.
  const TEST_FILE = 'checkout.steps.ts';
  const SKILL_FILE = 'login.steps.ts';

  async function seedBothFrames(test: string, withFiles: boolean): Promise<void> {
    await writeRecording(test, {
      steps: [
        step(1, { instruction: 'Press the go button', pageUrl: 'https://app.test/from-test-frame' }),
        step(2, { instruction: 'Press the go button', pageUrl: 'https://app.test/from-skill-frame' }),
      ],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
      identities: {
        1: { source: 'Press the go button', occurrence: 0, ...(withFiles && { file: TEST_FILE }) },
        2: { source: 'Press the go button', occurrence: 0, ...(withFiles && { file: SKILL_FILE }) },
      },
    });
  }

  it('a filed splice claims its own file\'s slot, never the identically-worded other frame\'s', async () => {
    const test = path.join(dir, 'checkout.md');
    clockAt(WRITTEN_AT);
    await seedBothFrames(test, true);
    const before = (await readRecording(test))!;
    expect(before.steps[0]!.file).toBe(TEST_FILE);
    expect(before.steps[1]!.file).toBe(SKILL_FILE);
    expect(before.steps[1]!.recordedAt).toBe(WRITTEN_AT);

    clockAt(SPLICED_AT);
    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Press the go button', pageUrl: 'https://app.test/spliced' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Press the go button', occurrence: 0, file: SKILL_FILE } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps).toHaveLength(2);
    // The SKILL slot took the splice — slot 2, not the first in file order…
    expect(after.steps[1]!.pageUrl).toBe('https://app.test/spliced');
    expect(after.steps[1]!.recordedAt).toBe(SPLICED_AT);
    // …and the test-frame step's evidence is byte-for-byte what it was.
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/from-test-frame');
    expect(after.steps[0]!.recordedAt).toBe(WRITTEN_AT);
  });

  it('a filed splice never claims a slot recorded for a DIFFERENT file — it opens a new one', async () => {
    const test = path.join(dir, 'checkout.md');
    await writeRecording(test, {
      steps: [step(1, { instruction: 'Press the go button', pageUrl: 'https://app.test/from-test-frame' })],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Press the go button', occurrence: 0, file: TEST_FILE } },
    });

    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Press the go button', pageUrl: 'https://app.test/spliced' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Press the go button', occurrence: 0, file: SKILL_FILE } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps).toHaveLength(2);
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/from-test-frame');
    expect(after.steps[1]!.pageUrl).toBe('https://app.test/spliced');
    expect(after.steps[1]!.file).toBe(SKILL_FILE);
  });

  it('a filed splice still matches a recording written before the field existed', async () => {
    const test = path.join(dir, 'checkout.md');
    await seedBothFrames(test, false);
    const before = (await readRecording(test))!;
    expect(before.steps[0]!.file).toBeUndefined();

    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Press the go button', pageUrl: 'https://app.test/spliced' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Press the go button', occurrence: 0, file: SKILL_FILE } },
    });

    // No same-file slot exists; the unfiled slot (first in file order) is
    // claimed — the pre-field behaviour, kept so old recordings still splice.
    const after = (await readRecording(test))!;
    expect(after.steps).toHaveLength(2);
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/spliced');
  });

  it('an unfiled splice keeps the pre-field behaviour: first slot in file order', async () => {
    const test = path.join(dir, 'checkout.md');
    await seedBothFrames(test, true);

    await spliceRecording(test, {
      steps: [step(1, { instruction: 'Press the go button', pageUrl: 'https://app.test/spliced' })],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Press the go button', occurrence: 0 } },
    });

    const after = (await readRecording(test))!;
    expect(after.steps).toHaveLength(2);
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/spliced');
  });
});

/**
 * One row per expanded step: the evidence pass
 * (stories/codebehind-loops-and-conditions.md, decisions 1 and 14).
 *
 * A runtime loop re-runs the same expanded indices, so a run's rows hold a body
 * index once per pass. Written as they came, every pass went through one
 * `step-NN` slot and the LAST won; spliced, each pass after the first opened a
 * new slot.
 */
describe('a looped step records its evidence pass', () => {
  /** One pass of a body step at `index`, told apart by its URL. */
  const pass = (index: number, n: number, over: Partial<StepResult> = {}): StepResult =>
    step(index, { instruction: 'Click Next', pageUrl: `https://app.test/pass-${n}`, ...over });

  it('picks the first pass that PASSED, else the first row — per index, in run order', () => {
    const rows = evidenceRows([
      step(1),
      pass(2, 1, { status: 'failed', tolerated: true }),
      pass(2, 2),
      pass(2, 3),
      step(3, { status: 'skipped' }),
      step(3, { status: 'skipped', instruction: 'later skip' }),
      { ...step(1, { instruction: 'hook' }), hookScope: 'before' } as StepResult,
    ]);
    expect(rows.map((r) => [r.index, r.pageUrl ?? r.instruction])).toEqual([
      [1, 'https://app.test/after'],
      // Pass 1 failed (tolerated); pass 2 is the first that passed.
      [2, 'https://app.test/pass-2'],
      // Never passed: the first row stands.
      [3, 'https://app.test/after'],
    ]);
    expect(rows[2]!.instruction).toBe('step 3');
  });

  it('skips a pass that ran cleanly as code for the pass that HEALED — the one with a transcript', () => {
    // The review's scenario: a While body whose entry ran as code on pass 1,
    // threw on pass 2 and healed under AI, then ran under AI on pass 3 (the
    // entry was discarded). Measured before the fix: pass 1 — `turns: []` —
    // was the evidence, so the boxed compile said "the recorded run performed
    // no page actions" and wrote `ai: true` over a working entry.
    const stale = { file: '/p/statements.steps.ts', source: 'Click Next', error: 'locator.click: Timeout 30000ms exceeded' };
    const rows = evidenceRows([
      step(1, { fromCodeBehind: true, turns: [] }),
      pass(2, 1, { fromCodeBehind: true, turns: [] }),
      pass(2, 2, { codeBehindStale: stale }),
      pass(2, 3),
    ]);
    expect(rows.map((r) => r.pageUrl)).toEqual([
      // Only ever ran as code: the first that passed still stands.
      'https://app.test/after',
      'https://app.test/pass-2',
    ]);
    expect(rows[1]!.codeBehindStale).toEqual(stale);
    expect(isEvidencePass(rows[1]!)).toBe(true);
    expect(isEvidencePass(rows[0]!)).toBe(false);
  });

  it('counts a deliberate failure as evidence — the step worked, as its text says', () => {
    const rows = evidenceRows([
      pass(2, 1, { status: 'failed', error: 'boom' }),
      pass(2, 2, { status: 'failed', deliberate: true, error: 'as written' }),
      pass(2, 3),
    ]);
    expect(rows[0]!.pageUrl).toBe('https://app.test/pass-2');
  });

  it('writes the healed pass to disk too, so the recording and the compile agree', async () => {
    const test = path.join(dir, 'healed.md');
    const stale = { file: '/p/healed.steps.ts', source: 'Click Next', error: 'boom' };
    await writeRecording(test, {
      steps: [step(1), pass(2, 1, { fromCodeBehind: true, turns: [] }), pass(2, 2, { codeBehindStale: stale }), step(3)],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'cli',
    });
    const recording = (await readRecording(test))!;
    expect(recording.steps[1]!.pageUrl).toBe('https://app.test/pass-2');
  });

  it('writes pass 1 of a three-pass body, and counts expanded steps in the manifest', async () => {
    const test = path.join(dir, 'loop.md');
    await writeRecording(test, {
      steps: [step(1), pass(2, 1), pass(2, 2), pass(2, 3), step(3)],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'cli',
    });
    const recording = (await readRecording(test))!;
    expect(recording.manifest.steps).toBe(3);
    expect(recording.steps[1]!.pageUrl).toBe('https://app.test/pass-1');
  });

  it('records a guard row\'s decision — never the page it was decided on', async () => {
    const test = path.join(dir, 'guard.md');
    await writeRecording(test, {
      steps: [
        step(1, {
          instruction: 'While the Next button is enabled, Go to the next page',
          turns: [],
          guard: {
            decidedBy: 'model',
            holds: true,
            evidence: { dom: '<p>SECRET-DOM</p>', url: 'https://app.test/judged', members: [{ index: 0, holds: true }] },
          },
        }),
      ],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
    });
    const recording = (await readRecording(test))!;
    expect(recording.steps[0]!.guard).toEqual({ decidedBy: 'model', holds: true });
    const raw = await fs.readFile(path.join(recordingDirFor(test), 'step-01.json'), 'utf-8');
    expect(raw).not.toContain('SECRET-DOM');
    expect(raw).not.toContain('evidence');
  });

  it('splices ONE slot for a body step a Compile This Step ran three times', async () => {
    const test = path.join(dir, 'splice-loop.md');
    await writeRecording(test, {
      steps: [step(1, { instruction: 'Open' }), step(2, { instruction: 'Click Next' })],
      status: 'passed',
      startedAt: 'a',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Open' }, 2: { source: 'Click Next' } },
    });

    await spliceRecording(test, {
      steps: [pass(1, 1), pass(1, 2), pass(1, 3)],
      status: 'passed',
      startedAt: 'b',
      parameters: {},
      source: 'server',
      identities: { 1: { source: 'Click Next' } },
    });

    const after = (await readRecording(test))!;
    // Two steps, not four: the passes are one step, and pass 1 is its evidence.
    expect(after.manifest.steps).toBe(2);
    expect(after.steps).toHaveLength(2);
    expect(after.steps[1]!.pageUrl).toBe('https://app.test/pass-1');
  });
});
