import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isCompileEvent, isHostMsg, isRunEvent, isWebviewMsg } from '../dist/protocol.js';

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
    'skillRerunAvailable',
    'compileState',
    'compileEvent',
    'compileRunEvent',
    'compileStep',
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

// ── Compile stream (stories/codebehind-compile.md §Server) ─────────────────

test('isCompileEvent: accepts every compile frame the server sends', () => {
  assert.equal(isCompileEvent({ type: 'compile:phase', phase: 'select', message: '3 to generate' }), true);
  assert.equal(isCompileEvent({ type: 'compile:phase', phase: 'replay', round: 2, message: 'ok' }), true);
  assert.equal(isCompileEvent({ type: 'compile:step', phase: 'generate', step: 4, message: 'generated' }), true);
  assert.equal(isCompileEvent({ type: 'compile:done', status: 'green', message: 'done' }), true);
  assert.equal(
    isCompileEvent({ type: 'compile:result', status: 'green', files: {}, summary: { test: '/a.md' } }),
    true,
  );
  // `output` rides the compile stream too — the server uses it for the
  // sessionId decline and for run noise.
  assert.equal(isCompileEvent({ type: 'output', msg: 'x', kind: 'info' }), true);
  // `line` on a step event, `partial` as a status: both additive.
  assert.equal(isCompileEvent({ type: 'compile:step', phase: 'generate', step: 4, line: 12, message: 'generated' }), true);
  assert.equal(isCompileEvent({ type: 'compile:done', status: 'partial', message: 'some' }), true);
});

test('isCompileEvent: accepts a run event inside compile:run, and only a run event', () => {
  // stories/codebehind-compile-as-a-run.md §Every run is on the stream: the
  // inner event is one of the run stream's own, untouched.
  assert.equal(
    isCompileEvent({ type: 'compile:run', phase: 'record', event: { type: 'step:start', line: 4 } }),
    true,
  );
  assert.equal(
    isCompileEvent({
      type: 'compile:run', phase: 'replay', round: 2,
      event: { type: 'step:pass', line: 4, fromCodeBehind: true },
    }),
    true,
  );
  assert.equal(
    isCompileEvent({ type: 'compile:run', phase: 'replay', round: 1, event: { type: 'done', status: 'failed' } }),
    true,
  );
  // A wrapper around something that is not a run event is not a compile event.
  assert.equal(isCompileEvent({ type: 'compile:run', phase: 'record', event: { type: 'compile:phase' } }), false);
  assert.equal(isCompileEvent({ type: 'compile:run', phase: 'record' }), false);
  assert.equal(isRunEvent({ type: 'compile:run', phase: 'record', event: { type: 'step:start', line: 4 } }), false);
});

test('isCompileEvent: rejects run events and junk', () => {
  assert.equal(isCompileEvent({ type: 'step:pass', line: 3 }), false);
  assert.equal(isCompileEvent({ type: 'done', status: 'passed' }), false);
  assert.equal(isCompileEvent(null), false);
  assert.equal(isCompileEvent('compile:phase'), false);
  assert.equal(isCompileEvent({}), false);
});

test('isRunEvent: admits only the two frames a compile-mode run emits', () => {
  // stories/compile-as-you-go.md §On the wire — a run carrying `compile`
  // emits these two on its OWN stream, so the run narrower has to pass them.
  assert.equal(isRunEvent({ type: 'compile:step', phase: 'generate', step: 1, message: 'generated' }), true);
  assert.equal(isRunEvent({ type: 'compile:result', status: 'partial', files: {}, summary: {} }), true);
  // The boxed pipeline's own phases still belong to the compile stream alone.
  assert.equal(isRunEvent({ type: 'compile:phase', phase: 'select', message: 'x' }), false);
  assert.equal(isRunEvent({ type: 'compile:done', status: 'green', message: 'x' }), false);
  assert.equal(isRunEvent({ type: 'compile:run', phase: 'record', event: { type: 'step:pass', line: 1 } }), false);
});

test('step:pass carries the code-behind flags through the narrower', () => {
  const asCode = { type: 'step:pass', line: 12, fromCodeBehind: true };
  assert.equal(isRunEvent(asCode), true);
  assert.equal(asCode.fromCodeBehind, true);

  const stale = {
    type: 'step:pass',
    line: 12,
    codeBehindStale: { file: '/p/tests/a.steps.ts', error: 'locator timeout' },
  };
  assert.equal(isRunEvent(stale), true);
  assert.equal(stale.codeBehindStale.file, '/p/tests/a.steps.ts');
});

test('isRunEvent: accepts both awaiting-debugger variants', () => {
  // Tool step-into (Phase 5) and its code-behind sibling
  // (stories/codebehind-debugging.md). Same contract: the client attaches
  // the Node debugger and POSTs the shared tool-debugger-ack route.
  assert.equal(
    isRunEvent({ type: 'tool:awaiting-debugger', toolName: 'echo', line: 3 }),
    true,
  );
  const cb = {
    type: 'codebehind:awaiting-debugger',
    file: '/p/tests/a.steps.ts',
    line: 7,
  };
  assert.equal(isRunEvent(cb), true);
  assert.equal(cb.file, '/p/tests/a.steps.ts');
});
