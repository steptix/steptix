/**
 * Record Steps with the browser toolbar, the TestBench half
 * (stories/testbench-record-toolbar.md): steps the author writes into the
 * test file while recording, locked steps, and the panel's new rows — pinned
 * against the pure core, with no host.
 *
 * A `Session` drives the core the way step-recorder.ts does: the anchor
 * followed through every change, the recording's writes applied as edits,
 * everyone else's followed with `followLiveRecord`, lines the author leaves
 * counted with `commitAuthorLines`, and the server's answer (`record:step`,
 * then a draft that holds the step) fed back in. The host-level halves (the
 * real change events, the add-step on the wire, undo) are in
 * tests/integration/suite/record-steps.test.cjs.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as core from '../src/extension/record-steps-core.ts';

const doc = (...lines) => lines.join('\n');

/** The integration suite's fixture. */
const FIXTURE = doc(
  '# Record fixture',
  '',
  '## Config',
  '- baseUrl: https://example.test/',
  '',
  '## Parameters',
  '- email: demo@example.test',
  '',
  '## Steps',
  '1. Navigate to login.html',
  '2. Click Sign in',
  '3. Open the dashboard',
  '',
  '### Sign in',
  '',
  '1. Type {{email}} into the Email field',
  '2. Click Submit',
  '',
);

const EMPTY = { steps: [], parameters: [] };
const change = (offset, length, text) => ({ offset, length, text });

function lineChange(text, c) {
  const pos = (off) => {
    const before = text.slice(0, off);
    return { line: (before.match(/\n/g) ?? []).length, char: off - (before.lastIndexOf('\n') + 1) };
  };
  const s = pos(c.offset);
  const e = pos(c.offset + c.length);
  return { startLine: s.line, startChar: s.char, endLine: e.line, endChar: e.char, text: c.text };
}

const anchorAt = (text, needle) => {
  const idx = text.split(/\r?\n/).indexOf(needle);
  assert.ok(idx >= 0, `no line ${JSON.stringify(needle)}`);
  const cursor = core.resolveRecordCursor(text, idx + 1);
  assert.equal(cursor.ok, true, cursor.reason);
  return { ...cursor.anchor, tracked: true };
};

/** One recording into one document, driven as step-recorder.ts drives it. */
class Session {
  constructor(text, needle) {
    this.text = text;
    this.anchor = anchorAt(text, needle);
    this.live = null;
    this.lost = false;
    this.touched = false;
  }

  /** Write a draft; returns the write (or the `lost` error). */
  write(draft) {
    if (!this.live) {
      const begun = core.beginLiveRecord(this.text, this.anchor);
      assert.ok(!('error' in begun), begun.error);
      this.live = begun;
    }
    const record = this.lost ? { ...this.live, uncertain: true } : this.live;
    const w = core.liveRecordWrite(record, this.text, draft, { anchor: this.anchor });
    if ('error' in w) {
      assert.ok(w.lost, `a write failed for another reason: ${w.error}`);
      this.lost = true;
      return w;
    }
    assert.equal(core.applyOffsetEdits(this.text, w.edits), w.text, 'the edits make the text the write reports');
    this.move(w.edits.map((e) => change(e.start, e.end - e.start, e.text)));
    this.live = w.record;
    return w;
  }

  move(changes) {
    const before = this.text;
    if (this.anchor) this.anchor = core.trackAnchorThroughChanges(this.anchor, changes.map((c) => lineChange(before, c)));
    this.text = core.applyOffsetEdits(before, changes.map((c) => ({ start: c.offset, end: c.offset + c.length, text: c.text })));
  }

  /** Someone else's change event. */
  author(changes, opts = {}) {
    this.move(changes);
    if (!this.live) return;
    const followed = core.followLiveRecord(this.live, changes, {
      text: () => this.text,
      uncertain: opts.uncertain === true,
      anchor: this.anchor,
    });
    this.live = followed.record;
    if (followed.touched) this.touched = true;
  }

  /** Typed one keystroke per change event, from `offset`. */
  type(offset, text) {
    for (let i = 0; i < text.length; i++) this.author([change(offset + i, 0, text[i])]);
  }

  /** Count the author's lines no cursor is on (`cursors`: offsets). */
  commit(cursors = []) {
    const r = core.commitAuthorLines(this.live, this.text, cursors);
    this.live = r.record;
    return r.commits;
  }

  /** `record:step` for an editor step. */
  step(id, text) {
    this.live = core.assignAuthorStepId(this.live, id, text);
  }

  lines() {
    return core.authorLinesOf(this.live);
  }
}

