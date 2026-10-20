/**
 * Installing the Steptix server from VS Code, for real
 * (docs/specs/SPEC-install.md §4.6, §5.2, §5.5, §9.2).
 *
 * Not part of the fast or live suites: tests/integration/runInstallTest.cjs
 * runs it. That runner serves this checkout's `steptix` package from a private
 * npm registry and launches this VS Code with a Steptix folder of its own, an
 * npm config pointing at that registry, and no Node.js on PATH. So everything
 * below is the real thing: npm downloading the package and its dependencies,
 * Node.js downloaded from nodejs.org and checked against its published
 * fingerprint, the launcher's own `server install`, the server started from
 * `runtimes/` under that Node.js, and the `steptix` command in `bin/`.
 *
 * Only the user's answers are scripted: VS Code's message boxes are stubbed to
 * answer as a user pressing Install (or Remove) would.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function required(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is not set — run this through tests/integration/runInstallTest.cjs`);
  return value;
}

async function health(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(label, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(500);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const ROOT = () => path.join(required('LOCALAPPDATA'), 'steptix');
const SERVER_URL = () => required('STEPTIX_INSTALL_TEST_SERVER_URL');
const VERSION = () => required('STEPTIX_INSTALL_TEST_VERSION');

describe('installing the Steptix server from VS Code', function () {
  this.timeout(20 * 60_000);

  /** Every message box the extension raised, and what the stub answered. */
  const prompts = [];
  const original = {};
  /** What the stub answers a message box with: the item to press, by text. */
  let press = () => undefined;

  before(() => {
    for (const name of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage']) {
      original[name] = vscode.window[name];
      vscode.window[name] = (message, ...rest) => {
        const items = rest.filter((r) => typeof r === 'string');
        const answer = press(String(message), items);
        prompts.push({ kind: name, message: String(message), items, answer });
        return Promise.resolve(answer);
      };
    }
  });

  after(async () => {
    for (const [name, fn] of Object.entries(original)) vscode.window[name] = fn;
    // Leave no server behind for the next launch.
    await vscode.commands.executeCommand('steptix.stopServer');
  });

  it('Install Server downloads Node.js and the server, and sets up the steptix command', async () => {
    assert.equal(fs.existsSync(path.join(ROOT(), 'runtimes', VERSION())), false, 'starts with nothing installed');
    await vscode.commands.executeCommand('steptix.installServer');

    const runtime = path.join(ROOT(), 'runtimes', VERSION());
    const record = JSON.parse(fs.readFileSync(path.join(runtime, '.steptix-install.json'), 'utf8'));
    assert.equal(record.source, 'extension', 'installed by the extension');
    const nodes = fs.readdirSync(path.join(ROOT(), 'node'));
    assert.equal(nodes.length, 1, `Steptix's own Node.js was downloaded: ${nodes}`);
    assert.match(nodes[0], /^22\.\d+\.\d+$/);
    assert.ok(
      prompts.some((p) => /^Steptix server .* is ready\.$/.test(p.message)),
      `said it is ready: ${JSON.stringify(prompts)}`,
    );

    // `steptix` for VS Code's terminals: the script in bin/, run as a terminal would.
    const command = path.join(ROOT(), 'bin', process.platform === 'win32' ? 'steptix.cmd' : 'steptix');
    const out = cp.execSync(`"${command}" --version`, { encoding: 'utf8', env: process.env });
    assert.match(out.split('\n')[1], new RegExp(`^Server: ${VERSION().replace(/\./g, '\\.')}\\b`));
    assert.ok(out.includes(runtime), `runs the installed server: ${out}`);
  });

  it('Start Server runs that server on its own Node.js, marked as started by VS Code', async () => {
    await vscode.commands.executeCommand('steptix.startServer');
    await waitFor('the server to answer', async () => (await health(SERVER_URL())) !== null, 120_000);
    const body = await health(SERVER_URL());
    assert.equal(body.version, VERSION());
    assert.equal(body.startedBy, 'vscode');
    await vscode.commands.executeCommand('steptix.stopServer');
    await waitFor('the server to stop', async () => (await health(SERVER_URL())) === null, 60_000);
  });

  it('Uninstall Server removes the servers, its Node.js and the steptix command', async () => {
    press = (message, items) => (message.startsWith('Remove every Steptix server') ? 'Remove' : undefined);
    await vscode.commands.executeCommand('steptix.uninstallServer');
    assert.deepEqual(
      fs.readdirSync(path.join(ROOT(), 'runtimes')).filter((n) => !n.startsWith('.')),
      [],
      'no server left',
    );
    assert.equal(fs.existsSync(path.join(ROOT(), 'node')), false, 'its Node.js is gone');
    assert.equal(fs.existsSync(path.join(ROOT(), 'bin')), false, 'the command is gone');
    assert.ok(fs.existsSync(path.join(ROOT(), '.env')), 'the machine .env stays');
  });

  it('with nothing installed, Start Server asks, and Install installs and starts it', async () => {
    const asked = [];
    press = (message, items) => {
      if (!message.startsWith('Steptix needs its local server')) return undefined;
      asked.push({ message, items });
      return 'Install';
    };
    await vscode.commands.executeCommand('steptix.startServer');
    assert.equal(asked.length, 1, 'asked once');
    assert.match(asked[0].message, /^Steptix needs its local server to run this test\. About \d+ MB to download\.$/);
    assert.deepEqual(asked[0].items, ['Install', 'Install and add steptix to PATH', 'Cancel']);
    await waitFor('the server to answer', async () => (await health(SERVER_URL())) !== null, 120_000);
    assert.equal((await health(SERVER_URL())).startedBy, 'vscode');
  });
});
