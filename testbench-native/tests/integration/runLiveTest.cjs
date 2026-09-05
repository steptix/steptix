// Live integration runner. Like runTest.cjs, but:
//  - workspace = ../../templates so .env walk-up from
//    init/tests/securebank.md reaches templates/.env
//  - test entry = tests/integration/live/index.cjs
//  - much longer timeouts; the run actually opens a real browser
//  - boots fixtures/test-app on :8787, the site the browser-driving live
//    suites point at (see startTestApp below)
//
// It runs the suite in PARALLEL by default: N workers, each with its own
// VS Code instance, its own copy of the workspace and its own server, pulling
// one test file at a time off a shared queue. See "Why a shard needs all
// three" below for what forces each of those, and `--shards=1` for the serial
// runner this replaced, kept intact for debugging.
//
// Usage:
//   npm run test:live                    # parallel, 4 shards, own servers
//   npm run test:live -- --shards=6      # more workers
//   npm run test:live -- --shards=1      # serial: one VS Code, one launch
//   npm run test:live -- --server=http://localhost:3103
//                                        # share a server you started
//   TESTBENCH_LIVE_GREP='step cache replay' npm run test:live
//                                        # mocha --grep, as before
//
// Prereq: with --shards=1 or --server=<url>, an ai-ui-automation Sessions API
// server must already be running (e.g. `node dist/index.js serve -p 3100`).
// Otherwise each shard starts its own from this checkout's dist/.
const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');
const { glob } = require('glob');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const {
  copyWorkspace,
  rebaseConfigPaths,
  pointEnvAtServer,
  pickFreePorts,
  probeHealth,
  buildFramework,
  startServer,
  recordServers,
  reapStaleServers,
  readDurations,
  writeDurations,
  scheduleOrder,
  runPool,
} = require('./liveShards.cjs');

const VERSION = '1.95.0';

/** Default worker count. See pickShardCount for why it is not cpus/2. */
const DEFAULT_SHARDS = 4;

/** First port tried when a shard needs a server of its own. */
const SHARD_PORT_BASE = 3200;

// The fixture app's port is baked into each fixture's `## Config` baseUrl
// (and into every tests/integration/*.md in the repo root), so it is pinned
// rather than allocated. That is also why we adopt an already-listening
// server instead of failing on EADDRINUSE: a developer with the app already
// running — or a concurrent live run in another worktree — is serving the
// same static fixture, and two runs sharing it is harmless. It holds no
// per-run state that one run could corrupt for another.
const TEST_APP_PORT = 8787;
const TEST_APP_URL = `http://127.0.0.1:${TEST_APP_PORT}`;

