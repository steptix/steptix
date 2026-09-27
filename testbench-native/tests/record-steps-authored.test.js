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
  commit(cursors = [], opts = {}) {
    const r = core.commitAuthorLines(this.live, this.text, cursors, opts);
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
// Lines sent before a draft holds the one next to them (review of 0.5.155)
// ---------------------------------------------------------------------------

/**
 * The server's side of the author's lines as src/recorder/draft-engine.ts
 * does it: every draft kept by its revision; an add-step's `afterStep` read
 * against the draft its `revision` names — that step's text, found nearest
 * its index in the draft as it is now (`mapIndex`) — and its lines put right
 * after it, or at the end when it names the last step or none. Two add-steps
 * aimed at one step therefore land the second one FIRST.
 */
class FakeServer {
  constructor(steps) {
    this.steps = steps.map((text) => ({ text }));
    this.revision = 0;
    this.history = new Map();
    this.nextId = 1;
    this.emit();
  }

  emit() {
    this.revision += 1;
    this.history.set(this.revision, this.steps.map((s) => s.text));
  }

  /** The draft as `record:draft` carries it. */
  draft() {
    const authored = [];
    const authoredIds = [];
    this.steps.forEach((s, i) => {
      if (!s.id) return;
      authored.push(i);
      authoredIds.push(s.id);
    });
    return { steps: this.steps.map((s) => s.text), parameters: [], authored, authoredIds, locked: this.steps.length, revision: this.revision };
  }

  /** One more recorded step, at the end. */
  record(text) {
    this.steps.push({ text });
    this.emit();
  }

  mapIndex(afterStep, revision) {
    const clamp = (i) => Math.max(0, Math.min(i, this.steps.length - 1));
    if (revision === undefined || revision === this.revision) return afterStep;
    const text = this.history.get(revision)?.[afterStep];
    if (text === undefined) return clamp(afterStep);
    let best = -1;
    let distance = Number.POSITIVE_INFINITY;
    this.steps.forEach((s, i) => {
      if (s.text === text && Math.abs(i - afterStep) < distance) {
        best = i;
        distance = Math.abs(i - afterStep);
      }
    });
    return best >= 0 ? best : clamp(afterStep);
  }

  /** An add-step from the editor; the steps it made, with their ids. */
  addStep(commit) {
    const at = commit.afterStep === undefined ? undefined : this.mapIndex(commit.afterStep, commit.revision);
    const atEnd = at === undefined || at >= this.steps.length - 1;
    const made = commit.lines.map((text) => ({ text, id: `s${this.nextId++}` }));
    if (atEnd) this.steps.push(...made);
    else this.steps.splice(at + 1, 0, ...made);
    this.emit();
    return made;
  }
}

/** Each of `texts` is in `text` exactly once. */
function once(text, texts) {
  for (const t of texts) assert.equal(text.split(t).length, 2, `${JSON.stringify(t)} is in the file ${text.split(t).length - 1} times`);
}

test('the race: two lines typed one after the other between steps, the second left before a draft holds the first — it waits for that draft, then names the first; the server keeps their order, and Stop writes over the draft', () => {
  const server = new FakeServer(['Click Menu', 'Click Payments']);
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(server.draft());
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  // Enter at the end of A: the cursor is on the new line — A is left.
  s.type(endOf(s.text, '4. Verify A'), '\n');
  const cursorOnNew = endOf(s.text, '4. Verify A') + 1;
  const first = s.commit([cursorOnNew]);
  assert.deepEqual(first.map((c) => [c.lines, c.afterStep, c.revision]), [[['Verify A'], 0, 1]]);
  // The server takes A; the draft that holds it is not in the file yet.
  const [a] = server.addStep(first[0]);
  s.step(a.id, a.text);
  s.type(cursorOnNew, '5. Verify B');
  // B is left too — but it would name the step A names, and the server would
  // put it in front of A.
  assert.deepEqual(s.commit([0]), [], 'B waits while A is sent and no draft in the file holds it');
  // The draft holding A is written: B goes, after A.
  s.write(server.draft());
  const second = s.commit([0]);
  assert.deepEqual(second.map((c) => [c.lines, c.afterStep, c.revision]), [[['Verify B'], 1, 2]]);
  const [b] = server.addStep(second[0]);
  s.step(b.id, b.text);
  server.record('Tick Cash');
  s.write(server.draft());
  assert.deepEqual(server.steps.map((x) => x.text), ['Click Menu', 'Verify A', 'Verify B', 'Click Payments', 'Tick Cash']);
  const inFile = ['3. Click Menu', '4. Verify A', '5. Verify B', '6. Click Payments', '7. Tick Cash'];
  assert.equal(s.text, withSteps(...inFile).replace('3. Open the dashboard', '8. Open the dashboard'));
  // Stop: the result is the last draft brought up to date. It goes over the
  // draft — not given up on, and not inserted a second time beside it.
  const last = server.draft();
  const result = [...last.steps, 'Sign out'];
  const fin = s.write({ steps: result, parameters: [], ...core.authoredForResult(last, result) });
  assert.ok(!fin.lost, 'the result is written over the last draft');
  assert.equal(s.text, withSteps(...inFile, '8. Sign out').replace('3. Open the dashboard', '9. Open the dashboard'));
  once(s.text, ['Click Menu', 'Verify A', 'Verify B', 'Click Payments', 'Tick Cash', 'Sign out']);
});

test('a line typed directly above one that is sent and not held yet waits too: both would name the step above them', () => {
  const server = new FakeServer(['Click Menu', 'Click Payments']);
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(server.draft());
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  const [first] = s.commit([]);
  const [a] = server.addStep(first);
  s.step(a.id, a.text);
  // A whole line pasted in front of A.
  s.author([change(s.text.indexOf('4. Verify A'), 0, 'Verify Z\n')]);
  assert.deepEqual(s.lines().map((l) => [l.line, l.status]), [['Verify Z', 'typing'], ['4. Verify A', 'sent']]);
  assert.deepEqual(s.commit([]), [], 'Z waits');
  s.write(server.draft());
  const [z] = s.commit([]);
  assert.deepEqual([z.lines, z.afterStep, z.revision], [['Verify Z'], 0, 2], 'after Click Menu, which is before A in the draft that holds A');
  const [made] = server.addStep(z);
  s.step(made.id, made.text);
  s.write(server.draft());
  assert.deepEqual(server.steps.map((x) => x.text), ['Click Menu', 'Verify Z', 'Verify A', 'Click Payments']);
  assert.equal(s.text, withSteps('3. Click Menu', '4. Verify Z', '5. Verify A', '6. Click Payments').replace('3. Open the dashboard', '7. Open the dashboard'));
});

test('lines between the same two steps that count together are ONE add-step, whatever blank line sits between them', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [], revision: 1 });
  s.author([change(s.text.indexOf('4. Click Payments'), 0, '4. First\n\n- Second\n')]);
  assert.deepEqual(s.lines().map((l) => l.line), ['4. First', '', '- Second']);
  const commits = s.commit([]);
  assert.deepEqual(commits.map((c) => [c.lines, c.afterStep]), [[['First', 'Second'], 0]]);
});

