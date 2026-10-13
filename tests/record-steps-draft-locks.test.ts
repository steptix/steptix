/**
 * Record Steps — the draft engine's locks and the author's steps, without a
 * browser (stories/steptix-record-toolbar.md, "Steps you write", "Undo and
 * locked steps", "Pause and resume").
 *
 * The HTTP suite (api-server-record-steps.test.ts) drives these through the
 * real routes and a real page; this file reaches the paths a page cannot
 * easily produce on demand — a catch-up call that fails, a pause with a call
 * waiting, a restore after the stretch changed — with a scripted model that
 * writes one step per action, named after its target.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRecordStepsPrompt, RECORD_STEPS_SYSTEM } from '../src/ai/prompts.js';
import type { ChatMessage, MessageContentBlock } from '../src/ai/types.js';
import { DraftEngine } from '../src/recorder/draft-engine.js';
import { authorStepLines, authorStepSecrets } from '../src/recorder/record-steps-run.js';
import { summarizeTargetFile } from '../src/recorder/target-file.js';
import type { RecordStreamEvent, RecordedAction } from '../src/recorder/types.js';
import {
  applyOffsetEdits,
  beginLiveRecord,
  liveRecordWrite,
  resolveRecordCursor,
  splitAuthorSteps,
  trackAnchorThroughChanges,
  type LiveDraft,
  type LiveRecord,
  type RecordAnchor,
} from '../steptix-vscode/src/extension/record-steps-core.js';

const FILE = summarizeTargetFile('# T\n\n## Steps\n1. Navigate to /\n', 'cursor', 4);

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as MessageContentBlock[]).map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

function recordingOf(messages: ChatMessage[]): Array<Record<string, any>> {
  const text = textOf(messages);
  const start = text.lastIndexOf('--- BEGIN RECORDING ---') + '--- BEGIN RECORDING ---'.length;
  return JSON.parse(text.slice(start, text.lastIndexOf('--- END RECORDING ---')));
}

/** Where the prompt says this call's steps go: the insert point, else the end. */
function replaceFromOf(messages: ChatMessage[]): number {
  const text = textOf(messages);
  const insert = /answer with replaceFrom (\d+)/.exec(text);
  const append = /To only add steps, replaceFrom is (\d+)/.exec(text);
  return insert ? Number(insert[1]) : append ? Number(append[1]) : 0;
}

/** The model: one step per action, after whatever the draft says to start at. */
function echo(messages: ChatMessage[]): string {
  return JSON.stringify({
    replaceFrom: replaceFromOf(messages),
    steps: recordingOf(messages).map((a) => `Step for ${a['target']?.name ?? a['kind']}`),
    parameters: [],
  });
}

function action(n: number, name: string, isAction = true): RecordedAction {
  return {
    id: `a${n}`,
    kind: isAction ? 'click' : 'type',
    atMs: n * 1000,
    summary: `Clicked button "${name}"`,
    tab: 'main',
    action: isAction,
    target: { tag: 'button', role: 'button', name },
  };
}

interface Harness {
  engine: DraftEngine;
  calls: ChatMessage[][];
  frames: RecordStreamEvent[];
  drafts: () => Array<Extract<RecordStreamEvent, { type: 'record:draft' }>>;
  last: () => Extract<RecordStreamEvent, { type: 'record:draft' }>;
  /** Answers per call, 1-based; anything not scripted is `echo`. */
  script: Map<number, Scripted>;
}

/** A scripted answer: its text, a failure, or an answer made from the prompt. */
type Scripted = string | Error | ((messages: ChatMessage[]) => string);

