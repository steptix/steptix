/**
 * Assembly goldens — §3 of stories/mcp-server.md.
 *
 * The wire body is an allow-list on the server side, so the failure mode these
 * tests exist to catch is a *silent field drop*: a payload that assembles
 * cleanly, posts successfully, and runs with the wrong environment, no skills
 * directory, or un-interpolated placeholders. Every assertion below is against
 * the finished `request`, not against an intermediate.
 *
 * The projects are real tmpdirs and `resolveProject` is the real one, so these
 * also pin the pinned call order end to end — notably that a `.env.uat` named
 * only by a test's frontmatter is actually loaded (step 10).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleSteps, assembleTestFile } from '../src/mcp/assemble.js';
import { resolveProject } from '../src/mcp/project.js';
import { PreflightFailure } from '../src/mcp/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp');

const BASE_ENV = {
  SERVER_URL: 'http://127.0.0.1:3100',
  AIUI_SERVER_API_KEY: 'project-key',
  BASE_URL: 'https://base.example.com',
  GREETING: 'Welcome back',
  TEST_PASSWORD: 'hunter2',
};

const created: string[] = [];
let root: string;

function writeEnvFile(file: string, vars: Record<string, string>): void {
  writeFileSync(file, `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
}

/** A project with the fixture tests copied into `<root>/tests`. */
function makeProject(config: Record<string, unknown>, dirs: string[] = []): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'aiui-mcp-asm-')));
  created.push(dir);
  writeFileSync(path.join(dir, 'aiui.config.json'), JSON.stringify(config, null, 2));
  writeEnvFile(path.join(dir, '.env'), BASE_ENV);
  writeEnvFile(path.join(dir, '.env.uat'), { BASE_URL: 'https://uat.example.com' });
  for (const sub of dirs) mkdirSync(path.join(dir, sub), { recursive: true });
  cpSync(FIXTURES, path.join(dir, 'tests'), { recursive: true });
  process.env['AIUI_MCP_ROOTS'] = dir;
  return dir;
}

function testFile(name: string, from = root): string {
  return path.join(from, 'tests', name);
}

/** Assemble a fixture with the real resolver. */
function assemble(
  name: string,
  extra: Partial<Parameters<typeof assembleTestFile>[0]> = {},
): ReturnType<typeof assembleTestFile> {
  return assembleTestFile({ path: testFile(name), resolveProject, ...extra });
}

