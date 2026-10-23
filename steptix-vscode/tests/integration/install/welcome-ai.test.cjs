/**
 * The welcome page's AI step (docs/specs/SPEC-install.md §7.1, §7.2), driven
 * as its webview would drive it (`__testHooks.welcome`), with stand-ins for
 * what a test cannot sign in to: a Copilot seat (FakeLm, as §11 says) and an
 * AI provider (a fetch that answers as OpenAI's model list does). The keys
 * are fakes named after this test; nothing reaches a real provider.
 *
 * What the open page shows is read with `__testHooks.welcome.shown`: the
 * state the host last posted to it. How each state is drawn is held by
 * tests/welcome-core.test.js, which runs the page's own script.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { FakeLm } = require('../fakes/fake-lm.cjs');
const { ROOT, VERSION, hooks, installed, stopServer, stubPrompts, waitFor } = require('./helpers.cjs');

const GOOD_KEY = 'good-key-welcome-test';
const WRONG_KEY = 'wrong-key-welcome-test';
const BRIDGE_TOKEN = 'bridge-token-welcome-test';
const OPENAI_MODELS = 'https://api.openai.com/v1/models';

const LUNA = { id: 'gpt-6-luna', vendor: 'copilot', family: 'gpt-6-luna', name: 'GPT 6 Luna' };
const GPT_41 = { id: 'gpt-4.1', vendor: 'copilot', family: 'gpt-4.1', name: 'GPT-4.1' };

/** While set, the stand-in provider waits for it before answering, so a
 *  check can be seen while it runs. */
let held = null;
/** How many times a key was checked with the stand-in. */
let providerCalls = 0;

/** OpenAI, as far as the key check sees it: the model list for the good key,
 *  401 for anything else. */
async function standInProvider(url, init) {
  providerCalls++;
  if (held) await held.promise;
  const auth = init.headers.Authorization ?? init.headers.authorization;
  const ok = url === OPENAI_MODELS && auth === `Bearer ${GOOD_KEY}`;
  return {
    ok,
    status: ok ? 200 : 401,
    json: async () => (ok ? { data: [{ id: 'gpt-6-mini' }, { id: 'gpt-6-luna' }, { id: 'gpt-5' }] } : { error: { message: 'Incorrect API key' } }),
  };
}

