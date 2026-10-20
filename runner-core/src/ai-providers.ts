/**
 * Choosing the AI with your own provider key (docs/specs/SPEC-install.md
 * §7.2, in the Steptix repo): the providers, checking a key by asking the
 * provider for its models, the model list with Steptix's recommended model
 * first, and the `.env` lines a choice writes.
 *
 * Shared by the extension's AI step and, as a deliberate copy, the
 * framework's `steptix ai` (src/ai/provider-setup.ts), which this bundle
 * cannot import. tests/provider-setup-parity.test.ts in the framework holds
 * the two to the same answers.
 */

export type ProviderId = 'openai' | 'anthropic' | 'openrouter';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** The provider's page for making a key. */
  keyPage: string;
  /** Steptix's recommended model there, by the provider's own id. */
  recommended: { id: string; label: string };
  /** Offer the recommended model only when the key's list has it. */
  recommendedOnlyIfOffered: boolean;
}

/** The recommended models ship with each release (§7.2). */
export const AI_PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyPage: 'https://platform.openai.com/api-keys',
    recommended: { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
    recommendedOnlyIfOffered: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyPage: 'https://console.anthropic.com/settings/keys',
    recommended: { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    recommendedOnlyIfOffered: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyPage: 'https://openrouter.ai/keys',
    recommended: { id: 'openai/gpt-6-luna', label: 'GPT 6 Luna' },
    recommendedOnlyIfOffered: true,
  },
];

/** Copilot's id for GPT 6 Luna, as `vscode.lm` lists it (runs record it as
 *  `gateway/copilot/gpt-6-luna`). */
export const COPILOT_RECOMMENDED_MODEL = { id: 'gpt-6-luna', label: 'GPT 6 Luna' };

export function providerInfo(id: ProviderId): ProviderInfo {
  return AI_PROVIDERS.find((p) => p.id === id)!;
}

export type KeyCheck =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'rejected' | 'unreachable' | 'unexpected'; message: string };

/** What a key check needs of `fetch`, so a test can answer for the provider. */
export type ProviderFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function idsOf(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data)
    ? data.map((m) => (m as { id?: unknown }).id).filter((id): id is string => typeof id === 'string')
    : [];
}

/**
 * Check a key by asking the provider for the models it can use (§7.2 step 2),
 * before anything is saved. `proxyHint` names where a company proxy would be
 * set: "VS Code" in the extension, "this terminal" for `steptix ai`.
 */
export async function checkProviderKey(
  provider: ProviderId,
  key: string,
  fetchFn: ProviderFetch,
  proxyHint: string,
): Promise<KeyCheck> {
  const info = providerInfo(provider);
  const get = async (url: string, headers: Record<string, string>) => {
    try {
      return await fetchFn(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      const reason = cause?.code ?? cause?.message ?? (err as Error).message;
      return { error: `Could not reach ${info.label}: ${reason}. Your company may need its proxy set for ${proxyHint}.` };
    }
  };
  const rejected = (): KeyCheck => ({
    ok: false,
    reason: 'rejected',
    message: `${info.label} did not accept this key. Check that you copied all of it, or make a new one.`,
  });
  const unexpected = (status: number): KeyCheck => ({
    ok: false,
    reason: 'unexpected',
    message: `${info.label} answered HTTP ${status} when asked for its models. Try again in a moment.`,
  });

  const trimmed = key.trim();
  if (trimmed === '') return rejected();
  let models: Awaited<ReturnType<typeof get>>;
  if (provider === 'openai') {
    models = await get('https://api.openai.com/v1/models', { Authorization: `Bearer ${trimmed}` });
  } else if (provider === 'anthropic') {
    models = await get('https://api.anthropic.com/v1/models?limit=1000', {
      'x-api-key': trimmed,
      'anthropic-version': '2023-06-01',
    });
  } else {
    // OpenRouter lists its models to anyone, so the key is checked on its own.
    const keyCheck = await get('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${trimmed}` });
    if ('error' in keyCheck) return { ok: false, reason: 'unreachable', message: keyCheck.error };
    if (keyCheck.status === 401 || keyCheck.status === 403) return rejected();
    if (!keyCheck.ok) return unexpected(keyCheck.status);
    models = await get('https://openrouter.ai/api/v1/models', { Authorization: `Bearer ${trimmed}` });
  }
  if ('error' in models) return { ok: false, reason: 'unreachable', message: models.error };
  if (models.status === 401 || models.status === 403) return rejected();
  if (!models.ok) return unexpected(models.status);
  try {
    return { ok: true, models: idsOf(await models.json()) };
  } catch {
    return unexpected(models.status);
  }
}

export interface ModelChoice {
  /** The provider's own id, as `AI_MODEL` carries it after the prefix. */
  id: string;
  label: string;
  recommended: boolean;
}

/**
 * The model list (§7.2 step 3): Steptix's recommended model first (for
 * OpenRouter only when the key's list has it), then every model the key can
 * use, in the provider's order without repeats. The caller adds "Type a model
 * id…".
 */
export function modelChoices(provider: ProviderId, available: readonly string[]): ModelChoice[] {
  const info = providerInfo(provider);
  const out: ModelChoice[] = [];
  const offered = available.includes(info.recommended.id);
  if (offered || !info.recommendedOnlyIfOffered) {
    out.push({ id: info.recommended.id, label: `${info.recommended.label} · recommended for Steptix`, recommended: true });
  }
  for (const id of available) {
    if (id === info.recommended.id || out.some((m) => m.id === id)) continue;
    out.push({ id, label: id, recommended: false });
  }
  return out;
}

/** `AI_MODEL` for a provider's model: `openai/…`, `anthropic/…`, `openrouter/…`. */
export function aiModelFor(provider: ProviderId, modelId: string): string {
  return `${provider}/${modelId}`;
}

/**
 * What an `AI_MODEL` means to a person, for the status bar (§7.2): `Copilot ·
 * GPT 6 Luna`, `Anthropic · Claude Sonnet 5.5`, `OpenRouter · deepseek/v4`.
 */
export function describeAiModel(aiModel: string): string {
  const copilot = /^gateway\/copilot\/(.+)$/.exec(aiModel);
  if (copilot) {
    const id = copilot[1]!;
    return `Copilot · ${id === COPILOT_RECOMMENDED_MODEL.id ? COPILOT_RECOMMENDED_MODEL.label : id}`;
  }
  const slash = aiModel.indexOf('/');
  const info = AI_PROVIDERS.find((p) => p.id === aiModel.slice(0, slash));
  if (!info || slash < 0) return aiModel;
  const id = aiModel.slice(slash + 1);
  return `${info.label} · ${id === info.recommended.id ? info.recommended.label : id}`;
}

/** A key as it may be shown once saved: its last four characters only. */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? '…' : `…${trimmed.slice(-4)}`;
}

/**
 * `text` with each key in `values` set (or, for null, removed), every other
 * line kept as it was. A key that is not there yet goes at the end.
 */
export function setEnvValues(text: string, values: Record<string, string | null>): string {
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key === undefined || !(key in values)) {
      out.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = values[key];
    if (value !== null && value !== undefined) out.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key) && value !== null) out.push(`${key}=${value}`);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** True when `text` has `key=` with nothing after it: a line that, in a
 *  project's `.env`, keeps the all-projects value from reaching it (§7.2). */
export function envValueBlank(text: string, key: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    return m?.[1] === key && (m[2] === '' || m[2] === '""' || m[2] === "''");
  });
}
