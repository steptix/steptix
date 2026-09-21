/**
 * Pure decision logic for the [interactive] REPL.
 *
 * The run-controller hands typed user input to `interpretReplCommand`,
 * which classifies it as a continue/exit/quit/help/list/resume/screenshot/
 * send-step/output/noop action. Everything that requires VS Code APIs
 * (posting events, calling the API server) stays in the controller; this
 * module is pure so it can be unit-tested without an extension host.
 */

export const INTERACTIVE_HELP = [
  'Interactive REPL commands:',
  '  /help          show this message',
  '  /list          list all numbered step lines from the file',
  '  /screenshot    capture current page and attach to report',
  '  /resume        pick a step to continue from',
  '  /continue      end interactive mode and run the next step',
  '  /exit          abort the entire run (alias: /quit)',
  'Anything else is sent as a single ad-hoc step against the live session.',
].join('\n');

export type ReplAction =
  | { kind: 'exit-section' }
  | { kind: 'quit-run' }
  | { kind: 'resume' }
  | { kind: 'screenshot' }
  | { kind: 'output'; msg: string; level: 'info' | 'warn' | 'error' }
  | { kind: 'send-step'; text: string }
  | { kind: 'noop' };

/** Slash-prefixed commands recognised by the REPL. */
const KNOWN_COMMANDS = new Set([
  '/help',
  '/list',
  '/screenshot',
  '/resume',
  '/continue',
  '/exit',
  '/quit',
]);

/** Bare-word / colon-prefix inputs from prior designs — we now reject with a hint. */
const DEPRECATED_HINTS: Record<string, string> = {
  done: '"done" is no longer recognised — use /continue to advance, /exit to abort.',
  exit: '"exit" is no longer recognised as a bare word — use /exit to abort, /continue to advance.',
  quit: '"quit" is no longer recognised as a bare word — use /quit (or /exit) to abort.',
  ':continue': 'Commands are now /-prefixed — use /continue.',
  ':exit': 'Commands are now /-prefixed — use /exit.',
  ':quit': 'Commands are now /-prefixed — use /quit.',
  ':resume': 'Commands are now /-prefixed — use /resume.',
  ':screenshot': 'Commands are now /-prefixed — use /screenshot.',
  ':list': 'Commands are now /-prefixed — use /list.',
  ':help': 'Commands are now /-prefixed — use /help.',
};

/** Return the lowercase first whitespace-delimited token (or '' for blank input). */
function firstToken(line: string): string {
  const m = line.trim().match(/^\S+/);
  return m ? m[0]!.toLowerCase() : '';
}

/**
 * Decide what to do with a single line of user input in interactive mode.
 * The caller is responsible for any side effects.
 *
 * `listSteps` is computed lazily by the caller (so this function stays
 * pure and the heavy formatting only runs on `/list`).
 */
export function interpretReplCommand(
  rawText: string,
  listSteps: () => string,
): ReplAction {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return { kind: 'noop' };

  const head = firstToken(trimmed);
  const lowerWhole = trimmed.toLowerCase();

  // Deprecated single-token inputs from prior designs.
  const dep = DEPRECATED_HINTS[head];
  if (dep && head === lowerWhole) {
    return { kind: 'output', msg: dep, level: 'warn' };
  }

  // Slash-prefixed inputs are commands ONLY when the first token is a known command name.
  // This lets ad-hoc Flick steps that start with a path (e.g. "/admin/users page should load")
  // fall through normally.
  if (head.startsWith('/')) {
    if (KNOWN_COMMANDS.has(head)) {
      if (head === '/continue') return { kind: 'exit-section' };
      if (head === '/exit' || head === '/quit') return { kind: 'quit-run' };
      if (head === '/help') return { kind: 'output', msg: INTERACTIVE_HELP, level: 'info' };
      if (head === '/list') {
        const steps = listSteps();
        return { kind: 'output', msg: steps || '(no steps in this file)', level: 'info' };
      }
      if (head === '/resume') return { kind: 'resume' };
      if (head === '/screenshot') return { kind: 'screenshot' };
    }
    // Single-token unknown slash command (no whitespace) → warn.
    if (head === lowerWhole) {
      return {
        kind: 'output',
        msg: `unknown command "${trimmed}". Type /help for the list.`,
        level: 'warn',
      };
    }
    // Multi-token slash input → fall through as a Flick step.
  }

  return { kind: 'send-step', text: trimmed };
}

