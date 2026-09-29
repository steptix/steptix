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
import { describe, it, expect } from 'vitest';
import { buildRecordStepsPrompt, RECORD_STEPS_SYSTEM } from '../src/ai/prompts.js';
import type { ChatMessage, MessageContentBlock } from '../src/ai/types.js';
import { DraftEngine } from '../src/recorder/draft-engine.js';
import { authorStepLines, authorStepSecrets } from '../src/recorder/record-steps-run.js';
import { summarizeTargetFile } from '../src/recorder/target-file.js';
import type { RecordStreamEvent, RecordedAction } from '../src/recorder/types.js';

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

/** The model: one step per action, after whatever the draft says to start at. */
function echo(messages: ChatMessage[]): string {
  const text = textOf(messages);
  const insert = /answer with replaceFrom (\d+)/.exec(text);
  const append = /To only add steps, replaceFrom is (\d+)/.exec(text);
  const replaceFrom = insert ? Number(insert[1]) : append ? Number(append[1]) : 0;
  return JSON.stringify({
    replaceFrom,
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
  script: Map<number, string | Error>;
}

function harness(): Harness {
  const calls: ChatMessage[][] = [];
  const frames: RecordStreamEvent[] = [];
  const script = new Map<number, string | Error>();
  const engine = new DraftEngine({
    file: FILE,
    sendImages: false,
    secrets: () => [],
    settleMs: 10,
    emit: (e) => frames.push(e),
    complete: async (messages) => {
      calls.push(messages);
      const scripted = script.get(calls.length);
      if (scripted instanceof Error) throw scripted;
      return { text: scripted ?? echo(messages) };
    },
  });
  const drafts = (): Array<Extract<RecordStreamEvent, { type: 'record:draft' }>> =>
    frames.filter((f): f is Extract<RecordStreamEvent, { type: 'record:draft' }> => f.type === 'record:draft');
  return { engine, calls, frames, drafts, last: () => drafts()[drafts().length - 1]!, script };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function settled(h: Harness, calls: number): Promise<void> {
  const until = Date.now() + 3_000;
  while ((h.calls.length < calls || h.engine.callsInFlight > 0) && Date.now() < until) await sleep(5);
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

  it('without locks, the draft reads exactly as it always did', () => {
    const [, user] = buildRecordStepsPrompt({ ...base, draft: { steps: ['A', 'B'], parameters: [] } });
    const text = textOf([user!]);
    expect(text).toContain(
      '## The draft so far: 2 steps\nIndexes count from 0, as replaceFrom does. To only add steps, replaceFrom is 2; the furthest back you may start is 0.\n```json',
    );
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