function harness(file = FILE, now?: () => number): Harness {
  const calls: ChatMessage[][] = [];
  const frames: RecordStreamEvent[] = [];
  const script = new Map<number, Scripted>();
  const engine = new DraftEngine({
    file,
    ...(now && { now }),
    sendImages: false,
    secrets: () => [],
    settleMs: 10,
    emit: (e) => frames.push(e),
    complete: async (messages) => {
      calls.push(messages);
      const scripted = script.get(calls.length);
      if (scripted instanceof Error) throw scripted;
      return { text: typeof scripted === 'function' ? scripted(messages) : (scripted ?? echo(messages)) };
    },
  });
  const drafts = (): Array<Extract<RecordStreamEvent, { type: 'record:draft' }>> =>
    frames.filter((f): f is Extract<RecordStreamEvent, { type: 'record:draft' }> => f.type === 'record:draft');
  return { engine, calls, frames, drafts, last: () => drafts()[drafts().length - 1]!, script };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until `calls` model calls have been made and none is running, then a
 *  moment for the engine to act on the last answer. Throws, saying what it
 *  saw, when that does not happen — not a silent return that lets the test
 *  fail later on a draft assertion that does not say why. */
async function settled(h: Harness, calls: number): Promise<void> {
  const until = Date.now() + 5_000;
  while (h.calls.length < calls || h.engine.callsInFlight > 0) {
    if (Date.now() > until) {
      throw new Error(`the engine did not settle: ${h.calls.length} of ${calls} calls made, ${h.engine.callsInFlight} running`);
    }
    await sleep(5);
  }
  await sleep(30);
}

describe('a step the author adds at the end', () => {
  it("when the catch-up call fails, the step still goes in where it was put; the next call drafts the gap above it and moves nothing after", async () => {
    const h = harness();
    h.script.set(1, new Error('503 the model is down'));
    h.engine.setPaused(true); // nothing drafts on its own while these arrive
    h.engine.addAction(action(1, 'One'));
    h.engine.addAction(action(2, 'Two'));
    h.engine.setPaused(false);
    await sleep(0);
    const added = await h.engine.addAuthorSteps(['Verify the total is 2'], {
      source: 'toolbar',
      boundary: 2,
      atMs: 2500,
    });
    // The catch-up was tried, failed, and the step went in anyway — above
    // nothing the model wrote, locked.
    expect(h.calls).toHaveLength(1);
    expect(added.map((a) => [a.step.id, a.index])).toEqual([['s1', 0]]);
    expect(h.last()).toMatchObject({ steps: ['Verify the total is 2'], locked: 1, authored: [0] });

    // The next action: first the gap above the step, then the new action below it.
    h.engine.addAction(action(3, 'Three'));
    await settled(h, 3);
    expect(h.calls).toHaveLength(3);
    expect(recordingOf(h.calls[1]!).map((a) => a['target'].name)).toEqual(['One', 'Two']);
    expect(textOf(h.calls[1]!)).toContain('They go in at index 0');
    expect(recordingOf(h.calls[2]!).map((a) => a['target'].name)).toEqual(['Three']);
    expect(h.last()).toMatchObject({
      steps: ['Step for One', 'Step for Two', 'Verify the total is 2', 'Step for Three'],
      locked: 3,
      authored: [2],
    });
  });

  it('several lines are several steps, each locking what is above it; blank lines add nothing; a leading number or marker goes', () => {
    expect(authorStepLines('8. Click Pay now\n\n  - Verify the receipt shows "Paid"  \n* Go back\n3) Reload the page')).toEqual([
      'Click Pay now',
      'Verify the receipt shows "Paid"',
      'Go back',
      'Reload the page',
    ]);
    expect(authorStepLines('   \n\n')).toEqual([]);
    // Only a marker followed by a space is one: this is text.
    expect(authorStepLines('8.5 kg is the limit')).toEqual(['8.5 kg is the limit']);
  });
});

/**
 * The extension cleans a step the author types IN THE FILE with its own copy
 * of this rule (`splitAuthorSteps` / `cleanAuthorLine`, steptix-vscode's
 * record-steps-core.ts), and sends the result here, where `authorStepLines`
 * runs again. The two packages cannot share the code at run time, so the same
 * cases go through both. Known to part, and not pinned here: runs of inner
 * whitespace (the extension collapses them), a number of ten digits or more,
 * a lone CR — and a line that still starts with a marker once one is taken
 * off, which is stripped again on arrival (`1. 2. Pay` is sent as `2. Pay`
 * and kept as `Pay`).
 */
describe("authorStepLines and the extension's copy agree", () => {
  it.each([
    '8. Click Pay now\n\n  - Verify the receipt shows "Paid"  \n* Go back\n3) Reload the page',
    'Click Save\r\nVerify the total is 2',
    '   \n\n',
    '3.',
    '-',
    '+ Tick Cash',
    '10) Ten is a number, not text',
    '8.5 kg is the limit',
    '-5 degrees is not a marker',
  ])('%j', (text) => {
    const ext = splitAuthorSteps(text);
    expect(ext).toEqual(authorStepLines(text));
    // What the extension sends comes back as it sent it.
    expect(ext.flatMap((line) => authorStepLines(line))).toEqual(ext);
  });
});

describe('pause', () => {
  it('no call starts for actions while paused — a call already waiting included — and they are drafted on resume', async () => {
    const h = harness();
    h.engine.addAction(action(1, 'One'));
    h.engine.setPaused(true); // before the settle window ran out
    await sleep(80);
    expect(h.calls).toHaveLength(0);
    h.engine.setPaused(false);
    await settled(h, 1);
    expect(h.calls).toHaveLength(1);
    expect(h.last().steps).toEqual(['Step for One']);
  });
});

describe('undo and restore of an author step', () => {
  it('restored after its stretch changed: its lock goes back where it was in the recording, and both sides are redrafted', async () => {
    const h = harness();
    h.engine.addAction(action(1, 'One'));
    await settled(h, 1);
    await h.engine.addAuthorSteps(['Mine'], { source: 'panel', boundary: 1, atMs: 1500 });
    h.engine.addAction(action(2, 'Two'));
    await settled(h, 2);
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Mine', 'Step for Two'], locked: 2 });

    expect(h.engine.latestLiveEntry()).toMatchObject({ id: 'a2', kind: 'action' });
    expect(h.engine.drop('s1')).toBe(true);
    // Out at once, lock lifted; Two was drafted after it, so both are redrafted as one.
    expect(h.drafts().some((d) => d.locked === 0 && !d.steps.includes('Mine'))).toBe(true);
    await settled(h, 3);
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Step for Two'], locked: 0, authored: [] });
    // Something new since: the stretch changed, so Restore cannot simply put
    // the old stretches back.
    h.engine.addAction(action(3, 'Three'));
    await settled(h, 4);
    expect(h.engine.restore('s1')).toBe(true);
    await settled(h, 6);
    expect(h.last()).toMatchObject({
      steps: ['Step for One', 'Mine', 'Step for Two', 'Step for Three'],
      locked: 2,
      authored: [1],
    });
    expect(h.engine.latestLiveEntry()).toMatchObject({ id: 'a3' });
  });
});

// ── The fix round (review of the toolbar's server half) ───────────────────

describe('a failed catch-up (finding 7)', () => {
  it('is not retried on its own: the gap above the step waits for the next action', async () => {
    const h = harness();
    h.script.set(1, new Error('503 the model is down'));
    h.engine.setPaused(true);
    h.engine.addAction(action(1, 'One'));
    h.engine.setPaused(false);
    await sleep(0);
    await h.engine.addAuthorSteps(['Verify it'], { source: 'toolbar', boundary: 1, atMs: 1500 });
    expect(h.calls).toHaveLength(1);
    // No new action: nothing is asked again, however long it waits.
    await sleep(250);
    expect(h.calls).toHaveLength(1);
    expect(h.last()).toMatchObject({ steps: ['Verify it'], locked: 1 });
    // The next action is what sends it: the gap first, then the action.
    h.engine.addAction(action(2, 'Two'));
    await settled(h, 3);
    expect(h.calls).toHaveLength(3);
    expect(h.last().steps).toEqual(['Step for One', 'Verify it', 'Step for Two']);
  });
});

describe("a secret in a step of the author's (finding 5, authorStepSecrets)", () => {
  it('becomes {{name}} in every spelling, longest first, with a $NAME parameter the file does not already have', () => {
    const known = [
      { name: 'password', value: 'hunter2-X' },
      { name: 'API_TOKEN', value: 'tok"quoted"-123' },
      { name: 'short', value: 'hunter2' },
    ];
    const out = authorStepSecrets(
      ['Type hunter2-X into Password', 'Send tok\\"quoted\\"-123 as the key', 'Verify "hunter2" is not shown'],
      known,
      [{ name: 'password' }],
    );
    expect(out.lines).toEqual([
      'Type {{password}} into Password',
      'Send {{API_TOKEN}} as the key',
      'Verify "{{short}}" is not shown',
    ]);
    // The file defines {{password}} already; the others read the .env.
    expect(out.parameters).toEqual([
      { name: 'API_TOKEN', value: '$API_TOKEN' },
      { name: 'short', value: '$SHORT' },
    ]);
    expect(out.unnamed).toBe(false);
    // Nothing to replace: unchanged.
    expect(authorStepSecrets(['Click Save'], known, [])).toMatchObject({ lines: ['Click Save'], parameters: [] });
  });

  it('a secret with no usable name leaves the step refused, not sent', () => {
    expect(authorStepSecrets(['Type s3cr3t-value here'], [{ name: null, value: 's3cr3t-value' }], []).unnamed).toBe(true);
    expect(authorStepSecrets(['Type s3cr3t-value here'], [{ name: 'row.pw', value: 's3cr3t-value' }], []).unnamed).toBe(true);
  });
});

describe('two editor steps aimed at the same place (finding 9)', () => {
  it('land in the order they were sent, the second after the first', async () => {
    const h = harness();
    h.engine.addAction(action(1, 'Menu'));
    h.engine.addAction(action(2, 'Payments'));
    await settled(h, 1);
    expect(h.last().steps).toEqual(['Step for Menu', 'Step for Payments']);
    const revision = h.engine.currentRevision;
    // Both typed under step 1 of the same draft, sent one after the other.
    await h.engine.addAuthorSteps(['Verify A'], { source: 'editor', boundary: 2, atMs: 2500, afterStep: 0, revision });
    await h.engine.addAuthorSteps(['Verify B'], { source: 'editor', boundary: 2, atMs: 2600, afterStep: 0, revision });
    expect(h.last().steps).toEqual(['Step for Menu', 'Verify A', 'Verify B', 'Step for Payments']);
    // The same at the end of the draft: the second after the first.
    const end = h.engine.currentRevision;
    await h.engine.addAuthorSteps(['Verify C'], { source: 'editor', boundary: 2, atMs: 2700, afterStep: 3, revision: end });
    await h.engine.addAuthorSteps(['Verify D'], { source: 'editor', boundary: 2, atMs: 2800, afterStep: 3, revision: end });
    expect(h.last().steps).toEqual([
      'Step for Menu', 'Verify A', 'Verify B', 'Step for Payments', 'Verify C', 'Verify D',
    ]);
  });
});

describe('restoring an editor step typed between two recorded steps (finding 10)', () => {
  it('after its stretch changed, it goes back between the same two steps — not to where the recording ended', async () => {
    const h = harness();
    h.engine.addAction(action(1, 'One'));
    await settled(h, 1);
    h.engine.addAction(action(2, 'Two'));
    await settled(h, 2);
    const revision = h.engine.currentRevision;
    await h.engine.addAuthorSteps(['Mine'], { source: 'editor', boundary: 2, atMs: 2500, afterStep: 0, revision });
    expect(h.last().steps).toEqual(['Step for One', 'Mine', 'Step for Two']);
    expect(h.engine.drop('s1')).toBe(true);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two']);
    // Something new since: its stretch changed, so Restore redrafts both sides.
    h.engine.addAction(action(3, 'Three'));
    await settled(h, 3);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Step for Three']);
    expect(h.engine.restore('s1')).toBe(true);
    // At once, and after the redrafts: between One and Two, where the file has it.
    expect(h.last().steps.indexOf('Mine')).toBe(1);
    await settled(h, 5);
    expect(h.last()).toMatchObject({
      steps: ['Step for One', 'Mine', 'Step for Two', 'Step for Three'],
      authored: [1],
    });
  });
});

describe('the prompt with locks (buildRecordStepsPrompt)', () => {
  const base = { file: FILE, includeImages: false, secrets: [], actions: [action(4, 'Four')], firstActionNumber: 4 };

  it('an ordinary call: the locked and authored steps marked, and the furthest back past every lock', () => {
    const [, user] = buildRecordStepsPrompt({
      ...base,
      draft: {
        steps: ['Step one', 'Verify it says "hi"', 'Step three', 'Step four', 'Step five', 'Step six'],
        parameters: [],
        locked: 3,
        authored: [1],
      },
    });
    const text = textOf([user!]);
    expect(text).toContain('Steps 0 to 2 are LOCKED: they are in the test file and final.');
    expect(text).toContain('Steps marked "author": true were written by hand by the author at that point');
    // Three back from six is 3, and the lock is at 3 too.
    expect(text).toContain('To only add steps, replaceFrom is 6; the furthest back you may start is 3.');
    expect(text).toContain('"index": 1,\n      "step": "Verify it says \\"hi\\"",\n      "locked": true,\n      "author": true');
    expect(text).not.toContain('yourStepsGoHere');
  });

  it('a call that inserts: where its steps go, what the author also wrote there, and replaceFrom that index', () => {
    const [, user] = buildRecordStepsPrompt({
      ...base,
      draft: {
        steps: ['Mine at the edge', 'Step after'],
        parameters: [],
        locked: 1,
        authored: [0],
        insertAt: 0,
        alsoByAuthor: ['Mine inside'],
      },
    });
    const text = textOf([user!]);
    expect(text).toContain('They go in at index 0, where the draft shows "yourStepsGoHere": answer with replaceFrom 0.');
    expect(text).toContain('the author also wrote these by hand; they stay exactly as written, so do not write them again: ["Mine inside"]');
    expect(text.indexOf('"yourStepsGoHere": true')).toBeLessThan(text.indexOf('Mine at the edge'));
    expect(text).toContain('Write the steps for these actions now. Answer with the one JSON object described in the rules, replaceFrom 0.');
  });

  // Measured live: recording from a breakpoint after step 5 of a 6-step test,
  // the first draft for ONE click came back as steps 1–5 copied from
  // aroundTheCursor, the click, and step 6 — the file then held its whole
  // flow twice. The excerpt is labelled as already in the file (I10).
  it('an existing test\'s excerpt is labelled as already in the file, never part of the draft', () => {
    const file = summarizeTargetFile('# T\n\n## Steps\n1. Navigate to /\n2. Click "Sign in"\n3. Click "Sign out"\n', 'cursor', 5);
    const [, user] = buildRecordStepsPrompt({ ...base, file });
    const text = textOf([user!]);
    expect(text).toContain('">>" marks the line the new steps follow; those lines are already in the test and are never copied into the draft, while every action below still gets its step (I10).');
    expect(text).toContain('>>   5  2. Click \\"Sign in\\"');
  });

  it('without locks, the draft says nothing of them: no lock, no author mark, no insert marker, and the whole draft may be rewritten', () => {
    const [, user] = buildRecordStepsPrompt({ ...base, draft: { steps: ['A', 'B'], parameters: [] } });
    const text = textOf([user!]);
    expect(text).not.toContain('LOCKED');
    expect(text).not.toContain('"locked"');
    expect(text).not.toContain('"author"');
    expect(text).not.toContain('yourStepsGoHere');
    expect(text).toContain('the furthest back you may start is 0.');
  });

  it('the rules for locked and authored steps, a pause, and painted boxes', () => {
    for (const rule of [
      'Never reach back past a LOCKED step, a step the author wrote or a step the author reworded (A1, A4)',
      'A1. A LOCKED step is in the test file already and final',
      'A2. A step marked "author" was written by hand by the author at that point in the recording',
      'the actions right after it that only do what it says are covered by it, so write nothing for them',
      'A3. Never write a Verify that repeats one of the author\'s steps, not even for a check action',
      'I9. An action marked afterPause is the first thing the author did after pausing',
      'I10. In an EXISTING test, every line in aroundTheCursor is already in the file',
      'They are context, never copied into the draft: the draft is only the steps for the actions in THIS recording.',
      'every action the author did take gets its step, even when a line in aroundTheCursor already does the same thing',
      'D2. A solid dark box in a screenshot was painted over something you must not see',
    ]) {
      expect(RECORD_STEPS_SYSTEM).toContain(rule);
    }
    expect(RECORD_STEPS_SYSTEM).not.toContain('\\');
  });
});

// ── Parameters across draft calls (#84) ───────────────────────────────────

type Draft = Extract<RecordStreamEvent, { type: 'record:draft' }>;
type Param = { name: string; value: string };

const EMAIL: Param = { name: 'email', value: 'quill@example.net' };
const TYPE_EMAIL = 'Type {{email}} into the Email field';
const NO_DEFINITION = 'which no parameter defines';

/** A scripted answer: these steps and this parameter list, where the prompt
 *  says the call's steps go (as `echo` does). */
function says(steps: string[], parameters: Param[]): (messages: ChatMessage[]) => string {
  return (messages) => JSON.stringify({ replaceFrom: replaceFromOf(messages), steps, parameters });
}

/** Wait until the engine has made `calls` calls, none is running, and the
 *  last draft is `ready` — the condition itself, polled under a generous
 *  ceiling; the error says what it saw. */
async function drafted(h: Harness, calls: number, ready: (d: Draft) => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      const d = h.drafts().at(-1);
      if (h.calls.length < calls || h.engine.callsInFlight > 0 || !d || !ready(d)) {
        throw new Error(
          `waiting: ${h.calls.length} of ${calls} calls, ${h.engine.callsInFlight} running, ` +
            `last draft ${JSON.stringify(d?.steps)}`,
        );
      }
    },
    { timeout: 5_000, interval: 5 },
  );
}

