/**
 * Roots confinement, `project_root` selection, config discovery and env
 * composition — §4 and §4a of stories/mcp-server.md.
 *
 * These are the MCP server's security boundary, so most of what follows
 * asserts a *refusal*. Every project lives in a fresh tmpdir with
 * `STEPTIX_MCP_ROOTS` pointed at it: the cwd default would otherwise make the
 * whole suite depend on where vitest was launched from, and the repo's own
 * `.env` holds real credentials.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  allowedRoots,
  applyEnvName,
  resolveProject,
  resolveTestsGlob,
} from '../src/mcp/project.js';
import { PreflightFailure } from '../src/mcp/types.js';

const BASE_ENV = { STEPTIX_SERVER_URL: 'http://127.0.0.1:3100', STEPTIX_SERVER_API_KEY: 'project-key' };

interface ProjectSpec {
  /** `null` writes no steptix.config.json at all. */
  config?: Record<string, unknown> | null;
  /** `null` writes no .env at all. */
  env?: Record<string, string> | null;
  envFiles?: Record<string, Record<string, string>>;
  dirs?: string[];
  files?: Record<string, string>;
}

const created: string[] = [];

/** A tmpdir, realpath'd — on macOS `/var` is a symlink to `/private/var` and
 *  on win32 TMP is routinely an 8.3 short name, and confinement compares
 *  canonical paths. */
function makeTmp(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'steptix-mcp-')));
  created.push(dir);
  return dir;
}