test('a draft that holds the author\'s lines the other way round is laid out by count: written, never twice, numbered as the file has them; Stop writes over it and Cancel keeps the lines', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A\n5. Verify B');
  s.commit([]);
  s.step('s1', 'Verify A');
  s.step('s2', 'Verify B');
  // The server put B in front of A (two add-steps aimed at one step).
  const reversed = { steps: ['Click Menu', 'Verify B', 'Verify A', 'Click Payments'], parameters: [], authored: [1, 2], authoredIds: ['s2', 's1'], locked: 4 };
  const w = s.write(reversed);
  assert.ok(!w.lost, 'the file is not given up on');
  const typed = ['3. Click Menu', '4. Verify A', '5. Verify B', '6. Click Payments'];
  assert.equal(s.text, withSteps(...typed).replace('3. Open the dashboard', '7. Open the dashboard'));
  for (const e of w.edits.filter((e) => e.kind === 'mine')) assert.match(e.text, /^\d+$/, 'only a number of the author\'s lines');
  assert.deepEqual(s.lines().map((l) => [l.stepId, l.inDraft]), [['s1', true], ['s2', true]]);
  s.write({ ...reversed, steps: [...reversed.steps, 'Tick Cash'] });
  assert.equal(s.text, withSteps(...typed, '7. Tick Cash').replace('3. Open the dashboard', '8. Open the dashboard'));
  // Stop.
  const result = [...reversed.steps, 'Tick Cash', 'Sign out'];
  const fin = s.write({ steps: result, parameters: [], ...core.authoredForResult(reversed, result) });
  assert.ok(!fin.lost);
  assert.equal(s.text, withSteps(...typed, '7. Tick Cash', '8. Sign out').replace('3. Open the dashboard', '9. Open the dashboard'));
  once(s.text, ['Verify A', 'Verify B', 'Click Menu', 'Click Payments']);
  // Cancel instead: the recording's lines out, the author's kept.
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. Verify A\n5. Verify B\n3. Open the dashboard'));
});