/**
 * What makes an AUTHOR-CHOSEN name a secret: the server's `isSecretName`
 * (src/parser/parameters.ts), mirrored character for character. A SUBSTRING,
 * so `mypassword`, `password2` and `apitoken` are secrets exactly as the
 * server reads them.
 *
 * Identical and not merely similar, because the difference is a leak in
 * whichever direction it falls. `frame:scope` carries RAW values by design —
 * the wire was left alone when redaction shipped, and the client is what hides
 * them — so a client rule the server's does not match shows in the Variables
 * view a value the report beside it redacts. Word boundaries were tried here
 * (`nameWords` + a word list) and did exactly that: `mypassword`, `newpassword`
 * and `apitoken` are single words to a splitter and matched nothing, while
 * `pwd` and `user_otp` went the other way and masked what the report prints.
 *
 * So the server's breadth comes with it, `keyword` and `monkey` included: they
 * are masked here because they are masked in the report, and a view that
 * disagrees with the report about one row is worse than a row that is
 * needlessly starred. Spec §7.6 states the rule that way.
 *
 * This decides a FLAT name only. A dotted one is `root.property`, whose
 * property came off a page rather than out of the author's head, and that goes
 * through {@link isRecordSecretKey} instead — see {@link isSecretVarName}.
 * `tests/record-secret-parity.test.js` in testbench-native reads the literal
 * out of the server's source and fails if this one drifts from it.
 */
const SECRET_NAME = /password|secret|token|key/i;

/** The pattern above, exported so the parity test can compare its `.source`
 *  with the server's rather than eyeballing two files. */
export const SECRET_NAME_PATTERN = SECRET_NAME;

/**
 * Is a flat, author-chosen name a secret by {@link SECRET_NAME}?
 *
 * Exported for the one other client surface that answers this question about
 * an author-chosen name — the `${env.X}` / `${data.X.Y}` completion dropdown
 * (testbench-native/src/extension/env-data-completion-core.ts), which asks it
 * of a '.'-joined data PATH, where every segment is author-chosen and none of
 * them is a record column. Not for a runtime variable name: that may be
 * dotted, and {@link isSecretVarName} is the rule for those.
 */
export function isSecretFlatName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/**
 * Is a RECORD COLUMN's name a secret? The mirror of `isRecordSecretKey`
 * (src/utils/secrets.ts), regex for regex — `tests/record-secret-parity.test.js`
 * in testbench-native reads both sources and fails if they drift.
 *
 * Narrower than {@link SECRET_NAME} on purpose, and the reason is on the
 * server side: a record's keys are picked off the page — a `readTable` column
 * alias, a header turned into a property — where `keyword` and `sort_key` both
 * contain `key`, and masking is not a free precaution because the server's
 * `redact` replaces that value EVERYWHERE, including in the DOM snapshot the
 * model plans its next action from. The client cannot be the broader of the
 * two and still be a mirror: a column the report shows would then be
 * `********` in the Variables view beside it.
 *
 * So: `password` / `passwd` / `pwd` / `secret` / `token` / `otp` /
 * `credential(s)` as whole words, and `key` only where something makes it a
 * credential — all seven of them: `api_key`, `apiKey`, `access_key`,
 * `private_key`, `auth_key`, `signing_key`, `encryption_key`. `apikey` as
 * one word has no boundary to read and is not a secret COLUMN — as an
 * author-chosen name it still is (above).
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

/** The two patterns above, exported so the parity test can compare their
 *  `.source` with the server's rather than eyeballing two files. */
export const RECORD_SECRET_PATTERNS = {
  word: RECORD_SECRET_WORD,
  key: RECORD_SECRET_KEY,
} as const;