const machineEnv = () => path.join(ROOT(), '.env');
const projectEnv = () => path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.env');
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** `text` with its AI lines replaced by `lines`, as a hand edit would leave it. */
function withAi(text, lines) {
  const kept = text.split(/\r?\n/).filter((l) => l && !/^AI_(MODEL|API_KEY|GATEWAY_URL)=/.test(l));
  return [...kept, ...Object.entries(lines).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n';
}

/** A promise the test resolves itself. */
function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

describe("the welcome page's AI step", function () {
  this.timeout(20 * 60_000);
  const prompts = stubPrompts();
  let h;
  /** The page's state, as the host posts it on `ready`. */
  const state = async () => (await h.welcome.send({ type: 'ready' })).find((m) => m.type === 'state').state;
  /** What the open page shows now. */
  const shownAi = () => h.welcome.shown()?.ai;

  before(async () => {
    h = await hooks();
    h.welcome.setFetch(standInProvider);
  });
  after(async () => {
    held?.open();
    held = null;
    h.welcome.setFetch(null);
    h.welcome.setCopilotInstalled(null);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await stopServer().catch(() => undefined);
  });

  it('lists Copilot while this VS Code has none, and offers it once one appears, without the page reopening', async () => {
    // This VS Code has no Copilot: the page says so, greys its entry and
    // opens OpenAI's (welcome-core.test.js holds how that is drawn; which
    // entry is open is the page's own, which the host does not see).
    await vscode.commands.executeCommand('steptix.welcome');
    await waitFor('the page to look for Copilot', () => ['none', 'unavailable'].includes(shownAi()?.copilot), 60_000);
    assert.deepEqual(shownAi().copilotModels, []);
    assert.equal(shownAi().copilotInstalled, false, 'this VS Code has no Copilot extension');

    // Installed but signed out: no models, and the page says to sign in.
    h.welcome.setCopilotInstalled(true);
    await h.welcome.send({ type: 'checkCopilot' });
    assert.equal(shownAi().copilotInstalled, true);
    assert.equal(shownAi().copilot, 'none');

    // Copilot signs in: VS Code says the models changed, and the page looks again.
    const lm = new FakeLm();
    lm.models = [GPT_41, LUNA];
    h.configureLmBridge({ lm, access: lm, retryMs: 250 });
    await waitFor('the page to offer Copilot', () => shownAi()?.copilot === 'offers-luna', 30_000);
    assert.equal(shownAi().copilotModels[0].id, 'gpt-6-luna');

    lm.models = [GPT_41];
    lm.modelsChanged();
    await waitFor('the page to follow Copilot dropping GPT 6 Luna', () => shownAi()?.copilot === 'no-luna', 30_000);
    lm.models = [];
    lm.modelsChanged();
    await waitFor('the page to follow Copilot going', () => shownAi()?.copilot === 'none', 30_000);
  });

  it('works while the server downloads', async () => {
    const install = vscode.commands.executeCommand('steptix.installServer');
    await waitFor('the server step to say it is installing', async () => (await state()).server.state === 'installing', 120_000);
    const [checked] = await h.welcome.send({ type: 'checkKey', provider: 'openai', key: GOOD_KEY });
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(installed().includes(VERSION()), false, 'the install had already finished, so this showed nothing');
    await install;
    assert.ok(installed().includes(VERSION()));
  });

  it('tells the page whether Copilot offers GPT 6 Luna, does not, or offers nothing, which decides the entry open to begin with', async () => {
    const lm = new FakeLm();
    h.configureLmBridge({ lm, retryMs: 250 });
    const copilot = async () => {
      await h.welcome.send({ type: 'checkCopilot' });
      return (await state()).ai;
    };

    lm.models = [
      { id: 'gpt-4.1', vendor: 'copilot', family: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-6-luna', vendor: 'copilot', family: 'gpt-6-luna', name: 'GPT 6 Luna' },
    ];
    const offers = await copilot();
    assert.equal(offers.copilot, 'offers-luna');
    assert.equal(offers.copilotModels[0].id, 'gpt-6-luna');
    assert.equal(offers.copilotModels[0].recommended, true);

    lm.models = [{ id: 'gpt-4.1', vendor: 'copilot', family: 'gpt-4.1', name: 'GPT-4.1' }];
    assert.equal((await copilot()).copilot, 'no-luna');

    lm.models = [];
    assert.equal((await copilot()).copilot, 'none');
  });

  it('refuses a wrong key before anything is saved, and lists a good key\'s models with the recommended one first', async () => {
    const [wrong] = await h.welcome.send({ type: 'checkKey', provider: 'openai', key: WRONG_KEY });
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /did not accept this key/);
    const refused = await h.welcome.send({ type: 'saveProvider', provider: 'openai', key: WRONG_KEY, model: 'gpt-6-luna' });
    assert.ok(refused.some((m) => m.type === 'failed'), JSON.stringify(refused));
    assert.doesNotMatch(read(machineEnv()), /AI_API_KEY/, 'a refused key was saved');

    const [good] = await h.welcome.send({ type: 'checkKey', provider: 'openai', key: GOOD_KEY });
    assert.equal(good.ok, true);
    assert.equal(good.models[0].id, 'gpt-6-luna');
    assert.equal(good.models[0].recommended, true);
  });

  it('saves for all projects, in the file it names, which reaches a project with no .env; a project .env of its own wins', async () => {
    assert.equal(fs.existsSync(projectEnv()), false, 'the project starts with no .env');
    assert.equal((await state()).ai.saveTo, machineEnv(), 'Save names the file for all projects');
    const saved = await h.welcome.send({ type: 'saveProvider', provider: 'openai', key: GOOD_KEY, model: 'gpt-6-luna' });
    assert.ok(saved.some((m) => m.type === 'saved'), JSON.stringify(saved));
    assert.match(read(machineEnv()), /^AI_MODEL=openai\/gpt-6-luna$/m);
    assert.match(read(machineEnv()), new RegExp(`^AI_API_KEY=${GOOD_KEY}$`, 'm'));
    const all = (await state()).ai;
    assert.deepEqual(all.found, { file: machineEnv(), project: false, git: null });
    assert.equal(all.chosen, 'AI: OpenAI · GPT 6 Luna');
    assert.equal(all.projectOwn, false);

    // The framework reads it too: in this project, which has no .env, a step
    // that needs the AI no longer fails for want of one. Node's network goes
    // to a closed port, so the stand-in key never leaves the machine.
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    fs.writeFileSync(path.join(ws, 'tests', 'needs-ai.md'), '# Needs the AI\n\n## Steps\n1. Check the page is blank\n');
    const command = path.join(ROOT(), 'bin', process.platform === 'win32' ? 'steptix.cmd' : 'steptix');
    const run = cp.spawnSync(`"${command}"`, ['run', 'tests/needs-ai.md', '--headless'], {
      cwd: ws,
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1', NO_PROXY: '' },
      timeout: 5 * 60_000,
    });
    const out = `${run.stdout}${run.stderr}`;
    assert.doesNotMatch(out, /AI is not configured/, `the machine's AI did not reach the project:\n${out}`);

    // A key for one project goes in its .env by hand (or with steptix ai):
    // the page shows it as found there, This project only, and says it wins.
    fs.writeFileSync(projectEnv(), `KEEP_THIS=welcome-test\nAI_MODEL=openai/gpt-6-mini\nAI_API_KEY=${GOOD_KEY}\n`);
    const project = (await state()).ai;
    assert.equal(project.chosen, 'AI: OpenAI · gpt-6-mini');
    assert.equal(project.found.file, projectEnv());
    assert.equal(project.found.project, true);
    assert.equal(project.projectOwn, true);

    // Remove key asks, naming the file, and takes the AI lines out of that
    // file only.
    prompts.answer((message) => (message.startsWith('Remove the AI settings from') ? 'Remove' : undefined));
    await h.welcome.send({ type: 'removeKey' });
    assert.deepEqual(
      prompts.matching(/^Remove the AI settings from/).map((p) => p.message),
      [`Remove the AI settings from ${projectEnv()}? The key and model are deleted from that file.`],
    );
    assert.equal(read(projectEnv()), 'KEEP_THIS=welcome-test\n', `errors shown: ${JSON.stringify(prompts.matching(/Could not write/))}`);
    assert.match(read(machineEnv()), new RegExp(`^AI_API_KEY=${GOOD_KEY}$`, 'm'), 'the all-projects file is untouched');
    const after = (await state()).ai;
    assert.deepEqual(after.found, { file: machineEnv(), project: false, git: null });
    assert.equal(after.projectOwn, false);
  });

  it('checks settings already there when the page opens: a good key checking then working, a wrong one not passing', async () => {
    // The one for all projects, written by hand.
    fs.rmSync(projectEnv(), { force: true });
    const machineBefore = read(machineEnv());
    try {
      held = gate();
      fs.writeFileSync(machineEnv(), withAi(machineBefore, { AI_MODEL: 'openai/gpt-6-luna', AI_API_KEY: GOOD_KEY }));
      await vscode.commands.executeCommand('steptix.welcome');
      await waitFor('the key to be checked', () => shownAi()?.check?.state === 'checking', 30_000);
      assert.equal(shownAi().chosen, 'AI: OpenAI · GPT 6 Luna', 'shown while it is checked');
      held.open();
      held = null;
      await waitFor('the key to be shown working', () => shownAi()?.check?.state === 'works', 30_000);
      assert.equal(shownAi().check.line, 'OpenAI accepted the key.');
      assert.equal(shownAi().keyHint, `key ending …${GOOD_KEY.slice(-4)}`);

      // The In use block's Model list, from that same check: another model
      // is saved without the key, which stays as it was and is not checked
      // again.
      assert.deepEqual(shownAi().check.models.map((m) => m.id), ['gpt-6-luna', 'gpt-6-mini', 'gpt-5']);
      const calls = providerCalls;
      await h.welcome.send({ type: 'saveModel', model: 'gpt-6-mini' });
      assert.match(read(machineEnv()), /^AI_MODEL=openai\/gpt-6-mini$/m);
      assert.match(read(machineEnv()), new RegExp(`^AI_API_KEY=${GOOD_KEY}$`, 'm'));
      assert.match(read(machineEnv()), /^STEPTIX_SERVER_URL=/m, 'every other line stays');
      assert.equal(shownAi().chosen, 'AI: OpenAI · gpt-6-mini');
      assert.equal(shownAi().check.state, 'works');
      assert.equal(providerCalls, calls, 'the key was checked again');

      fs.writeFileSync(machineEnv(), withAi(machineBefore, { AI_MODEL: 'openai/gpt-6-luna', AI_API_KEY: WRONG_KEY }));
      await vscode.commands.executeCommand('steptix.welcome');
      await waitFor('the wrong key to be shown not working', () => shownAi()?.check?.state === 'not-working', 30_000);
      assert.equal(shownAi().check.line, "OpenAI didn't accept this key.");

      // Copilot settings: working once Copilot lists the model and VS Code
      // has let Steptix use it, not checked until then.
      const lm = new FakeLm();
      lm.models = [GPT_41, LUNA];
      h.configureLmBridge({ lm, access: lm, retryMs: 250 });
      fs.writeFileSync(
        machineEnv(),
        withAi(machineBefore, { AI_MODEL: 'gateway/copilot/gpt-6-luna', AI_GATEWAY_URL: 'http://127.0.0.1:9/v1', AI_API_KEY: BRIDGE_TOKEN }),
      );
      await vscode.commands.executeCommand('steptix.welcome');
      await waitFor('Copilot settings to be shown not checked', () => shownAi()?.check?.state === 'not-checked', 30_000);
      assert.match(shownAi().check.line, /VS Code asks whether Steptix may use Copilot/);
      assert.equal(shownAi().bridgeToken, true);
      lm.access = true;
      await h.welcome.send({ type: 'checkAi' });
      await waitFor('Copilot settings to be shown working', () => shownAi()?.check?.state === 'works', 30_000);
    } finally {
      held?.open();
      held = null;
      fs.writeFileSync(machineEnv(), machineBefore);
    }
  });
});
