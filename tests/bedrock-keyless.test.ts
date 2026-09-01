/**
 * Keyless AI that is nonetheless configured — stories/bedrock-provider.md
 * §Part B.
 *
 * A Bedrock project signing with the AWS credential chain has no `AI_API_KEY`
 * and never will, so `aiConfigured` stopped being "is there a key" and became
 * "is there a key, OR does this model route to a provider that supplies its
 * own". Everything downstream — the run-settings echo, the executor's
 * `keyless` flag, which error an AI call throws — hangs off that one predicate,
 * and the interesting cases are all COMPOSITIONS rather than shapes:
 *
 *  - keyless Bedrock plus a session model override to a keyed provider, which
 *    must NOT report configured (the model the run will actually use is the
 *    one that has no key);
 *  - `ai: "off"` on a Bedrock run that would otherwise work, which must still
 *    refuse and must say `policy`, never `no key`.
 *
 * ── Why the library is mocked ───────────────────────────────────────────────
 * The pin is `@pkent/aigateway@1.4.0-beta.2`, which has no `bedrock` provider —
 * the one carrying it is built but unpublished (§Rollout). So the registry is
 * stubbed here with the shape that version will report, the same way
 * tests/ai-client.test.ts stubs the gateway class. Until the publish this is
 * the only way to exercise the branch at all; after it, these cases keep
 * working and one live compile proves the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config, RunSettings } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    success: vi.fn(), step: vi.fn(), trace: vi.fn(),
  },
}));

/** Records `new AIGateway(model, key, options)` — the empty key a keyless
 *  Bedrock run passes is part of the contract, not an accident. */
const constructorMock = vi.fn();
const chatMock = vi.fn();

vi.mock('@pkent/aigateway', () => {
  class FakeAIGateway {
    chat: typeof chatMock;
    stream = vi.fn();
    constructor(model: string, key: string, options: unknown) {
      constructorMock(model, key, options);
      this.chat = chatMock;
    }
    /**
     * What 1.4.0-beta.5 reports. `selfAuthenticating` is present only where it
     * is true, so a consumer reading it off `anthropic` gets `undefined` — the
     * shape the framework has to cope with, not a tidied-up boolean on every
     * entry.
     */
    static providers() {
      return [
        { id: 'openrouter', prefix: 'openrouter/' },
        { id: 'anthropic', prefix: 'anthropic/' },
        { id: 'openai', prefix: 'openai/' },
        { id: 'aibroker', prefix: 'aibroker/' },
        { id: 'gateway', prefix: 'gateway/' },
        { id: 'bedrock', prefix: 'bedrock/', selfAuthenticating: true },
      ];
    }
  }
  return { AIGateway: FakeAIGateway, default: FakeAIGateway };
});

import { aiConfigured } from '../src/config/loader.js';
import { resolveRunSettings } from '../src/config/run-settings.js';
import {
  AiClient,
  AiForbiddenByPolicyError,
  AiNotConfiguredError,
} from '../src/ai/client.js';

const BEDROCK_MODEL = 'bedrock/global.anthropic.claude-opus-4-6-v1';

/** A Mode-2 Bedrock config: a model that self-authenticates and no key at all,
 *  which is what a correct AWS-credential-chain setup looks like. */
function bedrockKeyless(): Config {
  return { ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, model: BEDROCK_MODEL, apiKey: undefined } };
}