/** The offset just past `needle` in `text` (the end of that line's text). */
const endOf = (text, needle) => {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `no ${JSON.stringify(needle)}`);
  return at + needle.length;
};

const withSteps = (...steps) => FIXTURE.replace('2. Click Sign in\n', `2. Click Sign in\n${steps.join('\n')}\n`);

// ---------------------------------------------------------------------------
// A line typed at the end of the block
// ---------------------------------------------------------------------------

test('a line typed under the last recorded line (End, Enter): counted when left, at the end; the draft that holds it adopts it — no second copy — and later steps go below it', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Check the banner');
  assert.equal(s.text, withSteps('3. Click Menu', '4. Check the banner').replace('3. Open the dashboard', '4. Open the dashboard'));
  assert.equal(s.touched, false, 'a new line is not an edit of a recorded one');
  assert.deepEqual(s.lines().map((l) => [l.line, l.status]), [['4. Check the banner', 'typing']]);

  // Still on the line: not counted, and the next draft writes above it.
  assert.deepEqual(s.commit([endOf(s.text, '4. Check the banner')]), []);
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  assert.equal(s.text, withSteps('3. Click Menu', '4. Click Payments', '4. Check the banner').replace('3. Open the dashboard', '5. Open the dashboard'));

  // Left: one add-step, at the end (no afterStep).
  const commits = s.commit([0]);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].lines, ['Check the banner'], 'sent without its number');
  assert.equal(commits[0].afterStep, undefined);
  assert.deepEqual(s.commit([0]), [], 'counted once');

  // The server's answer: record:step, then a draft that holds it, locked.
  s.step('s1', 'Check the banner');
  const w = s.write({
    steps: ['Click Menu', 'Click Payments', 'Check the banner', 'Tick Cash'],
    parameters: [],
    locked: 3,
    authored: [2],
    authoredIds: ['s1'],
  });
  assert.equal(
    s.text,
    withSteps('3. Click Menu', '4. Click Payments', '5. Check the banner', '6. Tick Cash').replace('3. Open the dashboard', '7. Open the dashboard'),
    'adopted where it is, numbered on; the next recorded step goes below it',
  );
  assert.equal(s.text.split('Check the banner').length, 2, 'never written twice');
  // The author's line: only its number was touched.
  const mineEdits = w.edits.filter((e) => e.kind === 'mine');
  assert.deepEqual(mineEdits.map((e) => e.text), ['5']);
  assert.deepEqual(s.lines().map((l) => [l.status, l.stepId, l.inDraft]), [['sent', 's1', true]]);

  // Cancel: everything the recording wrote out, the author's line kept, with
  // the number the author gave it.
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. Check the banner\n3. Open the dashboard'));
});

test('the block ending the file (no final line break): a line opened under it is the author\'s, and is adopted there', () => {
  const text = doc('## Steps', '1. A');
  const s = new Session(text, '1. A');
  s.write({ steps: ['New'], parameters: [] });
  assert.equal(s.text, doc('## Steps', '1. A', '2. New'));
  s.type(s.text.length, '\n3. Mine');
  s.write({ steps: ['New', 'Newer'], parameters: [] });
  assert.equal(s.text, doc('## Steps', '1. A', '2. New', '3. Newer', '3. Mine'));
  const [commit] = s.commit([]);
  assert.deepEqual([commit.lines, commit.afterStep], [['Mine'], undefined]);
  s.step('s1', 'Mine');
  s.write({ steps: ['New', 'Newer', 'Mine', 'Last'], parameters: [], authored: [2], authoredIds: ['s1'], locked: 3 });
  assert.equal(s.text, doc('## Steps', '1. A', '2. New', '3. Newer', '4. Mine', '5. Last'));
  s.write(EMPTY);
  assert.equal(s.text, doc('## Steps', '1. A', '3. Mine'));
});

test('CRLF: a line opened under the block is followed and adopted the same way', () => {
  const text = FIXTURE.replace(/\n/g, '\r\n');
  const s = new Session(text, '2. Click Sign in');
  s.write({ steps: ['Click Menu'], parameters: [] });
  s.author([change(endOf(s.text, '3. Click Menu'), 0, '\r\n')]);
  s.type(endOf(s.text, '3. Click Menu') + 2, '4. Mine');
  s.commit([]);
  s.step('s1', 'Mine');
  s.write({ steps: ['Click Menu', 'Mine', 'Click Pay'], parameters: [], authored: [1], authoredIds: ['s1'] });
  assert.equal(s.text, withSteps('3. Click Menu', '4. Mine', '5. Click Pay').replace('3. Open the dashboard', '6. Open the dashboard').replace(/\n/g, '\r\n'));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. Mine\n3. Open the dashboard').replace(/\n/g, '\r\n'));
});