test('a flow written 1. throughout stays that way when the author\'s lines are laid out by count', () => {
  const text = doc('## Steps', '1. A', '1. B', '');
  const s = new Session(text, '1. A');
  s.write({ steps: ['Menu', 'Pay'], parameters: [] });
  assert.equal(s.text, doc('## Steps', '1. A', '1. Menu', '1. Pay', '1. B', ''));
  s.type(endOf(s.text, '1. Menu'), '\nX\nY');
  s.commit([]);
  s.step('s1', 'X');
  s.step('s2', 'Y');
  const w = s.write({ steps: ['Menu', 'Y', 'X', 'Pay'], parameters: [], authored: [1, 2], authoredIds: ['s2', 's1'] });
  assert.ok(!w.lost);
  assert.equal(s.text, doc('## Steps', '1. A', '1. Menu', '1. X', '1. Y', '1. Pay', '1. B', ''));
});

test('Stop counts every line with a step on it — the cursor\'s too — and waits for nothing', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [], revision: 1 });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  assert.equal(s.commit([]).length, 1);
  s.type(endOf(s.text, '4. Verify A'), '\n5. Verify B');
  const cursor = endOf(s.text, '5. Verify B');
  assert.deepEqual(s.commit([cursor]), [], 'still typed on');
  assert.deepEqual(s.commit([]), [], 'and waiting on A');
  const final = s.commit([cursor], { final: true });
  assert.deepEqual(final.map((c) => [c.lines, c.afterStep, c.revision]), [[['Verify B'], 0, 1]]);
});

test('a line sent at Stop that no draft held yet is the result\'s step with its text: adopted, not written a second time beside it', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [], revision: 1 });
  s.type(endOf(s.text, '4. Click Payments'), '\n5. Verify B');
  assert.equal(s.commit([endOf(s.text, '5. Verify B')], { final: true }).length, 1);
  const result = ['Click Menu', 'Click Payments', 'Verify B'];
  const authored = core.authoredForResult({ steps: ['Click Menu', 'Click Payments'] }, result);
  const expected = withSteps('3. Click Menu', '4. Click Payments', '5. Verify B').replace('3. Open the dashboard', '6. Open the dashboard');
  // The one-shot insertion knows it too.
  assert.deepEqual(core.oneShotSteps(s.live, s.text, { steps: result, ...authored }).kept, ['Verify B']);
  const fin = s.write({ steps: result, parameters: [], ...authored, adoptSentByText: true });
  assert.ok(!fin.lost);
  assert.equal(s.text, expected);
});

test('an add-step names the revision of the draft that was in the file when its lines were counted', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [], revision: 3 });
  s.type(endOf(s.text, '3. Click Menu'), '\nMine');
  const [c] = s.commit([]);
  assert.equal(c.revision, 3);
  // A later draft does not change what that count named.
  s.write({ steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [], revision: 7 });
  assert.equal(c.revision, 3);
  s.type(endOf(s.text, '5. Tick Cash'), '\nOther');
  assert.equal(s.commit([])[0].revision, 7);
});

