/**
 * Record Steps — editing and deleting steps while recording, in the draft
 * engine, without a browser (stories/steptix-record-edit-steps.md).
 *
 * The model is scripted: by default it writes one step per recorded ACTION
 * (the events before an action ride with it), names each after its target,
 * and says which actions each step stands for (`stepActions`), as the prompt
 * numbers them. A test can script any call's answer instead, or hold a call
 * open to land an edit or a delete while it runs.
 *
 * The HTTP suite (api-server-record-steps.test.ts) drives the same through the
 * real routes and a real page; this file reaches the orderings a page cannot
 * produce on demand, and ends with a random-interleaving property run.
 */
import { describe, it, expect } from 'vitest';
import { buildRecordStepsPrompt, RECORD_STEPS_SYSTEM } from '../src/ai/prompts.js';
import type { ChatMessage, MessageContentBlock } from '../src/ai/types.js';
import { DraftEngine } from '../src/recorder/draft-engine.js';
import { authorStepLines } from '../src/recorder/record-steps-run.js';
import { summarizeTargetFile } from '../src/recorder/target-file.js';
import type { RecordStreamEvent, RecordedAction } from '../src/recorder/types.js';
import { parseDraftAnswer } from '../src/recorder/write-steps.js';

const FILE = summarizeTargetFile('# T\n\n## Steps\n1. Navigate to /\n', 'cursor', 4);

type Draft = Extract<RecordStreamEvent, { type: 'record:draft' }>;

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as MessageContentBlock[]).map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

/** The actions one call was shown. */
function recordingOf(messages: ChatMessage[]): Array<Record<string, any>> {
  const text = textOf(messages);
  const start = text.lastIndexOf('--- BEGIN RECORDING ---') + '--- BEGIN RECORDING ---'.length;
  return JSON.parse(text.slice(start, text.lastIndexOf('--- END RECORDING ---')));
}

/** The draft one call was shown — its entries, flags and actions included. */
function draftEntriesOf(messages: ChatMessage[]): Array<Record<string, any>> {
  const m = /## The draft so far: [^\n]*\n(?:[^\n]*\n)*?```json\n([\s\S]*?)\n```/.exec(textOf(messages));
  return m ? (JSON.parse(m[1]!) as { steps: Array<Record<string, any>> }).steps : [];
}

/** Where this call's steps start: an inserting call's marker, else the end. */
function startOf(messages: ChatMessage[]): number {
  const text = textOf(messages);
  const insert = /answer with replaceFrom (\d+)/.exec(text);
  const append = /To only add steps, replaceFrom is (\d+)/.exec(text);
  return insert ? Number(insert[1]) : append ? Number(append[1]) : 0;
}

/** One step per ACTION, the events before it riding along; each says which
 *  actions (by the numbers the prompt gave) it stands for. */
function echo(messages: ChatMessage[], opts: { mapping?: boolean } = {}): string {
  const recording = recordingOf(messages);
  const steps: string[] = [];
  const stepActions: number[][] = [];
  let pending: number[] = [];
  let names: string[] = [];
  for (const a of recording) {
    pending.push(a['n']);
    names.push(a['target']?.name ?? a['kind']);
    if (a['kind'] !== 'type') {
      steps.push(`Step for ${names.join('+')}`);
      stepActions.push(pending);
      pending = [];
      names = [];
    }
  }
  if (pending.length > 0) {
    steps.push(`Step for ${names.join('+')}`);
    stepActions.push(pending);
  }
  return JSON.stringify({
    replaceFrom: startOf(messages),
    steps,
    ...(opts.mapping !== false && { stepActions }),
    parameters: [],
  });
}

function act(n: number, name: string): RecordedAction {
  return {
    id: `a${n}`,
    kind: 'click',
    atMs: n * 1000,
    summary: `Clicked button "${name}"`,
    tab: 'main',
    action: true,
    target: { tag: 'button', role: 'button', name },
  };
}

/** A click that only put the caret in a text field. */
function focusClick(n: number, name: string): RecordedAction {
  return {
    id: `a${n}`,
    kind: 'click',
    atMs: n * 1000,
    summary: `Clicked textbox "${name}" (into the field)`,
    tab: 'main',
    action: true,
    focusOnly: true,
    target: { tag: 'input', role: 'textbox', name },
  };
}

/** Tab (or another key) pressed in a text field: an action. */
function keyIn(n: number, name: string, key = 'Tab'): RecordedAction {
  return {
    id: `a${n}`,
    kind: 'key',
    atMs: n * 1000,
    summary: `Pressed ${key} in textbox "${name}"`,
    tab: 'main',
    action: true,
    key,
    target: { tag: 'input', role: 'textbox', name },
  };
}

/** An event that rides with the next action: typing into a field. */
function typed(n: number, name: string, value = 'x'): RecordedAction {
  return {
    id: `a${n}`,
    kind: 'type',
    atMs: n * 1000,
    summary: `Typed into "${name}"`,
    tab: 'main',
    action: false,
    target: { tag: 'input', role: 'textbox', name },
    value,
  };
}

type Scripted = string | Error | ((messages: ChatMessage[]) => string);

interface Harness {
  engine: DraftEngine;
  calls: ChatMessage[][];
  frames: RecordStreamEvent[];
  drafts: () => Draft[];
  last: () => Draft;
  /** Answers per call, 1-based; anything not scripted is `echo`. */
  script: Map<number, Scripted>;
  /** Hold every call from now until the returned function is called. */
  hold: () => () => void;
  /** Wait until a call is running. */
  inFlight: () => Promise<void>;
  /** The most calls ever running at once. */
  maxAtOnce: () => number;
}

