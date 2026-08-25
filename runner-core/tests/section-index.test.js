/**
 * `buildSectionIndex` — the whole-document view the authoring affordances and
 * the run-time pre-flight are both built on.
 *
 * The match-table rows are the frozen cross-package specification
 * (stories/test-script-sections-contract.md §2, fixtures/sections/match-table.json).
 * Every row is asserted twice: once against `matchText` directly, and — where
 * the row is expressible as a real document — once end to end, by building a
 * document and checking whether the call actually resolved. The second form
 * is what catches an index that derives its keys differently from the way it
 * derives its lookups.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSectionIndex } from '../dist/section-index.js';
import { matchText, sectionNameError } from '../dist/section-match.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'sections',
);
const read = (name) => readFileSync(path.join(FIXTURES, name), 'utf-8');
const matchTable = JSON.parse(read('match-table.json'));

// ---------------------------------------------------------------------------
// The frozen match table
// ---------------------------------------------------------------------------

for (const row of matchTable.rows) {
  test(`matchText: ${row.name}`, () => {
    assert.equal(matchText(row.sectionName), row.expectedMatchText.name);
    assert.equal(matchText(row.stepRawText), row.expectedMatchText.step);
    assert.equal(
      matchText(row.sectionName) === matchText(row.stepRawText),
      row.matches,
      row.why,
    );
  });

  // Rows flagged `documentExpressible: false` pin the derivation only — they
  // describe inputs list parsing can never produce (leading whitespace) or a
  // name parsing refuses ('[' prefix).
  if (row.documentExpressible === false) continue;

  test(`buildSectionIndex: ${row.name}`, () => {
    const text = ['## Steps', `1. ${row.stepRawText}`, '', `### ${row.sectionName}`, '1. Body'].join(
      '\n',
    );
    const index = buildSectionIndex(text);
    const called = index.calls.some((c) => c.line === 2);
    assert.equal(called, row.matches, row.why);
    // The complement must hold too: a step is a call or a non-call, never
    // both and never neither.
    assert.equal(
      index.nonCallSteps.some((s) => s.line === 2),
      !row.matches,
    );
  });
}

// ---------------------------------------------------------------------------
// Definitions, duplicates, empty names
// ---------------------------------------------------------------------------

test('indexes the shared fixture: one call, one dead section, no duplicates', () => {
  const index = buildSectionIndex(read('classification.md'));

  assert.deepEqual([...index.sections.keys()], ['login', 'cleanup']);
  assert.deepEqual(index.sections.get('login'), {
    name: 'Login',
    headingLine: 20,
    stepCount: 2,
  });
  assert.deepEqual(index.sections.get('cleanup'), {
    name: 'Cleanup',
    headingLine: 31,
    stepCount: 1,
  });

  // Line 17 is `2. Login` in the main flow. Nothing calls Cleanup — the
  // liveness rule the dead-section warning and the "never used" diagnostic
  // both read off this.
  assert.deepEqual(index.calls, [{ line: 17, name: 'Login', nameStart: 3 }]);
  assert.deepEqual(index.duplicates, []);

  const called = new Set(index.calls.map((c) => matchText(c.name)));
  assert.deepEqual(
    [...index.sections.keys()].filter((k) => !called.has(k)),
    ['cleanup'],
  );
});

test('empty-name headings never enter `sections`, and all land in `duplicates`', () => {
  const index = buildSectionIndex(read('classification-hashes.md'));
  assert.equal(index.sections.size, 0);
  assert.deepEqual(index.duplicates, [
    { name: '', headingLine: 10 },
    { name: '', headingLine: 14 },
    { name: '', headingLine: 18 },
  ]);
});

test('first definition wins; the loser is reported rather than vanishing', () => {
  const text = [
    '## Steps',
    '1. Login',
    '',
    '### Login',
    '1. First body',
    '',
    '### LOGIN',
    '1. Second body',
  ].join('\n');
  const index = buildSectionIndex(text);

  assert.equal(index.sections.size, 1);
  assert.equal(index.sections.get('login').headingLine, 4);
  assert.deepEqual(index.duplicates, [{ name: 'LOGIN', headingLine: 7 }]);
});

test('a call reports the DEFINITION casing, not the call site casing', () => {
  // Consumers use `name` to look the section back up and to label it in the
  // call stack, so it must be what the author named the section.
  const text = ['## Steps', '1. LOGIN', '', '### Login As Admin', '1. Body'].join('\n');
  assert.deepEqual(buildSectionIndex(text).calls, []);

  const text2 = ['## Steps', '1. LOGIN', '', '### Login', '1. Body'].join('\n');
  assert.deepEqual(buildSectionIndex(text2).calls, [{ line: 2, name: 'Login', nameStart: 3 }]);
});

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------

test('body lines are call sites too — a section may call a section', () => {
  const text = [
    '## Steps',
    '1. Outer',
    '',
    '### Outer',
    '1. Inner',
    '',
    '### Inner',
    '1. Do the thing',
  ].join('\n');
  const index = buildSectionIndex(text);
  assert.deepEqual(index.calls, [
    { line: 2, name: 'Outer', nameStart: 3 },
    { line: 5, name: 'Inner', nameStart: 3 },
  ]);
});

test('a call site inside a never-invoked section still counts as a call', () => {
  // Liveness is a flat textual scan (contract §2.4): Inner is invoked, even
  // though the only thing invoking it is itself dead. Both the expander's
  // dead-section warning and the authoring diagnostic read this rule, and
  // they are asserted to agree.
  const text = [
    '## Steps',
    '1. Something else',
    '',
    '### Dead',
    '1. Inner',
    '',
    '### Inner',
    '1. Do the thing',
  ].join('\n');
  const index = buildSectionIndex(text);
  const called = new Set(index.calls.map((c) => matchText(c.name)));
  assert.equal(called.has('inner'), true);
  assert.deepEqual(
    [...index.sections.keys()].filter((k) => !called.has(k)),
    ['dead'],
  );
});

// ---------------------------------------------------------------------------
// Wrapped list items (the shared `stepWrapsAt` whitelist)
// ---------------------------------------------------------------------------

/**
 * A markdown list item may span several lines; the CLI matches on the item's
 * whole text, while this index sees only its first line. Reading that first
 * line alone would draw a link the runtime never follows.
 *
 * `tests/section-index-cli-parity.test.ts` at the repo root fuzzes these
 * against the real CLI parser — that is what proves the rule, rather than
 * these rows, which pin the individual shapes.
 */
