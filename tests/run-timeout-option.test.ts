/**
 * `steptix run --timeout <ms>` refuses a value that is not a whole number of
 * milliseconds (steptix/steptix#47).
 *
 * It used to be `parseInt`, so `--timeout abc` reached the runner as NaN. That
 * silently turned the timeout off while it was only checked between steps;
 * with the timeout a real deadline it must be refused before any run starts —
 * with commander's usage error and exit 1, the way `serve --idle-timeout`
 * refuses one.
 *
 * Only the option parsing runs: commander rejects the value before the
 * command's action, so no config is loaded and no test file is read.
 */
import { describe, it, expect, vi } from 'vitest';
import { Command, CommanderError } from 'commander';
import { registerRunCommand } from '../src/cli/commands/run.js';

/** A `steptix` program with only `run` on it, which throws instead of
 *  exiting and keeps what it would have printed. */
function program(): { cli: Command; written: string[]; action: ReturnType<typeof vi.fn> } {
  const cli = new Command();
  const written: string[] = [];
  registerRunCommand(cli);
  const run = cli.commands.find((c) => c.name() === 'run')!;
  // Replaced, so a value that IS accepted ends here instead of starting a run.
  const action = vi.fn();
  run.action(action);
  for (const c of [cli, run]) {
    c.exitOverride().configureOutput({ writeErr: (text) => written.push(text), writeOut: () => {} });
  }
  return { cli, written, action };
}

describe('steptix run --timeout', () => {
  it.each([['abc'], ['-5'], ['1.5'], ['60s'], ['']])('refuses %j with a usage error and exit 1', async (value) => {
    const { cli, written, action } = program();

    const err = await cli.parseAsync(['run', `--timeout=${value}`], { from: 'user' }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CommanderError);
    expect((err as CommanderError).code).toBe('commander.invalidArgument');
    expect((err as CommanderError).exitCode).toBe(1);
    expect(written.join('')).toMatch(/--timeout.*non-negative whole number/);
    expect(action).not.toHaveBeenCalled();
  });

  it('accepts a whole number of milliseconds', async () => {
    const { cli, action } = program();

    await cli.parseAsync(['run', 'tests/example.md', '--timeout', '600000'], { from: 'user' });

    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![1]).toMatchObject({ timeout: 600000 });
  });
});
