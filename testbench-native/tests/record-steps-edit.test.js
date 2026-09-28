/**
 * Record Steps: editing, deleting and restoring steps in the test file while
 * the recording runs (stories/testbench-record-edit-steps.md), the TestBench
 * half — pinned against the pure core, with no host.
 *
 * A `Session` drives the core the way step-recorder.ts does: every draft
 * written with the recording's `LineBook`, everyone else's changes followed
 * with `followLiveRecord`, lines the author leaves counted with
 * `commitAuthorLines` and `commitLineEdits`, deletions and undos read back as
 * the `drop` / `restore` controls they queue. `EditServer` plays the server's
 * draft engine: every step has an id (`record:draft.ids`), kept while the step
 * is unchanged; an `edit-step` keeps the id and marks the step `edited`; a
 * `drop` of a step takes it out, and `restore` puts it back after the step
 * that was before it.
 *
 * The host-level halves (real change events, the controls on the wire, the
 * panel) are in tests/integration/suite/record-steps.test.cjs.
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
/** Cancel: the recording takes out what it wrote. */
const CANCEL = { ...EMPTY, clear: true };
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
  constructor(text = FIXTURE, needle = '2. Click Sign in') {
    this.text = text;
    this.anchor = anchorAt(text, needle);
    this.live = null;
    this.lost = false;
    this.touched = false;
    this.book = core.newLineBook();
  }

  write(draft) {
    if (!this.live) {
      const begun = core.beginLiveRecord(this.text, this.anchor);
      assert.ok(!('error' in begun), begun.error);
      this.live = begun;
    }
    const record = this.lost ? { ...this.live, uncertain: true } : this.live;
    const w = core.liveRecordWrite(record, this.text, draft, { anchor: this.anchor, book: this.book });
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
      undo: opts.undo === true,
      anchor: this.anchor,
      book: this.book,
    });
    this.live = followed.record;
    if (followed.touched) this.touched = true;
  }

  /** Typed one keystroke per change event, from `offset`. */
  type(offset, text) {
    for (let i = 0; i < text.length; i++) this.author([change(offset + i, 0, text[i])]);
  }

  /** The author deletes the whole line holding `needle` (Ctrl+Shift+K). */
  deleteLine(needle) {
    const at = this.text.indexOf(needle);
    assert.ok(at >= 0, `no ${JSON.stringify(needle)}`);
    const start = this.text.lastIndexOf('\n', at) + 1;
    const end = this.text.indexOf('\n', at) + 1;
    const removed = this.text.slice(start, end);
    this.author([change(start, end - start, '')]);
    return { start, removed };
  }

  /** Ctrl+Z of a deletion: the text back where it was, as an undo. */
  undoDelete({ start, removed }) {
    this.author([change(start, 0, removed)], { uncertain: true, undo: true });
  }

  /** The author's lines no cursor is on (`cursors`: offsets) — add-steps and
   *  the edits of steps, as the recorder sends them. */
  commit(cursors = [], opts = {}) {
    const adds = core.commitAuthorLines(this.live, this.text, cursors, opts);
    this.live = adds.record;
    const edits = core.commitLineEdits(this.live, this.text, cursors, { ...opts, book: this.book });
    this.live = edits.record;
    return { adds: adds.commits, edits: edits.commits };
  }

  /** The drop / restore controls queued by deletions and undos. */
  controls() {
    return core.takeLineControls(this.book);
  }

  edited(event) {
    this.live = core.noteStepEdited(this.live, event, this.book);
  }

  lines() {
    return core.authorLinesOf(this.live);
  }
}

/** The offset just past `needle` in `text`. */
const endOf = (text, needle) => {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `no ${JSON.stringify(needle)}`);
  return at + needle.length;
};

/** FIXTURE with `lines` after "2. Click Sign in", and the next step numbered `open`. */
const withLines = (lines, open) =>
  FIXTURE.replace('2. Click Sign in\n', `2. Click Sign in\n${lines.join('\n')}\n`).replace('3. Open the dashboard', `${open}. Open the dashboard`);

/** FIXTURE with `steps` recorded after "2. Click Sign in", the rest renumbered. */
const recorded = (...steps) => withLines(steps, 3 + steps.length);

/**
 * The server's draft engine as far as ids go (stories/testbench-record-edit-steps.md
 * §"The wire, exactly"): each step keeps its id while it is unchanged in
 * place; the model's steps are `dN`, the author's `sN`. `edit` keeps the id
 * and marks the step edited; `drop` takes a step out, remembering the step
 * before it; `restore` puts it back after that one.
 */
class EditServer {
  constructor(steps = []) {
    this.seq = 0;
    this.sseq = 0;
    this.steps = steps.map((text) => ({ text, id: `d${++this.seq}` }));
    this.revision = 0;
    this.history = new Map();
    this.gone = [];
    this.emit();
  }

  emit() {
    this.revision += 1;
    this.history.set(this.revision, this.steps.map((s) => s.text));
  }