// ---------------------------------------------------------------------------
// A line typed between two recorded steps
// ---------------------------------------------------------------------------

test('a line typed between two recorded steps: counted with how many steps are above it; laid out around until the draft holds it; locked lines are only renumbered', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify the menu is open');
  assert.equal(
    s.text,
    withSteps('3. Click Menu', '4. Verify the menu is open', '4. Click Payments').replace('3. Open the dashboard', '5. Open the dashboard'),
  );
  assert.equal(s.touched, false, 'not an edit inside the recorded lines: no warning');
  const [commit] = s.commit([]);
  assert.deepEqual([commit.lines, commit.afterStep], [['Verify the menu is open'], 0], 'after the first step of the draft the author saw');

  // A draft that does not hold it yet: the steps are divided by count around it.
  s.write({ steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [] });
  assert.equal(
    s.text,
    withSteps('3. Click Menu', '4. Verify the menu is open', '4. Click Payments', '5. Tick Cash').replace('3. Open the dashboard', '6. Open the dashboard'),
  );

  // The draft that holds it (and a record:step that came AFTER it: the line
  // is still taken for the step, by the text it was sent as).
  const before = s.text;
  const w = s.write({
    steps: ['Click Menu', 'Verify the menu is open', 'Click Payments', 'Tick Cash'],
    parameters: [],
    locked: 4,
    authored: [1],
    authoredIds: ['s1'],
  });
  assert.equal(
    s.text,
    withSteps('3. Click Menu', '4. Verify the menu is open', '5. Click Payments', '6. Tick Cash').replace('3. Open the dashboard', '7. Open the dashboard'),
  );
  // Locked lines are not rewritten: every edit is a number, and none of the
  // author's line is touched.
  for (const e of w.edits) {
    assert.match(e.text, /^\d+$/, `only numbers change: ${JSON.stringify(e)}`);
    assert.match(before.slice(e.start, e.end), /^\d+$/);
  }
  assert.equal(w.edits.filter((e) => e.kind === 'mine').length, 0, 'its number was already right');
  s.step('s1', 'Verify the menu is open');
  assert.deepEqual(s.lines().map((l) => [l.stepId, l.inDraft]), [['s1', true]]);

  // The next draft only changes the open part below the last lock.
  const before2 = s.text;
  const w2 = s.write({
    steps: ['Click Menu', 'Verify the menu is open', 'Click Payments', 'Tick Cash', 'Click Pay'],
    parameters: [],
    locked: 4,
    authored: [1],
    authoredIds: ['s1'],
  });
  const lockedEnd = before2.indexOf('6. Tick Cash\n') + '6. Tick Cash\n'.length;
  for (const e of w2.edits) {
    assert.ok(e.start >= lockedEnd, `an edit reached into the locked steps: ${JSON.stringify(e)}`);
  }

  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. Verify the menu is open\n3. Open the dashboard'));
});

test('several lines pasted between two recorded steps are several steps, in ONE add-step', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.author([change(s.text.indexOf('4. Click Payments'), 0, '4. First\n- Second\n')]);
  assert.equal(s.touched, false);
  assert.deepEqual(s.lines().map((l) => l.line), ['4. First', '- Second']);
  const commits = s.commit([]);
  assert.equal(commits.length, 1);
  assert.deepEqual([commits[0].lines, commits[0].afterStep], [['First', 'Second'], 0]);
  s.step('s1', 'First');
  s.step('s2', 'Second');
  s.write({
    steps: ['Click Menu', 'First', 'Second', 'Click Payments'],
    parameters: [],
    authored: [1, 2],
    authoredIds: ['s1', 's2'],
    locked: 4,
  });
  // A list marker is replaced by the recording's number while the step is held…
  assert.equal(s.text, withSteps('3. Click Menu', '4. First', '5. Second', '6. Click Payments').replace('3. Open the dashboard', '7. Open the dashboard'));
  // …and given back at Cancel.
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. First\n- Second\n3. Open the dashboard'));
});

test('Home, Enter, typing on the new line above a recorded step (not the first) is a line between steps too', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.author([change(s.text.indexOf('4. Click Payments'), 0, '\n')]);
  s.type(s.text.indexOf('\n4. Click Payments'), 'Mine');
  assert.deepEqual(s.lines().map((l) => l.line), ['Mine']);
  assert.equal(s.touched, false);
  const [commit] = s.commit([]);
  assert.equal(commit.afterStep, 0);
});

// ---------------------------------------------------------------------------
// What does not count
// ---------------------------------------------------------------------------

