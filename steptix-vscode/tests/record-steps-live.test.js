/**
 * Record Steps, the file while recording — the fail-safe rule
 * (docs/specs/SPEC-record-steps.md §7): the recording never overwrites text
 * it cannot prove it wrote.
 *
 * Every case here is a sequence an adversarial review reproduced in a real
 * VS Code 1.95 host (tb 0.5.153), replayed against the pure core with the
 * change events VS Code reported for it — the offsets and texts are the ones
 * the host logged (`rangeOffset`, `rangeLength`, `text`), on the same fixture.
 * A `Session` drives the core the way the extension's change listener and
 * draft writer do. The host-level halves (rename, reload, the real events)
 * are in tests/integration/suite/record-steps.test.cjs.
 *
 * The core is imported as a namespace so that each case can be run against
 * an older core too: a missing export fails that case, not the file.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as core from '../src/extension/record-steps-core.ts';

const doc = (...lines) => lines.join('\n');

/** The integration suite's fixture, which the review's probes used. */
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
const D1 = { steps: ['Click Menu'], parameters: [] };
const D2 = { steps: ['Click Menu', 'Click Payments'], parameters: [] };
const D3 = { steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [] };
const PW = [{ name: 'password', value: '$PASSWORD' }];

const anchorAt = (text, needle) => {
  const idx = text.split(/\r?\n/).indexOf(needle);
  assert.ok(idx >= 0, `no line ${JSON.stringify(needle)}`);
  const cursor = core.resolveRecordCursor(text, idx + 1);
  assert.equal(cursor.ok, true, cursor.reason);
  return { ...cursor.anchor, tracked: true };
};

/** What a one-shot insertion of `draft` into `text` at `needle` reads as. */
const oneShot = (text, needle, draft) => {
  const plan = core.planRecordInsertion(text, { anchor: anchorAt(text, needle), ...draft });
  assert.ok(!('error' in plan), plan.error);
  return core.applyRecordEdits(text, plan.edits);
};

/** A change, 0-based offsets in the text before it (VS Code's shape). */
const change = (offset, length, text) => ({ offset, length, text });

/** The same change in lines, for the anchor tracker. */
function lineChange(text, c) {
  const pos = (off) => {
    const before = text.slice(0, off);
    return { line: (before.match(/\n/g) ?? []).length, char: off - (before.lastIndexOf('\n') + 1) };
  };
  const s = pos(c.offset);
  const e = pos(c.offset + c.length);
  return { startLine: s.line, startChar: s.char, endLine: e.line, endChar: e.char, text: c.text };
}

/** `from` → `to` as one change over whole lines — the shape VS Code's revert
 *  and reload diffs take. */
