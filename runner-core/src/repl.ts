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
 * The words that make a variable name a secret, matched as WORDS rather than
 * as substrings: `password`, `secret`, `token`, `key` (and `apikey`, which is
 * one word however it is spelled), each optionally plural.
 *
 * The server's rule is `isSecretName` (src/parser/parameters.ts), and what it
 * masks the client must mask too — a value the report redacts must not sit in
 * plain sight in the Variables view or the Output banner. This used to be
 * NARROWER than the server's in a way that leaked: bare `key` was missing, so
 * `MACHINE_KEY` and `privateKey` rendered their values while every report
 * redacted them.
 *
 * Word boundaries, not the server's plain substring, because that direction
 * of the difference costs nothing real and over-masking is its own bug:
 * `keyword` and `monkey` contain "key" and hold nothing secret, and a column
 * called `keyword` rendered as `********` is a row nobody can read. The
 * separator set is what a variable name actually uses — `_`, `-`, `.` and a
 * camelCase hump — so `api_key`, `apiKey`, `APIKEY` and `payment.password`
 * all mask.
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
  // src/utils/secrets.ts). A scope entry can be a record property — a
  // `readTable` column arrives as `payment.<key>` — and the client's list must
  // not be the shorter one: `frame:scope` carries raw values, so this render
  // is the only thing between a column called `pwd` and the screen.
  'passwd',
  'pwd',
  'otp',
  'credential',
  'credentials',
]);

/** The words in a variable name: split on every non-alphanumeric run and at
 *  each camelCase hump, lower-cased. `payment.api_key` → payment, api, key. */
function nameWords(varName: string): string[] {
  return varName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/** Is `varName` a secret by {@link SECRET_WORDS}? Exported so the surfaces
 *  that decide something other than a mask string — a hidden input, a redacted
 *  copy — ask the one question rather than re-spelling the pattern. */
export function isSecretVarName(varName: string): boolean {
  return nameWords(varName).some((word) => SECRET_WORDS.has(word));
}

/**
 * Mask values stored under a "secret-looking" variable name so they don't
 * appear in the output log. Returns the original value otherwise.
 *
 * Names like `username` or `email` are NOT masked: that hurts the common
 * debugging case and neither name says secret.
 */
export function maskIfSecret(varName: string, value: string): string {
  if (!isSecretVarName(varName)) return value;
  if (value.length === 0) return '(empty)';
  return '*'.repeat(Math.min(value.length, 8));
}