  draft() {
    const authored = [];
    const authoredIds = [];
    const edited = [];
    this.steps.forEach((s, i) => {
      if (s.author) {
        authored.push(i);
        authoredIds.push(s.id);
      }
      if (s.edited) edited.push(i);
    });
    return {
      steps: this.steps.map((s) => s.text),
      parameters: [],
      ids: this.steps.map((s) => s.id),
      ...(edited.length > 0 && { edited }),
      ...(authored.length > 0 && { authored, authoredIds }),
      revision: this.revision,
    };
  }

  /** The model records one more step at the end. */
  record(text) {
    this.steps.push({ text, id: `d${++this.seq}` });
    this.emit();
  }

  /** The model rewrites step `i` (not an edited one): a new id. */
  rewrite(i, text) {
    this.steps[i] = { text, id: `d${++this.seq}` };
    this.emit();
  }

  edit(id, text) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return { ignored: 'no step stands for its actions any more' };
    s.text = text;
    s.edited = true;
    this.emit();
    return { id };
  }

  drop(id) {
    const i = this.steps.findIndex((x) => x.id === id);
    if (i < 0) return { ignored: 'already dropped' };
    this.gone.push({ step: this.steps[i], after: this.steps[i - 1]?.id ?? null });
    this.steps.splice(i, 1);
    this.emit();
    return {};
  }

  restore(id) {
    const k = this.gone.findIndex((g) => g.step.id === id);
    if (k < 0) return { ignored: 'not dropped' };
    const [g] = this.gone.splice(k, 1);
    const at = g.after === null ? 0 : this.steps.findIndex((x) => x.id === g.after) + 1;
    this.steps.splice(at <= 0 && g.after !== null ? this.steps.length : at, 0, g.step);
    this.emit();
    return {};
  }

  mapIndex(afterStep, revision) {
    const clamp = (i) => Math.max(0, Math.min(i, this.steps.length - 1));
    if (revision === undefined || revision === this.revision) return afterStep;
    const text = this.history.get(revision)?.[afterStep];
    if (text === undefined) return clamp(afterStep);
    let best = -1;
    this.steps.forEach((s, i) => {
      if (s.text === text && (best < 0 || Math.abs(i - afterStep) < Math.abs(best - afterStep))) best = i;
    });
    return best >= 0 ? best : clamp(afterStep);
  }

  addStep(commit) {
    const at = commit.afterStep === undefined ? undefined : this.mapIndex(commit.afterStep, commit.revision);
    const made = commit.lines.map((text) => ({ text, id: `s${++this.sseq}`, author: true }));
    if (at === undefined || at >= this.steps.length - 1) this.steps.push(...made);
    else this.steps.splice(at + 1, 0, ...made);
    this.emit();
    return made;
  }

  idOf(text) {
    return this.steps.find((s) => s.text === text)?.id;
  }
}

/** Each of `texts` is in `text` exactly once. */
function once(text, texts) {
  for (const t of texts) assert.equal(text.split(t).length, 2, `${JSON.stringify(t)} is in the file ${text.split(t).length - 1} times`);
}

// ---------------------------------------------------------------------------
// Rewording a recorded line
// ---------------------------------------------------------------------------

test('a recorded line reworded in the file: the recording stops writing it at the first keystroke, still numbers it; left, it is one edit-step; the draft that holds the edit adopts the line — never twice; Cancel takes it out', () => {
  const server = new EditServer(['Click Menu', 'Click Payments in the main menu']);
  const s = new Session();
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments in the main menu'));

  // The author selects "Click Payments in the main menu" and types over it.
  const from = s.text.indexOf('Click Payments in the main menu');
  s.author([change(from, 'Click Payments in the main menu'.length, 'O')]);
  s.type(from + 1, 'pen Payments from the side menu');
  assert.equal(s.touched, false, 'no warning: the line is the author\'s now');
  assert.deepEqual(s.lines().map((l) => [l.line, l.origin, l.status, l.stepId]), [['4. Open Payments from the side menu', 'edit', 'typing', 'd2']]);

  // A draft meanwhile: a step recorded above it (the model inserted one) — the
  // line is renumbered, its words untouched, and not written beside it.
  server.steps.splice(1, 0, { text: 'Close the banner', id: `d${++server.seq}` });
  server.emit();
  const w = s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Close the banner', '5. Open Payments from the side menu'));
  assert.deepEqual(
    w.edits.filter((e) => e.kind === 'mine').map((e) => [e.why, e.text]),
    [['number', '5']],
    'only its number',
  );

  // Still on the line: nothing sent.
  assert.deepEqual(s.commit([endOf(s.text, 'side menu')]).edits, []);
  // Left: one edit-step, naming the draft the author was looking at.
  const { edits } = s.commit([0]);
  assert.deepEqual(edits.map(({ action, id, text, revision }) => ({ action, id, text, revision })), [
    { action: 'edit-step', id: 'd2', text: 'Open Payments from the side menu', revision: 2 },
  ]);
  assert.deepEqual(s.commit([0]).edits, [], 'sent once');

  // The server takes it: record:edited, then the draft that holds it edited.
  server.edit('d2', 'Open Payments from the side menu');
  s.edited({ id: 'd2', text: 'Open Payments from the side menu', source: 'editor' });
  server.record('Tick the Cash checkbox');
  s.write(server.draft());
  const expected = recorded('3. Click Menu', '4. Close the banner', '5. Open Payments from the side menu', '6. Tick the Cash checkbox');
  assert.equal(s.text, expected);
  once(s.text, ['Open Payments from the side menu']);
  assert.ok(!s.text.includes('Click Payments'), 'the model\'s words never come back');
  assert.deepEqual(s.lines().map((l) => [l.status, l.inDraft, l.unacked]), [['sent', true, undefined]]);

  // Cancel: every step the recording wrote out, the reworded one too.
  s.write(CANCEL);
  assert.equal(s.text, FIXTURE);
});