function lineDiff(from, to) {
  const a = from.split('\n');
  const b = to.split('\n');
  let p = 0;
  while (p < a.length - 1 && p < b.length - 1 && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - 1 - p && s < b.length - 1 - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const start = a.slice(0, p).join('\n').length + (p > 0 ? 1 : 0);
  const endFrom = from.length - (s > 0 ? a.slice(a.length - s).join('\n').length + 1 : 0);
  const endTo = to.length - (s > 0 ? b.slice(b.length - s).join('\n').length + 1 : 0);
  return change(start, Math.max(0, endFrom - start), to.slice(start, Math.max(start, endTo)));
}

/** The extension's change listener, before this fix had a `followLiveRecord`. */
const follow =
  core.followLiveRecord ??
  ((live, changes) => {
    const t = core.trackRecordSlots(live.slots, changes);
    return { record: { ...live, slots: t.slots }, touched: t.touched };
  });

/**
 * One recording into one document, driven as step-recorder.ts drives the
 * core: the anchor followed through every change, the recording's own writes
 * applied as edits, everyone else's through `followLiveRecord`, and a write
 * that comes back `lost` ending the live writing.
 */
class Session {
  constructor(text, needle) {
    this.text = text;
    this.anchor = anchorAt(text, needle);
    this.live = null;
    this.lost = false;
    this.touched = false;
    this.relocations = 0;
  }

  write(draft) {
    if (!this.live) {
      // Nothing written yet and nowhere to write (## Steps deleted): the
      // extension says so once and tries again with the next draft.
      const begun = core.beginLiveRecord(this.text, this.anchor);
      if ('error' in begun) return { edits: [], unwritable: begun.error };
      this.live = begun;
    }
    const record = this.lost ? { ...this.live, uncertain: true } : this.live;
    const w = core.liveRecordWrite(record, this.text, draft, { anchor: this.anchor });
    if ('error' in w) {
      assert.ok(w.lost, `a write failed for another reason: ${w.error}`);
      this.lost = true;
      return w;
    }
    this.move(w.edits.map((e) => change(e.start, e.end - e.start, e.text)));
    this.live = w.record ?? { ...this.live, slots: w.slots };
    return w;
  }

  /** The text and the anchor through `changes`. */
  move(changes) {
    const before = this.text;
    if (this.anchor) this.anchor = core.trackAnchorThroughChanges(this.anchor, changes.map((c) => lineChange(before, c)));
    this.text = core.applyOffsetEdits(
      before,
      changes.map((c) => ({ start: c.offset, end: c.offset + c.length, text: c.text })),
    );
  }

  /** Someone else's change event. `uncertain`: an undo, redo, revert or reload. */
  author(changes, opts = {}) {
    this.move(changes);
    if (!this.live) return;
    const followed = follow(this.live, changes, { text: () => this.text, uncertain: opts.uncertain === true, anchor: this.anchor });
    // Found again by its text at the event itself (the highlight stays right).
    const unfollowable = opts.uncertain === true || core.trackRecordSlots(this.live.slots, changes).uncertain === true;
    if (unfollowable && followed.record.uncertain === false) this.relocations++;
    this.live = followed.record;
    if (followed.touched) this.touched = true;
  }

  /** Typed, one keystroke per change event, from `offset`. */
  type(offset, text) {
    for (let i = 0; i < text.length; i++) this.author([change(offset + i, 0, text[i])]);
  }
}

// ---------------------------------------------------------------------------
// The review's sequences
// ---------------------------------------------------------------------------

test('File: Revert while recording (one line diff across the recorded lines): the next draft goes in afresh, Cancel restores the file', () => {
  // D2 of the review: the event VS Code sent for the revert, verbatim.
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D1));
  s.author([change(156, 36, '3. Open the dashboard\n')], { uncertain: true });
  assert.equal(s.text, FIXTURE, 'the revert');
  s.write(D2);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D2), 'nothing of the author\'s is overwritten');
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE, 'Cancel restores the file');
  assert.equal(s.touched, false, 'a revert is not an edit inside the recorded lines');
});

test('a revert that reaches from the parameters through the steps (the review\'s D) leaves ## Steps and the flow alone', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ ...D2, parameters: PW });
  s.author([lineDiff(s.text, FIXTURE)], { uncertain: true });
  assert.equal(s.text, FIXTURE);
  s.write({ ...D3, parameters: PW });
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', { ...D3, parameters: PW }));
  assert.match(s.text, /## Steps\n1\. Navigate to login\.html\n2\. Click Sign in\n3\. Click Menu/);
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE);
});

test('a revert WITHOUT the uncertain flag (a reload that reports nothing) is still not written over: the diff reaches across the block', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  s.author([change(156, 36, '3. Open the dashboard\n')]);
  s.write(D2);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D2));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE);
});

test('LF to CRLF (one change over the whole document) keeps the file: the next draft is written, in CRLF, over the last; Cancel restores it', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  const crlf = s.text.replace(/\n/g, '\r\n');
  s.author([change(0, s.text.length, crlf)]);
  s.write(D2);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D2).replace(/\n/g, '\r\n'));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace(/\n/g, '\r\n'), 'the author\'s line endings kept, the recording gone');
});

test('Ctrl+Z then Ctrl+Y while recording does not duplicate the steps; Cancel leaves no stray copy', () => {
  // The review's B: the events VS Code sent, verbatim.
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  const d1 = s.text;
  s.author([change(170, 1, '3'), change(156, 14, '')], { uncertain: true });
  assert.equal(s.text, FIXTURE, 'undo');
  s.author([change(156, 1, '4'), change(156, 0, '3. Click Menu\n')], { uncertain: true });
  assert.equal(s.text, d1, 'redo');
  s.write(D2);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D2), 'written over the redone draft, once');
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE);
  assert.equal(s.touched, false, 'undo and redo are not edits inside the recorded lines');
});

