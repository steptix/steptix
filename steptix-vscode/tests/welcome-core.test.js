/**
 * The welcome page's rules (docs/specs/SPEC-install.md §7): which AI is in
 * use, the status bar's words for it, where a sample goes, Chrome, the page's
 * security policy, the server step's Cancel, the AI step (Copilot not found;
 * the file a key is saved in; settings found being checked, working, not
 * passing or not checked, with where their key is, git's view of it, Open
 * file and Remove key), the notice when Copilot stops answering, and the page
 * coming back after a reload.
 */
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  aiCheckKind,
  aiStatusText,
  chromeFound,
  clearWelcomeReopen,
  copilotSettingsCheck,
  currentAi,
  firstUndoneStep,
  keyHintFor,
  PROVIDER_LIST,
  providerKeyCheck,
  providerModelOf,
  readWelcomeReopen,
  sameFolder,
  sampleFolderName,
  WELCOME_VIEW_TYPE,
  welcomeHtml,
  WELCOME_REOPEN_MAX_AGE_MS,
  welcomeReopenFile,
  withAiModel,
  withoutAiSettings,
  writeWelcomeReopen,
} from '../src/extension/welcome-core.ts';
import { copilotTroubleNotice } from '../src/extension/lm-bridge-core.ts';

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test("the project's own AI choice wins over the one for all projects", () => {
  const machine = 'AI_MODEL=anthropic/claude-sonnet-5-5\nAI_API_KEY=welcome-test-machine-key\n';
  assert.deepEqual(currentAi('', machine), {
    model: 'anthropic/claude-sonnet-5-5',
    key: 'welcome-test-machine-key',
    savedFor: 'all',
    blockedByProject: false,
  });
  assert.deepEqual(currentAi('AI_MODEL=openai/gpt-6-luna\nAI_API_KEY=welcome-test-project-key\n', machine), {
    model: 'openai/gpt-6-luna',
    key: 'welcome-test-project-key',
    savedFor: 'project',
    blockedByProject: false,
  });
});

test('an empty AI_API_KEY= in the project keeps the all-projects key out, and says so', () => {
  const ai = currentAi('AI_API_KEY=\n', 'AI_MODEL=openai/gpt-6-luna\nAI_API_KEY=welcome-test-machine-key\n');
  assert.equal(ai.model, null);
  assert.equal(ai.blockedByProject, true);
});

test('nothing chosen reads as not chosen', () => {
  assert.deepEqual(currentAi('', ''), { model: null, key: null, savedFor: null, blockedByProject: false });
  assert.equal(aiStatusText(null), 'AI: not chosen');
});

test("the status bar names the AI as a person reads it; a provider's key shows only its end", () => {
  assert.equal(aiStatusText('gateway/copilot/gpt-6-luna'), 'AI: Copilot · GPT 6 Luna');
  assert.equal(aiStatusText('openai/gpt-6-luna'), 'AI: OpenAI · GPT 6 Luna');
  assert.equal(keyHintFor('openai/gpt-6-luna', 'welcome-test-key-a1b2'), 'key ending …a1b2');
  assert.equal(keyHintFor('gateway/copilot/gpt-6-luna', 'bridge-token'), null);
});

test('a new sample goes in a folder that is not taken', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'steptix-welcome-'));
  made.push(parent);
  assert.equal(sampleFolderName(parent), 'steptix-sample');
  mkdirSync(path.join(parent, 'steptix-sample'));
  mkdirSync(path.join(parent, 'steptix-sample-2'));
  assert.equal(sampleFolderName(parent), 'steptix-sample-3');
});

/** The page's state as firstUndoneStep reads it: every step done. */
const allDone = () => ({
  server: { state: 'ready' },
  ai: { check: { state: 'works' } },
  browser: { chromeFound: true },
  folderOpen: true,
});

test('the page comes back on the first step still undone, in its order, and not once all are done', () => {
  assert.equal(firstUndoneStep(allDone()), null);
  assert.equal(firstUndoneStep({ ...allDone(), server: { state: 'yours' } }), null, "the user's own server is done");

  for (const state of ['not-installed', 'installing', 'chosen', 'unsupported']) {
    assert.equal(firstUndoneStep({ ...allDone(), server: { state } }), 'server', state);
  }
  assert.equal(firstUndoneStep({ ...allDone(), ai: { check: null } }), 'ai', 'none chosen');
  // Settings already there are done only once their check passes (§7.2).
  for (const state of ['checking', 'not-working', 'not-checked']) {
    assert.equal(firstUndoneStep({ ...allDone(), ai: { check: { state } } }), 'ai', state);
  }
  assert.equal(firstUndoneStep({ ...allDone(), browser: { chromeFound: false } }), 'browser');
  assert.equal(firstUndoneStep({ ...allDone(), folderOpen: false }), 'test');

  // Several undone: the first of them, wherever the others are.
  const none = { server: { state: 'installing' }, ai: { check: null }, browser: { chromeFound: false }, folderOpen: false };
  assert.equal(firstUndoneStep(none), 'server');
  assert.equal(firstUndoneStep({ ...none, server: { state: 'ready' } }), 'ai');
  assert.equal(firstUndoneStep({ ...none, server: { state: 'ready' }, ai: { check: { state: 'works' } } }), 'browser');
});