test('a number changed alone is no edit: the line stays the recording\'s, and the next draft puts its number back', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  const at = s.text.indexOf('4. Click Payments');
  s.author([change(at, 1, '9')]);
  assert.deepEqual(s.lines(), [], 'not a line of the author\'s');
  assert.deepEqual(s.commit([]), { adds: [], edits: [] });
  server.record('Tick Cash');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments', '5. Tick Cash'));
});

test('a reworded line changed back before the cursor left it is no edit: nothing is sent, and it is the recording\'s line again', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  const at = endOf(s.text, '4. Click Payments');
  s.type(at, ' now');
  assert.equal(s.lines()[0].origin, 'edit');
  s.author([change(at, 4, '')]);
  assert.deepEqual(s.commit([]).edits, []);
  assert.deepEqual(s.lines(), [], 'absorbed: the recording\'s line again');
  // The model may rewrite it, as any step of its own.
  server.rewrite(1, 'Click Payments in the menu');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments in the menu'));
});

test('a reworded line emptied, or left only its number, is a delete: drop, and the line stays as the author left it', () => {
  for (const leave of ['', '4.']) {
    const server = new EditServer(['Click Menu', 'Click Help', 'Click Payments']);
    const s = new Session();
    s.write(server.draft());
    const at = s.text.indexOf('4. Click Help');
    s.author([change(at, '4. Click Help'.length, leave)]);
    const { edits } = s.commit([]);
    assert.deepEqual(edits.map((e) => [e.action, e.id]), [['drop', 'd2']], JSON.stringify(leave));
    server.drop('d2');
    s.write(server.draft());
    assert.equal(s.text, withLines(['3. Click Menu', leave, '4. Click Payments'], 5), JSON.stringify(leave));
    assert.deepEqual(s.lines().map((l) => [l.line, l.origin, l.status]), [[leave, undefined, 'typing']]);
  }
});

test('Enter typed at the start of a recorded line opens a new line above it: the step stays on its line', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  const at = s.text.indexOf('4. Click Payments');
  s.type(at, 'Verify the menu');
  s.author([change(at + 'Verify the menu'.length, 0, '\n')]);
  const lines = s.lines();
  assert.deepEqual(lines.map((l) => [l.line, l.origin ?? 'typed']), [['Verify the menu', 'typed'], ['4. Click Payments', 'edit']]);
  const { adds, edits } = s.commit([]);
  assert.deepEqual(adds.map((c) => [c.lines, c.afterStep]), [[['Verify the menu'], 0]]);
  assert.deepEqual(edits, [], 'the step\'s line reads as it did');
  assert.deepEqual(s.lines().map((l) => l.line), ['Verify the menu'], 'the step\'s line is the recording\'s again');
});

// ---------------------------------------------------------------------------
// Deleting recorded lines
// ---------------------------------------------------------------------------