test('Ctrl+Z alone: the next draft goes back in at the anchor, and nothing is warned about', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  s.author([change(170, 1, '3'), change(156, 14, '')], { uncertain: true });
  assert.equal(s.touched, false);
  s.write(D2);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D2));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE);
});

test('typing at column 0 of a later step is the author\'s line: never overwritten, and its number is given back only when its line is exact', () => {
  // The review's E: "Check the banner" and Enter at the start of "4. Open the dashboard".
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  s.type(170, 'Check the banner\n');
  s.write(D2);
  assert.equal(
    s.text,
    FIXTURE.replace('3. Open the dashboard', '3. Click Menu\n4. Click Payments\nCheck the banner\n5. Open the dashboard'),
    'the typed line kept; the step below it, exact again, renumbered',
  );
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', 'Check the banner\n3. Open the dashboard'));
});

test('typing in front of a later step\'s number, with no Enter, leaves that line alone for good', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  s.type(170, 'Check ');
  s.write(D2);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '3. Click Menu\n4. Click Payments\nCheck 4. Open the dashboard'));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', 'Check 4. Open the dashboard'), 'not renumbered back: the line is not exact');
});

test('indenting a later step (Tab, or several lines at once) is the author\'s: the indentation is never stripped', () => {
  const text = doc('## Steps', '1. A', '2. B', '3. C', '4. D', '');
  const s = new Session(text, '1. A');
  s.write({ steps: ['New'], parameters: [] });
  assert.equal(s.text, doc('## Steps', '1. A', '2. New', '3. B', '4. C', '5. D', ''));
  // Multi-cursor Tab: one event, an insertion at the start of each line.
  const c = s.text.indexOf('4. C');
  const d = s.text.indexOf('5. D');
  s.author([change(d, 0, '\t'), change(c, 0, '\t')]);
  s.write({ steps: ['New', 'Newer'], parameters: [] });
  assert.equal(s.text, doc('## Steps', '1. A', '2. New', '3. Newer', '4. B', '\t4. C', '\t5. D', ''));
  s.write(EMPTY);
  assert.equal(s.text, doc('## Steps', '1. A', '2. B', '\t4. C', '\t5. D', ''));
});

test('End, Enter on the last recorded line starts the author\'s line BELOW the block: a step typed there is kept', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  const eol = s.text.indexOf('3. Click Menu') + '3. Click Menu'.length;
  s.type(eol, '\n4. Check the banner');
  s.write(D2);
  assert.equal(
    s.text,
    FIXTURE.replace('3. Open the dashboard', '3. Click Menu\n4. Click Payments\n4. Check the banner\n5. Open the dashboard'),
  );
  assert.equal(s.touched, false, 'not an edit inside the recorded lines');
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE.replace('3. Open the dashboard', '4. Check the banner\n3. Open the dashboard'));
});

test('End, Enter on the last recorded line when the block ends the file', () => {
  const text = doc('## Steps', '1. A');
  const s = new Session(text, '1. A');
  s.write({ steps: ['New'], parameters: [] });
  assert.equal(s.text, doc('## Steps', '1. A', '2. New'));
  s.type(s.text.length, '\n3. Mine');
  s.write({ steps: ['New', 'Newer'], parameters: [] });
  assert.equal(s.text, doc('## Steps', '1. A', '2. New', '3. Newer', '3. Mine'));
  s.write(EMPTY);
  assert.equal(s.text, doc('## Steps', '1. A', '3. Mine'));
});

test('an edit wholly inside the recorded lines is still taken in and written over (warned); one reaching across its edge is not', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D2);
  const at = s.text.indexOf('Click Payments');
  s.author([change(at, 5, 'Tap')]);
  assert.equal(s.touched, true);
  s.write(D3);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D3));
  // Selecting exactly the recorded lines and typing over them: the text is
  // the author's, not an edit inside the recording's.
  const t = new Session(FIXTURE, '2. Click Sign in');
  t.write(D1);
  t.author([change(156, '3. Click Menu\n'.length, 'Mine\n')]);
  t.write(D2);
  assert.ok(t.text.includes('Mine\n'), 'what the author typed over the recorded lines stays');
  t.write(EMPTY);
  assert.ok(t.text.includes('Mine\n'));
});

