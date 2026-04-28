/**
 * Pure decision logic for the [interactive] REPL.
 *
 * The run-controller hands typed user input to `interpretReplCommand`,
 * which classifies it as an exit/quit/help/list/send-step/output/noop
 * action. Everything that requires VS Code APIs (posting events, calling
 * the API server) stays in the controller; this module is pure so it can
 * be unit-tested without an extension host.
 */

export const INTERACTIVE_HELP = [
  'Interactive mode commands:',
  '  :help          show this message',
  '  :list          list all numbered step lines from the file',
  '  :exit / done   end interactive mode and continue the run',
  '  :quit          abort the entire run',
  'Anything else is sent as a single ad-hoc step against the live session.',
].join('\n');

export type ReplAction =
  | { kind: 'exit-section' }
  | { kind: 'quit-run' }
  | { kind: 'output'; msg: string; level: 'info' | 'warn' | 'error' }
  | { kind: 'send-step'; text: string }
  | { kind: 'noop' };

/**
 * Decide what to do with a single line of user input in interactive mode.
 * The caller is responsible for any side effects.
 *
 * `listSteps` is computed lazily by the caller (so this function stays
 * pure and the heavy formatting only runs on `:list`).
 */
export function interpretReplCommand(
  rawText: string,
  listSteps: () => string,
): ReplAction {
  const trimmed = rawText.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'done' || lower === 'exit' || lower === ':exit') {
    return { kind: 'exit-section' };
  }
  if (lower === ':quit') {
    return { kind: 'quit-run' };
  }
  if (lower === ':help') {
    return { kind: 'output', msg: INTERACTIVE_HELP, level: 'info' };
  }
  if (lower === ':list') {
    const steps = listSteps();
    return { kind: 'output', msg: steps || '(no steps in this file)', level: 'info' };
  }
  if (trimmed.startsWith(':')) {
    return {
      kind: 'output',
      msg: `unknown command "${trimmed}". Type :help for the list.`,
      level: 'warn',
    };
  }
  if (trimmed.length === 0) {
    return { kind: 'noop' };
  }
  return { kind: 'send-step', text: trimmed };
}

/**
 * Mask values stored under a "secret-looking" variable name so they don't
 * appear in the output log. Returns the original value otherwise.
 *
 * The pattern is intentionally narrow — names like `username` or `email`
 * are NOT masked because that hurts the common debugging case.
 */
export function maskIfSecret(varName: string, value: string): string {
  if (!/password|secret|token|apikey|api_key/i.test(varName)) return value;
  if (value.length === 0) return '(empty)';
  return '*'.repeat(Math.min(value.length, 8));
}
