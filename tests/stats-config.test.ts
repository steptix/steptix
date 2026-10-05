/**
 * The project's scoreboard switch, typed at load (docs/specs/SPEC-scoreboard.md
 * §6.4): `"stats": { "enabled": false }` keeps a project's step text off the
 * machine, so a value that is not the JSON boolean must fail loudly rather
 * than be read as "record". Before this, `"false"`, `0`, `"off"` and
 * `"stats": false` all kept recording, because the store reads the switch as
 * `!== false`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/loader.js';

const dirs: string[] = [];

function projectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-stats-config-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'steptix.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('loadConfig — the stats section', () => {
  it('reads the JSON boolean either way, and an absent section or key', async () => {
    expect((await loadConfig(undefined, projectWith({ stats: { enabled: false } }))).stats).toEqual({ enabled: false });
    expect((await loadConfig(undefined, projectWith({ stats: { enabled: true } }))).stats).toEqual({ enabled: true });
    expect((await loadConfig(undefined, projectWith({ stats: {} }))).stats).toEqual({});
    expect((await loadConfig(undefined, projectWith({}))).stats).toBeUndefined();
    // And through an explicit path, the form `--config <file>` takes.
    const explicit = path.join(projectWith({ stats: { enabled: false } }), 'steptix.config.json');
    expect((await loadConfig(explicit)).stats).toEqual({ enabled: false });
  });

  it.each([
    ['the string "false"', { enabled: 'false' }, /stats\.enabled.*the string "false"/],
    ['the number 0', { enabled: 0 }, /stats\.enabled.*the number 0/],
    ['the string "off"', { enabled: 'off' }, /stats\.enabled.*the string "off"/],
    ['null', { enabled: null }, /stats\.enabled.*null/],
  ])('refuses stats.enabled as %s, naming the file and the key', async (_label, stats, message) => {
    const dir = projectWith({ stats });
    await expect(loadConfig(undefined, dir)).rejects.toThrow(message);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(path.join(dir, 'steptix.config.json'));
  });

  it.each([
    ['false', false],
    ['"off"', 'off'],
    ['an array', []],
  ])('refuses "stats": %s — the section must be an object — and says what to write instead', async (_label, stats) => {
    const dir = projectWith({ stats });
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/Invalid "stats".*expected an object/);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/"stats": \{ "enabled": false \}/);
  });
});