function harness(opts: { mapping?: boolean } = {}): Harness {
  const calls: ChatMessage[][] = [];
  const frames: RecordStreamEvent[] = [];
  const script = new Map<number, Scripted>();
  let gate: Promise<void> | null = null;
  let running = 0;
  let most = 0;
  const engine = new DraftEngine({
    file: FILE,
    sendImages: false,
    secrets: () => [],
    settleMs: 10,
    emit: (e) => frames.push(e),
    complete: async (messages, signal) => {
      running++;
      most = Math.max(most, running);
      try {
        calls.push(messages);
        const n = calls.length;
        if (gate) {
          const g = gate;
          await new Promise<void>((resolve, reject) => {
            void g.then(resolve);
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        const scripted = script.get(n);
        if (scripted instanceof Error) throw scripted;
        if (typeof scripted === 'function') return { text: scripted(messages) };
        return { text: scripted ?? echo(messages, opts) };
      } finally {
        running--;
      }
    },
  });
  const drafts = (): Draft[] => frames.filter((f): f is Draft => f.type === 'record:draft');
  return {
    engine,
    calls,
    frames,
    drafts,
    last: () => drafts()[drafts().length - 1]!,
    script,
    hold: () => {
      let open: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    inFlight: async () => {
      const until = Date.now() + 3_000;
      while (engine.callsInFlight === 0 && Date.now() < until) await sleep(2);
    },
    maxAtOnce: () => most,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function settled(h: Harness, calls: number): Promise<void> {
  const until = Date.now() + 3_000;
  while ((h.calls.length < calls || h.engine.callsInFlight > 0) && Date.now() < until) await sleep(3);
  await sleep(40);
}

function answer(steps: string[], stepActions?: number[][], replaceFrom = 0, parameters: unknown[] = []): string {
  return JSON.stringify({ replaceFrom, steps, ...(stepActions && { stepActions }), parameters });
}

/** Draft three steps, one per action: "Step for One/Two/Three". */
async function three(h: Harness): Promise<void> {
  h.engine.addAction(act(1, 'One'));
  await settled(h, 1);
  h.engine.addAction(act(2, 'Two'));
  await settled(h, 2);
  h.engine.addAction(act(3, 'Three'));
  await settled(h, 3);
  expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Step for Three']);
}

function actionsOf(h: Harness, id: string): string[] {
  return h.engine.inspect().steps.find((s) => s.id === id)?.actions ?? [];
}

// ── Which actions a step stands for ───────────────────────────────────────

describe('the step → actions mapping', () => {
  it("the model's stepActions are kept; an event it left out rides with its action", async () => {
    const h = harness();
    h.script.set(1, answer(['Type {{email}} into the Email field', 'Click Next'], [[1], [2]]));
    h.engine.setPaused(true);
    h.engine.addAction(typed(1, 'Email'));
    h.engine.addAction(act(2, 'Next'));
    h.engine.addAction(typed(3, 'Search'));
    h.engine.addAction(act(4, 'Go'));
    h.engine.setPaused(false);
    await settled(h, 1);
    h.script.set(2, answer(['Search it'], [[]], 2));
    // (the next call is scripted below; this one covers a1..a4)
    const [first, second] = h.engine.inspect().steps;
    expect(first).toMatchObject({ id: 'd1', actions: ['a1'] });
    expect(second).toMatchObject({ id: 'd2', actions: ['a2'] });
    expect(h.last().ids).toEqual(['d1', 'd2']);
  });

  it('events left out ride with the action they came before; an unclaimed action goes with its events', async () => {
    const h = harness();
    // Step 1 claims only the click; step 2 claims only the typing.
    h.script.set(1, answer(['Click Next', 'Type {{q}} into Search'], [[2], [3]]));
    h.engine.setPaused(true);
    h.engine.addAction(typed(1, 'Email'));
    h.engine.addAction(act(2, 'Next'));
    h.engine.addAction(typed(3, 'Search'));
    h.engine.addAction(act(4, 'Go'));
    h.engine.setPaused(false);
    await settled(h, 1);
    const [first, second] = h.engine.inspect().steps;
    // The typing before Next rides with it; Go, claimed by nobody, goes with
    // the typing it followed.
    expect(first!.actions).toEqual(['a1', 'a2']);
    expect(second!.actions).toEqual(['a3', 'a4']);
  });

  it('missing: inferred from the last step back, earlier leftovers to the first — only this call\'s actions, only its steps', async () => {
    const h = harness({ mapping: false });
    h.engine.addAction(act(1, 'Start'));
    await settled(h, 1);
    expect(actionsOf(h, 'd1')).toEqual(['a1']);
    // A focus click, typing and Tab, a click: two steps.
    h.script.set(2, answer(['Type {{email}} into the Email field', 'Click Sign in'], undefined, 1));
    h.engine.setPaused(true);
    h.engine.addAction(act(2, 'Email'));
    h.engine.addAction(typed(3, 'Email'));
    h.engine.addAction(act(4, 'Tab'));
    h.engine.addAction(act(5, 'Sign in'));
    h.engine.setPaused(false);
    await settled(h, 2);
    const steps = h.engine.inspect().steps;
    expect(steps.map((s) => s.actions)).toEqual([['a1'], ['a2', 'a3', 'a4'], ['a5']]);
  });

  for (const [name, bad] of [
    ['an action in two steps', [[2], [2]]],
    ['a number this call did not show', [[1], [2]]],
    ['out of order', [[3], [2]]],
    ['one list short', [[2]]],
  ] as const) {
    it(`does not check out (${name}): inferred instead`, async () => {
      const h = harness();
      h.engine.addAction(act(1, 'Start'));
      await settled(h, 1);
      h.script.set(2, answer(['Step A', 'Step B'], bad as unknown as number[][], 1));
      h.engine.setPaused(true);
      h.engine.addAction(act(2, 'A'));
      h.engine.addAction(act(3, 'B'));
      h.engine.setPaused(false);
      await settled(h, 2);
      // a1 is an earlier call's: never given to this call's steps.
      expect(h.engine.inspect().steps.map((s) => s.actions)).toEqual([['a1'], ['a2'], ['a3']]);
    });
  }

  it('ids: kept on append and while a step stays unchanged in place; new when the model rewrites it', async () => {
    const h = harness();
    await three(h);
    expect(h.last().ids).toEqual(['d1', 'd2', 'd3']);
    // The model rewrites the last step and appends one: "Three" reworded gets
    // a new id; the append another.
    h.script.set(4, answer(['Click Three in the menu', 'Step for Four'], [[3], [4]], 2));
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Click Three in the menu', 'Step for Four']);
    expect(h.last().ids).toEqual(['d1', 'd2', 'd4', 'd5']);
    // Rewritten again, but "Click Three in the menu" comes back unchanged in
    // place: it keeps d4.
    h.script.set(5, answer(['Click Three in the menu', 'Step for Four+Five'], [[3], [4, 5]], 2));
    h.engine.addAction(act(5, 'Five'));
    await settled(h, 5);
    expect(h.last().ids).toEqual(['d1', 'd2', 'd4', 'd6']);
    // Never an action's id or an author step's.
    for (const id of h.last().ids) expect(id).toMatch(/^d\d+$/);
  });
});

// ── Edit ──────────────────────────────────────────────────────────────────

describe('an edit', () => {
  it('makes the step the author\'s at once, with no call: its text, its id, its actions; record:edited before the draft', async () => {
    const h = harness();
    await three(h);
    const calls = h.calls.length;
    const before = h.frames.length;
    expect(h.engine.editStep('d2', 'Open Payments from the side menu', { source: 'panel' })).toBe(true);
    const after = h.frames.slice(before);
    expect(after.map((f) => f.type)).toEqual(['record:edited', 'record:draft']);
    expect(after[0]).toEqual({ type: 'record:edited', id: 'd2', text: 'Open Payments from the side menu', source: 'panel' });
    expect(h.last()).toMatchObject({
      steps: ['Step for One', 'Open Payments from the side menu', 'Step for Three'],
      ids: ['d1', 'd2', 'd3'],
      edited: [1],
      authored: [],
      locked: 0,
    });
    expect(actionsOf(h, 'd2')).toEqual(['a2']);
    await sleep(60);
    expect(h.calls).toHaveLength(calls);
  });

  it('the next call shows it edited, with its actions, and may not reach back past it; nothing is written for its actions', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d2', 'Mine two', { source: 'editor' });
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    const call = h.calls[3]!;
    expect(draftEntriesOf(call)).toEqual([
      { index: 0, step: 'Step for One', actions: [1] },
      { index: 1, step: 'Mine two', edited: true, actions: [2] },
      { index: 2, step: 'Step for Three', actions: [3] },
    ]);
    expect(textOf(call)).toContain('the furthest back you may start is 2.');
    expect(textOf(call)).toContain('Steps marked "edited": true are the author\'s own rewording');
    expect(recordingOf(call).map((a) => a['n'])).toEqual([4]);
    expect(h.last().steps).toEqual(['Step for One', 'Mine two', 'Step for Three', 'Step for Four']);
  });

  it('survives a tail rewrite: an answer that reaches past it is refused, and the redraft leaves it and its actions alone', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d3', 'Mine three', { source: 'panel' });
    // The model reaches back over the edited step anyway.
    h.script.set(4, answer(['Whatever', 'Whatever else'], [[3], [4]], 2));
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 5);
    const retry = h.calls[4]!;
    // The redraft of the open steps: the edited step's action is not asked about.
    expect(recordingOf(retry).map((a) => a['target'].name)).toEqual(['One', 'Two', 'Four']);
    expect(textOf(retry)).toContain('the author also reworded these');
    expect(textOf(retry)).toContain('{"step":"Mine three","actions":[3]}');
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Mine three', 'Step for Four']);
    expect(h.last().edited).toEqual([2]);
  });

  it('survives a full redraft after an action is dropped: kept once, where its actions are', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d2', 'Mine two', { source: 'panel' });
    expect(h.engine.drop('a1')).toBe(true);
    await settled(h, 4);
    const call = h.calls[3]!;
    expect(recordingOf(call).map((a) => a['target'].name)).toEqual(['Three']);
    expect(h.last().steps).toEqual(['Mine two', 'Step for Three']);
    expect(h.last().edited).toEqual([0]);
    expect(h.last().ids[0]).toBe('d2');
  });

  it('survives a redraft of a locked stretch: that stretch alone, the edited step kept among its new steps', async () => {
    const h = harness();
    await three(h);
    await h.engine.addAuthorSteps(['Mine'], { source: 'panel', boundary: 3, atMs: 3500 });
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    h.engine.editStep('d3', 'Mine three', { source: 'panel' });
    expect(h.engine.drop('a1')).toBe(true);
    await settled(h, 5);
    const call = h.calls[4]!;
    expect(recordingOf(call).map((a) => a['target'].name)).toEqual(['Two']);
    expect(h.last().steps).toEqual(['Step for Two', 'Mine three', 'Mine', 'Step for Four']);
    expect(h.last()).toMatchObject({ edited: [1], authored: [2], locked: 3 });
  });

  it('a step the model ties only to an edited step\'s actions re-describes them (A4): it is not written', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d2', 'Mine two', { source: 'panel' });
    h.engine.drop('a1');
    h.script.set(4, (m) => {
      const n = Object.fromEntries(draftEntriesOf(m).map((e) => [e.step, e.actions]));
      void n;
      // The edited step stands for action 1 now (a1 is gone): the model writes it again anyway.
      return answer(['Click Two in the main menu', 'Step for Three'], [[1], [2]]);
    });
    await settled(h, 4);
    expect(h.last().steps).toEqual(['Mine two', 'Step for Three']);
  });

  it('an exact copy of the edited text in a redraft is not written a second time', async () => {
    const h = harness({ mapping: false });
    await three(h);
    h.engine.editStep('d2', 'Mine two', { source: 'panel' });
    h.engine.drop('a1');
    h.script.set(4, answer(['Mine two', 'Step for Three']));
    await settled(h, 4);
    expect(h.last().steps).toEqual(['Mine two', 'Step for Three']);
  });

  it('… but the same words tied to a repeat of the action are a step of their own (I10)', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d1', 'Click the Go button', { source: 'panel' });
    h.engine.addAction(act(4, 'Go'));
    await settled(h, 4);
    // A redraft: the model writes the author's words for the repeated click.
    h.script.set(5, (m) => {
      const n = recordingOf(m).find((a) => a['target'].name === 'Go')!['n'] as number;
      const others = recordingOf(m).filter((a) => a['target'].name !== 'Go').map((a) => [a['n'] as number]);
      return answer([...others.map((_x, i) => `Other ${i}`), 'Click the Go button'], [...others, [n]]);
    });
    h.engine.drop('a2');
    await settled(h, 5);
    expect(h.last().steps).toEqual(['Click the Go button', 'Other 0', 'Click the Go button']);
    expect(h.last().edited).toEqual([0]);
  });

  it("edited back to the model's exact words, it is the model's again", async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d3', 'Mine three', { source: 'panel' });
    expect(h.last().edited).toEqual([2]);
    expect(h.engine.editStep('d3', 'Step for Three', { source: 'panel' })).toBe(true);
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Step for Two', 'Step for Three'], edited: [] });
    // …and the model may rewrite it again.
    h.script.set(4, answer(['Three and four'], [[3, 4]], 2));
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Three and four']);
  });

  it("of a step the author wrote replaces its text; twice in a row, the second wins; the same text is no change", async () => {
    const h = harness();
    h.engine.addAction(act(1, 'One'));
    await settled(h, 1);
    await h.engine.addAuthorSteps(['Mine'], { source: 'toolbar', boundary: 1, atMs: 1500 });
    expect(h.engine.editStep('s1', 'Mine, reworded', { source: 'toolbar' })).toBe(true);
    expect(h.engine.editStep('s1', 'Mine, reworded again', { source: 'editor' })).toBe(true);
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Mine, reworded again'], authored: [1], ids: ['d1', 's1'] });
    expect(h.engine.editStep('s1', 'Mine, reworded again', { source: 'editor' })).toEqual({
      ignored: 'The step already reads that way.',
    });
  });

  it("of a step the model rewrote meanwhile: takes over only the actions it named, under that id; the rest is redrafted into a step of its own", async () => {
    const h = harness();
    h.engine.addAction(act(1, 'Menu'));
    await settled(h, 1);
    expect(h.last().ids).toEqual(['d1']);
    // The next action changes what the first meant: one step for both.
    h.script.set(2, answer(['Click Payments in the main menu'], [[1, 2]], 0));
    h.engine.addAction(act(2, 'Payments'));
    await settled(h, 2);
    expect(h.last()).toMatchObject({ steps: ['Click Payments in the main menu'], ids: ['d2'] });
    // The author's edit of "Click Menu", typed against the draft before. The
    // Payments click is not theirs to take: the author never saw it in d1.
    expect(h.engine.editStep('d1', 'Open the Payments menu', { source: 'editor' })).toBe(true);
    expect(h.last()).toMatchObject({ ids: ['d1', 'd2'], edited: [0] });
    expect(actionsOf(h, 'd1')).toEqual(['a1']);
    expect(actionsOf(h, 'd2')).toEqual(['a2']);
    // …and the merged step's words no longer fit: its stretch is redrafted.
    await settled(h, 3);
    expect(recordingOf(h.calls[2]!).map((a) => a['target'].name)).toEqual(['Payments']);
    expect(h.last()).toMatchObject({ steps: ['Open the Payments menu', 'Step for Payments'], edited: [0] });
  });

  it('from two sources for one step — the drawer, then the file naming the id the model has since rewritten — each keeps its own words, once', async () => {
    const h = harness();
    h.engine.addAction(act(1, 'Menu'));
    await settled(h, 1);
    h.script.set(2, answer(['Click Payments in the main menu'], [[1, 2]], 0));
    h.engine.addAction(act(2, 'Payments'));
    await settled(h, 2);
    expect(h.engine.editStep('d2', 'From the drawer', { source: 'toolbar' })).toBe(true);
    expect(h.engine.editStep('d1', 'From the file', { source: 'editor' })).toBe(true);
    // The file's edit named d1, which stood for the Menu click alone; the
    // drawer's words stay the author's, for what is left of theirs.
    expect(h.last()).toMatchObject({ steps: ['From the file', 'From the drawer'], ids: ['d1', 'd2'], edited: [0, 1] });
    expect(actionsOf(h, 'd1')).toEqual(['a1']);
    expect(actionsOf(h, 'd2')).toEqual(['a2']);
    await sleep(60);
    expect(h.calls).toHaveLength(2);
  });

  it('while an ordinary call that rewrites it is in flight: that answer is thrown away and asked again; the edit stands', async () => {
    const h = harness();
    await three(h);
    const open = h.hold();
    h.script.set(4, answer(['Rewritten three', 'Step for Four'], [[3], [4]], 2));
    h.engine.addAction(act(4, 'Four'));
    await h.inFlight();
    expect(h.engine.editStep('d3', 'Mine three', { source: 'editor' })).toBe(true);
    open();
    await settled(h, 5);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Mine three', 'Step for Four']);
    expect(h.drafts().every((d) => !d.steps.includes('Rewritten three'))).toBe(true);
    expect(h.maxAtOnce()).toBe(1);
  });

  it('while an ordinary call that does NOT reach it is in flight: the answer lands, around it', async () => {
    const h = harness();
    await three(h);
    const open = h.hold();
    h.engine.addAction(act(4, 'Four'));
    await h.inFlight();
    h.engine.editStep('d1', 'Mine one', { source: 'editor' });
    expect(h.engine.drop('d2')).toBe(true); // a delete before the tail moves every index
    open();
    await settled(h, 4);
    expect(h.calls).toHaveLength(4);
    expect(h.last().steps).toEqual(['Mine one', 'Step for Three', 'Step for Four']);
  });

  it('while a redraft of its stretch is in flight: the redraft is made again without its actions', async () => {
    const h = harness();
    await three(h);
    const open = h.hold();
    h.engine.drop('a1');
    await h.inFlight();
    expect(h.engine.editStep('d2', 'Mine two', { source: 'panel' })).toBe(true);
    open();
    await settled(h, 5);
    expect(recordingOf(h.calls[h.calls.length - 1]!).map((a) => a['target'].name)).toEqual(['Three']);
    expect(h.last().steps).toEqual(['Mine two', 'Step for Three']);
  });

  it('cannot apply to an unknown id, a deleted step, or one whose actions no step stands for any more', async () => {
    const h = harness();
    await three(h);
    expect(h.engine.editStep('d99', 'x', { source: 'panel' })).toEqual({ ignored: 'The recording has no step with that id.' });
    h.engine.drop('d2');
    expect(h.engine.editStep('d2', 'x', { source: 'panel' })).toMatchObject({ ignored: expect.stringContaining('deleted') });
    // d3's action dropped, and the redraft wrote nothing for it: d3 is gone and nothing stands for a3.
    h.engine.drop('a3');
    await settled(h, 4);
    expect(h.engine.editStep('d3', 'x', { source: 'panel' })).toMatchObject({
      ignored: expect.stringContaining('No step stands for the actions'),
    });
  });

  it("an edit whose actions are all dropped since is kept — the author's words are never lost — and is in the result", async () => {
    const h = harness();
    h.engine.addAction(act(1, 'One'));
    await settled(h, 1);
    h.engine.editStep('d1', 'Mine one', { source: 'panel' });
    h.engine.drop('a1');
    await settled(h, 1);
    expect(h.last().steps).toEqual(['Mine one']);
    expect(h.engine.editedCount).toBe(1);
    h.engine.close();
    expect((await h.engine.finish()).steps).toEqual(['Mine one']);
  });
});

