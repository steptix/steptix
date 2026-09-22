/**
 * The editor's half of `[use computer]` / `[use browser]`
 * (docs/specs/SPEC-use-computer.md §10.3): the squiggles, the bracket
 * completion, and the F11 line classification.
 *
 * Each of the three is a DECISION extracted from its vscode-coupled provider,
 * the split `section-diagnostics-core.ts` established — so what is asserted
 * here is what the provider will do, not a paraphrase of it.
 *
 * Parity with the runtime is NOT asserted here: `tests/use-step-parity.test.ts`
 * at the repo root owns that, because it is the only suite that can import
 * `src/parser` and `runner-core/src` at once. What this file pins is that the
 * editor surfaces reach the mirror at all — an affordance wired to nothing
 * passes a parity test and helps nobody.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeSectionDiagnostics } from '../src/extension/section-diagnostics-core.ts';
import {
  classifyDebuggableLine,
  useDirectiveCompletions,
} from '../src/extension/invocation-target-core.ts';

const doc = (...lines) => lines.join('\n');
const errors = (text) =>
  computeSectionDiagnostics(text).filter((d) => d.severity === 'error');

// ---------------------------------------------------------------------------
// §4.1 / §4.2 as squiggles
// ---------------------------------------------------------------------------

test('a malformed surface switch squiggles, with the runtime wording', () => {
  const text = doc('# T', '', '## Steps', '1. Click Save', '2. [use phone]');
  const [row, ...rest] = errors(text);
  assert.deepEqual(rest, []);
  assert.equal(row.line, 4); // 0-based: the fifth line
  assert.equal(row.startCol, '2. '.length);
  assert.equal(row.endCol, '2. [use phone]'.length);
  assert.ok(row.message.includes('`phone` is not a surface'), row.message);
  assert.ok(row.message.includes('`[use computer]`'), row.message);
});

test('each of the four §4.1 refusals reaches the editor', () => {
  for (const [instruction, phrase] of [
    ['[use]', 'names no surface'],
    ['[use phone]', 'is not a surface'],
    ['[use computer timeout=30]', 'takes no arguments'],
    ['[use computer] and click Save', 'is the whole step'],
  ]) {
    const text = doc('# T', '', '## Steps', `1. ${instruction}`);
    const rows = errors(text);
    assert.equal(rows.length, 1, instruction);
    assert.ok(rows[0].message.includes(phrase), `${instruction}: ${rows[0].message}`);
  }
});

test('§4.2 an invented whole-step bracket squiggles with a did-you-mean', () => {
  const text = doc('# T', '', '## Steps', '1. [computer]');
  const rows = errors(text);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].message.includes('Did you mean `[use computer]`?'), rows[0].message);
});

test('a `### Section` body is squiggled too, not just the main flow', () => {
  const text = doc(
    '# T',
    '',
    '## Steps',
    '1. Desktop excursion',
    '',
    '### Desktop excursion',
    '1. [use phone]',
    '2. Click Save',
  );
  const rows = errors(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 6);
  assert.ok(rows[0].message.includes('is not a surface'));
});

test('the well-formed directives are silent, and so is prose with a bracket', () => {
  for (const instruction of [
    '[use computer]',
    '[use browser]',
    '[use: browser]',
    '[no-hooks] [use computer]',
    '[skill: login]',
    '[interactive]',
    'Verify the [optional] banner',
    '[skillful] navigation is expected',
    'Click the Save button',
  ]) {
    const text = doc('# T', '', '## Steps', `1. ${instruction}`, '2. Done');
    assert.deepEqual(errors(text), [], instruction);
  }
});

test('the `[use …]` message wins over the generic directive list', () => {
  // Both rules see `[use]`. The order is the CLI parser's, and it is what
  // decides whether the author is told the two surfaces or handed a list of
  // six directives.
  const rows = errors(doc('# T', '', '## Steps', '1. [use]'));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].message.includes('names no surface'), rows[0].message);
});

test('a WRAPPED step is left to the run-time parse error', () => {
  // The CLI judges the whole list item; reading only the first physical line
  // would squiggle `[use computer]` on an item whose real text carries
  // trailing words — a refusal the runtime does not make.
  const text = doc(
    '# T',
    '',
    '## Steps',
    '1. [use computer]',
    '   and then click Save',
  );
  assert.deepEqual(errors(text), []);
});

test('a non-test document gets nothing', () => {
  assert.deepEqual(computeSectionDiagnostics('# Notes\n\n1. [use phone]\n'), []);
});

// ---------------------------------------------------------------------------
// The bracket completion
// ---------------------------------------------------------------------------

test('the completion offers both tokens, computer first, each a legal step', () => {
  const rows = useDirectiveCompletions();
  assert.deepEqual(
    rows.map((r) => r.token),
    ['[use computer]', '[use browser]'],
  );
  for (const row of rows) {
    assert.equal(row.detail, 'surface switch');
    assert.ok(row.documentation.length > 0, row.token);
    // The point of deriving the rows from `USE_SURFACES`: what is offered is
    // what the grammar accepts, so an accepted completion can never be a
    // §4.1 refusal.
    assert.deepEqual(errors(doc('# T', '', '## Steps', `1. ${row.token}`)), [], row.token);
  }
});

// ---------------------------------------------------------------------------
// F11
// ---------------------------------------------------------------------------

test('a surface switch is a non-steppable line for F11', () => {
  // `'use'` arms neither `pauseAtNextTool` nor `pauseAtNextCodeBehind` — all
  // three call sites test for `'tool'` and `'plain'` — so F11 falls through to
  // the ordinary step command on a line that has no "into".
  for (const line of [
    '3. [use computer]',
    '10. [use browser]',
    '  4. [use: computer]',
    '5. [no-hooks] [use computer]',
    '[use computer]',
  ]) {
    assert.equal(classifyDebuggableLine(line), 'use', line);
  }
});

test('…and the other three kinds are unchanged', () => {
  assert.equal(classifyDebuggableLine('3. [tool: echo value="hi"]'), 'tool');
  assert.equal(classifyDebuggableLine('3. [skill: login]'), 'skill');
  assert.equal(classifyDebuggableLine('3. Click the Save button'), 'plain');
  // A malformed switch is NOT a switch: it never runs, so it keeps the plain
  // treatment rather than being quietly excused from stepping.
  assert.equal(classifyDebuggableLine('3. [use phone]'), 'plain');
});
