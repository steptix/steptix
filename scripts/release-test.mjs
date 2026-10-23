#!/usr/bin/env node
// The release test (docs/specs/SPEC-install.md §10.1): nothing is published
// that was not installed and run the way a user would.
//
//   node scripts/build-release.mjs               (builds dist-release/)
//   node scripts/release-test.mjs [--files <dir>] [--skip-vscode]
//
// It takes the exact files about to be published (scripts/build-release.mjs
// writes them), serves the npm package from a private test registry
// (tests/npm-test-registry.cjs), and installs and runs them in a Steptix
// folder, an npm prefix and a cache of its own, with no AI configured. Then
// it runs the extension's install test (steptix-vscode/tests/integration/
// runInstallTest.cjs) on the `.vsix` and the same package.
//
// Every check runs even when an earlier one failed, and the run ends with
// the §10.1 rows it does not check yet, so a pass is never read as more than
// it is. It needs the network (npmjs.org through the registry, nodejs.org),
// Google Chrome, and, for the extension's part, a desktop session. It exits 0
// only when every check it ran passed.

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startTestRegistry } = require('../tests/npm-test-registry.cjs');
const { freeFetchablePort } = require('../tests/listen-fetchable.cjs');
const { unpackVsix, untar } = require('../tests/release-files.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const filesDir = path.resolve(arg('--files') ?? path.join(root, 'dist-release'));
const skipVsCode = process.argv.includes('--skip-vscode');
const win = process.platform === 'win32';

// --- The files under test --------------------------------------------------

const names = fs.readdirSync(filesDir);
const platformTag = `${process.platform}-${process.arch}`;
const offlineName = names.find((n) => n.endsWith(`-${platformTag}.tgz`));
const npmName = names.find((n) => /^steptix-\d+\.\d+\.\d+\.tgz$/.test(n));
const vsixName = names.find((n) => n.endsWith('.vsix'));
if (!npmName || !offlineName || !vsixName) {
  throw new Error(`${filesDir} must hold steptix-<v>.tgz, steptix-<v>-${platformTag}.tgz and a .vsix (scripts/build-release.mjs)`);
}
const version = /^steptix-(\d+\.\d+\.\d+)\.tgz$/.exec(npmName)[1];
const [major, minor, patch] = version.split('.').map(Number);
/** The next two patches, published alongside to test updating and which
 *  versions are kept (§6.1, §4.3, §6.5). */
const nextPatch = `${major}.${minor}.${patch + 1}`;
const thirdPatch = `${major}.${minor}.${patch + 2}`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-release-test-'));
console.log(`release test folder: ${scratch}`);
console.log(`testing ${npmName}, ${offlineName} and ${vsixName}`);

// --- Running things ---------------------------------------------------------

/** Run to completion; never throws. `shell` on Windows, where npm and the
 *  installed `steptix` are .cmd files. `out` is everything it printed,
 *  `stdout` the part a caller reads a result from. */
function sh(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', shell: win, timeout: 10 * 60_000, ...opts });
  return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Its stdout, or a throw naming everything it printed. */
function mustRun(command, args, opts) {
  const r = sh(command, args, opts);
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${r.status}:\n${r.out}`);
  return r.stdout;
}

/** PATH without the developer's own `steptix`, so only the installed one answers. */
function pathWithoutSteptix() {
  const value = process.env.PATH ?? process.env.Path ?? '';
  const names = win ? ['steptix.cmd', 'steptix.exe', 'steptix.ps1'] : ['steptix'];
  return value
    .split(path.delimiter)
    .filter((dir) => dir && !names.some((n) => fs.existsSync(path.join(dir, n))))
    .join(path.delimiter);
}

/**
 * A machine of its own: a Steptix folder, an npm prefix and cache, an npm
 * config naming `registry`, and the prefix's bin first on PATH. No AI and no
 * Steptix server settings come from the developer's environment.
 */
function machine(name, registry) {
  const dir = path.join(scratch, name);
  const home = path.join(dir, 'home');
  const prefix = path.join(dir, 'prefix');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  const npmrc = path.join(dir, 'npmrc');
  fs.writeFileSync(npmrc, registry.npmrcText);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(STEPTIX_|AI_|LIVE_STEPTIX_|AUTOMATION_ENV$|Path$)/.test(k)),
  );
  Object.assign(env, {
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_CACHE: path.join(dir, 'npm-cache'),
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    PATH: [win ? prefix : path.join(prefix, 'bin'), pathWithoutSteptix()].join(path.delimiter),
  });
  const userRoot = path.join(home, 'steptix');
  return {
    dir,
    env,
    userRoot,
    runtimes: () => (fs.existsSync(path.join(userRoot, 'runtimes')) ? fs.readdirSync(path.join(userRoot, 'runtimes')).filter((n) => /^\d/.test(n)) : []),
    steptix: (args, opts = {}) => sh('steptix', args, { env, ...opts }),
    npm: (args, opts = {}) => sh('npm', args, { env, ...opts }),
  };
}

/** A copy of `steptix-<version>.tgz` repacked as `newVersion`, for the
 *  update checks. Repacked rather than rebuilt, so it is the same code. */
function repackAs(newVersion) {
  const dir = path.join(scratch, `repack-${newVersion}`);
  untar(path.join(filesDir, npmName), dir);
  const manifestPath = path.join(dir, 'package', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = newVersion;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const out = mustRun('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], { cwd: path.join(dir, 'package') });
  return path.join(dir, out.trim().split(/\r?\n/).at(-1));
}

/** The server version `steptix` runs, from `--version`'s `Server:` line. Its
 *  first line is the launcher's own version, npm's copy, which is not the
 *  one a `server use` choice changes. */
function runningVersion(m) {
  return /^Server: (\d+\.\d+\.\d+)/m.exec(m.steptix(['--version']).stdout)?.[1] ?? null;
}

/** Resolves once `child` has exited, killing its process tree after `ms`. */
async function exited(child, ms) {
  if (child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  const timer = setTimeout(() => {
    if (win) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  }, ms);
  await done;
  clearTimeout(timer);
}

/** A copy of the sample project made by `steptix init`. */
function initProject(m, name) {
  const project = path.join(m.dir, name);
  const r = m.steptix(['init', project]);
  if (r.status !== 0) throw new Error(`steptix init exited ${r.status}:\n${r.out}`);
  return project;
}

/** Node's own network pointed at a closed port (`NODE_USE_ENV_PROXY`), so a
 *  run that reached for npm, nodejs.org or an AI provider would fail. */
function offlineEnv(env) {
  return { ...env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1', NO_PROXY: '' };
}

// --- Checks -----------------------------------------------------------------

const results = [];
async function check(name, scenario, fn) {
  process.stdout.write(`… ${name} (${scenario})\n`);
  try {
    await fn();
    results.push({ name, scenario, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, scenario, ok: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`FAIL ${name}\n     ${String(err instanceof Error ? err.message : err).split('\n').join('\n     ')}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** `steptix run` of the sample's test, which passes as code with no AI. */
function runSample(m, project, env = m.env) {
  const r = sh('steptix', ['run', 'tests/first-test.md', '--headless'], { cwd: project, env });
  expect(r.status === 0, `steptix run exited ${r.status}:\n${r.out}`);
  expect(/4 code-behind, 0 AI/.test(r.out), `the sample did not run as code:\n${r.out}`);
  return r.out;
}

const registry = await startTestRegistry(path.join(scratch, 'registry'));
registry.npmrcText = fs.readFileSync(registry.npmrc, 'utf8');
try {
  registry.publish(path.join(filesDir, npmName));

  // §5.1 ---------------------------------------------------------------------
  const a = machine('terminal', registry);
  let project;
  await check('npm i -g steptix, then the first command copies the package and a test runs', '§5.1', () => {
    const install = a.npm(['i', '-g', `steptix@${version}`]);
    expect(install.status === 0, `npm i -g exited ${install.status}:\n${install.out}`);
    const first = a.steptix(['--version']);
    expect(first.status === 0, `steptix --version exited ${first.status}:\n${first.out}`);
    expect(a.runtimes().includes(version), `runtimes/ holds ${a.runtimes().join(', ') || 'nothing'}, not ${version}`);
    const record = JSON.parse(fs.readFileSync(path.join(a.userRoot, 'runtimes', version, '.steptix-install.json'), 'utf8'));
    expect(record.source === 'npm', `the install record says source ${record.source}`);
    project = initProject(a, 'sample');
    runSample(a, project);
  });

  // §7.3 ---------------------------------------------------------------------
  // Node's network only: the browser's is not cut, which the sample's local
  // page does not need. §10.1's "network off" for the whole machine is a
  // row this test does not check yet.
  await check("the sample passes with no AI chosen and Node's network shut off", '§7.3', () => {
    expect(project, 'no sample project (the check above failed)');
    runSample(a, project, offlineEnv(a.env));
  });

  await check('steptix init and Create a sample project produce the same files', '§7.3', () => {
    expect(project, 'no sample project');
    const fromExtension = path.join(unpackVsix(path.join(filesDir, vsixName), path.join(scratch, 'vsix')), 'sample');
    const list = (dir) =>
      fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
        .filter((rel) => !rel.split('/').some((part) => part.startsWith('.') || part === 'reports'))
        .sort();
    const extensionFiles = list(fromExtension);
    expect(extensionFiles.length > 0, `the .vsix holds no sample in extension/sample`);
    expect(JSON.stringify(list(project)) === JSON.stringify(extensionFiles), `init made ${list(project).join(', ')}; the extension holds ${extensionFiles.join(', ')}`);
    for (const rel of extensionFiles) {
      expect(fs.readFileSync(path.join(project, rel)).equals(fs.readFileSync(path.join(fromExtension, rel))), `${rel} differs`);
    }
  });

  // §3.4 ---------------------------------------------------------------------
  await check("a project's own tool and compiled steps load, with and without a local steptix", '§3.4', () => {
    expect(project, 'no sample project');
    fs.mkdirSync(path.join(project, 'tools', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'tools', 'src', 'say_hello.ts'),
      [
        "import { defineTool } from 'steptix/tools';",
        '',
        'export default defineTool({',
        "  name: 'say_hello',",
        "  description: 'Sets the greeting variable.',",
        '  parameters: {},',
        "  outputs: { greeting: { type: 'string', description: 'the greeting' } },",
        '  async run(_args, { step }) {',
        "    step.setVar('greeting', 'hello');",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(project, 'tests', 'tool-test.md'), '# Tool test\n\n## Steps\n1. [tool: say_hello]\n');
    const runBoth = (label) => {
      const tool = sh('steptix', ['run', 'tests/tool-test.md', '--headless'], { cwd: project, env: a.env });
      expect(tool.status === 0, `${label}: the tool test exited ${tool.status}:\n${tool.out}`);
      runSample(a, project);
    };
    runBoth('no local steptix');
    // Into the project, not the global prefix.
    const { NPM_CONFIG_PREFIX: _global, ...projectEnv } = a.env;
    const local = sh('npm', ['i', `steptix@${version}`, '--no-audit', '--no-fund'], { cwd: project, env: projectEnv });
    expect(local.status === 0, `npm i steptix in the project exited ${local.status}:\n${local.out}`);
    runBoth('a local steptix');
  });

  // §4.13 --------------------------------------------------------------------
  await check('steps compiled by a newer major.minor run with the AI, warn, and stay as they are; with no AI they fail naming the update', '§4.13', () => {
    const newer = initProject(a, 'newer-stamp');
    const steps = path.join(newer, 'tests', 'first-test.steps.ts');
    const text = fs.readFileSync(steps, 'utf8').replace(/Compiled by Steptix \S+?\./, `Compiled by Steptix ${major + 1}.0.0.`);
    fs.writeFileSync(steps, text);
    const r = sh('steptix', ['run', 'tests/first-test.md', '--headless'], { cwd: newer, env: a.env });
    expect(r.status !== 0, `the run passed with no AI:\n${r.out}`);
    expect(new RegExp(`steps were compiled by Steptix ${major + 1}\\.0 and ran with the AI instead`).test(r.out), `no notice:\n${r.out}`);
    expect(/update Steptix to run it as code/.test(r.out), `the failure does not name the update:\n${r.out}`);
    expect(fs.readFileSync(steps, 'utf8') === text, 'the steps file was changed');
  });

  // §6.1, §6.3, §4.3, §6.5 -----------------------------------------------------
  await check('updating while a server runs: it keeps serving, the next start is the new version', '§6.1, §6.3', async () => {
    const port = await freeFetchablePort();
    const server = spawn('steptix', ['serve', '-p', String(port), '--idle-timeout', '5'], { env: a.env, shell: win, stdio: 'ignore' });
    try {
      const health = async () => {
        for (let i = 0; i < 120; i++) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
            if (res.ok) return await res.json();
          } catch {
            // starting
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(`no server answered on ${port}`);
      };
      expect((await health()).version === version, `the server is not ${version}`);
      registry.publish(repackAs(nextPatch));
      const update = a.npm(['i', '-g', `steptix@${nextPatch}`]);
      expect(update.status === 0, `npm i -g steptix@${nextPatch} exited ${update.status}:\n${update.out}`);
      expect((await health()).version === version, 'the running server changed under the update');
      expect(runningVersion(a) === nextPatch, `steptix --version after the update runs ${runningVersion(a)}`);
    } finally {
      // By its own URL: a bare stop looks at the machine .env's port.
      a.steptix(['stop', '--url', `http://127.0.0.1:${port}`, '--force']);
      await exited(server, 60_000);
    }
  });

  await check('only the newest of a major.minor and the previous version are kept', '§4.3', () => {
    registry.publish(repackAs(thirdPatch));
    const update = a.npm(['i', '-g', `steptix@${thirdPatch}`]);
    expect(update.status === 0, `npm i -g steptix@${thirdPatch} exited ${update.status}:\n${update.out}`);
    expect(runningVersion(a) === thirdPatch, `steptix --version runs ${runningVersion(a)}`);
    const kept = a.runtimes().sort();
    expect(JSON.stringify(kept) === JSON.stringify([nextPatch, thirdPatch]), `runtimes/ holds ${kept.join(', ')}, not ${nextPatch} and ${thirdPatch}`);
  });

  await check('server use the previous version runs it; server use newest undoes it', '§6.5', () => {
    const use = a.steptix(['server', 'use', nextPatch]);
    expect(use.status === 0, `server use ${nextPatch} exited ${use.status}:\n${use.out}`);
    expect(runningVersion(a) === nextPatch, `steptix --version runs ${runningVersion(a)}, not the chosen ${nextPatch}`);
    const newest = a.steptix(['server', 'use', 'newest']);
    expect(newest.status === 0, `server use newest exited ${newest.status}:\n${newest.out}`);
    expect(runningVersion(a) === thirdPatch, `steptix --version runs ${runningVersion(a)}, not the newest ${thirdPatch}`);
  });

  // §9.1 ---------------------------------------------------------------------
  await check('steptix uninstall warns when VS Code uses the servers, removes them, and names npm rm -g steptix', '§9.1', () => {
    // A stand-in for the extension's record of itself. Its folder must exist:
    // a record whose client is gone is dropped as stale.
    const clients = path.join(a.userRoot, 'clients');
    const location = path.join(scratch, 'vscode-extension');
    fs.mkdirSync(clients, { recursive: true });
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(
      path.join(clients, 'vscode-0123456789abcdef.json'),
      JSON.stringify({ kind: 'vscode', version, requires: `${major}.${minor}.0`, location }),
    );
    const asked = a.steptix(['uninstall']);
    expect(asked.status !== 0 && /The Steptix extension in VS Code uses these servers/.test(asked.out), `no warning:\n${asked.out}`);
    const removed = a.steptix(['uninstall', '--yes']);
    expect(removed.status === 0, `uninstall --yes exited ${removed.status}:\n${removed.out}`);
    expect(/npm rm -g steptix/.test(removed.out), `uninstall does not name npm rm -g steptix:\n${removed.out}`);
    expect(a.runtimes().length === 0, `runtimes/ still holds ${a.runtimes().join(', ')}`);
    expect(fs.existsSync(path.join(a.userRoot, '.env')), 'the machine .env was removed with the servers');
  });

  // §5.6 ---------------------------------------------------------------------
  await check('the offline file installs with no registry at all, and a test runs', '§5.6', () => {
    const o = machine('offline', { npmrcText: 'registry=http://127.0.0.1:9/\n' });
    const install = o.npm(['i', '-g', path.join(filesDir, offlineName), '--offline'], { env: offlineEnv(o.env) });
    expect(install.status === 0, `npm i -g <offline file> exited ${install.status}:\n${install.out}`);
    const first = o.steptix(['--version'], { env: offlineEnv(o.env) });
    expect(first.status === 0, `steptix --version exited ${first.status}:\n${first.out}`);
    const record = JSON.parse(fs.readFileSync(path.join(o.userRoot, 'runtimes', version, '.steptix-install.json'), 'utf8'));
    expect(record.source === 'offline file', `the install record says source ${record.source}`);
    const sample = path.join(o.dir, 'sample');
    const init = o.steptix(['init', sample], { env: offlineEnv(o.env) });
    expect(init.status === 0, `steptix init exited ${init.status}:\n${init.out}`);
    runSample(o, sample, offlineEnv(o.env));
  });

  await check('an offline file for another platform is refused, naming its platform', '§5.6', () => {
    const dir = path.join(scratch, 'wrong-platform');
    untar(path.join(filesDir, offlineName), dir);
    const manifestPath = path.join(dir, 'package', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(String(manifest.os) === process.platform && String(manifest.cpu) === process.arch, `the offline file says os ${manifest.os}, cpu ${manifest.cpu}`);
    // The same file, said to be for another platform.
    manifest.os = [win ? 'linux' : 'win32'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const other = mustRun('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], { cwd: path.join(dir, 'package') }).trim().split(/\r?\n/).at(-1);
    const o = machine('wrong-platform-machine', { npmrcText: 'registry=http://127.0.0.1:9/\n' });
    const r = o.npm(['i', '-g', path.join(dir, other), '--offline']);
    expect(r.status !== 0 && /EBADPLATFORM/.test(r.out) && r.out.includes(manifest.os[0]), `not refused by platform:\n${r.out}`);
  });

  // The extension --------------------------------------------------------------
  if (skipVsCode) {
    console.log('skipped: the extension install test (--skip-vscode)');
  } else {
    await check('the extension installs Node.js and the server, starts it and removes it, from the .vsix and this package', '§5.2, §4.6, §5.5, §9.2', () => {
      const r = sh('node', [path.join(root, 'steptix-vscode', 'tests', 'integration', 'runInstallTest.cjs')], {
        env: {
          ...process.env,
          STEPTIX_INSTALL_TEST_TARBALL: path.join(filesDir, npmName),
          STEPTIX_INSTALL_TEST_VSIX: path.join(filesDir, vsixName),
        },
        cwd: path.join(root, 'steptix-vscode'),
        shell: false,
        timeout: 40 * 60_000,
      });
      expect(r.status === 0, `the extension install test exited ${r.status}:\n${r.out.slice(-4000)}`);
    });
  }
} finally {
  registry.stop();
}

// --- What this run did not check ------------------------------------------

const NOT_YET = [
  'Extension with Node.js 22.21+ on PATH downloads only the server (§5.2, §4.6)',
  'npm install never run, then the extension uses npm\'s copy (§5.3)',
  'The install question appears once across a restart and a second window (§5.2, §4.5)',
  'Install and add steptix to PATH: steptix runs in a new terminal outside VS Code (§5.5)',
  'The welcome page: the AI step while the server downloads, a stand-in Copilot, a wrong and a good key, where the choice is saved, and steptix ai writing the same files (§7.1, §7.2)',
  'The .vsix installed with the network switched off (§5.6)',
  "The sample's first Run with the whole machine's network off, the browser's included (§7.3)",
  'Extension updates to a new minor, and a new server patch with no new extension (§6.2)',
  'Non-matching servers started by VS Code (idle and busy) and by hand (§6.4)',
  'serverAutoStart.command and useInstalledRuntime off (§4.12)',
  'A server patch with the oldest and the newest extension patch; no server of another major.minor (§4.2)',
  'npm\'s steptix on an older major.minor than the extension (§6.8)',
  'steptix browsers install firefox, and Firefox after an update that moves Playwright (§7.4)',
  'Two windows installing at once (§6.7), and an interrupted install retried (§8.3)',
];

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length} of ${results.length} checks passed on ${platformTag}.`);
for (const r of failed) console.log(`  FAIL ${r.name} (${r.scenario})`);
console.log('');
console.log(`Not checked by this test yet (${NOT_YET.length} rows of §10.1):`);
for (const row of NOT_YET) console.log(`  - ${row}`);
console.log(`release test folder: ${scratch}`);
process.exit(failed.length === 0 ? 0 : 1);