/**
 * Is `varName` a secret? Exported so the surfaces that decide something other
 * than a mask string — a read-only input, a redacted copy — ask the one
 * question rather than re-spelling the pattern.
 *
 * Two rules, because a scope holds two kinds of name (the same split the
 * server makes, docs/specs/SPEC-structured-table-reads.md §7.6):
 *
 * - a FLAT name is the author's — a parameter, a `[store as:]` capture — so
 *   the broad {@link SECRET_NAME} substring decides it;
 * - a DOTTED one is `root.property`, a binding a `For each` pass made over a
 *   record (§8.4). The property is the page's word, not the author's, so
 *   {@link isRecordSecretKey} decides it — while the ROOT is still the
 *   author's, and a record stored under `token` is a secret whole.
 *
 * The difference is not cosmetic: `payment.sort_key` and `payment.keyword`
 * used to render as `********` here while the report printed them.
 *
 * And a THIRD clause, the server's as well: the whole name read as one
 * credential key with the dots as separators ({@link wholeNameIsRecordSecret}).
 * Not every dotted name is a pass binding — a data column or a `[store as:]`
 * output may be called `api.key`, where neither half says secret and the two
 * halves together say nothing but. It is the record rule doing the reading, so
 * it stays whole-word and `row.keyword` and `payment.sort_key` stay clear of
 * it. Without this clause `api.key` and `private.key` rendered in full in the
 * Variables view while the report beside them said `***`.
 */
export function isSecretVarName(varName: string): boolean {
  const dot = varName.indexOf('.');
  if (dot < 0) return isSecretFlatName(varName);
  return (
    isSecretFlatName(varName.slice(0, dot))
    || isRecordSecretKey(varName.slice(dot + 1))
    || wholeNameIsRecordSecret(varName)
  );
}

/** The dotted name read as ONE record key: `api.key` → `api_key`. The record
 *  rule, not the author rule, so it stays whole-word — a name that merely
 *  contains `key` across the dot (`row.keyword`) is not caught by it.
 *
 *  Kept line for line with the server's `wholeNameIsRecordSecret`
 *  (src/utils/secrets.ts) and with the panel's copy; the parity test compares
 *  all three bodies. */
function wholeNameIsRecordSecret(name: string): boolean {
  return name.includes('.') && isRecordSecretKey(name.split('.').join('_'));
}

/** What a masked value renders as: a star per character, capped at eight, and
 *  {@link EMPTY_VALUE} for a blank one — saying a field was empty discloses
 *  nothing, and `***` over an empty cell makes a matrix unable to tell "wrong
 *  password" from "no password". Same words the server's `redactMap` uses. */
const EMPTY_VALUE = '(empty)';
function maskValue(value: string): string {
  return value.length === 0 ? EMPTY_VALUE : '*'.repeat(Math.min(value.length, 8));
}

/** Is this parsed JSON value one record — an object with keys, rather than a
 *  list, a null or a scalar? Its own function so the mask loop below is one
 *  call rather than a three-part condition a TypeScript cast has to repair,
 *  which is what lets the panel's copy stay identical to it. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A captured value with the secret COLUMNS of the records inside it masked.
 * Anything that is not a record (or a list of them) comes back untouched.
 *
 * A `readTable` capture is a whole table under ONE author-chosen name
 * (`payments`), and the pass binding is one record under another (`payment`),
 * so the name rule has nothing to catch: both rendered in full beside a
 * `payment.password` row showing `********`, which reads as "this is masked".
 * `frame:scope` carries raw values by design — the wire was left alone when
 * redaction shipped, and the client is what hides them — so this render is the
 * only guard those two surfaces have.
 *
 * By KEY, and at any JSON type a cell can hold on its own: a string, but also
 * a number or a boolean, because `{"password":123}` rendered the credential in
 * the clear while `{"password":"123"}` starred it — a distinction nothing in
 * the surface makes visible and nothing in the rule intends. A tool returning
 * records is what produces those, `readTable` having only strings to give.
 *
 * The LIMIT is a cell that is itself null, an object or an array: those are
 * left exactly as they came. Replacing null with `********` would report a
 * value where there is none, and a nested object would have to be walked to
 * mask anything — a shape neither the server nor this helper masks inside
 * today, so a `password` object stays readable here as it does in the report.
 *
 * No four-character floor here, unlike the server's. That floor exists because
 * a short value joins a free-text mask set and is then replaced EVERYWHERE,
 * including in the DOM the model plans from; masking in place under its own
 * key reaches nothing else, and the sibling `payment.password` entry is masked
 * at any length too.
 *
 * A value nothing was masked in is returned as it arrived, character for
 * character: the re-stringify is compact and a capture the server wrote is
 * compact as well, but a tool may pretty-print, and reformatting a value that
 * held no secret would be this helper inventing a change.
 *
 * Kept line for line with `maskRecordSecretsInline`
 * (testbench-native/src/webview/lib/variables-panel.js), which the webview
 * bundle uses because it can import nothing from here: the parity test
 * compares the two bodies with the TypeScript spellings normalised away, so a
 * change made in one and not the other fails rather than drifts.
 */
