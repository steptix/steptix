/**
 * "Steptix: Use Copilot for AI" against an active environment's overlay
 * (stories/env-overlay-awareness.md Part A).
 *
 * The planner is unit-tested without a host (tests/lm-bridge-env.test.js).
 * What needs the host is the ORDER: the overlay is looked at before anything
 * is planned, so the case that swallowed the original incident — a `.env` that
 * is already perfect, shadowed by a `.env.uat` that is not — still asks the
 * question instead of exiting with "nothing to write". And that the file the
 * user did not pick comes out byte-identical.
 *
 * `vscode.lm` is faked (fakes/fake-lm.cjs); the modals are stubbed on
 * `vscode.window`, since a real one would sit on screen for the rest of the
 * suite waiting for a click nobody can make.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vscode = require('vscode');
const { FakeLm } = require('../fakes/fake-lm.cjs');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR || path.resolve(__dirname, '..', 'fixtures');
const BASE_ENV = path.join(FIXTURES_DIR, '.env');
const ENV_NAME = 'setupenv';
const OVERLAY_ENV = path.join(FIXTURES_DIR, `.env.${ENV_NAME}`);
// A dotted name: legal in a filename, read and applied by the run path, and
// rejected by the first version of setup's name guard — which is how setup
// came to write `.env` while every run went on using the overlay.
const DOTTED_ENV_NAME = 'setupenv.local';
const DOTTED_OVERLAY_ENV = path.join(FIXTURES_DIR, `.env.${DOTTED_ENV_NAME}`);
const SETUP_COMMAND = 'steptix.useCopilotForAi';

/** The extension's output channel, which the harness tees to a file — VS Code
 *  exposes no way to read an OutputChannel back. */
