/**
 * The Copilot bridge's translation table (stories/copilot-lm-bridge.md §Part A).
 *
 * Every row of that table is a rule about bytes, and every one of them is
 * here: system folding, image forwarding and stripping (SPEC-use-computer
 * §15.2–15.3), the `max_completion_tokens` spelling,
 * the fields that must be dropped SILENTLY, the fence strip, the single-delta
 * SSE framing, model-id fallback, and the error texts — which are not
 * decoration, since PR #110 carries `error.message` verbatim into step hovers
 * and panel rows, so a message that fails to name the fix leaves the user with
 * nothing.
 *
 * The module imports nothing, so all of it runs under `node --test` with no
 * extension host. What is NOT here is the socket, the token and the
 * `vscode.lm` calls; those are tests/integration/suite/lm-bridge.test.cjs.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  BRIDGE_NAME,
  IMAGE_OMITTED_NOTE,
  IMAGE_STRIP_WARNING,
  MAX_BODY_BYTES,
  ZERO_USAGE,
  bodyLimitError,
  chatCompletionBody,
  imageBytes,
  imageInputUnsupportedError,
  isAuthorized,
  isTerminalError,
  lmUnavailableError,
  mapCompletionError,
  mapLmError,
  messageText,
  modelNotFoundError,
  modelSelectorAttempts,
  modelsListBody,
  parseImageDataUrl,
  qualifiedModelId,
  routeFor,
  streamFrames,
  stripJsonFence,
  textMessage,
  textProjection,
  translateBody,
  translateRequest,
  unauthorizedError,
  unknownRouteError,
} from '../src/extension/lm-bridge-core.ts';

/** A text-only message: exactly one text part, as the translation coalesces it. */
const msg = (role, text) => ({ role, parts: [{ kind: 'text', text }] });

/** A request in the shape `@pkent/aigateway` actually builds. */
const request = (over = {}) => ({
  model: 'copilot/gpt-4.1',
  messages: [{ role: 'user', content: 'hello' }],
  max_completion_tokens: 4096,
  response_format: { type: 'json_object' },
  ...over,
});

const ok = (raw) => {
  const result = translateRequest(raw);
  assert.equal(result.ok, true, `expected a translated request, got ${JSON.stringify(result)}`);
  return result.value;
};

const refused = (raw) => {
  const result = translateRequest(raw);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.error;
};

// ---------------------------------------------------------------------------
// Routing and auth
// ---------------------------------------------------------------------------

test('the two endpoints route, and a query string or trailing slash does not hide them', () => {
  assert.equal(routeFor('GET', '/v1/models'), 'models');
  assert.equal(routeFor('get', '/v1/models/'), 'models');
  assert.equal(routeFor('POST', '/v1/chat/completions'), 'completions');
  assert.equal(routeFor('POST', '/v1/chat/completions?stream=1'), 'completions');
});

test('anything else is unknown — including the right path with the wrong verb', () => {
  assert.equal(routeFor('POST', '/v1/models'), 'unknown');
  assert.equal(routeFor('GET', '/v1/chat/completions'), 'unknown');
  assert.equal(routeFor('GET', '/'), 'unknown');
  assert.equal(routeFor('GET', '/v1/v1/models'), 'unknown');
  assert.equal(routeFor(undefined, undefined), 'unknown');
});

test('the 404 for an unknown route names both paths and the /v1 trap', () => {
  const err = unknownRouteError('POST', '/v1/v1/chat/completions');
  assert.equal(err.status, 404);
  assert.match(err.body.error.message, /\/v1\/models/);
  assert.match(err.body.error.message, /\/v1\/chat\/completions/);
  // Doubling /v1 is the mistake a hand-written AI_GATEWAY_URL makes.
  assert.match(err.body.error.message, /bare origin/);
});

test('only "Bearer <token>" with the exact token authorizes', () => {
  const token = 'a'.repeat(64);
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isAuthorized(`bearer ${token}`, token), true, 'the scheme is case-insensitive');
  assert.equal(isAuthorized(`Bearer ${'a'.repeat(63)}b`, token), false);
  assert.equal(isAuthorized(`Bearer ${'a'.repeat(63)}`, token), false, 'length must match');
  assert.equal(isAuthorized(token, token), false, 'a bare token is not a Bearer header');
  assert.equal(isAuthorized(undefined, token), false);
  assert.equal(isAuthorized(`Bearer ${token}`, ''), false, 'an unminted token authorizes nothing');
});

test('the 401 names the copied-.env case, because that is the one nobody guesses', () => {
  const err = unauthorizedError();
  assert.equal(err.status, 401);
  assert.match(err.body.error.message, /another machine/);
  assert.match(err.body.error.message, /SecretStorage/);
  assert.match(err.body.error.message, /TestBench: Use Copilot for AI/);
});

