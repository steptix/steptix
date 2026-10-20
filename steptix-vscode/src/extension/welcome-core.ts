/**
 * The welcome page's pure parts (docs/specs/SPEC-install.md §7): its state,
 * which AI is in use, whether Google Chrome is there, where a sample project
 * goes, and the page's HTML. No `vscode` import, so the `node --test` suite
 * covers it; welcome.ts drives it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { chromeFound } from './install-core.ts';
import * as path from 'node:path';
import {
  AI_PROVIDERS,
  describeAiModel,
  envValueBlank,
  maskKey,
  parseEnv,
  type ModelChoice,
  type ProviderId,
} from 'steptix-runner-core';

export { chromeFound };

export const WELCOME_COMMAND = 'steptix.welcome';
export const CHOOSE_AI_COMMAND = 'steptix.chooseAi';

export type ServerStepState = 'not-installed' | 'installing' | 'ready' | 'yours' | 'unsupported';
export type CopilotState = 'checking' | 'offers-luna' | 'no-luna' | 'none' | 'unavailable';
export type SaveFor = 'all' | 'project';

export interface WelcomeState {
  server: {
    state: ServerStepState;
    /** One line: the version, and the Node.js it runs on; or why not. */
    detail: string;
    /** What the install is doing right now, while it runs. */
    progress: string | null;
    /** `steptix` works in every terminal already (npm's, or PATH added). */
    onPath: boolean;
  };
  ai: {
    /** What is in use, as the status bar says it, or null when none is chosen. */
    chosen: string | null;
    savedFor: SaveFor | null;
    /** The key's last four characters, for a provider. */
    keyHint: string | null;
    copilot: CopilotState;
    copilotModels: ModelChoice[];
    /** The open project's `.env` has an empty `AI_API_KEY=`, which keeps the
     *  all-projects key from reaching it (§7.2). */
    blockedByProject: boolean;
  };
  browser: { chromeFound: boolean };
  folderOpen: boolean;
  providers: Array<{ id: ProviderId; label: string; keyPage: string }>;
}

export const PROVIDER_LIST = AI_PROVIDERS.map(({ id, label, keyPage }) => ({ id, label, keyPage }));

/** The AI in use for a project, from its `.env` and the machine's (§7.2):
 *  the project's own choice wins over the all-projects one. */
export function currentAi(projectEnvText: string, machineEnvText: string): {
  model: string | null;
  key: string | null;
  savedFor: SaveFor | null;
  blockedByProject: boolean;
} {
  const project = parseEnv(projectEnvText);
  const machine = parseEnv(machineEnvText);
  const blockedByProject = envValueBlank(projectEnvText, 'AI_API_KEY');
  const projectKey = project['AI_API_KEY']?.trim() || null;
  const machineKey = blockedByProject ? null : machine['AI_API_KEY']?.trim() || null;
  const projectModel = project['AI_MODEL']?.trim() || null;
  const machineModel = machine['AI_MODEL']?.trim() || null;
  if (projectKey) return { model: projectModel ?? machineModel, key: projectKey, savedFor: 'project', blockedByProject };
  if (machineKey) return { model: projectModel ?? machineModel, key: machineKey, savedFor: 'all', blockedByProject };
  return { model: null, key: null, savedFor: null, blockedByProject };
}

/** The status bar's words for the AI in use (§7.2): `AI: Copilot · GPT 6 Luna`. */
export function aiStatusText(model: string | null): string {
  return model ? `AI: ${describeAiModel(model)}` : 'AI: not chosen';
}

/** A provider's key as the AI step shows it once saved, or null for Copilot. */
export function keyHintFor(model: string | null, key: string | null): string | null {
  return model && key && !model.startsWith('gateway/') ? `key ending ${maskKey(key)}` : null;
}

/** A folder name for a new sample project in `parent` that is not taken. */
export function sampleFolderName(parent: string, exists = existsSync): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'steptix-sample' : `steptix-sample-${n}`;
    if (!exists(path.join(parent, name))) return name;
  }
}

