/**
 * Several processes appending to one month file at once — Steptix's server,
 * a CLI run, four live-suite servers — leave a file in which every line parses
 * (docs/specs/SPEC-scoreboard.md §6.2, acceptance 6, here in seconds rather
 * than a minute).
 *
 * Real child processes running the real `appendStatsLines`, released together
 * at one instant so their appends overlap, with lines from a couple of hundred
 * bytes up to nearly the 4 KB cap so big writes race small ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStatsLines, statsDir } from '../src/stats/store.js';
import type { UserRootDeps } from '../src/env/user-root.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKERS = 4;
const PER_WORKER = 300;

/** Plain ESM; `--import tsx` lets it load the TypeScript store. */
const WORKER = `
const [storeUrl, root, id, count, goAt] = process.argv.slice(2);
const { appendStatsLines, flushStatsWrites } = await import(storeUrl);
const deps = { env: { LOCALAPPDATA: root, XDG_CONFIG_HOME: root } };
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(goAt) - Date.now())));
for (let i = 0; i < Number(count); i++) {
  appendStatsLines([{
    v: 1, kind: 'run', t: new Date().toISOString(), run: 'w' + id + '-' + i,
    project: 'p', test: null, suite: 'live', status: 'passed',
    steps: 1, firstTry: 1, failed: 0,
    report: 'x'.repeat((i * 397) % 3700),
  }], deps);
}
await flushStatsWrites();
`;

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-stats-concurrency-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runWorker(worker: string, id: number, goAt: number): Promise<void> {
  const storeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'stats', 'store.ts')).href;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', worker, storeUrl, tmp, String(id), String(PER_WORKER), String(goAt)],
      { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${id} exited with ${code}: ${stderr}`));
    });
  });
}

describe('appends from several processes at once', () => {
  it('interleave only whole lines, and each process keeps its own order', async () => {
    const worker = path.join(tmp, 'worker.mjs');
    fs.writeFileSync(worker, WORKER);
    // Released together once every child has had time to start.
    const goAt = Date.now() + 2000;
    await Promise.all(Array.from({ length: WORKERS }, (_, n) => runWorker(worker, n + 1, goAt)));

    const deps: UserRootDeps = { env: { LOCALAPPDATA: tmp, XDG_CONFIG_HOME: tmp }, platform: process.platform };
    const dir = statsDir(deps);
    const seen: string[] = [];
    for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'))) {
      const raw = fs.readFileSync(path.join(dir, name), 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      for (const text of raw.split('\n').slice(0, -1)) {
        seen.push((JSON.parse(text) as { run: string }).run); // throws on a torn line
      }
    }
    expect(seen).toHaveLength(WORKERS * PER_WORKER);
    expect(new Set(seen).size).toBe(WORKERS * PER_WORKER);

    // The processes really did overlap: lines from different workers alternate,
    // rather than arriving as four solid blocks (three switches). Measured on
    // the machine this was written on: ~1190 switches in 1200 lines.
    const switches = seen.filter((run, i) => i > 0 && run.split('-')[0] !== seen[i - 1]!.split('-')[0]).length;
    expect(switches).toBeGreaterThanOrEqual(WORKERS * 10);

    for (let id = 1; id <= WORKERS; id++) {
      const order = seen.filter((run) => run.startsWith(`w${id}-`)).map((run) => Number(run.split('-')[1]));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }

    const { lines, skipped } = await readStatsLines({ deps });
    expect(skipped).toBe(0);
    expect(lines).toHaveLength(WORKERS * PER_WORKER);
  }, 60_000);
});
