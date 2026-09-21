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
 * Re-exported as the one rule for names the AUTHOR chose — flat parameters,
 * `[store as:]` captures, `${…}` references. It matches on a SUBSTRING, which
 * is deliberate breadth for a name a human typed: a variable literally named
 * `token` is masked whole, because the name is the rule and the name says
 * secret.
 *
 * It is NOT the rule for a dotted name. A `For each` pass writes one entry per
 * property into the live variable map — `order.password`, `row.keyword`
 * (docs/specs/SPEC-structured-table-reads.md §8.4) — and the property half of
 * those came off the PAGE, where the same breadth masks the wrong things.
 * {@link isSecretParameterName} is the rule for a name that may be dotted, and
 * {@link isRecordSecretKey} the narrower one it applies to the page-derived
 * half. See that one for why.
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
 * So: `password` / `passwd` / `pwd` / `secret` / `token` / `otp` /
 * `credential` / `credentials` as whole words anywhere in the name, and `key`
 * (or `keys`) only behind one of the six prefixes that make it a credential —
 * `api`, `access`, `private`, `auth`, `signing`, `encryption` — in either
 * spelling, since camelCase reads as words too (`api_key`, `apiKey`,
 * `access_key`, `privateKey`, `auth_keys`, `signingKey`, `encryption_key`).
 * A column called plainly `key` is far more often a sort key or an id, and is
 * not masked; a test that needs it hidden can name the column `api_key` or
 * capture it into a secret-named variable, where the author-chosen rule
 * applies.
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

/**
 * Is a variable-map NAME a secret? The one rule for a name that may be dotted.
 *
 * A flat name is author-chosen end to end, so it keeps {@link isSecretName}'s
 * substring breadth. A dotted one — `row.keyword`, `order.password` — is half
 * author and half page: the author named the loop variable, the page named the
 * column. So it is a secret when the ROOT says so, or when the PROPERTY says
 * so under the whole-word record rule ({@link isRecordSecretKey}).
 *
 * Without the split, `isSecretName` read the joined name as one string and
 * `row.keyword` matched on `key` — so a `keyword` column bound as
 * `row.keyword = "AU"` masked every "AU" in the log, the report and the DOM
 * snapshot the model plans its next action from. That is the same
 * over-masking {@link isRecordSecretKey} exists to prevent inside a record,
 * arriving one door along as a map entry instead.
 *
 * Anything past the first dot is the property: `a.b.c` asks the record rule
 * about `b.c`, which normalises to `b_c` the same way a column name would.
 *
 * And the WHOLE name is asked too, with the dots read as separators
 * ({@link wholeNameIsRecordSecret}) — because not every dotted name is a
 * binding. A data-file column or a `[store as:]` output may be called
 * `api.key`, where neither half says secret and the two halves together say
 * nothing but. That is the same reading the record rule gives `api_key`, so
 * `row.keyword` and `payment.sort_key` stay clear of it.
 */
export function isSecretParameterName(name: string): boolean {
  const dot = name.indexOf('.');
  if (dot === -1) return isSecretName(name);
  return (
    isSecretName(name.slice(0, dot))
    || isRecordSecretKey(name.slice(dot + 1))
    || wholeNameIsRecordSecret(name)
  );
}

/** The dotted name read as ONE record key: `api.key` → `api_key`. The record
 *  rule, not the author rule, so it stays whole-word — a name that merely
 *  contains `key` across the dot (`row.keyword`) is not caught by it. */
function wholeNameIsRecordSecret(name: string): boolean {
  return name.includes('.') && isRecordSecretKey(name.split('.').join('_'));
}

