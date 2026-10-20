// The install test (tests/integration/install/install-flow.test.cjs): this
// checkout's `steptix` package, installed by the extension the way a user's
// would be (docs/specs/SPEC-install.md §5.2).
//
//   npm run test:install            (from steptix-vscode/)
//
// What it sets up, all under one temporary folder:
//
//  - A private npm registry (Verdaccio, fetched with npx) that serves this
//    checkout's packed `steptix` and passes every other package through to
//    npmjs.org, as a company registry would.
//  - A Steptix folder of its own (LOCALAPPDATA / XDG_CONFIG_HOME), whose
//    machine .env names a free port, so no server of yours is touched.
//  - An npm config that points at that registry, and a cache of its own.
//  - A PATH with no Node.js and no `steptix` on it, so the extension has to
//    download Node.js too.
//  - A VS Code of its own (user-data and extensions folders) running this
//    checkout's extension.
//
// It needs the network (npmjs.org through the registry, nodejs.org) and a
// desktop session, and takes a few minutes. It leaves the folder for
// diagnosis and prints where it is.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
// The registry and the server take their port as a flag, so they cannot
// bind 0 and report back: the one case freeFetchablePort is for.
const { freeFetchablePort } = require('../../../tests/listen-fetchable.cjs');

/** Pinned with the other runners. */
const VSCODE_VERSION = '1.95.0';
const VERDACCIO = 'verdaccio@6.1.6';
const LAUNCH_TIMEOUT_MS = 30 * 60_000;

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const extensionRoot = path.resolve(__dirname, '..', '..');