// ── Delete and restore ────────────────────────────────────────────────────

describe('a delete', () => {
  it('takes the step out at once, with no call, and drops its actions — the typing that rode with them included; record:dropped first', async () => {
    const h = harness();
    h.engine.addAction(act(1, 'One'));
    await settled(h, 1);
    h.engine.addAction(typed(2, 'Search', 'shoes'));
    h.engine.addAction(act(3, 'Go'));
    await settled(h, 2);
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 3);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Search+Go', 'Step for Four']);
    const calls = h.calls.length;
    const before = h.frames.length;
    expect(h.engine.drop('d2', 'toolbar')).toBe(true);
    const after = h.frames.slice(before);
    expect(after.map((f) => f.type)).toEqual(['record:dropped', 'record:draft']);
    expect(after[0]).toEqual({ type: 'record:dropped', id: 'd2', dropped: true, source: 'toolbar', actions: ['a2', 'a3'] });
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Step for Four'], ids: ['d1', 'd3'] });
    expect(h.engine.inspect().dropped.sort()).toEqual(['a2', 'a3']);
    await sleep(60);
    expect(h.calls).toHaveLength(calls);
    // Twice: nothing more to do.
    expect(h.engine.drop('d2')).toBe(false);
  });

  it('no later redraft brings it back: its actions are never shown to the model again', async () => {
    const h = harness();
    await three(h);
    h.engine.drop('d2');
    h.engine.drop('a1'); // a redraft of everything that is left
    await settled(h, 4);
    expect(recordingOf(h.calls[3]!).map((a) => a['target'].name)).toEqual(['Three']);
    expect(h.last().steps).toEqual(['Step for Three']);
  });

  it('Restore with nothing changed since: exactly where it was, same id, its actions back — no call', async () => {
    const h = harness();
    await three(h);
    const calls = h.calls.length;
    h.engine.drop('d2', 'editor');
    const before = h.frames.length;
    expect(h.engine.restore('d2', 'editor')).toBe(true);
    const after = h.frames.slice(before);
    expect(after.map((f) => f.type)).toEqual(['record:dropped', 'record:draft']);
    expect(after[0]).toEqual({ type: 'record:dropped', id: 'd2', dropped: false, source: 'editor', actions: ['a2'] });
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Step for Two', 'Step for Three'], ids: ['d1', 'd2', 'd3'] });
    expect(h.engine.inspect().dropped).toEqual([]);
    await sleep(60);
    expect(h.calls).toHaveLength(calls);
    // Covered as it was: the next call is about the next action only.
    h.engine.addAction(act(4, 'Four'));
    await settled(h, calls + 1);
    expect(recordingOf(h.calls[calls]!).map((a) => a['n'])).toEqual([4]);
  });

  it('Restore after the draft moved on: after the step that was before it — else where its actions are', async () => {
    const h = harness();
    await three(h);
    h.engine.drop('d2');
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    expect(h.engine.restore('d2')).toBe(true);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Step for Three', 'Step for Four']);
    // The step before it gone (its action dropped, so the model rewrote the rest):
    h.engine.drop('d2');
    h.engine.drop('a1');
    await settled(h, 5);
    expect(h.last().steps).toEqual(['Step for Three', 'Step for Four']);
    expect(h.engine.restore('d2')).toBe(true);
    expect(h.last().steps).toEqual(['Step for Two', 'Step for Three', 'Step for Four']);
  });

  it('one of its actions restored on its own is redrafted into a step of its own; the deleted step then cannot come back as it was', async () => {
    const h = harness();
    h.engine.addAction(act(1, 'One'));
    await settled(h, 1);
    h.engine.addAction(typed(2, 'Search'));
    h.engine.addAction(act(3, 'Go'));
    await settled(h, 2);
    h.engine.drop('d2');
    expect(h.engine.restore('a3')).toBe(true);
    await settled(h, 3);
    expect(recordingOf(h.calls[2]!).map((a) => a['target'].name)).toEqual(['One', 'Go']);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Go']);
    expect(h.engine.restore('d2')).toMatchObject({ ignored: expect.stringContaining('restored on their own') });
    expect(h.last().steps).toEqual(['Step for One', 'Step for Go']);
  });

  it('while an ordinary call that rewrites it is in flight: that answer is thrown away, and the step never comes back', async () => {
    const h = harness();
    await three(h);
    const open = h.hold();
    h.script.set(4, answer(['Rewritten three', 'Step for Four'], [[3], [4]], 2));
    h.engine.addAction(act(4, 'Four'));
    await h.inFlight();
    expect(h.engine.drop('d3')).toBe(true);
    open();
    await settled(h, 5);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Step for Four']);
    expect(h.drafts().every((d) => !d.steps.includes('Rewritten three'))).toBe(true);
  });

  it("of a step the model rewrote meanwhile: drops only the actions it named — the rest is redrafted — and Restore puts it back as the author saw it", async () => {
    const h = harness();
    h.engine.addAction(act(1, 'Menu'));
    await settled(h, 1);
    h.script.set(2, answer(['Click Payments in the main menu'], [[1, 2]], 0));
    h.engine.addAction(act(2, 'Payments'));
    await settled(h, 2);
    const before = h.frames.length;
    expect(h.engine.drop('d1', 'editor')).toBe(true);
    expect(h.frames.slice(before)[0]).toEqual({
      type: 'record:dropped', id: 'd1', dropped: true, source: 'editor', actions: ['a1'],
    });
    expect(h.engine.inspect().dropped).toEqual(['a1']);
    await settled(h, 3);
    expect(recordingOf(h.calls[2]!).map((a) => a['target'].name)).toEqual(['Payments']);
    expect(h.last().steps).toEqual(['Step for Payments']);
    expect(h.engine.restore('d1')).toBe(true);
    expect(h.last()).toMatchObject({ steps: ['Step for Menu', 'Step for Payments'] });
    expect(h.last().ids[0]).toBe('d1');
    expect(h.engine.inspect().dropped).toEqual([]);
  });

  it('a parameter no step uses any more leaves the list — after a delete, and after an edit', async () => {
    const h = harness();
    h.script.set(
      1,
      answer(['Type {{search}} into the Search field', 'Type {{email}} into the Email field'], [[1], [2]], 0, [
        { name: 'search', value: 'shoes' },
        { name: 'email', value: 'a@b.test' },
      ]),
    );
    h.engine.setPaused(true);
    h.engine.addAction(act(1, 'Search'));
    h.engine.addAction(act(2, 'Email'));
    h.engine.setPaused(false);
    await settled(h, 1);
    expect(h.last().parameters.map((p) => p.name)).toEqual(['search', 'email']);
    h.engine.drop('d1');
    expect(h.last().parameters.map((p) => p.name)).toEqual(['email']);
    h.engine.editStep('d2', 'Type demo into the Email field', { source: 'panel' });
    expect(h.last().parameters).toEqual([]);
    // An edit naming a {{name}} no parameter defines is the author's business: written as it is.
    h.engine.editStep('d2', 'Type {{login}} into the Email field', { source: 'panel' });
    expect(h.last().steps).toEqual(['Type {{login}} into the Email field']);
    expect(h.last().notes?.join(' ')).toContain('{{login}}');
  });

  it("of a step the author reworded: Restore brings the author's words back, still theirs", async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d2', 'Mine two', { source: 'panel' });
    h.engine.drop('d2');
    expect(h.last().steps).toEqual(['Step for One', 'Step for Three']);
    h.engine.restore('d2');
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Mine two', 'Step for Three'], edited: [1] });
  });

  it("of a step the author wrote is Undo's drop: out at once, its lock lifted", async () => {
    const h = harness();
    await three(h);
    await h.engine.addAuthorSteps(['Mine'], { source: 'panel', boundary: 3, atMs: 3500 });
    expect(h.last().locked).toBe(4);
    expect(h.engine.drop('s1', 'toolbar')).toBe(true);
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Step for Two', 'Step for Three'], locked: 0 });
  });
});

