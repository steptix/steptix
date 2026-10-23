/**
 * The welcome page's pure parts (docs/specs/SPEC-install.md §7): its state,
 * which AI is in use, whether Google Chrome is there, where a sample project
 * goes, which step it comes back on after a reload, and the page's HTML. No
 * `vscode` import, so the `node --test` suite covers it; welcome.ts drives it.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { chromeFound } from './install-core.ts';
import * as path from 'node:path';
import {
  AI_PROVIDERS,
  aiModelFor,
  describeAiModel,
  envValueBlank,
  maskKey,
  modelChoices,
  parseEnv,
  setEnvValues,
  type KeyCheck,
  type ModelChoice,
  type ProviderId,
} from 'steptix-runner-core';

export { chromeFound };

export const WELCOME_COMMAND = 'steptix.welcome';
export const CHOOSE_AI_COMMAND = 'steptix.chooseAi';
/** The page's webview type, which its serializer is registered for and
 *  package.json's `onWebviewPanel:` activation event names. */
export const WELCOME_VIEW_TYPE = 'steptix.welcome';

export type ServerStepState = 'not-installed' | 'installing' | 'ready' | 'yours' | 'unsupported' | 'chosen';
export type CopilotState = 'checking' | 'offers-luna' | 'no-luna' | 'none' | 'unavailable';
/** Which `.env` holds the key: the one for all projects, or the open project's. */
export type SaveFor = 'all' | 'project';

/** Where git stands with a project's `.env` that holds a key (§7.2):
 *  `not-ignored` when a commit would pick it up, `committed` when git tracks
 *  it already, `safe` otherwise. */
export type EnvGitState = 'safe' | 'not-ignored' | 'committed';

/**
 * How the AI the `.env` files already name stands (§7.2, Settings already
 * there): being checked, shown to work, shown not to (its key did not pass),
 * or something the page cannot check. Only `works` shows as done.
 */
export interface AiCheck {
  state: 'checking' | 'works' | 'not-working' | 'not-checked';
  /** What the check found, as the settings block says it ("OpenAI accepted
   *  the key."), or why it was not checked; null while it runs. */
  line: string | null;
  /** A provider key that passed: the models that same check listed, as the
   *  provider's entry lists them, for the block's Model list. */
  models?: ModelChoice[];
}

export const AI_CHECKING: AiCheck = { state: 'checking', line: null };

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
    /** The key's last four characters, for a provider. */
    keyHint: string | null;
    /** The provider and model id of provider settings, which the settings
     *  block's Model list starts on; null for Copilot or a gateway. */
    providerModel: { provider: ProviderId; id: string } | null;
    /** The key is the local token for VS Code's Copilot bridge, not a
     *  provider's key. */
    bridgeToken: boolean;
    copilot: CopilotState;
    /** The GitHub Copilot extension is installed, whether or not it offers
     *  models: with none, the step says to sign in rather than to install. */
    copilotInstalled: boolean;
    copilotModels: ModelChoice[];
    /** The open project's `.env` has an empty `AI_API_KEY=`, which keeps the
     *  all-projects key from reaching it (§7.2). */
    blockedByProject: boolean;
    /** The open project's `.env` sets `AI_MODEL` or `AI_API_KEY` of its own,
     *  which win over what the page saves, in that project. */
    projectOwn: boolean;
    /** The file the page saves to: the one for all projects (§7.2). */
    saveTo: string;
    /** The settings found: the file that holds their key, whether it is the
     *  open project's, and git's view of a project's file (null while it is
     *  asked, or for the all-projects file). Null when none are found. */
    found: { file: string; project: boolean; git: EnvGitState | null } | null;
    /** The check of `chosen`, or null when nothing is chosen. */
    check: AiCheck | null;
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

/** The Extensions view's search for GitHub Copilot, for **Install GitHub
 *  Copilot** (§7.2). */
export const COPILOT_EXTENSION_SEARCH = '@id:GitHub.copilot-chat';

