/**
 * Record Steps, runner-core half (stories/steptix-record-steps.md §On the
 * wire): the frame types and their guard, the host/webview messages the
 * panel's Recording block rides on, and the two client calls — the SSE start
 * and the JSON control.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiClient, ApiClientError, apiErrorReason, isUserAbort } from '../dist/api-client.js';
import { isHostMsg, isRecordStepsEvent, isWebviewMsg } from '../dist/protocol.js';

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

test('streamRecordSteps: a draft\'s ids and edited, record:edited, and the actions a step delete dropped all cross the wire', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () =>
      streamingResponse([
        frame({
          type: 'record:draft',
          revision: 3,
          steps: ['Navigate to login.html', 'Open Payments from the side menu', 'Verify the total'],
          parameters: [],
          locked: 3,
          authored: [2],
          authoredIds: ['s1'],
          ids: ['d1', 'd2', 's1'],
          edited: [1],
        }),
        frame({ type: 'record:edited', id: 'd2', text: 'Open Payments from the side menu', source: 'editor' }),
        frame({ type: 'record:dropped', id: 'd3', dropped: true, source: 'editor', actions: ['a4', 'a5'] }),
        frame({ type: 'done', status: 'passed' }),
      ]),
  });
  const events = await collect(client.streamRecordSteps('s', MINIMAL, new AbortController().signal));
  assert.deepEqual(events[0].ids, ['d1', 'd2', 's1']);
  assert.deepEqual(events[0].edited, [1]);
  assert.deepEqual(events[1], { type: 'record:edited', id: 'd2', text: 'Open Payments from the side menu', source: 'editor' });
  assert.deepEqual(events[2].actions, ['a4', 'a5']);
  assert.equal(events[2].source, 'editor');
});

test('controlRecordSteps: edit-step, and drop / restore of a step by its id, go as sent', async () => {
  const calls = [];
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, ignored: 'it holds a secret — write {{password}} in its place' }), { status: 202 });
    },
  });
  const answer = await client.controlRecordSteps('s', { action: 'edit-step', id: 'd2', text: 'Type hunter2 into Password', source: 'editor', revision: 7 });
  assert.deepEqual(answer, { ignored: true, reason: 'it holds a secret — write {{password}} in its place' });
  await client.controlRecordSteps('s', { action: 'drop', id: 'd3', source: 'editor' });
  await client.controlRecordSteps('s', { action: 'restore', id: 'd3', source: 'panel' });
  assert.deepEqual(calls, [
    { action: 'edit-step', id: 'd2', text: 'Type hunter2 into Password', source: 'editor', revision: 7 },
    { action: 'drop', id: 'd3', source: 'editor' },
    { action: 'restore', id: 'd3', source: 'panel' },
  ]);
});

test('isRecordStepsEvent: rejects run frames and garbage', () => {
  assert.equal(isRecordStepsEvent({ type: 'step:pass' }), false);
  assert.equal(isRecordStepsEvent({ type: 'record:crop' }), false);
  assert.equal(isRecordStepsEvent(null), false);
  assert.equal(isRecordStepsEvent('record:action'), false);
});

test('isHostMsg: the Recording block message is a host message', () => {
  assert.equal(isHostMsg({ type: 'recording', state: null }), true);
});

test('isHostMsg: the Add step box\'s answer is a host message', () => {
  assert.equal(isHostMsg({ type: 'recordAddStepResult', id: 'add-1', accepted: false, reason: 'the recording is finishing' }), true);
});

test('isWebviewMsg: every Recording control the panel posts is accepted', () => {
  // runner-view.ts drops whatever this guard rejects, so a button whose type is
  // missing here would do nothing at all.
  for (const type of ['recordSteps', 'recordNewTest', 'recordStop', 'recordCancel', 'recordCheck', 'recordDrop', 'recordPause', 'recordAddStep']) {
    assert.equal(isWebviewMsg({ type }), true, type);
  }
  assert.equal(isWebviewMsg({ type: 'recordToggle' }), false);
});

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

test('streamRecordSteps: yields every record frame in order, output and done included', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () =>
      streamingResponse([
        frame({ type: 'record:started', url: 'http://localhost:8787/', title: 'SecureBank' }),
        frame({ type: 'record:action', id: 'a1', kind: 'click', summary: 'Clicked link "Reports"', atMs: 1200 }),
        frame({ type: 'output', msg: 'crop budget spent', kind: 'warn' }),
        frame({ type: 'record:action', id: 'a2', kind: 'type', action: false, summary: 'Typed into Password (masked)', atMs: 2400, tab: 'popup-1' }),
        frame({ type: 'record:pick', armed: true }),
        frame({ type: 'record:drafting', busy: true }),
        frame({
          type: 'record:draft',
          revision: 1,
          steps: ['Click Reports'],
          parameters: [],
          notes: ['n0'],
          through: 'a2',
        }),
        frame({ type: 'record:drafting', busy: false }),
        frame({ type: 'record:writing' }),
        frame({
          type: 'record:result',
          steps: ['Click Reports'],
          parameters: [{ name: 'password', value: '$PASSWORD' }],
          notes: ['n1'],
        }),
        frame({ type: 'done', status: 'passed' }),
      ]),
  });
  const events = await collect(client.streamRecordSteps('s', MINIMAL, new AbortController().signal));
  assert.deepEqual(
    events.map((e) => e.type),
    [
      'record:started',
      'record:action',
      'output',
      'record:action',
      'record:pick',
      'record:drafting',
      'record:draft',
      'record:drafting',
      'record:writing',
      'record:result',
      'done',
    ],
  );
  assert.equal(events[1].summary, 'Clicked link "Reports"');
  assert.equal(events[3].tab, 'popup-1');
  assert.equal(events[3].action, false, 'the event flag survives the wire');
  assert.deepEqual(
    [events[5].busy, events[6].revision, events[6].through, events[7].busy],
    [true, 1, 'a2', false],
  );
  assert.deepEqual(events[9].parameters, [{ name: 'password', value: '$PASSWORD' }]);
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

test('streamRecordSteps: 409 is a conflict carrying the server reason', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () => jsonErrorResponse(409, '{"error":"A run holds this session."}'),
  });
  await assert.rejects(
    () => collect(client.streamRecordSteps('s', MINIMAL, new AbortController().signal)),
    (err) => err instanceof ApiClientError && err.kind === 'conflict' && err.message === 'A run holds this session.',
  );
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

test('streamRecordSteps: 404 (a server that predates the route) is not-found', async () => {
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => jsonErrorResponse(404, 'Cannot POST') });
  await assert.rejects(
    () => collect(client.streamRecordSteps('s', MINIMAL, new AbortController().signal)),
    (err) => err instanceof ApiClientError && err.kind === 'not-found',
  );
});

test('streamRecordSteps: aborting the signal is a user abort', async () => {
  const controller = new AbortController();
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  await assert.rejects(
    () => collect(client.streamRecordSteps('s', MINIMAL, controller.signal)),
    (err) => isUserAbort(err),
  );
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
