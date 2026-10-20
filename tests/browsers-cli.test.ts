/**
 * `steptix browsers` (issue #109): the argument checks, where Playwright's CLI
 * is resolved from, and what the child is started with — all without
 * downloading anything. The end-to-end cases run the built CLI with
 * `install --dry-run`, which prints where a build would go and fetches
 * nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync, type spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BROWSERS_USAGE,
  browsersCommand,
  isAllowedBrowsersArgs,
  resolvePlaywrightCli,
} from '../src/cli/commands/browsers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

let tmp: string;
let err: string[];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-browsers-cli-')));
  err = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

/** A fake `playwright` package under `root/node_modules`. */
function fakePlaywright(root: string, pkg: Record<string, unknown>, cli?: string): string {
  const dir = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'playwright', ...pkg }));
  if (cli !== undefined) fs.writeFileSync(path.join(dir, 'cli.js'), cli);
  return dir;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown };
}

/** A spawn that records its call and ends the way `finish` says. */
function fakeSpawn(finish: (child: EventEmitter) => void): { spawn: typeof spawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const impl = (command: string, args: string[], options: SpawnCall['options']) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => finish(child));
    return child;
  };
  return { spawn: impl as unknown as typeof spawn, calls };
}

describe('isAllowedBrowsersArgs', () => {
  it.each([
    [['install']],
    [['install', 'firefox']],
    [['install', 'chromium', 'webkit']],
    [['install', '--with-deps', 'firefox']],
    [['install-deps']],
    [['install-deps', 'webkit']],
    [['--help']],
  ])('allows %j', (args) => {
    expect(isAllowedBrowsersArgs(args)).toBe(true);
  });

  it.each([
    [[]],
    [['codegen']],
    [['test']],
    [['uninstall']],
    [['-h']],
    [['firefox', 'install']],
  ])('refuses %j', (args) => {
    expect(isAllowedBrowsersArgs(args)).toBe(false);
  });
});

