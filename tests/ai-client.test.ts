import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { AiConfig } from '../src/config/types.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    trace: vi.fn(),
  },
}));

describe('AiClient v2 gateway integration', () => {
  const originalFetch = global.fetch;

  const tokenTracker = {
    addUsage: vi.fn(),
    checkStepBudget: vi.fn(),
  };

  const baseConfig: AiConfig = {
    gatewayUrl: 'https://llm.corp.example',
    apiKey: 'test-key',
    model: 'gpt-4o',
    maxInputTokens: 1_000_000,
    streamResponses: false,
    sendScreenshots: true,
    diagnoseFailures: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts non-streaming requests to /v2/vision and extracts text from content blocks', async () => {
    global.fetch = vi.fn(async (url, init) => {
      expect(url).toBe('https://llm.corp.example/v2/vision');
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer test-key');
      return new Response(JSON.stringify({
        id: 'msg_123',
        object: 'response',
        created: 1776692376,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: '{"actions":[],"reasoning":"ok"}' },
        ],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const client = new AiClient(baseConfig, tokenTracker as any);
    const result = await client.complete([{ role: 'user', content: 'Hello' }]);

    expect(result.text).toBe('{"actions":[],"reasoning":"ok"}');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(tokenTracker.addUsage).toHaveBeenCalledWith(12, 8);
    expect(tokenTracker.checkStepBudget).toHaveBeenCalledWith(1_000_000);
  });

  it('streams from /v2/stream and assembles text from provider-neutral SSE events', async () => {
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.start","response":{"id":"msg_123","object":"response","created":1776692385,"provider":"anthropic","model":"claude-sonnet-4-5","role":"assistant"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.content_block.delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.content_block.delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"msg_123","object":"response","created":1776692385,"provider":"anthropic","model":"claude-sonnet-4-5","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hello world"}],"usage":{"input_tokens":21,"output_tokens":5,"total_tokens":26}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    global.fetch = vi.fn(async (url) => {
      expect(url).toBe('https://llm.corp.example/v2/stream');
      return new Response(streamBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
    const result = await client.complete([{ role: 'user', content: 'Hello' }]);

    expect(result.text).toBe('hello world');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(tokenTracker.addUsage).toHaveBeenCalledWith(21, 5);
    expect(tokenTracker.checkStepBudget).toHaveBeenCalledWith(1_000_000);
  });

  it('passes cache hints through to aiapi v2 requests', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'Core instructions', cache: true });
      expect(body.messages[1].content[0]).toEqual({ type: 'text', text: 'Live request data' });
      return new Response(JSON.stringify({
        id: 'msg_123',
        object: 'response',
        created: 1776692376,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: '{"actions":[],"reasoning":"ok"}' },
        ],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const client = new AiClient(baseConfig, tokenTracker as any);
    await client.complete([
      { role: 'system', content: [{ type: 'text', text: 'Core instructions', cache: true }] },
      { role: 'user', content: [{ type: 'text', text: 'Live request data' }] },
    ]);
  });

  describe('syncAuth — re-point an already-bound client (saved .env edit)', () => {
    /** Minimal OK response so `complete()` resolves; we only inspect the request. */
    const okResponse = () =>
      new Response(
        JSON.stringify({
          id: 'm',
          object: 'response',
          created: 1,
          provider: 'anthropic',
          model: 'ignored',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{}' }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    it('swaps the model used on the next request and reports the change', async () => {
      let sentModel: string | undefined;
      global.fetch = vi.fn(async (_url, init) => {
        sentModel = JSON.parse(String(init?.body)).model;
        return okResponse();
      }) as typeof fetch;

      const client = new AiClient(baseConfig, tokenTracker as any);
      const change = client.syncAuth('gpt-5.4-mini', baseConfig.apiKey);

      expect(change).toBe('AI model gpt-4o → gpt-5.4-mini');
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(sentModel).toBe('gpt-5.4-mini');
    });

    it('swaps the apiKey on the next request without leaking it into the change string', async () => {
      let auth: string | null = null;
      global.fetch = vi.fn(async (_url, init) => {
        auth = (init?.headers as Headers).get('Authorization');
        return okResponse();
      }) as typeof fetch;

      const client = new AiClient(baseConfig, tokenTracker as any);
      const change = client.syncAuth(baseConfig.model, 'super-secret-key');

      expect(change).toBe('AI API key changed');
      expect(change).not.toContain('super-secret-key');
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(auth).toBe('Bearer super-secret-key');
    });

    it('reverts to the base (no Authorization header) when the key goes empty', async () => {
      let hasAuth = true;
      global.fetch = vi.fn(async (_url, init) => {
        hasAuth = (init?.headers as Headers).has('Authorization');
        return okResponse();
      }) as typeof fetch;

      const client = new AiClient(baseConfig, tokenTracker as any);
      // Mirrors recompute-from-server-base when AI_API_KEY is removed from .env.
      const change = client.syncAuth(baseConfig.model, undefined);

      expect(change).toBe('AI API key changed');
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(hasAuth).toBe(false);
    });

    it('returns null and mutates nothing when model and key are unchanged', () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      expect(client.syncAuth(baseConfig.model, baseConfig.apiKey)).toBeNull();
    });
  });

  it('keeps parsing legacy v1-style responses as a fallback during migration', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      response: '{"actions":[],"reasoning":"legacy"}',
      model: 'gpt-4o',
      usage: { input_tokens: 10, output_tokens: 4 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const client = new AiClient(baseConfig, tokenTracker as any);
    const result = await client.complete([{ role: 'user', content: 'Hello' }]);

    expect(result.text).toBe('{"actions":[],"reasoning":"legacy"}');
    expect(result.model).toBe('gpt-4o');
    expect(tokenTracker.addUsage).toHaveBeenCalledWith(10, 4);
  });
});
