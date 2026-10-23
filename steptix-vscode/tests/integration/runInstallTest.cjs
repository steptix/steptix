// The install test: the `steptix` package and the VS Code extension,
// installed and run the way a user's would be (docs/specs/SPEC-install.md
// §4–§7, §10.1). The release test (scripts/release-test.mjs) runs it on the
// exact files a release publishes.
//
//   npm run test:install                       (from steptix-vscode/)
//   npm run test:install -- --scenarios=fresh,updates
//
// It runs scenarios, each on a machine of its own, all under one temporary
// folder. A machine is:
//
//  - a private npm registry (tests/npm-test-registry.cjs) serving the
//    package, and any other versions of it the scenario publishes;
//  - a Steptix folder (LOCALAPPDATA / XDG_CONFIG_HOME) whose machine .env
//    names a free port, so no server of yours is touched;
//  - an npm config pointing at that registry, and an npm prefix whose bin
//    is on PATH, for a scenario that installs `steptix` with npm;
//  - a PATH with no `steptix`, and Node.js on it only when the scenario says;
//  - a VS Code of its own (user-data and extensions folders), launched one
//    or more times on the same machine, each time running one of the files
//    in tests/integration/install/ inside the extension.
//
// STEPTIX_INSTALL_TEST_TARBALL names the npm package to test (default: this
// checkout, packed), STEPTIX_INSTALL_TEST_VSIX the extension (default: this
// checkout, packaged), and STEPTIX_INSTALL_TEST_OFFLINE_FILE the offline file
// for this platform (the offline scenario is skipped without one).
//
// It needs the network (npmjs.org through the registries, nodejs.org) and a
// desktop session, and takes a while. A scenario that passed removes its
// machine; one that failed is left for diagnosis, and the folder is printed.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
// The server takes its port as a flag, so it cannot bind 0 and report back:
// the one case freeFetchablePort is for.
const { freeFetchablePort } = require('../../../tests/listen-fetchable.cjs');
const { startTestRegistry } = require('../../../tests/npm-test-registry.cjs');
const { packageVersionOf, removeTree, repackAs, unpackVsix } = require('../../../tests/release-files.cjs');

/** Pinned with the other runners. */
const VSCODE_VERSION = '1.95.0';
const LAUNCH_TIMEOUT_MS = 30 * 60_000;
const win = process.platform === 'win32';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const extensionRoot = path.resolve(__dirname, '..', '..');

