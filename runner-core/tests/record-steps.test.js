/**
 * Record Steps, runner-core half (stories/steptix-record-steps.md §On the
 * wire): the frame types and their guard, and the two client calls — the SSE
 * start and the JSON control. The panel's Recording controls ride the
 * webview guard, which protocol.test.js checks against the whole union.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiClient, apiErrorReason } from '../dist/api-client.js';
import { isRecordStepsEvent } from '../dist/protocol.js';

function streamingResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function jsonErrorResponse(status, body = '') {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

async function collect(asyncIterable) {
  const out = [];
  for await (const ev of asyncIterable) out.push(ev);
  return out;
}

/** One SSE frame for an event object. */
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const MINIMAL = { testFilePath: '/t.md', target: { mode: 'new', fileText: '' } };

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

test('isRecordStepsEvent: accepts every frame the record stream carries', () => {
  for (const type of [
    'record:started',
    'record:action',
    'record:pick',
    // Live drafting (decision 9): the updating marker and the draft itself.
    'record:drafting',
    'record:draft',
    'record:writing',
    'record:result',
    // The existing frame, for warnings.
    'output',
    'done',
  ]) {
    assert.equal(isRecordStepsEvent({ type }), true, type);
  }
});

test('isRecordStepsEvent: accepts the browser toolbar\'s frames (stories/steptix-record-toolbar.md)', () => {
  // The run controller drops whatever this guard rejects, so a frame missing
  // here would never reach the panel: no pause marker, no ✎ row, no strike.
  for (const type of ['record:paused', 'record:step', 'record:dropped', 'record:toolbar']) {
    assert.equal(isRecordStepsEvent({ type }), true, type);
  }
});

test('isRecordStepsEvent: accepts record:edited (stories/steptix-record-edit-steps.md)', () => {
  // Dropped by the guard, a step reworded in the browser's drawer would never
  // reach the panel's row, nor the file line that follows it.
  assert.equal(isRecordStepsEvent({ type: 'record:edited', id: 'd4', text: 'Open Payments from the side menu', source: 'toolbar' }), true);
});

test('isRecordStepsEvent: rejects run frames and garbage', () => {
  assert.equal(isRecordStepsEvent({ type: 'step:pass' }), false);
  assert.equal(isRecordStepsEvent({ type: 'record:crop' }), false);
  assert.equal(isRecordStepsEvent(null), false);
  assert.equal(isRecordStepsEvent('record:action'), false);
});

// ---------------------------------------------------------------------------
// streamRecordSteps
//
// One `yield* postSse(…)`: the frame loop and the 401 / 404 / 409 / abort
// mapping are api-client.test.js's, on `streamSteps` and `compileCodeBehind`.
// What is pinned here is what the record stream adds — its route, that it is
// not filtered by the guard above, the 400 a headless server answers with,
// and `onOpen`.
// ---------------------------------------------------------------------------

test('streamRecordSteps: posts the record-steps route with SSE headers and the body verbatim', async () => {
  let captured;
  const client = new ApiClient({
    serverUrl: 'http://x:1/',
    apiKey: 'k',
    fetch: async (url, init) => {
      captured = { url, init };
      return streamingResponse([frame({ type: 'done', status: 'aborted' })]);
    },
  });
  const body = {
    testFilePath: 'C:\\p\\tests\\pay.md',
    config: { baseUrl: 'http://localhost:8787/', viewport: 'mobile' },
    target: { mode: 'cursor', fileText: '## Steps\n1. a\n', cursorLine: 2 },
    env: { AI_MODEL: 'm' },
    envName: 'staging',
  };
  await collect(client.streamRecordSteps('C:\\p\\tests\\pay.md', body, new AbortController().signal));

  assert.equal(captured.url, `http://x:1/sessions/${encodeURIComponent('C:\\p\\tests\\pay.md')}/record-steps`);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['x-api-key'], 'k');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.equal(captured.init.headers['Accept'], 'text/event-stream');
  // No `?stream=1`: the route is always SSE.
  assert.doesNotMatch(captured.url, /\?/);
  assert.deepEqual(JSON.parse(captured.init.body), body);
});

test('streamRecordSteps: a frame type the client does not know yet is passed through, not dropped', async () => {
  // The stream is not filtered by `isRecordStepsEvent`: a newer server's extra
  // frame reaches the consumer, which decides what to ignore.
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () =>
      streamingResponse([frame({ type: 'record:crop', id: 'a1' }), frame({ type: 'done', status: 'passed' })]),
  });
  const events = await collect(client.streamRecordSteps('s', MINIMAL, new AbortController().signal));
  assert.deepEqual(events.map((e) => e.type), ['record:crop', 'done']);
});

test('streamRecordSteps: a 400 (headless server) is a server-error whose reason apiErrorReason reads out', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () =>
      jsonErrorResponse(400, '{"error":"Record Steps needs a headed browser: set browser.headed to true."}'),
  });
  let caught;
  await collect(client.streamRecordSteps('s', MINIMAL, new AbortController().signal)).catch((err) => {
    caught = err;
  });
  assert.equal(caught.kind, 'server-error');
  assert.equal(caught.status, 400);
  assert.equal(apiErrorReason(caught), 'Record Steps needs a headed browser: set browser.headed to true.');
});

// ---------------------------------------------------------------------------
// controlRecordSteps
// ---------------------------------------------------------------------------

