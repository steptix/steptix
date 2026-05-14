// Unit coverage for the shared step parser (SPEC-FLICK.md "Step Input & Parsing").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps } from '../../src/shared/parse-steps';

test('plain lines become one step each', () => {
  assert.deepEqual(parseSteps('Navigate to facebook.com\nClick the login button'), [
    'Navigate to facebook.com',
    'Click the login button',
  ]);
});

test('numbered list prefixes are stripped', () => {
  assert.deepEqual(
    parseSteps('1. Navigate to facebook.com\n2. Click the login button\n3) Submit'),
    ['Navigate to facebook.com', 'Click the login button', 'Submit'],
  );
});

test('dashed list prefixes are stripped', () => {
  assert.deepEqual(parseSteps('- Navigate to facebook.com\n- Click the login button'), [
    'Navigate to facebook.com',
    'Click the login button',
  ]);
});

test('empty and whitespace-only lines are ignored', () => {
  assert.deepEqual(parseSteps('\n  \nNavigate\n\n   \nClick\n'), ['Navigate', 'Click']);
});

test('handles CRLF line endings', () => {
  assert.deepEqual(parseSteps('Navigate\r\nClick'), ['Navigate', 'Click']);
});

test('quoted content inside a step is preserved', () => {
  assert.deepEqual(parseSteps('Enter "user@example.com" in the email field'), [
    'Enter "user@example.com" in the email field',
  ]);
});

test('empty input yields no steps', () => {
  assert.deepEqual(parseSteps(''), []);
  assert.deepEqual(parseSteps('   \n  \n'), []);
});