test('the recorded lines found twice, or in part, stop the writing: nothing is written, and the empty draft takes nothing out', () => {
  // Twice: the author pasted a copy of the block above, then an undo came.
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D2);
  s.author([change(s.text.indexOf('## Steps'), 0, '3. Click Menu\n4. Click Payments\n')]);
  s.author([change(0, 0, '')], { uncertain: true });
  const before = s.text;
  const w = s.write(D3);
  assert.equal(w.lost, true);
  assert.equal(s.text, before, 'nothing written');
  const cleared = s.write(EMPTY);
  assert.equal(cleared.lost, true);
  assert.equal(s.text, before, 'nothing taken out');

  // In part: a change across the block's edge left one recorded line.
  const p = new Session(FIXTURE, '2. Click Sign in');
  p.write(D2);
  const from = p.text.indexOf('Sign in\n3.') + 4;
  p.author([change(from, p.text.indexOf('4. Click Payments') - from, '')]);
  const partial = p.text;
  assert.equal(p.write(D3).lost, true);
  assert.equal(p.text, partial);
});

test('undo back to an earlier draft (the author\'s edits split the undo history) is recognised and written over', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  const d1 = s.text;
  s.author([change(0, 0, 'X')]); // the author types: a new undo step
  s.write(D2);
  s.write(D3);
  // Ctrl+Z takes out drafts 2 and 3 (one step) — draft 1 is back.
  s.author([lineDiff(s.text, 'X' + d1)], { uncertain: true });
  assert.equal(s.text, 'X' + d1);
  s.write({ ...D3, steps: [...D3.steps, 'Click Pay'] });
  assert.equal(s.text, 'X' + oneShot(FIXTURE, '2. Click Sign in', { ...D3, steps: [...D3.steps, 'Click Pay'] }));
  s.write(EMPTY);
  assert.equal(s.text, 'X' + FIXTURE);
});

test('Ctrl+Z after a revert brings back a draft from before the recording started again: found, not duplicated', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write(D1);
  const d1 = s.text;
  s.author([lineDiff(s.text, FIXTURE)], { uncertain: true }); // revert
  s.write(D2); // afresh at the anchor
  s.author([lineDiff(s.text, FIXTURE)], { uncertain: true }); // undo the fresh draft
  s.author([lineDiff(s.text, d1)], { uncertain: true }); // undo the revert
  assert.equal(s.text, d1);
  s.write(D3);
  assert.equal(s.text, oneShot(FIXTURE, '2. Click Sign in', D3));
  s.write(EMPTY);
  assert.equal(s.text, FIXTURE);
});

// ---------------------------------------------------------------------------
// After a window reload
// ---------------------------------------------------------------------------

test('an unfinished recording is taken back out exactly — and not at all once its lines were edited', () => {
  const s = new Session(FIXTURE, '2. Click Sign in');
  s.write({ ...D2, parameters: PW });
  const kept = JSON.parse(JSON.stringify(core.unfinishedRecordingOf(s.live)));
  assert.deepEqual(kept.tails, [{ wrote: '5', original: '3', rest: '. Open the dashboard' }]);
  // Hot exit restores the buffer as it was; the author typed above it since.
  const restored = 'Mine\n' + s.text;
  const removal = core.removeUnfinishedRecording(restored, kept);
  assert.equal(removal.text, 'Mine\n' + FIXTURE);
  // The same buffer with CRLF line endings.
  assert.equal(core.removeUnfinishedRecording(restored.replace(/\n/g, '\r\n'), kept).text, ('Mine\n' + FIXTURE).replace(/\n/g, '\r\n'));
  // Edited inside the recorded lines: nothing can be proved, nothing offered.
  assert.equal(core.removeUnfinishedRecording(restored.replace('Click Payments', 'Tap Payments'), kept), null);
  // There twice: the same.
  assert.equal(core.removeUnfinishedRecording(restored + '3. Click Menu\n4. Click Payments\n', kept), null);
  // Gone (the author saved without it, or reverted): nothing offered.
  assert.equal(core.removeUnfinishedRecording(FIXTURE, kept), null);
  // Nothing written, nothing kept.
  assert.equal(core.unfinishedRecordingOf(core.beginLiveRecord(FIXTURE, anchorAt(FIXTURE, '2. Click Sign in'))), null);
});

