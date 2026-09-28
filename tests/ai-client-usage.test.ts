/**
 * `complete()` hands back what each call cost (docs/specs/SPEC-scoreboard.md
 * §7.1) — the same numbers it adds to the run's token tracker, so the
 * interaction a caller files and the run's total cannot disagree about a call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { AiConfig } from '../src/config/types.js';
import { TokenTracker } from '../src/utils/tokens.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), tokenWarning: vi.fn() },
}));

const gateway = vi.hoisted(() => ({
  chat: undefined as undefined | (() => Promise<unknown>),
  stream: undefined as undefined | (() => unknown),
}));

vi.mock('@pkent/aigateway', () => {
  class FakeAIGateway {
    chat() {
      return gateway.chat!();
    }
    stream() {
      return gateway.stream!();
    }
  }
  return { AIGateway: FakeAIGateway, default: FakeAIGateway };
});

function stream(deltas: string[], final: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of deltas) yield { type: 'text_delta', text };
    },
    final: Promise.resolve(final),
  };
}

const envelope = (text: string, usage?: Record<string, number>) => ({
  model: 'aibroker/openai/m',
  content: [{ type: 'text', text }],
  ...(usage && { usage }),
});

let config: AiConfig;
let tracker: TokenTracker;

beforeEach(() => {
  config = {
    gatewayUrl: 'https://aiapi.test',
    apiKey: 'k',
    model: 'aibroker/openai/m',
    maxInputTokens: 1_000_000,
    streamResponses: false,
    sendScreenshots: false,
    diagnoseFailures: false,
  } as AiConfig;
  tracker = new TokenTracker();
});

describe('usage on the completion', () => {
  it('a non-streamed call: the envelope\'s usage, cached input tokens included', async () => {
    gateway.chat = async () => envelope('{}', { input_tokens: 4200, output_tokens: 130, total_tokens: 4330, cached_input_tokens: 3900 });
    const result = await new AiClient(config, tracker).complete([{ role: 'user', content: 'hi' }]);
    expect(result.usage).toEqual({ inputTokens: 4200, outputTokens: 130, cachedInputTokens: 3900 });
    expect([tracker.inputTotal, tracker.outputTotal]).toEqual([4200, 130]);
  });

  it('a cache count the provider did not report is absent, not zero', async () => {
    gateway.chat = async () => envelope('{}', { input_tokens: 10, output_tokens: 2 });
    const result = await new AiClient(config, tracker).complete([{ role: 'user', content: 'hi' }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('an envelope with no usage block: none on the completion, and nothing added to the run', async () => {
    gateway.chat = async () => envelope('{}');
    const result = await new AiClient(config, tracker).complete([{ role: 'user', content: 'hi' }]);
    expect(result).not.toHaveProperty('usage');
    expect(tracker.total).toBe(0);
  });

  it('a streamed call: the final envelope\'s usage', async () => {
    config.streamResponses = true;
    gateway.stream = () => stream(['{"a":', '1}'], envelope('{"a":1}', { input_tokens: 800, output_tokens: 9, cached_input_tokens: 0 }));
    const result = await new AiClient(config, tracker).complete([{ role: 'user', content: 'hi' }]);
    expect(result.usage).toEqual({ inputTokens: 800, outputTokens: 9, cachedInputTokens: 0 });
    expect([tracker.inputTotal, tracker.outputTotal]).toEqual([800, 9]);
  });

  it('a stream that omitted usage: the client\'s estimate, marked as one, and the same estimate in the run', async () => {
    config.streamResponses = true;
    const text = '{"actions":[],"reasoning":"x"}';
    gateway.stream = () => stream([text], envelope(text));
    const result = await new AiClient(config, tracker).complete([{ role: 'user', content: 'hi' }]);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: Math.ceil(text.length / 4), estimated: true });
    expect([tracker.inputTotal, tracker.outputTotal]).toEqual([0, Math.ceil(text.length / 4)]);
  });
});
