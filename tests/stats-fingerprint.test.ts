/**
 * What a line says about the rules and the build it was written under
 * (docs/specs/SPEC-scoreboard.md §5.5).
 *
 * `buildSystemPrompt` is wrapped in a spy that calls straight through, so the
 * fingerprint is taken from the REAL rules text and the tests can still see
 * how, and how often, it was asked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/ai/prompts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/ai/prompts.js')>();
  return { ...real, buildSystemPrompt: vi.fn(real.buildSystemPrompt) };
});

import { buildSystemPrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { frameworkVersion, gitCommitAt, rulesFingerprint } from '../src/stats/fingerprint.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** A fresh fingerprint module — an empty cache — with the spy's count reset.
 *  (`resetModules` keeps the mocked module, so the spy is the same one.) */
async function fresh() {
  vi.resetModules();
  const prompts = await import('../src/ai/prompts.js');
  const fingerprint = await import('../src/stats/fingerprint.js');
  const build = vi.mocked(prompts.buildSystemPrompt);
  build.mockClear();
  return { build, rulesFingerprint: fingerprint.rulesFingerprint };
}

describe('rulesFingerprint', () => {
  it('is p- and the first 6 hex digits of the SHA-256 of the rules text', () => {
    const rules = contentBlocksToText(buildSystemPrompt('', undefined, {}));
    expect(rulesFingerprint()).toBe(`p-${sha256(rules).slice(0, 6)}`);
    expect(rulesFingerprint()).toMatch(/^p-[0-9a-f]{6}$/);
  });

  it('is stable, and builds the rules once per option set', async () => {
    const { build, rulesFingerprint: fp } = await fresh();
    const first = fp();
    expect(fp()).toBe(first);
    expect(fp({})).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);

    fp({ dismissalGuidance: true });
    fp({ dismissalGuidance: true });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('leaves the project context out: the rules are built with an empty one', async () => {
    const { build, rulesFingerprint: fp } = await fresh();
    fp({ dismissalGuidance: true });
    expect(build).toHaveBeenCalledWith('', undefined, { dismissalGuidance: true });

    // Which is what keeps two projects on the same rules on one fingerprint:
    // the context would move it.
    const withContext = contentBlocksToText(buildSystemPrompt('## Our app\nSign in is at /signin', undefined, {}));
    expect(`p-${sha256(withContext).slice(0, 6)}`).not.toBe(rulesFingerprint());
  });

  it('follows the run options that change the rules', () => {
    // dismissalGuidance adds a rule; false and absent write the same text.
    expect(rulesFingerprint({ dismissalGuidance: true })).not.toBe(rulesFingerprint());
    expect(rulesFingerprint({ dismissalGuidance: false })).toBe(rulesFingerprint());
  });

  it('changes when a rule changes', async () => {
    const real = await vi.importActual<typeof import('../src/ai/prompts.js')>('../src/ai/prompts.js');
    const today = rulesFingerprint();

    const { build, rulesFingerprint: fp } = await fresh();
    build.mockImplementationOnce((context, api, options) => {
      const [first, ...rest] = real.buildSystemPrompt(context, api, options);
      if (first?.type !== 'text') throw new Error('expected the rules block first');
      expect(first.text).toContain('1. Return ONLY valid JSON');
      return [{ ...first, text: first.text.replace('1. Return ONLY valid JSON', '1. Return ONLY valid YAML') }, ...rest];
    });
    expect(fp()).not.toBe(today);
  });
});

describe('gitCommitAt', () => {
  const SHA = 'b7004731f2e0c1d9a8b7c6d5e4f3a2b1c0d9e8f7';
  const OTHER = '0123456789abcdef0123456789abcdef01234567';
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-stats-git-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it('an ordinary checkout: HEAD names a branch with a loose ref', () => {
    write('repo/.git/HEAD', 'ref: refs/heads/main\n');
    write('repo/.git/refs/heads/main', `${SHA}\n`);
    expect(gitCommitAt(path.join(tmp, 'repo'))).toBe('b700473');
  });

  it('a branch that lives only in packed-refs', () => {
    write('repo/.git/HEAD', 'ref: refs/heads/feature/x\n');
    write(
      'repo/.git/packed-refs',
      `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/main\n${SHA} refs/heads/feature/x\n^${OTHER}\n`,
    );
    expect(gitCommitAt(path.join(tmp, 'repo'))).toBe('b700473');
  });

  it('a detached HEAD', () => {
    write('repo/.git/HEAD', `${SHA}\n`);
    expect(gitCommitAt(path.join(tmp, 'repo'))).toBe('b700473');
  });

  it('a worktree: .git is a file, HEAD is its own, the branch is shared through commondir', () => {
    // The main checkout is on another commit; the worktree must not report it.
    write('main/.git/HEAD', 'ref: refs/heads/main\n');
    write('main/.git/refs/heads/main', `${OTHER}\n`);
    write('main/.git/refs/heads/claude/scoreboard', `${SHA}\n`);
    write('main/.git/worktrees/wt/HEAD', 'ref: refs/heads/claude/scoreboard\n');
    write('main/.git/worktrees/wt/commondir', '../..\n');
    // Git writes the gitdir with forward slashes on Windows too.
    write('wt/.git', `gitdir: ${path.join(tmp, 'main/.git/worktrees/wt').replaceAll('\\', '/')}\n`);
    expect(gitCommitAt(path.join(tmp, 'wt'))).toBe('b700473');
    expect(gitCommitAt(path.join(tmp, 'main'))).toBe('0123456');
  });

  it('a relative gitdir resolves against the folder holding the .git file', () => {
    write('main/.git/refs/heads/topic', `${SHA}\n`);
    write('main/.git/worktrees/wt/HEAD', 'ref: refs/heads/topic\n');
    write('main/.git/worktrees/wt/commondir', '../..\n');
    write('wt/.git', 'gitdir: ../main/.git/worktrees/wt\n');
    expect(gitCommitAt(path.join(tmp, 'wt'))).toBe('b700473');
  });

  it('a SHA-256 repository', () => {
    write('repo/.git/HEAD', `${'ab'.repeat(32)}\n`);
    expect(gitCommitAt(path.join(tmp, 'repo'))).toBe('abababa');
  });

  it('undefined — never a guess — when there is nothing to read', () => {
    fs.mkdirSync(path.join(tmp, 'plain'));
    expect(gitCommitAt(path.join(tmp, 'plain'))).toBeUndefined();
    expect(gitCommitAt(path.join(tmp, 'missing'))).toBeUndefined();

    // An unborn branch: HEAD names a ref nobody has written.
    write('unborn/.git/HEAD', 'ref: refs/heads/main\n');
    expect(gitCommitAt(path.join(tmp, 'unborn'))).toBeUndefined();

    write('garbage/.git/HEAD', 'not a ref\n');
    expect(gitCommitAt(path.join(tmp, 'garbage'))).toBeUndefined();

    write('nofile/.git', 'this is not a gitdir line\n');
    expect(gitCommitAt(path.join(tmp, 'nofile'))).toBeUndefined();
  });

  it('asks the folder it is given, never a parent', () => {
    write('repo/.git/HEAD', `${SHA}\n`);
    fs.mkdirSync(path.join(tmp, 'repo/node_modules/steptix'), { recursive: true });
    expect(gitCommitAt(path.join(tmp, 'repo/node_modules/steptix'))).toBeUndefined();
  });
});

describe('frameworkVersion', () => {
  it('is the package version plus the checked-out commit of this checkout', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };
    let head: string | undefined;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    } catch {
      head = undefined; // no git on this machine: the version alone is right
    }
    const expected = head ? `${pkg.version}+${head.slice(0, 7)}` : pkg.version;
    expect(frameworkVersion()).toBe(expected);
    expect(frameworkVersion()).toBe(expected);
  });
});
