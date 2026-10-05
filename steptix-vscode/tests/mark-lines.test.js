import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  markLineMoves,
  moveLineKeyed,
} from '../src/extension/mark-lines-core.ts';

/**
 * Run marks follow their line's text (mark-lines-core.ts). Each case is the
 * change VS Code reports for an editor action, 0-based, against the text
 * BEFORE the edit — the shapes were recorded from VS Code 1.95 running the
 * real commands, and the command is named in each test. Marks are 1-based, as
 * the tracker stores them.
 *
 * The document is the integration fixture's: steps on 1-based lines 8, 9, 10
 * (0-based 7, 8, 9), so a mark on 9 is step 2. Every case applies its changes
 * to that document and asserts the TEXT each mark lands on, so a case cannot
 * pass by putting a mark on the right number of the wrong line.
 */

const STEP_1 = '1. Navigate to https://example.com'; // 34 characters
const STEP_2 = '2. Click the "Get started" button'; // 33
const STEP_3 = '3. Verify the page title contains "Welcome"'; // 43
const LINES = ['---', 'tags: [smoke]', '---', '', '# Sample Test', '', '## Steps', STEP_1, STEP_2, STEP_3, ''];
const DOC = LINES.join('\n');
const MARKS = [8, 9, 10];

const change = (startLine, startCharacter, endLine, endCharacter, text, rangeLength) => ({
  startLine,
  startCharacter,
  endLine,
  endCharacter,
  text,
  ...(rangeLength !== undefined && { rangeLength }),
});

/** Apply one event's changes the way VS Code does: every range in the ORIGINAL
 *  coordinates, all at once. Applied back to front, and at one position a
 *  zero-width insertion lands after a range ending there and before one
 *  starting there — the order VS Code's own buffer applies them in. */
function applyChanges(text, changes) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const offset = (line, character) => lineStarts[line] + character;
  const ordered = changes
    .map((c) => ({ c, start: offset(c.startLine, c.startCharacter), end: offset(c.endLine, c.endCharacter) }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const { c, start, end } of ordered) out = out.slice(0, start) + c.text + out.slice(end);
  return out;
}

/** Where every mark goes: `{ mark: text of the line it lands on }`, null when
 *  removed. `lines` also returns the 1-based numbers, for the cases that pin
 *  them. */
function after(changes, { text = DOC, marks = MARKS } = {}) {
  const post = applyChanges(text, changes).split(/\r?\n/);
  const moves = markLineMoves(marks, changes, (l) => post[l]?.length ?? 0) ?? new Map();
  const land = (l) => (moves.has(l) ? moves.get(l) : l);
  return {
    text: Object.fromEntries(marks.map((l) => [l, land(l) === null ? null : post[land(l) - 1]])),
    lines: marks.map(land),
  };
}

/** `after`, for when nothing may move: markLineMoves itself says so. */
function movesNothing(changes, { text = DOC, marks = MARKS } = {}) {
  const post = applyChanges(text, changes).split(/\r?\n/);
  return markLineMoves(marks, changes, (l) => post[l]?.length ?? 0) === null;
}

// ---- adding lines -------------------------------------------------------------