const wrapped = (after) =>
  ['## Steps', '', '1. Login', ...after, '', '### Login', '', '1. Type'].join('\n');
const isCall = (after) => buildSectionIndex(wrapped(after)).calls.some((c) => c.line === 3);

test('a wrapped call site is not a call: indented continuation', () => {
  assert.equal(isCall(['   and then confirm']), false);
});

test('a wrapped call site is not a call: lazy (unindented) continuation', () => {
  assert.equal(isCall(['and then confirm']), false);
});

test('a wrapped call site is not a call: blank then indented continuation', () => {
  // The one that defeats a naive "is the next line prose?" check.
  assert.equal(isCall(['', '   and then confirm']), false);
});

test('a wrapped call site is not a call: nested bullet', () => {
  assert.equal(isCall(['   - detail']), false);
});

test('an unwrapped call site IS a call', () => {
  assert.equal(isCall([]), true, 'end of document');
  assert.equal(isCall(['2. Next']), true, 'followed by a step');
  assert.equal(isCall(['', '2. Next']), true, 'blank then a step');
  assert.equal(isCall(['#### Note']), true, 'followed by a heading');
  // A blank line then UNINDENTED prose starts a new block outside the list,
  // so the item ended — this must stay a call, or ordinary prose between
  // steps would silently break every call site above it.
  assert.equal(isCall(['', 'Some prose.']), true, 'blank then unindented prose');
});

test('the frozen fixture call site survives the wrapped-item rule', () => {
  // classification.md line 17 is `2. Login`, followed directly by another
  // step. A rule that over-refused would break the fixture's only call.
  assert.deepEqual(buildSectionIndex(read('classification.md')).calls, [
    { line: 17, name: 'Login', nameStart: 3 },
  ]);
});

test('nameStart points past the ordinal and past a [no-hooks] marker', () => {
  const text = [
    '## Steps',
    '1. Login',
    '10. Login',
    '3. [no-hooks] Login',
    '4. [NO-HOOKS]Login',
    '',
    '### Login',
    '1. Body',
  ].join('\n');
  const index = buildSectionIndex(text);
  assert.deepEqual(
    index.calls.map((c) => [c.line, c.nameStart]),
    [
      [2, 3], // "1. "            → column 3
      [3, 4], // "10. "           → column 4
      [4, 14], // "3. [no-hooks] " → column 14
      [5, 13], // "4. [NO-HOOKS]"  → column 13, the marker's \s* matched zero
    ],
  );
  // The columns are not just plausible — they land exactly on the name.
  const lines = text.split('\n');
  for (const call of index.calls) {
    assert.equal(lines[call.line - 1].slice(call.nameStart), 'Login');
  }
});