test('a recorded line deleted whole is a drop at once; Ctrl+Z of the deletion is a restore; a draft in flight that still holds a deleted step does not write it back', () => {
  const server = new EditServer(['Click Menu', 'Click Help', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  const before = s.text;
  const del = s.deleteLine('4. Click Help');
  assert.deepEqual(s.controls(), [{ action: 'drop', id: 'd2' }], 'as soon as the line is gone');
  assert.ok(!s.lost);
  // Ctrl+Z straight away: the line back is its step restored.
  s.undoDelete(del);
  assert.equal(s.text, before);
  assert.ok(!s.lost, 'found again by its text');
  assert.deepEqual(s.controls(), [{ action: 'restore', id: 'd2' }]);
  assert.deepEqual(s.commit([]), { adds: [], edits: [] }, 'the line back is the recording\'s, not an edit');

  // Deleted again. A draft that left the server before the drop arrived still
  // holds d2: it is not written back.
  s.deleteLine('4. Click Help');
  assert.deepEqual(s.controls(), [{ action: 'drop', id: 'd2' }]);
  server.record('Tick Cash');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments', '5. Tick Cash'), 'the deleted step is not written back');
  // The server's own draft without it.
  server.drop('d2');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments', '5. Tick Cash'));
  once(s.text, ['Click Payments']);
});

test('the undo of a deletion that the next draft renumbered around: first Ctrl+Z takes the renumbering back, the second the deletion — restored, never lost', () => {
  const server = new EditServer(['Click Menu', 'Click Help', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  const before = s.text;
  const del = s.deleteLine('4. Click Help');
  assert.deepEqual(s.controls(), [{ action: 'drop', id: 'd2' }]);
  server.drop('d2');
  const afterDelete = s.text;
  const w = s.write(server.draft());
  assert.ok(w.edits.length > 0, 'the draft renumbered');
  // Ctrl+Z #1: the renumbering undone.
  s.author([change(0, s.text.length, afterDelete)], { uncertain: true, undo: true });
  assert.ok(!s.lost);
  assert.deepEqual(s.controls(), []);
  // Ctrl+Z #2: the deletion undone.
  s.undoDelete(del);
  assert.equal(s.text, before);
  assert.ok(!s.lost);
  assert.deepEqual(s.controls(), [{ action: 'restore', id: 'd2' }]);
  server.restore('d2');
  s.write(server.draft());
  assert.equal(s.text, before);
});

test('lines deleted across a recorded line and one the author typed are both deletes — the file is not given up on', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  const [add] = s.commit([]).adds;
  const [made] = server.addStep(add);
  s.live = core.assignAuthorStepId(s.live, made.id, made.text, s.book);
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Verify A', '5. Click Payments'));
  // Select "4. Verify A" and "5. Click Payments" — whole lines — and delete.
  const from = s.text.indexOf('4. Verify A');
  const to = endOf(s.text, '5. Click Payments') + 1;
  s.author([change(from, to - from, '')]);
  assert.ok(!s.lost);
  assert.equal(s.live.uncertain, false, 'followed by offsets');
  assert.deepEqual(s.controls().map((c) => [c.action, c.id]).sort(), [['drop', 'd2'], ['drop', 's1']]);
  server.drop('s1');
  server.drop('d2');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu'));
});

test('every recorded line deleted at once: each step dropped, and none written back', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  const from = s.text.indexOf('3. Click Menu');
  const to = endOf(s.text, '4. Click Payments') + 1;
  s.author([change(from, to - from, '')]);
  assert.equal(s.live.uncertain, false);
  assert.deepEqual(s.controls().map((c) => c.id).sort(), ['d1', 'd2']);
  // A lagging draft still holding both writes neither.
  server.record('Tick Cash');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Tick Cash'));
});

// ---------------------------------------------------------------------------
// Lines the author typed, and the server's words for a step
// ---------------------------------------------------------------------------

/** A session with "4. Verify A" typed between the recorded steps and held. */
function heldA() {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  const [add] = s.commit([]).adds;
  const [made] = server.addStep(add);
  s.live = core.assignAuthorStepId(s.live, made.id, made.text, s.book);
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Verify A', '5. Click Payments'));
  return { s, server };
}

test('a typed step edited after it went: an edit-step for its id when the cursor leaves it', () => {
  const { s } = heldA();
  s.type(endOf(s.text, '4. Verify A'), ' twice');
  assert.deepEqual(s.commit([endOf(s.text, 'A twice')]).edits, [], 'not while the cursor is on it');
  const { edits } = s.commit([0]);
  assert.deepEqual(edits.map((e) => [e.action, e.id, e.text]), [['edit-step', 's1', 'Verify A twice']]);
});

test('a typed step whose line is deleted is dropped — and one deleted before its id came is dropped when record:step names it', () => {
  const { s } = heldA();
  s.deleteLine('4. Verify A');
  assert.deepEqual(s.controls(), [{ action: 'drop', id: 's1' }]);

  const server = new EditServer(['Click Menu', 'Click Payments']);
  const t = new Session();
  t.write(server.draft());
  t.type(endOf(t.text, '3. Click Menu'), '\n4. Verify A');
  const [add] = t.commit([]).adds;
  t.deleteLine('4. Verify A');
  assert.deepEqual(t.controls(), [], 'no id to drop yet');
  const [made] = server.addStep(add);
  t.live = core.assignAuthorStepId(t.live, made.id, made.text, t.book);
  assert.deepEqual(t.controls(), [{ action: 'drop', id: 's1' }]);
});

test('a typed step deleted before its id came, and the draft holding it arrives first: left out of the file, not written back as the recording\'s', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '3. Click Menu'), '\n4. Verify A');
  const [add] = s.commit([]).adds;
  s.deleteLine('4. Verify A');
  server.addStep(add);
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments'));
  assert.deepEqual(s.controls(), [{ action: 'drop', id: 's1' }]);
});

test('newer words for a step from the drawer: a line the author is editing keeps theirs (the file wins); one they are not editing takes them at the next write', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  const at = endOf(s.text, '4. Click Payments');
  s.type(at, ' now');
  // The drawer rewords the same step meanwhile.
  server.edit('d2', 'Open Payments');
  s.edited({ id: 'd2', text: 'Open Payments', source: 'toolbar' });
  s.write(server.draft());
  assert.match(s.text, /^4\. Click Payments now$/m, 'the file wins while the author edits it');
  const { edits } = s.commit([]);
  assert.deepEqual(edits.map((e) => [e.id, e.text]), [['d2', 'Click Payments now']], 'and what they commit goes');
  server.edit('d2', 'Click Payments now');
  s.edited({ id: 'd2', text: 'Click Payments now', source: 'editor' });
  s.write(server.draft());
  assert.match(s.text, /^4\. Click Payments now$/m);

  // Later, the drawer again: the line is not being edited — it follows.
  server.edit('d2', 'Open the Payments page');
  s.edited({ id: 'd2', text: 'Open the Payments page', source: 'toolbar' });
  const w = s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Open the Payments page'));
  assert.deepEqual(w.edits.filter((e) => e.kind === 'mine').map((e) => e.why), ['follow']);
  // And Cancel takes it out with the rest.
  s.write(CANCEL);
  assert.equal(s.text, FIXTURE);
});

