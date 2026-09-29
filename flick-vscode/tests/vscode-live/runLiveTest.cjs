// Live integration harness for flick-vscode.
//
// Spins up everything end-to-end with real tokens:
//   1. fixtures/test-app/server.ts on http://localhost:8787 (the target site)
//   2. steptix Sessions API server on http://localhost:3100
//      (real `serve` subcommand, loading templates/.env for AI_API_KEY etc.)
//   3. VS Code with the flick-vscode extension under @vscode/test-electron
//   4. A Mocha suite that drives Flick to submit a real step batch and
//      verifies the result lands as a passed history entry.
//
// Tears down both servers on exit (success or failure).
//
// Required (from templates/.env, picked up by this bootstrap and forwarded):
//   AI_API_KEY        - real model credentials, tokens will be spent
//   STEPTIX_SERVER_API_KEY    - shared secret between Flick and the API server
//
// Run via:  npm run test:vscode-live
const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const VERSION = '1.95.0';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_APP_PORT = 8787;
const API_PORT = 3100;

/** Tiny .env reader — avoids dragging dotenv into the harness. */
function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** One-shot HTTP probe. Resolves true if anything answers within 1.5s. */
async function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Resolve once an HTTP GET to `url` returns any 2xx/4xx (server is up). */
async function waitForServer(url, label, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not become reachable at ${url} within ${timeoutMs}ms`);
}

/**
 * Kill whatever process is currently LISTENING on `port`. The live harness
 * owns both ports for the duration of the run — reusing whatever happens to
 * already be there risks testing against stale code (e.g. an
 * `npm run dev` session the developer started before editing).
 *
 * Returns once the port is free or we've given up. Idempotent: a no-op when
 * nothing is listening.
 */
function killListenerOnPort(port) {
  if (process.platform !== 'win32') {
    // POSIX one-liner: lsof + xargs kill -9.
    try {
      cp.execSync(`fuser -k ${port}/tcp || true`, { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    return;
  }
  // Windows: netstat -ano to find the listening PID(s), then taskkill /T /F
  // (tree-kill so tsx's node child dies too).
  let out;
  try {
    out = cp.execSync(`netstat -ano -p TCP`, { encoding: 'utf8' });
  } catch {
    return;
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    // ` TCP  0.0.0.0:8787  0.0.0.0:0  LISTENING  12345`
    if (!/\bLISTENING\b/.test(line)) continue;
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && Number(m[1]) === port) pids.add(m[2]);
  }
  for (const pid of pids) {
    try {
      cp.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* ignore — pid may have exited between netstat and taskkill */
    }
  }
}

/** Block until probe(url) returns false, or throw after timeoutMs. */
async function waitForPortFree(url, label, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await probe(url))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label} is still bound after kill within ${timeoutMs}ms`);
}