test('the 401 also names the overlay — the cause a correct .env cannot explain', () => {
  // The incident: `.env` is right, setup did run here, the token is this
  // machine's, and an active env's `.env.<name>` quietly beat all of it.
  // Unconditional, because this listener serves every window and a request
  // carries no workspace identity — there is nothing here to condition on.
  const message = unauthorizedError().body.error.message;
  assert.match(message, /testbench-native\.activeEnv/);
  assert.match(message, /\.env\.<name>/);
  assert.match(message, /AI_API_KEY over \.env/);
});

test('the 401 names the mechanism and never a token — it has none to leak', () => {
  // The expected token is in scope at the call site (isAuthorized compares it),
  // so "put the right one in the message" is a one-line change away at all
  // times. It would hand any unauthenticated caller the credential.
  const token = 'a'.repeat(64);
  const message = unauthorizedError().body.error.message;
  assert.equal(unauthorizedError.length, 0, 'the builder cannot even be given a token');
  assert.ok(!message.includes(token));
  assert.doesNotMatch(message, /[0-9a-f]{32}/, 'nothing token-shaped survives in the text');
});

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

test('a system message folds into the first user message — vscode.lm has no system role', () => {
  const value = ok(
    request({
      messages: [
        { role: 'system', content: 'You are a test compiler.' },
        { role: 'user', content: 'Compile step 3.' },
      ],
    }),
  );
  assert.deepEqual(value.messages, [
    msg('user', 'You are a test compiler.\n\nCompile step 3.'),
  ]);
});

test('several system messages join in order, ahead of the first user message only', () => {
  const value = ok(
    request({
      messages: [
        { role: 'system', content: 'One.' },
        { role: 'system', content: 'Two.' },
        { role: 'user', content: 'First user.' },
        { role: 'assistant', content: 'An answer.' },
        { role: 'user', content: 'Second user.' },
      ],
    }),
  );
  assert.deepEqual(value.messages, [
    msg('user', 'One.\n\nTwo.\n\nFirst user.'),
    msg('assistant', 'An answer.'),
    msg('user', 'Second user.'),
  ]);
});

test('a request with only a system message still arrives as a user message', () => {
  const value = ok(request({ messages: [{ role: 'system', content: 'Just this.' }] }));
  assert.deepEqual(value.messages, [msg('user', 'Just this.')]);
});

test('"developer" folds like "system" — the same role under OpenAI\'s newer name', () => {
  const value = ok(
    request({
      messages: [
        { role: 'developer', content: 'Rules.' },
        { role: 'user', content: 'Go.' },
      ],
    }),
  );
  assert.deepEqual(value.messages, [msg('user', 'Rules.\n\nGo.')]);
});

test('an unrecognised role lands as user rather than being dropped', () => {
  const value = ok(request({ messages: [{ role: 'tool', content: 'tool output' }] }));
  assert.deepEqual(value.messages, [msg('user', 'tool output')]);
});

