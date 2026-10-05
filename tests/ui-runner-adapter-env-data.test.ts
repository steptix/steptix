/**
 * Regression for issues/resolved/052 — the Electron runner and `${env.X}`.
 *
 * `UIRunnerAdapter` parsed every test with `parseTestFile(filePath, { skillsDir })`
 * and no env context, so the parser never resolved (or validated) a `${env.X}`
 * / `${data.x}` reference for it and never recorded `parsedTest.envData` for
 * the run; the step loop then ran only the `{{…}}` pass. Net effect, for as
 * long as the feature has existed: `Go to ${env.BASE_URL}/login` reached the
 * model as exactly that text. `steptix ui --env staging` could not change it — it
 * loaded the VALUES of `.env.staging` into the process but never said which
 * environment had been picked.
 *
 * A first cut of the fix passed the executor only the substituted text, so
 * the model was shown a resolved password where the CLI shows it a masked
 * placeholder, and left the environment overlay in `process.env` after the
 * run for the next run to inherit. The review caught both
 * (issues/resolved/052 §What the review found); the authored-line assertions
 * and the two-runs case below are its.
 *
 * What is driven here is the adapter's public `start()`, with the browser, the
 * step executor and the AI client replaced and everything between the file on
 * disk and the executor's arguments left real: the env files, the data file,
 * the parser, the env bundle and the adapter's own loop. The assertion is on
 * what `executeStep` is handed, because that is what the model reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepResult } from '../src/report/types.js';
import type { StepExecutorOptions } from '../src/runner/step-executor.js';

// ─── The seams: browser, executor, AI client, config, report ────────────────

const launchBrowserMock = vi.fn();
vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: (...args: unknown[]) => launchBrowserMock(...args),
  closeBrowser: vi.fn().mockResolvedValue(undefined),
}));

const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
  },
}));

// Defaults only — no machine `.env`, no `steptix.config.json` discovery — so the
// run reads exactly the project written below. `aiConfigured` stays real.
vi.mock('../src/config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/loader.js')>()),
  loadConfig: async () => structuredClone(DEFAULT_CONFIG),
}));

vi.mock('../src/report/generator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/report/generator.js')>()),
  generateReport: vi.fn().mockResolvedValue(''),
}));

import { UIRunnerAdapter } from '../src/ui/main/runner-adapter.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

const FRONTMATTER_ENV = `---
env: uat
---
`;

/** Steps 1, 2 and 4 go to the executor; 3 is a `Set`, which never does. */
const STEPS_WITH_REFS = `
# Login on the selected environment

## Steps
1. Go to \${env.BASE_URL}/login
2. Enter \${data.user.email} in the email field
3. Set {{who}} to "\${data.user.email}"
4. Type {{who}} into the search box
`;

/**
 * The two AI steps only. A `Set` whose template holds `${data.…}` would not be
 * refused without an environment — it stores the literal, which the first
 * cut's own before-output showed — but what a `Set` does with no environment
 * is the Set story's to pin, not this one's.
 */
const STEPS_NO_SET = `
# Login on no environment in particular

## Steps
1. Go to \${env.BASE_URL}/login
2. Enter \${data.user.email} in the email field
`;

/** The project the adapter runs in: a base `.env`, one named env, its data. */
function writeProject(root: string, testBody: string, name = 'login.md'): string {
  writeFileSync(path.join(root, '.env'), 'SHARED=from-base\n');
  writeFileSync(
    path.join(root, '.env.uat'),
    'BASE_URL=https://uat.example.com\nADMIN_PWD=uat-secret\n',
  );
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(
    path.join(root, 'data', 'uat.json'),
    JSON.stringify({ user: { email: 'admin@uat.example.com', password: '$ADMIN_PWD' } }),
  );
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  const file = path.join(root, 'tests', name);
  writeFileSync(file, testBody);
  return file;
}

function passed(index: number, instruction: string): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

type Emitted = { channel: string; data: Record<string, unknown> };

function makeAdapter(): {
  adapter: UIRunnerAdapter;
  events: Emitted[];
  emitted: (channel: string) => Promise<void>;
} {
  const events: Emitted[] = [];
  const waiters: Array<{ channel: string; resolve: () => void }> = [];
  const adapter = new UIRunnerAdapter((channel, data) => {
    events.push({ channel, data: data as Record<string, unknown> });
    for (const w of waiters) if (w.channel === channel) w.resolve();
  });
  /**
   * Settles when the adapter emits `channel` — at once if it already has. It
   * waits on the event itself rather than polling against a clock of its own,
   * so a slow start under a loaded suite is bounded by the test timeout only.
   */
  function emitted(channel: string): Promise<void> {
    if (events.some((e) => e.channel === channel)) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ channel, resolve }));
  }
  return { adapter, events, emitted };
}

