import { beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * One shared `create` spy that every mock client instance delegates to, so a
 * test can inspect the request regardless of which (rebuilt) client made it.
 * `createImpl` lets each test swap in the response (or async-iterable stream).
 */
const createMock = vi.fn();
let createImpl: (...args: any[]) => any = async () => ({ choices: [], model: 'unset' });

/** Records every `new OpenAI(...)` call so tests can assert construction args + rebuild count. */
const constructorMock = vi.fn();

vi.mock('openai', () => {
  class FakeOpenAI {
    chat: { completions: { create: typeof createMock } };
    constructor(opts: any) {
      constructorMock(opts);
      this.chat = { completions: { create: createMock } };
    }
  }
  return { default: FakeOpenAI };
});

/** Build an OpenAI-shaped non-streaming chat.completion object. */
function chatCompletion(opts: {
  content?: string;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1776692376,
    model: opts.model ?? 'gpt-4o',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: opts.content ?? '{}' },
      },
    ],
    usage: opts.usage,
  };
}

/** Build an async-iterable of streaming chunks for the `stream:true` path. */
function streamChunks(chunks: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe('AiClient — openai SDK gateway integration', () => {
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
    createImpl = async () => ({ choices: [], model: 'unset' });
    createMock.mockImplementation((...args: any[]) => createImpl(...args));
  });

  it('builds the openai client against the gateway /v1 surface with no retries', () => {
    new AiClient(baseConfig, tokenTracker as any);
    expect(constructorMock).toHaveBeenCalledTimes(1);
    expect(constructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://llm.corp.example/v1',
        apiKey: 'test-key',
        maxRetries: 0,
      }),
    );
  });

  it('sends a non-streaming request with the right shape and maps back {text,model}', async () => {
    let sawArgs: any;
    let sawOpts: any;
    createImpl = async (args: any, opts: any) => {
      sawArgs = args;
      sawOpts = opts;
      return chatCompletion({
        content: '{"actions":[],"reasoning":"ok"}',
        model: 'claude-sonnet-4-5',
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    };

    const client = new AiClient(baseConfig, tokenTracker as any);
    const result = await client.complete([{ role: 'user', content: 'Hello' }]);

    // Request shape
    expect(sawArgs.model).toBe('gpt-4o');
    expect(sawArgs.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(sawArgs.max_completion_tokens).toBe(4096);
    expect(sawArgs.response_format).toEqual({ type: 'json_object' });
    expect(sawArgs.stream).toBeUndefined();
    // Signal forwarded as a composite AbortSignal (timeout-only when no run signal)
    expect(sawOpts.signal).toBeInstanceOf(AbortSignal);
    expect(sawOpts.signal.aborted).toBe(false);

    // Map-back + token accounting (prompt_tokens/completion_tokens, NOT v2 input/output)
    expect(result.text).toBe('{"actions":[],"reasoning":"ok"}');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(tokenTracker.addUsage).toHaveBeenCalledWith(12, 8);
    expect(tokenTracker.checkStepBudget).toHaveBeenCalledWith(1_000_000);
  });

  it('falls back to the configured model when the response omits one', async () => {
    createImpl = async () =>
      chatCompletion({ content: '{}', model: '', usage: { prompt_tokens: 1, completion_tokens: 1 } });

    const client = new AiClient(baseConfig, tokenTracker as any);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.model).toBe('gpt-4o');
  });

  it('throws on empty content and does not invent a result', async () => {
    // Minimum scenario: a 200 with empty content + no usage must NOT silently pass.
    createImpl = async () => chatCompletion({ content: '', model: 'gpt-4o' });

    const client = new AiClient(baseConfig, tokenTracker as any);
    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(/no content/i);
    // No usage block → tokenTracker untouched on this path.
    expect(tokenTracker.addUsage).not.toHaveBeenCalled();
    expect(tokenTracker.checkStepBudget).not.toHaveBeenCalled();
  });

  it('streams: assembles text from deltas and uses final-chunk usage', async () => {
    let sawArgs: any;
    createImpl = async (args: any) => {
      sawArgs = args;
      return streamChunks([
        { choices: [{ delta: { content: 'hello ' } }], model: 'claude-sonnet-4-5' },
        { choices: [{ delta: { content: 'world' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
        },
      ]);
    };

    const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
    const result = await client.complete([{ role: 'user', content: 'Hello' }]);

    expect(sawArgs.stream).toBe(true);
    expect(sawArgs.stream_options).toEqual({ include_usage: true });
    expect(sawArgs.max_completion_tokens).toBe(4096);
    expect(sawArgs.response_format).toEqual({ type: 'json_object' });

    expect(result.text).toBe('hello world');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(tokenTracker.addUsage).toHaveBeenCalledWith(21, 5);
    expect(tokenTracker.checkStepBudget).toHaveBeenCalledWith(1_000_000);
  });

  it('streams: estimates tokens when the stream omits usage', async () => {
    // Minimum scenario: no usage chunk → estimate fallback (0 prompt, len/4 completion).
    createImpl = async () =>
      streamChunks([
        { choices: [{ delta: { content: 'abcd' } }], model: 'gpt-4o' },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);

    const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.text).toBe('abcd');
    expect(tokenTracker.addUsage).toHaveBeenCalledWith(0, 1); // ceil(4/4)
    expect(tokenTracker.checkStepBudget).not.toHaveBeenCalled();
  });

  it('strips cache hints from content blocks before the SDK call', async () => {
    let sawArgs: any;
    createImpl = async (args: any) => {
      sawArgs = args;
      return chatCompletion({ content: '{}', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };

    const client = new AiClient(baseConfig, tokenTracker as any);
    await client.complete([
      { role: 'system', content: [{ type: 'text', text: 'Core instructions', cache: true }] },
      { role: 'user', content: [{ type: 'text', text: 'Live request data' }] },
    ]);

    // `cache` must be gone; the rest of the block shape is preserved.
    expect(sawArgs.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'Core instructions' }],
    });
    expect(sawArgs.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Live request data' }],
    });
  });

  it('strips cache hints from image_url blocks too', async () => {
    let sawArgs: any;
    createImpl = async (args: any) => {
      sawArgs = args;
      return chatCompletion({ content: '{}', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };

    const client = new AiClient(baseConfig, tokenTracker as any);
    await client.complete([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' }, cache: true }],
      },
    ]);

    expect(sawArgs.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
    });
  });

  describe('buildSignal — 120s timeout + instant stop', () => {
    it('forwards a timeout-only AbortSignal when no run signal is passed', async () => {
      let sawOpts: any;
      createImpl = async (_args: any, opts: any) => {
        sawOpts = opts;
        return chatCompletion({ content: '{}', usage: { prompt_tokens: 1, completion_tokens: 1 } });
      };

      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(sawOpts.signal).toBeInstanceOf(AbortSignal);
      expect(sawOpts.signal.aborted).toBe(false);
    });

    it('forwards an AbortSignal.any combining the run signal with the timeout', async () => {
      let sawSignal: AbortSignal | undefined;
      // Hold the call open until the run signal fires, then reject like a real abort.
      createImpl = (_args: any, opts: any) => {
        sawSignal = opts.signal;
        return new Promise((_resolve, reject) => {
          sawSignal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        });
      };

      const client = new AiClient(baseConfig, tokenTracker as any);
      const ctrl = new AbortController();
      const pending = client.complete([{ role: 'user', content: 'Hi' }], ctrl.signal);

      // Composite — NOT the run signal passed through (which would drop the timeout).
      expect(sawSignal).toBeInstanceOf(AbortSignal);
      expect(sawSignal).not.toBe(ctrl.signal);
      expect(sawSignal!.aborted).toBe(false);
      ctrl.abort();
      expect(sawSignal!.aborted).toBe(true);

      await expect(pending).rejects.toThrow(/abort/i);
    });
  });

  describe('syncAuth — re-point an already-bound client (saved .env edit)', () => {
    it('swaps the model used on the next request and reports the change', async () => {
      let sentModel: string | undefined;
      createImpl = async (args: any) => {
        sentModel = args.model;
        return chatCompletion({ content: '{}', usage: { prompt_tokens: 1, completion_tokens: 1 } });
      };

      const client = new AiClient(baseConfig, tokenTracker as any);
      const change = client.syncAuth('gpt-5.4-mini', baseConfig.apiKey);

      expect(change).toBe('AI model gpt-4o → gpt-5.4-mini');
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(sentModel).toBe('gpt-5.4-mini');
    });

    it('swaps the apiKey, rebuilds the client with the new key, and never leaks it', async () => {
      createImpl = async () =>
        chatCompletion({ content: '{}', usage: { prompt_tokens: 1, completion_tokens: 1 } });

      const client = new AiClient(baseConfig, tokenTracker as any);
      expect(constructorMock).toHaveBeenCalledTimes(1); // initial build

      const change = client.syncAuth(baseConfig.model, 'super-secret-key');

      expect(change).toBe('AI API key changed');
      expect(change).not.toContain('super-secret-key');
      // Key is bound at construction → a key swap must rebuild the client.
      expect(constructorMock).toHaveBeenCalledTimes(2);
      expect(constructorMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: 'super-secret-key' }),
      );
    });

    it('rebuilds with an empty key when the key goes undefined', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      expect(constructorMock).toHaveBeenCalledTimes(1);

      const change = client.syncAuth(baseConfig.model, undefined);

      expect(change).toBe('AI API key changed');
      // Removed key → rebuilt client with apiKey '' (the openai SDK requires a string).
      expect(constructorMock).toHaveBeenCalledTimes(2);
      expect(constructorMock).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: '' }));
    });

    it('returns null, mutates nothing, and does NOT rebuild when model and key are unchanged', () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      expect(constructorMock).toHaveBeenCalledTimes(1);

      expect(client.syncAuth(baseConfig.model, baseConfig.apiKey)).toBeNull();
      // No key change → no rebuild.
      expect(constructorMock).toHaveBeenCalledTimes(1);
    });
  });
});