function run(command, args, opts = {}) {
  const result = cp.spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** PATH without any folder that holds node or steptix. */
function pathWithoutNode(value) {
  const names = process.platform === 'win32' ? ['node.exe', 'steptix.cmd', 'steptix.exe'] : ['node', 'steptix'];
  return value
    .split(path.delimiter)
    .filter((dir) => dir && !names.some((n) => fs.existsSync(path.join(dir, n))))
    .join(path.delimiter);
}

async function waitForRegistry(url) {
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`${url}-/ping`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the registry did not start at ${url}`);
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-install-test-'));
  console.log(`install test folder: ${scratch}`);
  const home = path.join(scratch, 'home');
  const ws = path.join(scratch, 'ws');
  for (const dir of [home, ws, path.join(scratch, 'registry')]) fs.mkdirSync(dir, { recursive: true });

  // The registry.
  const registryPort = await freeFetchablePort();
  const registry = `http://127.0.0.1:${registryPort}/`;
  fs.writeFileSync(
    path.join(scratch, 'registry', 'config.yaml'),
    [
      'storage: ./storage',
      'uplinks:',
      '  npmjs:',
      '    url: https://registry.npmjs.org/',
      'packages:',
      "  'steptix':",
      '    access: $all',
      '    publish: $all',
      "  '**':",
      '    access: $all',
      '    proxy: npmjs',
      'log: { type: stdout, format: pretty, level: warn }',
      '',
    ].join('\n'),
  );
  const npmrc = path.join(scratch, 'npmrc');
  fs.writeFileSync(npmrc, `registry=${registry}\n//127.0.0.1:${registryPort}/:_authToken=install-test-registry-token\n`);
  const verdaccio = cp.spawn('npx', ['-y', VERDACCIO, '--config', './config.yaml', '--listen', `127.0.0.1:${registryPort}`], {
    cwd: path.join(scratch, 'registry'),
    shell: process.platform === 'win32',
    stdio: ['ignore', fs.openSync(path.join(scratch, 'registry.log'), 'a'), fs.openSync(path.join(scratch, 'registry.log'), 'a')],
  });
  let status = 1;
  try {
    await waitForRegistry(registry);

    // This checkout's package, as npm would publish it (prepack builds dist/).
    const tarball = run('npm', ['pack', repoRoot, '--pack-destination', scratch], { cwd: scratch }).trim().split(/\r?\n/).at(-1);
    run('npm', ['publish', path.join(scratch, tarball), '--registry', registry], {
      cwd: scratch,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc },
    });
    const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
    console.log(`published steptix ${version} to ${registry}`);

    // The Steptix folder and the project.
    const serverPort = await freeFetchablePort();
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    fs.mkdirSync(path.join(home, 'steptix'), { recursive: true });
    fs.writeFileSync(path.join(home, 'steptix', '.env'), `STEPTIX_SERVER_URL=${serverUrl}\n`);
    fs.writeFileSync(path.join(ws, 'steptix.config.json'), JSON.stringify({ tests: { dir: './tests' } }, null, 2));
    fs.mkdirSync(path.join(ws, 'tests'));

    // This checkout's extension, built.
    run('npm', ['run', 'build'], { cwd: extensionRoot });

    const codeExe = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: path.join(extensionRoot, '.vscode-test') });
    const cliJs = path.join(path.dirname(codeExe), 'resources', 'app', 'out', 'cli.js');
    const reportPath = path.join(scratch, 'report.json');
    const env = {
      ...process.env,
      PATH: pathWithoutNode(process.env.PATH ?? process.env.Path ?? ''),
      LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home,
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_CACHE: path.join(scratch, 'npm-cache'),
      STEPTIX_TEST_SERVER_SETUP: '1',
      STEPTIX_INSTALL_TEST_SERVER_URL: serverUrl,
      STEPTIX_INSTALL_TEST_VERSION: version,
      STEPTIX_TEST_REPORT: reportPath,
      STEPTIX_LIVE_FILES: '../install/install-flow.test.cjs',
      ELECTRON_RUN_AS_NODE: '1',
    };
    delete env.Path;
    delete env.STEPTIX_NODE;
    delete env.STEPTIX_SERVER_URL;
    delete env.STEPTIX_SERVER_API_KEY;

    const code = await new Promise((resolve) => {
      const proc = cp.spawn(
        codeExe,
        [
          cliJs,
          '--wait',
          ws,
          `--extensionDevelopmentPath=${extensionRoot}`,
          `--extensionTestsPath=${path.join(__dirname, 'live', 'index.cjs')}`,
          `--user-data-dir=${path.join(scratch, 'vscode-data')}`,
          `--extensions-dir=${path.join(scratch, 'vscode-ext')}`,
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
    if (!report) {
      console.error(`VS Code exited ${code} without writing a report`);
    } else {
      for (const r of report.results) console.log(`${r.state === 'pass' ? 'ok  ' : 'FAIL'} ${r.title}${r.err ? `\n     ${r.err}` : ''}`);
      status = code === 0 && report.failures === 0 && report.results.length > 0 ? 0 : 1;
    }
    // What the install question's "About N MB" should say (SERVER_DOWNLOAD_MB
    // in install-core.ts): the package tarballs npm fetched, as its cache
    // index records them. The cache also holds package metadata, stored
    // uncompressed, which is far larger on disk than on the wire.
    const index = path.join(scratch, 'npm-cache', '_cacache', 'index-v5');
    if (fs.existsSync(index)) {
      let tarballs = 0;
      let count = 0;
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            walk(p);
            continue;
          }
          for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
            const tab = line.indexOf('\t');
            if (tab < 0) continue;
            try {
              const entry = JSON.parse(line.slice(tab + 1));
              if (/\.tgz$/.test(entry.key)) {
                tarballs += entry.size ?? 0;
                count++;
              }
            } catch {
              // a torn line
            }
          }
        }
      };
      walk(index);
      console.log(`npm downloaded ${count} package tarballs, ${Math.round(tarballs / 1e6)} MB`);
    }
  } finally {
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill.exe', ['/PID', String(verdaccio.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      verdaccio.kill();
    }
  }
  console.log(`install test folder: ${scratch}`);
  process.exit(status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