async function runAdapter(file: string): Promise<Emitted[]> {
  const { adapter, events } = makeAdapter();
  await adapter.start(file, []);
  return events;
}

function errorLogs(events: Emitted[]): unknown[] {
  return events
    .filter((e) => e.channel === 'runner:log' && e.data['level'] === 'error')
    .map((e) => e.data['message']);
}

/** What the model would have been asked to do, one entry per executor call. */
function executed(): string[] {
  return executeStepMock.mock.calls.map((call) => call[2] as string);
}

/** The executor's fifth argument: the step as authored, tokens intact. */
function authored(): unknown[] {
  return executeStepMock.mock.calls.map((call) => call[4]);
}

function executorOptions(): StepExecutorOptions[] {
  return executeStepMock.mock.calls.map((call) => call[3] as StepExecutorOptions);
}

function errors(events: Emitted[]): unknown[] {
  return events.filter((e) => e.channel === 'runner:error').map((e) => e.data['message']);
}

function stepStarts(events: Emitted[]): unknown[] {
  return events.filter((e) => e.channel === 'runner:step-start').map((e) => e.data['instruction']);
}

/**
 * What `process.env` held while each executor call ran. The overlay is only
 * observable from inside the run once `start()` puts the environment back, so
 * the executor stand-in records it.
 */
type SeenEnv = { BASE_URL: string | undefined; SHARED: string | undefined };
const envSeenByExecutor: SeenEnv[] = [];
const UAT_SEEN: SeenEnv = { BASE_URL: 'https://uat.example.com', SHARED: 'from-base' };
const NOTHING_SEEN: SeenEnv = { BASE_URL: undefined, SHARED: undefined };

// ─── Per-test isolation: cwd is the project, process.env is restored ────────

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let root: string;