describe('an author step that waited for a call which drafted actions recorded after it (property run, seed 46)', () => {
  /** a1 drafted; a2's call held open; the author's step sent (at `boundary`
   *  2); a3 arrives; the held call's answer is refused, and its retry — a
   *  redraft of the open steps — takes a3 in too. */
  async function raced(h: Harness, afterStep: number | undefined): Promise<void> {
    h.engine.addAction(act(1, 'One'));
    await settled(h, 1);
    const open = h.hold();
    h.script.set(2, JSON.stringify({ steps: ['No replaceFrom'], parameters: [] }));
    h.engine.addAction(act(2, 'Two'));
    await h.inFlight();
    const adding = h.engine.addAuthorSteps(['Mine'], {
      source: afterStep === undefined ? 'panel' : 'editor',
      boundary: 2,
      atMs: 2500,
      ...(afterStep !== undefined && { afterStep, revision: h.engine.currentRevision }),
    });
    h.engine.addAction(act(3, 'Three'));
    open();
    await adding;
    await settled(h, 3);
  }

  it('between two steps: every step drafted so far stays where it is, and nothing is written twice', async () => {
    const h = harness();
    await raced(h, 0);
    expect(h.last().steps).toEqual(['Step for One', 'Mine', 'Step for Two', 'Step for Three']);
    expect(h.calls).toHaveLength(3);
  });

  it('at the end: the step drafted for the later action goes below the line, as it is — no second copy, no call', async () => {
    const h = harness();
    await raced(h, undefined);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Mine', 'Step for Three']);
    expect(h.calls).toHaveLength(3);
    // …and it is open again below the line: the next action may still fold into it.
    h.script.set(4, answer(['Three and four'], [[3, 4]], 3));
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Mine', 'Three and four']);
  });
});

