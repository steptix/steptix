// Shard plumbing for the live integration suite: everything a parallel run
// needs that is NOT "launch VS Code and read the report".
//
// Split out of runLiveTest.cjs so the orchestration there stays readable, and
// so each piece here (workspace copy, free-port pick, server spawn, duration
// memory) can be reasoned about — and unit-tested — on its own.
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');

/**
 * Paths inside a copied workspace that must NOT come along.
 *
 * `reports/` is 4.7 MB of run history that no test reads (video-recording
 * snapshots the dir first and diffs, so an empty one suits it). The cache and
 * dot-dirs are per-run output — copying a previous run's would hand a shard a
 * warm cache the test believes it cleared. `*.steps.ts` is the sharpest of
 * them: no compiled step file is tracked in this repo, so any that exists is
 * a leftover, and a shard that starts with one would prove nothing when it
 * asserts the compile wrote it.
 */
const WORKSPACE_COPY_SKIP = new Set([
  'reports',
  'node_modules',
  '.cache',
  '.aiui',
  '.aiui-codebehind-cache',
  '.aiui-tool-cache',
  '.testbench',
]);

/**
 * Copy `srcDir` to `destDir`, minus the per-run leftovers above.
 *
 * A copy, not a junction: a shard has to be able to write `.steps.ts` files,
 * clear `.aiui-codebehind-cache`, and let the runner append run history to a
 * fixture `.md` — all of which are the very collisions that stop the current
 * suite running twice at once.
 */
function copyWorkspace(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      if (WORKSPACE_COPY_SKIP.has(base)) return false;
      if (base.endsWith('.steps.ts')) return false;
      return true;
    },
  });
}

/**
 * Config keys whose value is a directory path resolved against the project
 * root — the directory holding that `aiui.config.json`.
 *
 * From schema/aiui.config.schema.json. A key added there and not here is not
 * silently wrong: `rebaseConfigPaths` warns about any other value that starts
 * with `..`, which is the only shape that can escape a copied workspace.
 */
const CONFIG_PATH_KEYS = [
  ['tests', 'dir'],
  ['tests', 'dataDir'],
  ['tests', 'contextDir'],
  ['tests', 'skillsDir'],
  ['tests', 'toolsDir'],
  ['reports', 'outputDir'],
  ['api', 'specsDir'],
  ['cache', 'dir'],
];

/** Every aiui.config.json under `root`, as absolute paths. */
function findConfigs(root, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      findConfigs(abs, found);
    } else if (entry.name === 'aiui.config.json') {
      found.push(abs);
    }
  }
  return found;
}

/** Is `child` at or below `parent`? */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Repair the relative paths a copied workspace's configs inherited.
 *
 * A path that stays inside the workspace (`./tests`, `./reports`) travels with
 * the copy and must stay relative — that is the whole point of copying, and
 * rewriting it would send every shard's reports back to one directory. A path
 * that climbs OUT of it does not travel: `templates/init/aiui.config.json`
 * carries `"toolsDir": "../../fixtures/tools/src"`, which in a copy resolves
 * to a `fixtures/` that was never copied. The server then logs one WARN —
 * `no tools registered` — and carries on, so the run does not fail where the
 * cause is; it fails minutes later in an assertion about compiled code.
 *
 * So: in-tree paths are left alone, out-of-tree ones are pinned to the
 * absolute location they meant in the original. Those targets (tool source, a
 * shared spec cache) are code the shards read, not state they write.
 *
 * Returns a human-readable list of what it changed, plus warnings for any
 * other `..` value it does not know how to interpret.
 */