function run(command, args, opts = {}) {
  const result = cp.spawnSync(command, args, { encoding: 'utf8', shell: win, ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** PATH without any folder that holds node or steptix. */
function pathWithoutNode(value) {
  const names = win ? ['node.exe', 'steptix.cmd', 'steptix.exe'] : ['node', 'steptix'];
  return value
    .split(path.delimiter)
    .filter((dir) => dir && !names.some((n) => fs.existsSync(path.join(dir, n))))
    .join(path.delimiter);
}

/**
 * The test harness, copied inside an unpacked extension so it runs as part of
 * it. VS Code hands each extension its own `vscode` API object, chosen by
 * where the calling file lives, so a test outside the extension's folder
 * would stub the message boxes of an object the extension never sees.
 *
 * The harness's own packages (mocha, glob) come from this checkout through a
 * `tests/node_modules` link. Nothing the extension loads resolves through
 * `tests/`, so the extension still runs exactly as it was packed.
 */
function harnessInside(extensionPath) {
  const target = path.join(extensionPath, 'tests', 'integration');
  for (const dir of ['live', 'install', 'fakes']) {
    fs.cpSync(path.join(__dirname, dir), path.join(target, dir), { recursive: true });
  }
  fs.symlinkSync(path.join(extensionRoot, 'node_modules'), path.join(extensionPath, 'tests', 'node_modules'), 'junction');
  return path.join(target, 'live');
}

/** `X.Y.Z` with one field moved. */
function bump(version, field, by = 1) {
  const parts = version.split('.').map(Number);
  parts[field] += by;
  for (let i = field + 1; i < 3; i++) parts[i] = 0;
  return parts.join('.');
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------
//
// `nodeOnPath` keeps this machine's Node.js on PATH. `prepare(m)` runs once
// before the first launch. Each launch names its test `file`, and may have
// `before(m)` (between launches), `extensionVersion` (the extension's own
// version, edited into its package.json), `settings(m)` (VS Code User
// settings), `env(m)`, `folder(m)` (the folder VS Code opens, else the
// machine's own workspace), and `freshCache` (an empty npm cache, to see that
// nothing is downloaded).

const SCENARIOS = {
  fresh: {
    describe: 'No Node.js on PATH: Install Server downloads Node.js and the server (§5.2, §4.6, §5.5, §9.2)',
    launches: [{ file: 'install-flow.test.cjs' }],
  },
  'own-node': {
    describe: 'Node.js 22.21+ on PATH: only the server is downloaded, and runs on it (§5.2, §4.6)',
    nodeOnPath: true,
    launches: [{ file: 'own-node.test.cjs' }],
  },
  'npm-copy': {
    describe: "npm i -g steptix, never run, then the extension: npm's copy, no download (§5.3)",
    nodeOnPath: true,
    prepare: (m) => m.npmGlobal(`steptix@${m.version}`),
    launches: [{ file: 'npm-copy.test.cjs', freshCache: true }],
  },
  offline: {
    describe: 'The offline file and the .vsix with no npm registry at all (§5.6)',
    nodeOnPath: true,
    offline: true,
    needs: 'STEPTIX_INSTALL_TEST_OFFLINE_FILE',
    prepare: (m) => m.npmGlobal(process.env.STEPTIX_INSTALL_TEST_OFFLINE_FILE, ['--offline']),
    launches: [{ file: 'npm-copy.test.cjs', freshCache: true, env: () => ({ STEPTIX_INSTALL_TEST_OFFLINE: '1' }) }],
  },
  'ask-once': {
    describe:
      'The install question once, in a notification, not again when the extension starts again; a Run asks ' +
      "its own, in a dialog, stops on Stop, and asks no second question; the Test Runner's banner; " +
      'Install answered late does nothing (§5.2, §4.5)',
    launches: [{ file: 'ask-once.test.cjs' }],
  },
  cancel: {
    describe:
      'Cancel stops an install from the notification, the welcome page and the Test Runner: nothing half-installed ' +
      'is left, a Run waiting for it ends as not installed without asking, and Install works again (§5.2, §8.3)',
    nodeOnPath: true,
    launches: [{ file: 'cancel.test.cjs' }],
  },
  settings: {
    describe: 'serverAutoStart.command, and useInstalledRuntime off (§4.12)',
    nodeOnPath: true,
    prepare: (m) => m.npmGlobal(`steptix@${m.version}`),
    launches: [
      {
        file: 'settings.test.cjs',
        settings: (m) => ({
          'steptix.serverAutoStart.command': `"${m.globalSteptix}" serve -p ${m.port} --idle-timeout 5`,
          // Required with a command: it runs from there.
          'steptix.serverAutoStart.cwd': m.ws,
        }),
      },
      { file: 'settings.test.cjs', settings: () => ({ 'steptix.serverAutoStart.useInstalledRuntime': false }) },
    ],
  },
  'stale-terminal': {
    describe: "npm's steptix on an older major.minor than the extension: one notice, none for a patch (§6.8)",
    nodeOnPath: true,
    prepare: (m) => {
      m.publish(m.repack(m.older), 'older');
      m.npmGlobal(`steptix@${m.older}`);
    },
    launches: [
      { file: 'stale-terminal.test.cjs', env: (m) => ({ STEPTIX_INSTALL_TEST_TERMINAL: m.older }) },
      {
        file: 'stale-terminal.test.cjs',
        before: (m) => {
          m.publish(m.repack(m.nextPatch));
          m.npmGlobal(`steptix@${m.nextPatch}`);
        },
        env: (m) => ({ STEPTIX_INSTALL_TEST_TERMINAL: m.nextPatch }),
      },
    ],
  },
  updates: {
    describe: 'A server patch and an extension minor update without asking; who runs which server (§6.2, §4.2)',
    launches: [
      { file: 'updates.test.cjs', env: (m) => ({ STEPTIX_INSTALL_TEST_EXPECT: m.version }) },
      {
        file: 'updates.test.cjs',
        before: (m) => m.publish(m.repack(m.nextPatch)),
        env: (m) => ({ STEPTIX_INSTALL_TEST_EXPECT: m.nextPatch }),
      },
      {
        file: 'updates.test.cjs',
        before: (m) => m.publish(m.repack(m.nextMinor)),
        extensionVersion: (m) => m.nextMinor,
        env: (m) => ({ STEPTIX_INSTALL_TEST_EXPECT: m.nextMinor }),
      },
      { file: 'updates.test.cjs', extensionVersion: (m) => bump(m.version, 2, 9), env: (m) => ({ STEPTIX_INSTALL_TEST_EXPECT: m.nextPatch }) },
      { file: 'updates.test.cjs', extensionVersion: (m) => m.version, env: (m) => ({ STEPTIX_INSTALL_TEST_EXPECT: m.nextPatch }) },
      { file: 'updates.test.cjs', extensionVersion: (m) => bump(m.version, 1, 2), env: () => ({ STEPTIX_INSTALL_TEST_EXPECT: 'none' }) },
    ],
  },
  'welcome-ai': {
    describe: "The welcome page's AI step, with a stand-in Copilot and provider, while the server downloads (§7.1, §7.2)",
    launches: [{ file: 'welcome-ai.test.cjs' }],
  },
  resume: {
    describe:
      'Create a sample project during an install: the install carries on in the reopened window without asking, ' +
      'and the welcome page comes back on the first undone step (§8.3, §7.1, §7.3)',
    launches: [
      { file: 'resume.test.cjs', env: (m) => ({ STEPTIX_INSTALL_TEST_PROJECTS: path.join(m.dir, 'projects') }) },
      {
        file: 'resume.test.cjs',
        env: (m) => ({ STEPTIX_INSTALL_TEST_PROJECTS: path.join(m.dir, 'projects') }),
        // The window Create a sample project reopened on.
        folder: (m) => path.join(m.dir, 'projects', 'steptix-sample'),
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// A machine, and launching VS Code on it
// ---------------------------------------------------------------------------

async function makeMachine(name, scenario, shared) {
  const dir = path.join(shared.scratch, name);
  const home = path.join(dir, 'home');
  const ws = path.join(dir, 'ws');
  const prefix = path.join(dir, 'prefix');
  for (const d of [home, path.join(ws, 'tests'), prefix]) fs.mkdirSync(d, { recursive: true });
  const registry = scenario.offline ? null : await startTestRegistry(path.join(dir, 'registry'));
  if (registry) registry.publish(shared.tarball);
  const npmrc = registry ? registry.npmrc : path.join(dir, 'npmrc');
  if (!registry) fs.writeFileSync(npmrc, 'registry=http://127.0.0.1:9/\n');
  const port = await freeFetchablePort();
  fs.mkdirSync(path.join(home, 'steptix'), { recursive: true });
  fs.writeFileSync(path.join(home, 'steptix', '.env'), `STEPTIX_SERVER_URL=http://127.0.0.1:${port}\n`);
  fs.writeFileSync(path.join(ws, 'steptix.config.json'), JSON.stringify({ tests: { dir: './tests' } }, null, 2));

  const nodeDir = path.dirname(process.execPath);
  const prefixBin = win ? prefix : path.join(prefix, 'bin');
  const basePath = [prefixBin, ...(scenario.nodeOnPath ? [nodeDir] : []), pathWithoutNode(process.env.PATH ?? process.env.Path ?? '')].join(path.delimiter);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(STEPTIX_|AI_|LIVE_STEPTIX_|Path$)/.test(k)) delete env[k];
  Object.assign(env, {
    PATH: basePath,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_CACHE: shared.npmCache,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  });
  if (scenario.offline) {
    // The extension's downloads go nowhere: npm's registry and Node's own
    // network both point at a closed port.
    Object.assign(env, { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1', NO_PROXY: '' });
  }

  const m = {
    dir,
    home,
    ws,
    port,
    env,
    nodeDir,
    version: shared.version,
    nextPatch: bump(shared.version, 2),
    nextMinor: bump(shared.version, 1),
    // An older major.minor than the release's.
    older: shared.version.split('.')[1] === '0' ? `${Number(shared.version.split('.')[0]) - 1}.99.0` : bump(shared.version, 1, -1),
    globalSteptix: path.join(prefixBin, win ? 'steptix.cmd' : 'steptix'),
    repack: (version) => repackAs(shared.tarball, version, path.join(dir, `repack-${version}`)),
    publish: (tarball, tag) => registry.publish(tarball, tag),
    npmGlobal: (spec, extra = []) => run('npm', ['i', '-g', '--prefix', prefix, spec, '--no-audit', '--no-fund', ...extra], { env }),
    stop: () => registry?.stop(),
  };
  return m;
}

/** The extension as this launch runs it: the release's .vsix unpacked, with
 *  its own version changed when the launch says. */
function extensionFor(m, shared, version) {
  const dir = path.join(m.dir, `extension-${version ?? 'as-released'}`);
  if (!fs.existsSync(dir)) {
    const ext = unpackVsix(shared.vsix, dir);
    const manifestPath = path.join(ext, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // The release's own version runs the extension exactly as published.
    if (version && version !== manifest.version) {
      manifest.version = version;
      // The server it needs follows its major.minor (install-core.ts,
      // serverRequirement) unless the manifest pins one; a pinned one would
      // not follow the edit.
      delete manifest.steptixServer;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    harnessInside(ext);
  }
  return path.join(dir, 'extension');
}

function writeSettings(userData, settings) {
  const file = path.join(userData, 'User', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

async function launchVsCode(m, shared, launch, index) {
  const extensionPath = extensionFor(m, shared, launch.extensionVersion?.(m));
  const userData = path.join(m.dir, 'vscode-data');
  writeSettings(userData, launch.settings?.(m) ?? {});
  const reportPath = path.join(m.dir, `report-${index}.json`);
  fs.rmSync(reportPath, { force: true });
  const env = {
    ...m.env,
    ...(launch.freshCache && { NPM_CONFIG_CACHE: path.join(m.dir, `npm-cache-${index}`) }),
    STEPTIX_TEST_SERVER_SETUP: '1',
    STEPTIX_INSTALL_TEST_SERVER_URL: `http://127.0.0.1:${m.port}`,
    STEPTIX_INSTALL_TEST_VERSION: m.version,
    STEPTIX_INSTALL_TEST_NODE: m.nodeDir,
    STEPTIX_INSTALL_TEST_LAUNCH: String(index),
    STEPTIX_TEST_REPORT: reportPath,
    STEPTIX_LIVE_FILES: `../install/${launch.file}`,
    ELECTRON_RUN_AS_NODE: '1',
    ...launch.env?.(m),
  };
  const code = await new Promise((resolve) => {
    const proc = cp.spawn(
      shared.codeExe,
      [
        shared.cliJs,
        '--wait',
        launch.folder?.(m) ?? m.ws,
        `--extensionDevelopmentPath=${extensionPath}`,
        `--extensionTestsPath=${path.join(extensionPath, 'tests', 'integration', 'live', 'index.cjs')}`,
        `--user-data-dir=${userData}`,
        `--extensions-dir=${path.join(m.dir, 'vscode-ext')}`,
        '--disable-workspace-trust',
      ],
      { env, stdio: 'inherit' },
    );
    const timer = setTimeout(() => {
      console.error(`VS Code still running after ${LAUNCH_TIMEOUT_MS / 60_000} minutes; killing it`);
      proc.kill();
    }, LAUNCH_TIMEOUT_MS);
    proc.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    // none: a failure below
  }
  return { code, report };
}

// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--scenarios='));
  const wanted = (arg?.slice('--scenarios='.length) ?? process.env.STEPTIX_INSTALL_TEST_SCENARIOS ?? Object.keys(SCENARIOS).join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of wanted) if (!SCENARIOS[name]) throw new Error(`no install scenario named ${name}; there are ${Object.keys(SCENARIOS).join(', ')}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-install-test-'));
  console.log(`install test folder: ${scratch}`);
  const shared = { scratch, npmCache: path.join(scratch, 'npm-cache') };

  // The package and the extension under test: the release's, or this
  // checkout's, packed as a release would pack them (prepack builds dist/).
  shared.tarball =
    process.env.STEPTIX_INSTALL_TEST_TARBALL ??
    path.join(scratch, run('npm', ['pack', repoRoot, '--pack-destination', scratch], { cwd: scratch }).trim().split(/\r?\n/).at(-1));
  shared.version = packageVersionOf(shared.tarball, path.join(scratch, 'tarball'));
  if (process.env.STEPTIX_INSTALL_TEST_VSIX) {
    shared.vsix = process.env.STEPTIX_INSTALL_TEST_VSIX;
  } else {
    run('npm', ['run', 'build'], { cwd: extensionRoot });
    shared.vsix = path.join(scratch, 'steptix-vscode.vsix');
    run('npm', ['run', 'package', '--', '--out', shared.vsix], { cwd: extensionRoot });
  }
  shared.codeExe = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: path.join(extensionRoot, '.vscode-test') });
  shared.cliJs = path.join(path.dirname(shared.codeExe), 'resources', 'app', 'out', 'cli.js');

  const results = [];
  for (const name of wanted) {
    const scenario = SCENARIOS[name];
    console.log(`\n=== ${name}: ${scenario.describe}`);
    if (scenario.needs && !process.env[scenario.needs]) {
      console.log(`skipped: ${scenario.needs} is not set`);
      results.push({ scenario: name, skipped: true });
      continue;
    }
    let m;
    try {
      m = await makeMachine(name, scenario, shared);
      scenario.prepare?.(m);
      for (const [i, launch] of scenario.launches.entries()) {
        launch.before?.(m);
        const { code, report } = await launchVsCode(m, shared, launch, i + 1);
        if (!report) {
          results.push({ scenario: name, launch: i + 1, title: launch.file, ok: false, err: `VS Code exited ${code} without writing a report` });
          continue;
        }
        const ran = report.results.filter((r) => r.state !== 'pending');
        if (ran.length === 0) results.push({ scenario: name, launch: i + 1, title: launch.file, ok: false, err: 'no test ran' });
        for (const r of ran) results.push({ scenario: name, launch: i + 1, title: r.title, ok: r.state === 'pass' && code === 0, err: r.err });
      }
    } catch (err) {
      results.push({ scenario: name, title: 'setting up the machine', ok: false, err: err instanceof Error ? err.message : String(err) });
    } finally {
      m?.stop();
    }
    // A machine holds Node.js, npm caches and browsers: one whose tests all
    // passed is removed, and one that failed is kept for diagnosis.
    if (m && !results.some((r) => r.scenario === name && r.ok === false)) removeTree(m.dir);
  }

  console.log('');
  for (const r of results) {
    if (r.skipped) {
      console.log(`skip [${r.scenario}]`);
      continue;
    }
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${r.scenario}${r.launch ? ` #${r.launch}` : ''}] ${r.title}${r.err ? `\n     ${String(r.err).split('\n').join('\n     ')}` : ''}`);
  }
  const failed = results.some((r) => r.ok === false);
  if (failed) console.log(`install test folder: ${scratch}`);
  else removeTree(scratch);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
