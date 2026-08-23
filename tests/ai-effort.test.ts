import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { AiConfig } from '../src/config/types.js';

// Reasoning effort. The contract under test is that `effort` and `maxTokens`
// always move together — raising effort without raising the cap truncates the
// answer, because reasoning tokens count against the same cap on every provider
// (and OpenRouter sizes the reasoning budget as a fraction of it).
//
// Template: tests/ai-client.test.ts, whose gateway mock this reuses.

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

const chatMock = vi.fn();
const streamMock = vi.fn();

vi.mock('@pkent/aigateway', () => {
  class FakeAIGateway {
    chat: typeof chatMock;
    stream: typeof streamMock;
    constructor() {
      this.chat = chatMock;
      this.stream = streamMock;
    }
  }
  return { AIGateway: FakeAIGateway, default: FakeAIGateway };
});

function v2Response() {
  return {
    id: 'resp-1',
    object: 'response',
    created: 1776692376,
    provider: 'aibroker',
    model: 'aibroker/openai/chatgpt-5.5',
    role: 'assistant',
    stop_reason: 'stop',
    content: [{ type: 'text', text: '{}' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function makeStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text_delta', text: '{}' };
    },
    final: Promise.resolve(v2Response()),
  };
}

/** The options object the gateway was called with on the last chat/stream call. */
function lastChatOptions() {
  return chatMock.mock.calls.at(-1)?.[1];
}
function lastStreamOptions() {
  return streamMock.mock.calls.at(-1)?.[1];
}

describe('AiClient — reasoning effort profiles', () => {
  const tokenTracker = { addUsage: vi.fn(), checkStepBudget: vi.fn() };
  let baseConfig: AiConfig;

  beforeEach(() => {
    baseConfig = {
      gatewayUrl: 'https://llm.corp.example',
      apiKey: 'test-key',
      model: 'aibroker/openai/chatgpt-5.5',
      maxInputTokens: 1_000_000,
      streamResponses: false,
      sendScreenshots: true,
      diagnoseFailures: true,
    };
    vi.clearAllMocks();
    chatMock.mockImplementation(async () => v2Response());
    streamMock.mockImplementation(() => makeStream());
  });

  const HI = [{ role: 'user' as const, content: 'Hi' }];

  describe('the default call is unchanged from today', () => {
    it('sends maxTokens 4096 and NO effort key', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete(HI);

      const options = lastChatOptions();
      expect(options.maxTokens).toBe(4096);
      // Not `toBeUndefined()` — the key must be ABSENT, since an unset effort is
      // what keeps the upstream body byte-for-byte what it is today.
      expect('effort' in options).toBe(false);
    });

    it('sends maxTokens 4096 and NO effort key when streaming', async () => {
      const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
      await client.complete(HI);

      const options = lastStreamOptions();
      expect(options.maxTokens).toBe(4096);
      expect('effort' in options).toBe(false);
    });
  });

  describe('profiles pair effort with a cap that can hold the answer', () => {
    it('authoring sends high effort and a 16384 cap', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete(HI, undefined, { profile: 'authoring' });

      expect(lastChatOptions()).toMatchObject({ effort: 'high', maxTokens: 16384 });
    });

    it('retry sends medium effort and an 8192 cap', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete(HI, undefined, { profile: 'retry' });

      expect(lastChatOptions()).toMatchObject({ effort: 'medium', maxTokens: 8192 });
    });

    it('an explicit routine profile matches the default', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete(HI, undefined, { profile: 'routine' });

      const options = lastChatOptions();
      expect(options.maxTokens).toBe(4096);
      expect('effort' in options).toBe(false);
    });

    it('carries the profile through the streaming path too', async () => {
      const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
      await client.complete(HI, undefined, { profile: 'authoring' });

      expect(lastStreamOptions()).toMatchObject({ effort: 'high', maxTokens: 16384 });
    });
  });

  describe('AI_EFFORT raises the hot path only', () => {
    it('applies to the default call, and raises its cap with it', async () => {
      const client = new AiClient({ ...baseConfig, effort: 'high' }, tokenTracker as any);
      await client.complete(HI);

      expect(lastChatOptions()).toMatchObject({ effort: 'high', maxTokens: 8192 });
    });

    it('does NOT lower authoring — a cost knob must not degrade diagnosis', async () => {
      const client = new AiClient({ ...baseConfig, effort: 'low' }, tokenTracker as any);
      await client.complete(HI, undefined, { profile: 'authoring' });

      expect(lastChatOptions()).toMatchObject({ effort: 'high', maxTokens: 16384 });
    });

    it('does NOT lower retry either', async () => {
      const client = new AiClient({ ...baseConfig, effort: 'low' }, tokenTracker as any);
      await client.complete(HI, undefined, { profile: 'retry' });

      expect(lastChatOptions()).toMatchObject({ effort: 'medium', maxTokens: 8192 });
    });
  });

  describe('effort is a per-call option, not a binding', () => {
    it('does not invalidate the memoized gateway between profiles', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);

      await client.complete(HI);
      await client.complete(HI, undefined, { profile: 'authoring' });

      // Two different profiles, one gateway: the model/key binding is what
      // rebuilds it, and effort is not part of that.
      expect(chatMock).toHaveBeenCalledTimes(2);
      expect(lastChatOptions().effort).toBe('high');
    });

    it('responseFormat and signal still ride alongside the profile', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete(HI, undefined, { profile: 'authoring' });

      const options = lastChatOptions();
      expect(options.responseFormat).toEqual({ type: 'json_object' });
      expect(options.signal).toBeDefined();
    });
  });
});
