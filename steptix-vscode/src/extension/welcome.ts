/**
 * The welcome page, **Steptix: Welcome** and **Steptix: Choose AI**
 * (docs/specs/SPEC-install.md §7): four steps, each showing its state, done in
 * any order — the server, the AI, the browser, and a first test.
 *
 * The page needs no server for steps 2 to 4: keys are checked and models
 * listed from here, Copilot's dialog and models come from VS Code, and saving
 * a choice is a file write. The rules are in welcome-core.ts and
 * runner-core's ai-providers.ts; this is the panel and what its buttons do.
 */

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  aiModelFor,
  checkProviderKey,
  COPILOT_RECOMMENDED_MODEL,
  modelChoices,
  projectAiOverrides,
  providerEnvText,
  providerInfo,
  userRootDir,
  userRootEnvPath,
  withEnvIgnored,
  type ModelChoice,
  type ProviderFetch,
  type ProviderId,
} from 'steptix-runner-core';
import { copilotModels, useCopilotFor } from './lm-bridge-setup.js';
import type { LmBridge } from './lm-bridge.js';
import type { ServerSetup } from './server-setup.js';
import {
  AI_CHECKING,
  aiCheckKind,
  aiStatusText,
  CHOOSE_AI_COMMAND,
  chromeFound,
  clearWelcomeReopen,
  COPILOT_EXTENSION_IDS,
  COPILOT_EXTENSION_SEARCH,
  copilotSettingsCheck,
  currentAi,
  firstUndoneStep,
  keyHintFor,
  NOT_CHECKED_OTHER,
  PROVIDER_LIST,
  providerKeyCheck,
  providerModelOf,
  readText,
  readWelcomeReopen,
  sameFolder,
  sampleFolderName,
  WELCOME_COMMAND,
  WELCOME_VIEW_TYPE,
  welcomeHtml,
  withAiModel,
  withoutAiSettings,
  writeWelcomeReopen,
  type AiCheck,
  type CopilotState,
  type EnvGitState,
  type WelcomeState,
  type WelcomeStep,
} from './welcome-core.js';

const SHOWN_KEY = 'steptix.welcome.shown';
const OPEN_AFTER_KEY = 'steptix.sample.openAfter';
const CHROME_DOWNLOAD = 'https://www.google.com/chrome/';

type FromPage =
  | { type: 'ready' }
  | { type: 'installServer'; addToPath: boolean }
  | { type: 'cancelInstall' }
  | { type: 'addToPath' }
  | { type: 'useNewestServer' }
  | { type: 'checkCopilot' }
  | { type: 'installCopilot' }
  | { type: 'checkAi' }
  | { type: 'useCopilot'; modelId: string }
  | { type: 'checkKey'; provider: ProviderId; key: string }
  | { type: 'saveProvider'; provider: ProviderId; key: string; model: string }
  | { type: 'openKeyPage'; provider: ProviderId }
  | { type: 'openEnvFile' }
  | { type: 'saveModel'; model: string }
  | { type: 'removeKey' }
  | { type: 'ignoreEnv' }
  | { type: 'getChrome' }
  | { type: 'createSample' }
  | { type: 'openFolder' };

/**
 * Rename a file just written over another, trying again for a while when
 * Windows says it is busy: a virus scanner or a file watcher reading the file
 * holds it open for a moment, and a file held open cannot be replaced (EPERM,
 * EACCES or EBUSY). The launcher does the same for its own copies
 * (`renamePatiently` in src/launcher/runtimes.ts). Elsewhere those codes mean
 * a permission that waiting will not change.
 */
