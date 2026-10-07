import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { AiConfig } from '../src/config/types.js';
import { applyEnvToAiConfig } from '../src/server/run-helpers.js';
import { logger } from '../src/utils/logger.js';

/**
 * A compile-only model (docs/specs/SPEC-codebehind-robustness.md §6.10):
 * `AI_AUTHORING_MODEL`, falling back to `AI_MODEL`, for the `authoring` calls
 * compile makes — generation, repair, review — and for nothing else.
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
/** Records every `new AIGateway(...)`: which model each gateway was bound to. */
const constructorMock = vi.fn();

vi.mock('@pkent/aigateway', () => {
  class FakeAIGateway {
    chat: (messages: unknown, options: unknown) => Promise<unknown>;
    stream: (messages: unknown, options: unknown) => unknown;
    constructor(model: string, key: string, options: unknown) {
      constructorMock(model, key, options);
      this.chat = (messages, options) => chatMock(model, messages, options);
      this.stream = (messages, options) => streamMock(model, messages, options);
    }
  }
  return { AIGateway: FakeAIGateway, default: FakeAIGateway };
});

function v2Response(model: string) {
  return {
    id: 'resp-1',
    object: 'response',
    created: 1776692376,
    provider: 'openai',
    model,
    role: 'assistant',
    stop_reason: 'stop',
    content: [{ type: 'text', text: '{}' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const RUN_MODEL = 'openai/gpt-6-luna';
const AUTHORING_MODEL = 'openai/gpt-6-sol';

describe('AiClient — the authoring model', () => {
  const tokenTracker = { addUsage: vi.fn(), checkStepBudget: vi.fn() };
  let config: AiConfig;

  beforeEach(() => {
    config = {
      apiKey: 'authoring-model-test-key',
      model: RUN_MODEL,
      maxInputTokens: 1_000_000,
      streamResponses: false,
      sendScreenshots: true,
      diagnoseFailures: true,
    };
    vi.clearAllMocks();
    chatMock.mockImplementation(async (model: string) => v2Response(model));
    streamMock.mockImplementation((model: string) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', text: '{}' };
      },
      final: Promise.resolve(v2Response(model)),
    }));
  });

  const client = () => new AiClient(config, tokenTracker as never);

  it("sends compile's calls to the authoring model, and every other call to the model", async () => {
    config.authoringModel = AUTHORING_MODEL;
    const ai = client();
    const authored = await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
    const routine = await ai.complete([{ role: 'user', content: 'run it' }]);
    const retry = await ai.complete([{ role: 'user', content: 'again' }], undefined, { profile: 'retry' });
    expect(chatMock.mock.calls.map((c) => c[0])).toEqual([AUTHORING_MODEL, RUN_MODEL, RUN_MODEL]);
    expect(authored.model).toBe(AUTHORING_MODEL);
    expect(routine.model).toBe(RUN_MODEL);
    expect(retry.model).toBe(RUN_MODEL);
  });

  // Measured live: with the setting on every `authoring` call, a RUN's own
  // assertion code went to the authoring model too, which answered it without
  // the `code` field four times, and the step and its compile stopped. The
  // setting is compile's alone.
  it("leaves a run's own authoring calls — assertion code, diagnosis, Record Steps — on the model", async () => {
    config.authoringModel = AUTHORING_MODEL;
    const ai = client();
    const assertion = await ai.complete([{ role: 'user', content: 'check it' }], undefined, { profile: 'authoring' });
    expect(chatMock.mock.calls.map((c) => c[0])).toEqual([RUN_MODEL]);
    expect(assertion.model).toBe(RUN_MODEL);
  });

  it('does the same when streaming', async () => {
    config.authoringModel = AUTHORING_MODEL;
    config.streamResponses = true;
    const ai = client();
    const authored = await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
    await ai.complete([{ role: 'user', content: 'run it' }]);
    expect(streamMock.mock.calls.map((c) => c[0])).toEqual([AUTHORING_MODEL, RUN_MODEL]);
    expect(authored.model).toBe(AUTHORING_MODEL);
  });

  it('falls back to the model when none is set', async () => {
    const ai = client();
    await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
    expect(chatMock.mock.calls[0]![0]).toBe(RUN_MODEL);
    expect(constructorMock).toHaveBeenCalledTimes(1);
  });

  it('builds each gateway once, with the same key', async () => {
    config.authoringModel = AUTHORING_MODEL;
    const ai = client();
    for (let i = 0; i < 2; i++) {
      await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
      await ai.complete([{ role: 'user', content: 'run it' }]);
    }
    expect(constructorMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [AUTHORING_MODEL, 'authoring-model-test-key'],
      [RUN_MODEL, 'authoring-model-test-key'],
    ]);
  });

  it("logs what each compile call cost in tokens, and nothing for the run's own calls", async () => {
    config.authoringModel = AUTHORING_MODEL;
    const ai = client();
    await ai.complete([{ role: 'user', content: 'run it' }]);
    await ai.complete([{ role: 'user', content: 'check it' }], undefined, { profile: 'authoring' });
    expect(vi.mocked(logger.info)).not.toHaveBeenCalled();
    await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
    expect(vi.mocked(logger.info).mock.calls.map((c) => c[0])).toEqual([
      `Compile call to ${AUTHORING_MODEL}: 1 input tokens, 1 output tokens`,
    ]);
  });

  describe('syncAuth', () => {
    it('sets it, says so, and rebuilds the gateway it uses', async () => {
      const ai = client();
      await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
      expect(ai.syncAuth(RUN_MODEL, config.apiKey, undefined, AUTHORING_MODEL)).toBe(
        `AI authoring model (the model) → ${AUTHORING_MODEL}`,
      );
      await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
      expect(chatMock.mock.calls.map((c) => c[0])).toEqual([RUN_MODEL, AUTHORING_MODEL]);
    });

    it('clears it with null, and leaves it alone with undefined', async () => {
      config.authoringModel = AUTHORING_MODEL;
      const ai = client();
      expect(ai.syncAuth(RUN_MODEL, config.apiKey, undefined, undefined)).toBeNull();
      expect(ai.syncAuth(RUN_MODEL, config.apiKey, undefined, null)).toBe(
        `AI authoring model ${AUTHORING_MODEL} → (the model)`,
      );
      await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
      expect(chatMock.mock.calls[0]![0]).toBe(RUN_MODEL);
    });

    it('drops the authoring gateway when the key changes', async () => {
      config.authoringModel = AUTHORING_MODEL;
      const ai = client();
      await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
      ai.syncAuth(RUN_MODEL, 'authoring-model-test-key-2', undefined, AUTHORING_MODEL);
      await ai.complete([{ role: 'user', content: 'write it' }], undefined, { profile: 'compile' });
      expect(constructorMock.mock.calls.map((c) => c[1])).toEqual([
        'authoring-model-test-key',
        'authoring-model-test-key-2',
      ]);
    });
  });
});