export function readText(file: string): string {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * The welcome page. A shell with the four steps, filled from the state the
 * host posts; everything it does goes back to the host as a message, so the
 * page holds no key longer than the form needs it.
 */
export function welcomeHtml(args: { nonce: string; cspSource: string }): string {
  const { nonce, cspSource } = args;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Welcome to Steptix</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 24px 40px; max-width: 680px; }
  h1 { font-size: 22px; font-weight: 400; margin: 0 0 4px; }
  .lead { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
  section { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444)); border-radius: 6px; padding: 14px 16px; margin-bottom: 10px; }
  section.open { border-color: var(--vscode-focusBorder); }
  .head { display: flex; justify-content: space-between; align-items: center; }
  h2 { font-size: 15px; font-weight: 400; margin: 0; }
  .state { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .state.ok { color: var(--vscode-testing-iconPassed, #89d185); }
  .body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; line-height: 1.5; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { font: inherit; padding: 4px 12px; border: 0; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  input[type=password], input[type=text], select { font: inherit; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  input[type=password] { flex: 1; min-width: 12em; }
  .choice { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 8px 10px; }
  .choice input { margin-top: 3px; }
  .note { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .ok-text { color: var(--vscode-testing-iconPassed, #89d185); }
  .badge { font-size: 11px; padding: 0 7px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 6px; }
  code { font-family: var(--vscode-editor-font-family); }
  .bar { height: 3px; background: var(--vscode-progressBar-background); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
</style>
</head>
<body>
<h1>Welcome to Steptix</h1>
<p class="lead">Four things, and your first test runs. Do them in any order.</p>
<div id="steps" aria-live="polite"></div>
<script nonce="${nonce}">
${WELCOME_SCRIPT}
</script>
</body>
</html>`;
}

/** The page's script, kept apart so the HTML above stays readable. */
const WELCOME_SCRIPT = `
const vscode = acquireVsCodeApi();
let state = null;
const form = { open: null, path: false, saveFor: 'all', mode: null, provider: 'openai', key: '', models: null, model: '', typed: '', keyMessage: '', keyOk: false, busy: '', copilotModel: '' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const post = (message) => vscode.postMessage(message);

function saveForLine() {
  const project = state.folderOpen;
  return '<div class="row note"><label><input type="radio" name="savefor" value="all"' + (form.saveFor === 'all' ? ' checked' : '') + '> For all your projects</label>' +
    '<label><input type="radio" name="savefor" value="project"' + (form.saveFor === 'project' ? ' checked' : '') + (project ? '' : ' disabled') + '> Only this project' + (project ? '' : ' (open a folder first)') + '</label></div>';
}

function serverStep() {
  const s = state.server;
  const label = { 'not-installed': 'Not installed', installing: 'Installing', ready: 'Ready', yours: 'Yours', unsupported: 'Not supported here' }[s.state];
  let body = '<div>' + esc(s.detail) + '</div>';
  if (s.state === 'installing') body += '<div class="bar" role="progressbar" aria-label="Installing"></div>' + (s.progress ? '<div class="note">' + esc(s.progress) + '</div>' : '') + '<div class="note">You can carry on with the steps below while this finishes.</div>';
  if (s.state === 'not-installed') {
    body += '<div class="row"><button id="install">Install server</button>' +
      (s.onPath ? '' : '<label><input type="checkbox" id="addpath"' + (form.path ? ' checked' : '') + '> Also add <code>steptix</code> to PATH, for every terminal</label>') + '</div>';
  }
  if (s.state === 'ready' && !s.onPath) body += '<div><a id="addpath-link">Add steptix to PATH, for every terminal</a></div>';
  return card('server', '1 · Steptix server', label, s.state === 'ready' || s.state === 'yours', body, s.state !== 'ready');
}

function aiStep() {
  const a = state.ai;
  const label = a.chosen ? a.chosen.replace(/^AI: /, '') : (a.copilot === 'checking' ? 'Checking GitHub Copilot…' : 'Not chosen');
  let body = '';
  if (a.blockedByProject) body += '<div class="error">This project\\'s .env has an empty AI_API_KEY= line, which keeps the all-projects choice from reaching it. Remove that line, or save for only this project.</div>';
  if (a.chosen && form.mode === null) {
    body += '<div>' + esc(a.chosen.replace(/^AI: /, '')) + (a.keyHint ? ' · ' + esc(a.keyHint) : '') + '</div>' +
      '<div class="note">' + (a.savedFor === 'project' ? 'For this project.' : 'For all your projects.') + ' <a id="change-ai">Change</a></div>';
    return card('ai', '2 · AI', label, true, body, form.open === 'ai');
  }
  if (a.copilot === 'checking') return card('ai', '2 · AI', label, false, '<div class="note">Checking GitHub Copilot…</div>', true);
  const copilotFirst = a.copilot === 'offers-luna';
  const mode = form.mode === null || form.mode === 'change' ? (copilotFirst ? 'copilot' : 'provider') : form.mode;
  body += '<div>Steptix uses an AI model to understand each step. Which one?</div>';
  const copilotChoice = a.copilot === 'none' || a.copilot === 'unavailable' ? '' :
    '<label class="choice"><input type="radio" name="aimode" value="copilot"' + (mode === 'copilot' ? ' checked' : '') + '><span><span>GitHub Copilot</span>' + (copilotFirst ? '<span class="badge">Offers GPT 6 Luna</span>' : '') +
    '<br><span class="note">' + (copilotFirst ? 'No API key needed. Runs GPT 6 Luna, the model Steptix recommends, on your Copilot plan.' : 'Your Copilot does not offer GPT 6 Luna, the model Steptix recommends. You can still use it with one of the models it does offer.') + '</span></span></label>';
  const providerChoice = '<label class="choice"><input type="radio" name="aimode" value="provider"' + (mode === 'provider' ? ' checked' : '') + '><span><span>An AI provider</span><br><span class="note">OpenAI, Anthropic or OpenRouter, with your own API key.</span></span></label>';
  body += copilotFirst ? copilotChoice + providerChoice : providerChoice + copilotChoice;
  if (mode === 'copilot') {
    const models = a.copilotModels;
    body += '<div class="row"><label for="copilot-model">Copilot model</label><select id="copilot-model">' + models.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === form.copilotModel ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</select></div>' +
      '<div class="note">Uses Copilot requests when Steptix works out or repairs a step. A test that has been compiled runs without any.</div>' +
      saveForLine() + '<div class="row"><button id="use-copilot"' + (form.busy ? ' disabled' : '') + '>Use Copilot</button>' + (form.busy ? '<span class="note">' + esc(form.busy) + '</span>' : '') + '</div>' +
      (form.keyMessage && !form.keyOk ? '<div class="error">' + esc(form.keyMessage) + '</div>' : '');
  } else {
    const p = state.providers.find((x) => x.id === form.provider);
    body += '<div class="row" role="radiogroup" aria-label="Provider">' + state.providers.map((x) => '<button class="' + (x.id === form.provider ? '' : 'secondary') + '" data-provider="' + x.id + '" aria-pressed="' + (x.id === form.provider) + '">' + esc(x.label) + '</button>').join('') + '</div>' +
      '<label for="api-key">' + esc(p.label) + ' API key</label><div class="row"><input id="api-key" type="password" autocomplete="off" value="' + esc(form.key) + '"><button class="secondary" id="check-key"' + (form.busy ? ' disabled' : '') + '>Check key</button></div>' +
      '<div class="row" style="justify-content: space-between"><span class="' + (form.keyOk ? 'ok-text' : 'error') + '">' + esc(form.keyMessage) + '</span><a id="key-page">Get ' + (p.label.match(/^[AEIOU]/) ? 'an ' : 'a ') + esc(p.label) + ' API key</a></div>';
    if (form.models) {
      body += '<label for="model">Model</label><select id="model">' + form.models.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === form.model ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '<option value="">Type a model id…</option></select>' +
        (form.model === '' ? '<input id="typed-model" type="text" placeholder="model id" value="' + esc(form.typed) + '">' : '') +
        saveForLine() + '<div class="row"><button id="save-provider"' + (form.busy ? ' disabled' : '') + '>Save</button>' + (form.busy ? '<span class="note">' + esc(form.busy) + '</span>' : '') + '</div>';
    }
  }
  return card('ai', '2 · AI', label, false, body, true);
}

function browserStep() {
  const found = state.browser.chromeFound;
  const body = found ? '' : '<div>Steptix runs tests in Google Chrome by default, and it was not found on this machine.</div><div class="row"><button id="get-chrome">Get Google Chrome</button></div>';
  return card('browser', '3 · Browser', found ? 'Google Chrome found' : 'Google Chrome not found', found, body, !found);
}

function testStep() {
  const body = '<div>Start from a sample project with one test that runs as it is, or open a folder of your own tests.</div><div class="row"><button id="sample">Create a sample project</button><button class="secondary" id="open-folder">Open a folder</button></div>';
  return card('test', '4 · Your first test', state.folderOpen ? 'Folder open' : 'Next', false, body, true);
}

function card(id, title, label, ok, body, open) {
  return '<section class="' + (open ? 'open' : '') + '" id="step-' + id + '"><div class="head"><h2>' + esc(title) + '</h2><span class="state' + (ok ? ' ok' : '') + '">' + esc(label) + '</span></div>' + (open && body ? '<div class="body">' + body + '</div>' : '') + '</section>';
}

function render() {
  if (!state) return;
  const focused = document.activeElement && document.activeElement.id;
  document.getElementById('steps').innerHTML = serverStep() + aiStep() + browserStep() + testStep();
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a, input[type=radio], input[type=checkbox]');
  if (!t) return;
  if (t.id === 'install') post({ type: 'installServer', addToPath: form.path });
  else if (t.id === 'addpath') { form.path = t.checked; }
  else if (t.id === 'addpath-link') post({ type: 'addToPath' });
  else if (t.id === 'change-ai') { form.mode = 'change'; form.open = 'ai'; post({ type: 'checkCopilot' }); render(); }
  else if (t.name === 'aimode') { form.mode = t.value; render(); }
  else if (t.name === 'savefor') { form.saveFor = t.value; }
  else if (t.dataset && t.dataset.provider) { form.provider = t.dataset.provider; form.models = null; form.keyMessage = ''; form.keyOk = false; render(); }
  else if (t.id === 'check-key') { form.key = document.getElementById('api-key').value; form.busy = 'Checking the key…'; form.keyMessage = ''; render(); post({ type: 'checkKey', provider: form.provider, key: form.key }); }
  else if (t.id === 'key-page') post({ type: 'openKeyPage', provider: form.provider });
  else if (t.id === 'save-provider') {
    const model = form.model === '' ? (document.getElementById('typed-model') || {}).value || '' : form.model;
    if (!model.trim()) { form.keyMessage = 'Type a model id first.'; form.keyOk = false; render(); return; }
    form.busy = 'Saving…'; render();
    post({ type: 'saveProvider', provider: form.provider, key: form.key, model: model.trim(), saveFor: form.saveFor });
  }
  else if (t.id === 'use-copilot') {
    const select = document.getElementById('copilot-model');
    form.busy = 'Waiting for your permission…'; render();
    post({ type: 'useCopilot', modelId: select ? select.value : '', saveFor: form.saveFor });
  }
  else if (t.id === 'get-chrome') post({ type: 'getChrome' });
  else if (t.id === 'sample') post({ type: 'createSample' });
  else if (t.id === 'open-folder') post({ type: 'openFolder' });
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'model') { form.model = e.target.value; render(); }
  if (e.target.id === 'copilot-model') form.copilotModel = e.target.value;
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'api-key') { form.key = e.target.value; form.keyOk = false; }
  if (e.target.id === 'typed-model') form.typed = e.target.value;
});

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type === 'state') {
    state = m.state;
    if (!form.copilotModel && state.ai.copilotModels.length) form.copilotModel = state.ai.copilotModels[0].id;
    if (m.focus) { form.open = m.focus; if (m.focus === 'ai') { form.mode = 'change'; } }
    render();
    if (m.focus) { const el = document.getElementById('step-' + m.focus); if (el) el.scrollIntoView(); }
  } else if (m.type === 'keyChecked') {
    form.busy = '';
    form.keyOk = m.ok;
    form.keyMessage = m.ok ? 'Key works.' : m.message;
    form.models = m.ok ? m.models : null;
    form.model = m.ok && m.models.length ? m.models[0].id : '';
    render();
  } else if (m.type === 'saved') {
    form.busy = '';
    form.mode = null;
    form.key = '';
    form.models = null;
    form.keyMessage = '';
    render();
  } else if (m.type === 'failed') {
    form.busy = '';
    form.keyOk = false;
    form.keyMessage = m.message;
    render();
  }
});

post({ type: 'ready' });
`;