test('the one-shot insertion at Stop leaves out the author\'s steps whose lines are still in the file', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  s.type(endOf(s.text, '4. Verify A'), '\nOther');
  s.commit([]);
  s.step('s1', 'Verify A');
  const held = { steps: ['Click Menu', 'Verify A', 'Other', 'Click Payments'], parameters: [], authored: [1, 2], authoredIds: ['s1', ''] };
  s.write(held);
  // The block pasted a second time: what the recording wrote is there twice.
  const block = s.text.slice(s.text.indexOf('3. Click Menu'), s.text.indexOf('7. Open the dashboard'));
  s.author([change(s.text.length, 0, block)], { uncertain: true });
  const result = [...held.steps, 'Tick Cash'];
  const authored = core.authoredForResult(held, result);
  assert.deepEqual(authored, { authored: [1, 2], authoredIds: ['s1', ''] }, 'a step with no id keeps its place, by text');
  const lost = s.write({ steps: result, parameters: [], ...authored });
  assert.equal(lost.lost, true);
  assert.deepEqual(core.oneShotSteps(s.live, s.text, { steps: result, ...authored }), {
    steps: ['Click Menu', 'Click Payments', 'Tick Cash'],
    kept: ['Verify A', 'Other'],
  });
  // A line the author deleted is not in the file: its step goes in.
  const gone = s.text.replace('\n4. Verify A\n', '\n');
  assert.deepEqual(core.oneShotSteps(s.live, gone.split('4. Verify A').join(''), { steps: result, ...authored }).kept, ['Other']);
  assert.deepEqual(core.oneShotSteps(null, s.text, { steps: result, ...authored }).steps, result);
});

test('authoredIds absent from the wire: the draft\'s author steps are known by the text their lines were sent as — adopted, never a second copy', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  s.commit([]);
  const draft = { steps: ['Click Menu', 'Verify A', 'Click Payments', 'Tick Cash'], parameters: [], authored: [1] };
  s.write(draft);
  assert.equal(s.text, withSteps('3. Click Menu', '4. Verify A', '5. Click Payments', '6. Tick Cash').replace('3. Open the dashboard', '7. Open the dashboard'));
  assert.equal(s.lines()[0].inDraft, true);
  // The panel's copy names '' for the missing id; the result keeps it.
  const result = [...draft.steps, 'Sign out'];
  const fin = s.write({ steps: result, parameters: [], ...core.authoredForResult({ ...draft, authoredIds: [''] }, result) });
  assert.ok(!fin.lost);
  once(s.text, ['Verify A']);
});

// ---------------------------------------------------------------------------
// Undo of a step typed in the file (review of 0.5.155, finding 3)
// ---------------------------------------------------------------------------

const HELD_A = { steps: ['Click Menu', 'Verify A', 'Click Payments'], parameters: [], authored: [1], authoredIds: ['s1'], locked: 3 };

/** A session with "4. Verify A" typed between the recorded steps and held. */
function heldA() {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  s.commit([]);
  s.step('s1', 'Verify A');
  s.write(HELD_A);
  assert.equal(s.text, withSteps('3. Click Menu', '4. Verify A', '5. Click Payments').replace('3. Open the dashboard', '6. Open the dashboard'));
  return s;
}

test('Undo (or the panel\'s ✕) of a step typed in the file takes its line out; Restore puts it back where it was; Cancel puts it back with the author\'s number', () => {
  const s = heldA();
  const without = withSteps('3. Click Menu', '4. Click Payments').replace('3. Open the dashboard', '5. Open the dashboard');
  // The draft already in the file, written again with s1 dropped — what the
  // host does the moment the row is struck.
  const w = s.write({ ...HELD_A, droppedIds: ['s1'] });
  assert.equal(s.text, without, 'the line is out, the steps below close up');
  assert.deepEqual(w.left, []);
  assert.deepEqual(s.lines().map((l) => [l.line, l.dropped]), [['4. Verify A', 'hidden']]);
  // The server's next draft, without it.
  s.write({ steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [], droppedIds: ['s1'] });
  assert.equal(s.text, withSteps('3. Click Menu', '4. Click Payments', '5. Tick Cash').replace('3. Open the dashboard', '6. Open the dashboard'));
  // Restore: struck no more, and the server's draft holds it again.
  s.write({ steps: ['Click Menu', 'Verify A', 'Click Payments', 'Tick Cash'], parameters: [], authored: [1], authoredIds: ['s1'] });
  assert.equal(
    s.text,
    withSteps('3. Click Menu', '4. Verify A', '5. Click Payments', '6. Tick Cash').replace('3. Open the dashboard', '7. Open the dashboard'),
    'back where it was',
  );
  assert.deepEqual(s.lines().map((l) => [l.stepId, l.inDraft, l.dropped]), [['s1', true, undefined]]);
  // Dropped again, then Cancel: every line the author typed comes back.
  s.write({ steps: ['Click Menu', 'Verify A', 'Click Payments', 'Tick Cash'], parameters: [], authored: [1], authoredIds: ['s1'], droppedIds: ['s1'] });
  assert.ok(!s.text.includes('Verify A'));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. Verify A\n3. Open the dashboard'));
});