function readOutputLog() {
  const file = process.env.STEPTIX_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

async function setActiveEnv(name) {
  await vscode.workspace
    .getConfiguration('steptix')
    .update('activeEnv', name, vscode.ConfigurationTarget.Global);
}

describe('Steptix Copilot setup vs. the active env overlay', function () {
  this.timeout(30_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  let fake;
  let port;
  let token;
  let baseEnvSnapshot;
  const original = {};
  /** Every modal/toast the command raised: { kind, message, modal, items }. */
  let prompts;
  /** Answer for the overlay choice: index into its items, or null to dismiss. */
  let overlayAnswer;

  /** The trio a settled file holds, for the "already correct" case. */
  const settledEnv = () =>
    [
      'STEPTIX_SERVER_URL=http://127.0.0.1:39917',
      'STEPTIX_SERVER_API_KEY=integration-test-key',
      'AI_MODEL=gateway/copilot/gpt-4.1',
      `AI_GATEWAY_URL=http://127.0.0.1:${port}`,
      `AI_API_KEY=${token}`,
      '',
    ].join('\n');

  // The overlay choice is the only modal WARNING the command raises: the
  // confirm is an information modal (and once the overlay is the target, it
  // names `.env.setupenv` too — so filtering on the filename counts both).
  const overlayPrompts = () => prompts.filter((p) => p.modal && p.kind === 'warning');

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');

    fake = new FakeLm();
    hooks.configureLmBridge({ lm: fake, retryMs: 250 });
    port = await freePort();
    const cfg = vscode.workspace.getConfiguration('steptix');
    await cfg.update('lmBridge.port', port, vscode.ConfigurationTarget.Global);
    await cfg.update('lmBridge.enabled', true, vscode.ConfigurationTarget.Global);
    await hooks.syncLmBridge();
    token = await hooks.lmBridgeToken();

    baseEnvSnapshot = read(BASE_ENV);
    assert.ok(baseEnvSnapshot, 'the fixtures workspace must have a base .env to protect');

    // Stub the three window calls the command makes. A modal answers with the
    // scripted item; a plain toast answers with nothing, as an unclicked one
    // does.
    for (const name of ['showInformationMessage', 'showWarningMessage', 'showQuickPick']) {
      original[name] = vscode.window[name];
    }
    const record = (kind) => (message, options, ...items) => {
      const modal = options?.modal === true;
      prompts.push({ kind, message: String(message), modal, items });
      if (!modal) return Promise.resolve(undefined);
      if (kind === 'warning') {
        // The overlay choice — the only warning modal this command raises.
        return Promise.resolve(overlayAnswer === null ? undefined : items[overlayAnswer]);
      }
      return Promise.resolve(items[0]);
    };
    vscode.window.showInformationMessage = record('info');
    vscode.window.showWarningMessage = record('warning');
    vscode.window.showQuickPick = (choices) => {
      prompts.push({ kind: 'quickpick', message: 'model', modal: false, items: choices });
      return Promise.resolve(Array.isArray(choices) ? choices[0] : undefined);
    };
    assert.notEqual(
      vscode.window.showWarningMessage,
      original.showWarningMessage,
      'the vscode.window stubs must actually take — otherwise a modal hangs the suite',
    );
  });

  after(async () => {
    for (const [name, fn] of Object.entries(original)) vscode.window[name] = fn;
    const cfg = vscode.workspace.getConfiguration('steptix');
    await cfg.update('lmBridge.enabled', false, vscode.ConfigurationTarget.Global);
    await hooks.syncLmBridge();
    if (baseEnvSnapshot !== null) fs.writeFileSync(BASE_ENV, baseEnvSnapshot);
    fs.rmSync(OVERLAY_ENV, { force: true });
    fs.rmSync(DOTTED_OVERLAY_ENV, { force: true });
  });

  beforeEach(() => {
    prompts = [];
    overlayAnswer = 0;
    fs.writeFileSync(BASE_ENV, baseEnvSnapshot);
    fs.rmSync(OVERLAY_ENV, { force: true });
    fs.rmSync(DOTTED_OVERLAY_ENV, { force: true });
  });

  afterEach(async () => {
    // Never leak the selection: a stale env makes every later run STX006.
    await setActiveEnv(undefined);
    fs.writeFileSync(BASE_ENV, baseEnvSnapshot);
    fs.rmSync(OVERLAY_ENV, { force: true });
    fs.rmSync(DOTTED_OVERLAY_ENV, { force: true });
  });

  it('writes .env and asks nothing when no environment is active', async () => {
    await setActiveEnv(undefined);
    await vscode.commands.executeCommand(SETUP_COMMAND);

    assert.equal(overlayPrompts().length, 0, 'no overlay, no question');
    const written = read(BASE_ENV);
    assert.match(written, /AI_MODEL=gateway\/copilot\/gpt-4\.1/);
    assert.match(written, new RegExp(`AI_GATEWAY_URL=http://127\\.0\\.0\\.1:${port}`));
    assert.ok(written.includes(`AI_API_KEY=${token}`));
    assert.equal(read(OVERLAY_ENV), null, 'no overlay file is invented');
  });

  it('asks once when the active overlay sets any of the trio, and writes only the file picked', async () => {
    fs.writeFileSync(OVERLAY_ENV, 'AI_API_KEY=sk-live-from-uat\nUAT_ONLY=x\n');
    await setActiveEnv(ENV_NAME);
    overlayAnswer = 0; // "Write .env.setupenv"

    await vscode.commands.executeCommand(SETUP_COMMAND);

    const asked = overlayPrompts();
    assert.equal(asked.length, 1, 'asked exactly once');
    assert.deepEqual(
      asked[0].items,
      [`Write .env.${ENV_NAME}`, 'Continue anyway'],
      'two choices, and no default — dismissing must not pick one',
    );
    assert.match(asked[0].message, /AI_API_KEY/, 'the message names what the overlay sets');

    assert.equal(read(BASE_ENV), baseEnvSnapshot, '.env must come out byte-identical');

    const overlay = read(OVERLAY_ENV);
    assert.ok(overlay.includes(`AI_API_KEY=${token}`), 'the shadowing key is replaced');
    assert.match(overlay, /AI_MODEL=gateway\/copilot\/gpt-4\.1/, 'and the whole trio lands');
    assert.match(overlay, new RegExp(`AI_GATEWAY_URL=http://127\\.0\\.0\\.1:${port}`));
    assert.ok(overlay.includes('UAT_ONLY=x'), 'unrelated lines survive');
    assert.ok(!overlay.includes('sk-live-from-uat'), 'the shadowing value is gone, not appended');
    assert.match(overlay, /--env setupenv/, 'the block says how the CLI reaches these lines');
  });

  it('STILL asks when .env is already correct — the case that swallowed the incident', async () => {
    // This is the whole point of checking before planning: with `.env` settled,
    // the plan is `unchanged` and the command used to exit with "nothing to
    // write" while the overlay went on winning every run.
    fs.writeFileSync(BASE_ENV, settledEnv());
    fs.writeFileSync(OVERLAY_ENV, 'AI_MODEL=openai/chatgpt-5.5\n');
    await setActiveEnv(ENV_NAME);
    overlayAnswer = 0; // "Write .env.setupenv"

    await vscode.commands.executeCommand(SETUP_COMMAND);

    assert.equal(overlayPrompts().length, 1, 'the settled .env must not short-circuit the question');
    const overlay = read(OVERLAY_ENV);
    assert.ok(overlay.includes(`AI_API_KEY=${token}`));
    assert.match(overlay, /AI_MODEL=gateway\/copilot\/gpt-4\.1/, 'the shadowing model is replaced');
    assert.ok(!overlay.includes('openai/chatgpt-5.5'));
    assert.equal(read(BASE_ENV), settledEnv(), '.env is left as it was');
    assert.ok(
      prompts.some((p) => p.kind === 'info' && /nothing to write/.test(p.message)) === false,
      'and it never reports "nothing to write" while a file still needs writing',
    );
  });

  it('"Continue anyway" writes .env, leaving the overlay untouched', async () => {
    const overlayBefore = 'AI_API_KEY=sk-live-from-uat\n';
    fs.writeFileSync(OVERLAY_ENV, overlayBefore);
    await setActiveEnv(ENV_NAME);
    overlayAnswer = 1; // "Continue anyway"

    await vscode.commands.executeCommand(SETUP_COMMAND);

    assert.equal(overlayPrompts().length, 1);
    assert.equal(read(OVERLAY_ENV), overlayBefore, 'the overlay is the file setup promised not to touch');
    assert.ok(read(BASE_ENV).includes(`AI_API_KEY=${token}`), '.env got the trio, as before');
  });

  it('dismissing the question writes nothing at all — there is no default', async () => {
    const overlayBefore = 'AI_GATEWAY_URL=https://uat.example\n';
    fs.writeFileSync(OVERLAY_ENV, overlayBefore);
    await setActiveEnv(ENV_NAME);
    overlayAnswer = null; // Escape

    await vscode.commands.executeCommand(SETUP_COMMAND);

    assert.equal(overlayPrompts().length, 1);
    assert.equal(read(OVERLAY_ENV), overlayBefore);
    assert.equal(read(BASE_ENV), baseEnvSnapshot);
  });

  it('a dotted env name is a file like any other — it must still be checked', async () => {
    // `.env.setupenv.local` is read and applied by the run path. A name guard
    // that only accepted picker-shaped names threw this one away and returned
    // "no overlay", so setup wrote `.env` and reported success while every run
    // kept taking AI_API_KEY from here: the incident, wearing a different name.
    fs.writeFileSync(DOTTED_OVERLAY_ENV, 'AI_API_KEY=sk-live-from-dotted\n');
    await setActiveEnv(DOTTED_ENV_NAME);
    overlayAnswer = 0; // "Write .env.setupenv.local"

    await vscode.commands.executeCommand(SETUP_COMMAND);

    const asked = overlayPrompts();
    assert.equal(asked.length, 1, 'the dotted overlay must raise the same question');
    assert.deepEqual(asked[0].items, [`Write .env.${DOTTED_ENV_NAME}`, 'Continue anyway']);
    assert.equal(read(BASE_ENV), baseEnvSnapshot, '.env comes out byte-identical');
    const overlay = read(DOTTED_OVERLAY_ENV);
    assert.ok(overlay.includes(`AI_API_KEY=${token}`), 'the shadowing key is replaced');
    assert.ok(!overlay.includes('sk-live-from-dotted'));
  });

  it('a name that would escape the folder is refused, and says so in the log', async () => {
    // The guard still has to hold: this name is joined onto a folder path and
    // written to. What it must not do is refuse in silence — a bare `return
    // null` reads exactly like "no environment is active" and walks the user
    // into the same 401 with nothing to go on.
    await setActiveEnv('../..');

    await vscode.commands.executeCommand(SETUP_COMMAND);

    assert.equal(overlayPrompts().length, 0, 'no file is formed from it, so nothing to ask');
    assert.ok(read(BASE_ENV).includes(`AI_API_KEY=${token}`), '.env is written, as with no env');
    const log = readOutputLog();
    assert.ok(log, 'the harness must tee the output channel — see runTest.cjs');
    assert.match(log, /active env "\.\.\/\.\." cannot name a file beside \.env/);
  });

  it('an overlay that touches none of the trio is not a conflict', async () => {
    fs.writeFileSync(OVERLAY_ENV, 'STEPTIX_SERVER_URL=http://127.0.0.1:39917\nUAT_ONLY=x\n');
    await setActiveEnv(ENV_NAME);

    await vscode.commands.executeCommand(SETUP_COMMAND);

    assert.equal(overlayPrompts().length, 0, 'nothing shadows the trio, so nothing to ask');
    assert.ok(read(BASE_ENV).includes(`AI_API_KEY=${token}`));
  });
});
