/**
 * Secrets stay out of what the framework writes (stories/secret-redaction.md).
 *
 * One rule for what a secret is — `isSecretName`, by the name a value came
 * in under — and one way of masking it: every occurrence of the value in the
 * text being written becomes `***`. Used by the console step line, the
 * report, the per-run log file and the compile's recording, so none of them
 * can disagree about what to hide.
 *
 * Masking is applied at the outputs only. The run keeps its real values: the
 * step types the real password, the action cache stores the real action, a
 * captured `[as: token]` flows to later steps unchanged.
 */
import { isSecretName } from '../parser/parameters.js';
import { envDataSecretValues, type EnvDataContext } from '../parser/interpolate-env-data.js';
import type { TestReport } from '../report/types.js';

export { isSecretName };

export const MASK = '***';

/**
 * Is a `${…}` reference a secret? By its PATH, not its last segment:
 * `${data.secrets.smtp.host}` is one because `secrets` is on the way to it.
 *
 * The same rule {@link envDataSecretValues} applies when it collects the
 * values to mask — everything under a secret-named key — expressed over the
 * reference instead of over the tree, for the surfaces that hold the
 * reference and not the value (the prompt's `## Values` block). `${env.X}`
 * has two segments and masks on the second, which is where an `.env` secret's
 * name lives.
 */
export function isSecretRef(ref: string): boolean {
  return ref.split('.').some((segment) => isSecretName(segment));
}

/** The values to mask: those of secret-named parameters, plus any the caller
 *  names (the environment's secrets). Empty values are never secrets — there
 *  is nothing to find, and `split('')` would shred the text. */
export function secretValues(parameters: Record<string, string>, extra: string[] = []): string[] {
  const fromParameters = Object.entries(parameters)
    .filter(([name, value]) => isSecretName(name) && value.length > 0)
    .map(([, value]) => value);
  return [...new Set([...fromParameters, ...extra.filter((v) => v.length > 0)])];
}

/**
 * The values a run must never print: its secret-named parameters (which
 * grow during the run — `[as: …]` captures, `[input: …]` answers — so take
 * this fresh at each use rather than once) plus the env/data secrets of the
 * context its `${…}` references resolved against.
 */
export function runSecrets(run: {
  parameters: Record<string, string>;
  envData?: EnvDataContext | null | undefined;
}): string[] {
  return secretValues(run.parameters, run.envData ? envDataSecretValues(run.envData) : []);
}

/** Every occurrence of a secret value, replaced. Longest first, so a value
 *  that contains another is masked whole. */
export function redact(text: string, secrets: string[]): string {
  if (secrets.length === 0) return text;
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Keys whose values are never masked: base64 image data, where a short
 * secret can match by coincidence and a replacement would corrupt the image.
 * (`screenshot` is the server's `data:image/png;base64,…` form of the same;
 * a `data:image/` string under any other key — a prompt's image part in a
 * trace payload — is skipped by its prefix.)
 */
const BINARY_KEYS = new Set(['screenshotBase64', 'screenshot']);

/**
 * A deep copy of `value` with every string masked by value. Arrays and
 * plain objects are walked; anything else (numbers, booleans, null, class
 * instances such as Dates) is kept as is. Keys in {@link BINARY_KEYS} are
 * copied untouched.
 *
 * By value only, never by key name: the walk sees every object in a report,
 * and `isSecretName` over-matches on purpose — a `press` action's
 * `key: "Enter"` is not a secret. Maps that hold values *under* their
 * names go through {@link redactMap} instead.
 */
export function redactDeep<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  return walk(value, secrets, undefined) as T;
}

function walk(value: unknown, secrets: string[], key: string | undefined): unknown {
  if (typeof value === 'string') {
    const binary = (key !== undefined && BINARY_KEYS.has(key)) || value.startsWith('data:image/');
    return binary ? value : redact(value, secrets);
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, secrets, undefined));
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, secrets, k);
      }
      return out;
    }
  }
  return value;
}

/** A map of values held under their names — resolved parameters, captured
 *  outputs: secret-named entries masked outright, every other value masked
 *  by value. Outright, because the name is the rule: a secret-named entry
 *  whose value is not in `secrets` (an empty one, say) still says what it is. */
export function redactMap(map: Record<string, string>, secrets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k] = isSecretName(k) ? MASK : redact(v, secrets);
  return out;
}

/**
 * The report as every consumer should see it: each string masked by value,
 * the resolved parameters masked by name as well. A copy; the run's own
 * objects are left alone.
 */
export function redactReport(report: TestReport, secrets: string[]): TestReport {
  if (secrets.length === 0 && !report.parameters) return report;
  const out = redactDeep(report, secrets);
  return report.parameters ? { ...out, parameters: redactMap(report.parameters, secrets) } : out;
}