test('not counted while typing on it, never when blank, and a line above the block is outside the recording', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  // A blank line opened between steps and left blank.
  s.author([change(endOf(s.text, '3. Click Menu'), 0, '\n')]);
  assert.deepEqual(s.lines().map((l) => [l.line, l.status]), [['', 'typing']]);
  assert.deepEqual(s.commit([]), [], 'blank: never a step');
  // Half a sentence, the cursor still on it.
  s.type(endOf(s.text, '3. Click Menu') + 1, 'Verify the');
  const cursor = endOf(s.text, 'Verify the');
  assert.deepEqual(s.commit([cursor]), []);
  assert.deepEqual(s.commit([cursor - 3]), [], 'anywhere on the line is on it');
  // A number alone is not a step either.
  const n = new Session(FIXTURE, '2. Click Sign in');
  n.write({ steps: ['Click Menu'], parameters: [] });
  n.type(endOf(n.text, '3. Click Menu'), '\n4.');
  assert.deepEqual(n.commit([]), []);
  // Whole lines at the first recorded line's start go above the block.
  const a = new Session(FIXTURE, '2. Click Sign in');
  a.write({ steps: ['Click Menu'], parameters: [] });
  a.author([change(a.text.indexOf('3. Click Menu'), 0, '2b. Above\n')]);
  assert.deepEqual(a.lines(), [], 'outside the recording');
  assert.deepEqual(a.commit([]), []);
  a.write(EMPTY);
  assert.equal(a.text, FIXTURE.replace('2. Click Sign in\n', '2. Click Sign in\n2b. Above\n'));
});

test('a line the server did not take stays the author\'s, and is never sent again', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\nMine');
  const [commit] = s.commit([]);
  s.live = core.keepAuthorLines(s.live, commit.keys);
  assert.deepEqual(s.lines().map((l) => l.status), ['kept']);
  assert.deepEqual(s.commit([]), []);
  // Still written around, never over.
  s.write({ steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [] });
  assert.equal(s.text, withSteps('3. Click Menu', 'Mine', '4. Click Payments', '5. Tick Cash').replace('3. Open the dashboard', '6. Open the dashboard'));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', 'Mine\n3. Open the dashboard'));
});

// ---------------------------------------------------------------------------
// The author's line afterwards
// ---------------------------------------------------------------------------

test('the author edits their line after it was sent: the edit stays, the step still maps to it by what was sent', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Check the banner');
  s.commit([]);
  s.type(endOf(s.text, 'Check the banner'), ' twice');
  s.write({ steps: ['Click Menu', 'Check the banner', 'Click Pay'], parameters: [], authored: [1], authoredIds: ['s1'] });
  assert.equal(s.text, withSteps('3. Click Menu', '4. Check the banner twice', '5. Click Pay').replace('3. Open the dashboard', '6. Open the dashboard'));
  assert.equal(s.lines()[0].stepId, 's1');
});

test('a number the author changes after the recording numbered their line is theirs for good', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\nMine');
  s.commit([]);
  s.step('s1', 'Mine');
  s.write({ steps: ['Click Menu', 'Mine'], parameters: [], authored: [1], authoredIds: ['s1'] });
  assert.match(s.text, /3\. Click Menu\n4\. Mine\n5\. Open the dashboard/);
  s.author([change(s.text.indexOf('4. Mine'), 1, '9')]);
  s.write({ steps: ['Click Menu', 'Mine', 'Click Pay'], parameters: [], authored: [1], authoredIds: ['s1'] });
  assert.match(s.text, /3\. Click Menu\n9\. Mine\n5\. Click Pay\n6\. Open the dashboard/);
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '9. Mine\n3. Open the dashboard'));
});

test('a step the toolbar or the panel added is never taken for a line the author typed, even with the same text', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\nCheck');
  s.commit([]);
  s.write({ steps: ['Click Menu', 'Check'], parameters: [], authored: [1], authoredIds: ['t1'], foreignIds: ['t1'] });
  assert.equal(s.lines()[0].stepId, undefined);
  // The toolbar's step is the recording's line; the author's stays theirs.
  assert.match(s.text, /3\. Click Menu\n4\. Check\nCheck\n5\. Open the dashboard/);
});

test('an author\'s line deleted whole: the block closes up, and a step the draft still holds for it is the recording\'s line from then on', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\nMine');
  s.commit([]);
  s.step('s1', 'Mine');
  s.write({ steps: ['Click Menu', 'Mine', 'Click Payments'], parameters: [], authored: [1], authoredIds: ['s1'] });
  const at = s.text.indexOf('4. Mine\n');
  s.author([change(at, '4. Mine\n'.length, '')]);
  assert.deepEqual(s.lines(), []);
  s.write({ steps: ['Click Menu', 'Mine', 'Click Payments'], parameters: [], authored: [1], authoredIds: ['s1'] });
  assert.equal(s.text, withSteps('3. Click Menu', '4. Mine', '5. Click Payments').replace('3. Open the dashboard', '6. Open the dashboard'));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE);
});

