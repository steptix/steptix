import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepResult } from '../src/report/types.js';
import {
  readRecording,
  recordingDirFor,
  redact,
  secretValues,
  spliceRecording,
  writeRecording,
  writeReplayFailure,
} from '../src/codebehind/recording.js';

/**
 * The recording on disk (stories/codebehind-recording-on-disk.md): a compile's
 * input as files beside the test, written by the run and readable by the
 * author — and by nobody on the server afterwards.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-recording');
let counter = 0;
let dir: string;

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

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
      path.join(dir, 'tests', '.aiui-codebehind-cache', 'checkout.recording'),
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
    await seed(test);
    const before = (await readRecording(test))!;

    await new Promise((r) => setTimeout(r, 5));
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
    expect(after.steps[1]!.recordedAt).not.toBe(before.steps[1]!.recordedAt);
    // …and the siblings are byte-for-byte the recording they were.
    expect(after.steps[0]!.recordedAt).toBe(before.steps[0]!.recordedAt);
    expect(after.steps[2]!.recordedAt).toBe(before.steps[2]!.recordedAt);
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

    await new Promise((r) => setTimeout(r, 5));
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
    expect(after.steps[2]!.recordedAt).not.toBe(before.steps[2]!.recordedAt);
    // …and the first is exactly the recording it was.
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/one');
    expect(after.steps[0]!.recordedAt).toBe(before.steps[0]!.recordedAt);
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
    await seedBothFrames(test, true);
    const before = (await readRecording(test))!;
    expect(before.steps[0]!.file).toBe(TEST_FILE);
    expect(before.steps[1]!.file).toBe(SKILL_FILE);

    await new Promise((r) => setTimeout(r, 5));
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
    expect(after.steps[1]!.recordedAt).not.toBe(before.steps[1]!.recordedAt);
    // …and the test-frame step's evidence is byte-for-byte what it was.
    expect(after.steps[0]!.pageUrl).toBe('https://app.test/from-test-frame');
    expect(after.steps[0]!.recordedAt).toBe(before.steps[0]!.recordedAt);
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

    await new Promise((r) => setTimeout(r, 5));
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
