import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiClient, ApiClientError, isUserAbort } from '../dist/api-client.js';

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

test('streamSteps: sends correct headers + body shape', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return streamingResponse(['event: done\ndata: {"type":"done","status":"passed"}\n\n']);
  };
  const client = new ApiClient({ serverUrl: 'http://x:1', apiKey: 'k', fetch: fetchImpl });

  const events = await collect(
    client.streamSteps('sess-1', { steps: ['s1'], env: { AI_API_KEY: 'a' } }, new AbortController().signal),
  );

  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['x-api-key'], 'k');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.equal(captured.init.headers['Accept'], 'text/event-stream');
  assert.match(captured.url, /\/sessions\/sess-1\/steps\?stream=1$/);
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.steps, ['s1']);
  assert.deepEqual(body.env, { AI_API_KEY: 'a' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'done');
});

test('streamSteps: yields ordered events', async () => {
  const chunks = [
    'event: step:start\ndata: {"type":"step:start","line":2}\n\n',
    'event: step:pass\ndata: {"type":"step:pass","line":2}\n\n',
    'event: done\ndata: {"type":"done","status":"passed"}\n\n',
  ];
  const fetchImpl = async () => streamingResponse(chunks);
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: fetchImpl });

  const events = await collect(client.streamSteps('id', { steps: ['x'] }, new AbortController().signal));
  assert.deepEqual(
    events.map((e) => e.type),
    ['step:start', 'step:pass', 'done'],
  );
});

test('streamSteps: 401 throws unauthorized', async () => {
  const fetchImpl = async () => jsonErrorResponse(401, '{"error":"bad key"}');
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: fetchImpl });
  try {
    await collect(client.streamSteps('id', { steps: ['x'] }, new AbortController().signal));
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ApiClientError);
    assert.equal(err.kind, 'unauthorized');
  }
});

test('streamSteps: 404 throws not-found', async () => {
  const fetchImpl = async () => jsonErrorResponse(404);
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: fetchImpl });
  try {
    await collect(client.streamSteps('id', { steps: ['x'] }, new AbortController().signal));
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.kind, 'not-found');
  }
});

test('streamSteps: 500 throws server-error with body excerpt', async () => {
  const fetchImpl = async () => jsonErrorResponse(500, 'boom');
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: fetchImpl });
  try {
    await collect(client.streamSteps('id', { steps: ['x'] }, new AbortController().signal));
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.kind, 'server-error');
    assert.equal(err.status, 500);
    assert.equal(err.bodyExcerpt, 'boom');
  }
});

test('streamSteps: connection failure throws connect-failed', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: fetchImpl });
  try {
    await collect(client.streamSteps('id', { steps: ['x'] }, new AbortController().signal));
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.kind, 'connect-failed');
  }
});

test('streamSteps: abort throws aborted', async () => {
  const controller = new AbortController();
  const fetchImpl = async () => {
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  };
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: fetchImpl });
  try {
    await collect(client.streamSteps('id', { steps: ['x'] }, controller.signal));
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.kind, 'aborted');
  }
});

test('streamSteps: encodes session ID with special chars', async () => {
  let captured;
  const fetchImpl = async (url) => {
    captured = url;
    return streamingResponse(['event: done\ndata: {"type":"done","status":"passed"}\n\n']);
  };
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: fetchImpl });
  await collect(client.streamSteps('C:\\path with spaces\\file.md', { steps: ['x'] }, new AbortController().signal));
  assert.match(captured, /sessions\/C%3A%5Cpath%20with%20spaces%5Cfile\.md\/steps/);
});

// ---------------------------------------------------------------------------
// isUserAbort — used by the run-controller to distinguish Stop from network failure
// ---------------------------------------------------------------------------

test('isUserAbort: true for ApiClientError with kind=aborted', () => {
  assert.equal(isUserAbort(new ApiClientError('aborted', 'aborted')), true);
});

test('isUserAbort: false for other ApiClientError kinds', () => {
  for (const kind of ['connect-failed', 'unauthorized', 'not-found', 'server-error', 'stream-dropped']) {
    assert.equal(isUserAbort(new ApiClientError(kind, kind)), false, kind);
  }
});

test('isUserAbort: false for plain Error', () => {
  assert.equal(isUserAbort(new Error('aborted')), false);
});

test('isUserAbort: false for non-error values', () => {
  assert.equal(isUserAbort(null), false);
  assert.equal(isUserAbort(undefined), false);
  assert.equal(isUserAbort('aborted'), false);
  assert.equal(isUserAbort({ kind: 'aborted' }), false);
});

// ── getLastRun (issue 021) ───────────────────────────────────────────────
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('getLastRun: parses finalized + tokens + reportPath from a 200 body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse({
      finalized: true,
      tokens: { total: 30, input: 20, output: 10 },
      reportPath: '/reports/r.html',
    });
  };
  const client = new ApiClient({ serverUrl: 'http://x:1', apiKey: 'k', fetch: fetchImpl });

  const info = await client.getLastRun('sess-1');

  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.headers['x-api-key'], 'k');
  assert.match(captured.url, /\/sessions\/sess-1\/last-run$/);
  assert.deepEqual(info, {
    finalized: true,
    tokens: { total: 30, input: 20, output: 10 },
    reportPath: '/reports/r.html',
  });
});

