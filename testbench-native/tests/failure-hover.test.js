/**
 * Failure hovers — what the ✗ and ⚠ marks say about a step's error.
 *
 * The wording lives in failure-hover-core.ts (pure, no VS Code) precisely so
 * this suite can pin it: the hover is where a failed code-behind's error
 * surfaces in the editor, and a regression here silently sends the user back
 * to scrolling the run log.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  failHoverMessage,
  staleHoverMessage,
  STALE_HOVER_MESSAGE,
} from '../src/extension/failure-hover-core.ts';

const CB = { file: '/p/tests/booking.steps.ts', error: 'locator resolved to 2 elements' };

test('⚠ with no detail falls back to the static text (older persisted state)', () => {
  assert.equal(staleHoverMessage(), STALE_HOVER_MESSAGE);
  assert.equal(staleHoverMessage({}), STALE_HOVER_MESSAGE);
});

test('⚠ with a detail leads with the actual crash, names the file, keeps the Repair hint', () => {
  const hover = staleHoverMessage({ codeBehindStale: CB });
  assert.match(hover, /its compiled code-behind threw:/);
  assert.match(hover, /locator resolved to 2 elements/);
  assert.match(hover, /booking\.steps\.ts/);
  // The action line must survive the dynamic variant — it is what makes the
  // ⚠ actionable at all (see the STALE_HOVER_MESSAGE contract test in the
  // integration suite).
  assert.match(hover, /Repair this step/);
  assert.match(hover, /re-runs this step in the current session/);
});

test('✗ from the step\'s own code-behind says so', () => {
  const hover = failHoverMessage({
    error: 'the confirmation banner never appeared',
    fromCodeBehind: true,
  });
  assert.match(hover, /code-behind failed:/);
  assert.match(hover, /the confirmation banner never appeared/);
});

test('✗ after a failed heal shows BOTH errors — the crash and the AI failure', () => {
  const hover = failHoverMessage({
    error: 'AI could not find the button either',
    codeBehindStale: CB,
  });
  assert.match(hover, /code-behind threw/);
  assert.match(hover, /locator resolved to 2 elements/);
  assert.match(hover, /booking\.steps\.ts/);
  assert.match(hover, /AI could not find the button either/);
});

test('✗ with a plain AI failure stays a plain failure', () => {
  const hover = failHoverMessage({ error: 'no such button' });
  assert.match(hover, /This step failed:/);
  assert.match(hover, /no such button/);
  assert.doesNotMatch(hover, /code-behind/);
});

test('long errors are clipped so the hover stays a hover', () => {
  const hover = failHoverMessage({ error: 'x'.repeat(5000) });
  assert.ok(hover.length < 1200, `hover is ${hover.length} chars`);
  assert.match(hover, /…/);
});

test('a fence inside the error cannot break out of the hover\'s code block', () => {
  const hover = failHoverMessage({ error: 'before ``` after' });
  assert.doesNotMatch(hover, /before ``` after/);
  assert.match(hover, /before ''' after/);
});