/** The extensions that are GitHub Copilot: either one installed means the
 *  step says to sign in, not to install (§7.2). */
export const COPILOT_EXTENSION_IDS = ['GitHub.copilot-chat', 'GitHub.copilot'] as const;

/**
 * How the AI a `.env` names is checked (§7.2, Settings already there): a
 * provider's key as Check key checks it, Copilot by what VS Code says of its
 * model (`copilot/<id>`), anything else not at all.
 */
export function aiCheckKind(
  model: string,
): { kind: 'provider'; provider: ProviderId } | { kind: 'copilot'; model: string } | { kind: 'other' } {
  const provider = AI_PROVIDERS.find((p) => model.startsWith(`${p.id}/`));
  if (provider) return { kind: 'provider', provider: provider.id };
  if (model.startsWith('gateway/copilot/')) return { kind: 'copilot', model: model.slice('gateway/'.length) };
  return { kind: 'other' };
}

/** The line for an AI the page cannot check: another gateway, or a model it
 *  does not know how to ask about. */
export const NOT_CHECKED_OTHER: AiCheck = { state: 'not-checked', line: 'Not checked: runs will show whether it works.' };

/**
 * What a provider said of a saved key (§7.2), as the settings block says it.
 * Not Check key's own message, which is for a key just pasted ("check that
 * you copied all of it"): this key was saved a while ago.
 */
export function providerKeyCheck(provider: ProviderId, check: KeyCheck): AiCheck {
  const label = AI_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  if (check.ok) return { state: 'works', line: `${label} accepted the key.`, models: modelChoices(provider, check.models) };
  if (check.reason === 'rejected') return { state: 'not-working', line: `${label} didn't accept this key.` };
  return { state: 'not-working', line: `Couldn't check it. ${check.message}` };
}

/** The AI lines **Remove key** takes out of a `.env` (§7.2). */
export const AI_ENV_KEYS = ['AI_MODEL', 'AI_API_KEY', 'AI_GATEWAY_URL'] as const;

/** `text` without its AI settings, every other line kept. */
export function withoutAiSettings(text: string): string {
  return setEnvValues(text, Object.fromEntries(AI_ENV_KEYS.map((k) => [k, null])));
}

/** `text` with only its `AI_MODEL` changed, to `modelId` at `provider`: the
 *  settings block's Model list, which keeps the key and every other line. */
export function withAiModel(text: string, provider: ProviderId, modelId: string): string {
  return setEnvValues(text, { AI_MODEL: aiModelFor(provider, modelId) });
}

/** The provider and its model id an `AI_MODEL` names, or null for Copilot,
 *  a gateway or a model of no provider the page knows. */
export function providerModelOf(model: string | null): { provider: ProviderId; id: string } | null {
  if (!model) return null;
  const kind = aiCheckKind(model);
  return kind.kind === 'provider' ? { provider: kind.provider, id: model.slice(kind.provider.length + 1) } : null;
}

/**
 * Copilot settings work once Copilot lists that model and VS Code lets Steptix
 * use it (§7.2). `models` is what Copilot lists, each with VS Code's answer to
 * `canSendRequest`, or null when this VS Code has no language-model API.
 * Anything short of both stays not checked, with the reason: the page cannot
 * ask Copilot itself without a request the user did not make.
 */
export function copilotSettingsCheck(
  model: string,
  models: Array<{ vendor: string; id: string; canSendRequest: boolean | undefined }> | null,
): AiCheck {
  const name = describeAiModel(`gateway/${model}`);
  if (models === null || models.length === 0) {
    return { state: 'not-checked', line: 'Not checked: GitHub Copilot was not found in this VS Code.' };
  }
  const listed = models.find((m) => `${m.vendor}/${m.id}` === model);
  if (!listed) return { state: 'not-checked', line: `Not checked: Copilot does not offer ${name} in this VS Code.` };
  // Working Copilot settings need no line of their own: the block already
  // says how Steptix uses Copilot, and the header is green.
  if (listed.canSendRequest === true) return { state: 'works', line: null };
  if (listed.canSendRequest === false) {
    return { state: 'not-checked', line: 'Not checked: VS Code has not let Steptix use Copilot. Choose Use Copilot below, and Allow.' };
  }
  return { state: 'not-checked', line: 'Not checked: VS Code asks whether Steptix may use Copilot the first time a run needs it.' };
}