test('the drawer rewords a step the author typed in the file: the line takes the words at once while it reads as the recording last held it — changed since, the file keeps the author\'s, and the caller is told which line', () => {
  const { s, server } = heldA();
  // The drawer's edit replaces the author step's text on the server.
  const s1 = server.steps.find((x) => x.id === 's1');
  s1.text = 'Verify the menu';
  server.emit();
  const event = { id: 's1', text: 'Verify the menu', source: 'toolbar' };
  assert.equal(core.followDeclined(s.live, event), null);
  s.edited(event);
  const w = s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Verify the menu', '5. Click Payments'));
  assert.deepEqual(w.edits.filter((e) => e.kind === 'mine').map((e) => [e.why, e.text]), [['follow', '4. Verify the menu']]);
  // Changed by the author since (a word added): the next words from the drawer
  // are not put on it — the file wins — and the line is named for the log.
  s.type(endOf(s.text, 'Verify the menu'), ' now');
  s1.text = 'Check the menu';
  server.emit();
  const again = { id: 's1', text: 'Check the menu', source: 'toolbar' };
  assert.equal(core.followDeclined(s.live, again), core.authorLinesOf(s.live)[0].key);
  s.edited(again);
  s.write(server.draft());
  assert.match(s.text, /^4\. Verify the menu now$/m);
  // Left, their words go to the server as the edit.
  assert.deepEqual(s.commit([]).edits.map((e) => [e.id, e.text]), [['s1', 'Verify the menu now']]);
});

test('drawer words that the server took before the author\'s edit still on its way are not put on the line', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  s.commit([]);
  assert.equal(s.lines()[0].unacked, true);
  // The server took the drawer's words first, then ours.
  s.edited({ id: 'd2', text: 'Open Payments', source: 'toolbar' });
  s.write({ ...server.draft(), steps: ['Click Menu', 'Open Payments'], edited: [1] });
  assert.match(s.text, /^4\. Click Payments now$/m, 'never un-done');
  s.edited({ id: 'd2', text: 'Click Payments now', source: 'editor' });
  s.write({ ...server.draft(), steps: ['Click Menu', 'Click Payments now'], edited: [1], revision: 9 });
  assert.match(s.text, /^4\. Click Payments now$/m);
  once(s.text, ['Click Payments now']);
});

test('the model rewrote the step the author was editing: its new step goes beside the line until the edit lands on it; then the line is that step — the author\'s words once, the model\'s gone', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  // The model rewrites d2 (the last open step) into d3.
  server.rewrite(1, 'Click Payments in the menu');
  s.write(server.draft());
  assert.equal(s.text, withLines(['3. Click Menu', '4. Click Payments now', '4. Click Payments in the menu'], 5), 'beside it, where the step was');
  const { edits } = s.commit([]);
  assert.deepEqual(edits.map((e) => [e.id, e.text]), [['d2', 'Click Payments now']]);
  // The server puts the edit on the step that stands for its actions now.
  server.edit('d3', 'Click Payments now');
  s.edited({ id: 'd3', text: 'Click Payments now', source: 'editor' });
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments now'));
  // The same when the draft comes before record:edited.
  const t = new Session();
  const server2 = new EditServer(['Click Menu', 'Click Payments']);
  t.write(server2.draft());
  t.type(endOf(t.text, '4. Click Payments'), ' now');
  server2.rewrite(1, 'Click Payments in the menu');
  t.write(server2.draft());
  t.commit([]);
  server2.edit('d3', 'Click Payments now');
  t.write(server2.draft());
  assert.equal(t.text, recorded('3. Click Menu', '4. Click Payments now'));
  assert.equal(t.lines()[0].stepId, 'd3');
});

test('an edit the server does not take: the line stays as the author wrote it, still standing for its step — never written over, sent again only when changed', () => {
  const server = new EditServer(['Click Menu', 'Type {{password}} into the Password field']);
  const s = new Session();
  s.write(server.draft());
  const from = s.text.indexOf('{{password}}');
  s.author([change(from, '{{password}}'.length, 'hunter2')]);
  const { edits } = s.commit([]);
  assert.equal(edits.length, 1);
  s.live = core.editRefused(s.live, edits[0], s.book);
  assert.deepEqual(s.lines().map((l) => [l.status, l.line]), [['kept', '4. Type hunter2 into the Password field']]);
  server.record('Click Sign in');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Type hunter2 into the Password field', '5. Click Sign in'));
  assert.deepEqual(s.commit([]).edits, [], 'not sent again');
  // Put back as the server has it: nothing to send, the recording's line again.
  const at = s.text.indexOf('hunter2');
  s.author([change(at, 'hunter2'.length, '{{password}}')]);
  assert.deepEqual(s.commit([]).edits, [], 'the words the server has');
  assert.deepEqual(s.lines(), []);
  // Changed again: sent again.
  s.type(endOf(s.text, 'Password field'), ' now');
  assert.deepEqual(s.commit([]).edits.map((e) => [e.id, e.text]), [['d2', 'Type {{password}} into the Password field now']]);
});

