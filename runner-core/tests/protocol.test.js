import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isCompileEvent,
  isHostMsg,
  isRunEvent,
  isSkippedPass,
  isWebviewMsg,
} from '../dist/protocol.js';

test('isHostMsg: accepts every host variant', () => {
  // Keep in sync with HostToWebviewMsg / isHostMsg in src/protocol.ts.
  for (const type of [
    'activeFile',
    'runEvent',
    'runError',
    'prompt',
    'promptDone',
    'parametersResolved',
    // The data-row pair: the end-of-loop worst-status repaint, and the live
    // matrix the Rows section renders.
    'rowSummary',
    'rows',
    'running',
    'breakpointStop',
    'batchBanner',
    'skillRerunAvailable',
    'compileEvent',
    // The compile tail's strip state (stories/compile-tail-progress.md). It
    // replaced 'compileState' and 'compileStep', which nothing in the
    // extension host ever posted.
    'compileProgress',
    'compileRunEvent',
    // The Recording block (stories/testbench-record-steps.md, decision 13).
    'recording',
    // The answer to the Add step box, by the press's id.
    'recordAddStepResult',
  ]) {
    assert.equal(isHostMsg({ type }), true, type);
  }
});

test('isHostMsg: rejects garbage', () => {
  // The two retired shapes are garbage now, not merely unused: keeping them
  // accepted would let a stale sender post one and be silently ignored.
  assert.equal(isHostMsg({ type: 'compileState' }), false);
  assert.equal(isHostMsg({ type: 'compileStep' }), false);
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
    'runRows',
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
    'rerunSkillStep',
    'compile',
    // Record Steps (stories/testbench-record-steps.md).
    'recordSteps',
    'recordNewTest',
    'recordStop',
    'recordCancel',
    'recordCheck',
    'recordDrop',
    // The browser toolbar's panel parity (stories/testbench-record-toolbar.md).
    'recordPause',
    'recordAddStep',
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
    // A step an `If … then return` left behind (stories/step-flow-control.md,
    // decision 9). A client that does not know it drops it here, which is the
    // safe direction: the line keeps its old glyph rather than the run failing.
    'step:skip',
    'output',
    'capture',
    'done',
    'frame:push',
    'frame:pop',
    'frame:scope',
    // A compile-mode run's own frames. An ordinary run never sends them, but
    // the run stream is where they ride (stories/compile-as-you-go.md,
    // stories/compile-tail-progress.md).
    'compile:step',
    'compile:progress',
    'compile:result',
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

test('isRunEvent: a skip event narrows with its line, frame and reason', () => {
  // The two shapes a skip is emitted in (stories/step-flow-control.md,
  // decision 9): a skipped STEP, tagged with its own frame, and a skipped
  // nested CALL line, tagged with the frame the call is written in. Both are
  // the same event type — the difference is only which frame it names.
  assert.equal(
    isRunEvent({
      type: 'step:skip',
      line: 9,
      frame: {
        id: 'f1',
        parentId: null,
        kind: 'section',
        uri: '/fixtures/checkout.md',
        line: 4,
        skillName: 'Sign in',
      },
      reason: 'Not run: step 3 returned from "Sign in"',
    }),
    true,
  );
  // A frameless skip — what a runner with no expansion (an errand) emits.
  assert.equal(
    isRunEvent({ type: 'step:skip', line: 5, reason: 'Not run: step 3 ended the run' }),
    true,
  );
});

test('isRunEvent: capture event narrows with a source discriminator', () => {
  // All four members of the union, `generated` being a `[use ai]` step's value
  // (stories/use-ai-step.md, decision 9).
  for (const source of ['capture', 'toolOutput', 'assignment', 'generated']) {
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
  // The tail's counts (stories/compile-tail-progress.md). A client that folds
  // the compile stream has to narrow this one too, or it falls through to a
  // default case as an unknown frame.
  assert.equal(
    isCompileEvent({ type: 'compile:progress', done: 1, total: 3, phase: 'generate' }),
    true,
  );
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

test('isSkippedPass: a pass carrying output "skipped" is a step that never ran', () => {
  // The wire has no third verdict, so an untaken branch — and the body of a
  // `While` that never entered — arrives as a PASS with `output: 'skipped'`
  // (stories/control-flow.md). Every surface that derives a glyph or a log
  // line from `step:pass` asks this first; three of six used not to, and
  // painted a step that did nothing green.
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: 'skipped' }), true);
});

test('isSkippedPass: every other pass is a real one', () => {
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5 }), false);
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: '' }), false);
  // The reasoning a guard carries is an ordinary output, not the sentinel.
  assert.equal(
    isSkippedPass({ type: 'step:pass', line: 5, output: 'the Cash checkbox is ticked' }),
    false,
  );
  // Near misses are not the sentinel either — it is one exact string.
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: 'Skipped' }), false);
  assert.equal(isSkippedPass({ type: 'step:pass', line: 5, output: 'skipped: no branch held' }), false);
});
