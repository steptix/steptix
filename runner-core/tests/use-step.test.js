/**
 * The client-side mirrors of `[use computer]` / `[use browser]` (§4.1) and of
 * the unknown-whole-step-bracket rule (§4.2), in their own right.
 *
 * That the mirror AGREES with `src/parser` is pinned elsewhere, by
 * `tests/use-step-parity.test.ts` at the repo root — that suite can import
 * both sides, this one cannot import `src/` at all. What is asserted here is
 * what the extension actually asks of runner-core: which lines paint as a
 * directive, which squiggle and with what text, and that `USE_SURFACES` is the
 * list the bracket completion is built from.
 *
 * Against `dist/`, like every other file in this directory, because that is
 * what the extension bundles.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isUseStepClaim,
  parseUseStep,
  useStepError,
  USE_SURFACES,
} from '../dist/use-step.js';
import {
  closestDirective,
  isKnownWholeStepDirective,
  isWholeStepBracket,
  unknownWholeStepBracketError,
  KNOWN_WHOLE_STEP_DIRECTIVES,
} from '../dist/whole-step-bracket.js';

test('the two forms parse, colon optional, case and whitespace tolerated', () => {
  for (const [line, surface] of [
    ['[use computer]', 'computer'],
    ['[use browser]', 'browser'],
    ['[use: browser]', 'browser'],
    ['[USE COMPUTER]', 'computer'],
    ['   [use  browser ]   ', 'browser'],
    ['[use\tcomputer]', 'computer'],
    ['[no-hooks] [use computer]', 'computer'],
  ]) {
    assert.deepEqual(parseUseStep(line), { surface }, line);
    assert.equal(useStepError(line), null, line);
  }
});

test('USE_SURFACES is the closed set the completion is built from', () => {
  // The extension maps this into `[use <surface>]` rows rather than typing the
  // two tokens out, so a dropdown can never offer a spelling the grammar
  // refuses.
  assert.deepEqual([...USE_SURFACES], ['computer', 'browser']);
  for (const surface of USE_SURFACES) {
    assert.deepEqual(parseUseStep(`[use ${surface}]`), { surface });
  }
});

test('the four §4.1 refusals each name the fault and point at it', () => {
  for (const [line, phrase] of [
    ['[use]', 'names no surface'],
    ['[use phone]', '`phone` is not a surface'],
    ['[use computer timeout=30]', 'takes no arguments'],
    ['[use computer] and click Save', 'is the whole step'],
  ]) {
    const message = useStepError(line, ' at line 3');
    assert.ok(message, line);
    assert.ok(message.includes(phrase), `${line}: ${message}`);
    assert.ok(message.includes(' at line 3'), line);
    // The `formatMessage` shape: reason, the source line, a caret under it.
    const [, source, caret] = message.split('\n');
    assert.equal(source, `  ${line}`);
    assert.match(caret, /^ *\^$/);
    assert.ok(caret.length - 3 < line.length, `${line}: caret past the line`);
    assert.ok(isUseStepClaim(line), line);
    assert.equal(parseUseStep(line), null, line);
  }
});

test('prose stays prose — the claim is anchored and needs a separator', () => {
  for (const line of [
    'Click the Save button',
    'Verify the [use of cookies] banner is shown',
    '[used]',
    '[user guide]',
    '[use-computer]',
    '[skill: login]',
    '[interactive]',
    '',
  ]) {
    assert.equal(isUseStepClaim(line), false, line);
    assert.equal(parseUseStep(line), null, line);
    assert.equal(useStepError(line), null, line);
  }
});

test('§4.2 an invented whole-step bracket is refused, with the list and a guess', () => {
  const message = unknownWholeStepBracketError('[computer]', ' at line 3');
  assert.ok(message);
  assert.ok(message.includes('Cannot parse the step "[computer]" at line 3'));
  assert.ok(message.includes('Did you mean `[use computer]`?'), message);
  for (const directive of KNOWN_WHOLE_STEP_DIRECTIVES) {
    assert.ok(message.includes(`\`${directive}\``), `message omits ${directive}`);
  }
});

test('§4.2 leaves a bracket inside a longer step alone', () => {
  for (const line of [
    '[skillful] navigation is expected',
    'Verify the [optional] banner',
    '[a] [b]',
    'Click Save',
  ]) {
    assert.equal(isWholeStepBracket(line), false, line);
    assert.equal(unknownWholeStepBracketError(line), null, line);
  }
});

test('§4.2 knows the real directives, `[use …]` included', () => {
  for (const line of [
    '[skill: login]',
    '[skill login]',
    '[tool: echo]',
    '[input: pin]',
    '[interactive]',
    '[use computer]',
    // A malformed `[use …]` is KNOWN here on purpose: `useStepError` owns it,
    // so the author is told the two surfaces rather than handed the list.
    '[use]',
    '[use phone]',
    '[output: total]',
    '[store as: total]',
  ]) {
    assert.equal(isKnownWholeStepDirective(line), true, line);
    assert.equal(unknownWholeStepBracketError(line), null, line);
  }
});

test('§4.2 says nothing rather than guessing wrongly', () => {
  assert.equal(closestDirective('[dekstop]'), null);
  const message = unknownWholeStepBracketError('[dekstop]');
  assert.ok(message);
  assert.ok(!message.includes('Did you mean'), message);
  assert.ok(message.includes('`[use browser]`'), message);
});