// ---------------------------------------------------------------------------
// What the random run found (tests/record-steps-authored.test.js, "random
// edits, deletes and undos"), each pinned on its own
// ---------------------------------------------------------------------------

test('a reworded line whose step is deleted in the drawer or the panel comes out of the file at once — it reads as the recording last left it — and Restore puts it back', () => {
  const server = new EditServer(['Click Menu', 'Click Payments', 'Tick Cash']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  s.commit([]);
  server.edit('d2', 'Click Payments now');
  s.edited({ id: 'd2', text: 'Click Payments now', source: 'editor' });
  s.write(server.draft());
  const held = s.text;
  const w = s.write({ ...server.draft(), droppedIds: ['d2'] });
  assert.equal(s.text, recorded('3. Click Menu', '4. Tick Cash'));
  assert.deepEqual(w.edits.filter((e) => e.kind === 'mine').map((e) => e.why), ['hide']);
  s.write(server.draft());
  assert.equal(s.text, held, 'back where it was');
});

test('a draft of the server\'s with no steps (every one deleted) keeps the author\'s lines; only the recording\'s clear-out takes the reworded and emptied ones', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  // Line 3 emptied (a delete), line 4 reworded and then its step deleted in
  // the drawer while the author was editing it (so it stays, left).
  s.author([change(s.text.indexOf('3. Click Menu'), '3. Click Menu'.length, '')]);
  s.commit([]);
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  server.drop('d1');
  server.drop('d2');
  const w = s.write({ ...server.draft(), droppedIds: ['d2'] });
  assert.deepEqual(w.left.length, 1, 'the reworded line stays — the author was editing it');
  assert.equal(s.text, withLines(['', '4. Click Payments now'], 3), 'nothing of the author\'s taken by a draft with no steps');
  s.write(CANCEL);
  assert.equal(s.text, FIXTURE, 'Cancel takes the emptied and the reworded lines out');
});

test('Ctrl+Z of emptying a recorded line is its step restored — not a new line of the author\'s with the recording\'s words', () => {
  const server = new EditServer(['Click Menu', 'Click Help', 'Click Pay']);
  const s = new Session();
  s.write(server.draft());
  const before = s.text;
  const at = s.text.indexOf('Click Help');
  s.author([change(at, 'Click Help'.length, '')]);
  assert.deepEqual(s.commit([]).edits.map((e) => [e.action, e.id]), [['drop', 'd2']]);
  // Ctrl+Z: the words back, as an undo.
  s.author([change(at, 0, 'Click Help')], { uncertain: true, undo: true });
  assert.equal(s.text, before);
  assert.deepEqual(s.controls(), [{ action: 'restore', id: 'd2' }]);
  assert.deepEqual(s.commit([]), { adds: [], edits: [] }, 'no add-step, no edit: the recording\'s line again');
  assert.deepEqual(s.lines(), []);
  // Words typed on an emptied line by hand make a new line instead.
  s.author([change(at, 'Click Help'.length, '')]);
  s.commit([]);
  s.type(at, 'Verify help');
  assert.deepEqual(s.commit([]).adds.map((c) => c.lines), [['Verify help']]);
  assert.deepEqual(s.controls(), []);
});

test('a step whose line the author deleted in the file never takes another line of theirs with it — the model had rewritten the step they were editing, and their edit landed on the line they deleted', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  server.rewrite(1, 'Open Payments');
  s.write(server.draft());
  assert.equal(s.text, withLines(['3. Click Menu', '4. Click Payments now', '4. Open Payments'], 5));
  s.commit([]);
  // The server puts the edit on d3; the author deletes d3's line meanwhile.
  server.edit('d3', 'Click Payments now');
  s.deleteLine('4. Open Payments');
  assert.deepEqual(s.controls(), [{ action: 'drop', id: 'd3' }]);
  s.edited({ id: 'd3', text: 'Click Payments now', source: 'editor' });
  server.drop('d3');
  const w = s.write(server.draft());
  assert.ok(!w.edits.some((e) => e.why === 'hide'), 'the author\'s line is not taken out');
  assert.match(s.text, /^\d+\. Click Payments now$/m, 'their words stay');
});