/**
 * Does this name/value pair join the free-text mask set — the values
 * {@link redact} replaces EVERYWHERE, prose and DOM snapshot included?
 *
 * Stricter than {@link isSecretParameterName}, and only for the dotted case:
 * a page-derived property must also clear {@link RECORD_SECRET_MIN_LENGTH},
 * exactly as the same column would inside the record it came from. A `token`
 * column holding `7` masks its own map ENTRY (the name still says secret) but
 * must not turn every seven in every output into `***` — the round-1 defect,
 * which the pass bindings reintroduced by name.
 *
 * An author-chosen name, flat or as the root of a dotted one, keeps no floor:
 * that name is a deliberate instruction.
 */
function joinsMaskSet(name: string, value: string): boolean {
  if (value.length === 0) return false;
  const dot = name.indexOf('.');
  if (dot === -1) return isSecretName(name);
  if (isSecretName(name.slice(0, dot))) return true;
  return (
    (isRecordSecretKey(name.slice(dot + 1)) || wholeNameIsRecordSecret(name))
    && value.length >= RECORD_SECRET_MIN_LENGTH
  );
}

/**
 * The value as it appears INSIDE a JSON string: `he "said" hi` becomes
 * `he \"said\" hi`.
 *
 * A capture is STORED as JSON — one `readTable` variable is a JSON array of
 * records — so a secret containing `"` or `\` sits in the variable, the
 * report's parameter map and any trace payload in its escaped form, which the
 * raw value does not match. Prose was masked and the stored row was not.
 * Added alongside the raw form rather than instead of it, because both
 * spellings occur in the same run.
 */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Push `value` and, when they differ, its JSON-escaped spelling. */
