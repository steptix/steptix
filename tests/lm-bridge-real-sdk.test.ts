/**
 * The Copilot bridge's responses, parsed by the REAL client stack
 * (stories/copilot-lm-bridge.md §Part A).
 *
 * Everything else about the bridge is tested against a hand-written reader:
 * steptix-vscode's own unit tests assert the shapes it builds, and its
 * integration suite drives them over a real socket — but both sides of those
 * are ours, so a shape both agree on can still be one the OpenAI SDK rejects.
 * Here the request comes from `@pkent/aigateway` (which is the OpenAI SDK) and
 * the response is parsed by it, so the assertions are about the contract rather
 * than about our reading of it.
 *
 * This file lives in the framework's suite, not the extension's, because that is
 * where `@pkent/aigateway` is a declared dependency. It imports the extension's
 * response shapers across the package line; they import nothing at all
 * (lm-bridge-core.ts is deliberately free of `vscode` and `node:http`), so
 * there is no extension host in play.
 *
 * The model is spelled `openai/…` rather than `gateway/…`: the pinned
 * @pkent/aigateway has no `gateway` provider yet (that is rollout step 1 of the
 * story), and `openai/` with a `baseURL` is the same OpenAI-compatible client
 * the `gateway` provider will build — which is what this test is about.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AIGateway } from '@pkent/aigateway';
import {
  chatCompletionBody,
  streamFrames,
} from '../steptix-vscode/src/extension/lm-bridge-core.js';

/** What the bridge would answer with, for a fixed reply. */
const REPLY = '{"entry":"compiled"}';

interface Seen {
  authorization: string | undefined;
  body: Record<string, unknown>;
  url: string | undefined;
}

const seen: Seen[] = [];
let server: http.Server;
let baseURL: string;

/**
 * A stand-in for the bridge that answers with the bridge's OWN shapers.
 *
 * The socket, the routing and the `vscode.lm` call are not what is under test —
 * those have an extension host to prove them. What is under test is whether
 * `chatCompletionBody` and `streamFrames` produce bytes this client accepts.
 */
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      seen.push({ authorization: req.headers.authorization, body, url: req.url });

      const shape = {
        id: 'chatcmpl-test',
        created: 1_700_000_000,
        model: 'gpt-4.1',
        text: REPLY,
      };

      if (body['stream'] === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for (const frame of streamFrames(shape)) res.write(frame);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chatCompletionBody(shape)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseURL = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Built the way `AiClient.buildGateway` builds one for a routed model. */
const gateway = (): AIGateway => new AIGateway('openai/gpt-4.1', 'bridge-token', { baseURL });

describe('the bridge answers the real client stack', () => {
  it('is understood on the non-streaming path', async () => {
    const before = seen.length;
    const v2 = await gateway().chat([{ role: 'user', content: 'Compile step 1.' }], {
      maxTokens: 4096,
      responseFormat: { type: 'json_object' },
    });

    const text = v2.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    expect(text).toBe(REPLY);
    // Zero usage is what the bridge reports, and the SDK has to carry it as a
    // number rather than reading the absence as a parse failure.
    expect(v2.usage?.output_tokens).toBe(0);

    // The three things the bridge's translation layer reads off the request.
    const req = seen[before]!;
    expect(req.authorization).toBe('Bearer bridge-token');
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.body['max_completion_tokens']).toBe(4096);
    expect(req.body['max_tokens']).toBeUndefined();
  });

  it('is understood on the streaming path, one delta and a [DONE]', async () => {
    const before = seen.length;
    const stream = gateway().stream([{ role: 'user', content: 'Compile step 1.' }], {
      maxTokens: 4096,
      responseFormat: { type: 'json_object' },
    });

    let text = '';
    for await (const delta of stream) text += delta.text;
    const final = await stream.final;

    expect(text).toBe(REPLY);
    expect(final.model).toBeTruthy();

    const req = seen[before]!;
    expect(req.body['stream']).toBe(true);
    // The bridge ignores it, but it arrives on every stream — so a bridge that
    // erred on unknown fields would break every streamed compile.
    expect(req.body['stream_options']).toEqual({ include_usage: true });
  });

  it('carries an effort profile through without the bridge having to know it', async () => {
    // `retry`/`authoring` send `reasoning_effort`. The bridge drops it silently;
    // this pins that it is a field the SDK really does send, so "drop silently"
    // stays a rule about something that happens.
    const before = seen.length;
    await gateway().chat([{ role: 'user', content: 'Repair step 2.' }], {
      maxTokens: 8192,
      effort: 'medium',
      responseFormat: { type: 'json_object' },
    });

    expect(seen[before]!.body['reasoning_effort']).toBe('medium');
  });
});
