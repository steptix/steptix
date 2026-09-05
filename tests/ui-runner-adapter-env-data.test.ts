/**
 * Regression for issues/resolved/052 — the Electron runner and `${env.X}`.
 *
 * `UIRunnerAdapter` parsed every test with `parseTestFile(filePath, { skillsDir })`
 * and no env context, so the parser never resolved (or validated) a `${env.X}`
 * / `${data.x}` reference for it and never recorded `parsedTest.envData` for
 * the run; the step loop then ran only the `{{…}}` pass. Net effect, for as
 * long as the feature has existed: `Go to ${env.BASE_URL}/login` reached the
 * model as exactly that text. `aiui ui --env staging` could not change it — it
 * loaded the VALUES of `.env.staging` into the process but never said which
 * environment had been picked.
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

// Defaults only — no machine `.env`, no `aiui.config.json` discovery — so the
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

/** The project the adapter runs in: a base `.env`, one named env, its data. */
function writeProject(root: string, testBody: string): string {
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
  const file = path.join(root, 'tests', 'login.md');
  writeFileSync(file, testBody);
  return file;
}

function passed(index: number, instruction: string): StepResult {
  return { index, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
}

type Emitted = { channel: string; data: Record<string, unknown> };

async function runAdapter(file: string): Promise<Emitted[]> {
  const events: Emitted[] = [];
  const adapter = new UIRunnerAdapter((channel, data) => {
    events.push({ channel, data: data as Record<string, unknown> });
  });
  await adapter.start(file, []);
  return events;
}

/** What the model would have been asked to do, one entry per executor call. */
function executed(): string[] {
  return executeStepMock.mock.calls.map((call) => call[2] as string);
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

// ─── Per-test isolation: cwd is the project, process.env is restored ────────

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let root: string;

beforeEach(() => {
  // `realpathSync` because the adapter resolves the project from `process.cwd()`
  // and a temp dir can be reached through a short-name alias on Windows.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aiui-ui-envdata-')));
  process.chdir(root);
  // The minimum scenario: nothing selects an environment unless the test does.
  delete process.env['AUTOMATION_ENV'];
  executeStepMock.mockReset();
  executeStepMock.mockImplementation(async (index: number, _total: number, instruction: string) =>
    passed(index, instruction),
  );
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
    // The panel shows the same text — except the Set line, shown as authored
    // because a Set step is never interpolated before it runs.
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
    // The overlay reaches `process.env`, as it does for `aiui run`, so a
    // `## Parameters` `$VAR` — which reads `process.env` directly — sees it.
    expect(process.env['BASE_URL']).toBe('https://uat.example.com');
    expect(process.env['SHARED']).toBe('from-base');
    expect(events.at(-1)).toMatchObject({ channel: 'runner:complete', data: { status: 'passed' } });
  });

  it('AUTOMATION_ENV — what `aiui ui --env <name>` sets for the Electron process — selects the environment for a test with no frontmatter', async () => {
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

  it('with no environment selected a `${…}` is left as written, as `aiui run` without `--env` leaves it', async () => {
    // Only the two AI steps: a `Set` whose template needs `${data.…}` would be
    // refused here, and that refusal is the Set story's to test, not this one's.
    const file = writeProject(
      root,
      `
# Login on no environment in particular

## Steps
1. Go to \${env.BASE_URL}/login
2. Enter \${data.user.email} in the email field
`,
    );

    const events = await runAdapter(file);

    expect(errors(events)).toEqual([]);
    expect(executed()).toEqual([
      'Go to ${env.BASE_URL}/login',
      'Enter ${data.user.email} in the email field',
    ]);
    expect(executorOptions().every((o) => o.envData === undefined)).toBe(true);
  });
});