export function maskRecordSecrets(value: string): string {
  const text = String(value);
  // A leading BOM is stripped before both the sniff and the parse. JS `\s`
  // INCLUDES U+FEFF, so `\uFEFF[{"password":…}]` passed the sniff and then
  // threw in JSON.parse, and the catch returned the credential unmasked —
  // the one input shaped exactly like the case this function exists for.
  const body = text.replace(/^\uFEFF/, '');
  if (!/^\s*[[{]/.test(body)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text;
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  let masked = false;
  for (const record of records) {
    if (!isPlainRecord(record)) continue;
    for (const [key, cell] of Object.entries(record)) {
      if (!isRecordSecretKey(key)) continue;
      if (cell === null || typeof cell === 'object') continue;
      record[key] = maskValue(String(cell));
      masked = true;
    }
  }
  return masked ? JSON.stringify(parsed) : text;
}

/**
 * Mask values stored under a "secret-looking" variable name so they don't
 * appear in the output log, and mask the secret columns of any record the
 * value holds. Returns the original value when neither applies.
 *
 * Names like `username` or `email` are NOT masked: that hurts the common
 * debugging case and neither name says secret.
 *
 * The name first, and outright: a secret-named value is hidden whole, columns
 * and all, because the name is the rule and it says secret. Only when the name
 * says nothing does the value get looked into.
 */
export function maskIfSecret(varName: string, value: string): string {
  if (!isSecretVarName(varName)) return maskRecordSecrets(value);
  return maskValue(value);
}

/**
 * The same, for a map whose keys are author-chosen END TO END — the mirror of
 * the server's `redactAuthoredMap` (src/utils/secrets.ts), as {@link
 * maskIfSecret} is the mirror of its `redactMap`.
 *
 * {@link maskIfSecret}'s two-segment rule is right for the live variable map,
 * whose dotted entries are a loop's `row.<column>` bindings — half author,
 * half page. It is wrong for a DATA ROW's cells (the Run Rows quick pick, the
 * gutter hover, the Output banner's `k=v, k=v`) and for a step's `[store as:]`
 * tool outputs, because nothing in either of those came off a page: a column
 * headed `user.apikey`, `login.passkey` or `api.key` is a name a person typed,
 * and all three are masked by the server's flat author rule. Splitting them at
 * the dot and asking the narrow record rule about `apikey` answered no, so the
 * client printed `uk_live_1234` in a banner sitting beside a report matrix
 * that said `***` — the pre-feature client starred it, which makes this the
 * regression and not merely a gap.
 *
 * So the WHOLE key goes to {@link isSecretFlatName}, which is what that rule
 * was written for. Everything else is {@link maskIfSecret}'s shape: the name
 * first and outright, then the record scan for a value whose name said nothing.
 */
export function maskIfSecretAuthored(name: string, value: string): string {
  if (!isSecretFlatName(name)) return maskRecordSecrets(value);
  return maskValue(value);
}

/**
 * The order a scope renders in: by name, except that a `_`-prefixed segment
 * leads its siblings.
 *
 * `_row` must come first among a record's properties (§7.4 — the report and
 * the Variables panel show the row number before the columns), and a plain
 * `.sort()` does not deliver that. It compares code units, where `_` (95) sits
 * BETWEEN the upper-case letters and the lower-case ones: `payment._row`
 * leads `payment.payee` by luck and trails `payment.Amount`, which is an
 * ordinary alias for an `Amount` column. So the rule is spelled out instead of
 * inherited from the character table.
 */
export function compareVariableNames(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    // A shorter name is a prefix of the longer one: `payment` before
    // `payment._row`, the record before the properties it was split into.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xLeads = x.startsWith('_');
    const yLeads = y.startsWith('_');
    if (xLeads !== yLeads) return xLeads ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
