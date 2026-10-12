/**
 * A `## Parameters` value nobody can supply fails the run instead of exiting 0
 * (#46).
 *
 * `steptix run` asks at the terminal for a parameter it cannot fill in by
 * itself: an unset `$VAR` (secret-named or not), an empty value, or a
 * `{{name}}` pointing at itself. With stdin not a terminal and already ended —
 * CI, a script, a scheduled job — that question never settled, Node ran out of
 * work, and the process exited 0 having run nothing. Now:
 *
 *  - with no terminal, resolution fails at once, naming every variable or
 *    parameter it is missing, and opens no prompt at all;
 *  - with a terminal whose input ends at the prompt (Ctrl+D), the
 *    question fails naming the parameter instead of staying pending;
 *  - with a terminal that answers, nothing changed.
 *
 * `process.stdin.isTTY` is what decides, so the tests set it and put it back.
 * The terminal itself is injected — `createLineReader` is wrapped to read a
 * stream the test types into — so nothing here reads the developer's stdin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { resolveParameters } from '../src/parser/parameters.js';
import { NoAnswerError } from '../src/utils/ask-user.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestContent } from '../src/parser/markdown.js';
import { expandTestInstances, runTests } from '../src/runner/test-runner.js';
import type { Config } from '../src/config/types.js';

const terminal = vi.hoisted(() => ({
  /** What a line reader reads and writes — set by a test that has a terminal. */
  input: undefined as Readable | undefined,
  output: undefined as Writable | undefined,
  /** Runs once a question is pending: where a test types, or ends the input. */
  onQuestion: undefined as ((prompt: string) => void) | undefined,
  readersOpened: 0,
}));

vi.mock('../src/utils/ask-user.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ask-user.js')>();
  return {
    ...actual,
    createLineReader: () => {
      terminal.readersOpened++;
      if (!terminal.input || !terminal.output) {
        // Never fall back to the real stdin: a reader opened where the test
        // gave no terminal is exactly the bug, so say so instead of waiting.
        throw new Error('a line reader was opened with no terminal to read');
      }
      const reader = actual.createLineReader({ input: terminal.input, output: terminal.output });
      return {
        question(prompt: string, options?: { signal?: AbortSignal }) {
          const answer = reader.question(prompt, options);
          terminal.onQuestion?.(prompt);
          return answer;
        },
        close: () => reader.close(),
      };
    },
  };
});

// Names no machine sets, so "unset" is a fact about the test, not the box.
const PASSWORD_VAR = 'STEPTIX_TEST46_PASSWORD';
const URL_VAR = 'STEPTIX_TEST46_STAGING_URL';
const SET_VAR = 'STEPTIX_TEST46_SET';
const VARS = [PASSWORD_VAR, URL_VAR, SET_VAR];

let savedEnv: Record<string, string | undefined>;
let savedIsTTY: PropertyDescriptor | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
  savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  terminal.input = undefined;
  terminal.output = undefined;
  terminal.onQuestion = undefined;
  terminal.readersOpened = 0;
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

/** A terminal to type into, with an output nobody reads. */
function giveTerminal(): PassThrough {
  setStdinIsTTY(true);
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  terminal.input = input;
  terminal.output = output;
  return input;
}