function writeEnvFile(file: string, vars: Record<string, string>): void {
  writeFileSync(file, `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
}

function seedProject(root: string, spec: ProjectSpec = {}): string {
  mkdirSync(root, { recursive: true });
  if (spec.config !== null) {
    writeFileSync(
      path.join(root, 'steptix.config.json'),
      JSON.stringify(spec.config ?? { tests: { dir: './tests' } }, null, 2),
    );
  }
  if (spec.env !== null) writeEnvFile(path.join(root, '.env'), spec.env ?? BASE_ENV);
  for (const [name, vars] of Object.entries(spec.envFiles ?? {})) {
    writeEnvFile(path.join(root, `.env.${name}`), vars);
  }
  for (const dir of spec.dirs ?? []) mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/** The text of the `McpToolError` a pre-flight refusal carries. */
async function refusalText(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PreflightFailure) return err.toolError.content[0]!.text;
    throw err;
  }
  throw new Error('expected a PreflightFailure, but the call succeeded');
}

/** Where the redirected user root lands. The beforeEach points both
 *  LOCALAPPDATA (win32) and XDG_CONFIG_HOME (elsewhere) at one tmp, so the
 *  answer is the same join on every platform. */
function testUserRoot(): string {
  return path.join((process.env['LOCALAPPDATA'] ?? process.env['XDG_CONFIG_HOME'])!, 'steptix');
}

/** Seed the user root itself — config and/or `.env` — without the project
 *  defaults `seedProject` assumes. */
function seedUserRoot(spec: { config?: Record<string, unknown>; env?: Record<string, string> }): string {
  const root = testUserRoot();
  mkdirSync(root, { recursive: true });
  if (spec.config !== undefined) {
    writeFileSync(path.join(root, 'steptix.config.json'), JSON.stringify(spec.config, null, 2));
  }
  if (spec.env !== undefined) writeEnvFile(path.join(root, '.env'), spec.env);
  return root;
}

/** Directory symlinks need a junction on win32, FILE symlinks need admin or
 *  Developer Mode there, and both are outright unavailable in some sandboxes.
 *  A test that cannot create one has nothing to assert — so it calls
 *  `ctx.skip()` on a false return, and reports skipped rather than passing
 *  green about a security boundary it never touched. */
function trySymlink(target: string, link: string, type: 'dir' | 'file'): boolean {
  try {
    symlinkSync(target, link, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
    return true;
  } catch {
    return false;
  }
}

const originalEnv = { ...process.env };

beforeEach(() => {
  // A developer shell with STEPTIX_SERVER_URL set would silently satisfy the
  // discovery-fallback tests that are meant to fail.
  delete process.env['STEPTIX_SERVER_URL'];
  delete process.env['STEPTIX_SERVER_API_KEY'];
  // The key chain ends at the machine key file — redirect the user root into
  // an empty per-test dir so this machine's real key never leaks in. The
  // generic afterEach env restore puts both variables back.
  const userRootTmp = makeTmp();
  process.env['LOCALAPPDATA'] = userRootTmp;
  process.env['XDG_CONFIG_HOME'] = userRootTmp;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('allowed roots (§4a)', () => {
  it('defaults to the process cwd when STEPTIX_MCP_ROOTS is unset', async () => {
    const root = seedProject(makeTmp());
    delete process.env['STEPTIX_MCP_ROOTS'];
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    // The user root rides along implicitly (stories/mcp-no-project.md): it is
    // part of the confinement allow-list on every call, configured or not.
    expect(allowedRoots()).toEqual([root, testUserRoot()]);
    await expect(resolveProject({})).resolves.toMatchObject({
      projectRoot: root,
      scope: 'project',
    });
  });

  it('splits STEPTIX_MCP_ROOTS on path.delimiter and honours every entry', async () => {
    const first = seedProject(makeTmp());
    const second = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = [first, second].join(path.delimiter);

    expect(allowedRoots()).toEqual([first, second, testUserRoot()]);
    await expect(resolveProject({ projectRoot: second })).resolves.toMatchObject({
      projectRoot: second,
      scope: 'project',
    });
  });

  it('refuses a path outside every root, naming the roots and the env var', async () => {
    const root = seedProject(makeTmp());
    const outside = seedProject(makeTmp(), { files: { 'x.md': '# x\n' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(outside, 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
    expect(text).toContain(root);
    expect(text).toContain('STEPTIX_MCP_ROOTS');
  });

  it('refuses a `..` escape even though it lexically starts inside the root', async () => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    seedProject(path.join(parent, 'other'), { files: { 'x.md': '# x\n' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, '..', 'other', 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
  });

  it('compares on segment boundaries, so proj-evil is not inside proj', async () => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    const evil = seedProject(path.join(parent, 'proj-evil'), { files: { 'x.md': '# x\n' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(evil, 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
  });

  it('refuses a symlink inside the root that points outside it', async (ctx) => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    const secrets = seedProject(path.join(parent, 'secrets'), { files: { 'x.md': '# x\n' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;
    if (!trySymlink(secrets, path.join(root, 'link'), 'dir')) ctx.skip('cannot create a directory link here');

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, 'link', 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
  });

  it.runIf(process.platform === 'win32')(
    'accepts a differently-cased root on win32',
    async () => {
      const root = seedProject(makeTmp(), { files: { 'x.md': '# x\n' } });
      process.env['STEPTIX_MCP_ROOTS'] = root.toUpperCase();

      await expect(
        resolveProject({ testFilePath: path.join(root, 'x.md') }),
      ).resolves.toMatchObject({ projectRoot: root });
    },
  );

  it('refuses a STEPTIX_MCP_ROOTS entry that does not exist', async () => {
    process.env['STEPTIX_MCP_ROOTS'] = path.join(makeTmp(), 'nope');
    const text = await refusalText(async () => resolveProject({}));
    expect(text).toContain('STEPTIX_MCP_ROOTS names a directory that cannot be resolved');
  });
});

describe('project_root selection (§4a)', () => {
  it('branch 1: walks up from the test file', async () => {
    const root = seedProject(makeTmp(), { files: { 'tests/deep/x.md': '# x\n' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const project = await resolveProject({ testFilePath: path.join(root, 'tests/deep/x.md') });
    expect(project.projectRoot).toBe(root);
    expect(project.configPath).toBe(path.join(root, 'steptix.config.json'));
  });

  it('branch 2: uses the supplied project_root', async () => {
    const outer = makeTmp();
    const inner = seedProject(path.join(outer, 'inner'));
    process.env['STEPTIX_MCP_ROOTS'] = outer;

    await expect(resolveProject({ projectRoot: inner })).resolves.toMatchObject({
      projectRoot: inner,
    });
  });

  it('branch 3: falls back to the cwd when it sits inside a root', async () => {
    const root = seedProject(makeTmp());
    const sub = path.join(root, 'tests');
    mkdirSync(sub, { recursive: true });
    process.env['STEPTIX_MCP_ROOTS'] = root;
    vi.spyOn(process, 'cwd').mockReturnValue(sub);

    await expect(resolveProject({})).resolves.toMatchObject({ projectRoot: root });
  });

  it('branch 4: falls back to the single configured root', async () => {
    const root = seedProject(makeTmp());
    const elsewhere = makeTmp();
    process.env['STEPTIX_MCP_ROOTS'] = root;
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);

    await expect(resolveProject({})).resolves.toMatchObject({ projectRoot: root });
  });

  it('branch 5: several roots, cwd in none — falls back to the user root, reported via scope', async () => {
    const first = seedProject(makeTmp());
    const second = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = [first, second].join(path.delimiter);
    vi.spyOn(process, 'cwd').mockReturnValue(makeTmp());

    // The caller was not talking about either configured project, which is
    // exactly the situation project-less mode exists for. The landing is
    // reported (`scope: 'user'`), never silent.
    await expect(resolveProject({})).resolves.toMatchObject({
      scope: 'user',
      projectRoot: testUserRoot(),
    });
  });

  it('branch 5 with requireProject keeps the refusal for the project-shaped tools', async () => {
    const first = seedProject(makeTmp());
    const second = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = [first, second].join(path.delimiter);
    vi.spyOn(process, 'cwd').mockReturnValue(makeTmp());

    const text = await refusalText(() => resolveProject({ requireProject: true }));
    expect(text).toContain('Could not decide which project to use');
    expect(text).toContain(first);
    expect(text).toContain(second);
  });

  it('refuses a test file that is outside the supplied project_root', async () => {
    const outer = makeTmp();
    const a = seedProject(path.join(outer, 'a'));
    const b = seedProject(path.join(outer, 'b'), { files: { 'x.md': '# x\n' } });
    process.env['STEPTIX_MCP_ROOTS'] = outer;

    const text = await refusalText(() =>
      resolveProject({ projectRoot: a, testFilePath: path.join(b, 'x.md') }),
    );
    expect(text).toContain('is not inside project_root');
  });

  it('stops the steptix.config.json walk at the allowed root', async () => {
    // The config lives one level ABOVE the allowed root: an unbounded walk
    // would find it and pull skillsDir/toolsDir/.env from outside confinement.
    const outer = seedProject(makeTmp());
    const root = path.join(outer, 'child');
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'tests', 'x.md'), '# x\n');
    process.env['STEPTIX_MCP_ROOTS'] = root;

    // requireProject keeps the walk's refusal observable; the message still
    // names what was searched and must not have reached `outer`.
    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, 'tests', 'x.md'), requireProject: true }),
    );
    expect(text).toContain('No steptix.config.json found');
    expect(text).toContain(path.join(root, 'tests'));
    expect(text).not.toContain(`${outer}${path.sep}steptix.config.json`);
  });

  it('the user-scope fallback keeps the walk bound too — the outer config is never adopted', async () => {
    const outer = seedProject(makeTmp());
    const root = path.join(outer, 'child');
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    process.env['STEPTIX_MCP_ROOTS'] = root;
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'tests'));

    const project = await resolveProject({});
    // Landed on the user root — NOT on `outer`, whose config sits outside
    // confinement. The searched list proves the walk stopped at the bound.
    expect(project.scope).toBe('user');
    expect(project.projectRoot).toBe(testUserRoot());
    expect(project.configSearch).toContain(path.join(root, 'tests'));
    expect(project.configSearch).not.toContain(outer);
  });

  it('refuses a relative path before touching the filesystem', async () => {
    process.env['STEPTIX_MCP_ROOTS'] = seedProject(makeTmp());
    const text = await refusalText(() => resolveProject({ testFilePath: 'tests/x.md' }));
    expect(text).toContain('must be an absolute path');
  });

  it('reports a missing test file as a missing file, not as a confinement failure', async () => {
    const root = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = root;
    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, 'nope.md') }),
    );
    expect(text).toContain('No such file');
  });
});

describe('steptix.config.json', () => {
  it('resolves declared skillsDir/toolsDir absolute, and omits ones that are absent', async () => {
    const root = seedProject(makeTmp(), {
      config: { tests: { skillsDir: './macros', toolsDir: './code/tools' } },
      dirs: ['macros'],
    });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root });
    expect(project.skillsDir).toBe(path.join(root, 'macros'));
    expect(project.toolsDir).toBeNull();
  });

  it('falls back to the defaults.ts literals when the config omits them', async () => {
    // The case the fallback exists for: a project with ./skills on disk that
    // never mentions it. Without the literal every [skill: x] would ship to
    // the AI as prose.
    const root = seedProject(makeTmp(), {
      config: { tests: { dir: './tests' } },
      dirs: ['skills', 'tools/src'],
    });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root });
    expect(project.skillsDir).toBe(path.join(root, 'skills'));
    expect(project.toolsDir).toBe(path.join(root, 'tools', 'src'));
  });

  it('refuses a toolsDir that resolves outside the allowed roots', async () => {
    const root = seedProject(makeTmp(), {
      config: { tests: { toolsDir: '../../../evil' } },
    });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root }));
    expect(text).toContain('outside every allowed root');
  });

  it('reads desktopScreenshots from desktop.reportScreenshots, closed on anything but true or absent', async () => {
    // SPEC-use-computer.md §10.1: the privacy switch decides whether a desktop
    // capture may come back to the agent, so an ambiguous value withholds it.
    const absent = seedProject(makeTmp(), { config: {} });
    const on = seedProject(makeTmp(), { config: { desktop: { reportScreenshots: true } } });
    const off = seedProject(makeTmp(), { config: { desktop: { reportScreenshots: false } } });
    const garbled = seedProject(makeTmp(), { config: { desktop: { reportScreenshots: 'true' } } });
    process.env['STEPTIX_MCP_ROOTS'] = [absent, on, off, garbled].join(path.delimiter);

    expect((await resolveProject({ projectRoot: absent })).desktopScreenshots).toBe(true);
    expect((await resolveProject({ projectRoot: on })).desktopScreenshots).toBe(true);
    expect((await resolveProject({ projectRoot: off })).desktopScreenshots).toBe(false);
    expect((await resolveProject({ projectRoot: garbled })).desktopScreenshots).toBe(false);
  });

  it('refuses a config that is not readable JSON', async () => {
    const root = makeTmp();
    seedProject(root);
    writeFileSync(path.join(root, 'steptix.config.json'), '{ not json');
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root }));
    expect(text).toContain('could not be read as JSON');
  });

  it('resolveTestsGlob confines tests.dir and falls back to the defaults', async () => {
    const declared = seedProject(makeTmp(), {
      config: { tests: { dir: './suite', pattern: '**/*.spec.md' } },
    });
    const bare = seedProject(makeTmp(), { config: {} });
    const escaping = seedProject(makeTmp(), { config: { tests: { dir: '../../elsewhere' } } });
    process.env['STEPTIX_MCP_ROOTS'] = [declared, bare, escaping].join(path.delimiter);

    expect(resolveTestsGlob(await resolveProject({ projectRoot: declared }))).toEqual({
      dir: path.join(declared, 'suite'),
      pattern: '**/*.spec.md',
    });
    expect(resolveTestsGlob(await resolveProject({ projectRoot: bare }))).toEqual({
      dir: path.join(bare, 'tests'),
      pattern: '**/*.md',
    });
    const project = await resolveProject({ projectRoot: escaping });
    expect(() => resolveTestsGlob(project)).toThrow(PreflightFailure);
  });
});

describe('environment composition (§4)', () => {
  it('composes .env only when no env name is in play', async () => {
    const root = seedProject(makeTmp(), {
      env: { ...BASE_ENV, BASE_URL: 'https://base.example.com' },
      envFiles: { uat: { BASE_URL: 'https://uat.example.com' } },
    });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root });
    expect(project.envName).toBeNull();
    expect(project.env['BASE_URL']).toBe('https://base.example.com');
    expect(project.envFilesConsulted).toEqual([path.join(root, '.env')]);
  });

  it('layers .env.<name> over .env and re-derives the server URL from it', async () => {
    const root = seedProject(makeTmp(), {
      env: { ...BASE_ENV, BASE_URL: 'https://base.example.com' },
      envFiles: {
        uat: { BASE_URL: 'https://uat.example.com', STEPTIX_SERVER_URL: 'http://127.0.0.1:3999' },
      },
    });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root, envName: 'uat' });
    expect(project.envName).toBe('uat');
    expect(project.env['BASE_URL']).toBe('https://uat.example.com');
    expect(project.serverUrl).toBe('http://127.0.0.1:3999');
    expect(project.apiKey).toBe('project-key');
    expect(project.envFilesConsulted).toEqual([
      path.join(root, '.env'),
      path.join(root, '.env.uat'),
    ]);
  });

  it('never seeds the map from process.env', async () => {
    const root = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = root;
    process.env['HOST_ONLY_SECRET'] = 'do-not-egress';

    const project = await resolveProject({ projectRoot: root });
    expect(project.env['HOST_ONLY_SECRET']).toBeUndefined();
  });

  it('falls back to process.env for STEPTIX_SERVER_URL/STEPTIX_SERVER_API_KEY without putting them in the map', async () => {
    const root = seedProject(makeTmp(), { env: { OTHER: 'x' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;
    process.env['STEPTIX_SERVER_URL'] = 'http://127.0.0.1:4100';
    process.env['STEPTIX_SERVER_API_KEY'] = 'host-key';

    const project = await resolveProject({ projectRoot: root });
    expect(project.serverUrl).toBe('http://127.0.0.1:4100');
    expect(project.apiKey).toBe('host-key');
    expect(project.env).toEqual({ OTHER: 'x' });
  });

  it('prefers the project files over process.env', async () => {
    const root = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = root;
    process.env['STEPTIX_SERVER_URL'] = 'http://127.0.0.1:9999';

    await expect(resolveProject({ projectRoot: root })).resolves.toMatchObject({
      serverUrl: 'http://127.0.0.1:3100',
    });
  });

  it('falls back to the machine STEPTIX_SERVER_URL, then the default, when the project names none', async () => {
    // stories/machine-server-url.md: the same two a bare `steptix serve`
    // takes its port from, so auto-start and every other client agree.
    const root = seedProject(makeTmp(), {
      env: { STEPTIX_SERVER_API_KEY: 'k' },
      envFiles: { uat: { X: '1' } },
    });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const bare = await resolveProject({ projectRoot: root, envName: 'uat' });
    expect(bare.serverUrl).toBe('http://127.0.0.1:3100');

    seedUserRoot({ env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:3200' } });
    const machine = await resolveProject({ projectRoot: root, envName: 'uat' });
    expect(machine.serverUrl).toBe('http://127.0.0.1:3200');
    // The machine value is a fallback for the URL only; it never enters the
    // project's env map, which ships to the server as the request's `env`.
    expect(machine.env['STEPTIX_SERVER_URL']).toBeUndefined();
  });

  it('keeps process.env above the machine STEPTIX_SERVER_URL', async () => {
    const root = seedProject(makeTmp(), { env: { STEPTIX_SERVER_API_KEY: 'k' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;
    seedUserRoot({ env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:3200' } });
    process.env['STEPTIX_SERVER_URL'] = 'http://127.0.0.1:4100';

    expect((await resolveProject({ projectRoot: root })).serverUrl).toBe('http://127.0.0.1:4100');
  });

  it('defers a missing STEPTIX_SERVER_API_KEY as null rather than refusing', async () => {
    // stories/machine-key.md: only server-start.ts can decide what a missing
    // key means — down + loopback generates one, a running server refuses.
    const root = seedProject(makeTmp(), { env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:3100' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root });
    expect(project.apiKey).toBe(null);
  });

  it('falls back to the machine key file when project and process.env have none', async () => {
    const root = seedProject(makeTmp(), { env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:3100' } });
    process.env['STEPTIX_MCP_ROOTS'] = root;
    const steptixDir = path.join(process.env['LOCALAPPDATA']!, 'steptix');
    mkdirSync(steptixDir, { recursive: true });
    writeFileSync(path.join(steptixDir, '.env'), 'STEPTIX_SERVER_API_KEY=machine-key\n');

    const project = await resolveProject({ projectRoot: root });
    expect(project.apiKey).toBe('machine-key');
    // The machine key rides the discovery fallback, never the project map —
    // same rule as the process.env fallback above it.
    expect(project.env['STEPTIX_SERVER_API_KEY']).toBeUndefined();
  });

  it('prefers the project .env and process.env over the machine key', async () => {
    const steptixDir = path.join(process.env['LOCALAPPDATA']!, 'steptix');
    mkdirSync(steptixDir, { recursive: true });
    writeFileSync(path.join(steptixDir, '.env'), 'STEPTIX_SERVER_API_KEY=machine-key\n');

    const withProjectKey = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = withProjectKey;
    await expect(resolveProject({ projectRoot: withProjectKey })).resolves.toMatchObject({
      apiKey: 'project-key',
    });

    const withoutProjectKey = seedProject(makeTmp(), {
      env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:3100' },
    });
    process.env['STEPTIX_MCP_ROOTS'] = withoutProjectKey;
    process.env['STEPTIX_SERVER_API_KEY'] = 'host-key';
    await expect(resolveProject({ projectRoot: withoutProjectKey })).resolves.toMatchObject({
      apiKey: 'host-key',
    });
  });

  it('refuses an env_name containing a separator or a traversal (rule 6)', async () => {
    const root = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = root;

    // `..` alone is deliberately NOT in this list: it satisfies the charset,
    // and it is harmless because the name is concatenated after `.env.` — the
    // rule that matters is "no separators", which is what makes traversal
    // impossible.
    for (const bad of ['../secrets', 'a/b', 'a\\b', 'a b', '.env.uat:x']) {
      const text = await refusalText(() => resolveProject({ projectRoot: root, envName: bad }));
      expect(text).toContain('is not a valid environment name');
    }
  });

  it('reports a missing .env.<name> in the loader\'s own words', async () => {
    const root = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root, envName: 'uat' }));
    expect(text).toBe(`Environment file not found: ${path.join(root, '.env.uat')}`);
  });

  it('refuses a .env.<name> symlinked outside the allowed roots', async (ctx) => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    const secrets = path.join(parent, 'secrets.env');
    writeFileSync(secrets, 'STOLEN=1\n');
    process.env['STEPTIX_MCP_ROOTS'] = root;
    if (!trySymlink(secrets, path.join(root, '.env.uat'), 'file')) ctx.skip('cannot create a file symlink here');

    const text = await refusalText(() => resolveProject({ projectRoot: root, envName: 'uat' }));
    expect(text).toContain('outside every allowed root');
  });

  it('applyEnvName validates a frontmatter-derived name identically', async () => {
    const root = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = root;
    const project = await resolveProject({ projectRoot: root });

    const text = await refusalText(() => applyEnvName(project, '../../etc/passwd'));
    expect(text).toContain('is not a valid environment name');
  });
});

describe('user scope (stories/mcp-no-project.md)', () => {
  /** A configured root with no steptix.config.json anywhere in it, adopted as
   *  the cwd — the canonical "no project" starting position. */
  function noProjectCwd(): string {
    const root = makeTmp();
    process.env['STEPTIX_MCP_ROOTS'] = root;
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    return root;
  }

  it('rule 1: no config anywhere resolves to the user root instead of refusing', async () => {
    const root = noProjectCwd();

    const project = await resolveProject({});
    expect(project.scope).toBe('user');
    expect(project.projectRoot).toBe(testUserRoot());
    expect(project.configPath).toBe(path.join(testUserRoot(), 'steptix.config.json'));
    // Rule 7's raw material: the walk that found nothing is on the result.
    expect(project.configSearch).toContain(root);
    // Rule 6's floor: never a skills or tools directory.
    expect(project.skillsDir).toBeNull();
    expect(project.toolsDir).toBeNull();
  });

  it('defaults STEPTIX_SERVER_URL to the port a bare serve listens on, below both env layers', async () => {
    noProjectCwd();
    expect((await resolveProject({})).serverUrl).toBe('http://127.0.0.1:3100');

    // The user root's own .env beats the default…
    seedUserRoot({ env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:4444' } });
    expect((await resolveProject({})).serverUrl).toBe('http://127.0.0.1:4444');

    // …and process.env sits between the two.
    rmSync(path.join(testUserRoot(), '.env'));
    process.env['STEPTIX_SERVER_URL'] = 'http://127.0.0.1:5555';
    expect((await resolveProject({})).serverUrl).toBe('http://127.0.0.1:5555');
  });

  it('reads the user root .env directly — no walk-up past the root', async () => {
    noProjectCwd();
    // A stray .env one level ABOVE the user root (i.e. in LOCALAPPDATA
    // itself). The project walk-up read would adopt it; the direct read must
    // not.
    writeEnvFile(path.join(path.dirname(testUserRoot()), '.env'), { STRAY: 'adopted' });
    seedUserRoot({ env: { MINE: 'yes' } });

    const project = await resolveProject({});
    expect(project.env['MINE']).toBe('yes');
    expect(project.env['STRAY']).toBeUndefined();
    expect(project.envFilesConsulted).toEqual([path.join(testUserRoot(), '.env')]);
  });

  it('honours the user root steptix.config.json when present, defaults when absent', async () => {
    noProjectCwd();
    expect((await resolveProject({})).cdpPermissions.allowUnowned).toBe(false);

    seedUserRoot({
      config: { mcp: { cdp: { allowUnowned: true } } },
    });
    const project = await resolveProject({});
    expect(project.cdpPermissions.allowUnowned).toBe(true);
  });

  it('rule 8: allowUnowned in a project does not widen project-less calls, and vice versa', async () => {
    // A project that widened its own reach…
    const widened = seedProject(makeTmp(), {
      config: { mcp: { cdp: { allowUnowned: true } } },
    });
    process.env['STEPTIX_MCP_ROOTS'] = widened;
    expect((await resolveProject({ projectRoot: widened })).cdpPermissions.allowUnowned).toBe(
      true,
    );

    // …grants nothing to a project-less call on the same machine…
    vi.spyOn(process, 'cwd').mockReturnValue(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = makeTmp();
    expect((await resolveProject({})).cdpPermissions.allowUnowned).toBe(false);

    // …and the reverse: a user root that widened project-less reach grants
    // nothing to a project that did not.
    seedUserRoot({ config: { mcp: { cdp: { allowUnowned: true } } } });
    expect((await resolveProject({})).cdpPermissions.allowUnowned).toBe(true);
    const plain = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = plain;
    expect((await resolveProject({ projectRoot: plain })).cdpPermissions.allowUnowned).toBe(
      false,
    );
  });

  it('an explicit project_root naming the user root is user scope, whatever it contains', async () => {
    const userRoot = seedUserRoot({
      config: { tests: { skillsDir: './skills' } },
      env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:4444' },
    });
    mkdirSync(path.join(userRoot, 'skills'), { recursive: true });
    process.env['STEPTIX_MCP_ROOTS'] = seedProject(makeTmp());

    const project = await resolveProject({ projectRoot: userRoot });
    expect(project.scope).toBe('user');
    // Someone dropping a skills/ directory into the user root must not turn
    // project-less conversations into ones that execute it (rule 6).
    expect(project.skillsDir).toBeNull();
    expect(project.toolsDir).toBeNull();
    expect(project.serverUrl).toBe('http://127.0.0.1:4444');
  });

  it('requireProject refuses the user root by name, and the fallback path with the walk', async () => {
    const userRoot = seedUserRoot({ config: {} });
    process.env['STEPTIX_MCP_ROOTS'] = seedProject(makeTmp());

    const explicit = await refusalText(() =>
      resolveProject({ projectRoot: userRoot, requireProject: true }),
    );
    expect(explicit).toContain('not a project');
    expect(explicit).toContain(userRoot);

    const root = noProjectCwd();
    const fallback = await refusalText(() => resolveProject({ requireProject: true }));
    expect(fallback).toContain('No steptix.config.json found');
    expect(fallback).toContain(root);
  });

  it('layers .env.<name> under the user root exactly like a project', async () => {
    noProjectCwd();
    const userRoot = seedUserRoot({ env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:4444' } });
    writeEnvFile(path.join(userRoot, '.env.uat'), { STEPTIX_SERVER_URL: 'http://127.0.0.1:4555' });

    const project = await resolveProject({ envName: 'uat' });
    expect(project.scope).toBe('user');
    expect(project.envName).toBe('uat');
    expect(project.serverUrl).toBe('http://127.0.0.1:4555');
    expect(project.envFilesConsulted).toEqual([
      path.join(userRoot, '.env'),
      path.join(userRoot, '.env.uat'),
    ]);
  });

  it('keeps the single-configured-root implication for machine-global hosts', async () => {
    // The Codex/Copilot CLI shape: one STEPTIX_MCP_ROOTS entry, cwd nowhere near
    // it. The user root joining the allow-list must NOT break "that one entry
    // is the project".
    const only = seedProject(makeTmp());
    process.env['STEPTIX_MCP_ROOTS'] = only;
    vi.spyOn(process, 'cwd').mockReturnValue(makeTmp());

    await expect(resolveProject({})).resolves.toMatchObject({
      projectRoot: only,
      scope: 'project',
    });
  });

  it('the machine key still resolves for user scope, and null defers when absent', async () => {
    noProjectCwd();
    expect((await resolveProject({})).apiKey).toBeNull();

    seedUserRoot({ env: { STEPTIX_SERVER_API_KEY: 'machine-key' } });
    expect((await resolveProject({})).apiKey).toBe('machine-key');
  });
});

describe('user root joins the allow-list for ADDRESSING only, never project file-loading', () => {
  // The user root is on `allowedRoots()` so `project_root: <userRoot>` can
  // route to user scope — but a PROJECT's own untrusted config, .env symlink
  // or dataSources must not be able to reach into it. These pin that the
  // pre-story confinement boundary (configured roots only) still holds for
  // project scope. Regression guard for the two reviewers' shared finding.

  it('a project tests.dir pointing into the user root is refused', async () => {
    const root = seedProject(makeTmp(), { config: { tests: { dir: testUserRoot() } } });
    mkdirSync(testUserRoot(), { recursive: true });
    process.env['STEPTIX_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root });
    expect(() => resolveTestsGlob(project)).toThrow(PreflightFailure);
  });

  it('a project skillsDir or toolsDir pointing into the user root is refused, not loaded', async () => {
    // resolveProjectDir confines against the CONFIGURED roots before it looks
    // for the directory — so a config aiming skills or tools at the user root,
    // which `allowedRoots()` does list, is refused rather than handed a
    // directory that executes user-root code. The directory exists, so it is
    // the confinement that refuses it, not a missing path.
    const target = path.join(testUserRoot(), 'skills');
    mkdirSync(target, { recursive: true });

    for (const key of ['skillsDir', 'toolsDir']) {
      const root = seedProject(makeTmp(), { config: { tests: { [key]: target } } });
      process.env['STEPTIX_MCP_ROOTS'] = root;

      const text = await refusalText(() => resolveProject({ projectRoot: root }));
      expect(text, key).toContain('outside every allowed root');
    }
  });

  it('a base .env symlinked into the user root is refused (machine-key exfil channel)', async (ctx) => {
    const root = seedProject(makeTmp(), { env: null });
    mkdirSync(testUserRoot(), { recursive: true });
    writeFileSync(path.join(testUserRoot(), '.env'), 'STEPTIX_SERVER_API_KEY=machine-secret\n');
    process.env['STEPTIX_MCP_ROOTS'] = root;
    if (!trySymlink(path.join(testUserRoot(), '.env'), path.join(root, '.env'), 'file')) {
      ctx.skip('cannot create a file symlink here');
    }

    const text = await refusalText(() => resolveProject({ projectRoot: root }));
    expect(text).toContain('outside every allowed root');
  });

  it('a planted config in a user-root SUBDIRECTORY does not load as a project', async () => {
    // The ===userRoot guard catches the root itself; this covers a child of
    // it, named explicitly. It must not become a real project loading code
    // from under %LOCALAPPDATA%\steptix.
    const sub = path.join(testUserRoot(), 'planted');
    mkdirSync(path.join(sub, 'skills'), { recursive: true });
    writeFileSync(
      path.join(sub, 'steptix.config.json'),
      JSON.stringify({ tests: { skillsDir: './skills' } }),
    );
    writeEnvFile(path.join(sub, '.env'), { STEPTIX_SERVER_URL: 'http://127.0.0.1:3100' });
    process.env['STEPTIX_MCP_ROOTS'] = seedProject(makeTmp());

    const text = await refusalText(() => resolveProject({ projectRoot: sub }));
    expect(text).toContain('outside every allowed root');
  });

  it('but the user root ITSELF as project_root still routes to user scope', async () => {
    // The addressing path the wide allow-list exists to serve — unaffected by
    // the loading-boundary tightening.
    seedUserRoot({ env: { STEPTIX_SERVER_URL: 'http://127.0.0.1:4444' } });
    process.env['STEPTIX_MCP_ROOTS'] = seedProject(makeTmp());

    await expect(resolveProject({ projectRoot: testUserRoot() })).resolves.toMatchObject({
      scope: 'user',
      skillsDir: null,
    });
  });
});