test('nothing of the recording left but an author\'s line: not written afresh beside it — the writing stops', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\nMine');
  s.commit([]);
  // The recorded lines deleted, the author's line left.
  const first = s.text.indexOf('3. Click Menu\n');
  s.author([change(first, '3. Click Menu\n'.length, '')]);
  const second = s.text.indexOf('4. Click Payments\n');
  s.author([change(second, '4. Click Payments\n'.length, '')], { uncertain: true });
  const before = s.text;
  const w = s.write({ steps: ['Click Menu', 'Mine', 'Click Payments'], parameters: [], authored: [1], authoredIds: ['s1'] });
  assert.equal(w.lost, true);
  assert.equal(s.text, before);
});

test('an unfinished recording is taken out after a reload with the author\'s lines kept', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Mine');
  s.write({ steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [] });
  const kept = JSON.parse(JSON.stringify(core.unfinishedRecordingOf(s.live)));
  assert.deepEqual(kept.parts.map((p) => p.mine), [false, true, false]);
  const removal = core.removeUnfinishedRecording(s.text, kept);
  assert.equal(removal.text, FIXTURE.replace('3. Open the dashboard', '4. Mine\n3. Open the dashboard'));
});

// ---------------------------------------------------------------------------
// Random edits and drafts that hold the author's steps
// ---------------------------------------------------------------------------