test('Enter at the end of a step moves only the steps below it', () => {
  // `type "\n"` at the end of step 1; Insert Line Above (Ctrl+Shift+Enter) on
  // step 2 reports exactly the same change.
  const r = after([change(7, 34, 7, 34, '\n')]);
  assert.deepEqual(r.lines, [8, 10, 11]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('Enter at column 0 of a step pushes that step (and its mark) down', () => {
  // The step's text moves to the next line, so its ✓ goes with it rather than
  // staying on the blank line Enter left behind.
  const r = after([change(8, 0, 8, 0, '\n')]);
  assert.deepEqual(r.lines, [8, 10, 11]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('Enter at column 0 in a CRLF file is the same move', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const r = after([change(8, 0, 8, 0, '\r\n')], { text: crlf });
  assert.deepEqual(r.lines, [8, 10, 11]);
});

test('a line inserted above every step moves every mark', () => {
  assert.deepEqual(after([change(2, 0, 2, 0, 'x: 1\n')]).lines, [9, 10, 11]);
});

test('pasting several lines at column 0 of a step moves it by all of them', () => {
  const r = after([change(8, 0, 8, 0, 'a\nb\nc\n')]);
  assert.deepEqual(r.lines, [8, 12, 13]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('Copy Line Down puts the copy above, so the mark rides the lower of two identical lines', () => {
  // VS Code inserts the copy at column 0 of the original.
  const r = after([change(8, 0, 8, 0, `${STEP_2}\n`)]);
  assert.deepEqual(r.lines, [8, 10, 11]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('lines added below every step move nothing', () => {
  assert.ok(movesNothing([change(10, 0, 10, 0, 'a\nb\n')]));
});

// ---- deleting lines -----------------------------------------------------------

test('Ctrl+Shift+K on a step removes its mark and moves the ones below up', () => {
  // `editor.action.deleteLines`: (8,0) to (9,0), nothing inserted.
  const r = after([change(8, 0, 9, 0, '')]);
  assert.deepEqual(r.lines, [8, null, 9]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: null, 10: STEP_3 });
});

test('a deleted step does NOT hand its mark to the step that slides up', () => {
  // The resume arrow snaps forward on this edit; a result must not. What slid
  // into line 9 is step 3, and it keeps step 3's own mark.
  const moves = markLineMoves([9, 10], [change(8, 0, 9, 0, '')], () => 0);
  assert.deepEqual([...moves], [[9, null], [10, 9]]);
});

test('Ctrl+Shift+K on the LAST line of the document removes that step', () => {
  // With no line after it, VS Code deletes from the end of the line above.
  const last = DOC.replace(/\n$/, '');
  const r = after([change(8, 33, 9, 43, '')], { text: last });
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: null });
});

test('Backspace at column 0 joins the step onto the line above and removes its mark', () => {
  // `deleteLeft`; Delete Word Left and Delete All Left report the same change
  // there. The line above keeps its start, and its mark.
  const r = after([change(7, 34, 8, 0, '')]);
  assert.deepEqual(r.lines, [8, null, 9]);
  assert.deepEqual(r.text, { 8: `${STEP_1}${STEP_2}`, 9: null, 10: STEP_3 });
});

test('Backspace at column 0 in a CRLF file is the same join', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  assert.deepEqual(after([change(7, 34, 8, 0, '', 2)], { text: crlf }).lines, [8, null, 9]);
});

test('Delete at the end of the line above is the same join', () => {
  assert.deepEqual(after([change(8, 33, 9, 0, '')]).lines, [8, 9, null]);
});

test('deleting a blank line between steps moves the steps below up', () => {
  // Steps on 8, 10 and 11, a blank line on 9 (0-based 8) deleted whole.
  const text = [...LINES.slice(0, 8), '', STEP_2, STEP_3, ''].join('\n');
  const r = after([change(8, 0, 9, 0, '')], { text, marks: [8, 10, 11] });
  assert.deepEqual(r.lines, [8, 9, 10]);
  assert.deepEqual(r.text, { 8: STEP_1, 10: STEP_2, 11: STEP_3 });
});

test('deleting from the middle of one step to the middle of the next keeps the first, removes the second', () => {
  assert.deepEqual(after([change(7, 5, 8, 5, '')]).lines, [8, null, 9]);
});

test('selecting a whole step and typing over it removes its mark; the step below keeps its own', () => {
  // A gutter click (or triple click) selects (8,0)-(9,0); `type "x"`.
  const r = after([change(8, 0, 9, 0, 'x')]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: null, 10: `x${STEP_3}` });
});

test('selecting two whole steps and pasting one line removes both marks, moves the rest up', () => {
  const r = after([change(7, 0, 9, 0, 'new\n')]);
  assert.deepEqual(r.text, { 8: null, 9: null, 10: STEP_3 });
  assert.deepEqual(r.lines, [null, null, 9]);
});

test('replacing the whole document removes every mark', () => {
  assert.deepEqual(after([change(0, 0, 10, 0, 'a\nb\n')]).lines, [null, null, null]);
});

// ---- editing in place ---------------------------------------------------------

test('typing inside a step keeps every mark where it is', () => {
  assert.ok(movesNothing([change(8, 6, 8, 6, 'x')]));
});

test('retyping a step from column 0 keeps its mark (an in-place edit)', () => {
  assert.ok(movesNothing([change(8, 0, 8, 33, '2. Press the button')]));
});

test('Renumber Steps rewriting the ordinals keeps every mark', () => {
  // One event, one change per step, each from column 0 over the digits.
  const renumber = [change(7, 0, 7, 1, '4'), change(8, 0, 8, 1, '5'), change(9, 0, 9, 1, '6')];
  assert.ok(movesNothing(renumber));
});

test('indenting a step (Tab at column 0) keeps its mark', () => {
  assert.ok(movesNothing([change(8, 0, 8, 0, '    ')]));
});

test('Toggle Line Comment keeps the mark on the commented step', () => {
  const comment = [change(8, 33, 8, 33, ' -->'), change(8, 0, 8, 0, '<!-- ')];
  assert.ok(movesNothing(comment));
});

test('splitting a step with Enter in the middle keeps the mark on the first half', () => {
  const r = after([change(8, 6, 8, 6, '\n')]);
  assert.deepEqual(r.lines, [8, 9, 11]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: '2. Cli', 10: STEP_3 });
});

test('a line break rewritten as two line breaks moves the next step down one', () => {
  // A replacement of the break itself, as some formatters report it — not a
  // join, because a line break is put back.
  assert.deepEqual(after([change(8, 33, 9, 0, '\n\n')]).lines, [8, 9, 11]);
});

test('a rewrite from column 0 that adds line breaks sends the mark with what is left of the line', () => {
  // Select the ordinal of step 2 and press Enter: (8,0)-(8,1) becomes "\n".
  // The step's text is on the next line now, and the blank line Enter left
  // behind must not wear its ✓.
  const r = after([change(8, 0, 8, 1, '\n')]);
  assert.deepEqual(r.lines, [8, 10, 11]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: '. Click the "Get started" button', 10: STEP_3 });
});

test('…and stays where the rewrite begins when it replaced the whole line', () => {
  // Select all of step 2's text (not its line break) and paste two lines:
  // nothing of the step is left to follow, and the line after the paste is
  // the empty remainder, not a step.
  const r = after([change(8, 0, 8, 33, 'A. one\nB. two\n')]);
  assert.deepEqual(r.lines, [8, 9, 12]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: 'A. one', 10: STEP_3 });
});

test('Undo of typing over a whole step puts the slid-up step\'s mark back on it, not on the restored step', () => {
  // The forward edit: select step 2 whole, type "x" — step 3 slides up to line
  // 9 behind the "x" and keeps its ✗. Undo reports the "x" replaced by the
  // deleted step and its line break: a rewrite of line 9's first character.
  // Kept where that rewrite begins, step 3's ✗ and its hover landed on the
  // restored step 2.
  const typedOver = [...LINES.slice(0, 8), `x${STEP_3}`, ''].join('\n');
  const r = after([change(8, 0, 8, 1, `${STEP_2}\n`)], { text: typedOver, marks: [8, 9] });
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_3 });
  assert.deepEqual(r.lines, [8, 10]);
});

// ---- one event, several changes -----------------------------------------------

test('changes of one event are measured against the text before it, in any order', () => {
  const above = change(2, 0, 2, 0, 'x: 1\n');
  const deleteStep2 = change(8, 0, 9, 0, '');
  assert.deepEqual(after([above, deleteStep2]).lines, [9, null, 10]);
  assert.deepEqual(after([deleteStep2, above]).lines, [9, null, 10]);
});

test('multi-cursor typing on every step moves nothing', () => {
  const typing = [change(7, 4, 7, 4, 'x'), change(8, 4, 8, 4, 'x'), change(9, 4, 9, 4, 'x')];
  assert.ok(movesNothing(typing));
});

test('two touching selections deleted together join a step onto an UNMARKED line: its mark goes, it does not land there', () => {
  // Multi-cursor: (7,5)-(8,0) and (8,0)-(9,0) selected, Backspace. VS Code
  // keeps touching selections apart and reports two changes, and neither is a
  // join on its own. Step 3's text now carries on after "1. Na" — step 1's
  // line. Step 1 has no mark here (a Run Selected of steps 2–3), so nothing
  // else was going to stop step 3's ✗ and hover landing on step 1.
  const changes = [change(8, 0, 9, 0, ''), change(7, 5, 8, 0, '')];
  assert.deepEqual(after(changes, { marks: [9, 10] }).text, { 9: null, 10: null });
  // With step 1 marked it keeps its own mark.
  assert.deepEqual(after(changes).text, { 8: `1. Na${STEP_3}`, 9: null, 10: null });
});

test('a line break inserted where a join ends puts the line back: the mark stays', () => {
  // One event: delete the rest of step 1 and its break, and insert "a\n" at
  // column 0 of step 2. Step 2 still starts a line — the inserted break is in
  // front of it — so it is not a join.
  const changes = [change(8, 0, 8, 0, 'a\n'), change(7, 4, 8, 0, '')];
  const r = after(changes);
  assert.deepEqual(r.text, { 8: '1. Na', 9: STEP_2, 10: STEP_3 });
});

// ---- Move Line Up / Down --------------------------------------------------------

test('Alt+Down on a step moves both marks: the step, and the step it moved past', () => {
  // `editor.action.moveLinesDownAction` on step 2. VS Code deletes step 3 from
  // the end of step 2 to the end of step 3, and re-inserts it above step 2.
  // Read as an ordinary delete, step 3 lost its ✗ although its text never
  // changed.
  const changes = [change(8, 33, 9, 43, '', 44), change(8, 0, 8, 0, `${STEP_3}\n`)];
  const r = after(changes);
  assert.deepEqual(r.lines, [8, 10, 9]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('Alt+Up on a step moves both marks', () => {
  // `editor.action.moveLinesUpAction` on step 3: step 2 deleted whole, and
  // re-inserted after step 3.
  const changes = [change(9, 43, 9, 43, `\n${STEP_2}`), change(8, 0, 9, 0, '', 34)];
  const r = after(changes);
  assert.deepEqual(r.lines, [8, 10, 9]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('Alt+Down on two steps moves the block and the step it passed', () => {
  const changes = [change(8, 33, 9, 43, '', 44), change(7, 0, 7, 0, `${STEP_3}\n`)];
  const r = after(changes);
  assert.deepEqual(r.lines, [9, 10, 8]);
  assert.deepEqual(r.text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('Alt+Down in a CRLF file, and onto a last line with no break after it', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const crlfMove = [change(8, 33, 9, 43, '', 45), change(8, 0, 8, 0, `${STEP_3}\r\n`)];
  assert.deepEqual(after(crlfMove, { text: crlf }).lines, [8, 10, 9]);
  const last = DOC.replace(/\n$/, '');
  const lastMove = [change(8, 33, 9, 43, '', 44), change(8, 0, 8, 0, `${STEP_3}\n`)];
  assert.deepEqual(after(lastMove, { text: last }).text, { 8: STEP_1, 9: STEP_2, 10: STEP_3 });
});

test('Undo of Alt+Down is the move back up, and the marks go back with it', () => {
  const moved = [...LINES.slice(0, 8), STEP_3, STEP_2, ''].join('\n');
  const undo = [change(9, 33, 9, 33, `\n${STEP_3}`), change(8, 0, 9, 0, '', 44)];
  // Marks as the move left them: step 3's on 9, step 2's on 10.
  const r = after(undo, { text: moved, marks: [9, 10] });
  assert.deepEqual(r.lines, [10, 9]);
  assert.deepEqual(r.text, { 9: STEP_3, 10: STEP_2 });
});

test('a delete and an insert that only look like a move are not read as one', () => {
  // Same positions as Alt+Down, but the inserted line is not the deleted one
  // — the lengths disagree — so step 3 was deleted, and its mark goes.
  const changes = [change(8, 33, 9, 43, '', 44), change(8, 0, 8, 0, 'short\n')];
  assert.equal(after(changes).text[10], null);
});

// Several cursors. These shapes were measured on a five-line document of their
// own, and are carried verbatim: one delete-and-insert pair per block, in
// VS Code's order (last block first).
const FIVE = ['alpha line', 'bravo', 'charlie line three', 'delta 4', 'echo five five', ''].join('\n');
const FIVE_MARKS = [1, 2, 3, 4, 5];

test('Alt+Down with two cursors moves both blocks and BOTH lines they move past', () => {
  // Cursors on lines 1 and 3 (1-based). Four changes, not two — read as
  // ordinary deletes, "bravo" and "delta 4" lost their marks though neither
  // text changed.
  const changes = [
    change(2, 18, 3, 7, '', 8),
    change(2, 0, 2, 0, 'delta 4\n', 0),
    change(0, 10, 1, 5, '', 6),
    change(0, 0, 0, 0, 'bravo\n', 0),
  ];
  const r = after(changes, { text: FIVE, marks: FIVE_MARKS });
  assert.deepEqual(r.text, {
    1: 'alpha line',
    2: 'bravo',
    3: 'charlie line three',
    4: 'delta 4',
    5: 'echo five five',
  });
  assert.deepEqual(r.lines, [2, 1, 4, 3, 5]);
});

test('Alt+Up with two cursors, and the Undo of Alt+Down with two, move every mark', () => {
  // Cursors on lines 2 and 4 (1-based).
  const up = [
    change(3, 7, 3, 7, '\ncharlie line three', 0),
    change(2, 0, 3, 0, '', 19),
    change(1, 5, 1, 5, '\nalpha line', 0),
    change(0, 0, 1, 0, '', 11),
  ];
  const r = after(up, { text: FIVE, marks: FIVE_MARKS });
  assert.deepEqual(r.lines, [2, 1, 4, 3, 5]);
  assert.equal(new Set(Object.values(r.text)).size, 5, 'every mark on its own text');
  // Undo of the Alt+Down above, against the text it left.
  const movedDown = ['bravo', 'alpha line', 'delta 4', 'charlie line three', 'echo five five', ''].join('\n');
  const undo = [
    change(3, 18, 3, 18, '\ndelta 4', 0),
    change(2, 0, 3, 0, '', 8),
    change(1, 10, 1, 10, '\nbravo', 0),
    change(0, 0, 1, 0, '', 6),
  ];
  const back = after(undo, { text: movedDown, marks: FIVE_MARKS });
  assert.deepEqual(back.text, {
    1: 'bravo',
    2: 'alpha line',
    3: 'delta 4',
    4: 'charlie line three',
    5: 'echo five five',
  });
});

test('Alt+Down CRLF, and past a blank line, are the same pair', () => {
  const crlf = FIVE.replace(/\n/g, '\r\n');
  const crlfDown = [change(1, 5, 2, 18, '', 20), change(1, 0, 1, 0, 'charlie line three\r\n', 0)];
  assert.deepEqual(after(crlfDown, { text: crlf, marks: FIVE_MARKS }).lines, [1, 3, 2, 4, 5]);
  // "bravo" moved down past a blank line: the blank line carries no mark,
  // and bravo's goes down one.
  const blank = ['alpha line', 'bravo', '', 'charlie line three', 'delta 4', ''].join('\n');
  const pastBlank = [change(1, 5, 2, 0, '', 1), change(1, 0, 1, 0, '\n', 0)];
  assert.deepEqual(after(pastBlank, { text: blank, marks: [1, 2, 4] }).text, {
    1: 'alpha line',
    2: 'bravo',
    4: 'charlie line three',
  });
});

test('a formatter\'s insert and delete that sit where a move\'s would are not read as one', () => {
  // One event from `editor.edit` with two edits — the shape a formatter's
  // TextEdit[] arrives in: a blank line inserted under the heading, and a
  // doubled blank line above step 2 deleted. Measured: VS Code reports it
  // exactly as Alt+Down past an empty line would be, and read as a move,
  // step 2's ✗ landed on the inserted blank line.
  const withBlank = ['# T', '## Steps', '1. one', '', '2. two', ''].join('\n');
  const changes = [change(3, 0, 4, 0, '', 1), change(1, 0, 1, 0, '\n', 0)];
  const r = after(changes, { text: withBlank, marks: [3, 5] });
  assert.deepEqual(r.text, { 3: '1. one', 5: '2. two' });
  assert.deepEqual(r.lines, [4, 5]);
});

test('…nor is a join that sits where a move\'s delete would', () => {
  // A blank line inserted above the steps, and step 2 joined onto step 1, in
  // one event: by position a Move Line Down past an empty line 9. Step 2's
  // text is on the end of step 1 now, so its mark goes — it does not land on
  // the inserted blank line.
  const changes = [change(4, 0, 4, 0, '\n', 0), change(7, 34, 8, 0, '', 1)];
  const r = after(changes);
  assert.deepEqual(r.text, { 8: `${STEP_1}${STEP_2}`, 9: null, 10: STEP_3 });
  assert.deepEqual(r.lines, [9, null, 10]);
});

// ---- applying the moves -------------------------------------------------------

test('moveLineKeyed moves, removes and leaves alone, in place', () => {
  const statuses = new Map([
    [8, 'pass'],
    [9, 'fail'],
    [10, 'pass'],
    [3, 'pass'],
  ]);
  const same = statuses;
  moveLineKeyed(statuses, new Map([[9, null], [10, 9]]));
  assert.equal(statuses, same, 'the same Map — callers hold references to it');
  assert.deepEqual(
    [...statuses].sort((a, b) => a[0] - b[0]),
    [
      [3, 'pass'],
      [8, 'pass'],
      [9, 'pass'],
    ],
  );
});

test('one set of moves for every store keeps a ✗ and its hover on the same step', () => {
  const statuses = new Map([[8, 'pass'], [10, 'fail']]);
  const failures = new Map([[10, { error: 'boom' }]]);
  const changes = [change(7, 5, 8, 0, ''), change(8, 0, 9, 0, '')];
  const moves = markLineMoves([...statuses.keys(), ...failures.keys()], changes, () => 0);
  moveLineKeyed(statuses, moves);
  moveLineKeyed(failures, moves);
  assert.deepEqual([...statuses], [[8, 'pass']]);
  assert.deepEqual([...failures], [], 'the failure went with its step, not onto step 1');
});