test('getLastRun: returns null on 404 (older server without the route)', async () => {
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => jsonResponse({}, 404) });
  assert.equal(await client.getLastRun('id'), null);
});

test('getLastRun: tolerant of a partial/older body — missing fields stay undefined', async () => {
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => jsonResponse({ finalized: false }) });
  const info = await client.getLastRun('id');
  assert.equal(info.finalized, false);
  assert.equal(info.tokens, undefined);
  assert.equal(info.reportPath, undefined);
});

test('getLastRun: throws unauthorized on 401', async () => {
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => jsonResponse({}, 401) });
  await assert.rejects(() => client.getLastRun('id'), (err) => err instanceof ApiClientError && err.kind === 'unauthorized');
});

test('getLastRun: throws connect-failed on transport error', async () => {
  const client = new ApiClient({ serverUrl: 'http://x', apiKey: 'k', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => client.getLastRun('id'), (err) => err instanceof ApiClientError && err.kind === 'connect-failed');
});

// ── compileCodeBehind (stories/codebehind-compile.md §Server) ──────────────

test('compileCodeBehind: posts the compile route with the request body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return streamingResponse([
      'event: compile:done\ndata: {"type":"compile:done","status":"green","message":"ok"}\n\n',
    ]);
  };
  const client = new ApiClient({ serverUrl: 'http://x:1', apiKey: 'k', fetch: fetchImpl });

  const events = await collect(
    client.compileCodeBehind(
      { testFilePath: '/p/tests/a.md', select: { steps: [3] }, envName: 'ci' },
      new AbortController().signal,
    ),
  );

  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['x-api-key'], 'k');
  assert.equal(captured.init.headers['Accept'], 'text/event-stream');
  assert.match(captured.url, /\/codebehind\/compile$/);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.testFilePath, '/p/tests/a.md');
  assert.deepEqual(body.select, { steps: [3] });
  assert.equal(body.envName, 'ci');
  assert.equal(events.length, 1);
});

test('compileCodeBehind: yields phases, steps and the final result in order', async () => {
  const chunks = [
    'event: compile:phase\ndata: {"type":"compile:phase","phase":"select","message":"2 step(s) to generate"}\n\n',
    'event: compile:phase\ndata: {"type":"compile:phase","phase":"generate","message":"2 step(s)"}\n\n',
    'event: compile:step\ndata: {"type":"compile:step","phase":"generate","step":2,"message":"generated"}\n\n',
    'event: compile:phase\ndata: {"type":"compile:phase","phase":"replay","round":1,"message":"2/2 passed as code"}\n\n',
    'event: compile:done\ndata: {"type":"compile:done","status":"green","message":"Compiled"}\n\n',
    'event: compile:result\ndata: {"type":"compile:result","status":"green","files":{"/p/tests/a.steps.ts":"export default 1"},"summary":{"test":"/p/tests/a.md","compiled":2}}\n\n',
  ];
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () => streamingResponse(chunks),
  });

  const events = await collect(
    client.compileCodeBehind({ testFilePath: '/p/tests/a.md' }, new AbortController().signal),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ['compile:phase', 'compile:phase', 'compile:step', 'compile:phase', 'compile:done', 'compile:result'],
  );
  const result = events.at(-1);
  assert.equal(result.status, 'green');
  assert.equal(result.files['/p/tests/a.steps.ts'], 'export default 1');
  assert.equal(result.summary.compiled, 2);
  // The round survives the wire — the panel labels "Replay 1" from it.
  assert.equal(events[3].round, 1);
});

test('compileCodeBehind: 409 is a conflict carrying the server reason, not a server-error', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () => jsonErrorResponse(409, '{"error":"A compile of a.md is already running."}'),
  });
  await assert.rejects(
    () => collect(client.compileCodeBehind({ testFilePath: '/p/tests/a.md' }, new AbortController().signal)),
    (err) =>
      err instanceof ApiClientError &&
      err.kind === 'conflict' &&
      err.status === 409 &&
      err.message === 'A compile of a.md is already running.',
  );
});

test('compileCodeBehind: 401 still throws unauthorized', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () => jsonErrorResponse(401, '{"error":"bad key"}'),
  });
  await assert.rejects(
    () => collect(client.compileCodeBehind({ testFilePath: '/p/a.md' }, new AbortController().signal)),
    (err) => err instanceof ApiClientError && err.kind === 'unauthorized',
  );
});

test('compileCodeBehind: aborting the signal surfaces as an abort, not a transport fault', async () => {
  const controller = new AbortController();
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async (_url, init) => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal });
    },
  });
  await assert.rejects(
    () => collect(client.compileCodeBehind({ testFilePath: '/p/a.md' }, controller.signal)),
    (err) => isUserAbort(err),
  );
});

test('streamSteps still works after the shared SSE refactor', async () => {
  const client = new ApiClient({
    serverUrl: 'http://x',
    apiKey: 'k',
    fetch: async () =>
      streamingResponse([
        'event: step:pass\ndata: {"type":"step:pass","line":4,"fromCodeBehind":true}\n\n',
        'event: done\ndata: {"type":"done","status":"passed"}\n\n',
      ]),
  });
  const events = await collect(client.streamSteps('id', { steps: ['x'] }, new AbortController().signal));
  assert.deepEqual(events.map((e) => e.type), ['step:pass', 'done']);
  assert.equal(events[0].fromCodeBehind, true);
});