/** The page's four steps, in its order (§7.1). */
export type WelcomeStep = 'server' | 'ai' | 'browser' | 'test';

/**
 * The first step still to do, or null once every one is done (§7.1). Each is
 * done as the page marks it: a server ready (or the user's own), an AI shown
 * to work (§7.2: never done before its check passes), Google Chrome found,
 * and a folder open for the first test.
 */
export function firstUndoneStep(state: {
  server: { state: ServerStepState };
  ai: { check: Pick<AiCheck, 'state'> | null };
  browser: { chromeFound: boolean };
  folderOpen: boolean;
}): WelcomeStep | null {
  if (state.server.state !== 'ready' && state.server.state !== 'yours') return 'server';
  if (state.ai.check?.state !== 'works') return 'ai';
  if (!state.browser.chromeFound) return 'browser';
  if (!state.folderOpen) return 'test';
  return null;
}

/**
 * Where the page notes, before **Create a sample project** or **Open a
 * folder** reloads the window, that it should come back in the folder that
 * opens if a step is still undone there (§7.1). Whether one is, and which,
 * is worked out in that folder, whose own `.env` may choose the AI or not. A
 * file in the Steptix folder rather than VS Code's globalState, like the note
 * of an install (install-core.ts, installWantedFile): per user all the same,
 * and the install test can see it across two launches.
 */
export function welcomeReopenFile(userRoot: string): string {
  return path.join(userRoot, 'welcome-reopen.json');
}

export interface WelcomeReopen {
  /** The folder the window was reopening on. */
  folder: string;
}

/**
 * How long the note counts for. The window reopens in seconds; a note left
 * because it did not (the folder was already open in another window, which
 * VS Code focuses instead, or the user cancelled a save prompt) must not
 * bring the page back on some later start of that folder.
 */
export const WELCOME_REOPEN_MAX_AGE_MS = 5 * 60 * 1000;

export function readWelcomeReopen(userRoot: string, now: number = Date.now()): WelcomeReopen | null {
  try {
    const raw = JSON.parse(readFileSync(welcomeReopenFile(userRoot), 'utf-8')) as { folder?: unknown; since?: unknown } | null;
    if (typeof raw?.folder !== 'string' || typeof raw.since !== 'number') return null;
    return now - raw.since <= WELCOME_REOPEN_MAX_AGE_MS ? { folder: raw.folder } : null;
  } catch {
    return null;
  }
}

/** Best effort: a page that does not come back is no reason to stop the
 *  folder opening. */
export function writeWelcomeReopen(userRoot: string, reopen: WelcomeReopen, now: number = Date.now()): void {
  try {
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(welcomeReopenFile(userRoot), JSON.stringify({ folder: reopen.folder, since: now }) + '\n');
  } catch {
    // As above.
  }
}

export function clearWelcomeReopen(userRoot: string): void {
  try {
    rmSync(welcomeReopenFile(userRoot), { force: true });
  } catch {
    // Left for the next start in that folder, which tries again.
  }
}

/**
 * Whether two paths name the same folder: through links (macOS's `/var` is
 * `/private/var`) and Windows' short names, and without regard to letter case
 * on Windows, whose file names ignore it.
 */
