import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isHostMsg, isRunEvent, isWebviewMsg } from '../dist/protocol.js';

test('isHostMsg: accepts every host variant', () => {
  for (const type of [
    'init',
    'documentChanged',
    'runEvent',
    'runError',
    'settingsChanged',
    'prompt',
    'promptDone',
    'parametersResolved',
  ]) {
    assert.equal(isHostMsg({ type }), true, type);
  }
});

test('isHostMsg: rejects garbage', () => {
  assert.equal(isHostMsg(null), false);
  assert.equal(isHostMsg(undefined), false);
  assert.equal(isHostMsg('init'), false);
  assert.equal(isHostMsg({ type: 'nope' }), false);
});

test('isWebviewMsg: accepts every webview variant', () => {
  for (const type of [
    'ready',
    'run',
    'runAll',
    'stop',
    'edit',
    'restartSession',
    'promptResponse',
    'promptCancel',
  ]) {
    assert.equal(isWebviewMsg({ type }), true, type);
  }
});

test('isWebviewMsg: rejects garbage', () => {
  assert.equal(isWebviewMsg({}), false);
  assert.equal(isWebviewMsg({ type: 'init' }), false);
});

test('isRunEvent: accepts every event variant', () => {
  for (const type of [
    'step:start',
    'step:pass',
    'step:fail',
    'output',
    'capture',
    'done',
    'frame:push',
    'frame:pop',
    'frame:scope',
  ]) {
    assert.equal(isRunEvent({ type }), true, type);
  }
});

test('isRunEvent: rejects garbage', () => {
  assert.equal(isRunEvent({ type: 'random' }), false);
  assert.equal(isRunEvent(42), false);
});

test('isRunEvent: step events still narrow when carrying frame info', () => {
  const stepWithFrame = {
    type: 'step:start',
    line: 12,
    frame: {
      id: 'f1',
      parentId: null,
      kind: 'skill',
      uri: '/fixtures/skills/duckduckgo_search.md',
      line: 12,
      skillName: 'duckduckgo_search',
    },
  };
  assert.equal(isRunEvent(stepWithFrame), true);
});

test('isRunEvent: accepts frame:push/pop/scope payloads', () => {
  assert.equal(
    isRunEvent({
      type: 'frame:push',
      frame: { id: 'f1', parentId: null, kind: 'skill', uri: '/x.md', line: 1 },
    }),
    true,
  );
  assert.equal(isRunEvent({ type: 'frame:pop', frameId: 'f1', outputs: {} }), true);
  assert.equal(isRunEvent({ type: 'frame:scope', frameId: 'f1', scope: {} }), true);
});
