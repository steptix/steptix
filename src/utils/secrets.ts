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
 * step types the real password, a captured `[as: token]` flows to later
 * steps unchanged.
 */
import { isSecretName } from '../parser/parameters.js';
import {
  inheritLoopBindings,
  isLoopBinding,
  loopBindingsOf,
  markLoopBindings,
  unmarkLoopBindings,
} from './loop-bindings.js';
import { envDataSecretValues, type EnvDataContext } from '../parser/interpolate-env-data.js';
import type { StepResult, TestReport } from '../report/types.js';

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
 *
 * Record Steps uses the same floor for the `.env` values a recording learns
 * from its request (`envSecrets`, src/recorder/record-steps-run.ts) and for the
 * secrets its page script remembers (`TYPED_SECRET_MIN` in
 * src/browser/scripts/record-steps.js), for the same reason.
 */
export const RECORD_SECRET_MIN_LENGTH = 4;

/**
 * The loop-binding registry lives in its own module (./loop-bindings.js) so
 * that src/parser/parameters.ts — whose `clearDottedKeys` must UNMARK what it
 * drops — can import it without importing this file, which imports
 * `isSecretName` from parameters.ts in turn. Re-exported here because the
 * rules that consult it are here, and that is where a reader looks.
 *
 * {@link loopBindingsOf} comes with them for the one consumer that is not a
 * rule: `frame:scope` (src/server/session-manager.ts) puts the list on the
 * wire so TestBench can apply {@link isSecretParameterName}'s two-segment
 * rule to a pass binding and the author rule to everything else dotted,
 * which without it the client could not tell apart (§7.6).
 */
export { markLoopBindings, unmarkLoopBindings, isLoopBinding, inheritLoopBindings, loopBindingsOf };


/**
 * Is a variable-map NAME a secret? The one rule for a name that may be dotted.
 *
 * A flat name is author-chosen end to end, so it keeps {@link isSecretName}'s
 * substring breadth. A dotted one that a LOOP bound — `row.keyword`,
 * `order.password`, registered by `applyPassBindings` — is half author and
 * half page: the author named the loop variable, the page named the column. So
 * it is a secret when the ROOT says so, or when the PROPERTY says so under the
 * whole-word record rule ({@link isRecordSecretKey}).
 *
 * A dotted name in `map` that NO pass bound is a name a person typed — a data
 * file's column heading, a `[store as:]` output — and gets `isSecretName` on
 * the WHOLE key, the rule those had before the dotted split existed. Without
 * `map` there is nothing to ask, and the answer is the binding rule: the
 * callers with no map (`formatParameterBlock`, naming one parameter at a
 * time) are the ones this file has always answered that way.
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
export function isSecretParameterName(
  name: string,
  map?: Record<string, string>,
): boolean {
  const dot = name.indexOf('.');
  if (dot === -1) return isSecretName(name);
  // Nobody's binding: the author's rule on the whole key — and the whole
  // name read as one credential key, because `isSecretName` does not know
  // `otp`, `pwd`, `passwd` or `credential` and a data file headed `user.otp`
  // is exactly as secret as one headed `user.password`.
  if (map !== undefined && !isLoopBinding(map, name)) {
    return isSecretName(name) || wholeNameIsRecordSecret(name);
  }
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
 * that name is a deliberate instruction. Neither does a dotted name in `map`
 * that no pass bound — it is author-chosen end to end, so it is read whole,
 * exactly as {@link isSecretParameterName} reads it.
 */