test('restored before the server\'s draft holds it again: the line comes back at once, and is adopted when the draft arrives', () => {
  const s = heldA();
  s.write({ ...HELD_A, droppedIds: ['s1'] });
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [], droppedIds: ['s1'] });
  assert.equal(s.text, withSteps('3. Click Menu', '4. Click Payments').replace('3. Open the dashboard', '5. Open the dashboard'));
  // Restored in the panel: the draft in the file, which does not hold it,
  // written again with nothing dropped.
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  assert.equal(s.text, withSteps('3. Click Menu', '4. Verify A', '4. Click Payments').replace('3. Open the dashboard', '5. Open the dashboard'));
  s.write(HELD_A);
  assert.equal(s.text, withSteps('3. Click Menu', '4. Verify A', '5. Click Payments').replace('3. Open the dashboard', '6. Open the dashboard'));
});

test('Undo of a step typed in the file whose line the author has edited since: the line stays, and says so once', () => {
  const s = heldA();
  s.type(endOf(s.text, '4. Verify A'), '!');
  const w = s.write({ ...HELD_A, droppedIds: ['s1'] });
  assert.deepEqual(w.left.map((l) => l.line), ['4. Verify A!']);
  assert.equal(core.leftInFileText(w.left[0].line), 'Your step 4 was left in the file because you edited it — delete it if you meant to.');
  assert.match(s.text, /^4\. Verify A!$/m, 'still in the file');
  assert.deepEqual(s.lines().map((l) => l.dropped), ['left']);
  const again = s.write({ steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [], droppedIds: ['s1'] });
  assert.deepEqual(again.left, [], 'said once');
  assert.match(s.text, /^4\. Verify A!$/m);
  once(s.text, ['Verify A']);
  // Restored; the author takes the "!" back out; dropped again: the line reads
  // as the recording left it, so this time it goes.
  const heldAgain = { ...HELD_A, steps: [...HELD_A.steps, 'Tick Cash'] };
  s.write(heldAgain);
  assert.deepEqual(s.lines().map((l) => [l.inDraft, l.dropped]), [[true, undefined]]);
  s.author([change(s.text.indexOf('Verify A!') + 'Verify A'.length, 1, '')]);
  const gone = s.write({ ...heldAgain, droppedIds: ['s1'] });
  assert.deepEqual(gone.left, []);
  assert.ok(!s.text.includes('Verify A'));
  assert.equal(core.leftInFileText('Check it'), 'Your step "Check it" was left in the file because you edited it — delete it if you meant to.');
});

// ---------------------------------------------------------------------------
// The author's own number (review of 0.5.155, finding 4)
// ---------------------------------------------------------------------------

test('a held line whose number was already right: a number the author types afterwards is theirs, and a line they empty gets no number', () => {
  const s = heldA();
  s.author([change(s.text.indexOf('4. Verify A'), 1, '9')]);
  assert.match(s.text, /^9\. Verify A$/m);
  const more = { ...HELD_A, steps: [...HELD_A.steps, 'Tick Cash'] };
  s.write(more);
  assert.match(s.text, /^9\. Verify A$/m, 'the author\'s 9 stays');
  // The line emptied by the author.
  const at = s.text.indexOf('9. Verify A');
  s.author([change(at, '9. Verify A'.length, '')]);
  s.write({ ...more, steps: [...more.steps, 'Click Pay'] });
  assert.equal(s.text, withSteps('3. Click Menu', '', '5. Click Payments', '6. Tick Cash', '7. Click Pay').replace('3. Open the dashboard', '8. Open the dashboard'));
});

test('a line sent and then emptied before a draft holds it is not given a bare number', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '3. Click Menu'), '\nVerify A');
  s.commit([]);
  s.step('s1', 'Verify A');
  const at = s.text.indexOf('Verify A');
  s.author([change(at, 'Verify A'.length, '')]);
  s.write(HELD_A);
  assert.equal(s.text, withSteps('3. Click Menu', '', '5. Click Payments').replace('3. Open the dashboard', '6. Open the dashboard'));
});