/** The rejection, for a closer look than `rejects.toThrow` gives. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err as Error,
  );
}

describe('resolveParameters with no terminal', () => {
  beforeEach(() => setStdinIsTTY(false));

  it('fails naming the unset variable a secret parameter needs, without prompting', async () => {
    await expect(resolveParameters({ password: `$${PASSWORD_VAR}` })).rejects.toThrow(
      `Parameter "password" needs $${PASSWORD_VAR}, which is not set, and there is no terminal to ask`,
    );
    expect(terminal.readersOpened).toBe(0);
  });

  // The name only decides whether the prompt says "(input hidden)"; the path
  // to it is the same.
  it('fails the same way for a parameter whose name is not a secret', async () => {
    await expect(resolveParameters({ baseUrl: `$${URL_VAR}` })).rejects.toThrow(
      `Parameter "baseUrl" needs $${URL_VAR}, which is not set, and there is no terminal to ask`,
    );
    expect(terminal.readersOpened).toBe(0);
  });

  it('fails naming a parameter with no value', async () => {
    await expect(resolveParameters({ email: '' })).rejects.toThrow(
      'Parameter "email" has no value, and there is no terminal to ask',
    );
    expect(terminal.readersOpened).toBe(0);
  });

  it('fails naming a parameter whose value is a placeholder for itself', async () => {
    await expect(resolveParameters({ orderId: '{{orderId}}' })).rejects.toThrow(
      'Parameter "orderId" is {{orderId}}, which asks for a value at run time, and there is no terminal to ask',
    );
    expect(terminal.readersOpened).toBe(0);
  });

  it('names every parameter it cannot fill in, not just the first', async () => {
    process.env[SET_VAR] = 'from-env';
    const err = await rejectionOf(
      resolveParameters({
        username: 'ada@example.test',
        password: `$${PASSWORD_VAR}`,
        token: `$${SET_VAR}`,
        email: '',
        orderId: '{{orderId}}',
      }),
    );
    expect(err.message).toBe(
      [
        '3 parameters have no value, and there is no terminal to ask:',
        `  - "password" needs $${PASSWORD_VAR}, which is not set`,
        '  - "email" has no value',
        '  - "orderId" is {{orderId}}, which asks for a value at run time',
      ].join('\n'),
    );
    expect(terminal.readersOpened).toBe(0);
  });

  it('still resolves inline values and set variables without asking', async () => {
    process.env[SET_VAR] = 'from-env';
    const resolved = await resolveParameters({ email: 'ada@example.test', token: `$${SET_VAR}` });
    expect(resolved).toEqual({ email: 'ada@example.test', token: 'from-env' });
    expect(terminal.readersOpened).toBe(0);
  });

  // Data-driven expansion passes `promptUser: false`: an unresolvable value
  // becomes empty with a warning, exactly as before. Not this issue.
  it('leaves promptUser=false as it was: empty, no error', async () => {
    const resolved = await resolveParameters(
      { password: `$${PASSWORD_VAR}`, email: '', shared: 'yes' },
      { email: 'row@example.test' },
      false,
    );
    expect(resolved).toEqual({ password: '', email: 'row@example.test', shared: 'yes' });
    expect(terminal.readersOpened).toBe(0);
  });
});

describe('resolveParameters with a terminal', () => {
  it('asks, and uses what was typed', async () => {
    const input = giveTerminal();
    const answers = ['  typed-secret  ', 'typed@example.test'];
    const prompts: string[] = [];
    terminal.onQuestion = (prompt) => {
      prompts.push(prompt);
      input.write(`${answers.shift()}\n`);
    };

    const resolved = await resolveParameters({
      password: `$${PASSWORD_VAR}`,
      username: 'ada',
      email: '',
    });

    expect(resolved).toEqual({ password: 'typed-secret', username: 'ada', email: 'typed@example.test' });
    expect(prompts).toEqual([
      '  Enter value for "password" (input hidden): ',
      '  Enter value for "email": ',
    ]);
  });

  it('opens no prompt when everything resolves', async () => {
    giveTerminal();
    process.env[SET_VAR] = 'from-env';
    const resolved = await resolveParameters({ email: 'ada@example.test', token: `$${SET_VAR}` });
    expect(resolved).toEqual({ email: 'ada@example.test', token: 'from-env' });
    expect(terminal.readersOpened).toBe(0);
  });

  // Ctrl+D at the prompt: the input ends with the question pending.
  it('fails naming the parameter when the input ends at the prompt', async () => {
    const input = giveTerminal();
    terminal.onQuestion = () => input.end();

    const err = await rejectionOf(resolveParameters({ password: `$${PASSWORD_VAR}` }));

    expect(err.message).toBe(
      `Parameter "password" needs $${PASSWORD_VAR}, which is not set, and input ended before a value was typed`,
    );
    expect(err.cause).toBeInstanceOf(NoAnswerError);
  });

  // The CI shape, on a terminal: stdin at end of input before anything asks.
  it('fails the same way when the input had already ended', async () => {
    const input = giveTerminal();
    input.end();

    await expect(resolveParameters({ email: '' })).rejects.toThrow(
      'Parameter "email" has no value, and input ended before a value was typed',
    );
  });
});

describe('steptix run with a parameter nobody can supply', () => {
  let scratch: string;
  let config: Config;

  beforeEach(async () => {
    setStdinIsTTY(false);
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-no-terminal-'));
    config = structuredClone(DEFAULT_CONFIG);
    config.reports.outputDir = path.join(scratch, 'reports');
    config.reports.appendRunHistoryToTestFile = false;
    config.reports.openInBrowserAfterRun = false;
    config.tests.contextDir = path.join(scratch, 'no-context');
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** The issue's four kinds of line, under a path the message can name. */
  const testFile = path.join(process.cwd(), 'tests', 'missing-values.md');
  const missingValues = () =>
    parseTestContent(
      '# Missing values\n\n## Parameters\n' +
        `- baseUrl: $${URL_VAR}\n- password: $${PASSWORD_VAR}\n- email:\n- orderId: {{orderId}}\n` +
        '\n## Steps\n1. Go\n',
      testFile,
    );

  it('names the test file along with what is missing', async () => {
    const err = await rejectionOf(expandTestInstances(missingValues(), config));
    expect(err.message).toBe(
      [
        `${path.join('tests', 'missing-values.md')}: 4 parameters have no value, and there is no terminal to ask:`,
        `  - "baseUrl" needs $${URL_VAR}, which is not set`,
        `  - "password" needs $${PASSWORD_VAR}, which is not set`,
        '  - "email" has no value',
        '  - "orderId" is {{orderId}}, which asks for a value at run time',
      ].join('\n'),
    );
  });

  // The failure surfaces as a throw out of `runTests`, which `steptix run`
  // turns into "Fatal error during test run" and exit 1 — the same path a bad
  // `cdp:` or an unloadable data file takes. Nothing is launched.
  it('ends the run before the test is started', async () => {
    let started = 0;
    const runTestFn = (async () => {
      started++;
      throw new Error('runTest should not be reached');
    }) as unknown as typeof import('../src/runner/test-runner.js').runTest;

    await expect(runTests([missingValues()], config, { runTestFn })).rejects.toThrow(
      `"password" needs $${PASSWORD_VAR}, which is not set`,
    );
    expect(started).toBe(0);
    expect(terminal.readersOpened).toBe(0);
  });

  it('leaves data-row expansion alone: it never asks, so an unset value is empty', async () => {
    const test = parseTestContent(
      `# Rows\n\n## Parameters\n- password: $${PASSWORD_VAR}\n\n## Steps\n` +
        '| email |\n|-------|\n| a@example.test |\n| b@example.test |\n\n1. Go\n',
      testFile,
    );
    const instances = await expandTestInstances(test, config);
    expect(instances.map((i) => i.resolvedParameters)).toEqual([
      { password: '', email: 'a@example.test' },
      { password: '', email: 'b@example.test' },
    ]);
    expect(terminal.readersOpened).toBe(0);
  });
});
