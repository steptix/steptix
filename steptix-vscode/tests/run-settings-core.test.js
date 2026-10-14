/**
 * `steptix.highlight` → `runSettings.highlight`
 * (docs/specs/SPEC-interaction-highlight.md §7.2).
 *
 * The server retains run settings per session, so what a batch must send
 * depends on what the session was sent before: an override is cleared only by
 * an explicit `default`, and a `default` nobody needs is not sent at all, so
 * an older server never sees a key it would refuse.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { highlightRunSettings, readHighlightSetting } from '../src/extension/run-settings-core.ts';

test('readHighlightSetting: on and off as written, anything else is default', () => {
  assert.equal(readHighlightSetting('on'), 'on');
  assert.equal(readHighlightSetting('off'), 'off');
  assert.equal(readHighlightSetting('default'), 'default');
  assert.equal(readHighlightSetting(undefined), 'default');
  assert.equal(readHighlightSetting('ON'), 'default');
  assert.equal(readHighlightSetting(true), 'default');
});

test('highlightRunSettings: an override is always sent', () => {
  assert.deepEqual(highlightRunSettings('on', undefined), { highlight: 'on' });
  assert.deepEqual(highlightRunSettings('on', 'on'), { highlight: 'on' });
  assert.deepEqual(highlightRunSettings('off', 'on'), { highlight: 'off' });
});

test('highlightRunSettings: default clears an override the session was sent', () => {
  assert.deepEqual(highlightRunSettings('default', 'on'), { highlight: 'default' });
  assert.deepEqual(highlightRunSettings('default', 'off'), { highlight: 'default' });
});

test('highlightRunSettings: default with nothing to clear sends nothing', () => {
  assert.equal(highlightRunSettings('default', undefined), undefined);
  assert.equal(highlightRunSettings('default', 'default'), undefined);
});