describe('Stop', () => {
  it('writes the draft with every edit and delete in it, exactly', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d1', 'Mine one', { source: 'editor' });
    h.engine.drop('d2');
    h.engine.addAction(act(4, 'Four'));
    h.engine.close();
    const result = await h.engine.finish();
    expect(result.steps).toEqual(['Mine one', 'Step for Three', 'Step for Four']);
  });
});

// ── Review round 2 (the server half's findings) ──────────────────────────

describe('restoring steps deleted one after another (review, finding 1)', () => {
  async function four(h: Harness): Promise<void> {
    for (const [n, name] of [[1, 'One'], [2, 'Two'], [3, 'Three'], [4, 'Four']] as const) {
      h.engine.addAction(act(n, name));
      await settled(h, n);
    }
  }

  it('two neighbours deleted top to bottom and restored in that order go back in recording order — in the draft and the result', async () => {
    const h = harness();
    await four(h);
    expect(h.engine.drop('d2')).toBe(true);
    expect(h.engine.drop('d3')).toBe(true);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Four']);
    expect(h.engine.restore('d2')).toBe(true);
    expect(h.engine.restore('d3')).toBe(true);
    const all = ['Step for One', 'Step for Two', 'Step for Three', 'Step for Four'];
    expect(h.last()).toMatchObject({ steps: all, ids: ['d1', 'd2', 'd3', 'd4'] });
    h.engine.close();
    expect((await h.engine.finish()).steps).toEqual(all);
  });

  it('… and with a step landing between the two deletes', async () => {
    const h = harness();
    await four(h);
    h.engine.drop('d2');
    h.engine.addAction(act(5, 'Five'));
    await settled(h, 5);
    h.engine.drop('d3');
    h.engine.restore('d2');
    h.engine.restore('d3');
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Step for Three', 'Step for Four', 'Step for Five']);
  });
});