function joinsMaskSet(name: string, value: string, map?: Record<string, string>): boolean {
  if (value.length === 0) return false;
  const dot = name.indexOf('.');
  if (dot === -1) return isSecretName(name);
  // Nobody's binding: the author's rule on the whole key — and the whole
  // name read as one credential key, because `isSecretName` does not know
  // `otp`, `pwd`, `passwd` or `credential` and a data file headed `user.otp`
  // is exactly as secret as one headed `user.password`.
  if (map !== undefined && !isLoopBinding(map, name)) {
    return isSecretName(name) || wholeNameIsRecordSecret(name);
  }
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

/**
 * The value without a leading byte-order mark.
 *
 * `\s` matches U+FEFF, so the shape sniffs below pass on a BOM and
 * `JSON.parse` then throws on the same string — and both readers answer a
 * parse failure with "not a record", silently. A capture read from a file, or
 * handed over by a tool that read one, carries it.
 */
function withoutBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Is this value shaped like a record, or a list of them? One sniff for both
 *  readers, so neither can accept a shape the other drops. */
function looksLikeRecords(body: string): boolean {
  return /^\s*[[{]/.test(body);
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
 * The sniff is on `[` or `{`, not on `[{`: a list may be pretty-printed or
 * spaced by whatever produced it (`[ {`, or a newline), and those forms read
 * as "not a record list" and masked nothing at all — and a SINGLE record is a
 * record too. `[store as: account]` on a one-row read stores `{…}`, and while
 * {@link maskRecordSecrets} has always accepted both shapes, this half
 * accepted only the list: the same `password` column was `***` in the
 * Variables panel and printed in full in the run log, the report and the
 * substituted step line. One sniff for both ({@link looksLikeRecords}), and a
 * lone record is read as a one-element list.
 */
export function recordSecretValues(value: string): readonly string[] {
  const body = withoutBom(value);
  if (!looksLikeRecords(body)) return NO_RECORD_SECRETS;
  const cached = recordSecretCache.get(value);
  if (cached) return cached;

  const found: string[] = [];
  try {
    const parsed: unknown = JSON.parse(body);
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
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
 * character, because reformatting a value that held no secret would be this
 * helper inventing a change.
 *
 * A value something WAS masked in is re-stringified COMPACTLY — plain
 * `JSON.stringify`, no indent — so a pretty-printed capture comes back on one
 * line, a leading byte-order mark is gone, and the key order is whatever
 * `JSON.parse` preserved. That is deliberate rather than merely tolerated: the
 * masked form is a diagnostic, its text no longer matches what the page or the
 * tool produced, and pretending otherwise by preserving the layout would
 * suggest it still does.
 */
export function maskRecordSecrets(value: string): string {
  const body = withoutBom(value);
  if (!looksLikeRecords(body)) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
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
    // The map itself decides which of its dotted names a loop bound.
    if (joinsMaskSet(name, value, parameters)) pushBothForms(fromParameters, value);
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
 *  that contains another is masked whole.
 *
 *  An EMPTY secret is skipped rather than applied: `''.split('')` is every
 *  character of the text and `join(MASK)` puts the mask between all of them,
 *  so one empty entry turns `report` into `r***e***p***o***r***t`. The callers
 *  that build a list here drop empties already, but a list also arrives from
 *  elsewhere (a merged row's stored `secrets`), and the guard belongs where
 *  the damage would be done. */
export function redact(text: string, secrets: string[]): string {
  if (secrets.length === 0) return text;
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret === '') continue;
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
 *  By {@link isSecretParameterName}, ASKED ABOUT THIS MAP, so a dotted name a
 *  loop bound is decided by its own two segments and a dotted one nobody bound
 *  — a data file's `user.apikey` heading, merged into the same map by
 *  `resolveParameters` — is decided whole, by the author rule.
 *
 *  No length floor applies here: the floor exists to keep a short value out of
 *  the FREE-TEXT set, where it would be replaced everywhere, and this entry is
 *  the one place that value is named. So `row.token = "7"` shows as `***` here
 *  while every other seven survives. */
export function redactMap(map: Record<string, string>, secrets: string[]): Record<string, string> {
  return maskMapBy(map, secrets, (name) => isSecretParameterName(name, map));
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

/**
 * All three rules over one map, in the §7.6 order: the NAME first, then the
 * value's own SHAPE, then free text.
 *
 * `maskRecordSecrets` is the middle one and was missing. The name rule cannot
 * see inside a value and `redact` only replaces what it was TOLD about — so a
 * single-record capture under a plain name (`[store as: account]` holding
 * `{"user":"bob","password":"abc"}`) cleared both: `account` says nothing, and
 * a three-character cell is under {@link RECORD_SECRET_MIN_LENGTH} so it never
 * joined the free-text set. The report's parameter block and the band printed
 * it in full while the prompt's `## Values` block and the client's Variables
 * panel — both of which do mask by shape — showed `***` for the same value.
 */
function maskMapBy(
  map: Record<string, string>,
  secrets: string[],
  isSecret: (name: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = isSecret(k) ? (v === '' ? EMPTY : MASK) : redact(maskRecordSecrets(v), secrets);
  }
  return out;
}

/** {@link maskMapBy}'s VALUE half alone — the value's own shape, then free
 *  text — for a map whose keys have already had their say elsewhere. A
 *  step's captured `outputs` is that map: `[store as: password]` names a
 *  value that is in `parameters` too, so the free-text set already carries
 *  it and the name rule has nothing left to add here.
 *
 *  Order matters and is the same §7.6 order: SHAPE first, then free text. The
 *  other way round is the review-6 defect — `redact` replaces a token
 *  wherever it appears, including an UNQUOTED JSON one, so a mask set holding
 *  `123456` turned `{"otp":123456}` into `{"otp":***}`, which no longer
 *  parses, and the shape rule then declined the whole value and left the
 *  short `password` cell beside it in full.
 *
 *  A `data:image/…` value is left alone, because reading from the original
 *  steps around the guard {@link redactDeep}'s walk applies to exactly this
 *  string: a short secret matches inside base64 by coincidence, and a
 *  replacement there corrupts the image rather than hiding anything. A
 *  capture can hold one — `[store as: logo]` on an `img` `src`. */
function maskValuesOnly(map: Record<string, string>, secrets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = v.startsWith('data:image/') ? v : redact(maskRecordSecrets(v), secrets);
  }
  return out;
}

/**
 * `mask(original)`, answering with `current` ITSELF when the two read the
 * same entry for entry.
 *
 * Two things at once, and both are needed. The masking is computed from the
 * ORIGINAL map rather than from `redactDeep`'s copy — see
 * {@link maskStepValueMaps} for the two reasons — and the comparison is
 * against the copy, because that is what the caller would otherwise keep.
 * Equal means nothing this pass does changes the report, so the copy stands
 * and {@link redactReport}'s identity case survives a step that has one of
 * these maps but nothing in it to hide.
 */
function maskedOrSame(
  original: Record<string, string>,
  current: Record<string, string>,
  mask: (map: Record<string, string>) => Record<string, string>,
): Record<string, string> {
  const masked = mask(original);
  const keys = Object.keys(masked);
  if (keys.length !== Object.keys(current).length) return masked;
  for (const key of keys) {
    if (masked[key] !== current[key]) return masked;
  }
  return current;
}

/**
 * The two per-step maps that hold values UNDER THEIR NAMES, masked as such —
 * a loop band's `values`, and a step's captured `outputs`.
 *
 * `redactDeep` walks the report by VALUE, deliberately: it sees every object
 * in it and `isSecretName` over-matches, so a `press` action's `key: "Enter"`
 * must not become `***`. But that leaves the two maps here judged by free
 * text alone, and a three-character `password` cell or a boolean `token` is
 * under its floor — so the band read `payment.password=abc` beside a
 * `report.parameters` that said `***` for the same binding (§7.6).
 *
 * The two want different rules and get them. The BAND is the live variable
 * map's shape, so it takes {@link redactMap} — name, then shape, then free
 * text. A step's `outputs` takes the value half only
 * ({@link maskValuesOnly}): every name in it is a `[store as:]` the author
 * chose, which means its value is in `parameters` too and the free-text set
 * already carries it, so the name rule has nothing left to add.
 *
 * ALL THREE maps are read from the ORIGINAL step, not from the deep copy,
 * and each for its own reason.
 *
 * The band's, because the loop-binding registry is by object identity, so
 * `redactDeep`'s copy is nobody's binding and every `row.<column>` in it
 * would fall back to the author rule — `AU` masked because a column is
 * called `keyword`, the round-2 defect through the last door left open
 * (§7.6, `inheritLoopBindings`).
 *
 * The two `outputs` maps, because the copy has already had the FREE-TEXT set
 * applied to it, and that set can destroy the very shape the record rule
 * reads. A capture of `[{"payee":"Acme","otp":123456,"password":"abc"}]` puts
 * `123456` in the set — a number cell clears the floor — and the deep walk
 * rewrites the unquoted token to `"otp":***`, which is not JSON. The record
 * rule then declined the whole value, and a three-character `password` beside
 * it printed in full in the report's Captures section (review 6, finding 1).
 * Read from the original the value still parses, and the free text goes on
 * afterwards, in the §7.6 order ({@link maskValuesOnly}).
 *
 * Returns `steps` itself when nothing changed, so
 * {@link redactReport}'s identity case survives.
 */
function maskStepValueMaps(
  steps: StepResult[],
  originals: StepResult[],
  secrets: string[],
): StepResult[] {
  let changed = false;
  const out = steps.map((step, i) => {
    const original = originals[i] ?? step;
    let next = step;
    if (original.loop) {
      const band = next.loop ?? original.loop;
      const values = maskedOrSame(original.loop.values, band.values, (m) => redactMap(m, secrets));
      if (values !== band.values) next = { ...next, loop: { ...band, values } };
    }
    if (next.outputs) {
      const source = original.outputs ?? next.outputs;
      const outputs = maskedOrSame(source, next.outputs, (m) => maskValuesOnly(m, secrets));
      if (outputs !== next.outputs) next = { ...next, outputs };
    }
    if (next.toolStep) {
      const source = original.toolStep?.outputs ?? next.toolStep.outputs;
      const outputs = maskedOrSame(source, next.toolStep.outputs, (m) => maskValuesOnly(m, secrets));
      if (outputs !== next.toolStep.outputs) {
        next = { ...next, toolStep: { ...next.toolStep, outputs } };
      }
    }
    if (next !== step) changed = true;
    return next;
  });
  return changed ? out : steps;
}

/**
 * The report as every consumer should see it: each string masked by value,
 * and the three maps that hold values under their names — the resolved
 * parameters, each loop band's `values`, each step's captured `outputs` —
 * masked by name and by record shape as well.
 *
 * A copy; the run's own objects are left alone. A report with nothing to mask
 * comes back by identity — band and captured outputs included, which is what
 * {@link maskedOrSame} is for. A report with `parameters` never does: those
 * are rebuilt by NAME whatever the mask set holds, so there is always a new
 * map for them.
 */
export function redactReport(report: TestReport, secrets: string[]): TestReport {
  const out = redactDeep(report, secrets);
  const steps = maskStepValueMaps(out.steps, report.steps, secrets);
  const parameters = report.parameters ? redactMap(report.parameters, secrets) : undefined;
  if (steps === out.steps && parameters === undefined) return out;
  return { ...out, steps, ...(parameters !== undefined && { parameters }) };
}