async function main() {
  const envFile = path.join(REPO_ROOT, 'templates', '.env');
  const env = loadEnvFile(envFile);
  if (!env.AI_API_KEY || !env.STEPTIX_SERVER_API_KEY) {
    console.error(
      `Required env not found at ${envFile}.\n` +
        '  Need AI_API_KEY and STEPTIX_SERVER_API_KEY. (The live test makes real AI calls.)',
    );
    process.exit(2);
  }

  const processes = [];
  const cleanup = () => {
    for (const proc of processes) {
      try {
        if (proc.pid && !proc.killed) {
          // tree-kill via taskkill on Windows so child processes (tsx → node) die too
          if (process.platform === 'win32') {
            try { cp.execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
          } else {
            proc.kill('SIGTERM');
          }
        }
      } catch {
        /* ignore */
      }
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  try {
    // ── 1. test-app server ────────────────────────────────────────────────
    // ALWAYS kill anything currently on the port before spawning, so the
    // live run can never accidentally test against a stale process the
    // developer started before editing the code. shell:true is required on
    // Windows so npx's .cmd shim resolves (raw spawn of npx.cmd → EINVAL).
    if (await probe(`http://localhost:${TEST_APP_PORT}/`)) {
      console.log(`Killing existing process on :${TEST_APP_PORT}…`);
      killListenerOnPort(TEST_APP_PORT);
      await waitForPortFree(`http://localhost:${TEST_APP_PORT}/`, `:${TEST_APP_PORT}`);
    }
    console.log(`Starting fixtures/test-app on http://localhost:${TEST_APP_PORT}…`);
    const testApp = cp.spawn('npx tsx fixtures/test-app/server.ts', [], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(TEST_APP_PORT) },
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true,
    });
    processes.push(testApp);
    await waitForServer(`http://localhost:${TEST_APP_PORT}/`, 'test-app');

    // ── 2. Sessions API server ────────────────────────────────────────────
    if (await probe(`http://localhost:${API_PORT}/sessions`)) {
      console.log(`Killing existing process on :${API_PORT}…`);
      killListenerOnPort(API_PORT);
      await waitForPortFree(`http://localhost:${API_PORT}/sessions`, `:${API_PORT}`);
    }
    console.log(`Starting Sessions API server on http://localhost:${API_PORT}…`);
    const apiServer = cp.spawn('npx tsx src/index.ts serve', [], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AI_API_KEY: env.AI_API_KEY,
        STEPTIX_SERVER_API_KEY: env.STEPTIX_SERVER_API_KEY,
        AI_MODEL: env.AI_MODEL || process.env.AI_MODEL || '',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true,
    });
    processes.push(apiServer);
    await waitForServer(`http://localhost:${API_PORT}/sessions`, 'Sessions API');

    // ── 3. VS Code with the live Mocha suite ──────────────────────────────
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.cjs');
    const workspacePath = path.resolve(__dirname, 'fixtures');

    const codeExe = await downloadAndUnzipVSCode(VERSION);
    const installRoot = path.dirname(codeExe);
    const userDataDir = path.join(installRoot, '..', 'user-data-live-flick');
    const extensionsDir = path.join(installRoot, '..', 'extensions-live-flick');
    const cliJs = path.join(installRoot, 'resources', 'app', 'out', 'cli.js');

    const args = [
      cliJs,
      '--wait',
      workspacePath,
      '--extensionDevelopmentPath=' + extensionDevelopmentPath,
      '--extensionTestsPath=' + extensionTestsPath,
      '--user-data-dir=' + userDataDir,
      '--extensions-dir=' + extensionsDir,
      '--disable-workspace-trust',
    ];

    console.log('\nLaunching VS Code for live Flick test…');
    const reportPath = path.resolve(__dirname, 'live-test-report.json');
    try { fs.rmSync(reportPath, { force: true }); } catch { /* ignore */ }

    const result = cp.spawnSync(codeExe, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        FLICK_TEST_REPORT: reportPath,
        FLICK_LIVE_API_URL: `http://127.0.0.1:${API_PORT}`,
        FLICK_LIVE_API_KEY: env.STEPTIX_SERVER_API_KEY,
        FLICK_LIVE_TEST_APP_URL: `http://localhost:${TEST_APP_PORT}`,
      },
    });

    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      console.log('\n--- Live test report ---');
      for (const r of report.results) {
        const tag = r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : 'o';
        console.log(`  ${tag} ${r.suite} > ${r.title}`);
        if (r.state === 'fail' && r.err) console.log(r.err);
      }
      console.log(`\n${report.results.length} tests, ${report.failures} failures`);
    } catch (err) {
      console.error('No live test report written:', err.message);
    }

    if (result.status !== 0) {
      console.error('live tests failed with exit code', result.status);
      process.exit(result.status ?? 1);
    }
  } catch (err) {
    console.error('Live test harness failed:', err.message ?? err);
    process.exit(1);
  } finally {
    cleanup();
  }
}

main();