describe('a focus click the model folded into the typing after it (review, finding 2)', () => {
  it('goes with the step that claimed the typing into the same field; deleting that step drops it; no redraft brings it back', async () => {
    const h = harness();
    // As a real model answers: the typing is the step; the click into the field is folded away.
    h.script.set(1, answer(['Click One', 'Type {{email}} into the Email field'], [[1], [3]]));
    h.engine.setPaused(true);
    h.engine.addAction(act(1, 'One'));
    h.engine.addAction(focusClick(2, 'Email'));
    h.engine.addAction(typed(3, 'Email', 'a@b.test'));
    h.engine.addAction(keyIn(4, 'Email'));
    h.engine.setPaused(false);
    await settled(h, 1);
    expect(actionsOf(h, 'd2')).toEqual(['a2', 'a3', 'a4']);
    const before = h.frames.length;
    expect(h.engine.drop('d2')).toBe(true);
    expect(h.frames.slice(before)[0]).toEqual({
      type: 'record:dropped', id: 'd2', dropped: true, source: 'panel', actions: ['a2', 'a3', 'a4'],
    });
    h.engine.addAction(act(5, 'Next'));
    await settled(h, 2);
    // A redraft of everything left: the click into the field is not in it.
    h.engine.drop('a1');
    await settled(h, 3);
    expect(recordingOf(h.calls[2]!).map((a) => a['target'].name)).toEqual(['Next']);
    expect(h.last().steps).toEqual(['Step for Next']);
  });

  it('one no step claimed, just before a deleted step\'s first action on the same field, is dropped with it — and Restore puts it back', async () => {
    const h = harness();
    h.engine.addAction(act(1, 'One'));
    await settled(h, 1);
    // The click into the field is drafted on its own call, and folded away.
    h.script.set(2, answer([], [], 1));
    h.engine.addAction(focusClick(2, 'Email'));
    await settled(h, 2);
    expect(h.last().steps).toEqual(['Step for One']);
    h.engine.addAction(typed(3, 'Email'));
    h.engine.addAction(keyIn(4, 'Email'));
    await settled(h, 3);
    expect(actionsOf(h, 'd2')).toEqual(['a3', 'a4']);
    const before = h.frames.length;
    expect(h.engine.drop('d2')).toBe(true);
    expect(h.frames.slice(before)[0]).toEqual({
      type: 'record:dropped', id: 'd2', dropped: true, source: 'panel', actions: ['a2', 'a3', 'a4'],
    });
    expect(h.engine.restore('d2')).toBe(true);
    expect(h.engine.inspect().dropped).toEqual([]);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Email+Email']);
    // Deleted again, then a redraft of what is left: the click is not in it.
    h.engine.drop('d2');
    h.engine.addAction(act(5, 'Next'));
    await settled(h, 4);
    h.engine.drop('a1');
    await settled(h, 5);
    expect(recordingOf(h.calls[4]!).map((a) => a['target'].name)).toEqual(['Next']);
  });

  it('a click on another element before the step is not taken', async () => {
    const h = harness();
    h.engine.addAction(act(1, 'One'));
    await settled(h, 1);
    h.script.set(2, answer([], [], 1));
    h.engine.addAction(act(2, 'Search'));
    await settled(h, 2);
    h.engine.addAction(typed(3, 'Email'));
    h.engine.addAction(keyIn(4, 'Email'));
    await settled(h, 3);
    const before = h.frames.length;
    h.engine.drop('d2');
    expect(h.frames.slice(before)[0]).toMatchObject({ id: 'd2', actions: ['a3', 'a4'] });
  });
});

describe('an edit or a delete naming a step the model has since merged into another (review, finding 3)', () => {
  /** d1..d3 for One..Three; then the model merges Two and Four into one step. */
  async function merged(h: Harness): Promise<void> {
    await three(h);
    h.script.set(4, answer(['Click Two, then Four'], [[2, 4]], 1));
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    expect(h.last()).toMatchObject({ steps: ['Step for One', 'Click Two, then Four'], ids: ['d1', 'd4'] });
  }

  it("an edit takes over only the actions the named step stood for; the merged step's others are redrafted into a step — none is lost", async () => {
    const h = harness();
    await merged(h);
    expect(h.engine.editStep('d2', 'Click the Two button', { source: 'editor' })).toBe(true);
    expect(actionsOf(h, 'd2')).toEqual(['a2']);
    await settled(h, 5);
    // The redraft is not asked about the edited step's click, and not shown the merged words as the author's.
    expect(recordingOf(h.calls[4]!).map((a) => a['target'].name)).toEqual(['One', 'Three', 'Four']);
    expect(h.last()).toMatchObject({
      steps: ['Step for One', 'Click the Two button', 'Step for Three', 'Step for Four'],
      edited: [1],
    });
    expect(h.drafts().at(-1)!.steps).not.toContain('Click Two, then Four');
    h.engine.addAction(act(5, 'Five'));
    await settled(h, 6);
    h.engine.close();
    expect((await h.engine.finish()).steps).toEqual([
      'Step for One', 'Click the Two button', 'Step for Three', 'Step for Four', 'Step for Five',
    ]);
  });

  it('a delete drops only those actions — the rest is redrafted — and Restore puts the step back as the author saw it', async () => {
    const h = harness();
    await merged(h);
    const before = h.frames.length;
    expect(h.engine.drop('d2', 'editor')).toBe(true);
    expect(h.frames.slice(before)[0]).toEqual({
      type: 'record:dropped', id: 'd2', dropped: true, source: 'editor', actions: ['a2'],
    });
    expect(h.engine.inspect().dropped).toEqual(['a2']);
    await settled(h, 5);
    expect(recordingOf(h.calls[4]!).map((a) => a['target'].name)).toEqual(['One', 'Three', 'Four']);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Three', 'Step for Four']);
    expect(h.engine.restore('d2')).toBe(true);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'Step for Three', 'Step for Four']);
    expect(h.engine.inspect().dropped).toEqual([]);
  });
});

describe('an ordinary call that re-describes a reworded step (review, finding 8)', () => {
  it('a step the answer ties only to the reworded step\'s action is not written', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d3', 'My words for Three', { source: 'panel' });
    h.script.set(4, answer(['Click Three', 'Step for Four'], [[3], [4]], 3));
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'My words for Three', 'Step for Four']);
    expect(actionsOf(h, h.last().ids[3]!)).toEqual(['a4']);
  });

  it('with no mapping that holds up, an exact copy of its words is not written', async () => {
    const h = harness();
    await three(h);
    h.engine.editStep('d3', 'My words for Three', { source: 'panel' });
    h.script.set(4, answer(['My words for Three', 'Step for Four'], undefined, 3));
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    expect(h.last().steps).toEqual(['Step for One', 'Step for Two', 'My words for Three', 'Step for Four']);
  });
});

