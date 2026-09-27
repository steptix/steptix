/**
 * Record Steps, the editing half (stories/testbench-record-steps.md,
 * decisions 8 and 11): where the cursor may start a recording, where the
 * result goes, how the rest is renumbered, and how `## Parameters` is merged.
 *
 * The command needs a VS Code host; every decision it makes about TEXT lives
 * in record-steps-core.ts and is pinned here as before/after documents via
 * `applyRecordEdits`, which applies the plan the way one edit builder does.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURSOR_REFUSALS,
  applyOffsetEdits,
  applyRecordEdits,
  applyRecordFrame,
  beginLiveRecord,
  liveRecordWrite,
  recordedLines,
  trackRecordSlots,
  newRecordingState,
  cleanStepText,
  findProjectConfigs,
  formatRecordTime,
  globStaticPrefix,
  inferBaseUrl,
  newTestDir,
  newTestSkeleton,
  planRecordInsertion,
  plainNotificationText,
  recordedStepsText,
  recordingStatusText,
  resolveRecordCursor,
  titleFromName,
  trackAnchorThroughChanges,
  validateNewTestName,
} from '../src/extension/record-steps-core.ts';

const doc = (...lines) => lines.join('\n');

/**
 * The server's own parser (src/parser/markdown.ts, as built into the repo
 * root's dist/) — the judge of whether an inserted result still makes a test
 * the runner will read, and of what it reads out of `## Parameters`. The cases
 * that use it skip, saying so, when the root has not been built.
 */
const PARSER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/parser/markdown.js');
const serverParser = fs.existsSync(PARSER_PATH) ? await import(pathToFileURL(PARSER_PATH).href) : null;
/** `text` as the server parses it, or null (and the case skipped) with no build. */
function serverParse(t, text) {
  if (!serverParser) {
    t.skip(`the repo root is not built (${PARSER_PATH} is missing)`);
    return null;
  }
  return serverParser.parseTestContent(text, 'recorded.md');
}
/** 1-based line number of the first line equal to `needle`. */
const lineOf = (text, needle) => {
  const i = text.split(/\r?\n/).indexOf(needle);
  assert.ok(i >= 0, `fixture has no line ${JSON.stringify(needle)}`);
  return i + 1;
};

/** Resolve the cursor on `needle`, plan, apply — the whole flow as text. */
function recordAt(text, needle, steps, parameters = [], nth = 0) {
  const lines = text.split(/\r?\n/);
  let idx = -1;
  for (let i = 0, seen = 0; i < lines.length; i++) {
    if (lines[i] === needle && seen++ === nth) {
      idx = i;
      break;
    }
  }
  assert.ok(idx >= 0, `fixture has no line ${JSON.stringify(needle)}`);
  const cursor = resolveRecordCursor(text, idx + 1);
  assert.equal(cursor.ok, true, cursor.reason);
  const plan = planRecordInsertion(text, { anchor: cursor.anchor, steps, parameters });
  assert.ok(!('error' in plan), plan.error);
  return { plan, after: applyRecordEdits(text, plan.edits) };
}

const SAMPLE = doc(
  '# Pay by cash',
  '',
  '## Config',
  '- baseUrl: http://localhost:8787/',
  '',
  '## Parameters',
  '- email: demo@securebank.com',
  '',
  '## Steps',
  '1. Navigate to login.html',
  '2. Sign in',
  '3. Open Payments',
  '4. Sign out',
  '',
  '### Sign in',
  '',
  '1. Type {{email}} into the Email field',
  '2. Click the Sign in button',
  '',
  '## Notes',
  'Written by hand.',
);

// ---------------------------------------------------------------------------
// Where the cursor may start a recording (decision 11)
// ---------------------------------------------------------------------------

test('cursor on a main-flow step anchors there, in the main flow', () => {
  const r = resolveRecordCursor(SAMPLE, lineOf(SAMPLE, '2. Sign in'));
  assert.deepEqual(r, {
    ok: true,
    anchor: { line: lineOf(SAMPLE, '2. Sign in'), text: '2. Sign in', kind: 'step', section: null },
  });
});

test('cursor on a section-body step anchors in that section', () => {
  const r = resolveRecordCursor(SAMPLE, lineOf(SAMPLE, '1. Type {{email}} into the Email field'));
  assert.equal(r.ok, true);
  assert.equal(r.anchor.kind, 'step');
  assert.equal(r.anchor.section, 'Sign in');
});

test('the blank line after a step anchors on that step', () => {
  const text = SAMPLE;
  const blankAfterMain = lineOf(text, '4. Sign out') + 1;
  assert.deepEqual(resolveRecordCursor(text, blankAfterMain), {
    ok: true,
    anchor: { line: lineOf(text, '4. Sign out'), text: '4. Sign out', kind: 'step', section: null },
  });
  const blankAfterBody = lineOf(text, '2. Click the Sign in button') + 1;
  const body = resolveRecordCursor(text, blankAfterBody);
  assert.equal(body.ok, true);
  assert.equal(body.anchor.line, lineOf(text, '2. Click the Sign in button'));
  assert.equal(body.anchor.section, 'Sign in');
});

test('the blank line under ## Steps or a ### heading opens that flow', () => {
  const empty = doc('# T', '', '## Steps', '', '### Login', '');
  const main = resolveRecordCursor(empty, 4);
  assert.deepEqual(main, { ok: true, anchor: { line: 3, text: '## Steps', kind: 'heading', section: null } });
  const section = resolveRecordCursor(empty, 6);
  assert.deepEqual(section, { ok: true, anchor: { line: 5, text: '### Login', kind: 'heading', section: 'Login' } });
});

test('a wrapped step: its continuation line and the blank after it anchor on the step', () => {
  const text = doc('## Steps', '1. Type the username', '   into the tenant field', '', '2. Next');
  for (const line of [3, 4]) {
    const r = resolveRecordCursor(text, line);
    assert.equal(r.ok, true, `line ${line}`);
    assert.equal(r.anchor.line, 2, `line ${line}`);
  }
});

test('headings, prose, frontmatter and lines outside ## Steps are refused', () => {
  const text = doc('---', 'tags: [a]', '---', '# Title', 'Intro prose.', '', '## Steps', '1. One', '', '## Notes', 'Prose.', '');
  for (const needle of ['tags: [a]', '# Title', 'Intro prose.', '## Steps', '## Notes', 'Prose.']) {
    const r = resolveRecordCursor(text, lineOf(text, needle));
    assert.equal(r.ok, false, needle);
    assert.equal(r.reason, CURSOR_REFUSALS.notAStep, needle);
  }
  // The blank after `## Notes` belongs to Notes, not to the steps.
  assert.equal(resolveRecordCursor(text, 12).ok, false);
  // A section heading itself is a heading, not the blank line under it.
  assert.equal(resolveRecordCursor(SAMPLE, lineOf(SAMPLE, '### Sign in')).ok, false);
});

test('a numbered line inside a fence, and a blank line after a fence, are refused', () => {
  const text = doc('## Steps', '1. One', '```', '2. Not a step', '```', '', '3. Three');
  assert.deepEqual(resolveRecordCursor(text, 4), { ok: false, reason: CURSOR_REFUSALS.inFence });
  assert.deepEqual(resolveRecordCursor(text, 3), { ok: false, reason: CURSOR_REFUSALS.inFence });
  assert.equal(resolveRecordCursor(text, 6).ok, false);
});

test('an item under a #### heading is refused as inert', () => {
  const text = doc('## Steps', '1. One', '', '#### Ignored', '1. Not run');
  assert.deepEqual(resolveRecordCursor(text, 5), { ok: false, reason: CURSOR_REFUSALS.inert });
});

test('a file with no ## Steps is refused as such', () => {
  assert.deepEqual(resolveRecordCursor(doc('# Notes', '1. A list'), 2), { ok: false, reason: CURSOR_REFUSALS.noSteps });
});

// ---------------------------------------------------------------------------
// Insertion and renumbering
// ---------------------------------------------------------------------------

test('main flow: steps go after the cursor step, numbered on, and the rest is renumbered', () => {
  const { plan, after } = recordAt(SAMPLE, '2. Sign in', ['Click Payments in the main menu', 'Tick the Cash checkbox']);
  assert.equal(
    after,
    doc(
      '# Pay by cash',
      '',
      '## Config',
      '- baseUrl: http://localhost:8787/',
      '',
      '## Parameters',
      '- email: demo@securebank.com',
      '',
      '## Steps',
      '1. Navigate to login.html',
      '2. Sign in',
      '3. Click Payments in the main menu',
      '4. Tick the Cash checkbox',
      '5. Open Payments',
      '6. Sign out',
      '',
      '### Sign in',
      '',
      '1. Type {{email}} into the Email field',
      '2. Click the Sign in button',
      '',
      '## Notes',
      'Written by hand.',
    ),
  );
  assert.deepEqual(plan.insertedLines, [12, 13]);
  assert.equal(plan.section, null);
  assert.equal(plan.fellBack, false);
});