function prng(seed) {
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
 * Every character with who put it there — `base`, `author` (typed while
 * recording, anywhere), `rec` (the recording's writes). A write may replace
 * `rec`, a renumber of a step's leading digits, or the leading number of a
 * line of the author's that a draft holds — nothing else of the author's.
 */
test('random author lines and drafts that hold them: a write never replaces what the author typed (bar a held line\'s number), never writes an adopted line twice, and Cancel leaves only the author\'s', () => {
  const STEP_TEXTS = ['Click Menu', 'Click Payments', 'Tick Cash', 'Click Pay', 'Sign out', 'Open Reports'];
  const LINES = ['Check A', 'Check B', 'Verify C', '9. Verify D', '- Verify E'];
  let adopted = 0;
  let lostCount = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = prng(seed);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const s = new Session(FIXTURE, '2. Click Sign in');
    let chars = [...FIXTURE].map((c) => ({ c, own: 'base' }));
    const textOf = () => chars.map((x) => x.c).join('');
    const label = (op) => `seed ${seed}, ${op}`;
    let recorded = 1;
    /** Server side: the author's steps it holds, by id, with where they sit. */
    let serverSteps = STEP_TEXTS.slice(0, 1);
    let authored = []; // { id, text }
    let nextId = 1;
    const typedTexts = new Set();
    const draft = () => {
      const steps = [...serverSteps];
      return {
        steps,
        parameters: [],
        authored: authored.map((a) => steps.indexOf(a.text)).filter((i) => i >= 0),
        authoredIds: authored.filter((a) => steps.includes(a.text)).map((a) => a.id),
      };
    };
    const applyWrite = (w, op) => {
      for (const e of w.edits) {
        const replaced = chars.slice(e.start, e.end);
        const was = replaced.map((x) => x.c).join('');
        const recOnly = replaced.every((x) => x.own === 'rec');
        const digits = /^\d+$/.test(e.text) && replaced.every((x) => /\d/.test(x.c));
        const lineStart = e.start === 0 || chars[e.start - 1]?.c === '\n';
        // A held line's leading number (or marker), and nothing past it.
        const heldNumber =
          e.kind === 'mine' &&
          lineStart &&
          /^(?:\d+|\d+\. |(?:\d+\)|[-*+])[ \t]+|)$/.test(was) &&
          /^(?:\d+|\d+\. |(?:\d+\)|[-*+])[ \t]+|)$/.test(e.text);
        assert.ok(
          recOnly || (digits && lineStart) || heldNumber,
          label(`${op}: a write replaced ${JSON.stringify(was)} (${[...new Set(replaced.map((x) => x.own))]}) with ${JSON.stringify(e.text)}`),
        );
      }
      const ordered = w.edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.i - a.i);
      for (const { e } of ordered) chars.splice(e.start, e.end - e.start, ...[...e.text].map((c) => ({ c, own: e.kind === 'mine' ? 'author' : 'rec' })));
    };

    s.write(draft());
    // Ownership after the first write: the fixture with the one recorded line.
    {
      const at = FIXTURE.indexOf('3. Open the dashboard');
      chars = [...FIXTURE.slice(0, at)].map((c) => ({ c, own: 'base' }));
      chars.push(...[...'3. Click Menu\n'].map((c) => ({ c, own: 'rec' })));
      chars.push(...[...'4'].map((c) => ({ c, own: 'rec' })));
      chars.push(...[...FIXTURE.slice(at + 1)].map((c) => ({ c, own: 'base' })));
    }
    assert.equal(textOf(), s.text, label('setup'));

    for (let op = 0; op < 30 && !s.lost; op++) {
      const r = rnd();
      const run = s.live.slots.filter((x) => x.kind === 'block' || x.kind === 'mine');
      const runEnd = run[run.length - 1].end;
      const runStart = run[0].start;
      if (r < 0.35) {
        // The server: more steps recorded (appended to the open part).
        if (recorded < STEP_TEXTS.length) serverSteps.push(STEP_TEXTS[recorded++]);
        const w = s.write(draft());
        if (w.lost) {
          lostCount++;
          break;
        }
        applyWrite(w, `write ${op}`);
      } else if (r < 0.65) {
        // The author opens a line under a recorded line inside the run and
        // types a step on it.
        const starts = [];
        for (let i = runStart; i < runEnd; i++) if (s.text[i] === '\n') starts.push(i);
        if (starts.length === 0) continue;
        const at = pick(starts);
        // Each text once: two lines of the author's reading alike are a
        // different question from the one this asks.
        const unused = LINES.filter((l) => !typedTexts.has(l));
        if (unused.length === 0) continue;
        const line = pick(unused);
        typedTexts.add(line);
        s.type(at, '\n' + line);
        // The same text as the line and ITS break after the recorded line's
        // break — which is the author's line as it reads.
        chars.splice(at + 1, 0, ...[...(line + '\n')].map((c) => ({ c, own: 'author' })));
      } else if (r < 0.85) {
        // The author leaves their lines; the server takes each as a step
        // where the add-step said, and the next draft holds them.
        const commits = s.commit([]);
        // Each add-step's `afterStep` is the step it follows in the draft the
        // author saw — the server's reading (src/recorder/draft-engine.ts);
        // several at once are placed bottom-up, so none moves another's.
        for (const c of [...commits].reverse()) {
          c.lines.forEach((line, k) => {
            const id = `s${nextId++}`;
            const idx = c.afterStep === undefined ? serverSteps.length : Math.min(c.afterStep + 1 + k, serverSteps.length);
            // Two author steps with one text: the server's texts must differ
            // for this model, so a repeat is left out of the server's draft.
            if (serverSteps.includes(line)) return;
            serverSteps.splice(idx, 0, line);
            authored.push({ id, text: line });
            if (rnd() < 0.5) s.step(id, line);
          });
        }
        if (commits.length === 0) continue;
        const w = s.write(draft());
        if (w.lost) {
          lostCount++;
          break;
        }
        applyWrite(w, `adopt ${op}`);
        adopted++;
      } else if (r < 0.93) {
        // The author goes back to one of their lines and adds to it.
        const mine = s.live.slots.filter((x) => x.kind === 'mine' && x.wrote.trim() !== '');
        if (mine.length === 0) continue;
        const at = pick(mine).end - 1;
        s.type(at, ' too');
        chars.splice(at, 0, ...[...' too'].map((c) => ({ c, own: 'author' })));
      } else {
        // Typing elsewhere, above everything.
        s.author([change(0, 0, 'x')]);
        chars.splice(0, 0, { c: 'x', own: 'author' });
      }
      assert.equal(s.text, textOf(), label(`op ${op}: the model and the session agree`));
      // An adopted step's text is in the file once.
      for (const a of authored) {
        const count = s.text.split('\n').filter((l) => l.replace(/^(?:\d+\.|[-*+])\s+/, '') === a.text).length;
        assert.ok(count <= 1, label(`op ${op}: ${JSON.stringify(a.text)} is in the file ${count} times`));
      }
    }
    if (s.lost) continue;
    // Cancel.
    const w = s.write(EMPTY);
    if (w.lost) continue;
    applyWrite(w, 'Cancel');
    assert.equal(s.text, textOf());
    for (const line of s.text.split('\n')) {
      assert.ok(!STEP_TEXTS.some((t) => line.endsWith(`. ${t}`)), label(`Cancel left a recorded line: ${JSON.stringify(line)}`));
    }
    // Every line the author typed is still there.
    for (const typed of typedTexts) {
      const text = core.cleanAuthorLine(typed);
      assert.ok(
        s.text.split('\n').some((l) => core.cleanAuthorLine(l).startsWith(text)),
        label(`Cancel took the author's ${JSON.stringify(typed)} out`),
      );
    }
  }
  // The server here always places a line where the file has it: the writing
  // never had reason to stop.
  assert.equal(lostCount, 0);
  assert.ok(adopted > 100, `adopted: ${adopted}`);
});

