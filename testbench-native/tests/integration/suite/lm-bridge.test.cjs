/**
 * The Copilot bridge as a running socket, inside a real VS Code extension host
 * (stories/copilot-lm-bridge.md §Part A).
 *
 * The translation rules are unit-tested without a host
 * (tests/lm-bridge-core.test.js); what needs the host is everything the unit
 * layer cannot reach: that the User-scoped setting actually starts a listener,
 * that the token from SecretStorage is the one the socket demands, that a port
 * held by another process puts this window in standby and that it adopts the
 * port when that process goes away, and that both response modes come back off
 * a real HTTP request rather than out of a function call.
 *
 * `vscode.lm` itself is faked (tests/integration/fakes/fake-lm.cjs) — a real
 * one needs a signed-in Copilot seat and spends it.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const vscode = require('vscode');
const { FakeLm } = require('../fakes/fake-lm.cjs');

const EXT_ID = 'pkent.testbench-native';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient predicate errors are part of the wait */
    }
    await sleep(25);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Occupy a port the way another VS Code window's bridge would. */
function squat(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => res.end('squatter'));
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('TestBench Copilot LM bridge', function () {
  this.timeout(30_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  let fake;
  let token;
  let port;

  /** Raw request against the bridge; returns { status, headers, text }. */
  async function call(path, { method = 'GET', body, auth = token, at = port } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth) headers['authorization'] = `Bearer ${auth}`;
    const res = await fetch(`http://127.0.0.1:${at}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  const json = (result) => JSON.parse(result.text);

  /** The request shape @pkent/aigateway actually builds for this framework. */
  const completionRequest = (over = {}) => ({
    model: 'copilot/gpt-4.1',
    messages: [
      { role: 'system', content: 'You compile test steps.' },
      { role: 'user', content: 'Compile step 1.' },
    ],
    max_completion_tokens: 4096,
    response_format: { type: 'json_object' },
    ...over,
  });

  async function setBridge({ enabled, at }) {
    const cfg = vscode.workspace.getConfiguration('testbench-native');
    if (at !== undefined) await cfg.update('lmBridge.port', at, vscode.ConfigurationTarget.Global);
    await cfg.update('lmBridge.enabled', enabled, vscode.ConfigurationTarget.Global);
    await hooks.syncLmBridge();
  }

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
    token = await hooks.lmBridgeToken();
    assert.match(token, /^[0-9a-f]{64}$/, '32 random bytes, hex');
  });

  beforeEach(async () => {
    fake = new FakeLm();
    // 250ms rather than the real 15s, so the standby→adopt transition happens
    // inside a test's timeout instead of outliving the suite.
    hooks.configureLmBridge({ facade: fake, retryMs: 250 });
    port = await freePort();
    await setBridge({ enabled: true, at: port });
    await waitFor('bridge listening', () => hooks.lmBridgeStatus().state === 'listening');
  });

  after(async () => {
    await setBridge({ enabled: false });
  });

  it('is off until the User-scoped setting turns it on', async () => {
    await setBridge({ enabled: false });
    assert.equal(hooks.lmBridgeStatus().state, 'off');
    await assert.rejects(
      () => call('/v1/models'),
      /fetch failed|ECONNREFUSED/,
      'nothing should answer on the port',
    );

    await setBridge({ enabled: true, at: port });
    await waitFor('back up', () => hooks.lmBridgeStatus().state === 'listening');
    assert.equal((await call('/v1/models')).status, 200);
  });

  it('401s without the token, and serves with it', async () => {
    assert.equal((await call('/v1/models', { auth: null })).status, 401);
    assert.equal((await call('/v1/models', { auth: 'not-the-token' })).status, 401);

    const refused = await call('/v1/models', { auth: null });
    const body = json(refused);
    // The one cause nobody guesses from a 401 on a loopback URL.
    assert.match(body.error.message, /another machine/);
    assert.equal(body.error.code, 'invalid_api_key');

    assert.equal((await call('/v1/models')).status, 200);
  });

  it('an unauthenticated caller cannot even learn which routes exist', async () => {
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      auth: null,
      body: completionRequest(),
    });
    assert.equal(result.status, 401);
    assert.equal(fake.requests.length, 0, 'no model was touched');
  });

  it('GET /v1/models lists the seat in OpenAI shape, ids ready to paste', async () => {
    const body = json(await call('/v1/models'));
    assert.equal(body.object, 'list');
    assert.deepEqual(
      body.data.map((m) => m.id),
      ['copilot/gpt-4.1', 'copilot/claude-sonnet-4'],
    );
    assert.equal(body.data[0].owned_by, 'copilot');
  });

  it('answers a non-streaming request with a buffered, fence-stripped completion', async () => {
    fake.reply = ['```json\n{"entry":', '"compiled"}\n```'];
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest(),
    });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /application\/json/);

    const body = json(result);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, '{"entry":"compiled"}');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

    // The system message folded, and the cap arrived under the only spelling
    // this wire uses.
    assert.equal(fake.requests.length, 1);
    const sent = fake.requests[0];
    assert.deepEqual(sent.messages, [
      { role: 'user', text: 'You compile test steps.\n\nCompile step 1.' },
    ]);
    assert.deepEqual(sent.options.modelOptions, { max_tokens: 4096 });
  });

  it('answers a streamed request as ONE delta then [DONE]', async () => {
    fake.reply = ['{"entry":', '"streamed"}'];
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest({ stream: true, stream_options: { include_usage: true } }),
    });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /text\/event-stream/);

    const frames = result.text
      .split('\n\n')
      .filter(Boolean)
      .map((f) => f.replace(/^data: /, ''));
    assert.equal(frames.length, 3);
    assert.equal(frames[2], '[DONE]');

    const first = JSON.parse(frames[0]);
    // Both fragments arrive in ONE delta: the response was buffered so the
    // fence strip could run, which is only possible before anything is emitted.
    assert.equal(first.choices[0].delta.content, '{"entry":"streamed"}');
    assert.equal(JSON.parse(frames[1]).choices[0].finish_reason, 'stop');
  });

  it('resolves a vendor-qualified model by splitting it when the exact id misses', async () => {
    await call('/v1/chat/completions', { method: 'POST', body: completionRequest() });
    assert.deepEqual(fake.selectors.slice(0, 2), [
      { id: 'copilot/gpt-4.1' },
      { vendor: 'copilot', id: 'gpt-4.1' },
    ]);
    assert.equal(fake.requests[0].model, 'gpt-4.1');
  });

  it('404s an unknown model with the ids the seat does offer', async () => {
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest({ model: 'copilot/gpt-9' }),
    });
    assert.equal(result.status, 404);
    const body = json(result);
    assert.equal(body.error.code, 'model_not_found');
    assert.match(body.error.message, /copilot\/gpt-4\.1/);
    assert.match(body.error.message, /\/v1\/models/);
  });

  it('turns a missing consent into a 403 that names the setup command', async () => {
    fake.denyConsent('Permission denied by the user');
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest(),
    });
    assert.equal(result.status, 403);
    const body = json(result);
    assert.equal(body.error.code, 'no_permissions');
    assert.match(body.error.message, /TestBench: Use Copilot for AI/);
    // The provider's own text survives alongside the instruction.
    assert.match(body.error.message, /Permission denied by the user/);
  });

  it('turns an exhausted seat into a 429 that prices the alternatives', async () => {
    fake.exhaustQuota('You have exhausted this month\'s premium requests');
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest(),
    });
    assert.equal(result.status, 429);
    const body = json(result);
    assert.equal(body.error.code, 'quota_exhausted');
    assert.match(body.error.message, /compiled test spends no quota/i);
    // The OpenAI SDK retries a 429 twice by default. On a bridge whose whole
    // argument is quota arithmetic, that would make the quota error the most
    // expensive one there is.
    assert.equal(result.headers.get('x-should-retry'), 'false');
  });

  it('tells the client not to retry a terminal failure, and only a terminal one', async () => {
    fake.denyConsent();
    const consent = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest(),
    });
    assert.equal(consent.headers.get('x-should-retry'), 'false');

    // A 401 is not a spend and carries no such claim.
    const unauthorized = await call('/v1/models', { auth: null });
    assert.equal(unauthorized.headers.get('x-should-retry'), null);
  });

  it('counts served model requests, for the status bar tooltip', async () => {
    const before = hooks.lmBridgeStatus().servedRequests;
    await call('/v1/chat/completions', { method: 'POST', body: completionRequest() });
    await call('/v1/models');
    assert.equal(
      hooks.lmBridgeStatus().servedRequests,
      before + 1,
      'listing models spends nothing, so it does not count',
    );
  });

  it('reports the host having no vscode.lm rather than crashing on it', async () => {
    fake.isAvailable = false;
    const result = await call('/v1/models');
    assert.equal(result.status, 503);
    assert.match(json(result).error.message, /1\.90/);
  });

  it('404s any other path, naming the two it serves', async () => {
    const result = await call('/v1/v1/chat/completions', {
      method: 'POST',
      body: completionRequest(),
    });
    assert.equal(result.status, 404);
    assert.match(json(result).error.message, /\/v1\/chat\/completions/);
  });

  it('refuses port 0 instead of binding an ephemeral port nothing can find again', async () => {
    // `listen(0)` SUCCEEDS — the OS grants a random free port. Setup would then
    // write that number into a project `.env`, where it is wrong the moment the
    // window reloads. Refusing is the only answer that keeps the file truthful.
    await setBridge({ enabled: true, at: 0 });

    const status = hooks.lmBridgeStatus();
    assert.equal(status.state, 'error');
    assert.match(status.detail, /lmBridge\.port/, 'the message names the setting');
    assert.notEqual(status.port, 0, 'gatewayUrl() must never be able to say :0');

    // And the listener it had is released rather than left serving a port the
    // settings no longer name.
    await assert.rejects(() => call('/v1/models'), /fetch failed|ECONNREFUSED/);
  });

  it('refuses an out-of-range or fractional port without throwing out of sync()', async () => {
    // `server.listen(70000)` throws SYNCHRONOUSLY, from inside the promise
    // executor — on the `void bridge.sync()` call sites that is an unhandled
    // rejection, with nothing on screen. `setBridge` awaits sync, so a throw
    // here fails this test rather than vanishing.
    await setBridge({ enabled: true, at: 70000 });
    assert.equal(hooks.lmBridgeStatus().state, 'error');
    assert.match(hooks.lmBridgeStatus().detail, /1 to 65535/);

    await setBridge({ enabled: true, at: 18790.5 });
    assert.equal(hooks.lmBridgeStatus().state, 'error');

    // Recoverable: fixing the setting brings the listener back, so a typo is not
    // a window-lifetime outage.
    const good = await freePort();
    await setBridge({ enabled: true, at: good });
    await waitFor('recovered', () => hooks.lmBridgeStatus().state === 'listening');
    assert.equal((await call('/v1/models', { at: good })).status, 200);
  });

  it('stands by on a port another window holds, and adopts it when that window closes', async () => {
    const contested = await freePort();
    const other = await squat(contested);
    try {
      await setBridge({ enabled: true, at: contested });
      await waitFor('standby', () => hooks.lmBridgeStatus().state === 'standby');
      assert.match(hooks.lmBridgeStatus().detail, /another window/);
    } finally {
      await new Promise((r) => other.close(r));
    }

    // The retry claims the port the moment it is free — without this, every
    // `.env` on the machine written with that port would point at nothing for
    // the rest of the session.
    await waitFor('adopted the port', () => hooks.lmBridgeStatus().state === 'listening', 10_000);
    assert.equal(hooks.lmBridgeStatus().port, contested);
    assert.equal((await call('/v1/models', { at: contested })).status, 200);
  });
});
