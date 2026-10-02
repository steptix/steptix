// End-to-end test of one runtime installer. It installs the installer the way
// Windows does, uses the runtime through steptix.cmd from the CLI and from VS
// Code, and uninstalls it the way Installed Apps does.
//
// scripts/build-runtime.mjs runs this on every installer it builds and
// releases none that fails it. Run it by hand to re-check one:
//
//   node scripts/verify-runtime.mjs dist-runtime/SteptixRuntimeSetup-<version>-win-x64.exe
//
// Needs a desktop session (it opens a VS Code window), installed Google Chrome,
// and this checkout's steptix-vscode dependencies. Makes no AI calls. Uses a
// temporary %LOCALAPPDATA%, so the machine key and settings are never touched,
// and a Path value of its own, so your PATH is never touched either.
// The temporary folder is kept for diagnosis; it holds no real credentials.
import fs from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-runtime.mjs <installer.exe>');
const installer = path.resolve(process.argv[2]);
const version = /^SteptixRuntimeSetup-(.+)-win-x64\.exe$/.exec(path.basename(installer))?.[1];
if (!version) throw new Error(`Not a runtime installer name: ${path.basename(installer)}`);
const installerSha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');

// The long form of the temp directory: os.tmpdir() can be an 8.3 short path,
// and a real install lives under the long one. Spaces are wanted, not avoided.
const temp = await fs.mkdtemp(path.join(realpathSync.native(os.tmpdir()), 'steptix-runtime-verify-'));
const project = path.join(temp, 'test project');
// Stands in for %LOCALAPPDATA%. The runtime goes where the installer puts it
// by default, relative to that — which is where the extension looks for it.
// /D still has to say so: NSIS takes $LOCALAPPDATA from the shell folder, not
// from the environment.
const profile = path.join(temp, 'local app data');
const install = path.join(profile, 'steptix', 'runtimes', version);
const vscodeDir = path.join(temp, 'vscode');
for (const dir of [project, profile, vscodeDir]) await fs.mkdir(dir, { recursive: true });
const steptixCmd = path.join(install, 'steptix.cmd');
const keyFile = path.join(profile, 'steptix', '.env');

// A test install registers with Installed Apps under a key of its own
// (runtime.nsi, /TESTMODE), so a real install of this version is never touched.
const testId = randomBytes(4).toString('hex');
const regKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SteptixRuntime-${version}-test-${testId}`;
// It adds `steptix` to a Path value of its own too (user-path.nsh), seeded here
// the way Windows keeps a user's: REG_EXPAND_SZ, with a %VARIABLE% entry and a
// folder whose name has a space.
const userPathKey = `HKCU\\Software\\SteptixInstallerTest-${testId}`;
const userPathBefore = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Program Files\\Some Tool';
const binDir = path.join(profile, 'steptix', 'bin');

// Nothing of the developer's may leak in: no key, no AI settings, no server.
const baseEnv = { ...process.env, LOCALAPPDATA: profile, STEPTIX_STATS: 'off' };
for (const key of Object.keys(baseEnv)) {
  if (/^(AI_|STEPTIX_SERVER_API_KEY$|SERVER_URL$|LIVE_SERVER_URL$|AUTOMATION_ENV$|STEPTIX_NODE$)/i.test(key)) delete baseEnv[key];
}
// The CLI phase names Node through STEPTIX_NODE; the VS Code phase leaves it
// unset, so steptix.cmd takes `node` from PATH. Between them both branches run.
const cliEnv = { ...baseEnv, STEPTIX_NODE: process.execPath, CI: '1' };
const pathKey = Object.keys(baseEnv).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const vscodeEnv = { ...baseEnv, [pathKey]: `${path.dirname(process.execPath)};${baseEnv[pathKey] ?? ''}` };

function run(file, args, { cwd = project, env = cliEnv, timeout = 120_000, shell = false, verbatim = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env, shell, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const label = shell ? file : path.basename(file);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${label}\n${output.slice(-5000)}`)); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${label} exit ${code}: ${output.slice(-5000)}`));
    });
  });
}

const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg);
/** The CLI through steptix.cmd, by the same route the extension takes: one
 *  command line, run by cmd.exe /d /s /c. */
const steptix = (...args) => run([quote(steptixCmd), ...args.map(quote)].join(' '), [], { shell: true });

/** The values under a registry key, or null when the key does not exist. */
function regValues(key) {
  const result = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  const values = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

/** One registry value as stored, `{ type, data }`, or null when there is none. */
function regValue(key, name) {
  const result = spawnSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line);
    if (m && m[1] === name) return { type: m[2], data: m[3] };
  }
  return null;
}

/** Which of `pids` are still running. */
function alive(pids) {
  if (pids.length === 0) return [];
  // `exit 0`: a pid that has gone is an error to Get-Process even when
  // silenced, and that alone would make PowerShell exit 1.
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id; exit 0`,
  ], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).filter(Boolean).map(Number);
}

