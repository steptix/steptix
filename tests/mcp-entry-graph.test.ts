import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// `aiui mcp` deliberately bypasses the commander program, and this is the test
// that says whether the bypass still works.
//
// It pays for itself twice. Startup: the CLI graph reaches playwright,
// playwright-extra and the stealth plugin through a chain of static value
// imports, roughly a second of load time on every MCP start. And stdout
// hygiene: on a stdio transport stdout is the JSON-RPC channel, so every
// module that could print at import time is a way for the connection to die.
//
// Run against dist/ rather than through vitest's module graph on purpose —
// hosts execute dist/, vitest's transformed graph is a different artefact, and
// the regression this guards (someone registering `mcp` inside createCli, or
// adding a static import to src/index.ts) would be invisible in the latter.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');
const probe = pathToFileURL(
  path.join(repoRoot, 'tests', 'fixtures', 'mcp', 'graph-probe.mjs'),
).href;

interface ProbeResult {
  cjs: number;
  browsery: number;
  stdout: string;
  code: number | null;
}

function runWithProbe(args: string[]): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', probe, distEntry, ...args], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

    // Closing stdin is how a host says "we're done"; the mcp branch waits on
    // it, so this also proves the process actually exits rather than hanging.
    child.stdin.end();

    child.on('error', reject);
    child.on('close', (code) => {
      const match = /__GRAPH_PROBE__ (\{.*\})/.exec(stderr);
      if (!match?.[1]) {
        reject(new Error(`probe did not report. stderr was:\n${stderr}`));
        return;
      }
      const parsed = JSON.parse(match[1]) as { cjs: number; browsery: number };
      resolve({ ...parsed, stdout, code });
    });
  });
}

// dist/ is gitignored, so a fresh clone has none until `npm run build`.
const built = existsSync(distEntry);

describe.skipIf(!built)('aiui mcp module graph (dist)', () => {
  it('loads no browser stack, and exits when stdin closes', async () => {
    const result = await runWithProbe(['mcp']);

    expect(result.browsery).toBe(0);
    expect(result.code).toBe(0);
  }, 60_000);

  it('writes nothing to stdout that is not protocol', async () => {
    // With no client speaking to it, a correct server emits zero bytes. Any
    // banner, spinner or log line here would corrupt the first real frame.
    const result = await runWithProbe(['mcp']);

    expect(result.stdout).toBe('');
  }, 60_000);

  it('prints usage on stderr for --help without starting a server', async () => {
    const result = await runWithProbe(['mcp', '--help']);

    expect(result.stdout).toBe('');
    expect(result.code).toBe(0);
    // The help path should not even reach the SDK.
    expect(result.cjs).toBe(0);
  }, 60_000);

  it('CONTROL: the CLI path does load the browser stack', async () => {
    // Without this the first assertion would pass for the trivial reason that
    // the probe never detects anything. `list --help` is chosen because it
    // exits on its own and touches no browser at runtime — the point is that
    // merely *building* the commander program drags playwright in.
    const result = await runWithProbe(['list', '--help']);

    expect(result.browsery).toBeGreaterThan(0);
  }, 60_000);
});
