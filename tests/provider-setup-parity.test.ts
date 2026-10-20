/**
 * Choosing the AI with a provider key (docs/specs/SPEC-install.md §7.2):
 * src/ai/provider-setup.ts for `steptix ai`, and runner-core's copy for the
 * VS Code extension's AI step, which must give the same answers.
 *
 * The providers' answers below are constructed from their documented list
 * shapes ({ data: [{ id }] }); nothing here calls a provider.
 */
import { describe, expect, it } from 'vitest';
import * as cli from '../src/ai/provider-setup.js';
// runner-core's source, as control-line-parity.test.ts explains.
import * as core from '../runner-core/src/ai-providers.ts';

type Answer = { status: number; body?: unknown } | Error;

/** A provider that answers each URL as given, and records what was asked. */
function provider(answers: Record<string, Answer>) {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: cli.ProviderFetch = async (url, init) => {
    asked.push({ url, headers: init.headers });
    const answer = answers[url];
    if (answer === undefined) throw new Error(`unexpected request to ${url}`);
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  return { fetchFn, asked };
}

const OPENAI = 'https://api.openai.com/v1/models';
const ANTHROPIC = 'https://api.anthropic.com/v1/models?limit=1000';
const OR_KEY = 'https://openrouter.ai/api/v1/key';
const OR_MODELS = 'https://openrouter.ai/api/v1/models';

describe('checking a key', () => {
  it('lists the models a working key can use, sending the key the way each provider wants it', async () => {
    const p = provider({
      [OPENAI]: { status: 200, body: { data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-mini' }] } },
      [ANTHROPIC]: { status: 200, body: { data: [{ id: 'claude-sonnet-5-5' }] } },
      [OR_KEY]: { status: 200, body: { data: {} } },
      [OR_MODELS]: { status: 200, body: { data: [{ id: 'openai/gpt-6-luna' }, { id: 'ada/model-x' }] } },
    });
    expect(await cli.checkProviderKey('openai', 'provider-test-key', p.fetchFn, 'VS Code')).toEqual({ ok: true, models: ['gpt-6-luna', 'gpt-6-mini'] });
    expect(await cli.checkProviderKey('anthropic', 'provider-test-key', p.fetchFn, 'VS Code')).toEqual({ ok: true, models: ['claude-sonnet-5-5'] });
    expect(await cli.checkProviderKey('openrouter', 'provider-test-key', p.fetchFn, 'VS Code')).toEqual({ ok: true, models: ['openai/gpt-6-luna', 'ada/model-x'] });
    expect(p.asked[0]!.headers).toEqual({ Authorization: 'Bearer provider-test-key' });
    expect(p.asked[1]!.headers).toEqual({ 'x-api-key': 'provider-test-key', 'anthropic-version': '2023-06-01' });
    expect(p.asked[2]!.url).toBe(OR_KEY);
  });

  it('refuses a key the provider does not accept, in its words, before anything is saved', async () => {
    const p = provider({ [ANTHROPIC]: { status: 401 }, [OR_KEY]: { status: 401 } });
    expect(await cli.checkProviderKey('anthropic', 'provider-test-key', p.fetchFn, 'VS Code')).toEqual({
      ok: false,
      reason: 'rejected',
      message: 'Anthropic did not accept this key. Check that you copied all of it, or make a new one.',
    });
    expect((await cli.checkProviderKey('openrouter', 'provider-test-key', p.fetchFn, 'VS Code')).ok).toBe(false);
    expect((await cli.checkProviderKey('openai', '  ', p.fetchFn, 'VS Code')).ok).toBe(false);
  });

  it("names the network's reason and where a proxy would be set when the provider is out of reach", async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const p = provider({ [OR_KEY]: refused });
    expect(await cli.checkProviderKey('openrouter', 'provider-test-key', p.fetchFn, 'this terminal (HTTPS_PROXY)')).toEqual({
      ok: false,
      reason: 'unreachable',
      message: 'Could not reach OpenRouter: ENOTFOUND. Your company may need its proxy set for this terminal (HTTPS_PROXY).',
    });
  });
});

describe('the model list', () => {
  it("puts Steptix's recommended model first, then every model the key can use", () => {
    expect(cli.modelChoices('anthropic', ['claude-haiku-5', 'claude-sonnet-5-5'])).toEqual([
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · recommended for Steptix', recommended: true },
      { id: 'claude-haiku-5', label: 'claude-haiku-5', recommended: false },
    ]);
    // OpenAI's recommendation is offered even when its list leaves it out.
    expect(cli.modelChoices('openai', ['gpt-6-mini'])[0]).toMatchObject({ id: 'gpt-6-luna', recommended: true });
  });

  it('offers GPT 6 Luna on OpenRouter only when OpenRouter does', () => {
    expect(cli.modelChoices('openrouter', ['ada/model-x']).map((m) => m.id)).toEqual(['ada/model-x']);
    expect(cli.modelChoices('openrouter', ['ada/model-x', 'openai/gpt-6-luna']).map((m) => m.id)).toEqual([
      'openai/gpt-6-luna',
      'ada/model-x',
    ]);
  });
});

describe('what a choice writes and how it is shown', () => {
  it("writes AI_MODEL with the provider's prefix, and shows it as a person reads it", () => {
    expect(cli.aiModelFor('anthropic', 'claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5-5');
    expect(cli.describeAiModel('gateway/copilot/gpt-6-luna')).toBe('Copilot · GPT 6 Luna');
    expect(cli.describeAiModel('anthropic/claude-sonnet-5-5')).toBe('Anthropic · Claude Sonnet 5.5');
    expect(cli.describeAiModel('openrouter/ada/model-x')).toBe('OpenRouter · ada/model-x');
    expect(cli.describeAiModel('bedrock/some-model')).toBe('bedrock/some-model');
    expect(cli.maskKey('provider-test-key-a1b2')).toBe('…a1b2');
  });

  it('sets and removes lines in a .env, every other line kept', () => {
    const before = '# mine\nSTEPTIX_SERVER_URL=http://127.0.0.1:3100\nAI_MODEL=openai/old\nAI_GATEWAY_URL=http://127.0.0.1:18790\n';
    expect(cli.setEnvValues(before, { AI_MODEL: 'anthropic/claude-sonnet-5-5', AI_API_KEY: 'provider-test-key', AI_GATEWAY_URL: null })).toBe(
      '# mine\nSTEPTIX_SERVER_URL=http://127.0.0.1:3100\nAI_MODEL=anthropic/claude-sonnet-5-5\nAI_API_KEY=provider-test-key\n',
    );
    expect(cli.setEnvValues('', { AI_MODEL: 'openai/gpt-6-luna' })).toBe('AI_MODEL=openai/gpt-6-luna\n');
  });

  it('finds the empty AI_API_KEY= line that keeps the all-projects key out of a project', () => {
    expect(cli.envValueBlank('AI_API_KEY=\n', 'AI_API_KEY')).toBe(true);
    expect(cli.envValueBlank('AI_API_KEY=""\n', 'AI_API_KEY')).toBe(true);
    expect(cli.envValueBlank('AI_API_KEY=provider-test-key\n', 'AI_API_KEY')).toBe(false);
    expect(cli.envValueBlank('# AI_API_KEY=\n', 'AI_API_KEY')).toBe(false);
  });
});

describe('saving a provider choice', () => {
  it("writes the model and key, and drops a gateway on this machine, which is Copilot's bridge", () => {
    expect(cli.providerEnvText('AI_GATEWAY_URL=http://127.0.0.1:18790\nAI_MODEL=gateway/copilot/gpt-6-luna\n', 'openai', 'gpt-6-luna', 'provider-test-key')).toBe(
      'AI_MODEL=openai/gpt-6-luna\nAI_API_KEY=provider-test-key\n',
    );
  });

  it("keeps a gateway anywhere else, which is the user's own", () => {
    expect(cli.providerEnvText('AI_GATEWAY_URL=https://gateway.example.test\n', 'openai', 'gpt-6-luna', 'provider-test-key')).toBe(
      'AI_GATEWAY_URL=https://gateway.example.test\nAI_MODEL=openai/gpt-6-luna\nAI_API_KEY=provider-test-key\n',
    );
  });

  it('adds .env to a .gitignore on a line of its own', () => {
    expect(cli.withEnvIgnored('')).toBe('.env\n');
    expect(cli.withEnvIgnored('node_modules')).toBe('node_modules\n.env\n');
    expect(cli.withEnvIgnored('node_modules\n')).toBe('node_modules\n.env\n');
  });

  it("names the AI settings a project's .env makes for itself, and not empty ones", () => {
    expect(cli.projectAiOverrides('AI_MODEL=openai/gpt-6-luna\nexport AI_API_KEY=provider-test-key\n')).toEqual(['AI_MODEL', 'AI_API_KEY']);
    expect(cli.projectAiOverrides('AI_API_KEY=\n# AI_MODEL=x\nSTEPTIX_SERVER_URL=http://127.0.0.1:3100\n')).toEqual([]);
  });
});

describe("runner-core's copy", () => {
  it('lists the same providers and recommended models', () => {
    expect(core.AI_PROVIDERS).toEqual(cli.AI_PROVIDERS);
    expect(core.COPILOT_RECOMMENDED_MODEL).toEqual(cli.COPILOT_RECOMMENDED_MODEL);
  });

  it('gives the same answers', async () => {
    const answers: Record<string, Answer> = {
      [OPENAI]: { status: 200, body: { data: [{ id: 'gpt-6-luna' }] } },
      [ANTHROPIC]: { status: 403 },
      [OR_KEY]: new Error('network down'),
    };
    for (const id of ['openai', 'anthropic', 'openrouter'] as const) {
      expect(await core.checkProviderKey(id, 'provider-test-key', provider(answers).fetchFn, 'VS Code')).toEqual(
        await cli.checkProviderKey(id, 'provider-test-key', provider(answers).fetchFn, 'VS Code'),
      );
      expect(core.modelChoices(id, ['openai/gpt-6-luna', 'x', 'x'])).toEqual(cli.modelChoices(id, ['openai/gpt-6-luna', 'x', 'x']));
    }
    for (const model of ['gateway/copilot/gpt-6-luna', 'gateway/copilot/other', 'openai/gpt-6-luna', 'nothing']) {
      expect(core.describeAiModel(model)).toBe(cli.describeAiModel(model));
    }
    const text = 'A=1\nexport AI_MODEL=x\nAI_MODEL=y\n';
    expect(core.setEnvValues(text, { AI_MODEL: 'z', B: '2' })).toBe(cli.setEnvValues(text, { AI_MODEL: 'z', B: '2' }));
    expect(core.envValueBlank('AI_API_KEY=', 'AI_API_KEY')).toBe(cli.envValueBlank('AI_API_KEY=', 'AI_API_KEY'));
    expect(core.maskKey('abc')).toBe(cli.maskKey('abc'));
    const env = 'AI_GATEWAY_URL=http://localhost:18790\nAI_MODEL=y\n';
    expect(core.providerEnvText(env, 'anthropic', 'm', 'k')).toBe(cli.providerEnvText(env, 'anthropic', 'm', 'k'));
    expect(core.withEnvIgnored('a')).toBe(cli.withEnvIgnored('a'));
    expect(core.projectAiOverrides(env + 'AI_API_KEY=k\n')).toEqual(cli.projectAiOverrides(env + 'AI_API_KEY=k\n'));
  });
});
