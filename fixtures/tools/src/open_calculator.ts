import { spawn } from 'node:child_process';
import { defineTool } from 'steptix/tools';

/**
 * Open the operating system's Calculator on the machine running the SERVER.
 *
 * Written for `templates/init/tests/calc-one-plus-one.md`, the computer-mode
 * example that drives a native app with no browser at all
 * (docs/specs/SPEC-use-computer.md). A tool rather than a step for the model:
 * starting a program stays under the author's control. The model can press
 * keys and click, but nothing it reads on the screen can make it launch
 * something.
 *
 * What it does, and deliberately does not do:
 *
 *   - It starts the program and returns as soon as the OS has accepted the
 *     launch. It does NOT wait for the window. On Windows `calc.exe` is a stub
 *     that hands over to the Store app and exits, so there is no child process
 *     whose window could be waited on. The test's next step,
 *     `Wait until a window titled "Calculator" is open`, is what waits, and it
 *     asks the operating system's window list, not this process.
 *   - It never touches `page` or `context`. The test that uses it opens with
 *     `[use computer]`, so no browser is ever launched (§4.6).
 *   - It does not close Calculator. Nothing tracks what a tool starts; the
 *     test closes the window itself.
 *
 * Detached with stdio ignored and unref'd, so the app outlives the step and
 * the server does not keep a handle to it.
 *
 * Usage:
 *
 *   1. [use computer]
 *   2. [tool: open_calculator]
 *   3. Wait until a window titled "Calculator" is open
 */

/** The command that opens Calculator on each platform, in the order tried. */
const CANDIDATES: Record<string, Array<{ command: string; args: string[] }>> = {
  win32: [{ command: 'calc.exe', args: [] }],
  darwin: [{ command: 'open', args: ['-a', 'Calculator'] }],
  linux: [
    { command: 'gnome-calculator', args: [] },
    { command: 'kcalc', args: [] },
    { command: 'xcalc', args: [] },
  ],
};

/** Resolve once the OS has started the process, or reject with its error. */
function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export default defineTool({
  name: 'open_calculator',
  description:
    "Open the operating system's Calculator app on the machine running the server. Returns once the launch is accepted; wait for its window in the next step.",
  parameters: {},
  outputs: {
    calculator_command: { type: 'string', description: 'The command that was run to open Calculator.' },
  },
  async run(_args, { step, log }) {
    const candidates = CANDIDATES[process.platform];
    if (!candidates) {
      step.expect(false, `open_calculator: no Calculator command is known for platform "${process.platform}"`);
      return; // unreachable: step.expect threw.
    }

    const failures: string[] = [];
    for (const { command, args } of candidates) {
      try {
        await launch(command, args);
        const shown = [command, ...args].join(' ');
        log.info(`open_calculator: started "${shown}"`);
        step.setVar('calculator_command', shown);
        return;
      } catch (err) {
        failures.push(`${command}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    step.expect(false, `open_calculator: could not start Calculator (${failures.join('; ')})`);
  },
});
