/**
 * The installed runtime, started by the extension the way a user's would be
 * (packaging/runtime/README.md §Use with the extension): with nothing
 * configured.
 *
 * Not part of the fast or live suites. scripts/verify-runtime.mjs runs it once
 * per installer, from tests/integration/runRuntimeTest.cjs, after installing
 * that installer where it installs by default, under a temporary
 * %LOCALAPPDATA%. It hands over everything through the environment — the
 * install folder, the project, the URL nothing is listening on yet — and gives
 * this VS Code a profile of its own: no Steptix settings at all; a machine
 * .env holding only SERVER_URL, so there is no machine key; a project with no
 * .env; and no STEPTIX_NODE, so steptix.cmd finds Node on PATH the way it does
 * on a user's machine.
 *
 * Everything here is real: the auto-start spawn, the shell, steptix.cmd, the
 * launcher, the server, the key the server generates, headless Chrome. No AI —
 * the project sets `ai.allowInRuns: false`, and its steps are compiled.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient predicate errors are part of the wait */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function required(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is not set — run this through scripts/verify-runtime.mjs`);
  return value;
}

/** The parsed /health body, or null when nothing answers. */
async function health(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Every process on the machine, by pid: one PowerShell call, walked in JS. */
function processTable() {
  const json = cp.execFileSync(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  return new Map(JSON.parse(json).map((p) => [p.ProcessId, p]));
}

/** `pid` and its ancestors, nearest first, as far as `depth`. */
function ancestry(pid, depth) {
  const table = processTable();
  const chain = [];
  for (let p = table.get(pid); p && chain.length < depth; p = table.get(p.ParentProcessId)) {
    chain.push({ pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine ?? '' });
  }
  return chain;
}

const lower = (s) => s.toLowerCase();

describe('Installed runtime, auto-started by the extension through steptix.cmd', function () {
  this.timeout(420_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
  });

  it('finds and starts the installed server on Run, with nothing configured, and runs the test to a pass', async () => {
    const installDir = required('STEPTIX_E2E_INSTALL_DIR');
    const testFile = required('STEPTIX_E2E_TEST_FILE');
    const serverUrl = required('STEPTIX_E2E_SERVER_URL');
    const version = required('STEPTIX_E2E_VERSION');
    const resultPath = required('STEPTIX_E2E_RESULT');

    // The conditions a first-time user is in, checked rather than assumed:
    // a run that found a server already up would prove nothing about the
    // start, and a key or a Node path inherited from the developer's
    // environment would hide the two lookups the installed runtime must do
    // on its own.
    assert.equal(process.env.STEPTIX_NODE, undefined, 'STEPTIX_NODE must not be set: Node comes from PATH');
    assert.equal(process.env.STEPTIX_SERVER_API_KEY, undefined, 'no inherited API key');
    assert.equal(process.env.SERVER_URL, undefined, 'no inherited SERVER_URL');
    const machineEnv = path.join(required('LOCALAPPDATA'), 'steptix', '.env');
    assert.equal(
      fs.readFileSync(machineEnv, 'utf8').trim(),
      `SERVER_URL=${serverUrl}`,
      'the machine .env names the server and holds no key yet — the started server must generate it',
    );
    assert.equal(
      fs.existsSync(path.join(path.dirname(testFile), '..', '.env')),
      false,
      'the project has no .env of its own',
    );
    assert.equal(
      path.dirname(installDir),
      path.join(required('LOCALAPPDATA'), 'steptix', 'runtimes'),
      'installed where the installer puts it by default, which is where the extension looks',
    );
    const cfg = vscode.workspace.getConfiguration('steptix');
    for (const key of ['serverAutoStart.command', 'serverAutoStart.cwd', 'serverAutoStart.useInstalledRuntime']) {
      const set = cfg.inspect(key);
      assert.equal(set?.globalValue, undefined, `steptix.${key} must not be set: a first-time user has not`);
    }
    assert.equal(await health(serverUrl), null, `nothing may be listening on ${serverUrl} before Run`);

    // The one setting changed. readyTimeoutSeconds is raised from 20 because
    // a cold start through tsx on a loaded machine has come close to it; it
    // does not change what is started.
    await cfg.update('serverAutoStart.readyTimeoutSeconds', 90, vscode.ConfigurationTarget.Global);

    const uri = vscode.Uri.file(testFile);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    await waitFor('test file detected', () => hooks.tracker.snapshot().isTestFile === true, 20_000);

    hooks.clearRunError();
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor(
      'the run to finish',
      () => hooks.lastDoneStatus() !== null || hooks.lastRunError() !== null,
      300_000,
    );
    await waitFor('idle', () => !hooks.isRunning(), 30_000);

    assert.equal(hooks.lastRunError(), null, `the run was refused: ${JSON.stringify(hooks.lastRunError())}`);
    assert.equal(hooks.lastDoneStatus(), 'passed');

    // Each step, by its 1-based line, painted as the kind of pass it must be:
    // step 1 ran its compiled TypeScript (`</>`), step 2 the custom tool. A
    // compiled step that fell back to anything else would not be `</>`.
    const statuses = new Map(hooks.tracker.snapshot().statuses);
    const stepLines = fs
      .readFileSync(testFile, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, i) => (/^\d+\.\s/.test(line) ? [i + 1] : []));
    assert.equal(stepLines.length, 2, 'the fixture has two steps');
    assert.equal(statuses.get(stepLines[0]), 'pass-code-behind', `step 1 (line ${stepLines[0]})`);
    assert.equal(statuses.get(stepLines[1]), 'pass', `step 2 (line ${stepLines[1]})`);

    // The server that answered is the installed one, and it got there through
    // steptix.cmd — not a checkout's server, and not the launcher run directly.
    const h = await health(serverUrl);
    assert.ok(h, 'the started server stopped answering');
    assert.equal(h.service, 'steptix');
    assert.equal(h.version, version);
    assert.match(h.inspector ?? '', /^ws:\/\/127\.0\.0\.1:/, 'serve runs with the localhost inspector');
    assert.equal(h.idleTimeoutMinutes, 60, 'started with the idle timeout the extension passes');

    const [server, launcher, shell] = ancestry(h.pid, 3);
    assert.ok(server, `no process with the server's pid ${h.pid}`);
    assert.ok(
      lower(server.commandLine).includes(lower(path.join(installDir, 'server', 'dist', 'index.js'))),
      `the server runs the installed dist: ${server.commandLine}`,
    );
    assert.ok(launcher, 'the server has no parent process');
    assert.ok(
      lower(launcher.commandLine).includes(lower(path.join(installDir, 'runtime-launcher.cjs'))),
      `the server's parent is the installed launcher: ${launcher.commandLine}`,
    );
    assert.ok(shell, 'the launcher has no parent process');
    assert.equal(lower(shell.name), 'cmd.exe', 'the launcher was started by a shell');
    assert.ok(
      lower(shell.commandLine).includes(lower(path.join(installDir, 'steptix.cmd'))),
      `that shell ran steptix.cmd: ${shell.commandLine}`,
    );

    // For the script outside VS Code: what to stop, and what to wait out
    // before uninstalling — the auto-started chain outlives this window.
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ health: h, processes: [server, launcher, shell] }, null, 2),
    );
  });
});