test('bracket directives are neither calls nor non-calls', () => {
  // A step claimed by a bracket parser can never be a section call, and must
  // not be offered as a near-miss for one either — otherwise
  // `1. [skill: login]` warns about a section named Login.
  const text = [
    '## Steps',
    '1. [skill: login]',
    '2. [tool: click selector="#go"]',
    '3. [input: username]',
    '4. [interactive]',
    '5. [no-hooks] [skill: login]',
    '6. [something unknown]',
    '',
    '### Login',
    '1. Body',
  ].join('\n');
  const index = buildSectionIndex(text);
  assert.deepEqual(index.calls, []);
  // Only the section's own body step remains — body lines are scanned like
  // any other, which is what makes a section calling a section a call site.
  assert.deepEqual(index.nonCallSteps, [{ line: 10, matchText: 'body', nameStart: 3 }]);
});

test('a bracket-ish step that is NOT a known directive is also excluded', () => {
  // The documented cost of `DIRECTIVE_STEP_RE` being `/^\[/` rather than the
  // four named tokens: `1. [note] Login` is neither a call nor a near-miss.
  // Pinned so the trade-off is visible rather than discovered later.
  const text = ['## Steps', '1. [note] Login', '2. [Login]', '', '### Login', '1. Body'].join('\n');
  const index = buildSectionIndex(text);
  assert.deepEqual(index.calls, []);
  assert.deepEqual(index.nonCallSteps, [{ line: 6, matchText: 'body', nameStart: 3 }]);
});

test('near-misses land in nonCallSteps with their derived match text', () => {
  const text = [
    '## Steps',
    '1. Login.',
    '2. **Login**',
    '3. Login',
    '',
    '### Login',
    '1. Body',
  ].join('\n');
  const index = buildSectionIndex(text);
  // Line 4 (`3. Login`) is the only real call; the period and the bold are
  // near-misses, which is the whole point of keeping them separately.
  assert.deepEqual(
    index.calls.map((c) => c.line),
    [4],
  );
  assert.deepEqual(index.nonCallSteps, [
    { line: 2, matchText: 'login.', nameStart: 3 },
    { line: 3, matchText: '**login**', nameStart: 3 },
    { line: 7, matchText: 'body', nameStart: 3 },
  ]);
});

test('a marker-only step is neither a call nor a non-call', () => {
  const text = ['## Steps', '1. [no-hooks]', '2. Login', '', '### Login', '1. Body'].join('\n');
  const index = buildSectionIndex(text);
  assert.deepEqual(
    index.calls.map((c) => c.line),
    [3],
  );
  // Line 2 (`1. [no-hooks]`) carries no text at all, so it is neither; line 6
  // is the section's own body step.
  assert.deepEqual(index.nonCallSteps, [{ line: 6, matchText: 'body', nameStart: 3 }]);
});

test('a sectionless file still fills nonCallSteps — consumers must gate on sections.size', () => {
  // Worth stating plainly because the shape is a trap: with no sections
  // defined, EVERY step is a "non-call". A near-miss diagnostic that iterates
  // nonCallSteps without first checking `sections.size > 0` would light up
  // every step of every existing test in the repo.
  const text = ['## Steps', '1. Open the page', '2. Click Sign in'].join('\n');
  const index = buildSectionIndex(text);
  assert.equal(index.sections.size, 0);
  assert.deepEqual(index.calls, []);
  assert.deepEqual(index.duplicates, []);
  assert.equal(index.nonCallSteps.length, 2);
});

// ---------------------------------------------------------------------------
// Name validation (contract §2.5) — shared with the pre-flight + diagnostics
// ---------------------------------------------------------------------------

test('sectionNameError: the reserved list, case-insensitively', () => {
  for (const name of ['Steps', 'steps', 'CONFIG', 'Parameters', 'Outputs', 'Hooks']) {
    assert.match(sectionNameError(name) ?? '', /reserved section keyword/i, name);
  }
});

test('sectionNameError: bracket prefix, interpolation, empty', () => {
  assert.match(sectionNameError('[skill: x]') ?? '', /may not begin with/i);
  assert.match(sectionNameError('Login {{user}}') ?? '', /may not contain/i);
  assert.match(sectionNameError('') ?? '', /empty name/i);
  assert.match(sectionNameError('   ') ?? '', /empty name/i);
});

test('sectionNameError: null for a legal name', () => {
  assert.equal(sectionNameError('Login as admin'), null);
  assert.equal(sectionNameError('İşlem'), null);
  assert.equal(sectionNameError('**Login**'), null);
});