describe('browsersCommand', () => {
  it('prints the usage and returns 1 without resolving or starting anything', async () => {
    const resolveCli = vi.fn(() => 'unused');
    const { spawn, calls } = fakeSpawn((child) => child.emit('exit', 0));
    expect(await browsersCommand(['codegen'], { resolveCli, spawn })).toBe(1);
    expect(err.join('\n')).toBe(BROWSERS_USAGE);
    expect(resolveCli).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("runs Playwright's CLI with this Node, the arguments, and the caller's cwd and environment", async () => {
    const cli = path.join(tmp, 'cli.js');
    const { spawn, calls } = fakeSpawn((child) => child.emit('exit', 0));
    expect(await browsersCommand(['install', 'firefox'], { resolveCli: () => cli, spawn })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([cli, 'install', 'firefox']);
    expect(calls[0]!.options.cwd).toBe(process.cwd());
    expect(calls[0]!.options.env).toBe(process.env);
    expect(calls[0]!.options.stdio).toBe('inherit');
  });

  it("returns Playwright's exit code", async () => {
    const { spawn } = fakeSpawn((child) => child.emit('exit', 7));
    expect(await browsersCommand(['install'], { resolveCli: () => 'cli.js', spawn })).toBe(7);
  });

  it('returns 1 when the child ends on a signal', async () => {
    const { spawn } = fakeSpawn((child) => child.emit('exit', null, 'SIGTERM'));
    expect(await browsersCommand(['install'], { resolveCli: () => 'cli.js', spawn })).toBe(1);
  });

  it('returns 1 and says why when the child cannot start', async () => {
    const { spawn } = fakeSpawn((child) => child.emit('error', new Error('spawn failed for the test')));
    expect(await browsersCommand(['install'], { resolveCli: () => 'cli.js', spawn })).toBe(1);
    expect(err.join('\n')).toContain('spawn failed for the test');
  });

  it("returns 1 and says why when Playwright's CLI cannot be found", async () => {
    const { spawn, calls } = fakeSpawn((child) => child.emit('exit', 0));
    const resolveCli = () => {
      throw new Error('not found for the test');
    };
    expect(await browsersCommand(['install'], { resolveCli, spawn })).toBe(1);
    expect(err.join('\n')).toContain('not found for the test');
    expect(calls).toHaveLength(0);
  });
});

describe('resolvePlaywrightCli', () => {
  it("resolves Steptix's own Playwright by default", () => {
    const cli = resolvePlaywrightCli();
    expect(fs.realpathSync(cli)).toBe(
      fs.realpathSync(path.join(REPO_ROOT, 'node_modules', 'playwright', 'cli.js')),
    );
  });

  it('resolves from the module it is given, through the "bin" entry', () => {
    const pkgRoot = path.join(tmp, 'steptix');
    const dir = fakePlaywright(pkgRoot, { bin: { playwright: 'cli.js' } });
    const from = pathToFileURL(path.join(pkgRoot, 'dist', 'cli', 'commands', 'browsers.js'));
    expect(resolvePlaywrightCli(from)).toBe(path.join(dir, 'cli.js'));
  });

  it('accepts a "bin" that is a plain string', () => {
    const pkgRoot = path.join(tmp, 'steptix');
    const dir = fakePlaywright(pkgRoot, { bin: 'lib/cli.js' });
    const from = pathToFileURL(path.join(pkgRoot, 'dist', 'index.js'));
    expect(resolvePlaywrightCli(from)).toBe(path.join(dir, 'lib', 'cli.js'));
  });

  it('throws when "bin" names no playwright CLI', () => {
    const pkgRoot = path.join(tmp, 'steptix');
    fakePlaywright(pkgRoot, {});
    const from = pathToFileURL(path.join(pkgRoot, 'dist', 'index.js'));
    expect(() => resolvePlaywrightCli(from)).toThrow(/names no playwright CLI/);
  });
});

describe('steptix browsers (built CLI)', () => {
  /** Run `dist/index.js` with a user root and browsers folder inside `tmp`. */
  function runCli(args: string[], cwd: string, browsersPath: string) {
    return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: {
        ...process.env,
        LOCALAPPDATA: tmp,
        XDG_CONFIG_HOME: tmp,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      },
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  it('is listed in steptix --help', () => {
    const result = runCli(['--help'], tmp, path.join(tmp, 'browsers'));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+browsers \[args\.\.\.\]/m);
  });

  it.each([[['codegen']], [['-V']], [['--version']]])('refuses %j', (args) => {
    const result = runCli(['browsers', ...args], tmp, path.join(tmp, 'browsers'));
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(BROWSERS_USAGE);
  });

  it("hands options after the subcommand to Playwright, the program's --version included", () => {
    const steptixVersion = runCli(['--version'], tmp, path.join(tmp, 'browsers')).stdout.trim();
    expect(steptixVersion).not.toBe('');
    const result = runCli(['browsers', 'install', '--version'], tmp, path.join(tmp, 'browsers'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(steptixVersion);
    // Playwright's own answer.
    expect(result.stdout).toMatch(/^Version \d+\.\d+\.\d+/m);
  });

  it("uses Steptix's Playwright, not the project's, and the caller's PLAYWRIGHT_BROWSERS_PATH", () => {
    // A project with a playwright of its own that must not be the one run.
    const project = path.join(tmp, 'project');
    fakePlaywright(project, { bin: { playwright: 'cli.js' } }, "console.log('the project playwright ran');");
    const browsers = path.join(tmp, 'browsers');
    fs.mkdirSync(browsers);

    const result = runCli(['browsers', 'install', 'firefox', '--dry-run'], project, browsers);
    // Not `stderr === ''`: Playwright has warnings of its own for stderr (an
    // OS it does not officially support, say), which are no failure here.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('the project playwright ran');
    expect(result.stdout).toContain(path.join(browsers, 'firefox-'));
    // --dry-run downloads nothing.
    expect(fs.readdirSync(browsers)).toEqual([]);
  });
});