async function refusalText(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PreflightFailure) return err.toolError.content[0]!.text;
    throw err;
  }
  throw new Error('expected a PreflightFailure, but the call succeeded');
}

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env['SERVER_URL'];
  delete process.env['AIUI_SERVER_API_KEY'];
  root = makeProject(
    { tests: { skillsDir: './skills', toolsDir: './tools/src' }, cache: { enabled: true } },
    ['skills', 'tools/src', 'data'],
  );
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('assembleTestFile — goldens', () => {
  it('loads .env.<name> named only by frontmatter, and interpolates config from it', async () => {
    const run = await assemble('env-frontmatter.md');

    // Step 10's whole reason for existing: the name is not known until the
    // parse, so an implementation that resolved the env at step 7 would run
    // this test against the base `.env`.
    expect(run.project.envName).toBe('uat');
    expect(run.request.envName).toBe('uat');
    expect(run.request.env?.['BASE_URL']).toBe('https://uat.example.com');
    expect(run.request.config).toEqual({
      baseUrl: 'https://uat.example.com',
      timeout: '45s',
    });
    // Forwarded verbatim — the server resolves them against the test's dir.
    expect(run.request.dataSources).toEqual({ vip: './data/vip.json' });
    // Steps are NOT interpolated client-side; the server does that.
    expect(run.request.steps).toEqual([
      'Open the dashboard',
      'Confirm the banner says ${env.GREETING}',
    ]);
    expect(run.request.sourceLines).toEqual([16, 17]);
    expect(run.request.testFilePath).toBe(testFile('env-frontmatter.md'));
    expect(run.request.skillsDir).toBe(path.join(root, 'skills'));
    expect(run.request.toolsDir).toBe(path.join(root, 'tools', 'src'));
    expect(run.request.cacheEnabled).toBe(true);
    expect(run.sentSteps).toBe(run.request.steps);
    expect(run.warnings).toEqual([]);
  });

  it('a tool-supplied env_name wins over the frontmatter one', async () => {
    const run = await assemble('env-frontmatter.md', { envName: undefined });
    expect(run.request.envName).toBe('uat');

    writeEnvFile(path.join(root, '.env.prod'), { BASE_URL: 'https://prod.example.com' });
    const overridden = await assemble('env-frontmatter.md', { envName: 'prod' });
    expect(overridden.request.envName).toBe('prod');
    expect(overridden.request.config?.baseUrl).toBe('https://prod.example.com');
  });

  it('sends sections keyed by match text, without rawSteps, on a null prototype', async () => {
    const run = await assemble('sections.md');
    const sections = run.request.sections!;

    expect(Object.keys(sections).sort()).toEqual(['sign in', 'sign out']);
    expect(sections['sign in']).toEqual({
      name: 'Sign in',
      headingLine: 10,
      steps: ['Click Login', 'Enter the credentials'],
      stepLines: [12, 13],
    });
    expect('rawSteps' in sections['sign in']!).toBe(false);
    expect(Object.getPrototypeOf(sections)).toBeNull();
    // A section invoked twice stays two sent steps and one definition.
    expect(run.request.steps).toEqual(['Open the home page', 'Sign in', 'Sign out', 'Sign in']);
  });

  it('projects `cdp` into the wire shape and refuses a non-port value', async () => {
    const run = await assemble('cdp.md');
    expect(run.request.config).toEqual({
      baseUrl: 'https://example.com',
      cdp: { port: 9222, tab: 'active' },
    });

    const text = await refusalText(() => assemble('cdp-bad.md'));
    expect(text).toContain('nine-thousand');
    expect(text).toContain('integer between 1 and 65535');
  });

  it('merges the tool `config` over `## Config` per key, not wholesale', async () => {
    const run = await assemble('cdp.md', { config: { timeout: '99s' } });
    expect(run.request.config).toEqual({
      baseUrl: 'https://example.com',
      timeout: '99s',
      cdp: { port: 9222, tab: 'active' },
    });
  });

  it('drops cdpTab when there is no cdp port', async () => {
    const run = await assemble('cdp-tab-only.md');
    expect(run.request.config).toBeUndefined();
    expect(run.warnings).toEqual([]);
  });

  // stories/per-test-viewport.md §7. The whitelist here is a real projection —
  // a key it does not name never reaches the wire — so an MCP-run test would
  // silently lose its `viewport:` and pass at the wrong size, which is a green
  // suite reporting a layout nobody looked at.
  it("forwards a file's `viewport` to the wire, raw", async () => {
    const run = await assemble('viewport.md');
    expect(run.request.config).toEqual({
      baseUrl: 'https://example.com',
      viewport: 'mobile',
    });
  });

  it('lets a tool `viewport` override the file per key', async () => {
    // The point of the per-key merge for this field: an agent runs someone
    // else's test at phone width without editing it, and the file's `baseUrl`
    // survives.
    const run = await assemble('viewport.md', { config: { viewport: '360x640' } });
    expect(run.request.config).toEqual({
      baseUrl: 'https://example.com',
      viewport: '360x640',
    });
  });

  it('sends a tool `viewport` for a file that declares none', async () => {
    const run = await assemble('simple.md', { config: { viewport: 'tablet' } });
    expect(run.request.config).toEqual({ viewport: 'tablet' });
  });

  it('passes an invalid value THROUGH — the server owns the one validator', async () => {
    // Deliberately not refused here (§3): two validators drift, and the day
    // they disagree an agent gets a different answer from `run_test_file` than
    // a human gets from Run on the same file.
    const run = await assemble('simple.md', { config: { viewport: '390' } });
    expect(run.request.config).toEqual({ viewport: '390' });
    expect(run.warnings).toEqual([]);
  });

  it('honours the whole `cache:` value set in both directions', async () => {
    // Project default is on.
    expect((await assemble('simple.md')).request.cacheEnabled).toBe(true);
    expect((await assemble('cache-disabled.md')).request.cacheEnabled).toBeUndefined();

    const off = makeProject({ cache: { enabled: false } });
    expect(
      (await assembleTestFile({ path: testFile('simple.md', off), resolveProject })).request
        .cacheEnabled,
    ).toBeUndefined();
    expect(
      (await assembleTestFile({ path: testFile('cache-enabled.md', off), resolveProject }))
        .request.cacheEnabled,
    ).toBe(true);
  });

  it('warns that `## Config` log levels are not forwarded', async () => {
    const run = await assemble('cache-enabled.md');
    expect(run.warnings.join('\n')).toContain('consoleLogLevel');
    expect(run.request.config).toBeUndefined();
  });

  it('merges tool parameters over `## Parameters` per key and resolves $VAR from the project env', async () => {
    const run = await assemble('parameters.md', { parameters: { who: 'auditor', extra: '1' } });

    expect(run.request.parameters).toEqual({
      who: 'auditor',
      password: 'hunter2',
      extra: '1',
    });
    const warnings = run.warnings.join('\n');
    expect(warnings).toContain('Parameter "extra" is not declared');
    expect(warnings).toContain('{{orderId}}');
    expect(warnings).toContain('skill bodies');
  });

  it('warns about steps that need a human', async () => {
    const run = await assemble('unattended.md');
    const warning = run.warnings.find((w) => w.includes('[input:]'))!;
    expect(warning).toContain('2 step(s)');
    expect(warning).toContain('skipped');
  });

  it('drops sourceLines, with a warning, when the parser emitted a zero', async () => {
    const run = await assemble('unscanned-step.md');
    expect(run.request.sourceLines).toBeUndefined();
    expect(run.warnings.join('\n')).toContain('Source line numbers were unusable');
  });

  it('uses the defaults.ts literals when the config declares no skillsDir', async () => {
    const bare = makeProject({ tests: { dir: './tests' } }, ['skills']);
    const run = await assembleTestFile({ path: testFile('simple.md', bare), resolveProject });
    expect(run.request.skillsDir).toBe(path.join(bare, 'skills'));
    // ./tools/src does not exist in this project, so the field is omitted
    // rather than pointed at nothing.
    expect(run.request.toolsDir).toBeUndefined();
  });

  it('warns when dataSources are declared with no environment name', async () => {
    const run = await assemble('datasources-no-env.md');
    expect(run.request.dataSources).toEqual({ vip: './data/vip.json' });
    expect(run.warnings.join('\n')).toContain('ignores them unless an environment name');
  });

  it('refuses a dataSource that resolves outside the allowed roots', async () => {
    const text = await refusalText(() => assemble('escaping-datasource.md'));
    expect(text).toContain('outside every allowed root');
    expect(text).toContain('escapee');
  });
});