function pushBothForms(into: string[], value: string): void {
  into.push(value);
  const escaped = jsonEscaped(value);
  if (escaped !== value) into.push(escaped);
}

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
          if (!isRecordSecretKey(k)) continue;
          // A cell is not always a string. `readTable` only ever writes them,
          // but a code-behind step or a tool can store
          // `[{"password":123456}]`, and a scan that looked at strings alone
          // left that six-digit code out of the set — so the report and the
          // run log printed it in full. Its JSON spelling is what the outputs
          // actually contain, and it is what `redact` has to look for.
          // null, objects and arrays are still left alone: there is no single
          // value there to find, and `String({})` would put `[object Object]`
          // in the mask set. A boolean is left out too: `true` and `false`
          // clear the floor, and a `token` column holding one would turn every
          // "true" in the DOM snapshot into the mask. In place, inside the
          // record, {@link maskRecordSecrets} still masks it — that replacement
          // reaches nothing outside its own cell.
          const text = typeof v === 'string'
            ? v
            : typeof v === 'number' ? String(v) : undefined;
          // The floor is the same one a string cell clears, and for the same
          // reason: this value is about to be replaced EVERYWHERE.
          if (text !== undefined && text.length >= RECORD_SECRET_MIN_LENGTH) {
            pushBothForms(found, text);
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

/**
 * One value with the secret COLUMNS of the records inside it replaced by
 * {@link MASK}. Anything that is not a record — or a list of them — comes back
 * byte for byte.
 *
 * The server twin of the client's `maskRecordSecrets` (runner-core/src/repl.ts),
 * which hides the same columns in the Output banner and the Variables panel.
 * Both exist because the NAME rule has nothing to catch here: a `readTable`
 * capture is a whole table under one author-chosen name (`payments`) and a
 * pass binding is one record under another (`payment`), so neither entry says
 * "look inside" and both render in full beside a `payment.password` row
 * showing `***`.
 *
 * {@link redact} cannot stand in for it. That one replaces values it was TOLD
 * about, and what it is told is filtered by {@link RECORD_SECRET_MIN_LENGTH}
 * and by what parsed — so a short or a freshly-captured cell survives it. This
 * is structural: the key decides, and the replacement reaches nothing outside
 * the cell it is in, which is why there is no length floor here.
 *
 * A non-string cell is masked too: `{"password":123}` becomes
 * `{"password":"***"}`. null, a nested object and an array are left alone —
 * there is no single value in them to blank, and blanking the whole branch
 * would delete structure the reader needs.
 *
 * A value nothing was masked in is returned as it arrived, character for
 * character: the re-stringify is compact, a tool may pretty-print, and
 * reformatting a value that held no secret would be this helper inventing a
 * change.
 */
export function maskRecordSecrets(value: string): string {
  if (!/^\s*[[{]/.test(value)) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  let masked = false;
  for (const record of records) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
    const cells = record as Record<string, unknown>;
    for (const [key, cell] of Object.entries(cells)) {
      if (cell === null || typeof cell === 'object') continue;
      if (!isRecordSecretKey(key)) continue;
      cells[key] = MASK;
      masked = true;
    }
  }
  return masked ? JSON.stringify(parsed) : value;
}

/** The values to mask: those of secret-named parameters, plus any the caller
 *  names (the environment's secrets). Empty values are never secrets — there
 *  is nothing to find, and `split('')` would shred the text.
 *
 *  A name is judged by {@link joinsMaskSet}, not by `isSecretName`: the map
 *  holds a loop's pass bindings as well as the author's own parameters, and
 *  `row.keyword` is not the author's word.
 *
 *  `extra` gets {@link pushBothForms} exactly as a parameter does. It was the
 *  one source that did not, and the values in it are the ones most likely to
 *  need it: `${env.SMTP_KEYFILE}` holding a Windows path is `C:\keys\…` in
 *  prose and `C:\\keys\\…` the moment anything stores it as JSON — masked in
 *  the sentence and printed in the capture beside it. */
export function secretValues(parameters: Record<string, string>, extra: string[] = []): string[] {
  const fromParameters: string[] = [];
  for (const [name, value] of Object.entries(parameters)) {
    if (joinsMaskSet(name, value)) pushBothForms(fromParameters, value);
  }
  const fromRecords: string[] = [];
  for (const value of Object.values(parameters)) {
    for (const secret of recordSecretValues(value)) fromRecords.push(secret);
  }
  const fromExtra: string[] = [];
  for (const value of extra) {
    if (value.length > 0) pushBothForms(fromExtra, value);
  }
  return [...new Set([...fromParameters, ...fromRecords, ...fromExtra])];
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
 *  The one exception is an EMPTY one, which says {@link EMPTY} instead.
 *
 *  By {@link isSecretParameterName}, so a dotted pass binding is decided by
 *  its own two segments. No length floor applies here: the floor exists to
 *  keep a short value out of the FREE-TEXT set, where it would be replaced
 *  everywhere, and this entry is the one place that value is named. So
 *  `row.token = "7"` shows as `***` here while every other seven survives. */
export function redactMap(map: Record<string, string>, secrets: string[]): Record<string, string> {
  return maskMapBy(map, secrets, isSecretParameterName);
}

/**
 * The same, for a map whose keys are author-chosen END TO END: a data row's
 * cells (src/report/merge-rows.ts) and a step's `[store as:]` outputs
 * (src/codebehind/recording.ts).
 *
 * {@link redactMap}'s two-segment rule is right for the variable map, which
 * holds a loop's `row.<column>` bindings — half author, half page. It is wrong
 * here, because nothing in either of these maps came off a page: a CSV column
 * headed `api.key`, `user.apikey` or `login.passkey` is a name a person typed,
 * and all three were masked by `isSecretName` until the dotted rule started
 * splitting them at the dot and asking the narrow record rule about the half
 * that was left. So these two go back to asking the author rule about the
 * WHOLE key, which is what it was written for.
 */
export function redactAuthoredMap(
  map: Record<string, string>,
  secrets: string[],
): Record<string, string> {
  return maskMapBy(map, secrets, isSecretName);
}

function maskMapBy(
  map: Record<string, string>,
  secrets: string[],
  isSecret: (name: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = isSecret(k) ? (v === '' ? EMPTY : MASK) : redact(v, secrets);
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