// ---------------------------------------------------------------------------
// Random edits: the recorder never destroys text it did not write
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
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

const PROPERTY_FIXTURES = [
  [FIXTURE, '2. Click Sign in'],
  [FIXTURE, '1. Type {{email}} into the Email field'],
  [doc('# T', '', '## Steps', '1. A', '2. B', '3. C', ''), '1. A'],
  [doc('## Steps', '1. A', '2. B'), '2. B'],
  [doc('# T', '', '## Parameters', '- q: 1', '', '## Steps', '1. Open', '2. Pay', '', '### S', '1. X', ''), '1. Open'],
];
const STEP_TEXTS = ['Click Menu', 'Click Payments', 'Tick Cash', 'Type {{amount}} into Amount', 'Click Pay', 'Sign out'];
const AUTHOR_TEXTS = ['x', 'foo', '\n', 'bar\n', '7. mine\n', '\t', ' ', '9', 'Z\nY'];

/**
 * Every character of the document with who put it there: `base` (the file
 * before), `author` (typed while recording), `rec` (the recording's block and
 * parameter lines), `num` (a number the recording renumbered a step to), and
 * `loose` — typed by the author INSIDE or right against the recording's lines,
 * which §7 lets the next draft write over (warned).
 */
function charsOf(text, own) {
  return [...text].map((c) => ({ c, own }));
}
const textOf = (chars) => chars.map((x) => x.c).join('');
const inRecording = (x) => x !== undefined && (x.own === 'rec' || x.own === 'loose');

function authorChars(chars, c) {
  const out = chars.slice();
  out.splice(c.offset, c.length);
  const own = inRecording(out[c.offset - 1]) || inRecording(out[c.offset]) ? 'loose' : 'author';
  out.splice(c.offset, 0, ...charsOf(c.text, own));
  return out;
}

/** A write may replace the recording's own characters, the author's loose
 *  ones, and a step's leading number (a renumber) — nothing else. */
function checkWrite(chars, edits, label) {
  for (const e of edits) {
    const replaced = chars.slice(e.start, e.end);
    const ownOnly = replaced.every((x) => x.own === 'rec' || x.own === 'loose');
    const renumber =
      /^\d+$/.test(e.text) &&
      replaced.length > 0 &&
      replaced.every((x) => /\d/.test(x.c)) &&
      (e.start === 0 || chars[e.start - 1]?.c === '\n') &&
      chars[e.end]?.c === '.';
    assert.ok(
      ownOnly || renumber,
      `${label}: a write replaced ${JSON.stringify(textOf(replaced))} (${[...new Set(replaced.map((x) => x.own))].join(', ')}) with ${JSON.stringify(e.text)}`,
    );
  }
}

function writeChars(chars, edits) {
  let out = chars.slice();
  const ordered = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.i - a.i);
  for (const { e } of ordered) {
    const own = e.kind === 'tail' || (e.kind === undefined && /^\d+$/.test(e.text)) ? 'num' : 'rec';
    out.splice(e.start, e.end - e.start, ...charsOf(e.text, own));
  }
  return out;
}

function eolToggled(chars) {
  const crlf = textOf(chars).includes('\r\n');
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const x = chars[i];
    if (crlf && x.c === '\r' && chars[i + 1]?.c === '\n') continue;
    if (!crlf && x.c === '\n') out.push({ c: '\r', own: x.own });
    out.push(x);
  }
  return out;
}