test('text blocks are joined', () => {
  const value = ok(
    request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(value.messages, [msg('user', 'first\nsecond')]);
});

test('image blocks are stripped, leaving an inline note and a count for the warning', () => {
  const value = ok(
    request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Why did this fail?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(value.messages, [
    msg('user', `Why did this fail?\n${IMAGE_OMITTED_NOTE}`),
  ]);
  assert.equal(value.imagesStripped, 1);
});

test('an image-only message is not dropped — the note keeps the turn alive', () => {
  const value = ok(
    request({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    }),
  );
  assert.deepEqual(value.messages, [msg('user', IMAGE_OMITTED_NOTE)]);
  assert.equal(value.imagesStripped, 1);
});

test('a request with no images reports none, so the warning stays quiet', () => {
  assert.equal(ok(request()).imagesStripped, 0);
  assert.equal(ok(request()).imagesForwarded, 0);
});

// ---------------------------------------------------------------------------
// Image forwarding (SPEC-use-computer §15.2)
// ---------------------------------------------------------------------------

/** Real PNG bytes: the 8-byte signature, then the start of an IHDR chunk. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0xff, 0xfe, 0xfd, 0x00,
]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const imageBlock = (url = PNG_URL) => ({ type: 'image_url', image_url: { url } });
const forward = (raw) => {
  const result = translateRequest(raw, { imageMode: 'forward' });
  assert.equal(result.ok, true, `expected a translated request, got ${JSON.stringify(result)}`);
  return result.value;
};

test('a data: URL decodes to the exact bytes and mime it encoded', () => {
  const parsed = parseImageDataUrl(PNG_URL);
  assert.deepEqual(parsed, { mime: 'image/png', base64: PNG_B64 });
  const bytes = imageBytes({ kind: 'image', ...parsed });
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [...PNG_BYTES]);
  // Its own buffer, not a view into Node's shared pool: a consumer that reads
  // `.buffer` without the offset must still see only these bytes.
  assert.equal(bytes.byteOffset, 0);
  assert.equal(bytes.buffer.byteLength, PNG_BYTES.length);
});

test('the data: URL parser lower-cases the mime, tolerates parameters, and refuses the rest', () => {
  assert.equal(parseImageDataUrl(`data:IMAGE/JPEG;base64,${PNG_B64}`).mime, 'image/jpeg');
  assert.equal(parseImageDataUrl(`data:image/png;name=a.png;base64,${PNG_B64}`).base64, PNG_B64);
  assert.equal(parseImageDataUrl('https://example.test/shot.png'), null, 'not fetched');
  assert.equal(parseImageDataUrl(`data:text/plain;base64,${PNG_B64}`), null, 'not an image');
  assert.equal(parseImageDataUrl('data:image/png,rawbytes'), null, 'not base64');
  assert.equal(parseImageDataUrl('data:image/png;base64,'), null, 'empty');
  // Buffer.from would quietly skip the bad characters and decode a different image.
  assert.equal(parseImageDataUrl('data:image/png;base64,iVBO$$RK'), null, 'corrupt payload');
});

test('forward: text and image parts keep their order inside one user message', () => {
  const value = forward(
    request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Before.' },
            imageBlock(),
            { type: 'text', text: 'After, line 1.' },
            { type: 'text', text: 'After, line 2.' },
            imageBlock(`data:image/jpeg;base64,${PNG_B64}`),
          ],
        },
      ],
    }),
  );
  assert.deepEqual(value.messages, [
    {
      role: 'user',
      parts: [
        { kind: 'text', text: 'Before.' },
        { kind: 'image', mime: 'image/png', base64: PNG_B64 },
        // Adjacent text still coalesces with \n — only an image splits a run.
        { kind: 'text', text: 'After, line 1.\nAfter, line 2.' },
        { kind: 'image', mime: 'image/jpeg', base64: PNG_B64 },
      ],
    },
  ]);
  assert.equal(value.imagesForwarded, 2);
  assert.equal(value.imagesStripped, 0);
});

test('forward: the shape the computer-mode turn sends — system folded ahead of text + screenshot', () => {
  // src/desktop/prompt.ts: one user message, [text, image_url], after a system prompt.
  const value = forward(
    request({
      messages: [
        { role: 'system', content: 'You drive the desktop.' },
        { role: 'user', content: [{ type: 'text', text: '## Screen' }, imageBlock()] },
      ],
    }),
  );
  assert.deepEqual(value.messages, [
    {
      role: 'user',
      parts: [
        { kind: 'text', text: 'You drive the desktop.\n\n## Screen' },
        { kind: 'image', mime: 'image/png', base64: PNG_B64 },
      ],
    },
  ]);
});

test('forward: an image-first user message gets the folded system text as a part in front', () => {
  const value = forward(
    request({
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'user', content: [imageBlock(), { type: 'text', text: 'What is this?' }] },
      ],
    }),
  );
  assert.deepEqual(value.messages[0].parts.map((p) => p.kind), ['text', 'image', 'text']);
  assert.equal(value.messages[0].parts[0].text, 'Rules.');
});

test('forward: an image-only user message is kept, as a single image part', () => {
  const value = forward(request({ messages: [{ role: 'user', content: [imageBlock()] }] }));
  assert.deepEqual(value.messages, [
    { role: 'user', parts: [{ kind: 'image', mime: 'image/png', base64: PNG_B64 }] },
  ]);
});

test('strip is the default and is byte-for-byte the text-only bridge', () => {
  const raw = request({
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Why did this fail?' }, imageBlock(), { type: 'text', text: 'Thanks.' }],
      },
    ],
  });
  const expected = [msg('user', `Why did this fail?\n${IMAGE_OMITTED_NOTE}\nThanks.`)];
  assert.deepEqual(ok(raw).messages, expected, 'no options: strip');
  const explicit = translateRequest(raw, { imageMode: 'strip' }).value;
  assert.deepEqual(explicit.messages, expected);
  assert.equal(explicit.imagesStripped, 1);
  assert.equal(explicit.imagesForwarded, 0);
});

test('forward: a non-data URL is stripped with the note — the bridge fetches nothing', () => {
  const value = forward(
    request({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Look:' }, imageBlock('https://example.test/shot.png')],
        },
      ],
    }),
  );
  assert.deepEqual(value.messages, [msg('user', `Look:\n${IMAGE_OMITTED_NOTE}`)]);
  assert.equal(value.imagesStripped, 1);
  assert.equal(value.imagesForwarded, 0);
});

test('forward: an image in an assistant message is stripped; the user image beside it is not', () => {
  const value = forward(
    request({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Q' }, imageBlock()] },
        { role: 'assistant', content: [{ type: 'text', text: 'A' }, imageBlock()] },
      ],
    }),
  );
  assert.deepEqual(value.messages[1], msg('assistant', `A\n${IMAGE_OMITTED_NOTE}`));
  assert.equal(value.messages[0].parts[1].kind, 'image');
  assert.equal(value.imagesStripped, 1);
  assert.equal(value.imagesForwarded, 1);
});

test('forward: an image in a system message strips — the fold is a text join, unchanged', () => {
  const value = forward(
    request({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Sys' }, imageBlock()] },
        { role: 'user', content: 'Go.' },
      ],
    }),
  );
  assert.deepEqual(value.messages, [msg('user', `Sys\n${IMAGE_OMITTED_NOTE}\n\nGo.`)]);
  assert.equal(value.imagesStripped, 1);
});

test('the strip count counts every image dropped, across messages and modes', () => {
  const raw = request({
    messages: [
      { role: 'system', content: [imageBlock()] },
      { role: 'user', content: [imageBlock(), imageBlock('https://x.test/a.png')] },
      { role: 'assistant', content: [imageBlock()] },
      { role: 'user', content: [{ type: 'input_image', image_url: PNG_URL }] },
    ],
  });
  const stripped = ok(raw);
  assert.equal(stripped.imagesStripped, 5);
  assert.equal(stripped.imagesForwarded, 0);
  const forwarded = forward(raw);
  // Forwarded: the user data: URL and the input_image string form. Stripped:
  // the system one, the https one, the assistant one.
  assert.equal(forwarded.imagesForwarded, 2);
  assert.equal(forwarded.imagesStripped, 3);
});

test('the strip warning says why: this VS Code, not the model', () => {
  assert.match(IMAGE_STRIP_WARNING, /this VS Code has no image support for language models/);
  assert.match(IMAGE_STRIP_WARNING, /computer-mode/);
  assert.match(IMAGE_STRIP_WARNING, /ai\.sendScreenshots/);
  assert.match(IMAGE_STRIP_WARNING, /diagnosis/);
});

test('counting sees text only: the projection drops images and keeps the role', () => {
  const withImage = {
    role: 'user',
    parts: [
      { kind: 'text', text: 'a' },
      { kind: 'image', mime: 'image/png', base64: PNG_B64 },
      { kind: 'text', text: 'b' },
    ],
  };
  assert.deepEqual(textProjection(withImage), msg('user', 'a\nb'));
  assert.equal(messageText(withImage), 'a\nb');
  const imageOnly = { role: 'user', parts: [{ kind: 'image', mime: 'image/png', base64: PNG_B64 }] };
  assert.deepEqual(textProjection(imageOnly), msg('user', ''));
  // A text-only message is passed through untouched.
  const plain = textMessage('assistant', 'x');
  assert.equal(textProjection(plain), plain);
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test('max_completion_tokens is the cap that arrives, and it reaches modelOptions', () => {
  assert.deepEqual(ok(request({ max_completion_tokens: 8192 })).modelOptions, {
    max_tokens: 8192,
  });
});

test('max_tokens never appears on this wire, so it is not read', () => {
  const value = ok(request({ max_completion_tokens: undefined, max_tokens: 512 }));
  assert.deepEqual(value.modelOptions, {}, 'the aigateway client only ever sends the other name');
});

test('reasoning_effort, stream_options, temperature and unknowns drop SILENTLY', () => {
  // The retry/authoring profiles send effort and every stream carries
  // stream_options; erroring on either would break the paths this exists for.
  const value = ok(
    request({
      reasoning_effort: 'high',
      stream_options: { include_usage: true },
      temperature: 0.2,
      some_future_field: { nested: true },
    }),
  );
  assert.deepEqual(value.modelOptions, { max_tokens: 4096 });
  assert.equal(value.messages.length, 1);
});

test('response_format json_object is recognised; anything else is not', () => {
  assert.equal(ok(request()).wantsJson, true);
  assert.equal(ok(request({ response_format: { type: 'text' } })).wantsJson, false);
  assert.equal(ok(request({ response_format: undefined })).wantsJson, false);
});

test('stream is a strict true', () => {
  assert.equal(ok(request({ stream: true })).stream, true);
  assert.equal(ok(request({ stream: 'true' })).stream, false);
  assert.equal(ok(request()).stream, false);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a missing model is refused with the AI_MODEL spelling and the models endpoint', () => {
  const err = refused(request({ model: undefined }));
  assert.equal(err.status, 400);
  assert.match(err.body.error.message, /gateway\//);
  assert.match(err.body.error.message, /\/v1\/models/);
});

test('missing messages, a non-object body and content-free messages are all refused', () => {
  assert.equal(refused(request({ messages: [] })).status, 400);
  assert.equal(refused(request({ messages: 'hello' })).status, 400);
  assert.equal(refused('not an object').status, 400);
  assert.equal(refused(request({ messages: [{ role: 'user', content: '' }] })).status, 400);
});

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

test('a vendor-qualified id tries the exact id first, then the vendor split', () => {
  assert.deepEqual(modelSelectorAttempts('copilot/gpt-4.1'), [
    { id: 'copilot/gpt-4.1' },
    { vendor: 'copilot', id: 'gpt-4.1' },
    { vendor: 'copilot', family: 'gpt-4.1' },
  ]);
});

test('a bare id falls back to family — ids are opaque, family is the readable name', () => {
  assert.deepEqual(modelSelectorAttempts('gpt-4.1'), [{ id: 'gpt-4.1' }, { family: 'gpt-4.1' }]);
});

test('a stray leading or trailing slash does not produce an empty vendor', () => {
  assert.deepEqual(modelSelectorAttempts('/gpt-4.1'), [
    { id: '/gpt-4.1' },
    { family: '/gpt-4.1' },
  ]);
  assert.deepEqual(modelSelectorAttempts('copilot/'), [
    { id: 'copilot/' },
    { family: 'copilot/' },
  ]);
});

test('the qualified id is what .env carries after gateway/', () => {
  assert.equal(qualifiedModelId({ vendor: 'copilot', id: 'gpt-4.1' }), 'copilot/gpt-4.1');
});

// ---------------------------------------------------------------------------
// json_object emulation
// ---------------------------------------------------------------------------

test('one fenced block is unwrapped, tag or no tag', () => {
  assert.equal(stripJsonFence('```json\n{"entry":1}\n```'), '{"entry":1}');
  assert.equal(stripJsonFence('```\n{"entry":1}\n```'), '{"entry":1}');
  assert.equal(stripJsonFence('  ```json\n{"entry":1}\n```  '), '{"entry":1}');
});

test('unfenced JSON is returned untouched', () => {
  assert.equal(stripJsonFence('{"entry":1}'), '{"entry":1}');
});

test('exactly ONE pair comes off — an inner fence belongs to the content', () => {
  assert.equal(
    stripJsonFence('```\n{"entry":"```code```"}\n```'),
    '{"entry":"```code```"}',
  );
});

test('a fence that does not bracket the whole response is left alone', () => {
  const text = 'Here you go:\n```json\n{"entry":1}\n```';
  assert.equal(stripJsonFence(text), text);
});

test('an unterminated fence is left alone rather than truncated', () => {
  const text = '```json\n{"entry":1}';
  assert.equal(stripJsonFence(text), text);
});

test('a lone ``` line is not treated as a fence', () => {
  assert.equal(stripJsonFence('```'), '```');
});

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

const usage = { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 };
const shape = {
  id: 'chatcmpl-1',
  created: 1_700_000_000,
  model: 'copilot/gpt-4.1',
  text: '{"a":1}',
  usage,
};

test('the non-streaming body is a complete OpenAI chat.completion', () => {
  const body = chatCompletionBody(shape);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'copilot/gpt-4.1');
  assert.deepEqual(body.choices[0].message, { role: 'assistant', content: '{"a":1}' });
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, usage);
});

test('neither builder hands out a reference to the usage it was given', () => {
  // ZERO_USAGE is a module-level singleton and every fallback spreads it. If a
  // builder aliased instead of copying, one consumer mutating `body.usage`
  // would poison that constant for the extension host's lifetime — so the
  // mutation has to be applied to what came OUT and checked against what went
  // IN. (Mutating a second body built from a different object proves nothing:
  // that passes against an aliasing implementation too.)
  const body = chatCompletionBody(shape);
  body.usage.prompt_tokens = 999;
  assert.equal(shape.usage.prompt_tokens, 41);

  const finish = JSON.parse(streamFrames(shape)[1].replace(/^data: /, ''));
  finish.usage.completion_tokens = 999;
  assert.equal(shape.usage.completion_tokens, 7);
});

test('ZERO_USAGE cannot be mutated by a consumer that forgets to copy', () => {
  // Frozen rather than trusted: the fallback is reached exactly when something
  // has already gone wrong, which is the worst moment to also corrupt state
  // every later request reads.
  assert.throws(() => {
    ZERO_USAGE.prompt_tokens = 1;
  }, TypeError);
  assert.deepEqual(ZERO_USAGE, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});
test('a streamed response is ONE delta, a finish chunk, then [DONE]', () => {
  const frames = streamFrames(shape);
  assert.equal(frames.length, 3);

  const first = JSON.parse(frames[0].replace(/^data: /, ''));
  assert.equal(first.object, 'chat.completion.chunk');
  assert.deepEqual(first.choices[0].delta, { role: 'assistant', content: '{"a":1}' });
  assert.equal(first.choices[0].finish_reason, null);

  const second = JSON.parse(frames[1].replace(/^data: /, ''));
  assert.deepEqual(second.choices[0].delta, {});
  assert.equal(second.choices[0].finish_reason, 'stop');
  // stream_options: {include_usage: true} rides on every streamed request, so
  // the finish chunk carries usage. Real numbers here are what stop
  // completeStream treating it as missing and estimating output at len/4.
  assert.deepEqual(second.usage, usage);

  assert.equal(frames[2], 'data: [DONE]\n\n');
  for (const frame of frames) assert.ok(frame.endsWith('\n\n'), 'each frame terminates the event');
});

test('/v1/models advertises the vendor-qualified id, ready to paste after gateway/', () => {
  const body = modelsListBody(
    [
      { id: 'gpt-4.1', vendor: 'copilot', family: 'gpt-4.1' },
      { id: 'claude-sonnet-4', vendor: 'copilot', family: 'claude-sonnet-4' },
    ],
    1_700_000_000,
    'forward',
  );
  assert.equal(body.object, 'list');
  assert.deepEqual(
    body.data.map((m) => m.id),
    ['copilot/gpt-4.1', 'copilot/claude-sonnet-4'],
  );
  assert.equal(body.data[0].owned_by, 'copilot');
  assert.equal(body.data[0].object, 'model');
});

test('/v1/models carries aiui_bridge and a per-model image_input, exactly as §15.3', () => {
  const models = [
    { id: 'gpt-5.6-luna', vendor: 'copilot', family: 'gpt-5.6-luna', imageInput: true },
    { id: 'text-only', vendor: 'copilot', family: 'text-only', imageInput: false },
    { id: 'unknown', vendor: 'copilot', family: 'unknown', imageInput: null },
    { id: 'no-field', vendor: 'copilot', family: 'no-field' },
  ];
  const body = modelsListBody(models, 1_700_000_000, 'forward');
  assert.deepEqual(body.aiui_bridge, { name: 'testbench-copilot-bridge', images: 'forward' });
  assert.equal(BRIDGE_NAME, 'testbench-copilot-bridge');
  assert.deepEqual(
    body.data.map((m) => m.image_input),
    [true, false, null, null],
    'absent is reported as null — "forwarded; the model decides"',
  );
  assert.deepEqual(body.data[0], {
    id: 'copilot/gpt-5.6-luna',
    object: 'model',
    created: 1_700_000_000,
    owned_by: 'copilot',
    family: 'gpt-5.6-luna',
    image_input: true,
  });
  assert.deepEqual(modelsListBody(models, 0, 'strip').aiui_bridge, {
    name: 'testbench-copilot-bridge',
    images: 'strip',
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('NoPermissions sends the user back to the setup command, and says why', () => {
  const err = mapLmError({ code: 'NoPermissions', message: 'consent required' });
  assert.equal(err.status, 403);
  assert.match(err.body.error.message, /TestBench: Use Copilot for AI/);
  // The reason the command exists at all: an HTTP-triggered call can never
  // raise the dialog.
  assert.match(err.body.error.message, /user-initiated/);
  assert.match(err.body.error.message, /consent required/, 'the provider text survives');
});

test('Blocked is the documented quota code, and the text prices the alternatives', () => {
  const err = mapLmError({ code: 'Blocked', message: 'quota exceeded' });
  assert.equal(err.status, 429);
  assert.equal(err.body.error.code, 'quota_exhausted');
  assert.match(err.body.error.message, /premium request/i);
  assert.match(err.body.error.message, /resets monthly/);
  assert.match(err.body.error.message, /compiled test spends no quota/i);
});

test('a quota failure reported as Unknown is still read as quota', () => {
  const err = mapLmError({ code: 'Unknown', message: 'You have exhausted your premium requests.' });
  assert.equal(err.status, 429);
  assert.equal(err.body.error.code, 'quota_exhausted');
});

test('NotFound means the model went away — rerun setup and re-pick', () => {
  const err = mapLmError({ code: 'NotFound', message: 'no such model' }, { model: 'copilot/gpt-4.1' });
  assert.equal(err.status, 404);
  assert.match(err.body.error.message, /copilot\/gpt-4\.1/);
  assert.match(err.body.error.message, /subscription tier/);
  assert.match(err.body.error.message, /TestBench: Use Copilot for AI/);
});

test('an unclassified failure keeps the provider message instead of inventing one', () => {
  const err = mapLmError({ code: 'Unknown', message: 'socket hang up' });
  assert.equal(err.status, 502);
  assert.equal(err.body.error.code, 'lm_error');
  assert.match(err.body.error.message, /socket hang up/);
});

test('a failure with no message at all still says something', () => {
  const err = mapLmError({});
  assert.equal(err.status, 502);
  assert.match(err.body.error.message, /No message was reported/);
});

test('an unresolvable model 404s with the ids the seat actually offers', () => {
  const err = modelNotFoundError('copilot/gpt-9', ['copilot/gpt-4.1', 'copilot/claude-sonnet-4']);
  assert.equal(err.status, 404);
  assert.match(err.body.error.message, /copilot\/gpt-9/);
  assert.match(err.body.error.message, /copilot\/gpt-4\.1/);
  assert.match(err.body.error.message, /\/v1\/models/);
});

test('an unresolvable model on an empty seat says "sign in" rather than listing nothing', () => {
  const err = modelNotFoundError('copilot/gpt-4.1', []);
  assert.match(err.body.error.message, /no models at all/);
  assert.match(err.body.error.message, /[Ss]ign in/);
});

test('a host below the 1.90 floor gets the version, not a stack trace', () => {
  const err = lmUnavailableError();
  assert.equal(err.status, 503);
  assert.match(err.body.error.message, /1\.90/);
});

test('every model-touching failure is terminal — the SDK retries 429/5xx twice by default', () => {
  // Without this the quota-exhausted error, of all of them, costs three calls
  // into vscode.lm instead of one.
  assert.equal(isTerminalError(mapLmError({ code: 'Blocked' })), true, 'quota');
  assert.equal(isTerminalError(mapLmError({ code: 'NoPermissions' })), true, 'consent');
  assert.equal(isTerminalError(mapLmError({ code: 'NotFound' })), true, 'model gone');
  assert.equal(isTerminalError(mapLmError({ code: 'Unknown' })), true, 'unclassified');
  assert.equal(isTerminalError(lmUnavailableError()), true, 'no lm namespace');
  assert.equal(isTerminalError(modelNotFoundError('x', [])), true, 'unresolvable model');
});

test('a bad request is not marked terminal — nothing was spent and nothing is claimed', () => {
  assert.equal(isTerminalError(unauthorizedError()), false);
  assert.equal(isTerminalError(unknownRouteError('GET', '/nope')), false);
});

// --- a model that rejects images (§15.2) -----------------------------------

test('the image 400 is exactly the contract the server codes against', () => {
  const err = imageInputUnsupportedError('copilot/gpt-4.1');
  assert.equal(err.status, 400);
  assert.equal(
    JSON.stringify(err.body),
    '{"error":{"message":"copilot/gpt-4.1 does not accept images. Computer mode and ' +
      'ai.sendScreenshots need a model that does — pick another Copilot model.",' +
      '"type":"invalid_request_error","code":"image_input_unsupported"}}',
  );
  // The model WAS called: a retry would send the same image to the same model.
  assert.equal(isTerminalError(err), true);
});

const imageCtx = (over = {}) => ({
  model: 'copilot/gpt-4.1',
  imagesForwarded: 1,
  imageInput: null,
  cancelled: false,
  ...over,
});

test('an unclassified failure of an image-carrying request is image_input_unsupported', () => {
  const unclassified = { name: 'Error', message: 'Request Failed: 400 bad request' };
  for (const imageInput of [null, false]) {
    const err = mapCompletionError(unclassified, imageCtx({ imageInput }));
    assert.equal(err.status, 400, `imageInput ${imageInput}`);
    assert.equal(err.body.error.code, 'image_input_unsupported');
    assert.match(err.body.error.message, /^copilot\/gpt-4\.1 does not accept images\./);
  }
  // The same failure with no image in the request is the ordinary 502.
  const plain = mapCompletionError(unclassified, imageCtx({ imagesForwarded: 0 }));
  assert.equal(plain.status, 502);
  assert.equal(plain.body.error.code, 'lm_error');
});

test('consent, quota and a vanished model keep their mapping, images or not', () => {
  // Each names a cause that is not the image and a fix that is not "pick
  // another model"; relabelling would send the user to the wrong fix.
  const cases = [
    [{ code: 'NoPermissions', message: 'denied' }, 403, 'no_permissions'],
    [{ code: 'Blocked', message: 'quota' }, 429, 'quota_exhausted'],
    [{ code: 'Unknown', message: 'You have exhausted your premium requests.' }, 429, 'quota_exhausted'],
    [{ code: 'NotFound', message: 'gone' }, 404, 'model_not_found'],
  ];
  for (const [shape, status, code] of cases) {
    for (const imageInput of [null, false, true]) {
      const err = mapCompletionError(shape, imageCtx({ imageInput }));
      assert.equal(err.status, status, `${shape.code} with an image`);
      assert.equal(err.body.error.code, code);
    }
  }
});

test('a cancelled image request is not blamed on the model', () => {
  const byFlag = mapCompletionError({ name: 'Error', message: 'x' }, imageCtx({ cancelled: true }));
  assert.equal(byFlag.body.error.code, 'lm_error');
  // vscode.CancellationError is named "Canceled"; an AbortSignal's is AbortError.
  for (const name of ['Canceled', 'AbortError']) {
    const err = mapCompletionError({ name, message: name }, imageCtx());
    assert.notEqual(err.body.error.code, 'image_input_unsupported', name);
  }
});

test('a model that advertises image input keeps the provider\'s own failure', () => {
  // Its capabilities contradict "does not accept images", so the 502 with the
  // provider text is the more truthful answer.
  const err = mapCompletionError({ message: 'socket hang up' }, imageCtx({ imageInput: true }));
  assert.equal(err.status, 502);
  assert.match(err.body.error.message, /socket hang up/);
});

// --- the two refusals that happen before translateRequest ever sees a value --

test('a body that is not JSON is a 400 carrying the parser\'s own complaint', () => {
  // The OpenAI SDK surfaces `error.message` verbatim, and PR #110 puts it in
  // step hovers — so "not JSON" alone would leave the author with a bridge that
  // rejects and no way to see what it read.
  const result = translateBody('{"model": "copilot/gpt-4.1", messages:');
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 400);
  assert.equal(result.error.body.error.code, 'bad_request');
  assert.match(result.error.body.error.message, /not JSON/);
  assert.ok(
    result.error.body.error.message.length >
      'The request body is not JSON: '.length,
    'the parser\'s message is appended, not swallowed',
  );
});

test('an empty body is a 400 rather than a crash on JSON.parse', () => {
  const result = translateBody('');
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 400);
});

test('valid JSON goes straight through to translateRequest', () => {
  // The guard must not become the whole function: a well-formed body still has
  // to arrive translated, which is the case a "bad JSON is refused" test alone
  // would let a `return null` swallow.
  const result = translateBody(JSON.stringify(request()));
  assert.equal(result.ok, true);
  assert.equal(result.value.model, 'copilot/gpt-4.1');
});

test('valid JSON that is not an object is refused by translateRequest, not by the parser', () => {
  const result = translateBody('[1,2,3]');
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 400);
  assert.match(result.error.body.error.message, /must be a JSON object/);
});

test('the body cap allows exactly the cap and refuses one byte past it', () => {
  assert.equal(bodyLimitError(0), null);
  assert.equal(bodyLimitError(MAX_BODY_BYTES - 1), null);
  assert.equal(bodyLimitError(MAX_BODY_BYTES), null, 'the cap itself is allowed');

  const err = bodyLimitError(MAX_BODY_BYTES + 1);
  assert.equal(err.status, 413);
  assert.equal(err.body.error.code, 'payload_too_large');
  assert.match(err.body.error.message, new RegExp(String(MAX_BODY_BYTES)));
});

test('the 413 is not terminal — the caller may legitimately retry a smaller prompt', () => {
  assert.equal(isTerminalError(bodyLimitError(MAX_BODY_BYTES + 1)), false);
});

test('the body cap admits a realistic screenshot turn, and translates it', () => {
  // ~800 KB of base64 — past the few hundred KB a 1600×670 PNG measures — plus
  // a system prompt and a 200 KB page snapshot, serialized the way the OpenAI
  // SDK sends it.
  const pngBase64 = Buffer.alloc(600 * 1024, 0xa5).toString('base64');
  assert.ok(pngBase64.length >= 800 * 1024);
  const body = JSON.stringify(
    request({
      messages: [
        { role: 'system', content: 'You drive the desktop. '.repeat(400) },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x'.repeat(200 * 1024) },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } },
          ],
        },
      ],
    }),
  );
  const size = Buffer.byteLength(body);
  assert.equal(bodyLimitError(size), null, `${size} bytes refused`);
  // And the worst case the cap comment claims: a 1600×1600 RGBA PNG that does
  // not compress at all, as base64, beside a 1 MB snapshot.
  assert.equal(bodyLimitError(Math.ceil((1600 * 1600 * 4) / 3) * 4 + 1024 * 1024), null);

  const result = translateBody(body, { imageMode: 'forward' });
  assert.equal(result.ok, true);
  const image = result.value.messages[0].parts[1];
  assert.equal(image.kind, 'image');
  assert.equal(image.base64, pngBase64, 'the payload survives intact');
});
