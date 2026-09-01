import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiClient,
  AiForbiddenByPolicyError,
  AiNotConfiguredError,
  AI_FORBIDDEN_BY_POLICY_MESSAGE,
  AI_NOT_CONFIGURED_MESSAGE,
  GatewayUrlRequiredError,
  GATEWAY_URL_REQUIRED_MESSAGE,
} from '../src/ai/client.js';
import type { AiConfig } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { logger } from '../src/utils/logger.js';

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
 * One shared `chat` / `stream` spy that every mock gateway instance delegates
 * to, so a test can inspect the request regardless of which (rebuilt) gateway
 * made it. `chatImpl` / `streamImpl` let each test swap in the response.
 */
const chatMock = vi.fn();
const streamMock = vi.fn();
let chatImpl: (...args: any[]) => any = async () => ({ content: [], model: 'unset' });
let streamImpl: (...args: any[]) => any = () => makeStream([], { content: [], model: 'unset' });

/** Records every `new AIGateway(model, key, options)` so tests can assert construction args + rebuild count. */
const constructorMock = vi.fn();

vi.mock('@pkent/aigateway', () => {
  class FakeAIGateway {
    chat: typeof chatMock;
    stream: typeof streamMock;
    constructor(model: string, key: string, options: any) {
      constructorMock(model, key, options);
      this.chat = chatMock;
      this.stream = streamMock;
    }
  }
  return { AIGateway: FakeAIGateway, default: FakeAIGateway };
});

/** Build a v2 response envelope ({ content:[{type,text}], model?, usage? }). */
function v2Response(opts: {
  text?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens?: number };
}) {
  return {
    id: 'resp-1',
    object: 'response',
    created: 1776692376,
    provider: 'aibroker',
    model: opts.model,
    role: 'assistant',
    stop_reason: 'stop',
    content: opts.text === undefined ? [] : [{ type: 'text', text: opts.text }],
    usage: opts.usage,
  };
}

/**
 * Build a ChatStream-shaped object: async-iterable of `{type:'text_delta',text}`
 * deltas plus a `.final` promise resolving to the v2 envelope.
 */
function makeStream(deltas: string[], final: any) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of deltas) yield { type: 'text_delta', text };
    },
    final: Promise.resolve(final),
  };
}

