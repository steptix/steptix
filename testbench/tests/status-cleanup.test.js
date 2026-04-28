import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { clearRunningStatuses } from '../src/webview/lib/status-cleanup.js';

test('clearRunningStatuses: removes RUNNING entries', () => {
  const got = clearRunningStatuses({ 5: 'running' });
  assert.deepEqual(got, {});
});

test('clearRunningStatuses: keeps pass / fail / skip', () => {
  const input = { 1: 'pass', 2: 'fail', 3: 'skip', 4: 'running' };
  assert.deepEqual(clearRunningStatuses(input), { 1: 'pass', 2: 'fail', 3: 'skip' });
});

test('clearRunningStatuses: returns a new object (does not mutate input)', () => {
  const input = { 1: 'running', 2: 'pass' };
  const got = clearRunningStatuses(input);
  assert.notEqual(got, input);
  assert.deepEqual(input, { 1: 'running', 2: 'pass' });
});

test('clearRunningStatuses: empty input → empty output', () => {
  assert.deepEqual(clearRunningStatuses({}), {});
});

test('clearRunningStatuses: keeps numeric line keys intact', () => {
  const got = clearRunningStatuses({ 14: 'running', 15: 'pass' });
  assert.deepEqual(got, { 15: 'pass' });
});