test('controlRecordSteps: posts each control action as JSON to the control route', async () => {
  const calls = [];
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(null, { status: 202 });
    },
  });
  await client.controlRecordSteps('a b', { action: 'check' });
  await client.controlRecordSteps('a b', { action: 'cancel-check' });
  // Live drafting (decision 9): a ✕ drops at once, and redrafts.
  await client.controlRecordSteps('a b', { action: 'drop', id: 'a2' });
  await client.controlRecordSteps('a b', { action: 'restore', id: 'a2' });
  await client.controlRecordSteps('a b', { action: 'stop', dropped: ['a2', 'a5'] });
  await client.controlRecordSteps('a b', { action: 'cancel' });
  assert.deepEqual(
    calls.map((c) => c.body),
    [
      { action: 'check' },
      { action: 'cancel-check' },
      { action: 'drop', id: 'a2' },
      { action: 'restore', id: 'a2' },
      { action: 'stop', dropped: ['a2', 'a5'] },
      { action: 'cancel' },
    ],
  );
  for (const c of calls) {
    assert.equal(c.url, 'http://x/sessions/a%20b/record-steps/control');
    assert.equal(c.method, 'POST');
    assert.equal(c.headers['x-api-key'], 'k');
    assert.equal(c.headers['Content-Type'], 'application/json');
  }
});

test('controlRecordSteps: answers {} for a bare 202, { ignored: true } when the server says the call did nothing', async () => {
  const answering = (body) =>
    new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => new Response(body, { status: 202 }) });
  assert.deepEqual(await answering(null).controlRecordSteps('s', { action: 'pause' }), {});
  assert.deepEqual(await answering('{"accepted":true}').controlRecordSteps('s', { action: 'pause' }), {});
  assert.deepEqual(await answering('{"ignored":true}').controlRecordSteps('s', { action: 'pause' }), { ignored: true });
  // The server's own shape: why, as a sentence.
  const why = 'The recording has already been stopped and its steps are being written; only "cancel" still applies.';
  assert.deepEqual(
    await answering(JSON.stringify({ ok: true, ignored: why })).controlRecordSteps('s', { action: 'add-step', text: 'x', source: 'panel' }),
    { ignored: true, reason: why },
  );
  assert.deepEqual(await answering('{"ok":true,"ignored":false}').controlRecordSteps('s', { action: 'pause' }), {});
  assert.deepEqual(await answering('not json').controlRecordSteps('s', { action: 'pause' }), {});
});

test('controlRecordSteps: 404 (no recording running) is not-found; 401 unauthorized; 500 server-error', async () => {
  const at = (status, body = '') =>
    new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => jsonErrorResponse(status, body) });
  await assert.rejects(
    () => at(404, '{"error":"No recording is running for this session."}').controlRecordSteps('s', { action: 'stop' }),
    (err) => err.kind === 'not-found' && err.message === 'No recording is running for this session.',
  );
  await assert.rejects(() => at(401).controlRecordSteps('s', { action: 'stop' }), (err) => err.kind === 'unauthorized');
  await assert.rejects(
    () => at(500, 'boom').controlRecordSteps('s', { action: 'cancel' }),
    (err) => err.kind === 'server-error' && err.status === 500 && err.bodyExcerpt === 'boom',
  );
});

test('controlRecordSteps: a transport failure is connect-failed with the cause', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3100') });
    },
  });
  await assert.rejects(
    () => client.controlRecordSteps('s', { action: 'stop' }),
    (err) => err.kind === 'connect-failed' && /ECONNREFUSED/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// apiErrorReason
// ---------------------------------------------------------------------------

test('apiErrorReason: parsed JSON, truncated JSON, escapes, plain text and non-errors', () => {
  assert.equal(apiErrorReason({ message: 'HTTP 400', bodyExcerpt: '{"error":"headless"}' }), 'headless');
  // postSse keeps 240 characters: a long reason arrives as JSON with no end.
  const long = `{"error":"${'x'.repeat(300)}"}`.slice(0, 240);
  assert.equal(apiErrorReason({ message: 'HTTP 400', bodyExcerpt: long }), 'x'.repeat(230));
  const escaped = JSON.stringify({ error: 'say "hi"' });
  assert.equal(apiErrorReason({ message: 'HTTP 400', bodyExcerpt: escaped.slice(0, -2) }), 'say "hi"');
  assert.equal(apiErrorReason({ message: 'HTTP 502', bodyExcerpt: '<html>' }), 'HTTP 502');
  assert.equal(apiErrorReason(new Error('plain')), 'plain');
  assert.equal(apiErrorReason('str'), 'str');
});

test('streamRecordSteps: onOpen fires once the server answers 200, before any frame — and not on a refusal', async () => {
  // The server holds a session from the 200 on, so a caller marks `config` as
  // sent here — not on the first frame, which a cancel during the browser
  // launch never lets arrive.
  const order = [];
  const ok = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () => streamingResponse([frame({ type: 'record:started', url: 'u', title: '' })]),
  });
  for await (const ev of ok.streamRecordSteps('s', MINIMAL, new AbortController().signal, () => order.push('open'))) {
    order.push(ev.type);
  }
  assert.deepEqual(order, ['open', 'record:started']);
  let opened = false;
  const refused = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => jsonErrorResponse(409, '{}') });
  await assert.rejects(() => collect(refused.streamRecordSteps('s', MINIMAL, new AbortController().signal, () => { opened = true; })));
  assert.equal(opened, false);
});
