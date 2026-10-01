/**
 * What a line says about the rules and the build it was written under
 * (docs/specs/SPEC-scoreboard.md §5.5).
 *
 * `buildSystemPrompt` is wrapped in a spy that calls straight through, so the
 * fingerprint is taken from the REAL rules text and the tests can still see
 * how, and how often, it was asked.
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

vi.mock('../src/ai/prompts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/ai/prompts.js')>();
  return { ...real, buildSystemPrompt: vi.fn(real.buildSystemPrompt) };
});

import { buildSystemPrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { frameworkVersion, rulesFingerprint } from '../src/stats/fingerprint.js';

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

describe('frameworkVersion', () => {
  const pkg = () =>
    (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;

  it('from src/ (as here, under vitest) is the version alone: no build to name', () => {
    expect(frameworkVersion()).toBe(pkg());
    expect(frameworkVersion()).toBe(pkg());
  });

  it('from dist/ is the version plus the commit it was built from (pretest builds at HEAD)', async () => {
    let head: string | undefined;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    } catch {
      head = undefined; // no git on this machine: the version alone is right
    }
    const built = (await import(
      pathToFileURL(path.join(REPO_ROOT, 'dist', 'stats', 'fingerprint.js')).href
    )) as typeof import('../src/stats/fingerprint.js');
    expect(built.frameworkVersion()).toBe(head ? `${pkg()}+${head.slice(0, 7)}` : pkg());
  });
});