test("the note that the page comes back names the folder opening, and is gone once used", () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'steptix-welcome-')), 'steptix');
  made.push(path.dirname(root));
  const folder = path.resolve(path.sep, 'projects', 'steptix-sample');
  assert.equal(readWelcomeReopen(root), null);
  writeWelcomeReopen(root, { folder });
  assert.equal(welcomeReopenFile(root), path.join(root, 'welcome-reopen.json'));
  assert.deepEqual(readWelcomeReopen(root), { folder });
  clearWelcomeReopen(root);
  assert.equal(readWelcomeReopen(root), null);
  clearWelcomeReopen(root); // gone already: nothing to say

  writeFileSync(welcomeReopenFile(root), '{"fol');
  assert.equal(readWelcomeReopen(root), null, 'a note cut off while it was written is no note');
  writeFileSync(welcomeReopenFile(root), '{"folder":7}');
  assert.equal(readWelcomeReopen(root), null);
});

test('the note counts only for the few minutes a window takes to reopen', () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'steptix-welcome-')), 'steptix');
  made.push(path.dirname(root));
  const folder = path.resolve(path.sep, 'projects', 'steptix-sample');
  const written = 1_000_000;
  writeWelcomeReopen(root, { folder }, written);
  assert.deepEqual(readWelcomeReopen(root, written + 20_000), { folder });
  assert.deepEqual(readWelcomeReopen(root, written + WELCOME_REOPEN_MAX_AGE_MS), { folder });
  // The folder never opened here (it was open in another window already):
  // a later start of it must not bring the page back.
  assert.equal(readWelcomeReopen(root, written + WELCOME_REOPEN_MAX_AGE_MS + 1), null);
  writeFileSync(welcomeReopenFile(root), JSON.stringify({ folder }));
  assert.equal(readWelcomeReopen(root, written), null, 'a note with no time is no note');
});

test('the folder that opened is the one noted: through links, and in any letter case on Windows', () => {
  const noted = path.resolve(path.sep, 'tmp', 'Projects', 'steptix-sample');
  const linked = path.resolve(path.sep, 'private', 'tmp', 'Projects', 'steptix-sample');
  const noLinks = (p) => p;
  assert.equal(sameFolder(noted, noted, noLinks, 'linux'), true);
  assert.equal(sameFolder(noted, path.join(noted, '..', 'steptix-sample'), noLinks, 'linux'), true, 'resolved first');
  assert.equal(sameFolder(noted, path.resolve(path.sep, 'tmp', 'Projects', 'other'), noLinks, 'linux'), false);

  // macOS's /tmp is /private/tmp; the real path decides.
  const throughLink = (p) => (p.startsWith(path.resolve(path.sep, 'tmp')) ? path.join(path.resolve(path.sep, 'private'), p.slice(path.resolve(path.sep).length)) : p);
  assert.equal(sameFolder(noted, linked, throughLink, 'darwin'), true);

  const lower = noted.toLowerCase();
  assert.equal(sameFolder(noted, lower, noLinks, 'win32'), true, 'Windows file names ignore case');
  assert.equal(sameFolder(noted, lower, noLinks, 'linux'), lower === noted, 'elsewhere case is part of the name');

  const gone = () => {
    throw Object.assign(new Error('no such folder'), { code: 'ENOENT' });
  };
  assert.equal(sameFolder(noted, noted, gone, 'linux'), true, 'a folder that cannot be read is compared as written');
});

test("VS Code starts the extension to restore the page after a reload: package.json names the page's webview", () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(
    manifest.activationEvents.includes(`onWebviewPanel:${WELCOME_VIEW_TYPE}`),
    `activationEvents: ${JSON.stringify(manifest.activationEvents)}`,
  );
});

test('Chrome is found where it installs', () => {
  const env = { ProgramFiles: 'C:\\Program Files' };
  const expected = path.win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(chromeFound('win32', env, (p) => p === expected), true);
  assert.equal(chromeFound('win32', env, () => false), false);
  assert.equal(chromeFound('linux', {}, (p) => p === '/usr/bin/google-chrome-stable'), true);
});

test('the page runs only its own script and style, by nonce', () => {
  const html = welcomeHtml({ nonce: 'welcome-test-nonce', cspSource: 'vscode-resource:' });
  assert.match(html, /default-src 'none'; style-src vscode-resource: 'nonce-welcome-test-nonce'; script-src 'nonce-welcome-test-nonce';/);
  assert.equal(html.match(/<script nonce="welcome-test-nonce">/g)?.length, 1);
  assert.match(html, /<title>Welcome to Steptix<\/title>/);
});

/**
 * The page's own script, run with just enough of a DOM to see what it draws
 * and what it posts: `receive` is a message from the host, `click` a click
 * on the element with that id.
 */