const tokenTracker = { addUsage: vi.fn(), checkStepBudget: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  chatMock.mockResolvedValue({
    id: 'resp-1',
    object: 'response',
    created: 1776692376,
    provider: 'bedrock',
    model: BEDROCK_MODEL,
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{}' }],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });
});

// ─── The predicate ──────────────────────────────────────────────────────────

describe('aiConfigured', () => {
  it('is true for a keyless model whose provider self-authenticates', () => {
    expect(aiConfigured(bedrockKeyless().ai)).toBe(true);
  });

  it('is still false for a keyless model whose provider does not', () => {
    // The control. Without it, a predicate that simply returned true would
    // pass the case above while ending keyless mode for everyone.
    const ai = { ...bedrockKeyless().ai, model: 'anthropic/claude-opus-4-8' };
    expect(aiConfigured(ai)).toBe(false);
  });

  it('is still true with a key, on either kind of provider', () => {
    // Bedrock's bearer-token mode is an ordinary keyed config, and the key half
    // of the predicate is untouched by any of this.
    expect(aiConfigured({ ...bedrockKeyless().ai, apiKey: 'bedrock-bearer' })).toBe(true);
    expect(aiConfigured({ ...bedrockKeyless().ai, model: 'openai/gpt-4o', apiKey: 'sk-1' })).toBe(true);
  });

  it('still treats a whitespace key as absent', () => {
    // Unchanged: an `AI_API_KEY= ` line means the same "no key" it always did,
    // and on a non-self-authenticating model that is still the whole answer.
    expect(aiConfigured({ ...bedrockKeyless().ai, model: 'openai/gpt-4o', apiKey: '   ' })).toBe(false);
  });

  it('matches on the provider prefix, not on the word "bedrock"', () => {
    // A model that merely mentions it — including as a non-leading segment —
    // routes elsewhere and has no AWS credentials to sign with.
    expect(aiConfigured({ ...bedrockKeyless().ai, model: 'openrouter/bedrock/claude' })).toBe(false);
    expect(aiConfigured({ ...bedrockKeyless().ai, model: 'bedrockish/model' })).toBe(false);
  });
});

// ─── The composition that would report AI it does not have ──────────────────

describe('resolveRunSettings with a keyless Bedrock project', () => {
  const server = bedrockKeyless();

  function resolve(overrides: RunSettings, project: Config = server) {
    return resolveRunSettings(server, project, server.ai.model, overrides, { ai: server.ai });
  }

  it('reports AI on, with no key anywhere', () => {
    const { effective } = resolve({});

    expect(effective.ai).toBe('on');
    expect(effective.aiOffReason).toBeNull();
    expect(server.ai.apiKey).toBeUndefined();
  });

  it('reports AI off once a session override points at a provider that needs a key', () => {
    // THE trap. The resolver is deliberately handed the PRE-override model, so
    // a `keyed` check that read the config's own `model` would answer for
    // Bedrock while the run actually talks to Anthropic — reporting `on` and
    // then dying on an empty key at the first call.
    const { effective } = resolve({ model: 'anthropic/claude-opus-4-8' });

    expect(effective.model).toBe('anthropic/claude-opus-4-8');
    expect(effective.ai).toBe('off');
    expect(effective.aiOffReason).toBe('no-key');
  });

  it('reports AI on when the override points at another self-authenticating model', () => {
    // The other half of the same question: the override is not disqualifying
    // in itself, it just moves which model the answer is about.
    const { effective } = resolve({ model: 'bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0' });

    expect(effective.ai).toBe('on');
    expect(effective.aiOffReason).toBeNull();
  });

  it('keeps a keyed override working', () => {
    // A key present on the config plus an override to a keyed provider is the
    // ordinary case, and must not be collateral damage of the fix above.
    const keyed: Config = { ...server, ai: { ...server.ai, apiKey: 'sk-1' } };
    const { effective } = resolveRunSettings(keyed, keyed, keyed.ai.model, {
      model: 'anthropic/claude-opus-4-8',
    }, { ai: keyed.ai });

    expect(effective.ai).toBe('on');
  });

  it('says policy, not no-key, when a working Bedrock run is switched off', () => {
    // The second trap. This run HAS AI — it just was not allowed to use it —
    // so `AI: off (no key)` would send the reader to add a key that Bedrock has
    // no use for, which is the exact failure Part B exists to remove.
    const { effective } = resolve({ ai: 'off' });

    expect(effective.ai).toBe('off');
    expect(effective.aiOffReason).toBe('policy');
    expect(effective.sources.ai).toBe('session');
  });

  it('says policy for a project-level allowInRuns: false too', () => {
    const project: Config = { ...server, ai: { ...server.ai, allowInRuns: false } };
    const { effective } = resolve({}, project);

    expect(effective.ai).toBe('off');
    expect(effective.aiOffReason).toBe('policy');
  });
});

// ─── What an AI call does on such a run ─────────────────────────────────────

describe('AiClient on a keyless Bedrock config', () => {
  it('builds the gateway and calls the model, passing an empty key', async () => {
    // The whole point of Part B: the request is MADE. And the key it goes out
    // with is `''` — the framework does not invent one, and the library's key
    // check is what has to let a self-authenticating provider past it.
    const client = new AiClient(bedrockKeyless().ai, tokenTracker as never);

    await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(constructorMock).toHaveBeenCalledWith(BEDROCK_MODEL, '', {});
    expect(chatMock).toHaveBeenCalled();
  });

  it('still refuses on the same config with a key-needing model', async () => {
    // The control for the case above: the reactive backstop is intact, and it
    // is the model — not the mere absence of a key — that decides.
    const client = new AiClient(
      { ...bedrockKeyless().ai, model: 'anthropic/claude-opus-4-8' },
      tokenTracker as never,
    );

    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it('refuses by POLICY, not for want of a key, when the run forbids AI', async () => {
    // Composed rather than asserted apart: a keyless config AND a lowered veil
    // together are the state where the two errors could collapse into one, and
    // `AiNotConfiguredError`'s advice would be wrong twice over.
    const client = new AiClient(bedrockKeyless().ai, tokenTracker as never);
    client.setAiPolicy(false);

    const call = client.complete([{ role: 'user', content: 'Hi' }]);

    await expect(call).rejects.toBeInstanceOf(AiForbiddenByPolicyError);
    await expect(call).rejects.not.toBeInstanceOf(AiNotConfiguredError);
    await expect(call).rejects.toThrow(/forbids AI/);
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it('forwards AI_EFFORT with a bedrock model like any other', async () => {
    // Smoke: `output_config.effort` is always sent once effort is set, and
    // Bedrock documents it neither way — so this pins that the framework does
    // not quietly drop it for this provider.
    const client = new AiClient({ ...bedrockKeyless().ai, effort: 'high' }, tokenTracker as never);

    await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(chatMock.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' });
  });
});

// ─── The inert-pair warning ─────────────────────────────────────────────────

describe('the AI_GATEWAY_URL inert-pair warning', () => {
  it('does not tell a Bedrock user to switch to a gateway model', async () => {
    // This audience is unusually likely to have both set — a corporate gateway
    // configured, and Bedrock as the approved AI. The pairing IS inert and
    // still worth saying, but "Set AI_MODEL=gateway/<model>" as the only advice
    // is wrong: the traffic already goes to infrastructure they control.
    const { logger } = await import('../src/utils/logger.js');
    const client = new AiClient(
      { ...bedrockKeyless().ai, gatewayUrl: 'https://llm.corp.example' },
      tokenTracker as never,
    );

    await client.complete([{ role: 'user', content: 'Hi' }]);

    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('https://llm.corp.example');
    expect(warned).toContain(BEDROCK_MODEL);
    // Both readings offered, and the one that applies here named outright.
    expect(warned).toContain('AI_MODEL=gateway/<model>');
    expect(warned).toContain('your own AWS account');
    // And the request still goes: warned, never refused.
    expect(constructorMock).toHaveBeenCalledWith(BEDROCK_MODEL, '', {});
  });
});
