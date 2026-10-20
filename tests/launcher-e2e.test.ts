/**
 * The launcher for real: this checkout's built package laid out as npm lays
 * out a global install, run as `steptix` in a child process with its own
 * Steptix folder (docs/specs/SPEC-install.md §5.1, §4.8).
 *
 * Runs `dist/`, so it needs a build (`npm test` builds first). The scratch
 * folder is inside tests/ so the copies resolve their dependencies from this
 * checkout's node_modules, as an npm install resolves them from its own.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;

let scratch: string;
let npmCopy: string;
let userRoot: string;
let env: NodeJS.ProcessEnv;

function steptix(...args: string[]) {
  const result = spawnSync(process.execPath, [path.join(npmCopy, 'dist', 'index.js'), ...args], {
    cwd: scratch,
    env,
    encoding: 'utf-8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(repoRoot, 'tests', '.launcher-e2e-'));
  npmCopy = path.join(scratch, 'npm', 'node_modules', 'steptix');
  fs.mkdirSync(npmCopy, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(npmCopy, 'package.json'));
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(npmCopy, 'dist'), {
    recursive: true,
    filter: (src) => !path.relative(path.join(repoRoot, 'dist'), src).split(path.sep).includes('ui'),
  });
  const base = path.join(scratch, 'home');
  userRoot = path.join(base, 'steptix');
  // LOCALAPPDATA on Windows, XDG_CONFIG_HOME elsewhere: both name `base`.
  env = { ...process.env, LOCALAPPDATA: base, XDG_CONFIG_HOME: base, STEPTIX_STATS: 'off' };
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe('steptix installed by npm', () => {
  // One case, in steps: each step needs what the one before left.
  it('sets itself up on first use, runs from the copy, lists it, and uninstalls', () => {
    const runtimeDir = path.join(userRoot, 'runtimes', version);

    // The first command sets it up.
    const first = steptix('--version');
    expect(first.code).toBe(0);
    expect(first.stderr).toContain(`Setting up Steptix ${version} (first run only)…`);
    expect(fs.existsSync(path.join(runtimeDir, 'dist', 'index.js'))).toBe(true);
    const lines = first.stdout.trim().split('\n');
    expect(lines[1]!.startsWith(`Server: ${version} `)).toBe(true);
    expect(lines[1]!.endsWith(runtimeDir)).toBe(true);
    // The process marked that version in use, and took the mark away on exit.
    expect(fs.readdirSync(path.join(userRoot, 'runtimes', '.in-use'))).toEqual([]);

    // Later commands run the copy's own code and copy nothing. Stamp the copy
    // as another build: only the copy's own code reads this file.
    fs.writeFileSync(path.join(runtimeDir, 'dist', 'build-info.json'), JSON.stringify({ commit: 'abcdef0', modified: false }));
    const second = steptix('--version');
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain('Setting up');
    const [launcher, server] = second.stdout.trim().split('\n');
    expect(server).toContain('(abcdef0)');
    expect(launcher).not.toContain('abcdef0');

    // It lists as installed from npm.
    const list = steptix('server', 'list', '--json');
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.stdout) as { runtimes: Array<{ version: string; source: string; runsHere: boolean }> };
    expect(listed.runtimes).toEqual([expect.objectContaining({ version, source: 'npm', runsHere: true })]);

    // A runtime with a file missing says so and what to do.
    fs.rmSync(path.join(runtimeDir, 'dist', 'cli', 'index.js'));
    const damaged = steptix('list');
    expect(damaged.code).toBe(1);
    expect(damaged.stderr).toContain(`Steptix server ${version} in `);
    expect(damaged.stderr).toContain(`Remove it with steptix server remove ${version} and run the command again.`);

    // Uninstalling removes it and names the second command.
    const removed = steptix('uninstall', '--yes');
    expect(removed.code).toBe(0);
    expect(removed.stdout.trim().split('\n').at(-1)).toBe('To remove the steptix command too, run: npm rm -g steptix');
    expect(fs.existsSync(runtimeDir)).toBe(false);
  });
});
