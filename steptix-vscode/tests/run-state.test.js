/**
 * What a saved `.steptix/run-state.json` restores as.
 *
 * The rules live in run-state-core.ts (pure, no VS Code) so this suite can pin
 * them: `ActiveFileTracker.hydrate` imports `vscode`, and a status file written
 * by an older build is exactly the input a fresh integration workspace never
 * has.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { restoredStatuses } from '../src/extension/run-state-core.ts';

test('a pass-cached line written by an older build restores as a plain pass', () => {
  // The step cache and its ⚡ mark are gone; the step it marked did pass.
  // Kept as `pass-cached` it would match no decoration and the line would
  // restore blank — a pass the run really had, silently lost.
  assert.deepEqual(restoredStatuses([[5, 'pass-cached']]), [[5, 'pass']]);
});

test('running is dropped: no run is in flight after a reload', () => {
  assert.deepEqual(restoredStatuses([[3, 'running'], [4, 'pass']]), [[4, 'pass']]);
});

test('every current status passes through unchanged, in order', () => {
  const current = [
    [1, 'pass'],
    [2, 'pass-code-behind'],
    [3, 'pass-stale'],
    [4, 'fail'],
    [5, 'fail-tolerated'],
    [6, 'skip'],
    [7, 'stopped'],
  ];
  assert.deepEqual(restoredStatuses(current), current);
});

test('a status this build does not know is kept as written, not dropped', () => {
  // The union is widened by adding a status; a file from a NEWER build must
  // not lose its lines just because this one cannot paint them.
  assert.deepEqual(restoredStatuses([[9, 'pass-from-the-future']]), [[9, 'pass-from-the-future']]);
});

test('a status spelled like an Object.prototype member is kept as written too', () => {
  // A plain `map[status]` lookup answers these with inherited functions, which
  // then serialise as null and lose the line on the next save.
  assert.deepEqual(
    restoredStatuses([[1, 'constructor'], [2, 'toString'], [3, '__proto__']]),
    [[1, 'constructor'], [2, 'toString'], [3, '__proto__']],
  );
});
