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

/**
 * Re-exported as the one rule for names the AUTHOR chose — parameters,
 * `[store as:]` captures, `${…}` references. It matches on a SUBSTRING, which
 * is what makes a dotted loop binding work without a second rule:
 * `{{order.password}}` is a secret because `password` is in it, and so is the
 * `order.password` entry of the live variable map a pass leaves behind
 * (docs/specs/SPEC-structured-table-reads.md §8.4). The same breadth is why a
 * record stored under a variable literally named `token` is masked whole —
 * the name is the rule, and the name says secret.
 *
 * Column names inside a record are NOT author-chosen — they come off the page
 * — so they go through {@link isRecordSecretKey} instead, which is narrower on
 * purpose. See it for why.
 */
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

/**
 * Is a RECORD COLUMN's name a secret? Whole words, not substrings.
 *
 * `isSecretName` is deliberately broad because the author picked the name. A
 * record's keys are picked off the page — a `readTable` column alias, a header
 * turned into a property — and there the same breadth masks the wrong things:
 * `keyword` and `sort_key` both contain `key`. Masking is not a free
 * precaution, because {@link redact} replaces that value EVERYWHERE, including
 * in the DOM snapshot the model plans its next action from.
 *
 * So: `password` / `secret` / `token` as whole words anywhere in the name, and
 * `key` only where something makes it a credential (`api_key`, `apiKey`,
 * `access_key`, `private_key`). A column called plainly `key` is far more often
 * a sort key or an id, and is not masked; a test that needs it hidden can name
 * the column `api_key` or capture it into a secret-named variable, where the
 * author-chosen rule applies.
 */
const RECORD_SECRET_WORD = /(^|_)(password|passwd|pwd|secret|token|otp|credential|credentials)(_|$)/;
const RECORD_SECRET_KEY = /(^|_)(api|access|private|auth|signing|encryption)_keys?(_|$)/;
export function isRecordSecretKey(key: string): boolean {
  const words = key
    // camelCase and PascalCase read as words too: apiKey → api_Key.
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return RECORD_SECRET_WORD.test(words) || RECORD_SECRET_KEY.test(words);
}

/**
 * Shortest record-derived value that may join the mask set.
 *
 * Nothing this short is a credential, and masking it is actively harmful: a
 * `token` column holding `-`, `-` and `7` put `-` and `7` in the mask set, and
 * `redact` then replaced every dash and every seven in every output — the run
 * log, the report, and the DOM snapshot the model plans from. A parameter the
 * author named keeps no floor: that name is a deliberate instruction.
 */
const RECORD_SECRET_MIN_LENGTH = 4;

/** The answer for a value that holds no records. One shared frozen array, so
 *  the memoised path can return by identity. */
const NO_RECORD_SECRETS: readonly string[] = Object.freeze([]);

/** How many parsed values the memo holds. A capture is one entry, and a run
 *  has a handful live at once; the bound is what stops a long run that
 *  recaptures the same variable hundreds of times from retaining all of them. */
const RECORD_SECRET_CACHE_MAX = 64;
const recordSecretCache = new Map<string, readonly string[]>();

/**
 * The secret values inside ONE parameter value that holds a list of records.
 *
 * A `readTable` capture is a single string under a non-secret name
 * ("orders"), so the rule has to reach inside it: a `password` column is a
 * secret however the row it sits in is named (§7.6).
 *
 * Memoised on the value string, because it is not asked once. `secretsNow()`
 * rebuilds the mask set at every surface that writes anything — the console
 * line, the report, the log file — and re-parsing a 500-row capture each time
 * cost ~0.9 ms a call for one variable. The same string always has the same
 * answer, so the parse is done once.
 *
 * The sniff is on `[`, not on `[{`: a list may be pretty-printed or spaced by
 * whatever produced it (`[ {`, or a newline), and those forms read as
 * "not a record list" and masked nothing at all.
 */
export function recordSecretValues(value: string): readonly string[] {
  if (!/^\s*\[/.test(value)) return NO_RECORD_SECRETS;
  const cached = recordSecretCache.get(value);
  if (cached) return cached;

  const found: string[] = [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length >= RECORD_SECRET_MIN_LENGTH && isRecordSecretKey(k)) {
            found.push(v);
          }
        }
      }
    }
  } catch {
    /* not a record list */
  }

  const result: readonly string[] =
    found.length === 0 ? NO_RECORD_SECRETS : Object.freeze([...new Set(found)]);
  if (recordSecretCache.size >= RECORD_SECRET_CACHE_MAX) {
    // Insertion order: drop the oldest entry.
    const oldest = recordSecretCache.keys().next();
    if (!oldest.done) recordSecretCache.delete(oldest.value);
  }
  recordSecretCache.set(value, result);
  return result;
}

/** The values to mask: those of secret-named parameters, plus any the caller
 *  names (the environment's secrets). Empty values are never secrets — there
 *  is nothing to find, and `split('')` would shred the text. */
export function secretValues(parameters: Record<string, string>, extra: string[] = []): string[] {
  const fromParameters = Object.entries(parameters)
    .filter(([name, value]) => isSecretName(name) && value.length > 0)
    .map(([, value]) => value);
  const fromRecords: string[] = [];
  for (const value of Object.values(parameters)) {
    for (const secret of recordSecretValues(value)) fromRecords.push(secret);
  }
  return [...new Set([...fromParameters, ...fromRecords, ...extra.filter((v) => v.length > 0)])];
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

/** What an empty secret-named value renders as. Nothing is disclosed by
 *  saying a field was blank, and `***` over an empty cell makes a report's
 *  matrix unable to tell "wrong password" from "no password" — the two rows
 *  of a data table that most need telling apart. Same word the client's
 *  `maskIfSecret` (runner-core) uses, so the Output banner and the report
 *  say the same thing about the same cell. */
export const EMPTY = '(empty)';

/** A map of values held under their names — resolved parameters, captured
 *  outputs, a data row's cells: secret-named entries masked outright, every
 *  other value masked by value. Outright, because the name is the rule: a
 *  secret-named entry whose value is not in `secrets` still says what it is.
 *  The one exception is an EMPTY one, which says {@link EMPTY} instead. */
export function redactMap(map: Record<string, string>, secrets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = isSecretName(k) ? (v === '' ? EMPTY : MASK) : redact(v, secrets);
  }
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