test('random author edits between drafts: a write never replaces a character the recording did not write, and Cancel leaves none of its lines behind', () => {
  const outcomes = { found: 0, fresh: 0, lost: 0, writes: 0 };
  // RECORD_STEPS_SEED=<n> replays one seed and prints every step of it.
  const only = Number(process.env.RECORD_STEPS_SEED) || 0;
  const trace = only ? (...args) => console.log(...args) : () => {};
  for (let seed = only || 1; seed <= (only || 400); seed++) {
    const rnd = prng(seed);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const [base, needle] = pick(PROPERTY_FIXTURES);
    const s = new Session(base, needle);
    let chars = charsOf(base, 'base');
    const past = [chars];
    const label = (op) => `seed ${seed}, ${op}`;
    for (let op = 0; op < 40; op++) {
      const r = rnd();
      const len = s.text.length;
      if (r < 0.3) {
        const n = 1 + Math.floor(rnd() * STEP_TEXTS.length);
        const steps = STEP_TEXTS.slice(0, n);
        const parameters = rnd() < 0.3 ? [{ name: 'amount', value: '10' }] : [];
        if (s.lost) continue;
        const draft = rnd() < 0.1 ? EMPTY : { steps, parameters };
        const w = s.write(draft);
        trace(op, 'write', draft.steps.length, w.lost ? 'LOST' : w.relocated, JSON.stringify(w.edits));
        if (w.lost) {
          outcomes.lost++;
          continue;
        }
        outcomes.writes++;
        if (w.relocated === 'found') outcomes.found++;
        if (w.unwritable) continue;
        if (w.relocated === 'fresh') outcomes.fresh++;
        checkWrite(chars, w.edits, label(`write ${op}`));
        chars = writeChars(chars, w.edits);
        past.push(chars);
      } else if (r < 0.55) {
        const at = Math.floor(rnd() * (len + 1));
        const c = change(at, 0, pick(AUTHOR_TEXTS));
        s.author([c]);
        chars = authorChars(chars, c);
      } else if (r < 0.72) {
        const at = Math.floor(rnd() * len);
        const n = Math.min(len - at, 1 + Math.floor(rnd() * 12));
        const c = change(at, n, rnd() < 0.5 ? '' : pick(AUTHOR_TEXTS));
        s.author([c]);
        chars = authorChars(chars, c);
      } else if (r < 0.86) {
        // An undo or redo: an earlier state of the file back, as one line diff.
        const back = pick(past.slice(-4));
        const c = lineDiff(s.text, textOf(back));
        s.author([c], { uncertain: true });
        chars = back.slice();
      } else if (r < 0.93) {
        // A revert: the file as it was on disk.
        const c = lineDiff(s.text, base);
        s.author([c], { uncertain: true });
        chars = charsOf(base, 'base');
      } else {
        // Another extension converting the line endings: one change over it all.
        const toggled = eolToggled(chars);
        s.author([change(0, len, textOf(toggled))]);
        chars = toggled;
      }
      if (r >= 0.3) trace(op, r < 0.72 ? 'author' : r < 0.86 ? 'undo' : r < 0.93 ? 'revert' : 'eol', s.live?.uncertain ? '(uncertain)' : '');
      trace(JSON.stringify(s.text));
      assert.equal(s.text, textOf(chars), label(`op ${op}: the model and the session agree`));
      past.push(chars);
    }
    outcomes.found += s.relocations;
    // Cancel.
    const w = s.live ? s.write(EMPTY) : { edits: [] };
    if (!w.lost) {
      checkWrite(chars, w.edits, label('Cancel'));
      chars = writeChars(chars, w.edits);
      // No whole line of the recording's is left behind.
      let lineChars = [];
      for (const x of [...chars, { c: '\n', own: 'end' }]) {
        if (x.c !== '\n') {
          if (x.c !== '\r') lineChars.push(x);
          continue;
        }
        if (lineChars.length > 0 && lineChars.every((y) => y.own === 'rec')) {
          assert.fail(label(`Cancel left a recorded line behind: ${JSON.stringify(textOf(lineChars))}`));
        }
        lineChars = [];
      }
    }
  }
  // The runs went down every path.
  assert.ok(outcomes.writes > 1000, JSON.stringify(outcomes));
  assert.ok(outcomes.found > 20, `found by text: ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.fresh > 20, `written afresh: ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.lost > 20, `stopped: ${JSON.stringify(outcomes)}`);
});