describe('AiClient — @pkent/aigateway integration', () => {
  const tokenTracker = {
    addUsage: vi.fn(),
    checkStepBudget: vi.fn(),
  };

  // `syncAuth` mutates the config object it's handed (by reference), so a fresh
  // copy per test is required — otherwise a model/key change leaks into later
  // tests that read `baseConfig.model` / `.apiKey`.
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
    chatImpl = async () => v2Response({ text: '{}', model: 'aibroker/openai/chatgpt-5.5' });
    streamImpl = () =>
      makeStream(['{}'], v2Response({ text: '{}', model: 'aibroker/openai/chatgpt-5.5' }));
    chatMock.mockImplementation((...args: any[]) => chatImpl(...args));
    streamMock.mockImplementation((...args: any[]) => streamImpl(...args));
  });

  describe('construction — lazy + model-prefix-aware baseURL', () => {
    it('does NOT build the gateway in the constructor (lazy)', () => {
      new AiClient(baseConfig, tokenTracker as any);
      expect(constructorMock).not.toHaveBeenCalled();
    });

    it('builds the gateway with the bound model+key and { baseURL } for an aibroker/ model', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(constructorMock).toHaveBeenCalledTimes(1);
      expect(constructorMock).toHaveBeenCalledWith('aibroker/openai/chatgpt-5.5', 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
    });

    it('builds the gateway with NO baseURL for a direct openai/ model', async () => {
      const client = new AiClient(
        { ...baseConfig, model: 'openai/chatgpt-5.5' },
        tokenTracker as any,
      );
      await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(constructorMock).toHaveBeenCalledTimes(1);
      expect(constructorMock).toHaveBeenCalledWith('openai/chatgpt-5.5', 'test-key', {});
    });

    it('warns when a gateway URL somebody chose is paired with a direct model', async () => {
      // The silent-inert pairing (stories/keyless-replay-and-gateway-env.md
      // §Part A): `AI_GATEWAY_URL` reaches the client, the client honours the
      // model prefix, and the request leaves for the provider — with the
      // corporate user believing their traffic stayed inside the org.
      const client = new AiClient(
        { ...baseConfig, model: 'openai/chatgpt-5.5', gatewayUrl: 'https://llm.corp.example' },
        tokenTracker as any,
      );
      await client.complete([{ role: 'user', content: 'Hi' }]);

      const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('https://llm.corp.example');
      expect(warned).toContain('openai/chatgpt-5.5');
      // Both routing spellings are named: the reader has to be able to tell
      // which one their `.env` should say.
      expect(warned).toContain('gateway/');
      expect(warned).toContain('aibroker/');
      expect(warned).toContain('AI_MODEL=gateway/<model>');
      // Warned, not refused: the pairing is legal, and the request still goes.
      expect(constructorMock).toHaveBeenCalledWith('openai/chatgpt-5.5', 'test-key', {});
    });

    it('stays quiet for a direct model on the built-in gateway URL', async () => {
      // Nobody chose that URL — it is the default every resolved config
      // carries — so warning about it would fire on every ordinary run.
      const client = new AiClient(
        { ...baseConfig, model: 'openai/chatgpt-5.5', gatewayUrl: `${DEFAULT_CONFIG.ai.gatewayUrl}/` },
        tokenTracker as any,
      );
      await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('stays quiet for an aibroker/ model, where the URL is doing its job', async () => {
      const client = new AiClient(
        { ...baseConfig, gatewayUrl: 'https://llm.corp.example' },
        tokenTracker as any,
      );
      await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(logger.warn).not.toHaveBeenCalled();
      expect(constructorMock).toHaveBeenCalledWith('aibroker/openai/chatgpt-5.5', 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
    });

    it('memoizes the gateway across calls (built once)', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);
      await client.complete([{ role: 'user', content: 'Hi again' }]);
      expect(constructorMock).toHaveBeenCalledTimes(1);
    });

    it('refuses the request rather than building a gateway with no key', async () => {
      // It used to build one with `''` and let the gateway answer
      // `invalid_api_key` (stories/keyless-replay-and-gateway-env.md §Part B):
      // an auth error on a machine that was never meant to have a key.
      const cfg = { ...baseConfig };
      delete (cfg as Partial<AiConfig>).apiKey;
      const client = new AiClient(cfg as AiConfig, tokenTracker as any);

      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiNotConfiguredError,
      );
      expect(constructorMock).not.toHaveBeenCalled();
    });
  });

  describe('gateway/ — the explicit-destination prefix', () => {
    // stories/copilot-lm-bridge.md §Part B. `gateway/` says what the mechanism
    // does — route to AI_GATEWAY_URL — where `aibroker/` names the hosted broker
    // application. The alias routes identically; the one behavioural difference
    // is that `gateway/` demands a URL somebody chose.
    const corp = 'https://llm.corp.example';

    it('builds the gateway with { baseURL } for a gateway/ model, model string verbatim', async () => {
      const client = new AiClient(
        { ...baseConfig, model: 'gateway/copilot/gpt-4.1', gatewayUrl: corp },
        tokenTracker as any,
      );
      await client.complete([{ role: 'user', content: 'Hi' }]);

      // The full string goes across: stripping the first segment is the
      // library's job (`gateway` is a provider alias there), which is why this
      // asserts the prefix is still ON the model we hand it.
      expect(constructorMock).toHaveBeenCalledTimes(1);
      expect(constructorMock).toHaveBeenCalledWith('gateway/copilot/gpt-4.1', 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
      expect(chatMock).toHaveBeenCalledTimes(1);
    });

    it('does not warn about an inert pair — the URL is doing its job', async () => {
      const client = new AiClient(
        { ...baseConfig, model: 'gateway/copilot/gpt-4.1', gatewayUrl: corp },
        tokenTracker as any,
      );
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('normalises a trailing slash into the /v1 suffix, as aibroker/ does', async () => {
      const client = new AiClient(
        { ...baseConfig, model: 'gateway/copilot/gpt-4.1', gatewayUrl: `${corp}/` },
        tokenTracker as any,
      );
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(constructorMock).toHaveBeenCalledWith('gateway/copilot/gpt-4.1', 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
    });

    it('refuses a gateway/ model when AI_GATEWAY_URL was never set, and sends nothing', async () => {
      // The guard: the loader keeps no provenance, so "unset" is a value
      // comparison against the built-in default. Refusing beats silently
      // shipping the key and the DOM payload to the default host.
      const client = new AiClient(
        { ...baseConfig, model: 'gateway/copilot/gpt-4.1' },
        tokenTracker as any,
      );

      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        GatewayUrlRequiredError,
      );
      expect(constructorMock).not.toHaveBeenCalled();
      expect(chatMock).not.toHaveBeenCalled();
      expect(streamMock).not.toHaveBeenCalled();
    });

    it('names AI_GATEWAY_URL and .env, and never AI_API_KEY, in the refusal', async () => {
      // A key is not the problem here, and naming one would send the reader to
      // edit a line that is already correct.
      const client = new AiClient(
        { ...baseConfig, model: 'gateway/copilot/gpt-4.1' },
        tokenTracker as any,
      );
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        GATEWAY_URL_REQUIRED_MESSAGE,
      );
      expect(GATEWAY_URL_REQUIRED_MESSAGE).toBe(new GatewayUrlRequiredError().message);
      expect(GATEWAY_URL_REQUIRED_MESSAGE).toContain('AI_GATEWAY_URL');
      expect(GATEWAY_URL_REQUIRED_MESSAGE).toContain('.env');
      expect(GATEWAY_URL_REQUIRED_MESSAGE).not.toContain('AI_API_KEY');
    });

    it('refuses a default URL that only differs by a trailing slash', async () => {
      const client = new AiClient(
        {
          ...baseConfig,
          model: 'gateway/copilot/gpt-4.1',
          gatewayUrl: `${DEFAULT_CONFIG.ai.gatewayUrl}/`,
        },
        tokenTracker as any,
      );
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        GatewayUrlRequiredError,
      );
      expect(constructorMock).not.toHaveBeenCalled();
    });

    it('lets aibroker/ fall through to the default endpoint, guard or no guard', async () => {
      // The case the guard must not break: `aibroker/` is the zero-config
      // hosted-broker spelling, so the same config that refuses above proceeds
      // here. Testing the refusal alone would not have caught a guard that
      // matched both prefixes.
      const client = new AiClient(
        { ...baseConfig, model: 'aibroker/openai/chatgpt-5.5' },
        tokenTracker as any,
      );
      const result = await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(result.text).toBe('{}');
      expect(constructorMock).toHaveBeenCalledWith('aibroker/openai/chatgpt-5.5', 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
    });

    it('lets a gateway/ model through the moment a URL is chosen', async () => {
      const client = new AiClient(
        { ...baseConfig, model: 'gateway/copilot/gpt-4.1' },
        tokenTracker as any,
      );
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        GatewayUrlRequiredError,
      );

      // Same client, one `.env` edit later — the refusal is about the config,
      // not a state the client got stuck in.
      client.syncAuth('gateway/copilot/gpt-4.1', 'test-key', corp);
      const result = await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.text).toBe('{}');
      expect(constructorMock).toHaveBeenCalledWith('gateway/copilot/gpt-4.1', 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
    });
  });

  describe('keyless — the reactive backstop', () => {
    /** Every shape of "no key" the resolved config can be in. */
    const noKey: Array<[string, string | undefined]> = [
      ['absent', undefined],
      ['empty', ''],
      ['whitespace', '   '],
    ];

    for (const [label, apiKey] of noKey) {
      it(`throws AiNotConfiguredError with the spec's copy when the key is ${label}`, async () => {
        const cfg = { ...baseConfig };
        if (apiKey === undefined) delete (cfg as Partial<AiConfig>).apiKey;
        else cfg.apiKey = apiKey;

        // Construction still succeeds — the lazy-build contract is unchanged,
        // which is what lets a keyless run build a client and replay a
        // compiled test without ever reaching a request.
        const client = new AiClient(cfg, tokenTracker as any);
        expect(constructorMock).not.toHaveBeenCalled();

        await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(
          new AiNotConfiguredError(),
        );
        // The whole message, verbatim: this is the copy every AI operation —
        // compile, errand, an AI step in an uncompiled test — inherits.
        await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(
          'AI is not configured: AI_API_KEY resolved to empty. Compiled tests replay ' +
            'without AI; this operation needs a model. Set AI_API_KEY in the project .env ' +
            'or the machine .env — and AI_GATEWAY_URL if your org routes through its own ' +
            'endpoint. (A blank AI_API_KEY= line in the project .env deliberately blocks ' +
            'the machine key.)',
        );
        expect(AI_NOT_CONFIGURED_MESSAGE).toBe(new AiNotConfiguredError().message);
        expect(chatMock).not.toHaveBeenCalled();
        expect(streamMock).not.toHaveBeenCalled();
      });
    }

    it('logs no request for the request it never made', async () => {
      // The `POST …` debug line and the `ai.request#N` trace used to run
      // BEFORE the gateway was resolved, so a keyless run left a log claiming
      // a request went out — the one artefact someone reads to work out why
      // their run failed.
      const client = new AiClient({ ...baseConfig, apiKey: '' }, tokenTracker as any);
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiNotConfiguredError,
      );

      const logged = [
        ...vi.mocked(logger.debug).mock.calls,
        ...vi.mocked(logger.trace).mock.calls,
      ]
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).not.toContain('POST');
      expect(logged).not.toContain('ai.request');
    });

    it('refuses the streaming path on the same terms', async () => {
      const client = new AiClient(
        { ...baseConfig, apiKey: '', streamResponses: true },
        tokenTracker as any,
      );
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiNotConfiguredError,
      );
      expect(streamMock).not.toHaveBeenCalled();
    });

    it('leaves a keyed client on exactly today\'s behaviour', async () => {
      // The control the keyless cases are only meaningful against: one
      // character of key and the request goes through untouched.
      const client = new AiClient({ ...baseConfig, apiKey: 'k' }, tokenTracker as any);
      const result = await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(result.text).toBe('{}');
      expect(constructorMock).toHaveBeenCalledWith('aibroker/openai/chatgpt-5.5', 'k', {
        baseURL: 'https://llm.corp.example/v1',
      });
      expect(chatMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('setAiPolicy — the run-forbids-AI veil', () => {
    // stories/run-settings.md §9. Every test here runs on a KEYED client: the
    // whole point of the veil is that a key is present and the run was asked to
    // spend nothing anyway, so a keyless fixture would prove nothing.

    it('refuses a keyed request while the veil is up, and sends nothing', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      client.setAiPolicy(false);

      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiForbiddenByPolicyError,
      );
      expect(constructorMock).not.toHaveBeenCalled();
      expect(chatMock).not.toHaveBeenCalled();
      expect(streamMock).not.toHaveBeenCalled();
    });

    it('still runs the ordinary call when policy allows it', async () => {
      // The case the veil must not break, asserted alongside the refusal rather
      // than on its own: a gate tested only on the input it declines can be
      // refusing everything and look correct.
      const client = new AiClient(baseConfig, tokenTracker as any);
      client.setAiPolicy(true);

      const result = await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.text).toBe('{}');
      expect(chatMock).toHaveBeenCalledTimes(1);
    });

    it('lifts on the next batch without a session recycle', async () => {
      // Settings are re-resolved per request, so a client that stayed veiled
      // after the caller passed ai: "on" would need the browser thrown away to
      // recover — the very cost this whole feature exists to avoid.
      const client = new AiClient(baseConfig, tokenTracker as any);

      client.setAiPolicy(false);
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiForbiddenByPolicyError,
      );

      client.setAiPolicy(true);
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).resolves.toMatchObject({
        text: '{}',
      });
      expect(chatMock).toHaveBeenCalledTimes(1);
    });

    it('is NOT AiNotConfiguredError, and never advises setting a key', async () => {
      // The distinction the echo has to keep: "off (policy)" and "off (no key)"
      // need opposite responses, and "Set AI_API_KEY in the project .env" is
      // wrong advice for a run whose key is already there.
      const client = new AiClient(baseConfig, tokenTracker as any);
      client.setAiPolicy(false);

      const err = await client
        .complete([{ role: 'user', content: 'Hi' }])
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AiForbiddenByPolicyError);
      expect(err).not.toBeInstanceOf(AiNotConfiguredError);
      expect((err as Error).message).toBe(AI_FORBIDDEN_BY_POLICY_MESSAGE);
      expect(AI_FORBIDDEN_BY_POLICY_MESSAGE).toContain('runSettings.ai: off');
      expect(AI_FORBIDDEN_BY_POLICY_MESSAGE).not.toContain('AI_API_KEY');
      expect(AI_FORBIDDEN_BY_POLICY_MESSAGE).not.toBe(AI_NOT_CONFIGURED_MESSAGE);
    });

    it('beats the keyless refusal when a run is both keyless and policy-off', async () => {
      // Both true is reachable — a keyless machine whose caller also asked for
      // ai: "off". Policy is the more specific statement about THIS run, and
      // it is the one whose advice is not misleading.
      const client = new AiClient({ ...baseConfig, apiKey: '' }, tokenTracker as any);
      client.setAiPolicy(false);

      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiForbiddenByPolicyError,
      );
    });

    it('refuses the streaming path on the same terms', async () => {
      const client = new AiClient(
        { ...baseConfig, streamResponses: true },
        tokenTracker as any,
      );
      client.setAiPolicy(false);

      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiForbiddenByPolicyError,
      );
      expect(streamMock).not.toHaveBeenCalled();
    });

    it('logs no request for the request it never made', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      client.setAiPolicy(false);
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
        AiForbiddenByPolicyError,
      );

      const logged = [
        ...vi.mocked(logger.debug).mock.calls,
        ...vi.mocked(logger.trace).mock.calls,
      ]
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).not.toContain('POST');
      expect(logged).not.toContain('ai.request');
    });
  });

  describe('complete() — non-streaming', () => {
    it('calls chat with passed-through messages, maxTokens, responseFormat, composite signal', async () => {
      let sawMessages: any;
      let sawOpts: any;
      chatImpl = async (messages: any, opts: any) => {
        sawMessages = messages;
        sawOpts = opts;
        return v2Response({
          text: '{"actions":[],"reasoning":"ok"}',
          model: 'aibroker/openai/chatgpt-5.5',
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        });
      };

      const client = new AiClient(baseConfig, tokenTracker as any);
      const messages = [{ role: 'user', content: 'Hello' }];
      const result = await client.complete(messages as any);

      // Messages passed through unchanged (no cache-strip / no remapping).
      expect(sawMessages).toBe(messages);
      expect(sawMessages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(sawOpts.maxTokens).toBe(4096);
      expect(sawOpts.responseFormat).toEqual({ type: 'json_object' });
      // Signal forwarded as a composite AbortSignal (timeout-only when no run signal).
      expect(sawOpts.signal).toBeInstanceOf(AbortSignal);
      expect(sawOpts.signal.aborted).toBe(false);

      // Map-back from the v2 envelope.
      expect(result.text).toBe('{"actions":[],"reasoning":"ok"}');
      expect(result.model).toBe('aibroker/openai/chatgpt-5.5');
      // v2 field names: addUsage(input_tokens, output_tokens) — NOT prompt/completion.
      expect(tokenTracker.addUsage).toHaveBeenCalledWith(12, 8);
      expect(tokenTracker.checkStepBudget).toHaveBeenCalledWith(1_000_000);
    });

    it('does NOT strip cache hints — messages (incl. cache:true blocks) reach chat verbatim', async () => {
      let sawMessages: any;
      chatImpl = async (messages: any) => {
        sawMessages = messages;
        return v2Response({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } });
      };

      const client = new AiClient(baseConfig, tokenTracker as any);
      const messages = [
        { role: 'system', content: [{ type: 'text', text: 'Core instructions', cache: true }] },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:img,AAA' }, cache: true }] },
      ];
      await client.complete(messages as any);

      // The library handles cache hints itself; the client passes them through.
      expect(sawMessages).toBe(messages);
      expect(sawMessages[0].content[0]).toEqual({ type: 'text', text: 'Core instructions', cache: true });
      expect(sawMessages[1].content[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:img,AAA' },
        cache: true,
      });
    });

    it('joins only type:text blocks into the response text', async () => {
      chatImpl = async () => ({
        model: 'aibroker/openai/chatgpt-5.5',
        content: [
          { type: 'text', text: 'foo ' },
          { type: 'image', source: { url: 'x' } },
          { type: 'text', text: 'bar' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const client = new AiClient(baseConfig, tokenTracker as any);
      const result = await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.text).toBe('foo bar');
    });

    it('falls back to the configured model when the envelope omits one', async () => {
      chatImpl = async () =>
        v2Response({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } }); // model undefined

      const client = new AiClient(baseConfig, tokenTracker as any);
      const result = await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.model).toBe('aibroker/openai/chatgpt-5.5');
    });

    it('throws on empty content and does not invent a result', async () => {
      // Minimum scenario: empty content + no usage must NOT silently pass.
      chatImpl = async () => v2Response({ text: '', model: 'aibroker/openai/chatgpt-5.5' });

      const client = new AiClient(baseConfig, tokenTracker as any);
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(/no content/i);
      // No usage block → tokenTracker untouched on this path.
      expect(tokenTracker.addUsage).not.toHaveBeenCalled();
      expect(tokenTracker.checkStepBudget).not.toHaveBeenCalled();
    });
  });

  describe('complete() — streaming', () => {
    it('calls stream with passed-through messages, maxTokens, responseFormat, signal', async () => {
      let sawMessages: any;
      let sawOpts: any;
      streamImpl = (messages: any, opts: any) => {
        sawMessages = messages;
        sawOpts = opts;
        return makeStream(
          ['hello ', 'world'],
          v2Response({
            text: 'hello world',
            model: 'aibroker/openai/chatgpt-5.5',
            usage: { input_tokens: 21, output_tokens: 5, total_tokens: 26 },
          }),
        );
      };

      const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
      const messages = [{ role: 'user', content: 'Hello' }];
      const result = await client.complete(messages as any);

      expect(sawMessages).toBe(messages);
      expect(sawOpts.maxTokens).toBe(4096);
      expect(sawOpts.responseFormat).toEqual({ type: 'json_object' });
      expect(sawOpts.signal).toBeInstanceOf(AbortSignal);

      // Text assembled from the deltas; usage from .final.
      expect(result.text).toBe('hello world');
      expect(result.model).toBe('aibroker/openai/chatgpt-5.5');
      expect(tokenTracker.addUsage).toHaveBeenCalledWith(21, 5);
      expect(tokenTracker.checkStepBudget).toHaveBeenCalledWith(1_000_000);
    });

    it('estimates tokens when .final omits usage', async () => {
      // Minimum scenario: no usage on .final → estimate fallback (0 input, len/4 output).
      streamImpl = () =>
        makeStream(['abcd'], v2Response({ text: 'abcd', model: 'aibroker/openai/chatgpt-5.5' }));

      const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
      const result = await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(result.text).toBe('abcd');
      expect(tokenTracker.addUsage).toHaveBeenCalledWith(0, 1); // ceil(4/4)
      expect(tokenTracker.checkStepBudget).not.toHaveBeenCalled();
    });

    it('estimates tokens when .final usage is present but zero', async () => {
      streamImpl = () =>
        makeStream(
          ['abcd'],
          v2Response({
            text: 'abcd',
            model: 'aibroker/openai/chatgpt-5.5',
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          }),
        );

      const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(tokenTracker.addUsage).toHaveBeenCalledWith(0, 1); // ceil(4/4)
      expect(tokenTracker.checkStepBudget).not.toHaveBeenCalled();
    });

    it('throws on empty streamed content', async () => {
      streamImpl = () => makeStream([], v2Response({ text: '', model: 'aibroker/openai/chatgpt-5.5' }));
      const client = new AiClient({ ...baseConfig, streamResponses: true }, tokenTracker as any);
      await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(/no content/i);
    });
  });

  describe('buildSignal — 120s timeout + instant stop', () => {
    it('forwards a timeout-only AbortSignal when no run signal is passed', async () => {
      let sawOpts: any;
      chatImpl = async (_messages: any, opts: any) => {
        sawOpts = opts;
        return v2Response({ text: '{}', usage: { input_tokens: 1, output_tokens: 1 } });
      };

      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);

      expect(sawOpts.signal).toBeInstanceOf(AbortSignal);
      expect(sawOpts.signal.aborted).toBe(false);
    });

    it('forwards an AbortSignal.any combining the run signal with the timeout', async () => {
      let sawSignal: AbortSignal | undefined;
      // Hold the call open until the run signal fires, then reject like a real abort.
      chatImpl = (_messages: any, opts: any) => {
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
    it('rebuilds the gateway on a MODEL change and uses the new model on the next request', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]); // initial build
      expect(constructorMock).toHaveBeenCalledTimes(1);

      const change = client.syncAuth('aibroker/openrouter/gemini-3-flash', baseConfig.apiKey);
      expect(change).toBe('AI model aibroker/openai/chatgpt-5.5 → aibroker/openrouter/gemini-3-flash');

      // INVERTED vs the old per-request model: the model is bound at construction,
      // so a model change MUST rebuild the gateway (lazily, on the next call).
      await client.complete([{ role: 'user', content: 'Hi again' }]);
      expect(constructorMock).toHaveBeenCalledTimes(2);
      expect(constructorMock).toHaveBeenLastCalledWith(
        'aibroker/openrouter/gemini-3-flash',
        'test-key',
        expect.anything(),
      );
    });

    it('rebuilds the gateway on a KEY change with the new key, and never leaks it', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(constructorMock).toHaveBeenCalledTimes(1);

      const change = client.syncAuth(baseConfig.model, 'super-secret-key');

      expect(change).toBe('AI API key changed');
      expect(change).not.toContain('super-secret-key');

      // Rebuilds lazily on the next request, bound with the new key.
      await client.complete([{ role: 'user', content: 'Hi again' }]);
      expect(constructorMock).toHaveBeenCalledTimes(2);
      expect(constructorMock).toHaveBeenLastCalledWith(
        baseConfig.model,
        'super-secret-key',
        expect.anything(),
      );
    });

    it('goes keyless when the key is removed — the next request refuses, and builds nothing', async () => {
      // A saved `.env` edit that deletes AI_API_KEY. It used to rebuild the
      // gateway with `''`; now the session simply has no AI until a key comes
      // back (stories/keyless-replay-and-gateway-env.md §Part B).
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(constructorMock).toHaveBeenCalledTimes(1);

      const change = client.syncAuth(baseConfig.model, undefined);
      expect(change).toBe('AI API key changed');

      await expect(client.complete([{ role: 'user', content: 'Hi again' }])).rejects.toBeInstanceOf(
        AiNotConfiguredError,
      );
      expect(constructorMock).toHaveBeenCalledTimes(1);

      // …and the reverse edit puts it straight back, with no session recycle.
      client.syncAuth(baseConfig.model, 'back-again');
      await client.complete([{ role: 'user', content: 'Hi once more' }]);
      expect(constructorMock).toHaveBeenCalledTimes(2);
      expect(constructorMock).toHaveBeenLastCalledWith(
        baseConfig.model,
        'back-again',
        expect.anything(),
      );
    });

    it('reports both a model AND key change together', () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      const change = client.syncAuth('openai/chatgpt-5.5', 'new-key');
      expect(change).toBe('AI model aibroker/openai/chatgpt-5.5 → openai/chatgpt-5.5; AI API key changed');
      expect(change).not.toContain('new-key');
    });

    it('returns null, mutates nothing, and does NOT rebuild when model and key are unchanged', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]); // build once
      expect(constructorMock).toHaveBeenCalledTimes(1);

      expect(client.syncAuth(baseConfig.model, baseConfig.apiKey)).toBeNull();

      // Nothing changed → gateway NOT invalidated → no rebuild on the next call.
      await client.complete([{ role: 'user', content: 'Hi again' }]);
      expect(constructorMock).toHaveBeenCalledTimes(1);
    });

    it('rebuilds the gateway on a GATEWAY URL change and points the new one at it', async () => {
      // AI_GATEWAY_URL (stories/keyless-replay-and-gateway-env.md Part A). The
      // URL is baked into `baseURL` at construction, exactly like the model is
      // bound there — so re-applying a changed one has to invalidate the memo
      // or the session keeps talking to the endpoint it was born with.
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);
      expect(constructorMock).toHaveBeenCalledWith(baseConfig.model, 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });

      const change = client.syncAuth(baseConfig.model, baseConfig.apiKey, 'https://llm.corp.example');
      expect(change).toBe('AI gateway https://llm.corp.example → https://llm.corp.example');

      await client.complete([{ role: 'user', content: 'Hi again' }]);
      expect(constructorMock).toHaveBeenCalledTimes(2);
      expect(constructorMock).toHaveBeenLastCalledWith(baseConfig.model, 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
    });

    it('leaves the gateway alone when the URL is unchanged or not passed at all', async () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      await client.complete([{ role: 'user', content: 'Hi' }]);

      // Same URL, and then the two-argument form every other call site uses:
      // an omitted `gatewayUrl` means "not managed here", not "cleared".
      expect(client.syncAuth(baseConfig.model, baseConfig.apiKey, baseConfig.gatewayUrl)).toBeNull();
      expect(client.syncAuth(baseConfig.model, baseConfig.apiKey)).toBeNull();

      await client.complete([{ role: 'user', content: 'Hi again' }]);
      expect(constructorMock).toHaveBeenCalledTimes(1);
      // And the omitted form did not blank the config out from under the build.
      expect(constructorMock).toHaveBeenLastCalledWith(baseConfig.model, 'test-key', {
        baseURL: 'https://llm.corp.example/v1',
      });
    });

    it('reports a model, key AND gateway change together, without the key', () => {
      const client = new AiClient(baseConfig, tokenTracker as any);
      const change = client.syncAuth(
        'aibroker/openai/chatgpt-6',
        'new-key',
        'https://llm.corp.example',
      );
      expect(change).toBe(
        'AI model aibroker/openai/chatgpt-5.5 → aibroker/openai/chatgpt-6; ' +
          'AI API key changed; ' +
          'AI gateway https://llm.corp.example → https://llm.corp.example',
      );
      expect(change).not.toContain('new-key');
    });
  });
});