test('inside a section: the section body continues and only it is renumbered', () => {
  const { after, plan } = recordAt(SAMPLE, '1. Type {{email}} into the Email field', ['Type {{password}} into the Password field']);
  assert.match(
    after,
    /### Sign in\n\n1\. Type \{\{email\}\} into the Email field\n2\. Type \{\{password\}\} into the Password field\n3\. Click the Sign in button\n/,
  );
  // The main flow is untouched.
  assert.match(after, /## Steps\n1\. Navigate to login\.html\n2\. Sign in\n3\. Open Payments\n4\. Sign out\n/);
  assert.equal(plan.section, 'Sign in');
});

test('numbers continue from the anchor as written, and only the steps after it are renumbered', () => {
  // The walk continues from what is written, not from the step's position.
  const text = doc('## Steps', '1. A', '5. B', '6. C', '', '### S', '1. X', '2. Y');
  const { after } = recordAt(text, '5. B', ['New']);
  assert.equal(after, doc('## Steps', '1. A', '5. B', '6. New', '7. C', '', '### S', '1. X', '2. Y'));
});

test('a flow numbered 1. throughout stays 1. throughout — its own style, nothing renumbered', () => {
  // Main flow, from a step and from the heading.
  const main = doc('## Steps', '1. A', '1. B', '1. C');
  assert.equal(recordAt(main, '1. B', ['New', 'Newer']).after, doc('## Steps', '1. A', '1. B', '1. New', '1. Newer', '1. C'));
  const opened = doc('## Steps', '', '1. A', '1. B');
  assert.equal(recordAt(opened, '', ['New']).after, doc('## Steps', '', '1. New', '1. A', '1. B'));
  // A section body keeps its own style; the main flow beside it keeps its own.
  const sections = doc('## Steps', '1. Main', '2. More', '', '### S', '1. X', '1. Y');
  assert.equal(
    recordAt(sections, '1. X', ['New']).after,
    doc('## Steps', '1. Main', '2. More', '', '### S', '1. X', '1. New', '1. Y'),
  );
  assert.equal(
    recordAt(sections, '1. Main', ['New']).after,
    doc('## Steps', '1. Main', '2. New', '3. More', '', '### S', '1. X', '1. Y'),
  );
  // One step is not a style: a lone `1.` continues as 2.
  assert.equal(recordAt(doc('## Steps', '1. A'), '1. A', ['New']).after, doc('## Steps', '1. A', '2. New'));
});

test('at the end of the flow nothing is renumbered, and a missing trailing newline is handled', () => {
  const text = doc('## Steps', '1. A', '2. B');
  const { after, plan } = recordAt(text, '2. B', ['C', 'D']);
  assert.equal(after, doc('## Steps', '1. A', '2. B', '3. C', '4. D'));
  assert.deepEqual(plan.insertedLines, [4, 5]);
  assert.equal(plan.edits.length, 1);
});

test('a wrapped step is not split: new steps go after its continuation', () => {
  const text = doc('## Steps', '1. Type the username', '   into the tenant field', '2. Next', '');
  const { after } = recordAt(text, '1. Type the username', ['Click Go']);
  assert.equal(after, doc('## Steps', '1. Type the username', '   into the tenant field', '2. Click Go', '3. Next', ''));
});

test('from the blank line under ## Steps the steps open the flow, ahead of step 1', () => {
  const text = doc('## Steps', '', '1. Old first', '2. Old second', '');
  const { after, plan } = recordAt(text, '', ['New first']);
  assert.equal(after, doc('## Steps', '', '1. New first', '2. Old first', '3. Old second', ''));
  assert.deepEqual(plan.insertedLines, [3]);
});

test('an empty section body is filled from the blank line under its heading', () => {
  const text = doc('## Steps', '1. Main', '', '### Login', '', '### Other', '1. X');
  const { after } = recordAt(text, '', ['Type', 'Submit'], [], 1);
  assert.equal(after, doc('## Steps', '1. Main', '', '### Login', '1. Type', '2. Submit', '', '### Other', '1. X'));
});

test('fenced numbered lines are neither renumbered nor counted', () => {
  const text = doc('## Steps', '1. A', '```', '2. literal', '```', '2. B');
  const { after } = recordAt(text, '1. A', ['New']);
  assert.equal(after, doc('## Steps', '1. A', '2. New', '```', '2. literal', '```', '3. B'));
});

test('CRLF documents keep CRLF line endings', () => {
  const text = doc('## Steps', '1. A', '2. B', '').replace(/\n/g, '\r\n');
  const { after } = recordAt(text, '1. A', ['New'], [{ name: 'email', value: 'a@b' }]);
  assert.equal(after, '## Parameters\r\n- email: a@b\r\n\r\n## Steps\r\n1. A\r\n2. New\r\n3. B\r\n');
});

test('step texts are cleaned: one line, no leading number, blanks dropped', () => {
  assert.equal(cleanStepText('  3. Click   the\nbutton '), 'Click the button');
  assert.equal(cleanStepText(undefined), '');
  const plan = planRecordInsertion(doc('## Steps', '1. A'), { anchor: null, steps: ['', '  ', 'B'], parameters: [] });
  assert.equal(applyRecordEdits(doc('## Steps', '1. A'), plan.edits), doc('## Steps', '1. A', '2. B'));
  assert.deepEqual(planRecordInsertion(doc('## Steps'), { anchor: null, steps: [' '], parameters: [] }), {
    error: 'The recording came back with no steps.',
  });
});

test('mode new (no anchor): the steps go directly under ## Steps of the skeleton', () => {
  const { text } = newTestSkeleton({ title: 'Pay by cash', baseUrl: 'http://localhost:8787/' });
  const plan = planRecordInsertion(text, {
    anchor: null,
    steps: ['Navigate to login.html', 'Type {{email}} into the Email field', 'Type {{password}} into the Password field', 'Click the Sign in button'],
    parameters: [
      { name: 'email', value: 'demo@securebank.com' },
      { name: 'password', value: '$PASSWORD' },
    ],
  });
  // The story's worked example, byte for byte.
  assert.equal(
    applyRecordEdits(text, plan.edits),
    doc(
      '# Pay by cash',
      '',
      '## Config',
      '- baseUrl: http://localhost:8787/',
      '',
      '## Parameters',
      '- email: demo@securebank.com',
      '- password: $PASSWORD',
      '',
      '## Steps',
      '1. Navigate to login.html',
      '2. Type {{email}} into the Email field',
      '3. Type {{password}} into the Password field',
      '4. Click the Sign in button',
      '',
    ),
  );
  assert.deepEqual(plan.insertedLines, [11, 12, 13, 14]);
});

// ---------------------------------------------------------------------------
// A flow that opens with a data table (the parser: the table comes first,
// "before the numbered steps it feeds")
// ---------------------------------------------------------------------------

test('a main flow holding only a data table: steps go after the table, and the file still parses', (t) => {
  const text = doc('# T', '', '## Steps', '', '| user |', '| --- |', '| a |', '');
  // The blank line after the table is a place to record from, as is the one
  // under the heading; both open the flow.
  const heading = { line: 3, text: '## Steps', kind: 'heading', section: null };
  assert.deepEqual(resolveRecordCursor(text, 8), { ok: true, anchor: heading });
  assert.deepEqual(resolveRecordCursor(text, 4), { ok: true, anchor: heading });
  const plan = planRecordInsertion(text, {
    anchor: heading,
    steps: ['Type {{user}} into the Username field', 'Click Sign in'],
    parameters: [],
  });
  const after = applyRecordEdits(text, plan.edits);
  assert.equal(
    after,
    doc('# T', '', '## Steps', '', '| user |', '| --- |', '| a |', '', '1. Type {{user}} into the Username field', '2. Click Sign in', ''),
  );
  assert.deepEqual(plan.insertedLines, [9, 10]);
  const parsed = serverParse(t, after);
  if (parsed) assert.equal(parsed.steps.length, 2);
});

test('a section holding only a data table: steps go after its table, before the next section', (t) => {
  const text = doc('# T', '', '## Steps', '1. Log in', '', '### Log in', '', '| user |', '| --- |', '| a |', '', '### Other', '1. X', '');
  const cursor = resolveRecordCursor(text, 11);
  assert.deepEqual(cursor, { ok: true, anchor: { line: 6, text: '### Log in', kind: 'heading', section: 'Log in' } });
  const plan = planRecordInsertion(text, { anchor: cursor.anchor, steps: ['Type {{user}}'], parameters: [] });
  const after = applyRecordEdits(text, plan.edits);
  assert.equal(
    after,
    doc('# T', '', '## Steps', '1. Log in', '', '### Log in', '', '| user |', '| --- |', '| a |', '', '1. Type {{user}}', '', '### Other', '1. X', ''),
  );
  assert.equal(plan.section, 'Log in');
  serverParse(t, after);
});

test('a table that ends the file, or runs straight into a heading, gets a blank line before the steps', (t) => {
  const endsFile = doc('## Steps', '', '| a |', '| - |', '| 1 |');
  const a = applyRecordEdits(endsFile, planRecordInsertion(endsFile, { anchor: null, steps: ['New'], parameters: [] }).edits);
  assert.equal(a, doc('## Steps', '', '| a |', '| - |', '| 1 |', '', '1. New'));
  serverParse(t, a);
  const intoHeading = doc('## Steps', '| a |', '| - |', '| 1 |', '### S', '1. X', '');
  const b = applyRecordEdits(intoHeading, planRecordInsertion(intoHeading, { anchor: null, steps: ['New'], parameters: [] }).edits);
  assert.equal(b, doc('## Steps', '| a |', '| - |', '| 1 |', '', '1. New', '', '### S', '1. X', ''));
  serverParse(t, b);
});

test('a comment between the heading and its table is skipped, as the parser skips it', (t) => {
  const text = doc('## Steps', '<!-- one row per user -->', '| a |', '| - |', '| 1 |', '');
  const cursor = resolveRecordCursor(text, 6);
  assert.equal(cursor.ok, true);
  assert.equal(cursor.anchor.kind, 'heading');
  const after = applyRecordEdits(text, planRecordInsertion(text, { anchor: cursor.anchor, steps: ['New'], parameters: [] }).edits);
  assert.equal(after, doc('## Steps', '<!-- one row per user -->', '| a |', '| - |', '| 1 |', '', '1. New', ''));
  serverParse(t, after);
});

test('the blank line between a table and its steps opens the flow ahead of step 1', (t) => {
  const text = doc('## Steps', '', '| a |', '| - |', '| 1 |', '', '1. Old', '');
  const { after } = recordAt(text, '', ['New'], [], 1); // the blank under the table
  assert.equal(after, doc('## Steps', '', '| a |', '| - |', '| 1 |', '', '1. New', '2. Old', ''));
  serverParse(t, after);
});

// A table is what the parser calls one (src/parser/data-rows.ts): a line with
// an unescaped `|` over a delimiter row — the pipes at a row's ends optional.

test('a table written without leading pipes is a table: steps go after it, and the blank after it is a place', (t) => {
  const text = doc('# T', '', '## Steps', '', 'user | pass', '--- | ---', 'a | b', '', '');
  const heading = { line: 3, text: '## Steps', kind: 'heading', section: null };
  assert.deepEqual(resolveRecordCursor(text, 8), { ok: true, anchor: heading }, 'the blank line after the table');
  assert.deepEqual(resolveRecordCursor(text, 4), { ok: true, anchor: heading }, 'the blank line under ## Steps');
  const plan = planRecordInsertion(text, { anchor: heading, steps: ['Type {{user}} into Username', 'Click Sign in'], parameters: [] });
  const after = applyRecordEdits(text, plan.edits);
  assert.equal(
    after,
    doc('# T', '', '## Steps', '', 'user | pass', '--- | ---', 'a | b', '', '1. Type {{user}} into Username', '2. Click Sign in', ''),
  );
  assert.deepEqual(plan.insertedLines, [9, 10]);
  // Record New Test's case too: no anchor, the steps still follow the table.
  assert.equal(applyRecordEdits(text, planRecordInsertion(text, { anchor: null, steps: ['Type {{user}} into Username', 'Click Sign in'], parameters: [] }).edits), after);
  const parsed = serverParse(t, after);
  if (parsed) {
    assert.equal(parsed.steps.length, 2);
    assert.deepEqual(parsed.dataRows, [{ user: 'a', pass: 'b' }]);
  }
});

test('a section table without leading pipes: steps go after it, and escaped pipes are cell text, not columns', (t) => {
  const text = doc(
    '# T', '', '## Steps', '1. Log in', '',
    '### Log in', '', 'user | note', ':--- | ---:', 'a | x \\| y', '',
    '### Other', '1. X', '',
  );
  const cursor = resolveRecordCursor(text, 11);
  assert.deepEqual(cursor, { ok: true, anchor: { line: 6, text: '### Log in', kind: 'heading', section: 'Log in' } });
  const after = applyRecordEdits(text, planRecordInsertion(text, { anchor: cursor.anchor, steps: ['Type {{user}}'], parameters: [] }).edits);
  assert.equal(
    after,
    doc(
      '# T', '', '## Steps', '1. Log in', '',
      '### Log in', '', 'user | note', ':--- | ---:', 'a | x \\| y', '', '1. Type {{user}}', '',
      '### Other', '1. X', '',
    ),
  );
  const parsed = serverParse(t, after);
  if (parsed) {
    const section = parsed.sections['log in'];
    assert.deepEqual(section.rows, [{ user: 'a', note: 'x | y' }]);
    assert.deepEqual(section.steps, ['Type {{user}}']);
  }
});

test('a line whose only pipes are escaped opens no table: the flow has none, and the steps open it', (t) => {
  // `a \| b` holds no pipe, so `--- | ---` under it is not its delimiter row,
  // and nothing here is a table — the steps go under the heading, where a
  // table-shaped reading would have put them after the "rows".
  const text = doc('## Steps', '', 'a \\| b', '--- | ---', 'c | d', '');
  const plan = planRecordInsertion(text, { anchor: null, steps: ['New'], parameters: [] });
  const after = applyRecordEdits(text, plan.edits);
  assert.equal(after, doc('## Steps', '1. New', '', 'a \\| b', '--- | ---', 'c | d', ''));
  const parsed = serverParse(t, after);
  if (parsed) {
    assert.equal(parsed.dataRows, undefined);
    assert.equal(parsed.steps.length, 1);
  }
  // And a pipe-less table whose second "row" has only escaped pipes ends
  // before it, as the parser's rows do: the blank line after that prose is
  // not the blank line after the table.
  const prose = doc('## Steps', '', 'u | v', '--- | ---', '1 | 2', 'x \\| y', '', '');
  assert.deepEqual(resolveRecordCursor(prose, 7), { ok: false, reason: CURSOR_REFUSALS.notAStep });
  assert.deepEqual(resolveRecordCursor(doc('## Steps', '', 'u | v', '--- | ---', '1 | 2', '', ''), 6).ok, true);
});

test('pipes with no delimiter row under them are not a table: that line continues the step above', (t) => {
  const text = doc('## Steps', '1. Check the grid heading reads', '| Name | Age |', '', '2. Sign out', '');
  // The blank after the folded line belongs to step 1, as the line itself does.
  const anchor = { line: 2, text: '1. Check the grid heading reads', kind: 'step', section: null };
  assert.deepEqual(resolveRecordCursor(text, 4), { ok: true, anchor });
  assert.deepEqual(resolveRecordCursor(text, 3), { ok: true, anchor });
  const after = applyRecordEdits(text, planRecordInsertion(text, { anchor, steps: ['New'], parameters: [] }).edits);
  // After the whole step, not between its two lines.
  assert.equal(after, doc('## Steps', '1. Check the grid heading reads', '| Name | Age |', '2. New', '', '3. Sign out', ''));
  const parsed = serverParse(t, after);
  if (parsed) {
    assert.equal(parsed.dataRows, undefined);
    // The parser folds the line into step 1 too.
    assert.deepEqual(parsed.steps, ['Check the grid heading reads\n| Name | Age |', 'New', 'Sign out']);
  }
});

// ---------------------------------------------------------------------------
// The document changed while recording
// ---------------------------------------------------------------------------

/** A change as VS Code reports one: 0-based range in the document before it. */
const change = (startLine, startChar, endLine, endChar, text) => ({ startLine, startChar, endLine, endChar, text });

test('the anchor follows edits: lines added or removed above move it; edits within it keep it', () => {
  const a = { line: 5, text: '3. Click Next', kind: 'step', section: null, tracked: true };
  const track = (changes) => trackAnchorThroughChanges(a, changes);
  assert.deepEqual(track([change(1, 0, 1, 0, 'A note.\n')]), { ...a, line: 6 });
  assert.equal(track([change(1, 0, 3, 0, '')]).line, 3, 'two whole lines deleted above');
  assert.equal(track([change(2, 0, 4, 0, 'x\n')]).line, 4, 'two lines replaced by one, ending in a break');
  // A renumber rewrites the line in place: same line, still tracked, whatever
  // its text now says.
  assert.deepEqual(track([change(4, 0, 4, 1, '4')]), { ...a, line: 5 });
  assert.equal(track([change(4, 0, 4, 0, '\n')]).line, 6, 'Enter at its start pushes it down');
  assert.equal(track([change(4, 13, 4, 13, ' twice')]).line, 5, 'typing at its end');
  assert.equal(track([change(6, 0, 9, 0, '')]).line, 5, 'an edit below changes nothing');
  // One event carrying several changes (a multi-cursor edit, a renumber).
  assert.equal(track([change(0, 0, 0, 0, 'top\n'), change(4, 0, 4, 1, '9'), change(6, 0, 6, 0, 'below\n')]).line, 6);
});

test('the anchor is lost when its line is deleted or glued onto the line above — and stays lost', () => {
  const a = { line: 5, text: '3. Click Next', kind: 'step', section: null, tracked: true };
  for (const [what, c] of [
    ['the line deleted', change(4, 0, 5, 0, '')],
    ['Backspace at its start', change(3, 9, 4, 0, '')],
    ['lines above replaced by text with no break', change(2, 0, 4, 0, 'x')],
    ['a selection through it replaced', change(3, 0, 4, 5, 'y')],
  ]) {
    const lost = trackAnchorThroughChanges(a, [c]);
    assert.equal(lost.tracked, false, what);
    assert.equal(trackAnchorThroughChanges(lost, [change(0, 0, 0, 0, '\n')]), lost, `${what}: stays lost`);
  }
});

test('a tracked anchor lands after the step the author chose, not an identical one the text matches', () => {
  // The author records after the SECOND "Click Next", then inserts a step
  // above it and renumbers — which gives the FIRST "Click Next" the anchor's
  // old text and old line. Matching by text or position picks the wrong one.
  const before = doc('## Steps', '1. Open', '2. Click Next', '3. Click Next', '4. Done');
  const cursor = resolveRecordCursor(before, 4);
  let anchor = { ...cursor.anchor, tracked: true };
  anchor = trackAnchorThroughChanges(anchor, [change(2, 0, 2, 0, '2. Log in\n')]);
  anchor = trackAnchorThroughChanges(anchor, [change(3, 0, 3, 1, '3'), change(4, 0, 4, 1, '4'), change(5, 0, 5, 1, '5')]);
  const during = doc('## Steps', '1. Open', '2. Log in', '3. Click Next', '4. Click Next', '5. Done');
  const plan = planRecordInsertion(during, { anchor, steps: ['Tick Agree'], parameters: [] });
  assert.equal(plan.fellBack, false);
  assert.equal(
    applyRecordEdits(during, plan.edits),
    doc('## Steps', '1. Open', '2. Log in', '3. Click Next', '4. Click Next', '5. Tick Agree', '6. Done'),
  );
  // The same with a line added under the title of a `1.`-everywhere list,
  // where the anchor's old line number now holds the other "Click Next".
  const ones = doc('# T', '', '## Steps', '1. Open wizard', '1. Click Next', '1. Click Next', '1. Click Finish');
  let onesAnchor = { ...resolveRecordCursor(ones, 6).anchor, tracked: true };
  onesAnchor = trackAnchorThroughChanges(onesAnchor, [change(1, 0, 1, 0, 'A wizard test.\n')]);
  const onesDuring = doc('# T', 'A wizard test.', '', '## Steps', '1. Open wizard', '1. Click Next', '1. Click Next', '1. Click Finish');
  assert.equal(
    applyRecordEdits(onesDuring, planRecordInsertion(onesDuring, { anchor: onesAnchor, steps: ['Tick Agree'], parameters: [] }).edits),
    doc('# T', 'A wizard test.', '', '## Steps', '1. Open wizard', '1. Click Next', '1. Click Next', '1. Tick Agree', '1. Click Finish'),
  );
});

test('a tracked section anchor follows the section when it is renamed', () => {
  const before = doc('## Steps', '1. Login', '', '### Login', '1. a', '2. b');
  let anchor = { ...resolveRecordCursor(before, 5).anchor, tracked: true };
  anchor = trackAnchorThroughChanges(anchor, [change(3, 4, 3, 9, 'Sign in'), change(1, 3, 1, 8, 'Sign in')]);
  const during = doc('## Steps', '1. Sign in', '', '### Sign in', '1. a', '2. b');
  const plan = planRecordInsertion(during, { anchor, steps: ['X'], parameters: [] });
  assert.equal(plan.fellBack, false);
  assert.equal(plan.section, 'Sign in');
  assert.equal(applyRecordEdits(during, plan.edits), doc('## Steps', '1. Sign in', '', '### Sign in', '1. a', '2. X', '3. b'));
});

test('a lost anchor falls back to its text, else to the end of its flow', () => {
  const before = doc('## Steps', '1. A', '2. B', '3. C');
  const anchor = { ...resolveRecordCursor(before, 3).anchor, tracked: false };
  // Its line was deleted and retyped lower down: found by its text.
  const moved = doc('## Steps', '1. A', '3. C', '2. B');
  assert.match(applyRecordEdits(moved, planRecordInsertion(moved, { anchor, steps: ['N'], parameters: [] }).edits), /2\. B\n3\. N$/);
  // Gone: the end of its flow, said.
  const gone = doc('## Steps', '1. A', '3. C');
  const plan = planRecordInsertion(gone, { anchor, steps: ['N'], parameters: [] });
  assert.equal(plan.fellBack, true);
  assert.match(plan.warnings[0], /deleted or changed while you were recording/);
});

test('an anchor that moved is found again by its text', () => {
  const cursor = resolveRecordCursor(SAMPLE, lineOf(SAMPLE, '2. Sign in'));
  // Two lines added above the steps while recording.
  const edited = SAMPLE.replace('## Steps', '## Steps\n\nA note.');
  const plan = planRecordInsertion(edited, { anchor: cursor.anchor, steps: ['New'], parameters: [] });
  assert.equal(plan.fellBack, false);
  assert.match(applyRecordEdits(edited, plan.edits), /2\. Sign in\n3\. New\n4\. Open Payments\n5\. Sign out/);
});

test('an anchor that is gone: the steps go at the end of its flow, and it says so', () => {
  const cursor = resolveRecordCursor(SAMPLE, lineOf(SAMPLE, '2. Sign in'));
  const edited = SAMPLE.replace('2. Sign in\n', '');
  const plan = planRecordInsertion(edited, { anchor: cursor.anchor, steps: ['New'], parameters: [] });
  assert.equal(plan.fellBack, true);
  assert.match(plan.warnings[0], /changed while you were recording.*end of the main flow/);
  // End of the MAIN flow — not after the last section, which would make it a body step.
  assert.match(applyRecordEdits(edited, plan.edits), /3\. Open Payments\n4\. Sign out\n5\. New\n\n### Sign in/);
});

test('a section anchor that is gone falls back to the end of that section', () => {
  const cursor = resolveRecordCursor(SAMPLE, lineOf(SAMPLE, '1. Type {{email}} into the Email field'));
  const edited = SAMPLE.replace('1. Type {{email}} into the Email field', '1. Type {{email}} in the Email box');
  const plan = planRecordInsertion(edited, { anchor: cursor.anchor, steps: ['New'], parameters: [] });
  assert.equal(plan.fellBack, true);
  assert.match(plan.warnings[0], /end of the "Sign in" section/);
  assert.match(applyRecordEdits(edited, plan.edits), /2\. Click the Sign in button\n3\. New\n/);
});

test('an anchor whose text now appears twice is ambiguous, so it falls back', () => {
  const text = doc('## Steps', '1. A', '2. B', '3. C');
  const cursor = resolveRecordCursor(text, 3);
  const edited = doc('## Steps', '1. A', '2. B', '3. C', '2. B');
  const plan = planRecordInsertion(edited, { anchor: { ...cursor.anchor, line: 99 }, steps: ['N'], parameters: [] });
  assert.equal(plan.fellBack, true);
});

// ---------------------------------------------------------------------------
// ## Parameters (decisions 7 and 8)
// ---------------------------------------------------------------------------

test('a missing ## Parameters section is created immediately above ## Steps', () => {
  const text = doc('# T', '', '## Config', '- baseUrl: x', '', '## Steps', '1. A', '');
  const { after, plan } = recordAt(text, '1. A', ['Type {{email}} into Email'], [{ name: 'email', value: 'a@b.c' }]);
  assert.equal(
    after,
    doc('# T', '', '## Config', '- baseUrl: x', '', '## Parameters', '- email: a@b.c', '', '## Steps', '1. A', '2. Type {{email}} into Email', ''),
  );
  assert.deepEqual(plan.parametersAdded, ['email']);
  // The shift from the lines added above is in the reported position.
  assert.deepEqual(plan.insertedLines, [11]);
});

test('a created section gets a blank line before it when ## Steps had none', () => {
  const text = doc('## Config', '- baseUrl: x', '## Steps', '1. A');
  const { after } = recordAt(text, '1. A', ['B'], [{ name: 'q', value: 'v' }]);
  assert.equal(after, doc('## Config', '- baseUrl: x', '', '## Parameters', '- q: v', '', '## Steps', '1. A', '2. B'));
});

test('new parameters go after the existing ones; an existing name is never touched', () => {
  const { after, plan } = recordAt(SAMPLE, '4. Sign out', ['Type {{password}}'], [
    { name: 'email', value: 'demo@securebank.com' },
    { name: 'password', value: '$PASSWORD' },
  ]);
  assert.match(after, /## Parameters\n- email: demo@securebank\.com\n- password: \$PASSWORD\n\n## Steps/);
  assert.deepEqual(plan.parametersAdded, ['password']);
  assert.deepEqual(plan.parameterConflicts, []);
  assert.deepEqual(plan.warnings, []);
});

test('the same name with a different value is left as it is, and warned about', () => {
  const { after, plan } = recordAt(SAMPLE, '4. Sign out', ['Type {{email}}'], [{ name: 'email', value: 'other@x.y' }]);
  assert.match(after, /## Parameters\n- email: demo@securebank\.com\n\n## Steps/);
  assert.deepEqual(plan.parameterConflicts, [{ name: 'email', existing: 'demo@securebank.com', recorded: 'other@x.y' }]);
  assert.equal(plan.warnings.length, 1);
  // SPEC-record-steps.md §10, verbatim.
  assert.equal(plan.warnings[0], 'Parameter email already exists with a different value; the recorded value was not added.');
});

test('a conflicting value on a secret-named parameter never reaches the warning', () => {
  const text = doc('## Parameters', '- password: hunter2', '', '## Steps', '1. A');
  const { plan } = recordAt(text, '1. A', ['B'], [{ name: 'password', value: '$PASSWORD' }]);
  assert.equal(plan.warnings.length, 1);
  assert.doesNotMatch(plan.warnings[0], /hunter2/);
});

test('secret values travel as $NAME references', () => {
  const text = doc('## Steps', '1. A');
  const { after } = recordAt(text, '1. A', ['Type {{password}} into the Password field'], [{ name: 'password', value: '$PASSWORD' }]);
  assert.match(after, /^## Parameters\n- password: \$PASSWORD\n\n## Steps\n/);
});

test('invalid names and empty values are left out with a warning; duplicates count once', () => {
  const text = doc('## Steps', '1. A');
  const { after, plan } = recordAt(text, '1. A', ['B'], [
    { name: 'bad name', value: 'x' },
    { name: 'empty', value: '  ' },
    { name: 'ok', value: 'one' },
    { name: 'ok', value: 'two' },
  ]);
  assert.match(after, /## Parameters\n- ok: one\n\n/);
  assert.equal(plan.warnings.length, 2);
});

test('an empty ## Parameters section with prose in it gets the bullets after the prose', () => {
  const text = doc('## Parameters', 'Values the test reads.', '', '## Steps', '1. A');
  const { after } = recordAt(text, '1. A', ['B'], [{ name: 'k', value: 'v' }]);
  assert.equal(after, doc('## Parameters', 'Values the test reads.', '- k: v', '', '## Steps', '1. A', '2. B'));
});

test('bullets straight above the next heading keep a blank line before it', () => {
  const text = doc('## Parameters', '- a: 1', '## Steps', '1. A');
  const { after } = recordAt(text, '1. A', ['B'], [{ name: 'b', value: '2' }]);
  assert.equal(after, doc('## Parameters', '- a: 1', '- b: 2', '', '## Steps', '1. A', '2. B'));
});

test('## Parameters is found where the server parser finds it: not in a fence, not in frontmatter, not at depth 3', (t) => {
  const text = doc(
    '---',
    'notes: |',
    '  ## Parameters',
    '---',
    '# T',
    '',
    '```md',
    '## Parameters',
    '- x: 1',
    '```',
    '',
    '### Parameters',
    '- y: 2',
    '',
    '## Steps',
    '1. a',
  );
  const { after, plan } = recordAt(text, '1. a', ['Type {{email}}'], [{ name: 'email', value: 'a@b' }]);
  // None of the three is a section the server reads, so one is created where it will.
  assert.deepEqual(plan.parametersAdded, ['email']);
  assert.match(after, /- y: 2\n\n## Parameters\n- email: a@b\n\n## Steps\n1\. a\n2\. Type \{\{email\}\}$/);
  assert.match(after, /```md\n## Parameters\n- x: 1\n```/, 'the fenced example is untouched');
  const parsed = serverParse(t, after);
  if (parsed) assert.deepEqual(parsed.parameters, { email: 'a@b' });
});

test('existing parameters written with * or + bullets, or numbered, are recognised', (t) => {
  const text = doc('## Parameters', '* email: a@b', '+ user: me', '1. pin: 1234', '', '## Steps', '1. a');
  const { after, plan } = recordAt(text, '1. a', ['B'], [
    { name: 'email', value: 'a@b' },
    { name: 'user', value: 'other' },
    { name: 'pin', value: '1234' },
  ]);
  assert.deepEqual(plan.parametersAdded, []);
  assert.deepEqual(plan.parameterConflicts, [{ name: 'user', existing: 'me', recorded: 'other' }]);
  assert.equal(after, doc('## Parameters', '* email: a@b', '+ user: me', '1. pin: 1234', '', '## Steps', '1. a', '2. B'));
  const parsed = serverParse(t, after);
  if (parsed) assert.deepEqual(parsed.parameters, { email: 'a@b', user: 'me', pin: '1234' });
});

test('a ### heading inside ## Parameters does not end it, and a second ## Parameters counts too', (t) => {
  const text = doc('## Parameters', '- a: 1', '### Logins', '- b: 2', '', '## Parameters', '- c: 3', '', '## Steps', '1. x');
  const { after, plan } = recordAt(text, '1. x', ['Y'], [
    { name: 'b', value: '2' },
    { name: 'c', value: '9' },
    { name: 'd', value: '4' },
  ]);
  assert.deepEqual(plan.parametersAdded, ['d']);
  assert.deepEqual(plan.parameterConflicts, [{ name: 'c', existing: '3', recorded: '9' }]);
  // Added to the FIRST section, after its last item.
  assert.equal(
    after,
    doc('## Parameters', '- a: 1', '### Logins', '- b: 2', '- d: 4', '', '## Parameters', '- c: 3', '', '## Steps', '1. x', '2. Y'),
  );
  const parsed = serverParse(t, after);
  if (parsed) assert.deepEqual(parsed.parameters, { a: '1', b: '2', c: '3', d: '4' });
});

test('recorded values are written exactly; one with a line break is left out, and named', (t) => {
  const text = doc('## Steps', '1. a');
  const { after, plan } = recordAt(text, '1. a', ['B'], [
    { name: 'greeting', value: 'Hello,  two  spaces' },
    { name: 'padded', value: '  trimmed at the ends only  ' },
    { name: 'address', value: '1 Main St\nSpringfield' },
  ]);
  assert.deepEqual(plan.parametersAdded, ['greeting', 'padded']);
  assert.match(after, /^## Parameters\n- greeting: Hello, {2}two {2}spaces\n- padded: trimmed at the ends only\n\n/);
  assert.doesNotMatch(after, /address|Springfield/);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /"address".*line break/);
  const parsed = serverParse(t, after);
  if (parsed) assert.equal(parsed.parameters.greeting, 'Hello,  two  spaces', 'the parser reads back what was recorded');
});

// ---------------------------------------------------------------------------
// The file while recording: each draft replaces the last (the author's
// request, 2026-09-27 — "the steps appear in the test after every action")
// ---------------------------------------------------------------------------

const EMPTY = { steps: [], parameters: [] };

/** What a one-shot insertion of `draft` into `text` reads as — the reference
 *  every live write must match. */
const oneShot = (text, anchor, draft) => {
  const plan = planRecordInsertion(text, { anchor, ...draft });
  assert.ok(!('error' in plan), plan.error);
  return applyRecordEdits(text, plan.edits);
};

/**
 * Write `drafts` one after another into `text`, as the extension does: each
 * against the document as the last one left it, carrying the slots. Returns
 * the document after each draft, and the live record (its slots current).
 */
function writeDrafts(text, anchor, drafts, live = beginLiveRecord(text, anchor)) {
  assert.ok(!('error' in live), live.error);
  let cur = text;
  const after = [];
  for (const draft of drafts) {
    const w = liveRecordWrite(live, cur, draft);
    assert.ok(!('error' in w), w.error);
    assert.equal(applyOffsetEdits(cur, w.edits), w.text, 'the edits make the text the write reports');
    cur = w.text;
    Object.assign(live, w.record);
    // Every slot holds what this draft put there.
    for (const slot of w.slots) {
      if (slot.kind === 'block') assert.equal(cur.slice(slot.start, slot.end), w.plan?.parts.block ?? '');
      if (slot.kind === 'params') assert.equal(cur.slice(slot.start, slot.end), w.plan?.parts.params ?? '');
      if (slot.kind === 'tail') assert.match(cur.slice(slot.start, slot.end), /^\d+$/);
    }
    after.push(cur);
  }
  return { live, after, text: cur };
}

/** A change as VS Code reports one, in offsets: `text` replaces `length` chars at `offset`. */
const offsetChange = (offset, length, text) => ({ offset, length, text });
/** Apply one author change to `text` and carry `live`'s slots through it. */
function authorEdit(text, live, c) {
  const tracked = trackRecordSlots(live.slots, [c]);
  live.slots = tracked.slots;
  return { text: text.slice(0, c.offset) + c.text + text.slice(c.offset + c.length), touched: tracked.touched };
}

const anchorAt = (text, needle, nth = 0) => {
  const lines = text.split(/\r?\n/);
  let idx = -1;
  for (let i = 0, seen = 0; i < lines.length; i++) {
    if (lines[i] === needle && seen++ === nth) {
      idx = i;
      break;
    }
  }
  assert.ok(idx >= 0, `fixture has no line ${JSON.stringify(needle)}`);
  const cursor = resolveRecordCursor(text, idx + 1);
  assert.equal(cursor.ok, true, cursor.reason);
  return { ...cursor.anchor, tracked: true };
};

test('live drafts: each one reads as that draft alone would, and the empty draft restores the file exactly', () => {
  // The model grows the draft, then rewrites its last steps (Click Menu +
  // Payments became one step), then adds a parameter and a step.
  const d1 = { steps: ['Click Menu'], parameters: [] };
  const d2 = { steps: ['Click Payments in the main menu', 'Type {{password}} into the Password field'], parameters: [{ name: 'password', value: '$PASSWORD' }] };
  const d3 = {
    steps: ['Click Payments in the main menu', 'Type {{password}} into the Password field', 'Type {{amount}} into Amount', 'Click Pay'],
    parameters: [{ name: 'password', value: '$PASSWORD' }, { name: 'amount', value: '10' }, { name: 'email', value: 'demo@securebank.com' }],
  };
  const cases = [
    ['main flow', SAMPLE, anchorAt(SAMPLE, '2. Sign in')],
    ['section body', SAMPLE, anchorAt(SAMPLE, '1. Type {{email}} into the Email field')],
    ['the blank line under ## Steps (ahead of step 1)', doc('## Steps', '', '1. Old first', '2. Old second', ''), anchorAt(doc('## Steps', '', '1. Old first', '2. Old second', ''), '')],
    ['after a data table', doc('# T', '', '## Steps', '', '| user |', '| --- |', '| a |', ''), { line: 3, text: '## Steps', kind: 'heading', section: null, tracked: true }],
    ['a table that ends the file', doc('## Steps', '', '| a |', '| - |', '| 1 |'), null],
    ['a section table before the next section', doc('# T', '', '## Steps', '1. Log in', '', '### Log in', '', '| user |', '| --- |', '| a |', '', '### Other', '1. X', ''), { line: 6, text: '### Log in', kind: 'heading', section: 'Log in', tracked: true }],
    ['1.-style numbering', doc('## Steps', '1. A', '1. B', '1. C'), anchorAt(doc('## Steps', '1. A', '1. B', '1. C'), '1. B')],
    ['the last line, no final line break', doc('## Parameters', '- q: 1', '## Steps', '1. A', '2. B'), anchorAt(doc('## Parameters', '- q: 1', '## Steps', '1. A', '2. B'), '2. B')],
    ['CRLF, ## Parameters created', doc('# T', '', '## Steps', '1. A', '2. B', '').replace(/\n/g, '\r\n'), anchorAt(doc('# T', '', '## Steps', '1. A', '2. B', '').replace(/\n/g, '\r\n'), '1. A')],
    ['Record New Test (no anchor)', newTestSkeleton({ title: 'Pay by cash', baseUrl: 'http://localhost:8787/' }).text, null],
  ];
  for (const [name, text, anchor] of cases) {
    const { after } = writeDrafts(text, anchor, [d1, d2, d3, EMPTY]);
    assert.equal(after[0], oneShot(text, anchor, d1), `${name}: d1`);
    assert.equal(after[1], oneShot(text, anchor, d2), `${name}: d2`);
    assert.equal(after[2], oneShot(text, anchor, d3), `${name}: d3`);
    assert.equal(after[3], text, `${name}: the empty draft restores the file byte for byte`);
    // And straight to d3, with no drafts before it, is the same file.
    assert.equal(writeDrafts(text, anchor, [d3]).text, after[2], `${name}: d3 alone`);
  }
});

test('live drafts: a ## Parameters section the recording created is removed again by the empty draft', () => {
  const text = doc('# T', '', '## Config', '- baseUrl: x', '', '## Steps', '1. A', '');
  const anchor = anchorAt(text, '1. A');
  const withParam = { steps: ['Type {{email}} into Email'], parameters: [{ name: 'email', value: 'a@b.c' }] };
  const { after } = writeDrafts(text, anchor, [withParam, { steps: ['Click Next'], parameters: [] }, withParam, EMPTY]);
  assert.equal(after[0], doc('# T', '', '## Config', '- baseUrl: x', '', '## Parameters', '- email: a@b.c', '', '## Steps', '1. A', '2. Type {{email}} into Email', ''));
  // A draft that no longer needs the parameter takes the section back out.
  assert.equal(after[1], doc('# T', '', '## Config', '- baseUrl: x', '', '## Steps', '1. A', '2. Click Next', ''));
  assert.equal(after[2], after[0]);
  assert.equal(after[3], text);
});

test('live drafts: a draft that shrinks (the model merged steps) renumbers the rest of the flow for its new length', () => {
  const text = doc('## Steps', '1. Open', '2. Sign in', '3. Pay', '4. Sign out', '', '### S', '1. X');
  const anchor = anchorAt(text, '2. Sign in');
  const { after } = writeDrafts(text, anchor, [
    { steps: ['Click Menu', 'Click Payments', 'Tick Cash'], parameters: [] },
    { steps: ['Click Payments in the main menu'], parameters: [] },
    { steps: [], parameters: [] },
  ]);
  assert.equal(after[0], doc('## Steps', '1. Open', '2. Sign in', '3. Click Menu', '4. Click Payments', '5. Tick Cash', '6. Pay', '7. Sign out', '', '### S', '1. X'));
  assert.equal(after[1], doc('## Steps', '1. Open', '2. Sign in', '3. Click Payments in the main menu', '4. Pay', '5. Sign out', '', '### S', '1. X'));
  assert.equal(after[2], text);
});

test('live drafts: the empty draft writes back each later ordinal as the file had it, not as a renumber would', () => {
  // Out-of-sequence numbers are the author's; a recording that ends with
  // nothing must not "fix" them.
  const text = doc('## Steps', '1. A', '2. B', '7. C', '9. D');
  const anchor = anchorAt(text, '1. A');
  const { after } = writeDrafts(text, anchor, [{ steps: ['New'], parameters: [] }, EMPTY]);
  assert.equal(after[0], doc('## Steps', '1. A', '2. New', '3. B', '4. C', '5. D'));
  assert.equal(after[1], text);
});

test('live drafts: edits the author makes elsewhere stay, and the block follows them', () => {
  const text = SAMPLE;
  const anchor = anchorAt(text, '2. Sign in');
  const d1 = { steps: ['Click Menu'], parameters: [{ name: 'password', value: '$PASSWORD' }] };
  const d2 = { steps: ['Click Payments in the main menu', 'Tick Cash'], parameters: [{ name: 'password', value: '$PASSWORD' }] };
  const run = writeDrafts(text, anchor, [d1]);
  let cur = run.text;
  // A line typed under the title (above everything the recording wrote)…
  let r = authorEdit(cur, run.live, offsetChange(cur.indexOf('\n') + 1, 0, 'Written while recording.\n'));
  assert.equal(r.touched, false);
  cur = r.text;
  // …a typo fixed in the anchor step itself…
  r = authorEdit(cur, run.live, offsetChange(cur.indexOf('Sign in\n3.') + 'Sign in'.length, 0, ' as demo'));
  assert.equal(r.touched, false);
  cur = r.text;
  // …and a word changed in a later step (not its number).
  r = authorEdit(cur, run.live, offsetChange(cur.indexOf('Open Payments') + 5, 8, 'the payments page'));
  assert.equal(r.touched, false);
  cur = r.text;
  const next = writeDrafts(cur, anchor, [d2, EMPTY], run.live);
  const edited = (t) =>
    t.replace('# Pay by cash\n', '# Pay by cash\nWritten while recording.\n').replace('2. Sign in\n', '2. Sign in as demo\n').replace('Open Payments', 'Open the payments page');
  assert.equal(next.after[0], edited(oneShot(text, anchor, d2)));
  assert.equal(next.after[1], edited(text), 'the empty draft takes out only what the recording wrote');
});

test('live drafts: an edit inside the recorded lines is reported, and the next draft writes over it', () => {
  const text = SAMPLE;
  const anchor = anchorAt(text, '2. Sign in');
  const d1 = { steps: ['Click Menu', 'Tick Cash'], parameters: [] };
  const run = writeDrafts(text, anchor, [d1]);
  const at = run.text.indexOf('Tick Cash');
  const r = authorEdit(run.text, run.live, offsetChange(at, 4, 'Untick'));
  assert.equal(r.touched, true);
  assert.match(r.text, /4\. Untick Cash/);
  // Typing in the middle of a recorded line is inside it too.
  const r2 = authorEdit(r.text, run.live, offsetChange(r.text.indexOf('Click Menu') + 'Click Menu'.length, 0, ' twice'));
  assert.equal(r2.touched, true);
  assert.match(r2.text, /3\. Click Menu twice\n4\. Untick Cash/);
  const next = writeDrafts(r2.text, anchor, [d1], run.live);
  assert.equal(next.text, oneShot(text, anchor, d1), 'the draft is back as the model wrote it');
  // A new step typed as a whole line at the block's start goes above it,
  // outside the recording, and is kept.
  const blockStart = next.text.indexOf('3. Click Menu');
  const above = authorEdit(next.text, next.live, offsetChange(blockStart, 0, '2b. mine\n'));
  assert.equal(above.touched, false);
  assert.equal(writeDrafts(above.text, anchor, [EMPTY], next.live).text, text.replace('2. Sign in\n', '2. Sign in\n2b. mine\n'));
});

test('live drafts: a later step the author deletes is not renumbered again; the rest still are', () => {
  const text = doc('## Steps', '1. A', '2. B', '3. C', '4. D');
  const anchor = anchorAt(text, '1. A');
  const run = writeDrafts(text, anchor, [{ steps: ['New'], parameters: [] }]);
  assert.equal(run.text, doc('## Steps', '1. A', '2. New', '3. B', '4. C', '5. D'));
  const lineC = run.text.indexOf('4. C');
  const r = authorEdit(run.text, run.live, offsetChange(lineC, '4. C\n'.length, ''));
  assert.equal(r.touched, false);
  assert.equal(r.text, doc('## Steps', '1. A', '2. New', '3. B', '5. D'));
  // Unplaced rather than forgotten: its line is looked for again, exactly, at
  // every write — and it is gone, so it is never written.
  assert.equal(run.live.slots.filter((s) => s.kind === 'tail' && s.placed !== false).length, 2, 'C\'s ordinal is no longer the recording\'s');
  const next = writeDrafts(r.text, anchor, [{ steps: ['New', 'Newer'], parameters: [] }, EMPTY], run.live);
  assert.equal(next.after[0], doc('## Steps', '1. A', '2. New', '3. Newer', '4. B', '6. D'));
  assert.equal(next.after[1], doc('## Steps', '1. A', '2. B', '4. D'));
});

test('slot edges: whole lines at the block\'s start go above it; typing at the start of the line after it is that line\'s', () => {
  const text = doc('## Steps', '1. A', '2. B', '');
  const anchor = anchorAt(text, '1. A');
  const run = writeDrafts(text, anchor, [{ steps: ['New'], parameters: [] }]);
  assert.equal(run.text, doc('## Steps', '1. A', '2. New', '3. B', ''));
  const block = () => run.live.slots.find((s) => s.kind === 'block');
  const { start, end } = block();
  assert.equal(run.text.slice(start, end), '2. New\n');
  // Typing at the start of the first recorded line is inside it.
  assert.equal(trackRecordSlots(run.live.slots, [offsetChange(start, 0, 'x')]).touched, true);
  // Whole lines inserted there go above it.
  const above = trackRecordSlots(run.live.slots, [offsetChange(start, 0, 'x\n')]);
  assert.equal(above.touched, false);
  assert.equal(above.slots.find((s) => s.kind === 'block').start, start + 2);
  // Typing where the block ends is on the next line — which is `3. B`: typed
  // in front of its number, which makes that line the author's, not the block's.
  const atEnd = trackRecordSlots(run.live.slots, [offsetChange(end, 0, 'y')]);
  assert.equal(atEnd.touched, false);
  assert.deepEqual(atEnd.slots.find((s) => s.kind === 'block'), block());
  // A block that ends the file (no final line break) ends mid-line: typing
  // there extends the last recorded line.
  const bare = doc('## Steps', '1. A');
  const run2 = writeDrafts(bare, anchorAt(bare, '1. A'), [{ steps: ['New'], parameters: [] }]);
  assert.equal(run2.text, doc('## Steps', '1. A', '2. New'));
  assert.equal(trackRecordSlots(run2.live.slots, [offsetChange(run2.text.length, 0, '!')]).touched, true);
  // …while typing at the end of the anchor line, where that block starts, is not.
  assert.equal(trackRecordSlots(run2.live.slots, [offsetChange(bare.length, 0, '!')]).touched, false);
});

test('the recorded lines: the block\'s steps and the added parameters, not the blank lines between', () => {
  const text = doc('# T', '', '## Steps', '1. Log in', '', '### Log in', '', '| user |', '| --- |', '| a |', '### Other', '1. X', '');
  const run = writeDrafts(text, { line: 6, text: '### Log in', kind: 'heading', section: 'Log in', tracked: true }, [
    { steps: ['Type {{user}}', 'Click Go'], parameters: [{ name: 'user', value: 'a' }] },
  ]);
  const lines = run.text.split('\n');
  assert.deepEqual(
    recordedLines(run.text, run.live.slots).map((i) => lines[i]),
    ['## Parameters', '- user: a', '1. Type {{user}}', '2. Click Go'],
  );
  assert.deepEqual(recordedLines(run.text, run.live.slots, ['block']).map((i) => lines[i]), ['1. Type {{user}}', '2. Click Go']);
  assert.deepEqual(recordedLines(text, beginLiveRecord(text, null).slots), [], 'nothing written, nothing highlighted');
});

// ---------------------------------------------------------------------------
// Record New Test
// ---------------------------------------------------------------------------

test('the new-file skeleton: title, Config with baseUrl, empty Parameters, Steps; cursor under Steps', () => {
  const s = newTestSkeleton({ title: 'Pay by cash', baseUrl: 'http://localhost:8787/' });
  assert.equal(
    s.text,
    doc('# Pay by cash', '', '## Config', '- baseUrl: http://localhost:8787/', '', '## Parameters', '', '## Steps', ''),
  );
  assert.equal(s.cursorLine, 9);
  assert.equal(resolveRecordCursor(s.text, s.cursorLine).ok, true);
  // No baseUrl known: the section stays, empty, for the author to fill.
  assert.equal(newTestSkeleton({ title: 'T', baseUrl: null }).text, doc('# T', '', '## Config', '', '## Parameters', '', '## Steps', ''));
});

test('test names: safe file names only, .md optional, a title derived', () => {
  assert.deepEqual(validateNewTestName(' pay-by-cash '), { ok: true, fileName: 'pay-by-cash.md', title: 'Pay by Cash' });
  assert.deepEqual(validateNewTestName('Checkout.MD'), { ok: true, fileName: 'Checkout.md', title: 'Checkout' });
  for (const bad of ['', '   ', '.md', 'a/b', 'a\\b', 'a:b', 'a?', '-x', 'x.', 'CON', 'lpt1.md', 'x'.repeat(101)]) {
    assert.equal(validateNewTestName(bad).ok, false, JSON.stringify(bad));
  }
  // Title case (SPEC-record-steps.md §7.2): short joining words stay lower-case
  // in the middle; the author's own capitals stay.
  assert.equal(titleFromName('record_new.tmp'), 'Record New Tmp');
  assert.equal(titleFromName('the-way-in'), 'The Way In');
  assert.equal(titleFromName('sign-in-to-the-API'), 'Sign in to the API');
});

test('baseUrl inference: the active test first, else the most common, raw', () => {
  const t = (url) => doc('## Config', `- baseUrl: ${url}`, '', '## Steps', '1. A');
  assert.equal(inferBaseUrl([t('a'), t('b'), t('b')]), 'b');
  assert.equal(inferBaseUrl([t('a'), t('b')]), 'a');
  assert.equal(inferBaseUrl([t('b'), t('b')], 'mine'), 'mine');
  assert.equal(inferBaseUrl([t('$APP_URL')]), '$APP_URL');
  assert.equal(inferBaseUrl([doc('## Steps', '1. A')]), null);
});

test('the new test directory: config tests.dir, else the server default beside the config, else the testsGlob prefix, else the workspace', () => {
  const root = path.resolve('/ws');
  const config = path.resolve('/ws/app/aiui.config.json');
  assert.deepEqual(
    newTestDir({ configPath: config, configTestsDir: path.resolve('/ws/app/e2e'), testsGlob: 'specs/**/*.md', workspaceRoot: root }),
    { dir: path.resolve('/ws/app/e2e'), source: 'config' },
  );
  // A project that declares no tests.dir has the server's default, ./tests
  // beside its config (src/config/defaults.ts) — not the glob's prefix.
  assert.deepEqual(newTestDir({ configPath: config, configTestsDir: null, testsGlob: 'specs/**/*.md', workspaceRoot: root }), {
    dir: path.resolve('/ws/app/tests'),
    source: 'config-default',
  });
  assert.deepEqual(newTestDir({ configPath: null, configTestsDir: null, testsGlob: 'tests/**/*.md', workspaceRoot: root }), {
    dir: path.resolve('/ws/tests'),
    source: 'glob',
  });
  assert.deepEqual(newTestDir({ configPath: null, configTestsDir: null, testsGlob: '**/*.md', workspaceRoot: root }), {
    dir: root,
    source: 'workspace',
  });
  // A tests.dir outside the workspace is refused, and says where it points.
  const outside = newTestDir({
    configPath: config,
    configTestsDir: path.resolve('/elsewhere/tests'),
    testsGlob: '**/*.md',
    workspaceRoot: root,
  });
  assert.ok('refused' in outside);
  assert.match(outside.refused, /outside this workspace/);
  assert.ok(outside.refused.includes(path.resolve('/elsewhere/tests')));
  const climbing = newTestDir({ configPath: config, configTestsDir: path.resolve('/ws/../x'), testsGlob: '**/*.md', workspaceRoot: root });
  assert.ok('refused' in climbing);
  assert.equal(globStaticPrefix('./specs/ui/**/*.md'), 'specs/ui');
  assert.equal(globStaticPrefix('tests\\*.md'), 'tests');
  assert.equal(globStaticPrefix('{a,b}/**/*.md'), '');
  assert.equal(globStaticPrefix('../elsewhere/*.md'), '');
  assert.equal(globStaticPrefix('C:/abs/*.md'), '');
});

test('the projects inside a workspace: a shallow search that skips dependencies, build output and dot-folders', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-projects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel) => {
    const file = path.join(root, ...rel.split('/'), 'aiui.config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    return file;
  };
  // None: the testsGlob fallback's case.
  fs.mkdirSync(path.join(root, 'docs'));
  assert.deepEqual(findProjectConfigs(root), []);
  // One, in a subfolder — the case the walk up from an editor never reaches.
  const app = put('app');
  for (const skipped of ['node_modules/pkg', 'dist', '.git', '.live-shards/w1/templates/init', '.vscode-test/x', '.claude/worktrees/wt']) {
    put(skipped);
  }
  assert.deepEqual(findProjectConfigs(root), [app]);
  // Several, shallowest first; three levels down is found, four is not.
  const deep = put('packages/web/e2e');
  put('packages/web/e2e/too-deep');
  const b = put('b');
  assert.deepEqual(findProjectConfigs(root), [app, b, deep]);
  assert.deepEqual(findProjectConfigs(root, { maxDepth: 1 }), [app, b]);
  // A missing folder is none, not a throw.
  assert.deepEqual(findProjectConfigs(path.join(root, 'nope')), []);
});

test('panel and status bar text', () => {
  assert.equal(formatRecordTime(0), '0:00');
  assert.equal(formatRecordTime(65_400), '1:05');
  assert.equal(formatRecordTime(NaN), '0:00');
  const a = (dropped) => ({ dropped });
  assert.equal(recordingStatusText({ phase: 'recording', actions: [a(false), a(true), a(false)] }), 'Recording — 2 actions');
  assert.equal(recordingStatusText({ phase: 'recording', actions: [a(false)] }), 'Recording — 1 action');
  assert.equal(recordingStatusText({ phase: 'finishing', actions: [] }), 'Finishing…');
});

test('the panel copies of the time and heading text match the core (recording-panel.js)', async () => {
  const inline = await import('../src/webview/lib/recording-panel.js');
  for (const ms of [0, 999, 1000, 59_999, 60_000, 65_400, 3_600_000, -5, NaN]) {
    assert.equal(inline.formatRecordTimeInline(ms), formatRecordTime(ms), String(ms));
  }
  const a = (dropped) => ({ dropped });
  for (const state of [
    { phase: 'starting', actions: [] },
    { phase: 'recording', actions: [] },
    { phase: 'recording', actions: [a(false)] },
    { phase: 'recording', actions: [a(false), a(true), a(false)] },
    { phase: 'recording', actions: [a(false), { dropped: false, action: false }, { dropped: false, action: true }] },
    { phase: 'finishing', actions: [a(false)] },
  ]) {
    assert.equal(inline.recordingStatusTextInline(state), recordingStatusText(state), JSON.stringify(state));
  }
});

test('notification text from the page or the model cannot make a link', () => {
  // VS Code's notification link grammar (vs/base/common/linkedText.ts): only
  // `[text](target)` with the two brackets adjacent becomes a link.
  const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
  for (const note of [
    'Click [here](command:workbench.action.quit) to continue.',
    'See [the docs](https://evil.test/) and [more]  (file:///c:/x).',
    '[a](command:x "title")',
  ]) {
    const plain = plainNotificationText(note);
    assert.equal(plain.match(LINK), null, plain);
    // The words are all still there.
    assert.equal(plain.replace(/\s+/g, ''), note.replace(/\s+/g, ''));
  }
  assert.equal(plainNotificationText('Recorded 2 steps into t.md.'), 'Recorded 2 steps into t.md.');
});

test('a result that could not be inserted, as text to paste: numbered steps, parameters above them', () => {
  assert.equal(
    recordedStepsText(
      ['Navigate to login.html', '  3. Type {{email}}  into Email ', ''],
      [{ name: 'email', value: 'a@b' }, { name: 'address', value: '1 Main St\nSpringfield' }, { name: '', value: 'x' }],
    ),
    doc(
      '## Parameters',
      '- email: a@b',
      '- address: "1 Main St\\nSpringfield"',
      '',
      '## Steps',
      '1. Navigate to login.html',
      '2. Type {{email}} into Email',
    ),
  );
  assert.equal(recordedStepsText(['Click Pay'], []), doc('## Steps', '1. Click Pay'));
});

// ---------------------------------------------------------------------------
// The Recording block, frame by frame (decision 9: steps drafted live)
// ---------------------------------------------------------------------------

const fresh = () => newRecordingState({ uri: 'file:///t.md', file: 't.md', mode: 'cursor' });

test('a fresh block is starting, with no actions, no draft and nothing drafting', () => {
  assert.deepEqual(fresh(), {
    uri: 'file:///t.md',
    file: 't.md',
    mode: 'cursor',
    phase: 'starting',
    pickArmed: false,
    actions: [],
    draft: null,
    drafting: false,
  });
});

test('started, actions and picks fold in; an action restated keeps its ✕', () => {
  const s = fresh();
  assert.equal(applyRecordFrame(s, { type: 'record:started', url: 'https://x/', title: 'X' }), true);
  assert.equal(s.phase, 'recording');
  assert.equal(s.startedUrl, 'https://x/');
  applyRecordFrame(s, { type: 'record:action', id: 'a1', kind: 'click', action: true, summary: 'Clicked A', atMs: 10 });
  // Typing is an EVENT that rides with the next action (decision 4).
  applyRecordFrame(s, { type: 'record:action', id: 'a2', kind: 'type', action: false, summary: 'Typed', atMs: 20, tab: 'popup-1' });
  s.actions[0].dropped = true;
  // A frame with no flag reads as an action — what every frame meant before it.
  applyRecordFrame(s, { type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked A (again)', atMs: 10 });
  assert.deepEqual(s.actions, [
    { id: 'a1', kind: 'click', action: true, summary: 'Clicked A (again)', atMs: 10, dropped: true },
    { id: 'a2', kind: 'type', action: false, summary: 'Typed', atMs: 20, tab: 'popup-1', dropped: false },
  ]);
  // "N actions" counts actions — not events, not dropped ones.
  applyRecordFrame(s, { type: 'record:action', id: 'a3', kind: 'drag', action: true, summary: 'Dragged', atMs: 30 });
  assert.equal(recordingStatusText(s), 'Recording — 1 action');
  applyRecordFrame(s, { type: 'record:pick', armed: true });
  assert.equal(s.pickArmed, true);
  assert.equal(applyRecordFrame(s, { type: 'record:action', summary: 'no id' }), false);
});

test('an action before record:started still moves the block to recording', () => {
  const s = fresh();
  applyRecordFrame(s, { type: 'record:action', id: 'a1', kind: 'click', summary: 'x', atMs: 0 });
  assert.equal(s.phase, 'recording');
});

test('record:drafting is the updating marker, on and off', () => {
  const s = fresh();
  assert.equal(applyRecordFrame(s, { type: 'record:drafting', busy: true }), true);
  assert.equal(s.drafting, true);
  applyRecordFrame(s, { type: 'record:drafting', busy: false });
  assert.equal(s.drafting, false);
});

test('each newer draft REPLACES the list whole — rewritten steps are not merged', () => {
  const s = fresh();
  applyRecordFrame(s, {
    type: 'record:draft',
    revision: 1,
    steps: ['Navigate to login.html', 'Click Menu'],
    parameters: [],
    through: 'a2',
  });
  assert.deepEqual(s.draft, { revision: 1, steps: ['Navigate to login.html', 'Click Menu'], parameters: [], notes: [], through: 'a2' });
  // The next action changed what the last one meant: `Click Menu` + Payments
  // is one step now, and the list shrinks rather than growing a stale line.
  assert.equal(
    applyRecordFrame(s, {
      type: 'record:draft',
      revision: 2,
      steps: ['Navigate to login.html', 'Click Payments in the main menu'],
      parameters: [{ name: 'email', value: 'a@b' }],
      notes: ['Two clicks were one menu choice.'],
      through: 'a3',
    }),
    true,
  );
  assert.deepEqual(s.draft, {
    revision: 2,
    steps: ['Navigate to login.html', 'Click Payments in the main menu'],
    parameters: [{ name: 'email', value: 'a@b' }],
    notes: ['Two clicks were one menu choice.'],
    through: 'a3',
  });
});

test('a draft whose revision is not newer is ignored', () => {
  const s = fresh();
  applyRecordFrame(s, { type: 'record:draft', revision: 3, steps: ['Three'], parameters: [] });
  assert.equal(applyRecordFrame(s, { type: 'record:draft', revision: 2, steps: ['Two'], parameters: [] }), false);
  assert.equal(applyRecordFrame(s, { type: 'record:draft', revision: 3, steps: ['Three again'], parameters: [] }), false);
  assert.equal(applyRecordFrame(s, { type: 'record:draft', steps: ['no revision'], parameters: [] }), false);
  assert.deepEqual(s.draft.steps, ['Three']);
  assert.equal(applyRecordFrame(s, { type: 'record:draft', revision: 4, steps: ['Four'], parameters: [] }), true);
  assert.deepEqual(s.draft.steps, ['Four']);
});

test('draft step texts are cleaned like the result: one line, no number, no blanks', () => {
  const s = fresh();
  applyRecordFrame(s, {
    type: 'record:draft',
    revision: 1,
    steps: ['1. Click   Go', '', '  Tick\nCash '],
    parameters: [{ name: ' q ', value: 'v' }, { name: '', value: 'x' }],
    notes: ['', 'kept'],
  });
  assert.deepEqual(s.draft.steps, ['Click Go', 'Tick Cash']);
  assert.deepEqual(s.draft.parameters, [{ name: 'q', value: 'v' }]);
  assert.deepEqual(s.draft.notes, ['kept']);
});

test('record:writing is Finishing…: pick mode drops, the draft and actions stay', () => {
  const s = fresh();
  applyRecordFrame(s, { type: 'record:started', url: 'u', title: '' });
  applyRecordFrame(s, { type: 'record:action', id: 'a1', kind: 'click', summary: 'x', atMs: 0 });
  applyRecordFrame(s, { type: 'record:draft', revision: 1, steps: ['Click X'], parameters: [] });
  applyRecordFrame(s, { type: 'record:pick', armed: true });
  applyRecordFrame(s, { type: 'record:writing' });
  assert.equal(s.phase, 'finishing');
  assert.equal(s.pickArmed, false);
  assert.equal(recordingStatusText(s), 'Finishing…');
  // An action can still arrive after Stop, until record:writing — and even a
  // late one joins the list without undoing Finishing….
  applyRecordFrame(s, { type: 'record:action', id: 'a2', kind: 'type', summary: 'y', atMs: 5 });
  assert.equal(s.phase, 'finishing');
  assert.equal(s.actions.length, 2);
  assert.deepEqual(s.draft.steps, ['Click X']);
});

test('frames that are not the block\'s business change nothing', () => {
  const s = fresh();
  for (const type of ['output', 'record:result', 'done', 'record:crop']) {
    assert.equal(applyRecordFrame(s, { type }), false, type);
  }
  assert.deepEqual(s, fresh());
});