async function isTestAppUp() {
  try {
    const res = await fetch(`${TEST_APP_URL}/api/csrf-token`);
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Start fixtures/test-app unless something is already serving it.
 *
 * Returns a stop() that kills only a server WE spawned — adopting someone
 * else's and then killing it would break the session they were using.
 *
 * One app for every shard, on purpose: the pages are static markup, so the
 * shards contend on nothing. The one exception is the `/api/documents` list
 * behind the Documents page, which no live suite in this directory drives.
 */
async function startTestApp(repoRoot) {
  if (await isTestAppUp()) {
    console.log(`  test app:  already running at ${TEST_APP_URL} (adopted)`);
    return () => {};
  }

  const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');
  if (!fs.existsSync(serverPath)) {
    throw new Error(`fixture test app not found at ${serverPath}`);
  }

  const proc = cp.spawn(process.execPath, ['--import', 'tsx', serverPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(TEST_APP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (b) => process.stderr.write(`[test-app] ${b}`));

  // A spawned child and its stdio pipes each hold a ref on our event loop.
  // Without these unrefs the runner never exits after a PASSING run: the
  // suite finishes, the report is written, and then node sits forever with
  // nothing to do but a live child handle — which also means the
  // process.on('exit') cleanup below never fires, so the app leaks too.
  // Only bites when we spawned the app; an adopted one has no child handle,
  // which is why this hid behind whichever suite ran second.
  proc.unref();
  proc.stderr?.unref();

  // Surface an immediate spawn failure (missing tsx, syntax error) as itself
  // rather than as an opaque 30s readiness timeout.
  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `test app exited before becoming ready (code=${exited.code} signal=${exited.signal})`,
      );
    }
    if (await isTestAppUp()) {
      console.log(`  test app:  started at ${TEST_APP_URL} (pid ${proc.pid})`);
      return () => {
        if (proc.killed || exited) return;
        proc.kill('SIGTERM');
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  proc.kill('SIGKILL');
  throw new Error(`test app did not become ready at ${TEST_APP_URL} within 30s`);
}

/** Everything we started, invoked on every exit path. */
const teardown = [];
function runTeardown() {
  while (teardown.length) {
    const stop = teardown.pop();
    try { stop(); } catch { /* best effort */ }
  }
}
process.on('exit', runTeardown);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { runTeardown(); process.exit(130); });
}

function parseArgs(argv) {
  const opts = { shards: null, server: null, files: null };
  for (const arg of argv) {
    let m;
    if ((m = /^--shards=(\d+)$/.exec(arg))) opts.shards = Number(m[1]);
    else if ((m = /^--server=(.+)$/.exec(arg))) opts.server = m[1].replace(/\/$/, '');
    else if ((m = /^--files=(.+)$/.exec(arg))) opts.files = m[1].split(',').map((s) => s.trim());
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * How many workers.
 *
 * Not derived from cpu count: a shard is a VS Code instance, a node server and
 * a real browser, so the ceiling here is memory and the AI gateway's rate
 * limit rather than cores. Four is what fits comfortably on a 12-core / 32 GB
 * machine alongside an editor; raise it with --shards when the box is idle.
 */
function pickShardCount(opts) {
  const raw = opts.shards ?? process.env.TESTBENCH_LIVE_SHARDS;
  if (raw === undefined || raw === '') return DEFAULT_SHARDS;
  const requested = Number(raw);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`shard count must be a positive integer, got "${raw}"`);
  }
  return requested;
}

/**
 * Launch one VS Code, run `files` in it, and return what the report says.
 *
 * `--user-data-dir` and `--extensions-dir` are per worker and that is
 * load-bearing, not tidiness: a second VS Code sharing a user-data-dir does
 * not start a second instance, it forwards its arguments to the first one and
 * exits — so every shard after the first would report nothing while the first
 * silently ran someone else's files.
 */
function launchVSCode({
  codeExe, cliJs, extensionDevelopmentPath, extensionTestsPath,
  workspacePath, userDataDir, extensionsDir, reportPath, logPath,
  serverUrl, files, inherit,
}) {
  fs.rmSync(reportPath, { force: true });
  fs.rmSync(logPath, { force: true });

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

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TESTBENCH_FIXTURES_DIR: workspacePath,
    TESTBENCH_TEST_REPORT: reportPath,
    TESTBENCH_LIVE_LOG: logPath,
    ELECTRON_ENABLE_LOGGING: '1',
    LIVE_SERVER_URL: serverUrl,
  };
  if (files) env.TESTBENCH_LIVE_FILES = files.join(',');

  return new Promise((resolve) => {
    const chunks = [];
    const proc = cp.spawn(codeExe, args, {
      env,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    if (!inherit) {
      proc.stdout.on('data', (b) => chunks.push(b));
      proc.stderr.on('data', (b) => chunks.push(b));
    }
    proc.on('error', (err) => {
      chunks.push(Buffer.from(`spawn failed: ${err.message}\n`));
      resolve({ status: -1, output: Buffer.concat(chunks).toString('utf8') });
    });
    proc.on('close', (status) => {
      resolve({ status, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/**
 * The report a launch left behind, or a synthetic failure row.
 *
 * A missing report is a FAILURE, not a note: VS Code can exit 0 without ever
 * invoking the test entry (a missing `mocha` dependency does exactly that), so
 * a run that proved nothing must never read as a run where everything passed.
 * The same reasoning covers a report with zero rows — except under --grep,
 * where a file legitimately contributes none.
 */
function collectReport({ reportPath, label, status, grepping }) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    return {
      results: [{
        suite: label,
        title: '(no report written)',
        state: 'fail',
        err:
          `VS Code exited with code ${status} but wrote no suite results ` +
          `to ${reportPath}: ${err.message}`,
      }],
      failures: 1,
    };
  }
  if (report.results.length === 0 && !grepping) {
    return {
      results: [{
        suite: label,
        title: '(zero tests)',
        state: 'fail',
        err: 'The report contains no tests — nothing was verified.',
      }],
      failures: 1,
    };
  }
  return report;
}

/** Discover the live suite's test files, relative to tests/integration/live. */
async function discoverLiveFiles(liveDir, requested) {
  const found = (await glob('**/*.test.cjs', { cwd: liveDir })).sort();
  if (!requested) return found;
  const missing = requested.filter((f) => !found.includes(f));
  if (missing.length) {
    throw new Error(`--files names unknown test file(s): ${missing.join(', ')}`);
  }
  return requested;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const shardCount = pickShardCount(opts);

  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'live', 'index.cjs');
  const liveDir = path.resolve(__dirname, 'live');
  // Workspace = repo's templates/ directory. The fixtures the live suites
  // drive sit in templates/init/tests/, .env sits in templates/. With this
  // workspace the env walkup terminates at templates/ and finds the .env.
  const templatesDir = path.resolve(__dirname, '..', '..', '..', 'templates');
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  // Beside templates/, at the repo root — NOT under testbench-native/. A
  // shard workspace is a stand-in for `<repo>/templates`, and node resolves
  // bare imports by walking up from the file: from `<repo>/templates/...` that
  // walk sees only `<repo>/node_modules`, while from
  // `<repo>/testbench-native/.live-shards/...` it passes through
  // `testbench-native/node_modules` first — a directory full of packages the
  // real workspace cannot see. Same depth question, different answer, and the
  // code a compile emits is bundled from whatever that walk finds.
  const shardRoot = path.resolve(__dirname, '..', '..', '..', '.live-shards');

  if (!fs.existsSync(path.join(templatesDir, '.env'))) {
    console.error(
      `templates/.env not found at ${templatesDir}. The live test ` +
        `requires SERVER_URL, AIUI_SERVER_API_KEY, AI_API_KEY in that file.`,
    );
    process.exit(2);
  }

  const files = await discoverLiveFiles(liveDir, opts.files);
  const grepping = Boolean(process.env.TESTBENCH_LIVE_GREP);

  // Before VS Code, so a fixture-app failure reports as itself rather than
  // as nine browser steps timing out against a dead port.
  teardown.push(await startTestApp(repoRoot));

  const codeExe = await downloadAndUnzipVSCode(VERSION);
  const installRoot = path.dirname(codeExe);
  const cliJs = path.join(installRoot, 'resources', 'app', 'out', 'cli.js');

  const sharedServer = (opts.server || process.env.LIVE_SERVER_URL || '')
    .trim()
    .replace(/\/+$/, '') || null;

  // ─── Serial: exactly the runner this file used to be ──────────────────────
  // One launch, every file, the real templates/ workspace, whatever server is
  // already running. Kept because it is the shape to reach for when a shard
  // fails and you want to watch it happen with the output inherited.
  if (shardCount === 1) {
    const serverUrl = sharedServer || 'http://localhost:3100';
    console.log('Launching live test:', codeExe);
    console.log('  workspace:', templatesDir);
    console.log('  test suite:', extensionTestsPath);
    console.log('  server:', serverUrl);

    const reportPath = path.resolve(__dirname, 'live-test-report.json');
    const logPath = path.resolve(__dirname, 'live-test-output.log');
    const { status } = await launchVSCode({
      codeExe, cliJs, extensionDevelopmentPath, extensionTestsPath,
      workspacePath: templatesDir,
      userDataDir: path.join(installRoot, '..', 'user-data-live'),
      extensionsDir: path.join(installRoot, '..', 'extensions-live'),
      reportPath, logPath, serverUrl,
      files: opts.files ? files : null,
      inherit: true,
    });
    const report = collectReport({ reportPath, label: 'live suite', status, grepping });
    finish([{ file: 'live suite', report, logPath, output: '' }], status);
    return;
  }

  // ─── Parallel ─────────────────────────────────────────────────────────────
  //
  // Why a shard needs all three of a workspace, a VS Code and a server:
  //
  //  - Workspace copy. Five of the compile suites `rmSync` the SAME
  //    `templates/init/tests/.aiui-codebehind-cache`, two of them compile the
  //    same `compile-codebehind.md`, cache-replay wipes the project-wide
  //    `templates/init/.cache`, and templates/.env turns on
  //    APPEND_RUN_HISTORY_TO_TEST_FILE — which rewrites the fixture `.md` a
  //    run just used. Grouping the conflicts into one shard would put the five
  //    slowest suites back on one worker; a copy each removes the question.
  //  - VS Code instance. Per-worker --user-data-dir; see launchVSCode.
  //  - Server. src/utils/logger.ts fans log lines out process-globally, so
  //    concurrent sessions in one server see each other's lines — and one
  //    suite asserts a line is ABSENT from its run log.
  console.log(`Live suite: ${files.length} file(s) across ${shardCount} shard(s)`);

  // Before any port is picked: if this run is going to start the servers, it
  // owns their build. `npm run test:live` compiles testbench-native and stops
  // there, which was right while a human started the server and owned its
  // checkout — and silently wrong the moment the runner started spawning
  // `<repo>/dist/index.js` itself.
  if (!sharedServer) {
    const ms = buildFramework(repoRoot);
    console.log(`  built:     ${path.join(repoRoot, 'dist')} (${(ms / 1000).toFixed(0)}s)`);
  }

  const ports = sharedServer ? [] : await pickFreePorts(shardCount, SHARD_PORT_BASE);
  if (sharedServer) {
    const health = await probeHealth(sharedServer);
    if (!health?.ok) {
      console.error(
        `--server=${sharedServer} is not answering /health. Start it, or drop ` +
          `the flag and let each shard start its own.`,
      );
      process.exit(2);
    }
    console.log(
      `  server:    ${sharedServer} (shared by all shards — note that a shared ` +
        `server interleaves every session's log lines)`,
    );
  }

  const serversFile = path.resolve(__dirname, 'live-servers.json');
  const reaped = await reapStaleServers(serversFile);
  if (reaped > 0) console.log(`  reaped ${reaped} server(s) a previous run left behind`);
  // Pushed before any server, so it pops LAST — the note stays on disk until
  // every kill has been attempted. Dropping it earlier would turn a kill that
  // failed into a leak nothing can find.
  teardown.push(() => fs.rmSync(serversFile, { force: true }));

  fs.rmSync(shardRoot, { recursive: true, force: true });
  const workers = [];
  const servers = [];
  for (let i = 0; i < shardCount; i++) {
    const dir = path.join(shardRoot, `w${i + 1}`);
    const workspacePath = path.join(dir, 'templates');
    fs.mkdirSync(dir, { recursive: true });
    copyWorkspace(templatesDir, workspacePath);
    // Printed once, from the first shard: every shard rebases the same set, and
    // a `!` line here is the earliest place a path that escaped the copy can be
    // seen. Without it the symptom is a WARN in a shard's server log and an
    // assertion failure minutes later in a different file.
    const rebased = rebaseConfigPaths(workspacePath, templatesDir);
    if (i === 0) for (const note of rebased) console.log(`  config:    ${note}`);

    let serverUrl = sharedServer;
    if (!serverUrl) {
      const server = await startServer({
        repoRoot,
        port: ports[i],
        logPath: path.join(dir, 'server.log'),
      });
      teardown.push(server.stop);
      servers.push(server);
      // Written as each one comes up, not after the loop: a Ctrl+Break while
      // shard 3 is still starting must still leave shards 1 and 2 reapable.
      recordServers(serversFile, servers);
      serverUrl = server.url;
      console.log(`  shard ${i + 1}:   server ${serverUrl} (pid ${server.pid})`);
    }
    pointEnvAtServer(path.join(workspacePath, '.env'), serverUrl);

    workers.push({
      index: i + 1,
      workspacePath,
      serverUrl,
      userDataDir: path.join(dir, 'user-data'),
      extensionsDir: path.join(dir, 'extensions'),
      dir,
    });
  }

  // Beside the runner, not inside .live-shards/ — that directory is wiped at
  // the start of every run, and a scheduling memory that forgets each run is
  // the same as no memory at all.
  const durationsFile = path.resolve(__dirname, 'live-durations.json');
  const durations = readDurations(durationsFile);
  const queue = scheduleOrder(files, durations);

  const collected = [];
  const startedAt = Date.now();
  await runPool(workers, queue, async (worker, file) => {
    const safe = file.replace(/[\\/]/g, '_');
    const reportPath = path.join(worker.dir, `report-${safe}.json`);
    const logPath = path.join(worker.dir, `output-${safe}.log`);
    const fileStart = Date.now();
    console.log(`  [shard ${worker.index}] ▶ ${file}`);

    let status;
    let output;
    try {
      ({ status, output } = await launchVSCode({
        codeExe, cliJs, extensionDevelopmentPath, extensionTestsPath,
        workspacePath: worker.workspacePath,
        userDataDir: worker.userDataDir,
        extensionsDir: worker.extensionsDir,
        reportPath, logPath,
        serverUrl: worker.serverUrl,
        files: [file],
        inherit: false,
      }));
    } catch (err) {
      // One file's launch must not take the run down with it. `runPool` is a
      // plain Promise.all, so a throw here would reject the whole pool and
      // discard every result the other shards had already collected — up to
      // sixteen files of real browser and model time, thrown away because one
      // `rmSync` lost a race with a dying VS Code's file handle. Record it as
      // this file's failure and let the queue carry on; the run still fails,
      // it just also reports everything else.
      console.log(`  [shard ${worker.index}] ✗ ${file} (launch failed: ${err.message})`);
      collected.push({
        file,
        report: {
          results: [{
            suite: file,
            title: '(the launch itself failed)',
            state: 'fail',
            err: err instanceof Error ? (err.stack ?? err.message) : String(err),
          }],
          failures: 1,
        },
        logPath,
        output: '',
      });
      return;
    }

    const elapsed = Date.now() - fileStart;
    durations[file] = elapsed;
    const report = collectReport({ reportPath, label: file, status, grepping });
    // Mocha's entry rejects when a test fails, so a non-zero exit normally
    // means the report already says so. A non-zero exit with a CLEAN report is
    // the other thing: the extension host died after writing it. Left
    // unreported that reads as a pass.
    if (status !== 0 && report.failures === 0) {
      report.results.push({
        suite: file,
        title: '(VS Code exited non-zero after a clean report)',
        state: 'fail',
        err: `exit code ${status} — the host crashed or was killed after the suite finished`,
      });
      report.failures += 1;
    }
    const mark = report.failures > 0 ? '✗' : '✓';
    console.log(
      `  [shard ${worker.index}] ${mark} ${file} ` +
        `(${(elapsed / 1000).toFixed(0)}s, ${report.results.length} test(s))`,
    );
    collected.push({ file, report, logPath, output });
  });

  writeDurations(durationsFile, durations);
  console.log(`\nWall clock: ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  // By file, not by finishing order: the merged report is read by a human
  // comparing runs, and an order that depends on which shard happened to be
  // quicker makes two runs of the same suite hard to diff.
  collected.sort((a, b) => a.file.localeCompare(b.file));
  finish(collected, 0);
}

/**
 * Print the merged report, stop everything we started, and exit.
 *
 * The exit is explicit rather than "let the event loop drain": every shard
 * server is a live child handle, and node with nothing to do but a live child
 * handle does not exit — which then means the exit hook that kills those
 * servers never fires either. They are unref'd as well; this is the belt to
 * that pair of braces.
 */
function finish(collected, launchStatus) {
  console.log('\n--- Live test report ---');
  let total = 0;
  let failures = 0;
  let skipped = 0;
  for (const { report } of collected) {
    for (const r of report.results) {
      const tag = r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : 'o';
      console.log(`  ${tag} ${r.suite} > ${r.title}`);
      if (r.state === 'fail' && r.err) console.log(r.err);
      total++;
      if (r.state === 'pending') skipped++;
    }
    failures += report.failures;
  }

  console.log(
    `\n${total} tests, ${failures} failures` +
      // Counted out loud: a skipped scenario is one nobody checked, and a
      // silent one reads as a scenario that passed.
      (skipped > 0 ? `, ${skipped} skipped` : ''),
  );

  if (total === 0) {
    console.error('Live test report contains zero tests — nothing was verified.');
    exitWith(1);
  }
  if (failures > 0) {
    // Only the failing shards' logs, and only on failure: dumping every
    // shard's OutputChannel would bury the one that matters.
    for (const { file, report, logPath, output } of collected) {
      if (report.failures === 0) continue;
      console.error(`\n--- ${file}: TestBench OutputChannel log ---`);
      try {
        console.error(fs.readFileSync(logPath, 'utf8') || '(empty)');
      } catch (err) {
        console.error(`No OutputChannel log captured: ${err.message}`);
      }
      if (output) {
        console.error(`--- ${file}: VS Code stdout/stderr ---`);
        console.error(output);
      }
    }
    console.error(`${failures} live test(s) failed.`);
    exitWith(1);
  }

  if (launchStatus !== 0) {
    console.error('live integration test failed with exit code', launchStatus);
    exitWith(launchStatus ?? 1);
  }

  exitWith(0);
}

function exitWith(code) {
  runTeardown();
  process.exit(code);
}

main().catch((err) => {
  console.error('Failed to run live test', err);
  process.exit(1);
});