async function until(label, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for: ${label}`);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const checks = [];
/** The VS Code phase's server URL, and the processes its test saw serve it. */
let base = null;
let started = null;

try {
  // ── 1. Install ──────────────────────────────────────────────────────────
  const seeded = spawnSync('reg.exe', ['add', userPathKey, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', userPathBefore, '/f'], { windowsHide: true });
  assert.equal(seeded.status, 0, `could not seed ${userPathKey}`);
  // NSIS requires /D to be the last argument and unquoted, even with spaces.
  await run(installer, ['/S', `/TESTMODE=${testId}`, `/D=${install}`], { cwd: temp, timeout: 180_000, verbatim: true });
  const manifest = JSON.parse(await fs.readFile(path.join(install, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.node.bundled, false);
  const entry = regValues(regKey);
  assert.ok(entry, `no Installed Apps entry at ${regKey}`);
  assert.equal(entry.DisplayVersion, version);
  assert.equal(entry.InstallLocation, install);
  assert.equal(entry.UninstallString, `"${path.join(install, 'Uninstall.exe')}"`);
  checks.push('Installs silently into a fresh path with spaces and registers with Installed Apps');

  // "Add steptix to PATH" is ticked by default, so a silent install adds it.
  assert.deepEqual(regValue(userPathKey, 'Path'), { type: 'REG_EXPAND_SZ', data: `${userPathBefore};${binDir}` });
  for (const file of ['steptix.cmd', 'run-newest-runtime.cjs']) await fs.access(path.join(binDir, file));
  checks.push('Adds %LOCALAPPDATA%\\steptix\\bin to the end of the user Path, keeping every entry as written and the value\'s type');

  // ── 2. The CLI, through steptix.cmd ─────────────────────────────────────
  assert.match(await steptix('--version'), new RegExp(escapeRegExp(version)));
  const help = await steptix('--help');
  for (const command of ['run', 'compile', 'serve', 'status', 'stop', 'mcp']) assert.ok(help.includes(command), `help lists ${command}`);
  assert.ok(!help.includes('ui [directory]'), 'the server-only runtime has no ui command');
  assert.match(await steptix('browsers', '--help'), /install/);
  checks.push('steptix.cmd: version, server-only help and the Playwright browser installer');

  await steptix('init');
  await fs.access(path.join(project, 'steptix.config.json'));
  await fs.access(path.join(project, 'tests/example.md'));
  checks.push('Project scaffolding from the packaged templates');

  // A project with nothing installed in it, outside any checkout: the
  // compiled steps and the tool import the framework through the runtime.
  // And no package.json, as `steptix init` leaves it — so its `.ts` files are
  // in a CommonJS scope, which is where an ESM-only tsx registration broke.
  const config = {
    ai: { allowInRuns: false }, browser: { headed: false, browser: 'chromium', stealth: false },
    tests: { dir: './tests', toolsDir: './tools', contextDir: './context', skillsDir: './skills' },
    reports: { outputDir: './reports', openInBrowserAfterRun: false },
    execution: { timeout: 30_000, retries: 0 },
  };
  await fs.writeFile(path.join(project, 'steptix.config.json'), JSON.stringify(config));
  await fs.mkdir(path.join(project, 'tools'), { recursive: true });
  const testFile = path.join(project, 'tests/smoke.md');
  await fs.writeFile(testFile, '# Runtime smoke\n\n## Steps\n1. Open fixture\n2. [tool: echo]\n');
  await fs.writeFile(path.join(project, 'tests/smoke.steps.ts'), `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([{source: 'Open fixture', async run({page, step}) {
  await page.goto('data:text/html,<title>Runtime smoke</title><h1>Ready</h1>');
  step.setVar('fixture', await page.title());
}}]);\n`);
  await fs.writeFile(path.join(project, 'tools/echo.ts'), `import { defineTool } from 'steptix/tools';
export default defineTool({name:'echo',parameters:{},outputs:{marker:{type:'string'}},
async run(_args, {step}) { const value: string = 'tool-ok'; step.setVar('marker', value); }});\n`);
  await assert.rejects(fs.access(path.join(project, 'node_modules')));
  await assert.rejects(fs.access(path.join(project, 'package.json')));
  assert.match(await steptix('run', testFile, '--headless'), /passed/i);
  checks.push('steptix.cmd run: headless Chrome, compiled TypeScript steps and a custom tool, no AI, no project dependencies');

  // ── 3. VS Code: Run starts the installed server through steptix.cmd ────
  // Nothing configured: no extension settings, no project .env. The one line
  // written is SERVER_URL in the machine .env, because 3100 — the default the
  // extension would otherwise use — may be a developer's own server.
  base = `http://127.0.0.1:${await freePort()}`;
  await fs.rm(path.join(project, '.env'), { force: true });
  // A first-time user has no machine key; the server the extension starts
  // must create it, beside the URL, and the extension must then find it.
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  await fs.writeFile(keyFile, `SERVER_URL=${base}\n`);

  console.log('Building the VS Code extension under test...');
  execSync('npm run build', { cwd: path.join(root, 'steptix-vscode'), stdio: 'inherit' });
  const require = createRequire(import.meta.url);
  const { runInstalledRuntimeTest } = require(path.join(root, 'steptix-vscode/tests/integration/runRuntimeTest.cjs'));
  const userDataDir = path.join(vscodeDir, 'user-data');
  const resultPath = path.join(vscodeDir, 'result.json');
  const logPath = path.join(vscodeDir, 'steptix-output.log');
  console.log('Running the installed-runtime test in VS Code...');
  const vscodeRun = await runInstalledRuntimeTest({
    workspacePath: project,
    userDataDir,
    extensionsDir: path.join(vscodeDir, 'extensions'),
    reportPath: path.join(vscodeDir, 'report.json'),
    logPath,
    env: {
      ...vscodeEnv,
      STEPTIX_E2E_INSTALL_DIR: install,
      STEPTIX_E2E_TEST_FILE: testFile,
      STEPTIX_E2E_SERVER_URL: base,
      STEPTIX_E2E_VERSION: version,
      STEPTIX_E2E_RESULT: resultPath,
    },
  });
  if (existsSync(resultPath)) started = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const passed = vscodeRun.report && vscodeRun.report.failures === 0 && vscodeRun.report.results.some((r) => r.state === 'pass');
  if (!passed || vscodeRun.status !== 0) {
    const serverLog = path.join(userDataDir, 'User', 'globalStorage', 'pkent.steptix-vscode', 'server.log');
    const read = async (file) => fs.readFile(file, 'utf8').catch((error) => `(unreadable: ${error.message})`);
    const rows = vscodeRun.report
      ? vscodeRun.report.results.map((r) => `  ${r.state} ${r.title}${r.err ? `\n${r.err}` : ''}`).join('\n')
      : '  (no report written — the test entry never ran)';
    throw new Error(
      `The VS Code phase failed (VS Code exit ${vscodeRun.status}).\n${rows}\n\n` +
      `--- Steptix output channel ---\n${await read(logPath)}\n` +
      `--- server.log (the auto-started server) ---\n${await read(serverLog)}\n` +
      `--- VS Code output (tail) ---\n${vscodeRun.output.slice(-5000)}`,
    );
  }
  assert.ok(started, 'the VS Code test passed but recorded no server');
  checks.push('VS Code: with no settings and no project .env, Run finds the installed runtime and the machine .env\'s SERVER_URL, starts the server through steptix.cmd with Node from PATH and a generated key, and the test passes');

  // ── 4. The started server, from outside VS Code ────────────────────────
  const key = (await fs.readFile(keyFile, 'utf8')).match(/^STEPTIX_SERVER_API_KEY=(.+)$/m)?.[1].trim();
  assert.ok(key, `the started server wrote no key to ${keyFile}`);
  const keyContents = await fs.readFile(keyFile, 'utf8');
  assert.equal((await fetch(`${base}/sessions`)).status, 401);
  const response = await fetch(`${base}/sessions/installer-smoke/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ steps: ['Open fixture', '[tool: echo]'], testFilePath: testFile, toolsDir: path.join(project, 'tools'), runSettings: { ai: 'off' } }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.outputs.marker, 'tool-ok');
  assert.equal(result.outputs.fixture, 'Runtime smoke');
  checks.push('Authenticated Sessions API execution with the generated key');

  // In a child process: esbuild keeps a service process alive for as long as
  // the process that loaded it, and that would hold the installed esbuild.exe
  // open through the uninstall below.
  const reload = pathToFileURL(path.join(install, 'server/dist/tools/reload.js')).href;
  const mapCheck = await run(process.execPath, ['--input-type=module', '-e', `
    const reload = await import(${JSON.stringify(reload)});
    const bundle = await reload.bundleToolModule(${JSON.stringify(path.join(project, 'tools/echo.ts'))}, ${JSON.stringify(path.join(project, 'tools/.steptix-tool-cache'))});
    console.log(/sourceMappingURL=data:application\\/json;base64,/.test(new TextDecoder().decode(bundle.contents)) ? 'inline-source-map' : 'no-source-map');
    process.exit(0);`]);
  assert.match(mapCheck, /inline-source-map/);
  checks.push('Custom TypeScript tool compilation retains inline debugger source maps');

  await steptix('stop', '--url', base);
  const pids = started.processes.map((p) => p.pid);
  await until('the server, launcher and shell to exit', () => alive(pids).length === 0, 30_000);
  checks.push('steptix.cmd stop ends the server, its launcher and its shell');

  // ── 5. steptix on PATH ──────────────────────────────────────────────────
  // A terminal opened after the install: System32, then the user Path the
  // installer wrote, expanded as Windows expands it. Beside the real runtime,
  // two that `steptix` must not run: an older one, and a newer one that an
  // unfinished uninstall left without its launch files.
  const runtimesDir = path.dirname(install);
  const older = path.join(runtimesDir, '0.0.1');
  await fs.mkdir(path.join(older, 'server', 'dist'), { recursive: true });
  await fs.writeFile(path.join(older, 'steptix.cmd'), '');
  await fs.writeFile(path.join(older, 'server', 'dist', 'index.js'), '');
  await fs.writeFile(path.join(older, 'runtime-launcher.cjs'), "console.log('the older runtime ran');\n");
  const unfinished = path.join(runtimesDir, '99.0.0');
  await fs.mkdir(unfinished, { recursive: true });
  await fs.writeFile(path.join(unfinished, 'runtime-launcher.cjs'), "console.log('the unfinished uninstall ran');\n");
  const expand = (value) => value.replace(/%([^%;]+)%/g, (whole, name) => process.env[name] ?? whole);
  const terminalEnv = {
    ...cliEnv,
    [pathKey]: `${path.join(process.env.SystemRoot, 'System32')};${expand(regValue(userPathKey, 'Path').data)}`,
  };
  const found = await run('where.exe', ['steptix'], { env: terminalEnv });
  assert.equal(found.split(/\r?\n/)[0], path.join(binDir, 'steptix.cmd'));
  const onPath = await run('steptix --version', [], { env: terminalEnv, shell: true });
  assert.match(onPath, new RegExp(escapeRegExp(version)));
  assert.doesNotMatch(onPath, /older runtime|unfinished uninstall/);
  checks.push('steptix on PATH, in a new terminal, runs the newest installed runtime');
  // An older runtime still installed would keep the PATH folder through the
  // uninstall below. The unfinished one must not, so it stays.
  await fs.rm(older, { recursive: true });

  // ── 6. Uninstall the way Installed Apps does ────────────────────────────
  // UninstallString, not Uninstall.exe with _?=: run normally, the uninstaller
  // copies itself out and returns at once, then removes everything including
  // itself. So the check is that the folder goes, not that a process exits.
  const uninstallString = regValues(regKey)?.UninstallString;
  assert.ok(uninstallString, 'the Installed Apps entry has no UninstallString');
  await run(`${uninstallString} /S`, [], { cwd: temp, shell: true });
  try {
    await until('the install folder to be removed', () => !existsSync(install), 120_000);
  } catch (error) {
    throw new Error(`${error.message}. Left behind:\n  ${(await listFiles(install)).join('\n  ') || '(nothing — the folder itself)'}`);
  }
  // Removing its Installed Apps entry is the uninstaller's last step, after
  // the PATH folder, so this waits for the whole uninstall.
  await until('the Installed Apps entry to be removed', () => regValues(regKey) === null, 30_000);
  await fs.access(testFile);
  assert.equal(await fs.readFile(keyFile, 'utf8'), keyContents);
  checks.push('Uninstall through the Installed Apps entry removes the install folder and the entry, and keeps the project and the machine key');
  // The unfinished uninstall's folder does not count as a runtime, so this
  // was the last one: the PATH folder and its entry go, every other entry stays.
  assert.deepEqual(regValue(userPathKey, 'Path'), { type: 'REG_EXPAND_SZ', data: userPathBefore });
  assert.equal(existsSync(binDir), false, `${binDir} was not removed`);
  checks.push('Uninstalling the last runtime removes the PATH folder and its entry, and keeps the rest of the user Path as written');

  const report = {
    installer, sha256: installerSha256, version, installedTestPath: install,
    checks, passed: checks.length, verifiedAt: new Date().toISOString(),
  };
  await fs.writeFile(`${installer}.verification.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Whatever happened: no server left running, no test entry left in
  // Installed Apps, no test Path value. The folder itself stays, for diagnosis. A test that failed
  // after the start but before recording it still left a server on `base`.
  try {
    const pids = started ? started.processes.map((p) => p.pid) : [];
    if (!started && base) {
      const pid = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
        .then((res) => res.json()).then((h) => h.pid).catch(() => null);
      if (pid) pids.push(pid);
    }
    for (const pid of alive(pids)) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  } catch (error) {
    console.error(`Could not stop the test's server: ${error.message}`);
  }
  if (regValues(regKey)) spawnSync('reg.exe', ['delete', regKey, '/f'], { windowsHide: true, stdio: 'ignore' });
  if (regValues(userPathKey)) spawnSync('reg.exe', ['delete', userPathKey, '/f'], { windowsHide: true, stdio: 'ignore' });
  console.log(`Diagnostics kept in ${temp}`);
}