export function sameFolder(
  a: string,
  b: string,
  realpath: (p: string) => string = realpathSync.native,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const canonical = (p: string) => {
    let full = path.resolve(p);
    try {
      full = realpath(full);
    } catch {
      // Gone, or unreadable: compared as written.
    }
    return platform === 'win32' ? full.toLowerCase() : full;
  };
  return canonical(a) === canonical(b);
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
  .settings { display: flex; flex-direction: column; gap: 4px; border-left: 2px solid var(--vscode-panel-border, #444); padding-left: 10px; }
  .settings .heading { font-weight: 600; }
  .save-to code { word-break: break-all; }
  .body { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; line-height: 1.5; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { font: inherit; padding: 4px 12px; border: 0; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  input[type=password], input[type=text], select { font: inherit; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  input[type=password] { flex: 1; min-width: 12em; }
  .entry { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; }
  .entry.open { border-color: var(--vscode-focusBorder); }
  .entry-head { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; cursor: pointer; }
  .entry-head input { margin-top: 3px; }
  .entry.unavailable .entry-head { cursor: default; }
  .entry.unavailable .title { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .entry-form { display: flex; flex-direction: column; gap: 10px; padding: 0 10px 10px; }
  .entry-links { padding: 0 10px 8px; }
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
<p class="lead">Set up Steptix and run your first test.</p>
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
// different: the choices are unfolded under Choose a different AI provider.
// savedModel, savedTyped: the In use block's Model list, once touched (null: untouched).
// entry: the entry the user opened (null: none yet); provider: the provider entry the key field is for.
// checked: the provider and key a Check key is out for, so its answer is shown only for that key.
const form = { open: null, path: false, different: false, entry: null, provider: 'openai', key: '', checked: null, models: null, model: '', typed: '', keyMessage: '', keyOk: false, busy: '', copilotModel: '', savedModel: null, savedTyped: '' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const post = (message) => vscode.postMessage(message);

function serverStep() {
  const s = state.server;
  const label = { 'not-installed': 'Not installed', installing: 'Installing', ready: 'Ready', yours: 'Yours', unsupported: 'Not supported here', chosen: 'Another version chosen' }[s.state];
  let body = '<div>' + esc(s.detail) + '</div>';
  if (s.state === 'installing') body += '<div class="bar" role="progressbar" aria-label="Installing"></div>' + (s.progress ? '<div class="note">' + esc(s.progress) + '</div>' : '') + '<div class="note">You can carry on with the steps below while this finishes.</div>' +
    '<div class="row"><button class="secondary" id="cancel-install">Cancel</button></div>';
  if (s.state === 'not-installed') {
    body += '<div class="row"><button id="install">Install server</button>' +
      (s.onPath ? '' : '<label><input type="checkbox" id="addpath"' + (form.path ? ' checked' : '') + '> Also add <code>steptix</code> to PATH, for every terminal</label>') + '</div>';
  }
  if (s.state === 'chosen') body += '<div class="row"><button id="use-newest">Use newest server</button></div>';
  if (s.state === 'ready' && !s.onPath) body += '<div><a id="addpath-link">Add steptix to PATH, for every terminal</a></div>';
  return card('server', '1 · Steptix server', label, s.state === 'ready' || s.state === 'yours', body, s.state !== 'ready');
}

function aiStep() {
  const a = state.ai;
  const name = a.chosen ? a.chosen.replace(/^AI: /, '') : null;
  const check = name ? a.check : null;
  const works = !!check && check.state === 'works';
  // The header: the AI's name in green once its check passes, and only then;
  // Set up AI while nothing works (§7.2).
  let label = 'Set up AI';
  if (check && check.state === 'checking') label = 'Checking…';
  else if (check && (check.state === 'works' || check.state === 'not-checked')) label = name;
  let body = '';
  if (a.blockedByProject) body += '<div class="error">This project\\'s .env has an empty AI_API_KEY= line, which keeps the all-projects settings from reaching it. Remove that line to use them here.</div>';
  if (check) body += settingsBlock(a, name, check);
  // The choices: folded while the settings work, open while nothing does.
  if (works) {
    body += '<div><a id="different-ai">Choose a different AI provider</a></div>';
    if (!form.different) return card('ai', '2 · AI', label, true, body, true);
  }
  return card('ai', '2 · AI', label, works, body + choices(a), true);
}

/** The settings found, whichever .env holds them (§7.2): what they are, what
 *  the check found, where the key is, and what to do about it. */
function settingsBlock(a, name, check) {
  const f = a.found;
  let html = '<div class="settings"><div class="heading">' + (check.state === 'works' ? 'In use' : 'Found in your settings') + '</div>' +
    '<div>' + esc(name) + (!a.bridgeToken && a.keyHint ? ' · ' + esc(a.keyHint) : '') + '</div>' +
    (a.bridgeToken ? '<div class="note">Steptix will use GitHub Copilot through VS Code\\'s Copilot bridge only while authoring, compiling or running tests in VS Code.</div>' : '');
  if (check.state === 'checking') html += '<div class="note">Checking…</div>';
  else if (check.state === 'works') html += (check.line ? '<div class="ok-text">' + esc(check.line) + '</div>' : '') + (check.models && a.providerModel ? modelList(a.providerModel.id, check.models) : '');
  else html += '<div>' + esc(check.line) + ' <a id="check-ai">Check again</a></div>';
  if (f) {
    // Copilot's settings hold the bridge's address and a local token, not a
    // key the user would know as theirs.
    html += '<div class="note">' + (a.bridgeToken ? 'Settings saved in' : 'Key saved in') + '</div><div><code>' + esc(f.file) + '</code>' + (f.project ? ' This project only.' : '') + '</div>';
    if (f.git === 'not-ignored') html += '<div class="error">Git does not ignore this file, so the key would go into a commit. <a id="ignore-env">Add .env to .gitignore</a></div>';
    if (f.git === 'committed') html += '<div class="error">This file is in git: the key is in its history. Rotate the key, and run git rm --cached .env.</div>';
    html += '<div><a id="open-env">Open file</a> · <a id="remove-key">Remove key</a></div>';
  }
  return html + '</div>';
}

/** A working provider key's models, from its own check, to change the model
 *  without pasting the key again: listed as the provider's entry lists them,
 *  on the model in use, with Save once another is picked. */
function modelList(current, models) {
  const listed = models.some((m) => m.id === current);
  // Untouched, the list shows the model in use; one the provider did not
  // list shows as typed.
  const picked = form.savedModel !== null ? form.savedModel : (listed ? current : '');
  const typed = form.savedModel !== null ? form.savedTyped : (listed ? '' : current);
  const chosen = picked === '' ? typed.trim() : picked;
  let html = '<div class="row"><label for="saved-model">Model</label><select id="saved-model">' +
    models.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === picked ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') +
    '<option value=""' + (picked === '' ? ' selected' : '') + '>Type a model id…</option></select>';
  if (picked === '') html += '<input id="saved-typed" type="text" placeholder="model id" value="' + esc(typed) + '">';
  if (chosen && chosen !== current) html += '<button id="save-model">Save</button>';
  return html + '</div>';
}

/** Where the page saves, above Save ("The key will be saved in") and Use
 *  Copilot ("Saved in"): a key is a secret on disk, so the file is named
 *  before anything is written (§7.2). */
function saveToBlock(label) {
  return '<div class="save-to"><div class="note">' + label + '</div><code>' + esc(state.ai.saveTo) + '</code></div>';
}

/** Beside Save and Use Copilot, when the open project's .env would win. */
function projectOwnNote() {
  return state.ai.projectOwn ? '<span class="note">This project\\'s .env has its own AI settings, which win over these in this project.</span>' : '';
}

/** The four ways to an AI, always in this order, so nothing moves when
 *  Copilot appears or goes (§7.2). */
const ENTRIES = ['copilot', 'openai', 'anthropic', 'openrouter'];
const ENTRY_LINES = { openai: 'With your own API key.', anthropic: 'With your own API key.', openrouter: "One key for many providers' models." };

/** The entry whose form is open: the one the user opened, else Copilot when
 *  it offers GPT 6 Luna, else OpenAI; none while Copilot is being looked for
 *  and the user has opened nothing. */
function openEntry(a) {
  const copilotOpenable = a.copilot === 'offers-luna' || a.copilot === 'no-luna';
  if (form.entry && (form.entry !== 'copilot' || copilotOpenable)) return form.entry;
  if (a.copilot === 'checking') return null;
  return a.copilot === 'offers-luna' ? 'copilot' : 'openai';
}

/** The list, each entry a box with its name and one line, the open one with
 *  its form inside it. */
function choices(a) {
  const open = openEntry(a);
  let body = '<div>Steptix uses an AI model to understand each step. Which one?</div>';
  for (const id of ENTRIES) body += id === 'copilot' ? copilotEntry(a, open === 'copilot') : providerEntry(id, open === id);
  return body;
}

/** One entry: its head, which opens it, and its form inside it once open.
 *  The title and line come as HTML already. */
function entryBox(id, title, line, open, inner, disabled) {
  return '<div class="entry' + (open ? ' open' : '') + (disabled ? ' unavailable' : '') + '">' +
    entryHead(id, title, line, open, disabled) +
    (open ? '<div class="entry-form">' + inner + '</div>' : '') + '</div>';
}

/** An entry's header row: its radio, of the one group the four share, then
 *  its name and line. The row is the radio's label, so a click anywhere on it
 *  chooses the entry, and the arrow keys move between the enabled ones. */
function entryHead(id, title, line, open, disabled) {
  return '<label class="entry-head"><input type="radio" name="aientry" value="' + id + '" id="entry-' + id + '"' + (open ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
    '<span><span class="title">' + title + '</span><br><span class="note">' + line + '</span></span></label>';
}

function copilotEntry(a, open) {
  const title = 'GitHub Copilot' + (a.copilot === 'offers-luna' ? '<span class="badge">Offers GPT 6 Luna</span>' : '');
  if (a.copilot === 'checking') return entryBox('copilot', title, 'Checking GitHub Copilot…', false, '', true);
  if (a.copilot === 'none' || a.copilot === 'unavailable') {
    // Not openable; its box says why. Installed but offering no models wants a sign-in, not an install.
    const why = a.copilot === 'none' && a.copilotInstalled
      ? 'GitHub Copilot is installed but offers no models. Sign in to GitHub Copilot, or check that your Copilot plan includes chat.'
      : 'Not found in this VS Code. Install GitHub Copilot and sign in to use it with no API key.';
    const links = a.copilot === 'none' && a.copilotInstalled
      ? '<a id="check-copilot">Check again</a>'
      : '<a id="install-copilot">Install GitHub Copilot</a> · <a id="check-copilot">Check again</a>';
    return '<div class="entry unavailable">' + entryHead('copilot', 'GitHub Copilot', why, false, true) +
      '<div class="entry-links">' + links + '</div></div>';
  }
  const models = a.copilotModels;
  const inner = (a.copilot === 'no-luna' ?'<div class="note">Your Copilot does not offer GPT 6 Luna, the model Steptix recommends. You can still use it with one of the models it does offer.</div>' : '') +
    '<div class="row"><label for="copilot-model">Copilot model</label><select id="copilot-model">' + models.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === form.copilotModel ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</select></div>' +
    '<div class="note">GitHub Copilot can be used only within VS Code.</div>' +
    saveToBlock('Saved in') + '<div class="row"><button id="use-copilot"' + (form.busy ? ' disabled' : '') + '>Use Copilot</button>' + (form.busy ? '<span class="note">' + esc(form.busy) + '</span>' : '') + projectOwnNote() + '</div>' +
    (form.keyMessage && !form.keyOk ? '<div class="error">' + esc(form.keyMessage) + '</div>' : '');
  return entryBox('copilot', title, 'No API key needed. Runs on your Copilot plan.', open, inner, false);
}

function providerEntry(id, open) {
  const p = state.providers.find((x) => x.id === id);
  let inner = '';
  if (open) {
    inner = '<label for="api-key">' + esc(p.label) + ' API key</label><div class="row"><input id="api-key" type="password" autocomplete="off" value="' + esc(form.key) + '"><button class="secondary" id="check-key"' + (form.busy ? ' disabled' : '') + '>Check key</button></div>' +
      '<div class="row" style="justify-content: space-between"><span class="' + (form.keyOk ? 'ok-text' : 'error') + '">' + esc(form.keyMessage) + '</span><a id="key-page">Get ' + (p.label.match(/^[AEIOU]/) ? 'an ' : 'a ') + esc(p.label) + ' API key</a></div>';
    if (form.models) {
      inner += '<label for="model">Model</label><select id="model">' + form.models.map((m) => '<option value="' + esc(m.id) + '"' + (m.id === form.model ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '<option value="">Type a model id…</option></select>' +
        (form.model === '' ? '<input id="typed-model" type="text" placeholder="model id" value="' + esc(form.typed) + '">' : '') +
        saveToBlock('The key will be saved in') + '<div class="row"><button id="save-provider"' + (form.busy ? ' disabled' : '') + '>Save</button>' + (form.busy ? '<span class="note">' + esc(form.busy) + '</span>' : '') + projectOwnNote() + '</div>';
    }
  }
  return entryBox(id, esc(p.label), ENTRY_LINES[id], open, inner, false);
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

/** One step. \`ok\` shows its state in green, as done; else it is grey. */
function card(id, title, label, ok, body, open) {
  return '<section class="' + (open ? 'open' : '') + '" id="step-' + id + '"><div class="head"><h2>' + esc(title) + '</h2><span class="state' + (ok ? ' ok' : '') + '">' + esc(label) + '</span></div>' + (open && body ? '<div class="body">' + body + '</div>' : '') + '</section>';
}

function render() {
  if (!state) return;
  const focused = document.activeElement && document.activeElement.id;
  document.getElementById('steps').innerHTML = serverStep() + aiStep() + browserStep() + testStep();
  const again = focused && document.getElementById(focused);
  if (again) {
    again.focus();
    // A rebuilt text box gets its caret back at the end of what was typed.
    if (typeof again.setSelectionRange === 'function' && typeof again.value === 'string') { try { again.setSelectionRange(again.value.length, again.value.length); } catch {} }
  }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a, input[type=radio], input[type=checkbox]');
  if (!t) return;
  if (t.id === 'install') post({ type: 'installServer', addToPath: form.path });
  else if (t.id === 'cancel-install') post({ type: 'cancelInstall' });
  else if (t.id === 'addpath') { form.path = t.checked; }
  else if (t.id === 'addpath-link') post({ type: 'addToPath' });
  else if (t.id === 'use-newest') post({ type: 'useNewestServer' });
  else if (t.id === 'different-ai') { form.different = !form.different; if (form.different) post({ type: 'checkCopilot' }); render(); }
  else if (t.id === 'install-copilot') post({ type: 'installCopilot' });
  else if (t.id === 'check-copilot') post({ type: 'checkCopilot' });
  else if (t.id === 'check-ai') post({ type: 'checkAi' });
  else if (t.id === 'open-env') post({ type: 'openEnvFile' });
  else if (t.id === 'remove-key') post({ type: 'removeKey' });
  else if (t.id === 'ignore-env') post({ type: 'ignoreEnv' });
  else if (t.id === 'save-model') {
    const id = form.savedModel === '' ? form.savedTyped.trim() : form.savedModel;
    if (id) post({ type: 'saveModel', model: id });
  }
  else if (t.id && t.id.startsWith('entry-')) { if (!t.disabled) chooseEntry(t.id.slice('entry-'.length)); }
  else if (t.id === 'check-key') { form.key = document.getElementById('api-key').value; form.checked = { provider: form.provider, key: form.key }; form.busy = 'Checking the key…'; form.keyMessage = ''; render(); post({ type: 'checkKey', provider: form.provider, key: form.key }); }
  else if (t.id === 'key-page') post({ type: 'openKeyPage', provider: form.provider });
  else if (t.id === 'save-provider') {
    const model = form.model === '' ? (document.getElementById('typed-model') || {}).value || '' : form.model;
    if (!model.trim()) { form.keyMessage = 'Type a model id first.'; form.keyOk = false; render(); return; }
    form.busy = 'Saving…'; render();
    post({ type: 'saveProvider', provider: form.provider, key: form.key, model: model.trim() });
  }
  else if (t.id === 'use-copilot') {
    const select = document.getElementById('copilot-model');
    form.busy = 'Waiting for your permission…'; render();
    post({ type: 'useCopilot', modelId: select ? select.value : '' });
  }
  else if (t.id === 'get-chrome') post({ type: 'getChrome' });
  else if (t.id === 'sample') post({ type: 'createSample' });
  else if (t.id === 'open-folder') post({ type: 'openFolder' });
});

/** Open an entry, closing the one open. A provider's key, and what its check
 *  said, stay with that provider: another entry starts on an empty field. */
function chooseEntry(id) {
  if (openEntry(state.ai) === id) return;
  form.entry = id;
  if (id !== 'copilot') form.provider = id;
  form.key = ''; form.checked = null; form.models = null; form.keyMessage = ''; form.keyOk = false;
  render();
}

document.addEventListener('change', (e) => {
  // The entries' radios, chosen with the arrow keys as well as a click.
  if (e.target.name === 'aientry' && !e.target.disabled) chooseEntry(e.target.value);
  if (e.target.id === 'model') { form.model = e.target.value; render(); }
  if (e.target.id === 'saved-model') { form.savedModel = e.target.value; form.savedTyped = ''; render(); }
  if (e.target.id === 'copilot-model') form.copilotModel = e.target.value;
});
document.addEventListener('input', (e) => {
  // A changed key has to be checked again before it can be saved.
  // The key's status belongs to the key that was checked: any change to the
  // field, emptying it included, takes it away until the key is checked again.
  if (e.target.id === 'api-key') {
    const shown = form.models || form.keyMessage;
    // Typing keeps this entry open, even if Copilot turns up meanwhile.
    if (form.entry === null) form.entry = form.provider;
    form.key = e.target.value; form.keyOk = false; form.checked = null; form.models = null; form.keyMessage = '';
    if (shown) render();
  }
  if (e.target.id === 'typed-model') form.typed = e.target.value;
  // Save shows once the id typed is another model, so the list is drawn again.
  if (e.target.id === 'saved-typed') { if (form.savedModel === null) form.savedModel = ''; form.savedTyped = e.target.value; render(); }
});

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type === 'state') {
    state = m.state;
    if (!form.copilotModel && state.ai.copilotModels.length) form.copilotModel = state.ai.copilotModels[0].id;
    // Choose AI unfolds the choices, even beside settings that work.
    if (m.focus) { form.open = m.focus; if (m.focus === 'ai') { form.different = true; } }
    render();
    if (m.focus) { const el = document.getElementById('step-' + m.focus); if (el) el.scrollIntoView(); }
  } else if (m.type === 'keyChecked') {
    // An answer for a key no longer in the field, or another provider's, or
    // one this page never asked about, says nothing about the field.
    const asked = form.checked;
    form.checked = null;
    if (!asked || asked.key !== form.key || asked.provider !== form.provider) { form.busy = ''; render(); return; }
    form.busy = '';
    form.keyOk = m.ok;
    form.keyMessage = m.ok ? 'Key works.' : m.message;
    form.models = m.ok ? m.models : null;
    form.model = m.ok && m.models.length ? m.models[0].id : '';
    render();
  } else if (m.type === 'saved') {
    form.busy = '';
    form.different = false;
    form.entry = null;
    form.key = '';
    form.checked = null;
    form.models = null;
    form.keyMessage = '';
    render();
  } else if (m.type === 'modelSaved') {
    form.savedModel = null;
    form.savedTyped = '';
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
