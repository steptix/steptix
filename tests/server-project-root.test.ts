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
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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
    // The user root's NEIGHBOUR is the path a sloppy boundary misfires on:
    // `<LOCALAPPDATA>/steptix-other` starts with `<LOCALAPPDATA>/steptix` as a
    // string, so a prefix check (rather than a whole-directory comparison)
    // would stop the walk there and return a root with no marker in it. The
    // marker sits one level further up, in LOCALAPPDATA itself, so only a walk
    // that carries on past the neighbour finds it.
    const localAppData = path.dirname(userRoot());
    const neighbour = path.join(localAppData, `${path.basename(userRoot())}-other`);
    mkdirSync(path.join(neighbour, 'deep'), { recursive: true });
    writeFileSync(path.join(localAppData, 'steptix.config.json'), '{}');

    expect(await resolveProjectRoot(path.join(neighbour, 'deep', 'x.md'))).toBe(localAppData);
  });
});