test('a line emptied while a draft write is on its way stays emptied when the write lands — its delete goes once', () => {
  const server = new EditServer(['Click Menu', 'Click Help', 'Click Pay']);
  const s = new Session();
  s.write(server.draft());
  const at = s.text.indexOf('Click Help');
  s.author([change(at, 'Click Help'.length, '')]);
  // A write planned now — the recorder's, in flight…
  server.record('Sign out');
  const pending = core.liveRecordWrite(s.live, s.text, server.draft(), { anchor: s.anchor, book: s.book });
  assert.ok(!('error' in pending));
  // …while the author leaves the line: its delete goes.
  assert.deepEqual(s.commit([]).edits.map((e) => [e.action, e.id]), [['drop', 'd2']]);
  // The write lands: the recorder takes its record, carrying in what it knows.
  s.move(pending.edits.map((e) => change(e.start, e.end - e.start, e.text)));
  s.live = core.carryAuthorState(s.live, pending.record);
  assert.deepEqual(s.commit([]).edits, [], 'no second drop');
  assert.deepEqual(s.lines().map((l) => [l.line, l.stepId, l.origin]), [['4. ', undefined, undefined]], 'a line of the author\'s, standing for nothing');
});

// ---------------------------------------------------------------------------
// Stop, Cancel, the one Ctrl+Z after Stop, a reload
// ---------------------------------------------------------------------------

test('Stop: the result (no ids) is held by the last draft\'s ids — the reworded line is its step, written once; after the drafts are taken out first (the split), it comes back', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  s.commit([]);
  server.edit('d2', 'Click Payments now');
  s.edited({ id: 'd2', text: 'Click Payments now', source: 'editor' });
  s.write(server.draft());
  const last = server.draft();
  const result = [...last.steps, 'Sign out'];
  const mapped = core.idsForResult(last, result);
  assert.deepEqual(mapped, { ids: ['d1', 'd2', ''], edited: [1] });
  // The split: the drafts taken out (the reworded line with them)…
  s.write(CANCEL);
  assert.equal(s.text, FIXTURE);
  // …then the result, which puts the line back where it was.
  s.write({ steps: result, parameters: [], ...mapped });
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments now', '5. Sign out'));
  once(s.text, ['Click Payments now']);
});

test('Cancel takes out every step the recording wrote, reworded ones too, and keeps the lines typed as new steps', () => {
  const { s, server } = heldA();
  s.type(endOf(s.text, '5. Click Payments'), ' now');
  s.commit([]);
  server.edit('d2', 'Click Payments now');
  s.write(server.draft());
  assert.equal(s.text, recorded('3. Click Menu', '4. Verify A', '5. Click Payments now'));
  s.write(CANCEL);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. Verify A\n3. Open the dashboard'));
});

test('a reload\'s leftovers: removing the unfinished recording takes the reworded line out and keeps the typed one', () => {
  const { s, server } = heldA();
  s.type(endOf(s.text, '5. Click Payments'), ' now');
  s.commit([]);
  server.edit('d2', 'Click Payments now');
  s.write(server.draft());
  const kept = JSON.parse(JSON.stringify(core.unfinishedRecordingOf(s.live)));
  assert.deepEqual(kept.parts.map((p) => [p.mine, p.edit === true]), [[false, false], [true, false], [true, true]]);
  const removal = core.removeUnfinishedRecording(s.text, kept);
  assert.equal(removal.text, FIXTURE.replace('3. Open the dashboard', '4. Verify A\n3. Open the dashboard'));
});

test('the one-shot insertion after the file was given up on leaves out the reworded step whose line is still there', () => {
  const server = new EditServer(['Click Menu', 'Click Payments']);
  const s = new Session();
  s.write(server.draft());
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  s.commit([]);
  const result = ['Click Menu', 'Click Payments now', 'Sign out'];
  const once1 = core.oneShotSteps(s.live, s.text, { steps: result, ids: ['d1', 'd2', ''] });
  assert.deepEqual(once1, { steps: ['Click Menu', 'Sign out'], kept: ['Click Payments now'] });
});

// ---------------------------------------------------------------------------
// A server that sends no ids
// ---------------------------------------------------------------------------

