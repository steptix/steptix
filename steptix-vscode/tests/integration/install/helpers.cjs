/**
 * What the install scenarios share (tests/integration/runInstallTest.cjs runs
 * them, one VS Code launch per file): the machine the runner set up, the
 * server's health, a wait on a condition, the extension's test hooks, and
 * VS Code's message boxes stubbed to answer as a user would.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { EXT_ID } = require('../extension-id.cjs');

function required(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is not set — run this through tests/integration/runInstallTest.cjs`);
  return value;
}

/** The Steptix folder of the runner's machine. */
const ROOT = () => path.join(required('LOCALAPPDATA'), 'steptix');
/** Where the extension's servers listen: the machine .env's STEPTIX_SERVER_URL. */
const SERVER_URL = () => required('STEPTIX_INSTALL_TEST_SERVER_URL');
/** The release's server version. */
const VERSION = () => required('STEPTIX_INSTALL_TEST_VERSION');
/** This launch's extension version, which a scenario may have changed. */
const EXTENSION_VERSION = () => vscode.extensions.getExtension(EXT_ID).packageJSON.version;

async function health(serverUrl = SERVER_URL()) {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Poll `predicate` until it is true, failing after `timeoutMs`. */
async function waitFor(label, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/** The servers in runtimes/, by version. */
function installed() {
  const dir = path.join(ROOT(), 'runtimes');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d/.test(n)).sort() : [];
}

function installRecord(version) {
  return JSON.parse(fs.readFileSync(path.join(ROOT(), 'runtimes', version, '.steptix-install.json'), 'utf8'));
}

/** `steptix --version` through the script the extension put in bin/. */
function binVersion() {
  const command = path.join(ROOT(), 'bin', process.platform === 'win32' ? 'steptix.cmd' : 'steptix');
  return cp.execSync(`"${command}" --version`, { encoding: 'utf8', env: process.env });
}

async function hooks() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  const api = await ext.activate();
  assert.ok(api?.__testHooks, 'the extension exposes no test hooks: STEPTIX_TEST_REPORT is not set');
  return api.__testHooks;
}

/**
 * Stub VS Code's message boxes for a describe block. `prompts` collects
 * every one raised, with its items and whether it was `modal` (a dialog
 * rather than a notification); `answer(fn)` sets what the next ones are
 * answered with: `fn(message, items)` returns the item to press, or
 * undefined to dismiss, which is also what VS Code answers for a dialog's
 * Cancel.
 */
function stubPrompts() {
  const prompts = [];
  const original = {};
  let press = () => undefined;
  before(() => {
    for (const name of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage']) {
      original[name] = vscode.window[name];
      vscode.window[name] = (message, ...rest) => {
        // MessageOptions, when given, come before the items: an object that
        // is not a MessageItem, which has a title.
        const first = rest[0];
        const options = first !== null && typeof first === 'object' && !('title' in first) ? first : {};
        const items = rest.filter((r) => typeof r === 'string');
        const answer = press(String(message), items);
        prompts.push({ kind: name, message: String(message), items, modal: options.modal === true, answer });
        return Promise.resolve(answer);
      };
    }
  });
  after(() => {
    for (const [name, fn] of Object.entries(original)) vscode.window[name] = fn;
  });
  return {
    prompts,
    answer(fn) {
      press = fn;
    },
    /** Prompts whose message matches `pattern`. */
    matching(pattern) {
      return prompts.filter((p) => pattern.test(p.message));
    },
  };
}

/** Stop whatever server answers, so no launch leaves one behind. */
async function stopServer() {
  await vscode.commands.executeCommand('steptix.stopServer');
  await waitFor('the server to stop', async () => (await health()) === null, 60_000);
}

module.exports = {
  EXTENSION_VERSION,
  ROOT,
  SERVER_URL,
  VERSION,
  binVersion,
  health,
  hooks,
  installRecord,
  installed,
  required,
  stopServer,
  stubPrompts,
  waitFor,
};