// ---------------------------------------------------------------------------
// Text the author gives as steps
// ---------------------------------------------------------------------------

test('Add step text: one line is one step, several lines several, blanks and bare numbers dropped, markers taken off', () => {
  assert.deepEqual(core.splitAuthorSteps('Verify the balance shows "$1,234.56"'), ['Verify the balance shows "$1,234.56"']);
  assert.deepEqual(core.splitAuthorSteps('8. Click Pay\n\n  - Tick   Cash \r\n9)\tSign out\n7.\n*'), ['Click Pay', 'Tick Cash', 'Sign out']);
  assert.deepEqual(core.splitAuthorSteps(''), []);
  assert.deepEqual(core.splitAuthorSteps('   \n  '), []);
  // A number that is the step's own text stays.
  assert.deepEqual(core.splitAuthorSteps('3 items are shown'), ['3 items are shown']);
  assert.equal(core.cleanAuthorLine('12. Verify 12. is a number'), 'Verify 12. is a number');
});

// ---------------------------------------------------------------------------
// The panel's Recording block: the toolbar's frames
// ---------------------------------------------------------------------------

const fresh = () => core.newRecordingState({ uri: 'file:///t.md', file: 't.md', mode: 'cursor' });

test('record:paused: a ❚❚ Paused / ▶ Resumed row where it happened, the status, pick mode off; a repeat changes nothing', () => {
  const s = fresh();
  core.applyRecordFrame(s, { type: 'record:started', url: 'u', title: '' });
  core.applyRecordFrame(s, { type: 'record:action', id: 'a1', kind: 'click', action: true, summary: 'Clicked A', atMs: 10 });
  core.applyRecordFrame(s, { type: 'record:pick', armed: true });
  assert.equal(core.applyRecordFrame(s, { type: 'record:paused', paused: true, atMs: 4000, source: 'toolbar' }), true);
  assert.equal(s.paused, true);
  assert.equal(s.pickArmed, false, 'a check is recording: paused disarms it');
  assert.equal(core.recordingStatusText(s), 'Recording paused — 1 action');
  assert.equal(core.applyRecordFrame(s, { type: 'record:paused', paused: true, atMs: 4100, source: 'panel' }), false);
  core.applyRecordFrame(s, { type: 'record:paused', paused: false, atMs: 9000, source: 'panel' });
  assert.equal(core.recordingStatusText(s), 'Recording — 1 action');
  assert.deepEqual(
    s.actions.map((a) => [a.kind, a.summary, a.atMs, a.action]),
    [
      ['click', 'Clicked A', 10, true],
      ['pause', 'Paused', 4000, false],
      ['resume', 'Resumed', 9000, false],
    ],
  );
  assert.equal(new Set(s.actions.map((a) => a.id)).size, 3, 'each row has its own id');
});