test('a draft without ids: nothing changes — an edit inside the recorded lines is written over (warned), a typed line edited after it went is not sent', () => {
  const s = new Session();
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  s.type(endOf(s.text, '4. Click Payments'), ' now');
  assert.equal(s.touched, true, 'warned, as before');
  assert.deepEqual(s.lines(), []);
  assert.deepEqual(s.commit([]), { adds: [], edits: [] });
  s.write({ steps: ['Click Menu', 'Click Payments'], parameters: [] });
  assert.equal(s.text, recorded('3. Click Menu', '4. Click Payments'));
  // A line deleted is not a drop either.
  s.deleteLine('4. Click Payments');
  assert.deepEqual(s.controls(), []);
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const fresh = () => core.newRecordingState({ uri: 'file:///t.md', file: 't.md', mode: 'cursor' });

test('record:draft: each step\'s id and the author\'s rewordings, mapped onto the steps as kept; "yours" on both, no lock anywhere', () => {
  const state = fresh();
  core.applyRecordFrame(state, {
    type: 'record:draft',
    revision: 1,
    steps: ['Click Menu', '  ', 'Open Payments', 'Verify A'],
    parameters: [],
    locked: 4,
    authored: [3],
    authoredIds: ['s1'],
    ids: ['d1', 'dx', 'd2', 's1'],
    edited: [2],
  });
  assert.deepEqual(state.draft.ids, ['d1', 'd2', 's1']);
  assert.deepEqual(state.draft.edited, [1]);
  assert.deepEqual(core.draftStepMarks(state.draft), [{ yours: false }, { yours: true }, { yours: true }]);
});

test('record:edited: a "✎ Edited step N" row, with where it was edited; not an action, never dropped', () => {
  const state = fresh();
  core.applyRecordFrame(state, { type: 'record:action', id: 'a1', kind: 'click', action: true, summary: 'Clicked', atMs: 4000 });
  core.applyRecordFrame(state, { type: 'record:draft', revision: 1, steps: ['Click Menu', 'Open Payments'], parameters: [], ids: ['d1', 'd2'] });
  assert.equal(core.applyRecordFrame(state, { type: 'record:edited', id: 'd2', text: 'Open Payments from the side menu', source: 'toolbar' }), true);
  const row = state.actions.at(-1);
  assert.deepEqual([row.kind, row.summary, row.source, row.action, row.atMs], ['edit', 'Edited step 2: Open Payments from the side menu', 'toolbar', false, 4000]);
  assert.equal(core.recordingStatusText(state), 'Recording — 1 action', 'not counted');
  assert.equal(core.applyRecordFrame(state, { type: 'record:dropped', id: row.id, dropped: true, source: 'toolbar' }), false);
});

test('record:dropped for a step: struck in Steps so far where it was, its actions struck with it (each restorable alone); restored, all back', () => {
  const state = fresh();
  for (const id of ['a1', 'a2', 'a3']) core.applyRecordFrame(state, { type: 'record:action', id, kind: 'click', action: true, summary: id, atMs: 0 });
  core.applyRecordFrame(state, { type: 'record:draft', revision: 1, steps: ['Click Menu', 'Click Help', 'Click Pay'], parameters: [], ids: ['d1', 'd2', 'd3'] });
  assert.equal(core.applyRecordFrame(state, { type: 'record:dropped', id: 'd2', dropped: true, source: 'editor', actions: ['a2'] }), true);
  assert.deepEqual(state.deletedSteps, [{ id: 'd2', text: 'Click Help', after: 'd1' }]);
  assert.deepEqual(state.actions.map((a) => [a.id, a.dropped, a.droppedWith]), [['a1', false, undefined], ['a2', true, 'd2'], ['a3', false, undefined]]);
  assert.equal(core.recordingStatusText(state), 'Recording — 2 actions');
  // The server's next draft without it: still struck, where it was.
  core.applyRecordFrame(state, { type: 'record:draft', revision: 2, steps: ['Click Menu', 'Click Pay'], parameters: [], ids: ['d1', 'd3'] });
  assert.deepEqual(state.deletedSteps.map((d) => d.id), ['d2']);
  // Restored: the step and its actions.
  assert.equal(core.applyRecordFrame(state, { type: 'record:dropped', id: 'd2', dropped: false, source: 'panel', actions: ['a2'] }), true);
  assert.deepEqual(state.deletedSteps, []);
  assert.equal(state.actions[1].dropped, false);
  assert.equal(state.actions[1].droppedWith, undefined);
  // A repeat changes nothing.
  assert.equal(core.applyRecordFrame(state, { type: 'record:dropped', id: 'd2', dropped: false, source: 'panel', actions: ['a2'] }), false);
});

test('a deleted step the draft holds again is off the struck list', () => {
  const state = fresh();
  core.applyRecordFrame(state, { type: 'record:draft', revision: 1, steps: ['A', 'B'], parameters: [], ids: ['d1', 'd2'] });
  core.markStepDeleted(state, 'd2', true);
  assert.equal(state.deletedSteps.length, 1);
  core.applyRecordFrame(state, { type: 'record:draft', revision: 2, steps: ['A', 'B'], parameters: [], ids: ['d1', 'd2'] });
  assert.deepEqual(state.deletedSteps, []);
});

test('the panel\'s Steps so far rows: numbered steps with an id to delete by, the deleted ones struck where they were (recording-panel.js)', async () => {
  const panel = await import('../src/webview/lib/recording-panel.js');
  const draft = { steps: ['Click Menu', 'Open Payments', 'Click Pay'], ids: ['d1', 'd2', 'd4'], authored: [2], edited: [1] };
  const rows = panel.stepsSoFarRowsInline(draft, [
    { id: 'd3', text: 'Click Help', after: 'd2' },
    { id: 'd0', text: 'Close banner', after: null },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.number ?? null, r.text, r.id, r.yours === true]),
    [
      ['deleted', null, 'Close banner', 'd0', false],
      ['step', 1, 'Click Menu', 'd1', false],
      ['step', 2, 'Open Payments', 'd2', true],
      ['deleted', null, 'Click Help', 'd3', false],
      ['step', 3, 'Click Pay', 'd4', true],
    ],
  );
  // No ids (a server that predates editing): nothing to delete by.
  assert.deepEqual(panel.stepsSoFarRowsInline({ steps: ['A'] }, []).map((r) => r.id), [null]);
  // The marks copy matches the core.
  assert.deepEqual(panel.draftStepMarksInline(draft), core.draftStepMarks(draft));
});
