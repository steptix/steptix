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
import * as path from 'node:path';
import {
  CURSOR_REFUSALS,
  applyRecordEdits,
  applyRecordFrame,
  newRecordingState,
  cleanStepText,
  formatRecordTime,
  globStaticPrefix,
  inferBaseUrl,
  newTestDir,
  newTestSkeleton,
  planRecordInsertion,
  recordingStatusText,
  resolveRecordCursor,
  titleFromName,
  validateNewTestName,
} from '../src/extension/record-steps-core.ts';

const doc = (...lines) => lines.join('\n');
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
  // `1.`-everywhere lists are common; the walk continues from what is written.
  const text = doc('## Steps', '1. A', '1. B', '1. C');
  const { after } = recordAt(text, '1. B', ['New']);
  assert.equal(after, doc('## Steps', '1. A', '1. B', '2. New', '3. C'));
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
// The document changed while recording
// ---------------------------------------------------------------------------

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

test('the new test directory: config tests.dir, else the testsGlob prefix, else the workspace', () => {
  const root = path.resolve('/ws');
  assert.deepEqual(newTestDir({ configTestsDir: path.resolve('/ws/e2e'), testsGlob: 'tests/**/*.md', workspaceRoot: root }), {
    dir: path.resolve('/ws/e2e'),
    source: 'config',
  });
  assert.deepEqual(newTestDir({ configTestsDir: null, testsGlob: 'tests/**/*.md', workspaceRoot: root }), {
    dir: path.resolve('/ws/tests'),
    source: 'glob',
  });
  assert.deepEqual(newTestDir({ configTestsDir: null, testsGlob: '**/*.md', workspaceRoot: root }), { dir: root, source: 'workspace' });
  assert.equal(globStaticPrefix('./specs/ui/**/*.md'), 'specs/ui');
  assert.equal(globStaticPrefix('tests\\*.md'), 'tests');
  assert.equal(globStaticPrefix('{a,b}/**/*.md'), '');
  assert.equal(globStaticPrefix('../elsewhere/*.md'), '');
  assert.equal(globStaticPrefix('C:/abs/*.md'), '');
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