describe("an edit of a step of the author's while a redraft of its stretch is in flight (review, finding 9)", () => {
  it('throws that answer away: no copy of the old words is written beside the new ones', async () => {
    const h = harness();
    await three(h);
    await h.engine.addAuthorSteps(['Verify the total'], { source: 'editor', boundary: 3, atMs: 3500 });
    h.engine.addAction(act(4, 'Four'));
    await settled(h, 4);
    const open = h.hold();
    const n0 = h.calls.length;
    h.engine.drop('a1');
    await h.inFlight();
    // The model, shown the author's step, copies its words as they were when it was asked.
    h.script.set(n0 + 1, answer(['Step for Two', 'Step for Three', 'Verify the total'], [[1], [2], []], 0));
    expect(h.engine.editStep('s1', 'Verify the order total is 12', { source: 'editor' })).toBe(true);
    const since = h.drafts().length;
    open();
    await settled(h, n0 + 2);
    expect(h.last().steps).toEqual(['Step for Two', 'Step for Three', 'Verify the order total is 12', 'Step for Four']);
    expect(h.drafts().slice(since).every((d) => !d.steps.includes('Verify the total'))).toBe(true);
  });
});

describe('a lone number or list marker (review, finding 10)', () => {
  it('is no step: an edit of it is a delete, an Add step of it adds nothing', () => {
    for (const t of ['3.', ' 3. ', '12)', '-', '* ', '+', '1)\n-']) expect(authorStepLines(t)).toEqual([]);
    expect(authorStepLines('3. Click Go')).toEqual(['Click Go']);
    expect(authorStepLines('-5 degrees is the limit')).toEqual(['-5 degrees is the limit']);
    expect(authorStepLines('3.5 kg')).toEqual(['3.5 kg']);
  });
});

// ── The prompt and the answer ─────────────────────────────────────────────

describe('the prompt and the answer (stepActions)', () => {
  it('the rules: the answer carries stepActions; each draft step lists its actions; A4 for a rewording', () => {
    for (const rule of [
      '"stepActions": [[<n>], [<n>, <n>]]',
      '"stepActions": beside "steps", one list for each step you write',
      'An action goes in one step at most, in the order the author acted.',
      'A4. A step marked "edited" is the author\'s own rewording of a step: keep it exactly as it is, never write another step for the actions it lists, and never reach back past it.',
    ]) {
      expect(RECORD_STEPS_SYSTEM).toContain(rule);
    }
    expect(RECORD_STEPS_SYSTEM).not.toContain('\\');
  });

  it('numbers each action as given; an inserting call lists the reworded steps inside it with their actions', () => {
    const [, user] = buildRecordStepsPrompt({
      file: FILE,
      includeImages: false,
      secrets: ['s3cr3t-pw'],
      actions: [act(5, 'Five'), act(7, 'Seven')],
      actionNumbers: [2, 4],
      draft: {
        steps: ['Edge'],
        parameters: [],
        locked: 1,
        authored: [0],
        insertAt: 0,
        stepActions: [null],
        alsoEdited: [{ step: 'Type s3cr3t-pw into the box', actions: [3] }],
      },
    });
    const text = textOf([user!]);
    expect(recordingOf([user!]).map((a) => a['n'])).toEqual([2, 4]);
    expect(text).toContain('the author also reworded these; each stands for the actions it lists, which are left out of the recording below.');
    expect(text).toContain('[{"step":"Type *** into the box","actions":[3]}]');
    expect(text).not.toContain('s3cr3t-pw');
    // An author step lists no actions.
    expect(draftEntriesOf([user!])).toEqual([{ yourStepsGoHere: true }, { index: 0, step: 'Edge', locked: true, author: true }]);
  });

  it('parseDraftAnswer reads stepActions parallel to the steps it keeps; anything else is undefined', () => {
    expect(
      parseDraftAnswer('{"replaceFrom":0,"steps":["A","","B"],"stepActions":[[1],[2],[3,4]]}').stepActions,
    ).toEqual([[1], [3, 4]]);
    expect(parseDraftAnswer('{"steps":["A"]}').stepActions).toBeUndefined();
    expect(parseDraftAnswer('{"steps":["A"],"stepActions":[[0]]}').stepActions).toBeUndefined();
    expect(parseDraftAnswer('{"steps":["A"],"stepActions":[["1"]]}').stepActions).toBeUndefined();
    expect(parseDraftAnswer('{"steps":["A","B"],"stepActions":[[1]]}').stepActions).toBeUndefined();
    expect(parseDraftAnswer('{"steps":["A"],"stepActions":[[]]}').stepActions).toEqual([[]]);
  });
});

// ── A random interleaving ─────────────────────────────────────────────────

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The model, at random: appends or rewrites up to the furthest it may, says
 * which actions each step stands for — rightly, not at all, or wrongly — takes
 * its time, and sometimes fails. Every step it writes is "M<k> …", unique.
 */
function randomModel(r: () => number): (messages: ChatMessage[], signal: AbortSignal) => Promise<{ text: string }> {
  let k = 0;
  return async (messages, signal) => {
    const delay = Math.floor(r() * 5);
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        }, { once: true });
      });
    }
    if (r() < 0.05) throw new Error('503 scripted failure');
    const text = textOf(messages);
    const recording = recordingOf(messages);
    const entries = draftEntriesOf(messages).filter((e) => typeof e['step'] === 'string');
    const insert = /answer with replaceFrom (\d+)/.exec(text);
    const floorMatch = /the furthest back you may start is (\d+)/.exec(text);
    let replaceFrom: number;
    let reclaimed: number[] = [];
    if (insert) {
      replaceFrom = Number(insert[1]);
    } else {
      const length = entries.length;
      const floor = floorMatch ? Number(floorMatch[1]) : length;
      const roll = r();
      // Mostly append; sometimes rewrite the tail it may; now and then reach too far.
      replaceFrom = roll < 0.6 ? length : roll < 0.9 ? floor : Math.max(0, floor - 1);
      for (const e of entries.slice(replaceFrom)) reclaimed.push(...((e['actions'] as number[] | undefined) ?? []));
    }
    const numbers = [...new Set([...reclaimed, ...recording.map((a) => a['n'] as number)])].sort((a, b) => a - b);
    const steps: string[] = [];
    const stepActions: number[][] = [];
    let i = 0;
    while (i < numbers.length) {
      const size = 1 + Math.floor(r() * 2);
      const group = numbers.slice(i, i + size);
      i += size;
      if (r() < 0.15) continue; // folded away: no step for these
      steps.push(`M${++k} for ${group.join(',')}`);
      stepActions.push(group);
    }
    const mapping = r();
    const said =
      mapping < 0.6
        ? stepActions
        : mapping < 0.8
          ? undefined
          : stepActions.map((l) => l.map((n) => n + (r() < 0.5 ? 1 : 0)));
    return { text: JSON.stringify({ replaceFrom, steps, ...(said && { stepActions: said }), parameters: [] }) };
  };
}