test('record:step: a ✎ row for the author\'s step, with where it came from; dropped and restored by its id', () => {
  const s = fresh();
  core.applyRecordFrame(s, { type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked Reports', atMs: 5 });
  assert.equal(
    core.applyRecordFrame(s, { type: 'record:step', id: 's1', text: '8.  Verify the balance shows "$1,234.56"', source: 'editor', afterStep: 7, atMs: 9500 }),
    true,
  );
  assert.deepEqual(s.actions[1], {
    id: 's1',
    kind: 'step',
    action: false,
    summary: 'Verify the balance shows "$1,234.56"',
    atMs: 9500,
    dropped: false,
    source: 'editor',
  });
  assert.equal(core.recordingStatusText(s), 'Recording — 1 action', 'a step is not an action');
  // The toolbar's Undo, then Restore.
  assert.equal(core.applyRecordFrame(s, { type: 'record:dropped', id: 's1', dropped: true, source: 'toolbar' }), true);
  assert.equal(s.actions[1].dropped, true);
  assert.equal(core.applyRecordFrame(s, { type: 'record:dropped', id: 'a1', dropped: true, source: 'toolbar' }), true);
  assert.equal(core.recordingStatusText(s), 'Recording — 0 actions');
  assert.equal(core.applyRecordFrame(s, { type: 'record:dropped', id: 'a1', dropped: true, source: 'toolbar' }), false, 'already');
  core.applyRecordFrame(s, { type: 'record:dropped', id: 's1', dropped: false, source: 'toolbar' });
  assert.equal(s.actions[1].dropped, false);
  assert.equal(core.applyRecordFrame(s, { type: 'record:dropped', id: 'nope', dropped: true, source: 'toolbar' }), false);
  // A restated step keeps its strike.
  core.applyRecordFrame(s, { type: 'record:dropped', id: 's1', dropped: true, source: 'panel' });
  core.applyRecordFrame(s, { type: 'record:step', id: 's1', text: 'Verify the balance', source: 'editor', afterStep: 7, atMs: 9500 });
  assert.equal(s.actions[1].dropped, true);
  assert.equal(s.actions.length, 2);
  // Markers cannot be dropped.
  core.applyRecordFrame(s, { type: 'record:paused', paused: true, atMs: 1, source: 'panel' });
  const marker = s.actions[s.actions.length - 1];
  assert.equal(core.applyRecordFrame(s, { type: 'record:dropped', id: marker.id, dropped: true, source: 'toolbar' }), false);
  assert.equal(core.applyRecordFrame(s, { type: 'record:toolbar', dock: 'tl', minimised: true }), false, 'the host\'s, not the block\'s');
});

test('record:draft: locked steps and the author\'s, mapped onto the steps as kept', () => {
  const s = fresh();
  core.applyRecordFrame(s, {
    type: 'record:draft',
    revision: 1,
    steps: ['Click Menu', '', 'Verify the total', 'Click Pay'],
    parameters: [],
    locked: 3,
    authored: [2, 9],
    authoredIds: ['s1', 's9'],
  });
  assert.deepEqual(s.draft.steps, ['Click Menu', 'Verify the total', 'Click Pay']);
  assert.equal(s.draft.locked, 3);
  assert.deepEqual([s.draft.authored, s.draft.authoredIds], [[1], ['s1']]);
  core.applyRecordFrame(s, { type: 'record:draft', revision: 2, steps: ['A'], parameters: [], locked: 7 });
  assert.equal(s.draft.locked, 1, 'never more than the steps');
  assert.equal(s.draft.authored, undefined);
  assert.deepEqual(core.draftStepMarks(s.draft), [{ locked: true, yours: false }]);
});

test('Steps so far marks: a lock on each locked step, "yours" on the author\'s', () => {
  assert.deepEqual(
    core.draftStepMarks({ steps: ['a', 'b', 'c', 'd'], locked: 3, authored: [1] }),
    [
      { locked: true, yours: false },
      { locked: true, yours: true },
      { locked: true, yours: false },
      { locked: false, yours: false },
    ],
  );
  assert.deepEqual(core.draftStepMarks({ steps: ['a'] }), [{ locked: false, yours: false }]);
  assert.deepEqual(core.draftStepMarks(null), []);
});

test('the result\'s author steps come from the last draft: where it had them, else the next step with the same text', () => {
  const draft = { steps: ['a', 'Mine', 'b', 'Other'], authored: [1, 3], authoredIds: ['s1', 's2'] };
  assert.deepEqual(core.authoredForResult(draft, ['a', 'Mine', 'b', 'Other', 'c']), { authored: [1, 3], authoredIds: ['s1', 's2'] });
  assert.deepEqual(core.authoredForResult(draft, ['a', 'x', 'Mine', 'b', 'Other']), { authored: [2, 4], authoredIds: ['s1', 's2'] });
  assert.deepEqual(core.authoredForResult(draft, ['a', 'b']), { authored: [], authoredIds: [] });
  assert.deepEqual(core.authoredForResult(null, ['a']), { authored: [], authoredIds: [] });
});

test('the panel copies of the heading text and the draft marks match the core (recording-panel.js)', async () => {
  const inline = await import('../src/webview/lib/recording-panel.js');
  const a = (dropped, action) => ({ dropped, ...(action !== undefined && { action }) });
  for (const state of [
    { phase: 'recording', paused: true, actions: [a(false), a(false, false)] },
    { phase: 'recording', paused: false, actions: [a(false)] },
    { phase: 'recording', paused: true, actions: [] },
    { phase: 'finishing', paused: true, actions: [a(false)] },
  ]) {
    assert.equal(inline.recordingStatusTextInline(state), core.recordingStatusText(state), JSON.stringify(state));
  }
  for (const draft of [
    { steps: ['a', 'b', 'c'], locked: 2, authored: [0] },
    { steps: ['a'] },
    { steps: [], locked: 0 },
    null,
  ]) {
    assert.deepEqual(inline.draftStepMarksInline(draft), core.draftStepMarks(draft), JSON.stringify(draft));
  }
});
