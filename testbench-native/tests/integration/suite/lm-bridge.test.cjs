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
 * one needs a signed-in Copilot seat and spends it. Only the namespace: the
 * bridge's own `vscode` layer still builds real `LanguageModelChatMessage`s,
 * so the image cases (SPEC-use-computer §15.2–15.3) see the text and data
 * parts exactly as a real model would. This harness runs VS Code 1.95, which
 * has no `LanguageModelDataPart`: feature detection says `strip` here, and the
 * forward path is driven by injecting a stand-in factory.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const vscode = require('vscode');
const { FakeLm, FakeDataPart } = require('../fakes/fake-lm.cjs');

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
    // inside a test's timeout instead of outliving the suite. No `imagePart`:
    // image support is detected on this host, as in production.
    hooks.configureLmBridge({ lm: fake, retryMs: 250 });
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
    // Measured, not zeros. The fake counts ceil(len/4) plus 4 for a message's
    // role framing, so these are derivable rather than magic:
    //   prompt     = the one folded user message, 40 chars -> 10, +4 framing
    //   completion = the RAW reply, fences and all, 32 chars -> 8
    // That completion figure is the load-bearing one. The fence-stripped text
    // the client receives is 20 chars (5 tokens), so 8 proves the bridge counts
    // what the model GENERATED rather than what survived the strip.
    assert.deepEqual(body.usage, { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 });

    // The system message folded, and the cap arrived under the only spelling
    // this wire uses.
    assert.equal(fake.requests.length, 1);
    const sent = fake.requests[0];
    assert.deepEqual(fake.sentMessages(), [
      { role: 'user', text: 'You compile test steps.\n\nCompile step 1.' },
    ]);
    // A text-only message still goes out as the plain-string overload — one
    // text part — on every host, image support or not.
    assert.equal(sent.messages[0].content.length, 1);
    assert.deepEqual(sent.options.modelOptions, { max_tokens: 4096 });
  });

  for (const { when, after } of [
    { when: 'on the first prompt message', after: 0 },
    { when: 'on the response, after the prompt counted fine', after: 1 },
  ]) {
    it(`serves the completion with zeroed usage when countTokens fails ${when}`, async () => {
      // Usage is a nicety; the answer is the product. A tokenizer that throws
      // must not turn a completion the seat already paid for into an error.
      // Both positions, because a try/catch wrapped around only the prompt
      // loop would survive the first case and throw on the second.
      fake.reply = ['{"entry":"ok"}'];
      fake.countTokensFailsWith = new Error('tokenizer unavailable');
      fake.countTokensFailsAfter = after;
      const result = await call('/v1/chat/completions', {
        method: 'POST',
        body: completionRequest(),
      });
      assert.equal(result.status, 200);
      const body = json(result);
      assert.equal(body.choices[0].message.content, '{"entry":"ok"}');
      assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    });
  }

  it('serves the completion when countTokens never settles', async () => {
    // A tokenizer that hangs is the case a try/catch cannot save you from:
    // `countTokens` takes no cancellation token, so without a bound the bridge
    // would sit on a generated answer until the client gave up at 120s and
    // discard a completion the seat had already paid for. MEASURE_BUDGET_MS
    // turns that into a served completion with no numbers.
    fake.reply = ['{"entry":"ok"}'];
    fake.countTokensHangs = true;
    const started = Date.now();
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest(),
    });
    const elapsed = Date.now() - started;
    assert.equal(result.status, 200);
    const body = json(result);
    assert.equal(body.choices[0].message.content, '{"entry":"ok"}');
    assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    // Bounded, and by the budget rather than by the mocha timeout. The budget
    // is 2s; this allows 5x for a loaded box but still fails an unbounded wait,
    // which would run to the suite timeout at 30s. A literal because
    // MEASURE_BUDGET_MS lives in a .ts module this .cjs suite cannot import.
    assert.ok(elapsed < 10_000, `served in ${elapsed}ms, which is not a bound`);
  });

  it('answers a streamed request as ONE delta then [DONE], carrying usage', async () => {
    // Fenced, so the completion count distinguishes raw from stripped HERE too:
    // raw is 32 chars (8 tokens), the stripped text the client sees is 20 (5).
    fake.reply = ['```json\n{"entry":', '"streamed"}\n```'];
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
    const finish = JSON.parse(frames[1]);
    assert.equal(finish.choices[0].finish_reason, 'stop');
    // The finish chunk is where `stream_options: {include_usage: true}` looks,
    // and zeros here are not neutral: `completeStream` reads zero-or-absent as
    // missing and estimates output at ceil(len/4). Measured numbers are the
    // only thing that stops a run reporting a figure derived from string
    // length, so this assertion is the streaming half of the whole change.
    assert.deepEqual(finish.usage, { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 });
  });

  it('counts EVERY prompt message, not just the first', async () => {
    // The default fixture folds system+user into one message, so the summation
    // loop never iterates and `prompt = count(messages[0])` would pass. An
    // assistant turn survives the fold, so this is the shape that separates
    // them. Counts, with the fake's ceil(len/4) + 4 framing per message:
    //   the folded system+user message   40 chars -> 10 + 4 = 14
    //   '{"entry":"first"}'              17 chars ->  5 + 4 =  9
    //   'Now compile step 2.'            19 chars ->  5 + 4 =  9
    // Summing gives 32; counting only the first message gives 14.
    fake.reply = ['{"entry":"second"}'];
    const result = await call('/v1/chat/completions', {
      method: 'POST',
      body: completionRequest({
        messages: [
          { role: 'system', content: 'You compile test steps.' },
          { role: 'user', content: 'Compile step 1.' },
          { role: 'assistant', content: '{"entry":"first"}' },
          { role: 'user', content: 'Now compile step 2.' },
        ],
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(json(result).usage.prompt_tokens, 32);

    // And each prompt message was counted AS A MESSAGE. A bridge that passed
    // the raw string would lose the 4 framing tokens per message on the real
    // tokenizer, silently under-reporting every prompt.
    const promptInputs = fake.counted.slice(0, -1);
    assert.equal(promptInputs.length, 3);
    for (const input of promptInputs) assert.equal(typeof input, 'object');
    // The response is counted as a plain string — it has no role to frame.
    assert.equal(typeof fake.counted[fake.counted.length - 1], 'string');
  });

  // -- images (SPEC-use-computer §15.2–15.3) --------------------------------

  /** A real PNG header, so the bytes a test compares are not all one value. */
  const PNG_B64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]).toString('base64');
  /** A literal: IMAGE_OMITTED_NOTE lives in a .ts module this .cjs suite cannot import. */
  const NOTE = '[screenshot omitted — images unsupported over the bridge]';
  const IMAGE_400 = {
    error: {
      message:
        'copilot/gpt-4.1 does not accept images. Computer mode and ai.sendScreenshots ' +
        'need a model that does — pick another Copilot model.',
      type: 'invalid_request_error',
      code: 'image_input_unsupported',
    },
  };

  /** The shape a computer-mode turn sends (src/desktop/prompt.ts): system, then [text, image]. */
  const screenshotRequest = (over = {}) =>
    completionRequest({
      messages: [
        { role: 'system', content: 'You drive the desktop.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '## Screen' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
          ],
        },
      ],
      ...over,
    });

  const hostForwards = () => typeof vscode.LanguageModelDataPart?.image === 'function';

  it('GET /v1/models says what this bridge does with images, and what each model accepts', async () => {
    fake.models = [
      // The consumer object VS Code 1.138 hands out carries supportsImageToText.
      { id: 'gpt-5.6-luna', vendor: 'copilot', family: 'gpt-5.6-luna', name: 'Luna', capabilities: { supportsImageToText: true } },
      // The provider-side spelling, in case a host ever exposes that instead.
      { id: 'text-only', vendor: 'copilot', family: 'text-only', name: 'Text', capabilities: { imageInput: false } },
      // No capabilities at all — the 1.95 shape, and the public type's.
      { id: 'gpt-4.1', vendor: 'copilot', family: 'gpt-4.1', name: 'GPT-4.1' },
    ];
    const body = json(await call('/v1/models'));
    for (const m of body.data) {
      assert.equal(typeof m.created, 'number');
      delete m.created;
    }
    // Detected on THIS host, not assumed: the harness's 1.95 has no
    // LanguageModelDataPart, so today this reads "strip".
    assert.deepEqual(body, {
      object: 'list',
      aiui_bridge: { name: 'testbench-copilot-bridge', images: hostForwards() ? 'forward' : 'strip' },
      data: [
        { id: 'copilot/gpt-5.6-luna', object: 'model', owned_by: 'copilot', family: 'gpt-5.6-luna', image_input: true },
        { id: 'copilot/text-only', object: 'model', owned_by: 'copilot', family: 'text-only', image_input: false },
        { id: 'copilot/gpt-4.1', object: 'model', owned_by: 'copilot', family: 'gpt-4.1', image_input: null },
      ],
    });
  });

  it('decides forward or strip by feature detection on this host', async () => {
    const result = await call('/v1/chat/completions', { method: 'POST', body: screenshotRequest() });
    assert.equal(result.status, 200);
    const sent = fake.requests[0].messages;
    if (hostForwards()) {
      assert.ok(sent[0].content[1] instanceof vscode.LanguageModelDataPart, 'a real data part');
      assert.deepEqual(fake.sentMessages()[0].parts[1], { image: { mime: 'image/png', base64: PNG_B64 } });
    } else {
      // No LanguageModelDataPart here: stripped, with the note in place of the
      // image, exactly as the text-only bridge always did.
      assert.deepEqual(fake.sentMessages(), [
        { role: 'user', text: `You drive the desktop.\n\n## Screen\n${NOTE}` },
      ]);
    }
  });

  it('forwards a screenshot as a data part, in order with its text, and counts only the text', async () => {
    // FakeDataPart stands in for LanguageModelDataPart, which 1.95 lacks; the
    // bridge's own vscode layer builds the message around it.
    hooks.configureLmBridge({ lm: fake, imagePart: FakeDataPart.image });
    fake.reply = ['{"action":"click"}'];
    const result = await call('/v1/chat/completions', { method: 'POST', body: screenshotRequest() });
    assert.equal(result.status, 200);

    const [message] = fake.requests[0].messages;
    assert.equal(message.role, vscode.LanguageModelChatMessageRole.User);
    assert.ok(message.content[0] instanceof vscode.LanguageModelTextPart);
    assert.ok(message.content[1] instanceof FakeDataPart);
    assert.deepEqual(fake.sentMessages(), [
      {
        role: 'user',
        parts: [
          { text: 'You drive the desktop.\n\n## Screen' },
          { image: { mime: 'image/png', base64: PNG_B64 } },
        ],
      },
    ]);

    // The fake tokenizer throws on a data part, so measured usage is the proof
    // the image never reached countTokens. With ceil(len/4) + 4 framing:
    //   'You drive the desktop.\n\n## Screen'  33 chars -> 9 + 4 = 13
    //   '{"action":"click"}'                   18 chars -> 5
    assert.deepEqual(json(result).usage, { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 });
    assert.ok(fake.counted[0].content.every((p) => p instanceof vscode.LanguageModelTextPart));

    assert.equal(json(await call('/v1/models')).aiui_bridge.images, 'forward');
  });

  it('strips with the note when the host has no image support, and says so on /v1/models', async () => {
    hooks.configureLmBridge({ lm: fake, imagePart: null });
    const result = await call('/v1/chat/completions', { method: 'POST', body: screenshotRequest() });
    assert.equal(result.status, 200);
    assert.deepEqual(fake.sentMessages(), [
      { role: 'user', text: `You drive the desktop.\n\n## Screen\n${NOTE}` },
    ]);
    assert.equal(json(await call('/v1/models')).aiui_bridge.images, 'strip');
  });

  for (const when of ['send', 'stream']) {
    it(`answers a model that refuses the image (${when}) with 400 image_input_unsupported`, async () => {
      hooks.configureLmBridge({ lm: fake, imagePart: FakeDataPart.image });
      fake.rejectImages = when;
      const result = await call('/v1/chat/completions', { method: 'POST', body: screenshotRequest() });
      assert.equal(result.status, 400);
      assert.deepEqual(json(result), IMAGE_400);
      // Never silently retried without the image — one call, and the client
      // is told not to retry it either.
      assert.equal(fake.requests.length, 1);
      assert.equal(result.headers.get('x-should-retry'), 'false');
    });
  }

  it('keeps the consent 403 for an image-carrying request — the image is not the cause', async () => {
    hooks.configureLmBridge({ lm: fake, imagePart: FakeDataPart.image });
    fake.denyConsent('Permission denied by the user');
    const result = await call('/v1/chat/completions', { method: 'POST', body: screenshotRequest() });
    assert.equal(result.status, 403);
    assert.equal(json(result).error.code, 'no_permissions');
  });

  it('the same refusing model still answers text-only requests', async () => {
    hooks.configureLmBridge({ lm: fake, imagePart: FakeDataPart.image });
    fake.rejectImages = 'send';
    const result = await call('/v1/chat/completions', { method: 'POST', body: completionRequest() });
    assert.equal(result.status, 200);
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
