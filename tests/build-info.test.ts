/**
 * The build stamp: `scripts/build-info.mjs` writes which commit `dist/` was
 * built from and whether the tree was modified; `src/utils/version.ts` reads it
 * back and words it for people.
 *
 * The script is run for real against throwaway git repositories, since what it
 * has to get right is git's answer, not a parse of it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeVersion, getBuildInfo, parseBuildInfo } from '../src/utils/version.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-info.mjs');

describe('describeVersion', () => {
  it('the version, then the commit in brackets', () => {
    expect(describeVersion({ version: '1.0.0-beta.1', commit: 'b700473', modified: false })).toBe(
      '1.0.0-beta.1 (b700473)',
    );
  });

  it('modified after the commit when the build held uncommitted changes', () => {
    expect(describeVersion({ version: '1.0.0-beta.1', commit: 'b700473', modified: true })).toBe(
      '1.0.0-beta.1 (b700473, modified)',
    );
  });

  it('the version alone when the commit is unknown or not reported', () => {
    expect(describeVersion({ version: '1.0.0-beta.1', commit: null, modified: null })).toBe('1.0.0-beta.1');
    // A /health body from a server predating the fields.
    expect(describeVersion({ version: '1.0.0-beta.1' })).toBe('1.0.0-beta.1');
  });
});

describe('parseBuildInfo', () => {
  it('passes a well-formed stamp through', () => {
    expect(parseBuildInfo({ commit: 'b700473', modified: true })).toEqual({ commit: 'b700473', modified: true });
  });

  it('anything malformed is unknown, never a guess', () => {
    expect(parseBuildInfo(null)).toEqual({ commit: null, modified: null });
    expect(parseBuildInfo('b700473')).toEqual({ commit: null, modified: null });
    expect(parseBuildInfo({ commit: 'not-a-sha', modified: false })).toEqual({ commit: null, modified: null });
    expect(parseBuildInfo({ commit: 'b700473', modified: 'yes' })).toEqual({ commit: 'b700473', modified: null });
  });

  it('modified without a commit says nothing', () => {
    expect(parseBuildInfo({ commit: null, modified: true })).toEqual({ commit: null, modified: null });
  });
});

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

describe.runIf(hasGit)('scripts/build-info.mjs', () => {
  let tmp: string;
  /** An empty home for git, outside `tmp` (itself a repository here). */
  let gitHome: string;
  /**
   * Every git in this block — the helper's and the script's — runs with no
   * system config and an empty global one, so this machine's own never reaches
   * these throwaway repositories: a global hook (git-secrets, a corporate
   * pre-commit) can fail or prompt on the commit, and a global
   * `status.showUntrackedFiles=no` or excludes file would hide the untracked
   * file the script is asked about. `GIT_CONFIG_GLOBAL` needs git 2.32; an
   * older git reads the global file from `HOME` (and `XDG_CONFIG_HOME`).
   */
  let gitEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-build-info-')));
    gitHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-build-info-home-')));
    fs.writeFileSync(path.join(gitHome, '.gitconfig'), '');
    fs.mkdirSync(path.join(gitHome, 'hooks'));
    gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(gitHome, '.gitconfig'),
      HOME: gitHome,
      XDG_CONFIG_HOME: gitHome,
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(gitHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync(
      'git',
      [
        '-c', 'user.name=t',
        '-c', 'user.email=t@t',
        '-c', 'commit.gpgsign=false',
        // Belt and braces over the isolated config: no hooks, no template.
        '-c', `core.hooksPath=${path.join(gitHome, 'hooks')}`,
        '-c', 'init.templateDir=',
        ...args,
      ],
      { cwd, encoding: 'utf-8', env: gitEnv },
    ).trim();
  }

  /** A package root holding a copy of the script, as `scripts/build-info.mjs`. */
  function packageAt(root: string): void {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'build-info.mjs'));
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');
  }

  function stamp(root: string): unknown {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build-info.mjs')], { stdio: 'ignore', env: gitEnv });
    return JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf-8'));
  }

  function committedRepo(root: string): string {
    packageAt(root);
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    return git(root, 'rev-parse', 'HEAD').slice(0, 7);
  }

  it('a clean checkout: its commit, not modified — and dist/ itself does not count', () => {
    const head = committedRepo(tmp);
    stamp(tmp); // dist/ now exists; gitignored, as in the real repo
    expect(stamp(tmp)).toEqual({ commit: head, modified: false });
  });

  it('a changed tracked file marks it modified', () => {
    const head = committedRepo(tmp);
    fs.appendFileSync(path.join(tmp, '.gitignore'), 'reports/\n');
    expect(stamp(tmp)).toEqual({ commit: head, modified: true });
  });

  it('an untracked file marks it modified: a new source file is in what was compiled', () => {
    const head = committedRepo(tmp);
    fs.writeFileSync(path.join(tmp, 'new.ts'), 'export {};\n');
    expect(stamp(tmp)).toEqual({ commit: head, modified: true });
  });

  it("unknown inside someone else's repository: never THEIR commit", () => {
    git(tmp, 'init', '-q');
    fs.writeFileSync(path.join(tmp, 'theirs.txt'), 'x');
    git(tmp, 'add', '.');
    git(tmp, 'commit', '-q', '-m', 'theirs');
    const pkg = path.join(tmp, 'node_modules', 'steptix');
    packageAt(pkg);
    expect(stamp(pkg)).toEqual({ commit: null, modified: null });
  });

  it('unknown outside any checkout', () => {
    packageAt(tmp);
    // GIT_CEILING_DIRECTORIES stops git walking up past tmp into whatever
    // repository the machine's temp folder happens to sit in.
    execFileSync(process.execPath, [path.join(tmp, 'scripts', 'build-info.mjs')], {
      stdio: 'ignore',
      env: { ...gitEnv, GIT_CEILING_DIRECTORIES: path.dirname(tmp) },
    });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'build-info.json'), 'utf-8'))).toEqual({
      commit: null,
      modified: null,
    });
  });
});

describe('getBuildInfo', () => {
  it('from src/ (npm run dev, or vitest as here) is unknown: the stamp names a different build', () => {
    expect(getBuildInfo()).toEqual({ commit: null, modified: null });
  });

  it('from dist/ is the stamp the build wrote beside it', async () => {
    const built = (await import(
      pathToFileURL(path.join(REPO_ROOT, 'dist', 'utils', 'version.js')).href
    )) as typeof import('../src/utils/version.js');
    const stamp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'dist', 'build-info.json'), 'utf-8'));
    expect(built.getBuildInfo()).toEqual(parseBuildInfo(stamp));
  });

  it.runIf(hasGit)('end to end: the built CLI names the commit `pretest` just built from', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'dist', 'index.js'), '--version'], {
      encoding: 'utf-8',
    }).trim();
    const commit = head.slice(0, 7);
    expect([`${pkg.version} (${commit})`, `${pkg.version} (${commit}, modified)`]).toContain(out);
  });
});