async function renamePatiently(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const busy = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (!busy || attempt >= 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

function installedCopilot(): boolean {
  return COPILOT_EXTENSION_IDS.some((id) => vscode.extensions.getExtension(id) !== undefined);
}

/** Where `.env` in `dir` stands with git (§7.2), as `steptix ai` asks it:
 *  `safe` outside a repository or ignored, `not-ignored` when a commit would
 *  pick it up, `committed` when git tracks it already. */
async function envGitState(dir: string): Promise<EnvGitState> {
  const git = (args: string[]) =>
    new Promise<boolean>((resolve) => execFile('git', args, { cwd: dir, windowsHide: true }, (err) => resolve(!err)));
  if (!(await git(['rev-parse', '--is-inside-work-tree']))) return 'safe';
  if (await git(['ls-files', '--error-unmatch', '.env'])) return 'committed';
  return (await git(['check-ignore', '-q', '.env'])) ? 'safe' : 'not-ignored';
}

export class Welcome implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly setup: ServerSetup;
  private readonly bridge: LmBridge;
  private panel: vscode.WebviewPanel | undefined;
  private copilot: CopilotState = 'checking';
  /** See WelcomeState's `copilotInstalled`; asked at each Copilot check. */
  private copilotInstalled = false;
  /** Whether GitHub Copilot is installed: VS Code's own answer, unless a test
   *  put its own in place. Only the extension list is read: Steptix never
   *  asks for a GitHub sign-in just to word the step. */
  private copilotInstalledNow: () => boolean = installedCopilot;
  private copilotChoices: ModelChoice[] = [];
  /** Copilot checks, one after another, so the last one asked for is the
   *  one that shows. */
  private copilotChain: Promise<void> = Promise.resolve();
  /**
   * The check of the AI the `.env` files name (§7.2, Settings already there),
   * for that model and key: a check of other settings shows nothing.
   */
  private aiCheck: { model: string; key: string | null; result: AiCheck; done: Promise<void> } | undefined;
  /** Git's view of the project `.env` that holds the key, asked once per file
   *  until the page opens again, the file changes or .gitignore is changed
   *  from the page; null while it is asked. */
  private envGit: { file: string; state: EnvGitState | null } | undefined;
  private readonly aiItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** A plain Reload Window: VS Code hands back the page it had open (§7.1). */
  private readonly serializer: vscode.WebviewPanelSerializer = {
    deserializeWebviewPanel: (panel) => this.restore(panel),
  };

  constructor(context: vscode.ExtensionContext, setup: ServerSetup, bridge: LmBridge) {
    this.context = context;
    this.setup = setup;
    this.bridge = bridge;
    this.aiItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.aiItem.command = CHOOSE_AI_COMMAND;
    this.aiItem.tooltip = 'Steptix: Choose AI';
    const machineEnvWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(userRootEnvPath())), '.env'),
    );
    const projectEnvWatcher = vscode.workspace.createFileSystemWatcher('**/.env');
    const refresh = () => void this.refresh();
    const projectEnvChanged = () => {
      this.envGit = undefined;
      void this.refresh();
    };
    this.disposables.push(
      this.aiItem,
      machineEnvWatcher,
      projectEnvWatcher,
      machineEnvWatcher.onDidChange(refresh),
      machineEnvWatcher.onDidCreate(refresh),
      projectEnvWatcher.onDidChange(projectEnvChanged),
      projectEnvWatcher.onDidCreate(projectEnvChanged),
      projectEnvWatcher.onDidDelete(projectEnvChanged),
      setup.onDidChange(refresh),
      vscode.commands.registerCommand(WELCOME_COMMAND, () => this.show()),
      vscode.commands.registerCommand(CHOOSE_AI_COMMAND, () => this.show('ai')),
      vscode.window.registerWebviewPanelSerializer(WELCOME_VIEW_TYPE, this.serializer),
      // §7.2: Copilot is looked for again when VS Code says its models
      // changed, that Steptix may now use them, or that extensions were
      // installed or removed, and when the window comes back into focus, so
      // installing or signing in elsewhere shows here.
      bridge.onDidChangeChatModels(() => this.copilotMayHaveChanged()),
      vscode.extensions.onDidChange(() => this.copilotMayHaveChanged()),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.copilotMayHaveChanged();
      }),
      ...(context.languageModelAccessInformation
        ? [context.languageModelAccessInformation.onDidChange(() => this.copilotMayHaveChanged())]
        : []),
    );
    void this.refresh();
  }

  /** While the page is open: look for Copilot again, without the page
   *  showing a check nobody asked for, and check Copilot settings again. */
  private copilotMayHaveChanged(): void {
    if (!this.panel) return;
    void this.checkCopilot({ quiet: true }).then(() => {
      if (this.aiCheck && aiCheckKind(this.aiCheck.model).kind === 'copilot') this.aiCheck = undefined;
      return this.refresh();
    });
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /**
   * Open the page the first time the extension starts (§5.2 step 1). After
   * Create a sample project or Open a folder reopened the window, open the
   * sample test, and the page again on the first step still undone (§7.1).
   * Returns that step, or null when the page did not come back on one.
   */
  async onStart(): Promise<WelcomeStep | null> {
    const openAfter = this.context.globalState.get<string>(OPEN_AFTER_KEY);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (openAfter && folder && path.resolve(folder) === path.resolve(path.dirname(path.dirname(openAfter)))) {
      await this.context.globalState.update(OPEN_AFTER_KEY, undefined);
      await vscode.window.showTextDocument(vscode.Uri.file(openAfter));
    }
    const reopen = readWelcomeReopen(userRootDir());
    let step: WelcomeStep | null = null;
    if (reopen && folder && sameFolder(reopen.folder, folder)) {
      // Used once, and only in the folder that was opening. The AI step is
      // done only once its settings are shown to work (§7.2), so they are
      // checked before the step is chosen.
      clearWelcomeReopen(userRootDir());
      await this.aiCheckNow()?.done;
      step = firstUndoneStep(await this.state());
    }
    if (step) {
      await this.context.globalState.update(SHOWN_KEY, true);
      await this.show(step);
      return step;
    }
    if (!this.context.globalState.get<boolean>(SHOWN_KEY)) {
      await this.context.globalState.update(SHOWN_KEY, true);
      await this.show();
    }
    return null;
  }

  private get folder(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  /** The open project's `.env`, or null with no folder open. */
  private get projectEnv(): string | null {
    return this.folder ? path.join(this.folder, '.env') : null;
  }

  private ai() {
    return currentAi(this.projectEnv ? readText(this.projectEnv) : '', readText(userRootEnvPath()));
  }

  /** The file that holds the key of the settings found, or null (§7.2). */
  private foundFile(): { file: string; project: boolean } | null {
    const { savedFor } = this.ai();
    if (savedFor === 'project' && this.projectEnv) return { file: this.projectEnv, project: true };
    return savedFor === 'all' ? { file: userRootEnvPath(), project: false } : null;
  }

  /** Git's view of `file`, a project's `.env`: asked once, then remembered
   *  (see {@link envGit}). Null until git has answered. */
  private envGitNow(file: string): EnvGitState | null {
    if (this.envGit?.file === file) return this.envGit.state;
    const record: NonNullable<Welcome['envGit']> = { file, state: null };
    this.envGit = record;
    void envGitState(path.dirname(file)).then((state) => {
      if (this.envGit !== record) return;
      record.state = state;
      return this.refresh();
    });
    return null;
  }

  private async state(): Promise<WelcomeState> {
    const ai = this.ai();
    const found = this.foundFile();
    return {
      server: await this.setup.welcomeServerState(),
      ai: {
        chosen: ai.model ? aiStatusText(ai.model) : null,
        keyHint: keyHintFor(ai.model, ai.key),
        providerModel: providerModelOf(ai.model),
        bridgeToken: ai.model?.startsWith('gateway/copilot/') === true,
        copilot: this.copilot,
        copilotInstalled: this.copilotInstalled,
        copilotModels: this.copilotChoices,
        blockedByProject: ai.blockedByProject,
        projectOwn: this.projectEnv !== null && projectAiOverrides(readText(this.projectEnv)).length > 0,
        saveTo: userRootEnvPath(),
        found: found && { ...found, git: found.project ? this.envGitNow(found.file) : null },
        check: this.aiCheckNow()?.result ?? null,
      },
      browser: { chromeFound: chromeFound(process.platform, process.env) },
      folderOpen: this.folder !== null,
      providers: PROVIDER_LIST,
    };
  }

  private async refresh(focus?: WelcomeStep): Promise<void> {
    const ai = this.ai();
    this.aiItem.text = `$(sparkle) ${aiStatusText(ai.model)}`;
    this.aiItem.show();
    if (this.panel || this.testSink) {
      const state = await this.state();
      if (this.panel) this.shown = state;
      await this.postToPage({ type: 'state', state, focus });
    }
  }

  async show(focus?: WelcomeStep): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.adopt(
        vscode.window.createWebviewPanel(WELCOME_VIEW_TYPE, 'Welcome to Steptix', vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
        }),
      );
    }
    // The page opening checks the AI already set up, and asks git, afresh (§7.2).
    this.aiCheck = undefined;
    this.envGit = undefined;
    await this.checkCopilot();
    await this.refresh(focus);
  }

  /** Make `panel` the page: a new one, or one VS Code restored. */
  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = welcomeHtml({ nonce, cspSource: panel.webview.cspSource });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.shown = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((m: FromPage) => void this.onMessage(m));
  }

  /** The page VS Code restores after a Reload Window, where it was and as it
   *  is now. One opened already, by onStart or a command, stays the page. */
  private async restore(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel) {
      panel.dispose();
      return;
    }
    panel.webview.options = { enableScripts: true };
    this.adopt(panel);
    this.aiCheck = undefined;
    this.envGit = undefined;
    await this.checkCopilot();
    await this.refresh();
  }

  /**
   * The check of the AI the `.env` files name now, started if these settings
   * have none yet (§7.2, Settings already there), or undefined when they name
   * none. The page shows it as checking until it is done.
   */
  private aiCheckNow(): Welcome['aiCheck'] {
    const ai = this.ai();
    if (!ai.model) {
      this.aiCheck = undefined;
      return undefined;
    }
    if (this.aiCheck?.model === ai.model && this.aiCheck.key === ai.key) return this.aiCheck;
    const model = ai.model;
    const record: NonNullable<Welcome['aiCheck']> = { model, key: ai.key, result: AI_CHECKING, done: Promise.resolve() };
    this.aiCheck = record;
    record.done = this.checkSettings(model, ai.key).then((result) => {
      // Other settings since, or Check again: that check has the say.
      if (this.aiCheck !== record) return;
      record.result = result;
      return this.refresh();
    });
    return record;
  }

  /** Does the AI these settings name work (§7.2)? Never throws: a check that
   *  cannot finish says why. */
  private async checkSettings(model: string, key: string | null): Promise<AiCheck> {
    const kind = aiCheckKind(model);
    try {
      if (kind.kind === 'provider') return providerKeyCheck(kind.provider, await this.checkKey(kind.provider, key ?? ''));
      if (kind.kind === 'copilot') {
        const models = await copilotModels(this.bridge);
        return copilotSettingsCheck(
          kind.model,
          models && models.map((m) => ({ vendor: m.vendor, id: m.id, canSendRequest: m.canSendRequest?.() })),
        );
      }
      return NOT_CHECKED_OTHER;
    } catch (err) {
      return { state: 'not-checked', line: `Not checked: ${(err as Error).message}` };
    }
  }

  /** Does Copilot offer GPT 6 Luna (§7.2)? The answer picks which way of
   *  choosing the AI comes first. `quiet` looks without showing *Checking
   *  GitHub Copilot…*, for a look nobody asked for. */
  private checkCopilot(opts: { quiet?: boolean } = {}): Promise<void> {
    const run = this.copilotChain.then(() => this.runCopilotCheck(opts.quiet === true));
    this.copilotChain = run.catch(() => undefined);
    return run;
  }

  private async runCopilotCheck(quiet: boolean): Promise<void> {
    if (!quiet) {
      this.copilot = 'checking';
      await this.refresh();
    }
    const models = await copilotModels(this.bridge);
    this.copilotInstalled = this.copilotInstalledNow();
    if (models === null) {
      this.copilot = 'unavailable';
      this.copilotChoices = [];
    } else if (models.length === 0) {
      this.copilot = 'none';
      this.copilotChoices = [];
    } else {
      const luna = models.find((m) => m.id === COPILOT_RECOMMENDED_MODEL.id);
      this.copilot = luna ? 'offers-luna' : 'no-luna';
      this.copilotChoices = [
        ...(luna ? [{ id: luna.id, label: `${COPILOT_RECOMMENDED_MODEL.label} · recommended for Steptix`, recommended: true }] : []),
        ...models.filter((m) => m !== luna).map((m) => ({ id: m.id, label: m.name, recommended: false })),
      ];
    }
  }

  /** Write a `.env` that holds a key: owner-only, and whole or not at all.
   *  Null when written, else why not. */
  private async writeEnv(envPath: string, text: string): Promise<string | null> {
    const tmpPath = `${envPath}.tmp-${process.pid}`;
    try {
      mkdirSync(path.dirname(envPath), { recursive: true });
      writeFileSync(tmpPath, text, { mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(tmpPath, 0o600);
      await renamePatiently(tmpPath, envPath);
      return null;
    } catch (err) {
      rmSync(tmpPath, { force: true });
      return `Could not write ${envPath}: ${(err as Error).message}`;
    }
  }

  /**
   * The In use block's Model list (§7.2): a working provider key's model
   * changed, `AI_MODEL` only, in the file the settings came from, and the
   * key's check carried over, since the key is the same. That file is the
   * project's when the project's `.env` holds the key or sets the model
   * itself, so the new model is the one that takes effect; else the one for
   * all projects.
   */
  private async saveModel(modelId: string): Promise<void> {
    const ai = this.ai();
    const current = providerModelOf(ai.model);
    const found = this.foundFile();
    const id = modelId.trim();
    const check = this.aiCheck;
    if (!current || !found || !id || check?.result.state !== 'works') return this.refresh();
    const projectSetsModel = this.projectEnv !== null && projectAiOverrides(readText(this.projectEnv)).includes('AI_MODEL');
    const file = found.project || projectSetsModel ? this.projectEnv! : found.file;
    const problem = await this.writeEnv(file, withAiModel(readText(file), current.provider, id));
    if (problem) {
      void vscode.window.showErrorMessage(`Steptix: ${problem}`);
      return this.refresh();
    }
    // Unless another check started while the file was written.
    if (this.aiCheck === check && check.key === ai.key) check.model = aiModelFor(current.provider, id);
    await this.postToPage({ type: 'modelSaved' });
    return this.refresh();
  }

  /** **Remove key** (§7.2): the AI lines out of the file that holds the key
   *  found, every other line kept, once the user says so. */
  private async removeKey(): Promise<void> {
    const found = this.foundFile();
    if (!found) return this.refresh();
    const remove = 'Remove';
    const choice = await vscode.window.showWarningMessage(
      `Remove the AI settings from ${found.file}? The key and model are deleted from that file.`,
      { modal: true },
      remove,
    );
    if (choice !== remove) return;
    const problem = await this.writeEnv(found.file, withoutAiSettings(readText(found.file)));
    if (problem) void vscode.window.showErrorMessage(`Steptix: ${problem}`);
    return this.refresh();
  }

  private async onMessage(m: FromPage): Promise<void> {
    const post = (message: unknown) => this.postToPage(message);
    switch (m.type) {
      case 'ready':
        return this.refresh();
      case 'installServer':
        await vscode.commands.executeCommand('steptix.installServer', { addToPath: m.addToPath });
        return this.refresh();
      case 'cancelInstall':
        // The server step's Cancel (§5.2). The step goes back to Not
        // installed when the install has ended, by the setup's change event.
        this.setup.cancelInstall();
        return this.refresh();
      case 'useNewestServer':
        this.setup.useNewestServer();
        return this.refresh();
      case 'addToPath':
        await vscode.commands.executeCommand('steptix.addToPath');
        return this.refresh();
      case 'checkCopilot':
        await this.checkCopilot();
        // Copilot settings stand or fall with what Copilot says now.
        if (this.aiCheck && aiCheckKind(this.aiCheck.model).kind === 'copilot') this.aiCheck = undefined;
        return this.refresh();
      case 'installCopilot':
        return void vscode.commands.executeCommand('workbench.extensions.search', COPILOT_EXTENSION_SEARCH);
      case 'checkAi':
        // Check again, for settings that were not working or not checked.
        this.aiCheck = undefined;
        this.envGit = undefined;
        return this.refresh();
      case 'openEnvFile': {
        const found = this.foundFile();
        if (found) await vscode.window.showTextDocument(vscode.Uri.file(found.file));
        return;
      }
      case 'saveModel':
        return this.saveModel(m.model);
      case 'removeKey':
        return this.removeKey();
      case 'ignoreEnv': {
        // The project's own .env, not ignored by git: .env added to its .gitignore.
        const found = this.foundFile();
        if (found?.project && this.folder) {
          const gitignore = path.join(this.folder, '.gitignore');
          writeFileSync(gitignore, withEnvIgnored(readText(gitignore)));
          this.envGit = undefined;
        }
        return this.refresh();
      }
      case 'useCopilot': {
        // The page saves only to the file for all projects (§7.2).
        const result = await useCopilotFor(this.bridge, { modelId: m.modelId, envPath: userRootEnvPath() });
        await post(result.ok ? { type: 'saved' } : { type: 'failed', message: result.message });
        return this.refresh();
      }
      case 'checkKey': {
        const check = await this.checkKey(m.provider, m.key);
        return void post(
          check.ok
            ? { type: 'keyChecked', ok: true, models: modelChoices(m.provider, check.models) }
            : { type: 'keyChecked', ok: false, message: check.message },
        );
      }
      case 'saveProvider': {
        // Checked again here, not taken on the page's word: the key in the
        // form may have changed since its Check key (§7.2).
        const key = m.key.trim();
        const check = await this.checkKey(m.provider, key);
        if (!check.ok) return void post({ type: 'failed', message: check.message });
        // The page saves only to the file for all projects (§7.2).
        const envPath = userRootEnvPath();
        const problem = await this.writeEnv(envPath, providerEnvText(readText(envPath), m.provider, m.model, key));
        if (problem) return void post({ type: 'failed', message: problem });
        await post({ type: 'saved' });
        return this.refresh();
      }
      case 'openKeyPage':
        return void vscode.env.openExternal(vscode.Uri.parse(providerInfo(m.provider).keyPage));
      case 'getChrome':
        return void vscode.env.openExternal(vscode.Uri.parse(CHROME_DOWNLOAD));
      case 'createSample':
        return this.createSample();
      case 'openFolder':
        return this.openFolder();
    }
  }

  private checkKey(provider: ProviderId, key: string) {
    return checkProviderKey(provider, key, this.fetchFn, 'VS Code');
  }

  /** Everything the host says to the page goes through here, so the release
   *  test sees it as the page would. */
  private async postToPage(message: unknown): Promise<void> {
    this.testSink?.push(message);
    await this.panel?.webview.postMessage(message);
  }

  /** How the key check reaches a provider: the real fetch, unless the
   *  release test put a stand-in provider in its place. */
  private fetchFn: ProviderFetch = (url, init) => fetch(url, init);
  /** What the host posted while the release test drove it, when it is. */
  private testSink: unknown[] | undefined;
  /** The state last posted to the open page: what it shows now, for the
   *  release test, which cannot read the page itself. */
  private shown: WelcomeState | undefined;

  shownStateForTests(): WelcomeState | undefined {
    return this.shown;
  }

  /** The release test's way in (`__testHooks.welcome`, extension.ts): one
   *  message from the page, and what the host posted back while handling it. */
  async receiveForTests(message: unknown): Promise<unknown[]> {
    const sink: unknown[] = [];
    this.testSink = sink;
    try {
      await this.onMessage(message as FromPage);
    } finally {
      this.testSink = undefined;
    }
    return sink;
  }

  setFetchForTests(fetchFn: ProviderFetch | null): void {
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  /** Whether Copilot counts as installed, in place of the extension list,
   *  which a test cannot change; null goes back to the list. */
  setCopilotInstalledForTests(installed: boolean | null): void {
    this.copilotInstalledNow = installed === null ? installedCopilot : () => installed;
  }

  /** A panel handed over as VS Code does after a Reload Window, through the
   *  serializer registered for the page: a test cannot reload its window. */
  async restoreForTests(panel: vscode.WebviewPanel): Promise<void> {
    await this.serializer.deserializeWebviewPanel(panel, undefined);
  }

  /**
   * **Create a sample project** (§7.3): the files `steptix init` creates,
   * from the same `templates/sample/`, which the build copies into the
   * extension. Then the folder opens, and the test with it.
   */
  private async createSample(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Create the sample here',
      title: 'Where should the Steptix sample project go?',
    });
    const parent = picked?.[0]?.fsPath;
    if (!parent) return;
    const target = path.join(parent, sampleFolderName(parent));
    const source = path.join(this.context.extensionPath, 'sample');
    if (!existsSync(source)) {
      void vscode.window.showErrorMessage(`Steptix: the sample is missing from this extension (${source}). Reinstall the extension.`);
      return;
    }
    try {
      cpSync(source, target, { recursive: true });
      // The folders `steptix init` makes, empty ones included.
      for (const dir of ['tests', 'context', 'reports']) mkdirSync(path.join(target, dir), { recursive: true });
    } catch (err) {
      void vscode.window.showErrorMessage(`Steptix: could not create the sample in ${target}: ${(err as Error).message}`);
      return;
    }
    await this.context.globalState.update(OPEN_AFTER_KEY, path.join(target, 'tests', 'first-test.md'));
    await this.openInThisWindow(target);
  }

  /** **Open a folder** (§7.3): picked here rather than with VS Code's own
   *  Open Folder, so the page knows a folder is opening before the window
   *  reloads, and only once one was chosen. */
  private async openFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Open',
      title: 'Open a folder of Steptix tests',
    });
    const folder = picked?.[0]?.fsPath;
    if (folder) await this.openInThisWindow(folder);
  }

  /** Open `folder` in this window, which reloads it, noting first that the
   *  page comes back there if a step is still undone (§7.1). Whether one is,
   *  onStart works out in that folder, whose own `.env` may choose the AI. */
  private async openInThisWindow(folder: string): Promise<void> {
    writeWelcomeReopen(userRootDir(), { folder });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder));
  }
}