/** Every draft whose steps use `{{name}}` defined it: no draft along the way
 *  dropped it, and none said that nothing defines it. */
function alwaysDefined(h: Harness, name: string): void {
  const using = h.drafts().filter((d) => d.steps.some((s) => s.includes(`{{${name}}}`)));
  expect(using.length).toBeGreaterThan(0);
  for (const d of using) {
    expect({ steps: d.steps, names: d.parameters.map((p) => p.name) }).toEqual({
      steps: d.steps,
      names: expect.arrayContaining([name]),
    });
    expect(d.notes ?? []).not.toContainEqual(expect.stringContaining(NO_DEFINITION));
  }
}

describe('parameters across draft calls (#84)', () => {
  it('a later call that leaves a parameter out keeps it while a step still uses it', async () => {
    const h = harness();
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, says(['Click Continue'], []));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    expect(h.last().parameters).toEqual([EMAIL]);
    h.engine.addAction(action(2, 'Continue'));
    await drafted(h, 2, (d) => d.steps.length === 2);
    // The call was shown the parameter, and its answer left it out.
    expect(textOf(h.calls[1]!)).toContain(EMAIL.value);
    expect(h.last()).toMatchObject({ steps: [TYPE_EMAIL, 'Click Continue'], parameters: [EMAIL] });
    alwaysDefined(h, 'email');
  });

  it('an answer that names the parameter wins: the model can still correct a value', async () => {
    const h = harness();
    const grace = { name: 'email', value: 'grace@example.com' };
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, says(['Click Continue'], [grace]));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    h.engine.addAction(action(2, 'Continue'));
    await drafted(h, 2, (d) => d.steps.length === 2);
    expect(h.last().parameters).toEqual([grace]);
  });

  it('a carried parameter keeps its place in the list; new ones follow the answer', async () => {
    const h = harness();
    const pin = { name: 'pin', value: '4321' };
    const city = { name: 'city', value: 'Paris' };
    h.script.set(1, says([TYPE_EMAIL, 'Type {{pin}} into the PIN field'], [EMAIL, pin]));
    h.script.set(2, says(['Type {{city}} into the City field'], [city]));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 2);
    h.engine.addAction(action(2, 'City'));
    await drafted(h, 2, (d) => d.steps.length === 3);
    expect(h.last().parameters).toEqual([EMAIL, pin, city]);
  });

  it('a deleted step still takes its parameter with it — a later call that leaves it out does not bring it back', async () => {
    const h = harness();
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, says(['Click Continue'], []));
    h.script.set(3, says(['Click Done'], []));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    h.engine.addAction(action(2, 'Continue'));
    await drafted(h, 2, (d) => d.steps.length === 2);
    expect(h.last().parameters).toEqual([EMAIL]);
    expect(h.engine.drop(h.last().ids[0]!)).toBe(true);
    expect(h.last()).toMatchObject({ steps: ['Click Continue'], parameters: [] });
    h.engine.addAction(action(3, 'Done'));
    await drafted(h, 3, (d) => d.steps.length === 2);
    // Not shown to the call, and not put back after it.
    expect(textOf(h.calls[2]!)).not.toContain(EMAIL.value);
    expect(h.last()).toMatchObject({ steps: ['Click Continue', 'Click Done'], parameters: [] });
  });

  it('so does a step reworded without it', async () => {
    const h = harness();
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, says(['Click Done'], []));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    expect(h.engine.editStep(h.last().ids[0]!, 'Type the address into the Email field', { source: 'panel' })).toBe(
      true,
    );
    expect(h.last().parameters).toEqual([]);
    h.engine.addAction(action(2, 'Done'));
    await drafted(h, 2, (d) => d.steps.length === 2);
    expect(h.last()).toMatchObject({
      steps: ['Type the address into the Email field', 'Click Done'],
      parameters: [],
    });
  });

  it('a parameter settled under a new name (the file has the name) is carried under that name, not renamed again', async () => {
    const file = summarizeTargetFile(
      '# T\n\n## Parameters\n- email: someone@example.org\n\n## Steps\n1. Navigate to /\n',
      'cursor',
      7,
    );
    const h = harness(file);
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, says(['Click Continue'], []));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    const renamed = { name: 'email_2', value: EMAIL.value };
    expect(h.last()).toMatchObject({ steps: ['Type {{email_2}} into the Email field'], parameters: [renamed] });
    h.engine.addAction(action(2, 'Continue'));
    await drafted(h, 2, (d) => d.steps.length === 2);
    expect(h.last()).toMatchObject({
      steps: ['Type {{email_2}} into the Email field', 'Click Continue'],
      parameters: [renamed],
    });
    alwaysDefined(h, 'email_2');
  });

  it('a redraft of a closed stretch that leaves the parameter out keeps it', async () => {
    const h = harness();
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, says(['Click Extra'], [EMAIL]));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    h.engine.addAction(action(2, 'Extra'));
    await drafted(h, 2, (d) => d.steps.length === 2);
    await h.engine.addAuthorSteps(['Verify the form is filled'], { source: 'panel', boundary: 2, atMs: 2500 });
    const third = h.calls.length + 1;
    h.script.set(third, says(['Click Continue'], [EMAIL]));
    h.engine.addAction(action(3, 'Continue'));
    await drafted(h, third, (d) => d.steps.length === 4);
    expect(h.last()).toMatchObject({ locked: 3, parameters: [EMAIL] });
    // Dropping an action of the closed stretch redrafts that stretch alone.
    const before = h.calls.length;
    h.script.set(before + 1, says([TYPE_EMAIL], []));
    expect(h.engine.drop('a2')).toBe(true);
    await drafted(h, before + 1, (d) => d.steps.length === 3);
    expect(textOf(h.calls[before]!)).toContain('They go in at index 0');
    expect(textOf(h.calls[before]!)).toContain(EMAIL.value);
    expect(h.last()).toMatchObject({
      steps: [TYPE_EMAIL, 'Verify the form is filled', 'Click Continue'],
      parameters: [EMAIL],
    });
    alwaysDefined(h, 'email');
  });

  it("a gap call — the actions a failed catch-up left above a step of the author's — that leaves the parameter out keeps it", async () => {
    // The gap is due once an action comes after the failed call — compared
    // by the engine's clock, which ticks on every reading here, so the two
    // never share a millisecond however fast the test runs.
    let tick = 0;
    const h = harness(FILE, () => ++tick);
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, new Error('503 the model is down'));
    h.script.set(3, says(['Click Two'], []));
    h.script.set(4, says(['Click Continue'], [EMAIL]));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    h.engine.setPaused(true); // nothing drafts on its own while it arrives
    h.engine.addAction(action(2, 'Two'));
    h.engine.setPaused(false);
    await h.engine.addAuthorSteps(['Verify the form is filled'], { source: 'toolbar', boundary: 2, atMs: 2500 });
    expect(h.calls).toHaveLength(2);
    expect(h.last().steps).toEqual([TYPE_EMAIL, 'Verify the form is filled']);
    h.engine.addAction(action(3, 'Continue'));
    await drafted(h, 4, (d) => d.steps.length === 4);
    expect(textOf(h.calls[2]!)).toContain('They go in at index 1');
    expect(h.last()).toMatchObject({
      steps: [TYPE_EMAIL, 'Click Two', 'Verify the form is filled', 'Click Continue'],
      parameters: [EMAIL],
    });
    // The draft between the gap call and the next one included.
    alwaysDefined(h, 'email');
  });

  it('a redraft from nothing starts its parameters from nothing: it was shown none, so none is carried into it', async () => {
    const h = harness();
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    // Reaches past the end: refused, and asked again as a redraft of the open
    // steps — the whole draft here, so the call starts from nothing.
    h.script.set(2, JSON.stringify({ replaceFrom: 7, steps: ['Click Continue'], parameters: [] }));
    h.script.set(3, says([TYPE_EMAIL, 'Click Continue'], []));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    h.engine.addAction(action(2, 'Continue'));
    await drafted(h, 3, (d) => d.steps.length === 2);
    expect(textOf(h.calls[2]!)).not.toContain(EMAIL.value);
    expect(h.last()).toMatchObject({ steps: [TYPE_EMAIL, 'Click Continue'], parameters: [] });
    expect(h.last().notes).toContainEqual(expect.stringContaining(`{{email}}, ${NO_DEFINITION}`));
  });

  it('a redraft from nothing keeps what its own answer gives', async () => {
    const h = harness();
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, JSON.stringify({ replaceFrom: 7, steps: ['Click Continue'], parameters: [] }));
    h.script.set(3, says([TYPE_EMAIL, 'Click Continue'], [EMAIL]));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    h.engine.addAction(action(2, 'Continue'));
    await drafted(h, 3, (d) => d.steps.length === 2);
    expect(h.last()).toMatchObject({ steps: [TYPE_EMAIL, 'Click Continue'], parameters: [EMAIL] });
  });
});