// ---------------------------------------------------------------------------
// Only steps count (review of 0.5.155, finding 5)
// ---------------------------------------------------------------------------

test('a heading, a data table, ## Parameters or a comment typed under the recorded steps is never sent, and never numbered', () => {
  const base = doc('# T', '', '## Steps', '1. Navigate to /', '');
  const cases = [
    ['### Checkout'],
    ['| user | pass |', '| --- | --- |', '| a | b |'],
    ['## Parameters'],
    ['<!-- a note -->'],
    ['#### Notes', '1. Aside'],
    ['```', 'raw', '```'],
  ];
  for (const typed of cases) {
    const s = new Session(base, '1. Navigate to /');
    s.write({ steps: ['Click Menu'], parameters: [] });
    s.type(endOf(s.text, '2. Click Menu'), `\n${typed.join('\n')}`);
    assert.deepEqual(s.commit([]), [], JSON.stringify(typed));
    s.write({ steps: ['Click Menu', 'Click Pay'], parameters: [] });
    assert.equal(s.text, doc('# T', '', '## Steps', '1. Navigate to /', '2. Click Menu', '3. Click Pay', ...typed, ''), JSON.stringify(typed));
  }
  // Text and list items are steps once numbered: they count.
  const s = new Session(base, '1. Navigate to /');
  s.write({ steps: ['Click Menu'], parameters: [] });
  s.type(endOf(s.text, '2. Click Menu'), '\nCheck it\n- Check more');
  assert.deepEqual(s.commit([]).map((c) => c.lines), [['Check it', 'Check more']]);
});

