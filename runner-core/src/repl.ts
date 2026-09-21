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
 * The words that make an AUTHOR-CHOSEN name a secret, matched as WORDS rather
 * than as substrings: `password`, `secret`, `token`, `key` (and `apikey`,
 * which is one word however it is spelled), each optionally plural.
 *
 * The server's rule for such a name is `isSecretName`
 * (src/parser/parameters.ts), and what it masks the client must mask too — a
 * value the report redacts must not sit in plain sight in the Variables view
 * or the Output banner. This used to be NARROWER than the server's in a way
 * that leaked: bare `key` was missing, so `MACHINE_KEY` and `privateKey`
 * rendered their values while every report redacted them.
 *
 * Word boundaries, not the server's plain substring, because that direction
 * of the difference costs nothing real and over-masking is its own bug:
 * `keyword` and `monkey` contain "key" and hold nothing secret, and a variable
 * called `keyword` rendered as `********` is a row nobody can read. The
 * separator set is what a variable name actually uses — `_`, `-` and a
 * camelCase hump — so `api_key`, `apiKey` and `APIKEY` all mask.
 *
 * This list decides a FLAT name only. A dotted one is `root.property`, whose
 * property came off a page rather than out of the author's head, and that goes
 * through {@link isRecordSecretKey} instead — see {@link isSecretVarName}.
 */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwords',
  'secret',
  'secrets',
  'token',
  'tokens',
  'apikey',
  'apikeys',
  'key',
  'keys',
  // The rest of the server's record-column list (`isRecordSecretKey`,
  // src/utils/secrets.ts). Kept here as well so a variable the author called
  // `pwd` or `otp` masks: widening an author-chosen name costs nothing (the
  // author picked a word that says credential), and `frame:scope` carries raw
  // values, so this render is the only thing between such a value and the
  // screen.
  'passwd',
  'pwd',
  'otp',
  'credential',
  'credentials',
]);

/** The words in a variable name: split on every non-alphanumeric run and at
 *  each camelCase hump, lower-cased. `api_key` → api, key. */
function nameWords(varName: string): string[] {
  return varName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/** Is a flat, author-chosen name a secret by {@link SECRET_WORDS}? */
function isSecretFlatName(name: string): boolean {
  return nameWords(name).some((word) => SECRET_WORDS.has(word));
}

/**
 * Is a RECORD COLUMN's name a secret? The mirror of `isRecordSecretKey`
 * (src/utils/secrets.ts), regex for regex — `tests/record-secret-parity.test.js`
 * in testbench-native reads both sources and fails if they drift.
 *
 * Narrower than {@link SECRET_WORDS} on purpose, and the reason is on the
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
 * credential (`api_key`, `apiKey`, `access_key`, `private_key`). `apikey` as
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
 *   the broad {@link SECRET_WORDS} list decides it;
 * - a DOTTED one is `root.property`, a binding a `For each` pass made over a
 *   record (§8.4). The property is the page's word, not the author's, so
 *   {@link isRecordSecretKey} decides it — while the ROOT is still the
 *   author's, and a record stored under `token` is a secret whole.
 *
 * The difference is not cosmetic: `payment.sort_key` and `payment.keyword`
 * used to render as `********` here while the report printed them, and
 * `payment.pwd` had to be spelled into the flat list to mask at all.
 */
export function isSecretVarName(varName: string): boolean {
  const dot = varName.indexOf('.');
  if (dot < 0) return isSecretFlatName(varName);
  return isSecretFlatName(varName.slice(0, dot)) || isRecordSecretKey(varName.slice(dot + 1));
}

/** What a masked value renders as: a star per character, capped at eight, and
 *  {@link EMPTY_VALUE} for a blank one — saying a field was empty discloses
 *  nothing, and `***` over an empty cell makes a matrix unable to tell "wrong
 *  password" from "no password". Same words the server's `redactMap` uses. */
const EMPTY_VALUE = '(empty)';
function maskValue(value: string): string {
  return value.length === 0 ? EMPTY_VALUE : '*'.repeat(Math.min(value.length, 8));
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
 * Strings only, and by key only: the server masks a record value the same way
 * (`recordSecretValues`), and a number or a nested object under a `password`
 * key is not something `readTable` can produce.
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
    for (const [key, cell] of Object.entries(record as Record<string, unknown>)) {
      if (typeof cell === 'string' && isRecordSecretKey(key)) {
        (record as Record<string, unknown>)[key] = maskValue(cell);
        masked = true;
      }
    }
  }
  return masked ? JSON.stringify(parsed) : value;
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
