/**
 * Roots confinement, `project_root` selection, config discovery and env
 * composition — §4 and §4a of stories/mcp-server.md.
 *
 * These are the MCP server's security boundary, so most of what follows
 * asserts a *refusal*. Every project lives in a fresh tmpdir with
 * `AIUI_MCP_ROOTS` pointed at it: the cwd default would otherwise make the
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

const BASE_ENV = { SERVER_URL: 'http://127.0.0.1:3100', SERVER_API_KEY: 'project-key' };

interface ProjectSpec {
  /** `null` writes no aiui.config.json at all. */
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
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'aiui-mcp-')));
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
      path.join(root, 'aiui.config.json'),
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

/** Directory symlinks need a junction on win32 and are outright unavailable
 *  in some sandboxes; a test that cannot create one has nothing to assert. */
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
  // A developer shell with SERVER_URL set would silently satisfy the
  // discovery-fallback tests that are meant to fail.
  delete process.env['SERVER_URL'];
  delete process.env['SERVER_API_KEY'];
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
  it('defaults to the process cwd when AIUI_MCP_ROOTS is unset', async () => {
    const root = seedProject(makeTmp());
    delete process.env['AIUI_MCP_ROOTS'];
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    expect(allowedRoots()).toEqual([root]);
    await expect(resolveProject({})).resolves.toMatchObject({ projectRoot: root });
  });

  it('splits AIUI_MCP_ROOTS on path.delimiter and honours every entry', async () => {
    const first = seedProject(makeTmp());
    const second = seedProject(makeTmp());
    process.env['AIUI_MCP_ROOTS'] = [first, second].join(path.delimiter);

    expect(allowedRoots()).toEqual([first, second]);
    await expect(resolveProject({ projectRoot: second })).resolves.toMatchObject({
      projectRoot: second,
    });
  });

  it('refuses a path outside every root, naming the roots and the env var', async () => {
    const root = seedProject(makeTmp());
    const outside = seedProject(makeTmp(), { files: { 'x.md': '# x\n' } });
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(outside, 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
    expect(text).toContain(root);
    expect(text).toContain('AIUI_MCP_ROOTS');
  });

  it('refuses a `..` escape even though it lexically starts inside the root', async () => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    seedProject(path.join(parent, 'other'), { files: { 'x.md': '# x\n' } });
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, '..', 'other', 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
  });

  it('compares on segment boundaries, so proj-evil is not inside proj', async () => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    const evil = seedProject(path.join(parent, 'proj-evil'), { files: { 'x.md': '# x\n' } });
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(evil, 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
  });

  it('refuses a symlink inside the root that points outside it', async () => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    const secrets = seedProject(path.join(parent, 'secrets'), { files: { 'x.md': '# x\n' } });
    process.env['AIUI_MCP_ROOTS'] = root;
    if (!trySymlink(secrets, path.join(root, 'link'), 'dir')) return;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, 'link', 'x.md') }),
    );
    expect(text).toContain('outside every allowed root');
  });

  it.runIf(process.platform === 'win32')(
    'accepts a differently-cased root on win32',
    async () => {
      const root = seedProject(makeTmp(), { files: { 'x.md': '# x\n' } });
      process.env['AIUI_MCP_ROOTS'] = root.toUpperCase();

      await expect(
        resolveProject({ testFilePath: path.join(root, 'x.md') }),
      ).resolves.toMatchObject({ projectRoot: root });
    },
  );

  it('refuses an AIUI_MCP_ROOTS entry that does not exist', async () => {
    process.env['AIUI_MCP_ROOTS'] = path.join(makeTmp(), 'nope');
    const text = await refusalText(async () => resolveProject({}));
    expect(text).toContain('AIUI_MCP_ROOTS names a directory that cannot be resolved');
  });
});