beforeEach(() => {
  // `realpathSync` because the adapter resolves the project from `process.cwd()`
  // and a temp dir can be reached through a short-name alias on Windows.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'steptix-ui-envdata-')));
  process.chdir(root);
  // The minimum scenario: nothing selects an environment unless the test does.
  delete process.env['AUTOMATION_ENV'];
  delete process.env['BASE_URL'];
  delete process.env['SHARED'];
  envSeenByExecutor.length = 0;
  executeStepMock.mockReset();
  executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) => {
    envSeenByExecutor.push({ BASE_URL: process.env['BASE_URL'], SHARED: process.env['SHARED'] });
    return passed(index, instruction);
  });
  launchBrowserMock.mockReset();
  launchBrowserMock.mockResolvedValue({
    page: { url: () => 'about:blank', goto: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

// ─── The cases ──────────────────────────────────────────────────────────────

describe('UIRunnerAdapter resolves ${env.X} / ${data.x} in step text', () => {
  it('a test pinned to an environment by frontmatter `env:` runs with that environment resolved', async () => {
    const file = writeProject(root, FRONTMATTER_ENV + STEPS_WITH_REFS);

    const events = await runAdapter(file);

    expect(errors(events)).toEqual([]);
    // The model is handed values, not references. Step 4 is the proof that
    // the `Set` branch's `envData` threading is live: the template's
    // `${data.user.email}` resolved into `{{who}}`.
    expect(executed()).toEqual([
      'Go to https://uat.example.com/login',
      'Enter admin@uat.example.com in the email field',
      'Type admin@uat.example.com into the search box',
    ]);
    // The executor is also handed the step as AUTHORED — the CLI's fifth
    // argument — so the prompt shows `${data.user.email}` beside a `## Values`
    // row, masked when the name looks secret, rather than the value inline.
    expect(authored()).toEqual([
      'Go to ${env.BASE_URL}/login',
      'Enter ${data.user.email} in the email field',
      'Type {{who}} into the search box',
    ]);
    // The panel shows the substituted text — except the Set line, shown as
    // authored because a Set step is never interpolated before it runs.
    expect(stepStarts(events)).toEqual([
      'Go to https://uat.example.com/login',
      'Enter admin@uat.example.com in the email field',
      'Set {{who}} to "${data.user.email}"',
      'Type admin@uat.example.com into the search box',
    ]);
    // The context travels with every call, so the executor's `## Values`
    // block, its action substitution, a code-behind `step.getVar('data.x')`
    // and secret masking all read what the step text did.
    for (const opts of executorOptions()) {
      expect(opts.envData?.envName).toBe('uat');
      expect(opts.envData?.env['BASE_URL']).toBe('https://uat.example.com');
      expect(opts.envData?.data).toEqual({
        user: { email: 'admin@uat.example.com', password: 'uat-secret' },
      });
    }
    // The overlay reaches `process.env` for the run's duration, as it does
    // for `steptix run`, so a `## Parameters` `$VAR` — which reads `process.env`
    // directly — sees it; and it is gone when the run ends.
    expect(envSeenByExecutor).toEqual([UAT_SEEN, UAT_SEEN, UAT_SEEN]);
    expect(process.env['BASE_URL']).toBeUndefined();
    expect(process.env['SHARED']).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ channel: 'runner:complete', data: { status: 'passed' } });
  });

  it('AUTOMATION_ENV — what `steptix ui --env <name>` sets for the Electron process — selects the environment for a test with no frontmatter', async () => {
    process.env['AUTOMATION_ENV'] = 'uat';
    const file = writeProject(root, STEPS_WITH_REFS);

    const events = await runAdapter(file);

    expect(errors(events)).toEqual([]);
    expect(executed()).toEqual([
      'Go to https://uat.example.com/login',
      'Enter admin@uat.example.com in the email field',
      'Type admin@uat.example.com into the search box',
    ]);
    expect(executorOptions().every((o) => o.envData?.envName === 'uat')).toBe(true);
  });

  it('with no environment selected a `${…}` is left as written, as `steptix run` without `--env` leaves it', async () => {
    const file = writeProject(root, STEPS_NO_SET);

    const events = await runAdapter(file);

    expect(errors(events)).toEqual([]);
    expect(executed()).toEqual([
      'Go to ${env.BASE_URL}/login',
      'Enter ${data.user.email} in the email field',
    ]);
    expect(executorOptions().every((o) => o.envData === undefined)).toBe(true);
    expect(envSeenByExecutor).toEqual([NOTHING_SEEN, NOTHING_SEEN]);
  });

  it('the overlay does not outlive its run: a later run in the same window starts from the environment the window was launched with', async () => {
    const { adapter, events } = makeAdapter();
    const pinned = writeProject(root, FRONTMATTER_ENV + STEPS_WITH_REFS);
    const unpinned = writeProject(root, STEPS_NO_SET, 'plain.md');

    await adapter.start(pinned, []);
    expect(envSeenByExecutor).toEqual([UAT_SEEN, UAT_SEEN, UAT_SEEN]);

    executeStepMock.mockClear();
    envSeenByExecutor.length = 0;
    await adapter.start(unpinned, []);

    expect(errors(events)).toEqual([]);
    // Neither the reference nor `process.env` remembers the earlier run.
    expect(executed()).toEqual([
      'Go to ${env.BASE_URL}/login',
      'Enter ${data.user.email} in the email field',
    ]);
    expect(executorOptions().every((o) => o.envData === undefined)).toBe(true);
    expect(envSeenByExecutor).toEqual([NOTHING_SEEN, NOTHING_SEEN]);
  });

  it('a steer resolves against the same environment; one the environment cannot answer is refused as a log line and the run stays paused', async () => {
    const { adapter, events, emitted } = makeAdapter();
    const file = writeProject(root, FRONTMATTER_ENV + STEPS_WITH_REFS);

    const run = adapter.start(file, [1]);
    // A run that ends without reaching the breakpoint fails here and says so,
    // rather than leaving the wait to run out the test timeout.
    await Promise.race([
      emitted('runner:paused'),
      run.then(() => {
        throw new Error(`the run ended without pausing: ${JSON.stringify(events.at(-1))}`);
      }),
    ]);

    // Refused: said in the log, not thrown at an invoke nobody catches, and
    // not `runner:error`, which would end the run in the panel.
    await adapter.steer('Go to ${env.NOPE}/x');
    expect(executeStepMock).not.toHaveBeenCalled();
    expect(errorLogs(events)).toHaveLength(1);
    expect(errorLogs(events)[0]).toMatch(/NOPE/);
    expect(errors(events)).toEqual([]);

    // Answered: the model reads the steer as typed, and acts on the value.
    await adapter.steer('Go to ${env.BASE_URL}/help');
    expect(executed()).toEqual(['Go to https://uat.example.com/help']);
    expect(authored()).toEqual(['Go to ${env.BASE_URL}/help']);
    expect(executorOptions()[0]?.envData?.envName).toBe('uat');

    adapter.resume();
    await run;
    expect(errors(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ channel: 'runner:complete', data: { status: 'passed' } });
  });
});