describe('a random interleaving of actions, drops, restores, author steps, edits, deletes and the model', () => {
  const SEEDS = 150;

  it(`holds its invariants over ${SEEDS} seeds`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      const frames: RecordStreamEvent[] = [];
      let running = 0;
      let most = 0;
      /** True while one of the author's own operations runs: the only time
       *  an edited step may leave the draft. */
      let inOp = false;
      const authorDrafts = new WeakSet<object>();
      /** Recorded actions a step delete dropped: never shown to the model again
       *  until they come back. */
      const dead = new Set<string>();
      const model = randomModel(r);
      /** What happened, in order: the author's operations and the frames. */
      const log: string[] = [];
      const fail = (why: string): never => {
        throw new Error(`seed ${seed}: ${why}\n${log.join('\n')}`);
      };
      const engine = new DraftEngine({
        file: FILE,
        sendImages: false,
        secrets: () => [],
        settleMs: 2,
        emit: (e) => {
          frames.push(e);
          log.push(e.type === 'record:draft' ? `  draft ${e.revision}: ${JSON.stringify(e.steps.map((t, i) => `${e.ids[i]}=${t}`))} locked ${e.locked}` : `  ${JSON.stringify(e)}`);
          if (e.type === 'record:draft' && inOp) authorDrafts.add(e);
        },
        complete: async (messages, signal) => {
          running++;
          most = Math.max(most, running);
          try {
            // A deleted step's actions are never asked about.
            for (const a of recordingOf(messages)) {
              const id = `a${String(a['target']?.name ?? '').slice(1)}`;
              if (dead.has(id)) fail(`${id}, dropped by a step delete, was shown to the model`);
            }
            return await model(messages, signal);
          } finally {
            running--;
          }
        },
      });
      const op = <T>(label: string, fn: () => T): T => {
        inOp = true;
        try {
          const out = fn();
          log.push(`${label} -> ${JSON.stringify(out)}  books: ${JSON.stringify(engine.inspect().steps.map((x) => `${x.id}:${x.actions.join(',')}`))} dropped ${engine.inspect().dropped.join(',')}`);
          return out;
        } finally {
          inOp = false;
        }
      };

      /** Each edited id's latest text, from `record:edited`. */
      const latest = new Map<string, string>();
      /** Step deletes still in force: id → the actions they dropped. */
      const deleted = new Map<string, string[]>();
      let lastDraft: Draft | null = null;
      let seen = 0;

      const check = (): void => {
        for (; seen < frames.length; seen++) {
          const f = frames[seen]!;
          if (f.type === 'record:edited') {
            latest.set(f.id, f.text);
            continue;
          }
          if (f.type === 'record:dropped' && f.actions !== undefined) {
            if (f.dropped) {
              deleted.set(f.id, f.actions);
              for (const a of f.actions) dead.add(a);
            } else {
              deleted.delete(f.id);
              for (const a of f.actions) dead.delete(a);
            }
            continue;
          }
          if (f.type !== 'record:draft') continue;
          const d = f;
          if (d.ids.length !== d.steps.length) fail('ids not parallel to steps');
          if (new Set(d.ids).size !== d.ids.length) fail(`an id twice: ${JSON.stringify(d.ids)}`);
          d.ids.forEach((id, i) => {
            if (d.authored.includes(i) ? !/^s\d+$/.test(id) : !/^d\d+$/.test(id)) fail(`id ${id} at ${i}`);
          });
          d.edited.forEach((i) => {
            if (d.authored.includes(i)) fail(`step ${i} both the author's and reworded`);
          });
          // Never written twice.
          const edits = d.steps.filter((s) => s.startsWith('Edit#'));
          if (new Set(edits).size !== edits.length) fail(`an edit written twice: ${JSON.stringify(d.steps)}`);
          // Never undone: a step that was edited shows the latest text it was given.
          d.ids.forEach((id, i) => {
            const text = latest.get(id);
            if (text !== undefined && d.steps[i] !== text) fail(`the edit of ${id} reads "${d.steps[i]}", not "${text}"`);
          });
          // Never lost: an edited step leaves only in a draft of the author's own doing.
          if (lastDraft) {
            const before = lastDraft;
            before.ids.forEach((id, i) => {
              if (!before.steps[i]!.startsWith('Edit#')) return;
              if (!d.ids.includes(id) && !authorDrafts.has(d)) fail(`the edit ${before.steps[i]} vanished on its own`);
            });
          }
          // Deleted steps stay out.
          for (const id of deleted.keys()) if (d.ids.includes(id)) fail(`deleted ${id} is back`);
          lastDraft = d;
        }
        // The engine's own books: no action in two steps.
        const owner = new Map<string, string>();
        const snapshot = engine.inspect();
        const dropped = new Set(snapshot.dropped);
        for (const s of snapshot.steps) {
          for (const a of s.actions) {
            if (dropped.has(a)) continue;
            if (owner.has(a)) fail(`${a} in ${owner.get(a)} and ${s.id}`);
            owner.set(a, s.id);
          }
        }
      };

      const liveIds = (): string[] => engine.inspect().steps.map((s) => s.id);
      const pick = <T>(list: readonly T[]): T | undefined =>
        list.length > 0 ? list[Math.floor(r() * list.length)] : undefined;
      const everIds = new Set<string>();
      let n = 0;
      let editSeq = 0;

      for (let step = 0; step < 45; step++) {
        for (const id of liveIds()) everIds.add(id);
        const roll = r();
        if (roll < 0.34) {
          n++;
          const a = r() < 0.3 ? typed(n, `F${n}`) : act(n, `B${n}`);
          log.push(`action ${a.id}${a.action ? '' : ' (event)'}`);
          engine.addAction(a);
        } else if (roll < 0.42) {
          const id = `a${1 + Math.floor(r() * Math.max(1, n))}`;
          op(`drop ${id}`, () => engine.drop(id));
        } else if (roll < 0.48) {
          const id = `a${1 + Math.floor(r() * Math.max(1, n))}`;
          if (op(`restore ${id}`, () => engine.restore(id)) === true) dead.delete(id);
        } else if (roll < 0.53) {
          const steps = liveIds();
          const between = r() < 0.5 && steps.length > 1;
          log.push(`author step ${between ? 'between' : 'at the end'}`);
          void engine.addAuthorSteps([`Author ${step}`], {
            source: between ? 'editor' : 'panel',
            boundary: engine.recordedCount,
            atMs: n * 1000 + 1,
            ...(between && { afterStep: Math.floor(r() * (steps.length - 1)), revision: engine.currentRevision }),
          });
        } else if (roll < 0.72) {
          // An edit: of a step there now, or of an id the model has since rewritten.
          const id = r() < 0.75 ? pick(liveIds()) : pick([...everIds]);
          if (id) {
            const text = `Edit#${++editSeq}`;
            const source = r() < 0.5 ? 'editor' : 'toolbar';
            op(`edit ${id} ${text}`, () => engine.editStep(id, text, { source }));
          }
        } else if (roll < 0.86) {
          const id = r() < 0.8 ? pick(liveIds()) : pick([...everIds]);
          if (id) op(`delete ${id}`, () => engine.drop(id, 'toolbar'));
        } else if (roll < 0.93) {
          const id = pick([...deleted.keys()]);
          if (id) op(`restore step ${id}`, () => engine.restore(id));
        }
        check();
        if (r() < 0.5) await sleep(Math.floor(r() * 4));
        check();
      }
      engine.close();
      const final = lastDraft as Draft | null;
      let result: { steps: string[] } | null = null;
      try {
        result = await engine.finish();
      } catch {
        result = null; // the model failed Stop's call: an error, and nothing is written
      }
      check();
      if (most > 1) fail('two calls at once');
      if (result && final) {
        for (const text of final.steps.filter((s) => s.startsWith('Edit#'))) {
          if (result.steps.filter((s) => s === text).length !== 1) fail(`result: "${text}" not there exactly once`);
        }
      }
    }
  }, 240_000);
});