describe('assembleTestFile — refusals', () => {
  it('refuses a skill file', async () => {
    const text = await refusalText(() => assemble('skill.md'));
    expect(text).toContain('type: skill');
    expect(text).toContain(testFile('skill.md'));
  });

  it('refuses a test with no steps', async () => {
    const text = await refusalText(() => assemble('no-steps.md'));
    expect(text).toContain('no steps');
  });

  it('reports both parseTestContent throw classes as parse failures', async () => {
    const duplicate = await refusalText(() => assemble('duplicate-section.md'));
    expect(duplicate).toContain(`Cannot parse ${testFile('duplicate-section.md')}: `);
    expect(duplicate).toContain('Duplicate section');

    const mismatch = await refusalText(() => assemble('line-mismatch.md'));
    expect(mismatch).toContain(`Cannot parse ${testFile('line-mismatch.md')}: `);
    expect(mismatch).toContain('Step/line mismatch');
  });
});

describe('interpolation', () => {
  it('fails pre-flight, verbatim, on an unknown ${env.X}', async () => {
    const text = await refusalText(() =>
      assemble('simple.md', { config: { baseUrl: '${env.NOPE}' } }),
    );
    expect(text).toContain("Unknown environment variable 'NOPE'");
    expect(text).toContain(testFile('simple.md'));
  });

  it('resolves a whole-value $VAR, and leaves an unresolvable one literal with a warning', async () => {
    const run = await assemble('dollar-var.md');
    expect(run.request.config?.baseUrl).toBe('https://base.example.com');
    expect(run.request.parameters).toEqual({ token: '$MISSING_TOKEN' });
    expect(run.warnings.join('\n')).toContain('$MISSING_TOKEN is not set');
  });

  it('warns about a ${data.X} placeholder it cannot resolve client-side', async () => {
    const run = await assemble('data-placeholder.md');
    expect(run.request.parameters).toEqual({ region: '${data.region}' });
    expect(run.warnings.join('\n')).toContain('${data.region}');
  });

  it('warns when nothing will interpolate a ${...} because no env name is in play', async () => {
    const run = await assembleSteps({
      steps: ['Log in as ${env.USER}'],
      resolveProject,
      projectRoot: root,
    });
    const warning = run.warnings.join('\n');
    expect(warning).toContain('No environment name is in play');
    expect(warning).toContain('${env.USER}');
  });
});

describe('assembleSteps', () => {
  it('synthesises a test file path and 1..n source lines without touching the disk', async () => {
    const run = await assembleSteps({
      steps: ['Open the home page', 'Sign in', 'Sign out'],
      resolveProject,
      projectRoot: root,
      envName: 'uat',
    });

    expect(run.request.testFilePath).toBe(path.join(root, '.aiui-mcp-steps.md'));
    expect(existsSync(run.request.testFilePath!)).toBe(false);
    expect(run.request.sourceLines).toEqual([1, 2, 3]);
    expect(run.request.sections).toBeUndefined();
    expect(run.request.dataSources).toBeUndefined();
    expect(run.request.envName).toBe('uat');
    expect(run.request.env?.['BASE_URL']).toBe('https://uat.example.com');
    expect(run.request.skillsDir).toBe(path.join(root, 'skills'));
    expect(run.request.toolsDir).toBe(path.join(root, 'tools', 'src'));
    expect(run.request.cacheEnabled).toBe(true);
    expect(run.sentSteps).toEqual(run.request.steps);
  });

  it('interpolates the tool-supplied config and parameters', async () => {
    const run = await assembleSteps({
      steps: ['Open the home page'],
      resolveProject,
      projectRoot: root,
      envName: 'uat',
      config: { baseUrl: '${env.BASE_URL}', timeout: '30s' },
      parameters: { who: '$TEST_PASSWORD' },
    });

    expect(run.request.config).toEqual({ baseUrl: 'https://uat.example.com', timeout: '30s' });
    expect(run.request.parameters).toEqual({ who: 'hunter2' });
  });

  it('refuses an empty step list', async () => {
    const text = await refusalText(() =>
      assembleSteps({ steps: [], resolveProject, projectRoot: root }),
    );
    expect(text).toContain('at least one instruction');
  });
});