function rebaseConfigPaths(copyRoot, originalRoot) {
  const notes = [];
  for (const configPath of findConfigs(copyRoot)) {
    const rel = path.relative(copyRoot, configPath);
    const originalDir = path.dirname(path.resolve(originalRoot, rel));
    let config;
    let raw;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(raw);
    } catch (err) {
      notes.push(`! ${rel}: could not be read as JSON (${err.message})`);
      continue;
    }

    let changed = false;
    for (const [section, key] of CONFIG_PATH_KEYS) {
      const value = config?.[section]?.[key];
      if (typeof value !== 'string' || value === '' || path.isAbsolute(value)) continue;
      const target = path.resolve(originalDir, value);
      if (isInside(originalRoot, target)) continue;
      config[section][key] = target;
      changed = true;
      notes.push(`${rel}: ${section}.${key} "${value}" → ${target}`);
    }

    // Anything else that climbs out. Not rewritten — we do not know what it
    // means — but said out loud, because the failure it causes surfaces far
    // from here.
    for (const [section, values] of Object.entries(config ?? {})) {
      if (!values || typeof values !== 'object') continue;
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string' || !/^\.\.[/\\]/.test(value)) continue;
        if (CONFIG_PATH_KEYS.some(([s, k]) => s === section && k === key)) continue;
        notes.push(
          `! ${rel}: ${section}.${key} = "${value}" climbs out of the workspace ` +
            `and is not a key this runner knows to rebase`,
        );
      }
    }

    if (changed) fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  return notes;
}

/**
 * Point a copied workspace's `.env` at `serverUrl`.
 *
 * The extension resolves SERVER_URL by walking up from the test file, so this
 * line — not any flag we pass — is what decides which server a shard drives.
 * Rewritten rather than appended when present, because a later duplicate does
 * not reliably win in every .env parser and "it depends" is not a property a
 * test harness should have.
 */
function pointEnvAtServer(envPath, serverUrl) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`shard workspace has no .env at ${envPath}`);
  }
  const original = fs.readFileSync(envPath, 'utf8');
  const line = `SERVER_URL=${serverUrl}`;
  const rewritten = /^SERVER_URL=.*$/m.test(original)
    ? original.replace(/^SERVER_URL=.*$/m, line)
    : `${original.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(envPath, rewritten, 'utf8');
}

/** Is anything listening on `port` of 127.0.0.1? */
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ port, host: '127.0.0.1' });
    const done = (answer) => {
      probe.destroy();
      resolve(answer);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(400, () => done(false));
  });
}

/**
 * `count` ports from `start` upwards that nothing is listening on.
 *
 * Deliberately not `listen(0)`: an ephemeral port we bind and immediately
 * release is free at the moment we ask and can be taken by anything on the
 * machine before the server we picked it for gets there. Scanning a fixed
 * range upward and handing each port out once gives ports that are at least
 * predictable in a log, and the server itself is the thing that finally claims
 * them — an EADDRINUSE from `serve` is a clear failure, not a silent one.
 */
async function pickFreePorts(count, start) {
  const ports = [];
  for (let port = start; port < start + 500 && ports.length < count; port++) {
    if (!(await portInUse(port))) ports.push(port);
  }
  if (ports.length < count) {
    throw new Error(`could not find ${count} free ports from ${start}`);
  }
  return ports;
}

/**
 * Kill `pid` and everything it started.
 *
 * `/T` matters: a shard server is node started by node, but a browser it
 * launched is a grandchild, and a signal to the parent alone leaves one
 * running. `execSync` goes through cmd.exe, not whatever shell the caller is
 * in — a Git Bash `taskkill /pid` has its `/pid` rewritten to a path.
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      cp.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      return true;
    } catch {
      /* fall through to the signal */
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** GET /health, or null if the server is not there / not ours. */
async function probeHealth(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Start one Sessions API server for a shard and resolve once /health answers.
 *
 * Per shard rather than one shared: `addLogCallback` in src/utils/logger.ts is
 * process-global, so every in-flight session in a server sees every other
 * session's log lines. The suite already has assertions that read the run log
 * and one that asserts a line is ABSENT — which a concurrent run in the same
 * process could satisfy or break by accident. Separate processes make the
 * question not arise, for the price of a node process per shard.
 */
async function startServer({ repoRoot, port, logPath }) {
  const entry = path.join(repoRoot, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      `no server build at ${entry}. Run \`npm run build\` in ${repoRoot}, ` +
        `or pass --server=<url> to share a server you started yourself.`,
    );
  }

  const url = `http://localhost:${port}`;
  const log = fs.createWriteStream(logPath, { flags: 'w' });
  const proc = cp.spawn(
    process.execPath,
    [entry, 'serve', '-p', String(port), '--idle-timeout', '60'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);

  // A spawned child and its stdio pipes each hold a ref on the parent's event
  // loop, and a server does not exit on its own. Without these unrefs the
  // runner sits forever after a PASSING run with nothing to do but a live
  // child handle — which also means the exit hook that stops these servers
  // never fires, so they leak too. Same trap the fixture app documents in
  // runLiveTest.cjs, one process further out.
  proc.unref();
  proc.stdout.unref();
  proc.stderr.unref();

  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `server for ${url} exited before becoming ready ` +
          `(code=${exited.code} signal=${exited.signal}); see ${logPath}`,
      );
    }
    const health = await probeHealth(url);
    if (health?.ok) {
      return {
        url,
        pid: proc.pid,
        port,
        stop: () => {
          if (proc.killed || exited) return;
          killTree(proc.pid);
        },
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  throw new Error(`server did not become ready at ${url} within 60s; see ${logPath}`);
}

/**
 * Note the servers this run owns, so the next run can clean up after a kill.
 *
 * The exit hook stops them on every path this process controls; it does not
 * run when the process is killed outright, which is exactly what happens when
 * a developer hits Ctrl+Break or a CI job times the step out. A shard server
 * left behind holds its port and its browser until its idle timeout an hour
 * later.
 */
function recordServers(file, servers) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(servers.map(({ pid, port }) => ({ pid, port })), null, 2),
      'utf8',
    );
  } catch {
    /* the reaper is a courtesy; never fail a run over it */
  }
}