function welcomePage() {
  const html = welcomeHtml({ nonce: 'welcome-test-nonce', cspSource: 'vscode-resource:' });
  const script = /<script nonce="welcome-test-nonce">([\s\S]*?)<\/script>/.exec(html)[1];
  const posted = [];
  const listeners = {};
  const steps = { innerHTML: '' };
  /** Text fields typed into, by id, as the script reads them back. */
  const fields = {};
  vm.runInNewContext(script, {
    // Copied, as postMessage copies: what reaches the host is data, not the page's objects.
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))) }),
    document: {
      activeElement: null,
      getElementById: (id) => (id === 'steps' ? steps : fields[id] ?? null),
      addEventListener: (type, fn) => (listeners[type] = fn),
    },
    window: { addEventListener: (type, fn) => (listeners[`window ${type}`] = fn) },
  });
  return {
    posted,
    drawn: () => steps.innerHTML,
    receive: (data) => listeners['window message']({ data }),
    click: (id) => listeners.click({ target: { closest: () => ({ id, dataset: {} }) } }),
    /** A select changed, or text typed, in the element with that id. */
    change: (id, value) => listeners.change({ target: { id, value } }),
    /** The entries' radio group moved to `value`, as the arrow keys move it. */
    choose: (value, { disabled = false } = {}) => listeners.change({ target: { id: `entry-${value}`, name: 'aientry', value, disabled } }),
    input: (id, value) => {
      fields[id] = { id, value };
      listeners.input({ target: fields[id] });
    },
  };
}

/** The files the AI step names, as native paths. */
const ALL_PROJECTS_ENV = path.resolve(path.sep, 'home', 'ada', 'steptix', '.env');
const PROJECT_ENV = path.resolve(path.sep, 'work', 'shop', '.env');

function pageState(server) {
  return {
    server: { detail: 'Installing the Steptix server.', progress: null, onPath: false, ...server },
    ai: {
      chosen: null,
      keyHint: null,
      providerModel: null,
      bridgeToken: false,
      copilot: 'none',
      copilotInstalled: false,
      copilotModels: [],
      blockedByProject: false,
      projectOwn: false,
      saveTo: ALL_PROJECTS_ENV,
      found: null,
      check: null,
    },
    browser: { chromeFound: true },
    folderOpen: true,
    providers: PROVIDER_LIST,
  };
}

test("while the server installs, its step offers Cancel, which asks the host to stop the install (§5.2)", () => {
  const page = welcomePage();
  page.receive({ type: 'state', state: pageState({ state: 'installing', progress: 'Downloading steptix 1.4.2' }) });
  assert.match(page.drawn(), /<button class="secondary" id="cancel-install">Cancel<\/button>/);
  assert.match(page.drawn(), /Downloading steptix 1\.4\.2/);

  page.click('cancel-install');
  assert.deepEqual(page.posted.at(-1), { type: 'cancelInstall' });

  // Cancelled: back to Install, and nothing to cancel.
  page.receive({ type: 'state', state: pageState({ state: 'not-installed', detail: 'Runs your tests on this machine.' }) });
  assert.doesNotMatch(page.drawn(), /cancel-install/);
  assert.match(page.drawn(), /<button id="install">Install server<\/button>/);
});

/** The page with this AI step, the server ready; and the AI card it draws. */
function aiPage(ai) {
  const page = welcomePage();
  const state = pageState({ state: 'ready', detail: 'Steptix 1.0.0.', onPath: true });
  page.receive({ type: 'state', state: { ...state, ai: { ...state.ai, ...ai } } });
  const card = () => /<section[^>]*id="step-ai">[\s\S]*?<\/section>/.exec(page.drawn())[0];
  /** The card's header state, and its colour: ok (green) or grey. */
  const header = () => {
    const [, tone, label] = /<span class="state( ok)?">([^<]*)<\/span>/.exec(card());
    return { label, tone: tone?.trim() ?? 'grey' };
  };
  return { ...page, card, header };
}

/** A path as the page writes it, HTML-escaped, for a pattern. */
const pathPattern = (p) => p.replace(/[\\.]/g, (c) => `\\${c}`);

const OPENAI_SAVED = {
  chosen: 'AI: OpenAI · GPT 6 Luna',
  keyHint: 'key ending …a1b2',
  found: { file: ALL_PROJECTS_ENV, project: false, git: null },
};

/** The entries the AI card lists, in order: each one's radio, of the one
 *  group, checked when it is the open entry, disabled when it cannot be. */
const entries = (card) =>
  [...card.matchAll(/<input type="radio" name="aientry" value="([a-z]+)" id="entry-\1"( checked)?( disabled)?>/g)].map(([, id, checked, disabled]) => ({
    id,
    open: checked !== undefined,
    disabled: disabled !== undefined,
  }));
const LUNA_MODELS = [{ id: 'gpt-6-luna', label: 'GPT 6 Luna · recommended for Steptix', recommended: true }];
const GOOD_MODELS = [{ id: 'gpt-6-luna', label: 'GPT 6 Luna · recommended for Steptix', recommended: true }, { id: 'gpt-6-mini', label: 'gpt-6-mini', recommended: false }];

/** Type a key into the open entry's field, press Check key, and have the host answer. */
function checkKey(page, key, answer) {
  page.input('api-key', key);
  page.click('check-key');
  page.receive({ type: 'keyChecked', ...answer });
}