describe('project_root selection (§4a)', () => {
  it('branch 1: walks up from the test file', async () => {
    const root = seedProject(makeTmp(), { files: { 'tests/deep/x.md': '# x\n' } });
    process.env['AIUI_MCP_ROOTS'] = root;

    const project = await resolveProject({ testFilePath: path.join(root, 'tests/deep/x.md') });
    expect(project.projectRoot).toBe(root);
    expect(project.configPath).toBe(path.join(root, 'aiui.config.json'));
  });

  it('branch 2: uses the supplied project_root', async () => {
    const outer = makeTmp();
    const inner = seedProject(path.join(outer, 'inner'));
    process.env['AIUI_MCP_ROOTS'] = outer;

    await expect(resolveProject({ projectRoot: inner })).resolves.toMatchObject({
      projectRoot: inner,
    });
  });

  it('branch 3: falls back to the cwd when it sits inside a root', async () => {
    const root = seedProject(makeTmp());
    const sub = path.join(root, 'tests');
    mkdirSync(sub, { recursive: true });
    process.env['AIUI_MCP_ROOTS'] = root;
    vi.spyOn(process, 'cwd').mockReturnValue(sub);

    await expect(resolveProject({})).resolves.toMatchObject({ projectRoot: root });
  });

  it('branch 4: falls back to the single configured root', async () => {
    const root = seedProject(makeTmp());
    const elsewhere = makeTmp();
    process.env['AIUI_MCP_ROOTS'] = root;
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);

    await expect(resolveProject({})).resolves.toMatchObject({ projectRoot: root });
  });

  it('branch 5: refuses when several roots are configured and the cwd is in none', async () => {
    const first = seedProject(makeTmp());
    const second = seedProject(makeTmp());
    process.env['AIUI_MCP_ROOTS'] = [first, second].join(path.delimiter);
    vi.spyOn(process, 'cwd').mockReturnValue(makeTmp());

    const text = await refusalText(() => resolveProject({}));
    expect(text).toContain('Could not decide which project to use');
    expect(text).toContain(first);
    expect(text).toContain(second);
  });

  it('refuses a test file that is outside the supplied project_root', async () => {
    const outer = makeTmp();
    const a = seedProject(path.join(outer, 'a'));
    const b = seedProject(path.join(outer, 'b'), { files: { 'x.md': '# x\n' } });
    process.env['AIUI_MCP_ROOTS'] = outer;

    const text = await refusalText(() =>
      resolveProject({ projectRoot: a, testFilePath: path.join(b, 'x.md') }),
    );
    expect(text).toContain('is not inside project_root');
  });

  it('stops the aiui.config.json walk at the allowed root', async () => {
    // The config lives one level ABOVE the allowed root: an unbounded walk
    // would find it and pull skillsDir/toolsDir/.env from outside confinement.
    const outer = seedProject(makeTmp());
    const root = path.join(outer, 'child');
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'tests', 'x.md'), '# x\n');
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, 'tests', 'x.md') }),
    );
    expect(text).toContain('No aiui.config.json found');
    expect(text).toContain(path.join(root, 'tests'));
    expect(text).not.toContain(`${outer}${path.sep}aiui.config.json`);
  });

  it('refuses a relative path before touching the filesystem', async () => {
    process.env['AIUI_MCP_ROOTS'] = seedProject(makeTmp());
    const text = await refusalText(() => resolveProject({ testFilePath: 'tests/x.md' }));
    expect(text).toContain('must be an absolute path');
  });

  it('reports a missing test file as a missing file, not as a confinement failure', async () => {
    const root = seedProject(makeTmp());
    process.env['AIUI_MCP_ROOTS'] = root;
    const text = await refusalText(() =>
      resolveProject({ testFilePath: path.join(root, 'nope.md') }),
    );
    expect(text).toContain('No such file');
  });
});