/**
 * Kill servers a previous run recorded and never got to stop.
 *
 * A recorded pid alone is not evidence — pids are reused, and killing a
 * stranger's process because it inherited a number is far worse than leaking
 * ours. So each one is only killed when the server on its port answers
 * `/health` claiming to BE that pid.
 */
async function reapStaleServers(file) {
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(recorded)) return 0;

  let killed = 0;
  for (const entry of recorded) {
    if (!entry || typeof entry.pid !== 'number' || typeof entry.port !== 'number') continue;
    const health = await probeHealth(`http://localhost:${entry.port}`);
    if (!health?.ok || health.pid !== entry.pid) continue;
    if (killTree(entry.pid)) killed++;
  }
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  return killed;
}

/**
 * Remembered wall-clock per test file, so the next run can start the slow ones
 * first.
 *
 * Longest-processing-time-first is what turns "17 files over 4 workers" from a
 * schedule whose tail is decided by whichever slow file happened to be picked
 * last into one whose tail is a single short file. There is nothing to
 * remember on a first run, which is what UNKNOWN_FIRST below is for.
 */
function readDurations(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDurations(file, durations) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(durations, null, 2), 'utf8');
  } catch {
    /* a scheduling hint is not worth failing a run over */
  }
}

/**
 * Slowest known first; never-seen files ahead of all of them.
 *
 * An unknown file is assumed slow rather than fast on purpose: guessing "fast"
 * and being wrong puts a long file last and every worker waits on it, while
 * guessing "slow" and being wrong costs one worker a short early task.
 */
function scheduleOrder(files, durations) {
  return [...files].sort((a, b) => {
    const da = durations[a];
    const db = durations[b];
    if (da === undefined && db === undefined) return a.localeCompare(b);
    if (da === undefined) return -1;
    if (db === undefined) return 1;
    return db - da;
  });
}

/**
 * Run `task` over `items` with at most `workers.length` in flight, handing each
 * worker the next item as it frees up.
 *
 * Pull, not a pre-computed split: file durations here range from seconds to
 * minutes, so any static assignment made before the run is a guess, and a
 * worker that drew three short files sits idle while another grinds through
 * three long ones.
 */
async function runPool(workers, items, task) {
  const queue = [...items];
  await Promise.all(
    workers.map(async (worker) => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await task(worker, item);
      }
    }),
  );
}

module.exports = {
  WORKSPACE_COPY_SKIP,
  copyWorkspace,
  rebaseConfigPaths,
  pointEnvAtServer,
  portInUse,
  pickFreePorts,
  probeHealth,
  killTree,
  startServer,
  recordServers,
  reapStaleServers,
  readDurations,
  writeDurations,
  scheduleOrder,
  runPool,
};