describe("a project's .env sets it per request", () => {
  const base: AiConfig = {
    model: RUN_MODEL,
    maxInputTokens: 1_000_000,
    streamResponses: false,
    sendScreenshots: true,
    diagnoseFailures: true,
  };

  it('reads AI_AUTHORING_MODEL, trimmed', () => {
    expect(applyEnvToAiConfig(base, { AI_AUTHORING_MODEL: `  ${AUTHORING_MODEL} ` }).authoringModel).toBe(
      AUTHORING_MODEL,
    );
  });

  it('treats a blank one as not set here', () => {
    expect(applyEnvToAiConfig({ ...base, authoringModel: AUTHORING_MODEL }, { AI_AUTHORING_MODEL: '' }).authoringModel)
      .toBe(AUTHORING_MODEL);
    expect(applyEnvToAiConfig(base, { AI_AUTHORING_MODEL: ' ' }).authoringModel).toBeUndefined();
  });
});

describe('the config loader', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('takes AI_AUTHORING_MODEL from the environment', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authoring-model-'));
    try {
      process.env['LOCALAPPDATA'] = root;
      process.env['XDG_CONFIG_HOME'] = root;
      process.env['AI_AUTHORING_MODEL'] = AUTHORING_MODEL;
      const { loadConfig } = await import('../src/config/loader.js');
      const config = await loadConfig(undefined, root);
      expect(config.ai.authoringModel).toBe(AUTHORING_MODEL);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
