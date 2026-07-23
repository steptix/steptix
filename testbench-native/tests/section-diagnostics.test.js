/**
 * Section diagnostics — the while-typing safety net.
 *
 * The provider needs a VS Code host, but the DECISION (which rows fire, where,
 * at what severity) is pure and lives in `computeSectionDiagnostics`. That is
 * what these assert, so every table row is covered under `node --test`.
 *
 * The near-miss row is the only heuristic; every other row restates a parse or
 * expansion error, and the "never used" row must agree with the expander's
 * dead-section warning exactly — both consume the same flat liveness rule from
 * `buildSectionIndex`.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  computeSectionDiagnostics,
  editDistance,
} from '../src/extension/section-diagnostics-core.ts';

const doc = (...lines) => lines.join('\n');
const bySeverity = (text, sev) =>
  computeSectionDiagnostics(text).filter((d) => d.severity === sev);

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'sections',
);
const readFixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf-8');

// ---------------------------------------------------------------------------
// Nothing to report
// ---------------------------------------------------------------------------

test('a clean sectioned file produces no diagnostics', () => {
  const text = doc('## Steps', '1. Login', '', '### Login', '1. Type the username');
  assert.deepEqual(computeSectionDiagnostics(text), []);
});

test('a file with no sections produces no diagnostics', () => {
  assert.deepEqual(computeSectionDiagnostics(doc('## Steps', '1. One', '2. Two')), []);
});

test('a non-test file produces no diagnostics', () => {
  assert.deepEqual(computeSectionDiagnostics('# Just prose\n\nNo steps here.'), []);
});

// ---------------------------------------------------------------------------
// Errors that mirror parse / expansion failures
// ---------------------------------------------------------------------------

test('duplicate name → error on the losing heading', () => {
  const text = doc(
    '## Steps', '1. Login', '',
    '### Login', '1. A', '',
    '### LOGIN', '1. B',
  );
  const errors = bySeverity(text, 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Duplicate section "LOGIN"/);
  assert.equal(errors[0].line, 6, 'anchored to the SECOND definition, line 7 (0-based 6)');
});

test('reserved name → error', () => {
  const errors = bySeverity(doc('## Steps', '1. C', '', '### Steps', '1. A'), 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /reserved section keyword/i);
});

test('bracket-prefixed and interpolated names → error', () => {
  assert.match(
    bySeverity(doc('## Steps', '1. C', '', '### [skill: x]', '1. A'), 'error')[0].message,
    /may not begin with/i,
  );
  assert.match(
    bySeverity(doc('## Steps', '1. C', '', '### Login {{u}}', '1. A'), 'error')[0].message,
    /may not contain/i,
  );
});

test('empty-name heading (bare ###) → error, with a visible range', () => {
  const text = doc('## Steps', '1. Open', '', '###', '', '1. Body');
  const errors = bySeverity(text, 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /empty name/i);
  assert.equal(errors[0].line, 3);
  // A bare `###` has no text after the hashes, so anchoring past them would be
  // a zero-width (invisible) squiggle — fall back to underlining the hashes.
  assert.equal(errors[0].startCol, 0);
  assert.equal(errors[0].endCol, 3);
});

test('an empty-body section that is ALSO uncalled reports only the empty-body error', () => {
  // The section must be uncalled for the suppression to matter — if a step
  // called it, "never used" wouldn't fire anyway and the test couldn't tell
  // the suppression from that. `Orphan` is empty AND never invoked, so both
  // an empty-body Error and a "never used" Info are eligible; only the
  // actionable Error should show.
  const text = doc(
    '## Steps', '1. Login', '',
    '### Login', '1. A', '',
    '### Orphan', '',
    '## Outputs', '- x',
  );
  const emptyBody = bySeverity(text, 'error').filter((e) => /has no steps/i.test(e.message));
  assert.equal(emptyBody.length, 1);
  assert.match(emptyBody[0].message, /"Orphan"/);
  assert.deepEqual(bySeverity(text, 'information'), [], 'no "never used" piled onto an empty body');
});

test('invoked section with no steps → error', () => {
  const text = doc('## Steps', '1. Empty', '', '### Empty', '', '## Outputs', '- x');
  const errors = bySeverity(text, 'error');
  assert.ok(errors.some((e) => /has no steps/i.test(e.message)));
});

test('an invalid name is reported once, not also as "never used"', () => {
  // A section named `Steps` is both reserved AND (being reserved) never a
  // legal call target — but stacking two diagnostics on it is noise.
  const text = doc('## Steps', '1. C', '', '### Steps', '1. A');
  const infos = bySeverity(text, 'information');
  assert.deepEqual(infos, [], 'no "never used" on an already-invalid name');
});

// ---------------------------------------------------------------------------
// Liveness — must match the expander's flat rule
// ---------------------------------------------------------------------------

test('a section nothing calls → information "never used"', () => {
  const text = doc('## Steps', '1. Login', '', '### Login', '1. A', '', '### Cleanup', '1. B');
  const infos = bySeverity(text, 'information');
  assert.equal(infos.length, 1);
  assert.match(infos[0].message, /Section "Cleanup" is never used/);
});

test('a section called only from ANOTHER (even dead) section is live', () => {
  // Flat rule: any call site anywhere counts, including one inside a
  // never-invoked section. `Helper` is called only from `Dead`, which is
  // itself never called — but `Helper` is still live.
  const text = doc(
    '## Steps', '1. Something', '',
    '### Dead', '1. Helper', '',
    '### Helper', '1. Do it',
  );
  const dead = bySeverity(text, 'information').map((d) => d.message);
  assert.ok(dead.some((m) => /Dead.*never used/.test(m)), 'Dead is genuinely uninvoked');
  assert.ok(!dead.some((m) => /Helper.*never used/.test(m)), 'Helper is called from Dead');
});

test('the shared classification fixture reports exactly its dead section', () => {
  // classification.md defines Login (called) and Cleanup (never). The frozen
  // fixture records `expectedDeadSections: ["Cleanup"]`; the diagnostic must
  // agree, or the editor and the run-time warning have diverged.
  const frozen = JSON.parse(readFixture('classification.json')).files['classification.md'];
  const infos = bySeverity(readFixture('classification.md'), 'information')
    .filter((d) => /never used/.test(d.message));
  const named = infos.map((d) => d.message.match(/"([^"]+)"/)[1]);
  assert.deepEqual(named, frozen.expectedDeadSections);
});

// ---------------------------------------------------------------------------
// Near-miss — the one heuristic
// ---------------------------------------------------------------------------

test('a single close typo → warning "Did you mean", squiggling the step text', () => {
  const text = doc('## Steps', '1. Logn', '', '### Login', '1. Type');
  const warnings = bySeverity(text, 'warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Did you mean section "Login"\?/);
  assert.equal(warnings[0].line, 1);
  // The underline covers the match text, not the `N. ` prefix — `Logn` starts
  // at column 3 and runs to end of line. The column is the user-visible
  // payload of the whole feature, so pin it.
  assert.equal(warnings[0].startCol, 3);
  assert.equal(warnings[0].endCol, '1. Logn'.length);
});

test('near-miss does not fire when TWO section names are equally close', () => {
  // "Logan" is distance 1 from both "Login" and "Logon" — ambiguous, so the
  // conservative rule stays silent rather than guess.
  const text = doc(
    '## Steps', '1. Logan', '',
    '### Login', '1. A', '',
    '### Logon', '1. B',
  );
  assert.deepEqual(bySeverity(text, 'warning'), []);
});

test('near-miss does not fire on a genuinely different instruction', () => {
  const text = doc('## Steps', '1. Navigate to the checkout page', '', '### Login', '1. Type');
  assert.deepEqual(bySeverity(text, 'warning'), []);
});

test('near-miss ignores casing and whitespace (those are not a "typo")', () => {
  // `LOGIN` resolves as a call (distance 0 after casefolding), so it is not a
  // non-call and cannot be a near-miss.
  const text = doc('## Steps', '1. LOGIN', '', '### Login', '1. Type');
  assert.deepEqual(computeSectionDiagnostics(text), []);
});

test('a bracket-token line is never a near-miss', () => {
  // `1. [login]` is within edit distance 2 of `### Login` (the brackets are
  // two edits), so the exclusion is LOAD-BEARING here — without it this would
  // warn. `[skill: login]` would be distance 3 and pass whether or not the
  // exclusion existed, which is why this uses the tighter form.
  assert.ok(editDistance('[login]', 'login') <= 2, 'the fixture must actually be within range');
  const text = doc('## Steps', '1. [login]', '', '### Login', '1. Type', '', '### Other', '1. call Login');
  const warnings = bySeverity(text, 'warning').map((d) => d.message);
  assert.deepEqual(warnings, [], 'a bracket line must not be offered a near-miss');
});

test('near-miss does NOT suggest a section whose own name is invalid', () => {
  // `Setps` is distance 1 from the reserved name `Steps`. Suggesting it would
  // send the author to rename a step to a reserved word — a second error. The
  // near-miss candidate set skips invalid names, matching the liveness loop.
  const text = doc('## Steps', '1. Setps', '', '### Steps', '1. A');
  assert.deepEqual(bySeverity(text, 'warning'), [], 'no near-miss to a reserved name');
});

// ---------------------------------------------------------------------------
// editDistance
// ---------------------------------------------------------------------------

test('editDistance: basics and the cap', () => {
  assert.equal(editDistance('login', 'login'), 0);
  assert.equal(editDistance('logn', 'login'), 1); // one insertion
  assert.equal(editDistance('lgoin', 'login'), 2); // one transposition = 2 edits
  assert.equal(editDistance('login', 'logon'), 1); // one substitution
  // Beyond the cap it may return any value > 2; only the threshold matters.
  assert.ok(editDistance('login', 'checkout') > 2);
  // Length gap alone exceeds the cap without scanning.
  assert.ok(editDistance('a', 'abcd') > 2);
});