describe('aiui.config.json', () => {
  it('resolves declared skillsDir/toolsDir absolute, and omits ones that are absent', async () => {
    const root = seedProject(makeTmp(), {
      config: { tests: { skillsDir: './macros', toolsDir: './code/tools' } },
      dirs: ['macros'],
    });
    process.env['AIUI_MCP_ROOTS'] = root;

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
    process.env['AIUI_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root });
    expect(project.skillsDir).toBe(path.join(root, 'skills'));
    expect(project.toolsDir).toBe(path.join(root, 'tools', 'src'));
  });

  it('refuses a toolsDir that resolves outside the allowed roots', async () => {
    const root = seedProject(makeTmp(), {
      config: { tests: { toolsDir: '../../../evil' } },
    });
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root }));
    expect(text).toContain('outside every allowed root');
  });

  it('reads cacheEnabled from cache.enabled === true', async () => {
    const on = seedProject(makeTmp(), { config: { cache: { enabled: true } } });
    const off = seedProject(makeTmp(), { config: { cache: { enabled: 'yes' } } });
    process.env['AIUI_MCP_ROOTS'] = [on, off].join(path.delimiter);

    await expect(resolveProject({ projectRoot: on })).resolves.toMatchObject({
      cacheEnabled: true,
    });
    await expect(resolveProject({ projectRoot: off })).resolves.toMatchObject({
      cacheEnabled: false,
    });
  });

  it('refuses a config that is not readable JSON', async () => {
    const root = makeTmp();
    seedProject(root);
    writeFileSync(path.join(root, 'aiui.config.json'), '{ not json');
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root }));
    expect(text).toContain('could not be read as JSON');
  });

  it('resolveTestsGlob confines tests.dir and falls back to the defaults', async () => {
    const declared = seedProject(makeTmp(), {
      config: { tests: { dir: './suite', pattern: '**/*.spec.md' } },
    });
    const bare = seedProject(makeTmp(), { config: {} });
    const escaping = seedProject(makeTmp(), { config: { tests: { dir: '../../elsewhere' } } });
    process.env['AIUI_MCP_ROOTS'] = [declared, bare, escaping].join(path.delimiter);

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
    process.env['AIUI_MCP_ROOTS'] = root;

    const project = await resolveProject({ projectRoot: root });
    expect(project.envName).toBeNull();
    expect(project.env['BASE_URL']).toBe('https://base.example.com');
    expect(project.envFilesConsulted).toEqual([path.join(root, '.env')]);
  });

  it('layers .env.<name> over .env and re-derives the server URL from it', async () => {
    const root = seedProject(makeTmp(), {
      env: { ...BASE_ENV, BASE_URL: 'https://base.example.com' },
      envFiles: {
        uat: { BASE_URL: 'https://uat.example.com', SERVER_URL: 'http://127.0.0.1:3999' },
      },
    });
    process.env['AIUI_MCP_ROOTS'] = root;

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
    process.env['AIUI_MCP_ROOTS'] = root;
    process.env['HOST_ONLY_SECRET'] = 'do-not-egress';

    const project = await resolveProject({ projectRoot: root });
    expect(project.env['HOST_ONLY_SECRET']).toBeUndefined();
  });

  it('falls back to process.env for SERVER_URL/SERVER_API_KEY without putting them in the map', async () => {
    const root = seedProject(makeTmp(), { env: { OTHER: 'x' } });
    process.env['AIUI_MCP_ROOTS'] = root;
    process.env['SERVER_URL'] = 'http://127.0.0.1:4100';
    process.env['SERVER_API_KEY'] = 'host-key';

    const project = await resolveProject({ projectRoot: root });
    expect(project.serverUrl).toBe('http://127.0.0.1:4100');
    expect(project.apiKey).toBe('host-key');
    expect(project.env).toEqual({ OTHER: 'x' });
  });

  it('prefers the project files over process.env', async () => {
    const root = seedProject(makeTmp());
    process.env['AIUI_MCP_ROOTS'] = root;
    process.env['SERVER_URL'] = 'http://127.0.0.1:9999';

    await expect(resolveProject({ projectRoot: root })).resolves.toMatchObject({
      serverUrl: 'http://127.0.0.1:3100',
    });
  });

  it('names both env files and the variable when SERVER_URL is nowhere', async () => {
    const root = seedProject(makeTmp(), {
      env: { SERVER_API_KEY: 'k' },
      envFiles: { uat: { X: '1' } },
    });
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root, envName: 'uat' }));
    expect(text).toContain('No SERVER_URL');
    expect(text).toContain(path.join(root, '.env'));
    expect(text).toContain(path.join(root, '.env.uat'));
    expect(text).toContain('SERVER_URL environment variable');
  });

  it('has its own error for a missing SERVER_API_KEY', async () => {
    const root = seedProject(makeTmp(), { env: { SERVER_URL: 'http://127.0.0.1:3100' } });
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root }));
    expect(text).toContain('No SERVER_API_KEY');
    expect(text).toContain('`aiui serve` exits rather than start without one');
  });

  it('refuses an env_name containing a separator or a traversal (rule 6)', async () => {
    const root = seedProject(makeTmp());
    process.env['AIUI_MCP_ROOTS'] = root;

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
    process.env['AIUI_MCP_ROOTS'] = root;

    const text = await refusalText(() => resolveProject({ projectRoot: root, envName: 'uat' }));
    expect(text).toBe(`Environment file not found: ${path.join(root, '.env.uat')}`);
  });

  it('refuses a .env.<name> symlinked outside the allowed roots', async () => {
    const parent = makeTmp();
    const root = seedProject(path.join(parent, 'proj'));
    const secrets = path.join(parent, 'secrets.env');
    writeFileSync(secrets, 'STOLEN=1\n');
    process.env['AIUI_MCP_ROOTS'] = root;
    if (!trySymlink(secrets, path.join(root, '.env.uat'), 'file')) return;

    const text = await refusalText(() => resolveProject({ projectRoot: root, envName: 'uat' }));
    expect(text).toContain('outside every allowed root');
  });

  it('applyEnvName validates a frontmatter-derived name identically', async () => {
    const root = seedProject(makeTmp());
    process.env['AIUI_MCP_ROOTS'] = root;
    const project = await resolveProject({ projectRoot: root });

    const text = await refusalText(() => applyEnvName(project, '../../etc/passwd'));
    expect(text).toContain('is not a valid environment name');
  });
});
