import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isHostMsg, isRunEvent, isWebviewMsg } from '../dist/protocol.js';

test('isHostMsg: accepts every host variant', () => {
  // Keep in sync with HostToWebviewMsg / isHostMsg in src/protocol.ts.
  for (const type of [
    'activeFile',
    'runEvent',
    'runError',
    'prompt',
    'promptDone',
    'parametersResolved',
    'running',
    'breakpointStop',
    'batchBanner',
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
  // Keep in sync with WebviewToHostMsg / isWebviewMsg in src/protocol.ts.
  for (const type of [
    'ready',
    'run',
    'runAll',
    'stop',
    'restartSession',
    'promptResponse',
    'promptCancel',
    'revealLine',
    'toggleBreakpoint',
    'resume',
    'pause',
    'focusTestResults',
    'clearStatus',
    'webviewState',
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

test('isRunEvent: capture event narrows with a source discriminator', () => {
  for (const source of ['capture', 'toolOutput']) {
    assert.equal(
      isRunEvent({ type: 'capture', line: 7, name: 'x', value: 'v', source }),
      true,
      source,
    );
  }
});

test('isRunEvent: capture event from an old server (no source) still narrows', () => {
  // Backward compat: a server that predates source tagging emits a capture
  // without the field. Narrowing keys off `type` only, so it must still pass;
  // consumers that read `source` are expected to treat absent as 'capture'.
  const legacyCapture = { type: 'capture', line: 7, name: 'x', value: 'v' };
  assert.equal(isRunEvent(legacyCapture), true);
  assert.equal(legacyCapture.source ?? 'capture', 'capture');
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
