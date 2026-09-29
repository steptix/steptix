/**
 * The server-side project walk (src/server/project-root.ts), and specifically
 * its user-root boundary (stories/mcp-no-project.md).
 *
 * A project-less MCP run anchors its synthetic test path inside the user root,
 * whose `steptix.config.json` legitimately may not exist. Without the boundary
 * the walk continues into `%LOCALAPPDATA%` and the home directory, and any
 * stray config file up there silently becomes the "project" whose `.env` and
 * report directory the run uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveProjectRoot } from '../src/server/project-root.js';

const created: string[] = [];
const originalEnv = { ...process.env };

function makeTmp(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'steptix-proot-')));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  const tmp = makeTmp();
  process.env['LOCALAPPDATA'] = tmp;
  process.env['XDG_CONFIG_HOME'] = tmp;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userRoot(): string {
  return path.join(process.env['LOCALAPPDATA']!, 'steptix');
}

describe('resolveProjectRoot', () => {
  it('finds a marker by walking up, as before', async () => {
    const proj = makeTmp();
    writeFileSync(path.join(proj, 'steptix.config.json'), '{}');
    mkdirSync(path.join(proj, 'tests'), { recursive: true });

    expect(await resolveProjectRoot(path.join(proj, 'tests', 'x.md'))).toBe(proj);
  });

  it('stops AT the user root when no marker exists inside it', async () => {
    // The stray-config trap: a marker one level ABOVE the user root (in
    // LOCALAPPDATA itself) must never be adopted.
    writeFileSync(path.join(path.dirname(userRoot()), 'steptix.config.json'), '{}');
    mkdirSync(userRoot(), { recursive: true });

    const anchored = path.join(userRoot(), '.steptix-mcp-steps.md');
    expect(await resolveProjectRoot(anchored)).toBe(userRoot());
  });

  it('a marker inside the user root still wins normally', async () => {
    mkdirSync(userRoot(), { recursive: true });
    writeFileSync(path.join(userRoot(), 'steptix.config.json'), '{}');

    const anchored = path.join(userRoot(), '.steptix-mcp-steps.md');
    expect(await resolveProjectRoot(anchored)).toBe(userRoot());
  });

  it('a file outside the user root never triggers the boundary', async () => {
    // No marker anywhere above this tmp file (up to the fs root) — apart from
    // machines that happen to have one, which the walk has always honoured.
    // The pin here is narrower: the user-root boundary must not fire for a
    // path that is not under it, so the walk proceeds past LOCALAPPDATA's
    // sibling levels exactly as before.
    const elsewhere = makeTmp();
    mkdirSync(path.join(elsewhere, 'deep'), { recursive: true });
    writeFileSync(path.join(elsewhere, 'steptix.config.json'), '{}');

    expect(await resolveProjectRoot(path.join(elsewhere, 'deep', 'x.md'))).toBe(elsewhere);
  });
});