test('one list of four entries, always in the same order; OpenAI open unless Copilot offers GPT 6 Luna (§7.2)', () => {
  const order = ['copilot', 'openai', 'anthropic', 'openrouter'];
  for (const [copilot, open] of [['offers-luna', 'copilot'], ['no-luna', 'openai'], ['none', 'openai'], ['unavailable', 'openai']]) {
    const card = aiPage({ copilot, copilotModels: LUNA_MODELS }).card();
    assert.deepEqual(entries(card).map((e) => e.id), order, copilot);
    assert.deepEqual(entries(card).filter((e) => e.open).map((e) => e.id), [open], `${copilot}: one radio checked, the open entry's`);
    assert.equal(card.match(/name="aientry"/g).length, 4, 'one radio group');
    assert.match(card, new RegExp(`<div class="entry open"><label class="entry-head"><input type="radio" name="aientry" value="${open}"`), 'the open box is marked');
  }
  const card = aiPage({ copilot: 'offers-luna', copilotModels: LUNA_MODELS }).card();
  assert.match(card, /GitHub Copilot<span class="badge">Offers GPT 6 Luna<\/span><\/span><br><span class="note">No API key needed\. Runs on your Copilot plan\.<\/span>/);
  assert.match(card, /OpenAI<\/span><br><span class="note">With your own API key\.<\/span>/);
  assert.match(card, /Anthropic<\/span><br><span class="note">With your own API key\.<\/span>/);
  assert.match(card, /OpenRouter<\/span><br><span class="note">One key for many providers' models\.<\/span>/);
  assert.doesNotMatch(card, /An AI provider|data-provider|name="aimode"/, 'no second level, no provider buttons');
  // Copilot there without GPT 6 Luna: no badge, and its form says so.
  const noLuna = aiPage({ copilot: 'no-luna', copilotModels: LUNA_MODELS });
  assert.doesNotMatch(noLuna.card(), /Offers GPT 6 Luna/);
  noLuna.click('entry-copilot');
  assert.match(noLuna.card(), /Your Copilot does not offer GPT 6 Luna, the model Steptix recommends\./);
  // While Copilot is being looked for, nothing opens on its own.
  assert.deepEqual(entries(aiPage({ copilot: 'checking' }).card()).filter((e) => e.open), []);
  // A key being typed into OpenAI keeps it open when Copilot turns up.
  const typing = aiPage({ copilot: 'none' });
  typing.input('api-key', 'typing-test-key');
  const later = pageState({ state: 'ready', detail: 'Steptix 1.0.0.', onPath: true });
  typing.receive({ type: 'state', state: { ...later, ai: { ...later.ai, copilot: 'offers-luna', copilotModels: LUNA_MODELS } } });
  assert.deepEqual(entries(typing.card()).filter((e) => e.open).map((e) => e.id), ['openai']);
});

test('opening an entry opens its form inside its own box and closes the one open', () => {
  const page = aiPage({ copilot: 'offers-luna', copilotModels: LUNA_MODELS });
  page.click('entry-anthropic');
  assert.deepEqual(entries(page.card()).filter((e) => e.open).map((e) => e.id), ['anthropic']);
  // Its form sits inside its own box: after its head, before the next entry's.
  const card = page.card();
  const anthropicBox = card.slice(card.indexOf('id="entry-anthropic"'), card.indexOf('id="entry-openrouter"'));
  assert.match(anthropicBox, /<label for="api-key">Anthropic API key<\/label>/);
  assert.match(anthropicBox, /<a id="key-page">Get an Anthropic API key<\/a>/);
  assert.doesNotMatch(page.card(), /id="use-copilot"/, 'the Copilot form closed');
  page.click('key-page');
  assert.deepEqual(page.posted.at(-1), { type: 'openKeyPage', provider: 'anthropic' });
  page.click('entry-openrouter');
  assert.match(page.card(), /OpenRouter API key/);
  assert.doesNotMatch(page.card(), /Anthropic API key/);
  assert.deepEqual(entries(page.card()).filter((e) => e.open).map((e) => e.id), ['openrouter']);

  // The arrow keys move the group's choice, which VS Code's webview reports as a change.
  page.choose('openai');
  assert.deepEqual(entries(page.card()).filter((e) => e.open).map((e) => e.id), ['openai']);
  assert.match(page.card(), /OpenAI API key/);
});

test('Copilot unavailable: first, greyed, cannot be opened; not installed or installed-but-no-models, with its links (§7.2)', () => {
  for (const copilot of ['none', 'unavailable']) {
    const page = aiPage({ copilot });
    const card = page.card();
    assert.equal(entries(card)[0].id, 'copilot', 'stays first');
    assert.match(card, /<div class="entry unavailable"><label class="entry-head"><input type="radio" name="aientry" value="copilot" id="entry-copilot" disabled>/, copilot);
    assert.deepEqual(entries(card).filter((e) => e.disabled).map((e) => e.id), ['copilot'], 'only its radio is disabled');
    assert.match(card, /Not found in this VS Code\. Install GitHub Copilot and sign in to use it with no API key\./);
    assert.match(card, /<a id="install-copilot">Install GitHub Copilot<\/a> · <a id="check-copilot">Check again<\/a>/);
    page.choose('copilot', { disabled: true });
    assert.deepEqual(entries(page.card()).filter((e) => e.open).map((e) => e.id), ['openai'], 'cannot be opened');
    page.click('install-copilot');
    assert.deepEqual(page.posted.at(-1), { type: 'installCopilot' });
    page.click('check-copilot');
    assert.deepEqual(page.posted.at(-1), { type: 'checkCopilot' });
  }
  // Installed but offering no models: sign in, not install.
  const signIn = aiPage({ copilot: 'none', copilotInstalled: true }).card();
  assert.match(signIn, /GitHub Copilot is installed but offers no models\. Sign in to GitHub Copilot, or check that your Copilot plan includes chat\.<\/span><\/span><\/label><div class="entry-links"><a id="check-copilot">Check again<\/a><\/div>/);
  assert.equal(entries(signIn)[0].disabled, true);
  assert.doesNotMatch(signIn, /install-copilot|Not found in this VS Code/);
  // With no language-model API at all, installing is still the way.
  assert.match(aiPage({ copilot: 'unavailable', copilotInstalled: true }).card(), /Not found in this VS Code/);
});

test('the page saves only for all projects, and names the file above Save and Use Copilot (§7.2)', () => {
  const page = aiPage({});
  checkKey(page, 'save-test-key', { ok: true, models: LUNA_MODELS });
  const saveBlock = new RegExp(`<div class="save-to"><div class="note">The key will be saved in</div><code>${pathPattern(ALL_PROJECTS_ENV)}</code></div><div class="row"><button id="save-provider">Save</button>`);
  assert.match(page.drawn(), saveBlock);
  assert.doesNotMatch(page.drawn(), /savefor|Only this project|For all your projects/, 'no choice of where');
  page.click('save-provider');
  assert.deepEqual(page.posted.at(-1), { type: 'saveProvider', provider: 'openai', key: 'save-test-key', model: 'gpt-6-luna' });

  const copilot = aiPage({ copilot: 'offers-luna', copilotModels: LUNA_MODELS });
  assert.match(copilot.card(), new RegExp(`<div class="note">Saved in</div><code>${pathPattern(ALL_PROJECTS_ENV)}</code></div><div class="row"><button id="use-copilot">`));
  copilot.click('use-copilot');
  // The model comes from the select, which this stand-in DOM does not have;
  // what matters is that no choice of file goes with it.
  assert.deepEqual(Object.keys(copilot.posted.at(-1)).sort(), ['modelId', 'type']);
  assert.equal(copilot.posted.at(-1).type, 'useCopilot');
});

test("a project whose .env sets its own AI says so beside Save; its empty AI_API_KEY= is still called out", () => {
  const own = "This project's .env has its own AI settings, which win over these in this project.";
  const page = aiPage({ projectOwn: true });
  checkKey(page, 'own-test-key', { ok: true, models: LUNA_MODELS });
  assert.match(page.drawn(), new RegExp(`<button id="save-provider">Save</button><span class="note">${own.replace(/\./g, '\\.')}</span></div>`));
  assert.doesNotMatch(aiPage({}).card(), /has its own AI settings/);
  assert.match(aiPage({ blockedByProject: true }).card(), /has an empty AI_API_KEY= line/);
});

test("a key's result belongs to the key in the field: changed, emptied or another entry opened, it goes (§7.2)", () => {
  const page = aiPage({});
  checkKey(page, 'result-test-key', { ok: true, models: GOOD_MODELS });
  assert.match(page.card(), /<span class="ok-text">Key works\.<\/span>/);
  assert.match(page.card(), /id="save-provider"/);
  page.input('api-key', 'result-test-ke');
  assert.doesNotMatch(page.card(), /Key works\.|id="save-provider"/, 'a changed key');

  checkKey(page, 'result-test-key', { ok: true, models: GOOD_MODELS });
  page.input('api-key', '');
  assert.doesNotMatch(page.card(), /Key works\./, 'an emptied field');

  checkKey(page, 'result-test-key', { ok: false, message: 'OpenAI did not accept this key. Check that you copied all of it, or make a new one.' });
  assert.match(page.card(), /<span class="error">OpenAI did not accept this key\./);
  page.click('entry-anthropic');
  assert.doesNotMatch(page.card(), /did not accept this key/, 'another entry opened');
  assert.match(page.card(), /id="api-key" type="password" autocomplete="off" value=""/, 'its field starts empty');

  // An answer for a key no longer in the field, or one never asked about, shows nothing.
  page.input('api-key', 'first-test-key');
  page.click('check-key');
  page.input('api-key', 'second-test-key');
  page.receive({ type: 'keyChecked', ok: true, models: GOOD_MODELS });
  assert.doesNotMatch(page.card(), /Key works\./, 'the answer was for the key typed before');
  page.receive({ type: 'keyChecked', ok: true, models: GOOD_MODELS });
  assert.doesNotMatch(page.card(), /Key works\./, 'nobody asked');
});

test('no AI set up: the header asks for it, in grey, and the choices are open', () => {
  const page = aiPage({});
  assert.deepEqual(page.header(), { label: 'Set up AI', tone: 'grey' });
  assert.match(page.card(), /Which one\?/);
  assert.doesNotMatch(page.card(), /class="settings"/);
});

test('settings found: Checking… in grey while the key is checked, never green before it passes (§7.2)', () => {
  const page = aiPage({ ...OPENAI_SAVED, check: { state: 'checking', line: null } });
  assert.deepEqual(page.header(), { label: 'Checking…', tone: 'grey' });
  const card = page.card();
  assert.match(card, /<div class="heading">Found in your settings<\/div><div>OpenAI · GPT 6 Luna · key ending …a1b2<\/div><div class="note">Checking…<\/div>/);
  assert.doesNotMatch(card, /In use|ok-text/);
});

test('settings that work: In use, the name in green, what the provider said, where the key is, and the choices folded', () => {
  const page = aiPage({ ...OPENAI_SAVED, check: { state: 'works', line: 'OpenAI accepted the key.' } });
  assert.deepEqual(page.header(), { label: 'OpenAI · GPT 6 Luna', tone: 'ok' });
  const card = page.card();
  assert.match(card, /<div class="heading">In use<\/div><div>OpenAI · GPT 6 Luna · key ending …a1b2<\/div><div class="ok-text">OpenAI accepted the key\.<\/div>/);
  assert.match(card, new RegExp(`<div class="note">Key saved in</div><div><code>${pathPattern(ALL_PROJECTS_ENV)}</code></div>`));
  assert.doesNotMatch(card, /This project only|check-ai/);
  assert.match(card, /<a id="open-env">Open file<\/a> · <a id="remove-key">Remove key<\/a>/);
  assert.match(card, /<a id="different-ai">Choose a different AI provider<\/a>/);
  assert.doesNotMatch(card, /Which one\?|id="api-key"/, 'the choices are folded');

  page.click('different-ai');
  assert.match(page.card(), /Which one\?/, 'unfolded');
  assert.deepEqual(page.posted.at(-1), { type: 'checkCopilot' });
  page.click('different-ai');
  assert.doesNotMatch(page.card(), /Which one\?/, 'folded again');

  page.click('open-env');
  assert.deepEqual(page.posted.at(-1), { type: 'openEnvFile' });
  page.click('remove-key');
  assert.deepEqual(page.posted.at(-1), { type: 'removeKey' });
});

test('a working provider key: a Model list from its own check, on the model in use, and Save once another is picked', () => {
  const models = [
    { id: 'gpt-6-luna', label: 'GPT 6 Luna · recommended for Steptix', recommended: true },
    { id: 'gpt-6-mini', label: 'gpt-6-mini', recommended: false },
  ];
  const working = (id) => ({
    ...OPENAI_SAVED,
    providerModel: { provider: 'openai', id },
    check: { state: 'works', line: 'OpenAI accepted the key.', models },
  });
  const page = aiPage(working('gpt-6-luna'));
  const list = () => /<select id="saved-model">[\s\S]*?<\/select>/.exec(page.card())?.[0] ?? '';
  assert.equal(
    list(),
    '<select id="saved-model"><option value="gpt-6-luna" selected>GPT 6 Luna · recommended for Steptix</option>' +
      '<option value="gpt-6-mini">gpt-6-mini</option><option value="">Type a model id…</option></select>',
    'the recommended model first, then the rest, then Type a model id…, on the model in use',
  );
  assert.doesNotMatch(page.card(), /save-model/, 'nothing to save yet');
  assert.doesNotMatch(page.card(), /a1b2[^<]*<\/option>|good-key|value="key/, 'no key in the list');

  page.change('saved-model', 'gpt-6-mini');
  assert.match(page.card(), /<button id="save-model">Save<\/button>/);
  page.click('save-model');
  assert.deepEqual(page.posted.at(-1), { type: 'saveModel', model: 'gpt-6-mini' });
  page.change('saved-model', 'gpt-6-luna');
  assert.doesNotMatch(page.card(), /save-model/, 'back on the model in use');

  // Typed: Save once the id is another model.
  page.change('saved-model', '');
  assert.match(page.card(), /<input id="saved-typed" type="text" placeholder="model id" value="">/);
  page.input('saved-typed', 'gpt-7-preview');
  page.click('save-model');
  assert.deepEqual(page.posted.at(-1), { type: 'saveModel', model: 'gpt-7-preview' });
  page.receive({ type: 'modelSaved' });
  assert.doesNotMatch(page.card(), /save-model/);

  // A model the provider did not list shows as typed.
  const unlisted = aiPage(working('gpt-legacy'));
  assert.match(unlisted.card(), /<option value="" selected>Type a model id…<\/option><\/select><input id="saved-typed" type="text" placeholder="model id" value="gpt-legacy">/);
  assert.doesNotMatch(unlisted.card(), /save-model/);

  // Not for Copilot or a gateway, nor before the key passes.
  assert.doesNotMatch(aiPage({ ...working('gpt-6-luna'), providerModel: null }).card(), /saved-model/);
  assert.doesNotMatch(aiPage({ ...working('gpt-6-luna'), check: { state: 'not-working', line: "OpenAI didn't accept this key." } }).card(), /saved-model/);
});

test('the Model list writes AI_MODEL only, with its provider, and keeps the key and every other line', () => {
  const before = 'STEPTIX_SERVER_URL=http://127.0.0.1:3100\nAI_MODEL=openai/gpt-6-luna\nAI_API_KEY=model-test-key\n';
  assert.equal(withAiModel(before, 'openai', 'gpt-6-mini'), 'STEPTIX_SERVER_URL=http://127.0.0.1:3100\nAI_MODEL=openai/gpt-6-mini\nAI_API_KEY=model-test-key\n');
  assert.equal(withAiModel('AI_API_KEY=model-test-key\n', 'openrouter', 'openai/gpt-6-luna'), 'AI_API_KEY=model-test-key\nAI_MODEL=openrouter/openai/gpt-6-luna\n');
  assert.deepEqual(providerModelOf('openrouter/openai/gpt-6-luna'), { provider: 'openrouter', id: 'openai/gpt-6-luna' });
  assert.deepEqual(providerModelOf('anthropic/claude-sonnet-5-5'), { provider: 'anthropic', id: 'claude-sonnet-5-5' });
  assert.equal(providerModelOf('gateway/copilot/gpt-6-luna'), null);
  assert.equal(providerModelOf(null), null);
  assert.deepEqual(providerKeyCheck('openai', { ok: true, models: ['gpt-6-mini', 'gpt-6-luna'] }).models.map((m) => m.id), ['gpt-6-luna', 'gpt-6-mini']);
});

test("settings whose key did not pass: Set up AI in grey, what the provider said, Check again, and the choices open", () => {
  const page = aiPage({ ...OPENAI_SAVED, check: { state: 'not-working', line: "OpenAI didn't accept this key." } });
  assert.deepEqual(page.header(), { label: 'Set up AI', tone: 'grey' });
  const card = page.card();
  assert.match(card, /<div class="heading">Found in your settings<\/div>/);
  assert.match(card, /<div>OpenAI didn&#39;t accept this key\. <a id="check-ai">Check again<\/a><\/div>/);
  assert.doesNotMatch(card, /did not accept this key\. Check that you copied/, "not Check key's words for a key just pasted");
  assert.match(card, /<a id="remove-key">Remove key<\/a>/);
  assert.match(card, /Which one\?/, 'the choices are open');
  assert.doesNotMatch(card, /different-ai/);

  page.click('check-ai');
  assert.deepEqual(page.posted.at(-1), { type: 'checkAi' });
});

test("a project's own .env: This project only., and what git would do with the key", () => {
  const inProject = (git) =>
    aiPage({ ...OPENAI_SAVED, found: { file: PROJECT_ENV, project: true, git }, check: { state: 'works', line: 'OpenAI accepted the key.' } }).card();
  assert.match(inProject('safe'), new RegExp(`<code>${pathPattern(PROJECT_ENV)}</code> This project only\\.</div>`));
  assert.doesNotMatch(inProject('safe'), /Git does not ignore|in git/);

  assert.match(
    inProject('not-ignored'),
    /<div class="error">Git does not ignore this file, so the key would go into a commit\. <a id="ignore-env">Add \.env to \.gitignore<\/a><\/div>/,
  );
  assert.match(inProject('committed'), /This file is in git: the key is in its history\. Rotate the key, and run git rm --cached \.env\./);
  assert.doesNotMatch(inProject(null), /Git does not ignore|in git/, 'nothing said until git has answered');

  const page = aiPage({ ...OPENAI_SAVED, found: { file: PROJECT_ENV, project: true, git: 'not-ignored' }, check: { state: 'works', line: 'x' } });
  page.click('ignore-env');
  assert.deepEqual(page.posted.at(-1), { type: 'ignoreEnv' });
});

test("Copilot settings: the key is the bridge's local token, and one not checked shows its name in grey, with why", () => {
  const page = aiPage({
    chosen: 'AI: Copilot · GPT 6 Luna',
    keyHint: null,
    bridgeToken: true,
    found: { file: ALL_PROJECTS_ENV, project: false, git: null },
    check: { state: 'not-checked', line: 'Not checked: runs will show whether it works.' },
  });
  assert.deepEqual(page.header(), { label: 'Copilot · GPT 6 Luna', tone: 'grey' });
  const card = page.card();
  assert.match(card, /<div>Copilot · GPT 6 Luna<\/div>/);
  assert.match(
    card,
    /<div class="note">Steptix will use GitHub Copilot through VS Code's Copilot bridge only while authoring, compiling or running tests in VS Code\.<\/div>/,
  );
  assert.doesNotMatch(card, /key ending/);
  // What is saved for Copilot is the bridge's settings, not a key of the user's.
  assert.match(card, /<div class="note">Settings saved in<\/div>/);
  assert.doesNotMatch(card, /Key saved in/);
  assert.match(card, /<div>Not checked: runs will show whether it works\. <a id="check-ai">Check again<\/a><\/div>/);
  assert.match(card, /Which one\?/, 'the choices are open while nothing works');
});

test("what a provider said of a saved key: accepted, didn't accept, or couldn't check with the reason", () => {
  const accepted = providerKeyCheck('openai', { ok: true, models: [] });
  assert.equal(accepted.state, 'works');
  assert.equal(accepted.line, 'OpenAI accepted the key.');
  assert.deepEqual(providerKeyCheck('anthropic', { ok: false, reason: 'rejected', message: 'Anthropic did not accept this key. Check that you copied all of it, or make a new one.' }), {
    state: 'not-working',
    line: "Anthropic didn't accept this key.",
  });
  assert.deepEqual(providerKeyCheck('openrouter', { ok: false, reason: 'unreachable', message: 'Could not reach OpenRouter: ENOTFOUND.' }), {
    state: 'not-working',
    line: "Couldn't check it. Could not reach OpenRouter: ENOTFOUND.",
  });
  assert.equal(providerKeyCheck('openai', { ok: false, reason: 'unexpected', message: 'OpenAI answered HTTP 500.' }).line, "Couldn't check it. OpenAI answered HTTP 500.");
});

test('Remove key takes out the AI lines and keeps every other line', () => {
  const before = 'STEPTIX_SERVER_URL=http://127.0.0.1:3100\nAI_MODEL=openai/gpt-6-luna\nAI_API_KEY=remove-test-key\nAI_GATEWAY_URL=http://127.0.0.1:18790/v1\nSTEPTIX_SERVER_API_KEY=remove-test-server-key\n';
  assert.equal(withoutAiSettings(before), 'STEPTIX_SERVER_URL=http://127.0.0.1:3100\nSTEPTIX_SERVER_API_KEY=remove-test-server-key\n');
  assert.equal(withoutAiSettings('OTHER=1\n'), 'OTHER=1\n');
});

test('how settings already there are checked: a provider by its key, Copilot by what VS Code says, the rest not at all', () => {
  assert.deepEqual(aiCheckKind('openai/gpt-6-luna'), { kind: 'provider', provider: 'openai' });
  assert.deepEqual(aiCheckKind('anthropic/claude-sonnet-5-5'), { kind: 'provider', provider: 'anthropic' });
  assert.deepEqual(aiCheckKind('openrouter/openai/gpt-6-luna'), { kind: 'provider', provider: 'openrouter' });
  assert.deepEqual(aiCheckKind('gateway/copilot/gpt-6-luna'), { kind: 'copilot', model: 'copilot/gpt-6-luna' });
  assert.deepEqual(aiCheckKind('gateway/acme/model-7'), { kind: 'other' });
  assert.deepEqual(aiCheckKind('model-7'), { kind: 'other' });
});

test('Copilot settings work once Copilot lists the model and VS Code lets Steptix use it; else not checked, with why', () => {
  const luna = (canSendRequest) => [
    { vendor: 'copilot', id: 'gpt-4.1', canSendRequest: true },
    { vendor: 'copilot', id: 'gpt-6-luna', canSendRequest },
  ];
  // Works, with no line of its own: the block already says how Steptix uses
  // Copilot, and the header is green.
  assert.deepEqual(copilotSettingsCheck('copilot/gpt-6-luna', luna(true)), { state: 'works', line: null });
  for (const [models, reason] of [
    [null, /Copilot was not found in this VS Code/],
    [[], /Copilot was not found in this VS Code/],
    [[{ vendor: 'copilot', id: 'gpt-4.1', canSendRequest: true }], /Copilot does not offer Copilot · GPT 6 Luna in this VS Code/],
    [luna(false), /VS Code has not let Steptix use Copilot/],
    [luna(undefined), /VS Code asks whether Steptix may use Copilot/],
  ]) {
    const check = copilotSettingsCheck('copilot/gpt-6-luna', models);
    assert.equal(check.state, 'not-checked', JSON.stringify(models));
    assert.match(check.line, /^Not checked: /);
    assert.match(check.line, reason);
  }
});

test('working Copilot settings: green, how Steptix uses Copilot, and no status line under it', () => {
  const page = aiPage({
    chosen: 'AI: Copilot · GPT 6 Luna',
    bridgeToken: true,
    found: { file: ALL_PROJECTS_ENV, project: false, git: null },
    check: { state: 'works', line: null },
  });
  assert.deepEqual(page.header(), { label: 'Copilot · GPT 6 Luna', tone: 'ok' });
  const card = page.card();
  assert.match(card, /only while authoring, compiling or running tests in VS Code\./);
  assert.doesNotMatch(card, /class="ok-text"/, 'no line saying it works: the header does');
  assert.doesNotMatch(card, /null/);
});

test('Copilot stopping answering gets the notice with its way out, in the spec\'s words', () => {
  const err = (code, message = '') => ({ status: 429, body: { error: { code, message, type: 'x' } } });
  assert.equal(
    copilotTroubleNotice(err('quota_exhausted')),
    "Copilot has used up this month's requests. Compiled tests still run. To keep working now, switch to an AI provider.",
  );
  assert.equal(
    copilotTroubleNotice(err('model_not_found', 'Copilot no longer offers "copilot/gpt-6-luna"')),
    'Your Copilot no longer offers GPT 6 Luna. Pick another Copilot model, or switch to an AI provider.',
  );
  assert.match(copilotTroubleNotice(err('no_permissions')), /no longer has permission to use Copilot/);
  assert.equal(copilotTroubleNotice(err('lm_error')), null);
});