test('a line typed below a ## heading the author added is outside ## Steps: never sent', () => {
  const base = doc('# T', '', '## Steps', '1. Navigate to /', '');
  const s = new Session(base, '1. Navigate to /');
  s.write({ steps: ['Click Menu'], parameters: [] });
  s.type(endOf(s.text, '2. Click Menu'), '\n## Parameters\n- user: demo');
  assert.deepEqual(s.commit([]), []);
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
test('random author lines, drafts that lag behind the lines sent, and a server that places each line by (afterStep, revision) as draft-engine.ts does: a write never replaces what the author typed (bar a held line\'s number), the server holds the lines in the file\'s order, nothing is written twice, the writing never stops, and Stop or Cancel leaves the author\'s lines', () => {
  const STEP_TEXTS = ['Click Menu', 'Click Payments', 'Tick Cash', 'Click Pay', 'Sign out', 'Open Reports', 'Close Reports'];
  const LINES = ['Check A', 'Check B', 'Verify C', '9. Verify D', '- Verify E', 'Check F', 'Verify G'];
  let adopted = 0;
  let lostCount = 0;
  /** Writes made while an add-step was unplaced, or placed and in no draft
   *  written yet — the lag the first version of this test never had. */
  let lagged = 0;
  /** Lines that waited for a draft to hold the line next to them. */
  let waited = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = prng(seed);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const s = new Session(FIXTURE, '2. Click Sign in');
    let chars = [...FIXTURE].map((c) => ({ c, own: 'base' }));
    const textOf = () => chars.map((x) => x.c).join('');
    const label = (op) => `seed ${seed}, ${op}`;
    let recorded = 1;
    const server = new FakeServer(STEP_TEXTS.slice(0, 1));
    /** Add-steps sent and not placed yet, in the order they were sent. */
    const inbox = [];
    /** Steps the server placed whose `record:step` has not arrived. */
    let unnamed = [];
    let written = 0;
    const typedTexts = new Set();
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
    /** The author's lines a written draft holds are in the file in the order
     *  the server holds their steps. */
    const inServerOrder = (op) => {
      const ids = s.live.slots.filter((x) => x.kind === 'mine' && x.inDraft).map((x) => x.stepId);
      const at = ids.map((id) => server.steps.findIndex((x) => x.id === id));
      assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), label(`${op}: the file has the author's lines ${JSON.stringify(ids)} in another order than the server (${at})`));
    };
    /** The author's lines left since: counted as step-recorder counts them,
     *  and sent. */
    const count = (opts) => {
      const ready = s.lines().filter((l) => l.status === 'typing' && core.cleanAuthorLine(l.line) !== '').length;
      const commits = s.commit([], opts);
      const went = commits.reduce((n, c) => n + c.lines.length, 0);
      if (went < ready) waited++;
      inbox.push(...commits);
    };
    /** The latest draft into the file — then the lines left meanwhile are
     *  counted, as step-recorder.ts does after every write. */
    const writeLatest = (op, opts = {}) => {
      if (inbox.length > 0 || s.lines().some((l) => l.status === 'sent' && !l.inDraft)) lagged++;
      const w = s.write(server.draft());
      if (w.lost) {
        lostCount++;
        return false;
      }
      written = server.revision;
      applyWrite(w, op);
      if (!opts.stop) inServerOrder(op);
      count();
      return true;
    };
    /** The server takes the first `n` add-steps sent. */
    const place = (n) => {
      for (const c of inbox.splice(0, n)) {
        const made = server.addStep(c);
        for (const step of made) {
          // `record:step` now, or later.
          if (rnd() < 0.5) s.step(step.id, step.text);
          else unnamed.push(step);
        }
      }
    };

    s.write(server.draft());
    written = server.revision;
    // Ownership after the first write: the fixture with the one recorded line.
    {
      const at = FIXTURE.indexOf('3. Open the dashboard');
      chars = [...FIXTURE.slice(0, at)].map((c) => ({ c, own: 'base' }));
      chars.push(...[...'3. Click Menu\n'].map((c) => ({ c, own: 'rec' })));
      chars.push(...[...'4'].map((c) => ({ c, own: 'rec' })));
      chars.push(...[...FIXTURE.slice(at + 1)].map((c) => ({ c, own: 'base' })));
    }
    assert.equal(textOf(), s.text, label('setup'));

    for (let op = 0; op < 40 && !s.lost; op++) {
      const r = rnd();
      const run = s.live.slots.filter((x) => x.kind === 'block' || x.kind === 'mine');
      const runEnd = run[run.length - 1].end;
      const runStart = run[0].start;
      if (r < 0.15) {
        // The server records another step (appended to the open part); its
        // draft is not in the file yet.
        if (recorded < STEP_TEXTS.length) server.record(STEP_TEXTS[recorded++]);
      } else if (r < 0.3) {
        // The latest draft reaches the file.
        if (server.revision === written) continue;
        const before = s.lines().filter((l) => l.inDraft).length;
        if (!writeLatest(`write ${op}`)) break;
        if (s.lines().filter((l) => l.inDraft).length > before) adopted++;
      } else if (r < 0.5) {
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
      } else if (r < 0.62) {
        // The author leaves their lines: those that count are sent.
        count();
      } else if (r < 0.77) {
        // The server places what was sent — one add-step, or all of them —
        // each by the step it names in the draft it names.
        place(rnd() < 0.5 ? 1 : inbox.length);
      } else if (r < 0.83) {
        // The `record:step` frames that were late.
        for (const step of unnamed) s.step(step.id, step.text);
        unnamed = [];
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
      // A step of the author's, or a recorded one, is in the file once.
      for (const text of [...typedTexts].map(core.cleanAuthorLine).concat(STEP_TEXTS)) {
        const n = s.text.split('\n').filter((l) => core.cleanAuthorLine(l) === text).length;
        assert.ok(n <= 1, label(`op ${op}: ${JSON.stringify(text)} is in the file ${n} times`));
      }
    }
    if (s.lost) continue;
    const typedThere = () => {
      for (const typed of typedTexts) {
        const text = core.cleanAuthorLine(typed);
        assert.ok(s.text.split('\n').some((l) => core.cleanAuthorLine(l).startsWith(text)), label(`the author's ${JSON.stringify(typed)} is gone`));
      }
    };
    if (rnd() < 0.5) {
      // Stop: every line left goes, waiting for nothing — so the server may
      // put two of them the other way round, which the file does not follow
      // (laid out by count); the server places them all; the result is the
      // last draft with one more step, written over the draft in the file.
      count({ final: true });
      place(inbox.length);
      for (const step of unnamed) s.step(step.id, step.text);
      unnamed = [];
      if (server.revision !== written && !writeLatest('last draft', { stop: true })) continue;
      const last = server.draft();
      const result = [...last.steps, 'Stopped'];
      const w = s.write({ steps: result, parameters: [], ...core.authoredForResult(last, result) });
      assert.ok(!w.lost, label('Stop: the result is written over the draft'));
      applyWrite(w, 'Stop');
      assert.equal(s.text, textOf());
      for (const text of [...typedTexts].map(core.cleanAuthorLine).concat(result)) {
        const n = s.text.split('\n').filter((l) => core.cleanAuthorLine(l) === text).length;
        assert.ok(n <= 1, label(`Stop: ${JSON.stringify(text)} is in the file ${n} times`));
      }
      for (const text of result) {
        assert.ok(s.text.split('\n').some((l) => core.cleanAuthorLine(l).startsWith(text)), label(`Stop: ${JSON.stringify(text)} is not in the file`));
      }
      typedThere();
      continue;
    }
    // Cancel.
    const w = s.write(EMPTY);
    if (w.lost) continue;
    applyWrite(w, 'Cancel');
    assert.equal(s.text, textOf());
    for (const line of s.text.split('\n')) {
      assert.ok(!STEP_TEXTS.some((t) => line.endsWith(`. ${t}`)), label(`Cancel left a recorded line: ${JSON.stringify(line)}`));
    }
    // Every line the author typed is still there.
    typedThere();
  }
  // Lines are only ever sent where the server keeps their order, so the
  // writing never had reason to stop.
  assert.equal(lostCount, 0);
  assert.ok(adopted > 100, `adopted: ${adopted}`);
  assert.ok(lagged > 300, `lagged: ${lagged}`);
  assert.ok(waited > 20, `waited: ${waited}`);
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

test('the panel\'s Add step box keeps its text until the host says the server took the steps; a refusal keeps it with the reason (recording-panel.js)', async () => {
  const box = await import('../src/webview/lib/recording-panel.js');
  let b = box.addStepBoxEdit(box.EMPTY_ADD_STEP_BOX, 'Verify the total');
  // Add pressed: sent, the text still there.
  let press = box.addStepBoxSend(b, 'add-1');
  assert.equal(press.sent, true);
  b = press.box;
  assert.deepEqual(b, { text: 'Verify the total', pending: { id: 'add-1', text: 'Verify the total' }, error: null });
  // A second press while waiting sends nothing.
  assert.equal(box.addStepBoxSend(b, 'add-2').sent, false);
  // An answer to another press changes nothing.
  assert.equal(box.addStepBoxAnswer(b, { type: 'recordAddStepResult', id: 'add-9', accepted: true }), b);
  // Refused: the text stays, with why.
  const refused = box.addStepBoxAnswer(b, { type: 'recordAddStepResult', id: 'add-1', accepted: false, reason: 'the recording is finishing' });
  assert.deepEqual(refused, { text: 'Verify the total', pending: null, error: 'The step was not added — the recording is finishing.' });
  // Typing again clears the reason; pressing again sends it again.
  b = box.addStepBoxEdit(refused, 'Verify the total is 3');
  assert.equal(b.error, null);
  press = box.addStepBoxSend(b, 'add-3');
  b = press.box;
  // Taken: cleared — unless the author typed on meanwhile.
  assert.deepEqual(box.addStepBoxAnswer(b, { id: 'add-3', accepted: true }), box.EMPTY_ADD_STEP_BOX);
  const typedOn = box.addStepBoxEdit(b, 'Verify the total is 3\nClick Pay');
  assert.deepEqual(box.addStepBoxAnswer(typedOn, { id: 'add-3', accepted: true }), { text: 'Verify the total is 3\nClick Pay', pending: null, error: null });
  // A blank box sends nothing.
  assert.equal(box.addStepBoxSend(box.addStepBoxEdit(box.EMPTY_ADD_STEP_BOX, '  \n'), 'add-4').sent, false);
  // No reason given: said plainly.
  assert.equal(
    box.addStepBoxAnswer(box.addStepBoxSend(box.addStepBoxEdit(box.EMPTY_ADD_STEP_BOX, 'x'), 'a').box, { id: 'a', accepted: false }).error,
    'The step was not added — the recording did not take it.',
  );
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
