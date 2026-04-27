import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ApiClient, ApiClientError } from '../dist/api-client.js';

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
