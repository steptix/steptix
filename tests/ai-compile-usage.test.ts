import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { AiConfig } from '../src/config/types.js';
import { logger } from '../src/utils/logger.js';

/**
 * What a compile's model calls cost (docs/specs/SPEC-codebehind-robustness.md
 * §6.10): one info line per `compile`-profile call — writing, repairing and
 * reviewing code-behind — and none for a run's own calls, so the server log
 * says what a compile spent without a line per AI step.
 *
 * Template: tests/ai-effort.test.ts, whose gateway fake this reuses.
 */

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
    chat = chatMock;
    stream = streamMock;
  }
  return { AIGateway: FakeAIGateway, default: FakeAIGateway };
});

const MODEL = 'openai/gpt-6-luna';

function v2Response(usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }) {
  return {
    id: 'resp-1',
    object: 'response',
    created: 1776692376,
    provider: 'openai',
    model: MODEL,
    role: 'assistant',
    stop_reason: 'stop',
    content: [{ type: 'text', text: '{}' }],
    usage,
  };
}

describe('AiClient — what each compile call cost', () => {
  const tokenTracker = { addUsage: vi.fn(), checkStepBudget: vi.fn() };
  let config: AiConfig;

  beforeEach(() => {
    config = {
      apiKey: 'compile-usage-test-key',
      model: MODEL,
      maxInputTokens: 1_000_000,
      streamResponses: false,
      sendScreenshots: true,
      diagnoseFailures: true,
    };
    vi.clearAllMocks();
    chatMock.mockImplementation(async () => v2Response({ input_tokens: 12_000, output_tokens: 380, cached_input_tokens: 9_000 }));
    streamMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', text: '{}' };
      },
      final: Promise.resolve(v2Response({ input_tokens: 15_000, output_tokens: 420 })),
    }));
  });

  const info = () => vi.mocked(logger.info).mock.calls.map((c) => c[0]);

  it("logs a compile call's model and tokens, cached ones included", async () => {
    const ai = new AiClient(config, tokenTracker as never);
    await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
    expect(info()).toEqual([`Compile call to ${MODEL}: 12000 input tokens (9000 cached), 380 output tokens`]);
  });

  it('does the same when streaming, and says nothing of a cache it did not use', async () => {
    config.streamResponses = true;
    const ai = new AiClient(config, tokenTracker as never);
    await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
    expect(info()).toEqual([`Compile call to ${MODEL}: 15000 input tokens, 420 output tokens`]);
  });

  it("logs nothing for a run's own calls — routine, retry, or authoring (assertion code, diagnosis)", async () => {
    const ai = new AiClient(config, tokenTracker as never);
    await ai.complete([{ role: 'user', content: 'run it' }]);
    await ai.complete([{ role: 'user', content: 'again' }], undefined, { profile: 'retry' });
    await ai.complete([{ role: 'user', content: 'check it' }], undefined, { profile: 'authoring' });
    expect(info()).toEqual([]);
  });
});