/** Line coordinates of an offset edit, for the anchor tracker. */
function lineChangeOf(text: string, start: number, end: number, inserted: string) {
  const pos = (off: number) => {
    const before = text.slice(0, off);
    return { line: (before.match(/\n/g) ?? []).length, char: off - (before.lastIndexOf('\n') + 1) };
  };
  const s = pos(start);
  const e = pos(end);
  return { startLine: s.line, startChar: s.char, endLine: e.line, endChar: e.char, text: inserted };
}

describe("the extension's live writer, fed the engine's drafts (#84)", () => {
  it('keeps "- email: …" under ## Parameters after a draft whose call left the parameter out', async () => {
    const h = harness();
    h.script.set(1, says([TYPE_EMAIL], [EMAIL]));
    h.script.set(2, says(['Click Continue'], []));
    h.engine.addAction(action(1, 'Email'));
    await drafted(h, 1, (d) => d.steps.length === 1);
    h.engine.addAction(action(2, 'Continue'));
    await drafted(h, 2, (d) => d.steps.length === 2);

    // Every draft written in order, as the extension's draft writer does.
    let text = '# T\n\n## Steps\n1. Navigate to /\n';
    const cursor = resolveRecordCursor(text, 4);
    if (!cursor.ok) throw new Error(cursor.reason);
    let anchor: RecordAnchor = { ...cursor.anchor, tracked: true };
    let live: LiveRecord | null = null;
    const written: string[] = [];
    for (const draft of h.drafts()) {
      if (!live) {
        const begun = beginLiveRecord(text, anchor);
        if ('error' in begun) throw new Error(begun.error);
        live = begun;
      }
      const w = liveRecordWrite(live, text, draft as LiveDraft, { anchor });
      if ('error' in w) throw new Error(w.error);
      anchor = trackAnchorThroughChanges(
        anchor,
        w.edits.map((e) => lineChangeOf(text, e.start, e.end, e.text)),
      );
      text = applyOffsetEdits(text, w.edits);
      live = w.record;
      written.push(text);
    }
    expect(written.length).toBeGreaterThanOrEqual(2);
    expect(written[0]).toContain('- email: quill@example.net');
    expect(text).toBe(
      '# T\n\n## Parameters\n- email: quill@example.net\n\n## Steps\n1. Navigate to /\n' +
        '2. Type {{email}} into the Email field\n3. Click Continue\n',
    );
  });
});
