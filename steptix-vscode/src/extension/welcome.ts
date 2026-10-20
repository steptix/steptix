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
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  aiModelFor,
  checkProviderKey,
  COPILOT_RECOMMENDED_MODEL,
  modelChoices,
  providerInfo,
  setEnvValues,
  userRootEnvPath,
  type ModelChoice,
  type ProviderId,
} from 'steptix-runner-core';
import { copilotModels, useCopilotFor } from './lm-bridge-setup.js';
import type { LmBridge } from './lm-bridge.js';
import type { ServerSetup } from './server-setup.js';
import {
  aiStatusText,
  CHOOSE_AI_COMMAND,
  chromeFound,
  currentAi,
  keyHintFor,
  PROVIDER_LIST,
  readText,
  sampleFolderName,
  WELCOME_COMMAND,
  welcomeHtml,
  type CopilotState,
  type SaveFor,
  type WelcomeState,
} from './welcome-core.js';

const SHOWN_KEY = 'steptix.welcome.shown';
const OPEN_AFTER_KEY = 'steptix.sample.openAfter';
const CHROME_DOWNLOAD = 'https://www.google.com/chrome/';

type FromPage =
  | { type: 'ready' }
  | { type: 'installServer'; addToPath: boolean }
  | { type: 'addToPath' }
  | { type: 'checkCopilot' }
  | { type: 'useCopilot'; modelId: string; saveFor: SaveFor }
  | { type: 'checkKey'; provider: ProviderId; key: string }
  | { type: 'saveProvider'; provider: ProviderId; key: string; model: string; saveFor: SaveFor }
  | { type: 'openKeyPage'; provider: ProviderId }
  | { type: 'getChrome' }
  | { type: 'createSample' }
  | { type: 'openFolder' };

/** Is `.env` in `dir` inside a git work tree and not ignored there (§7.2)? */
function envUntrackedByGit(dir: string): Promise<boolean> {
  const git = (args: string[]) =>
    new Promise<boolean>((resolve) => execFile('git', args, { cwd: dir, windowsHide: true }, (err) => resolve(!err)));
  return git(['rev-parse', '--is-inside-work-tree']).then(async (inside) =>
    inside ? !(await git(['check-ignore', '-q', '.env'])) : false,
  );
}

export class Welcome implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly setup: ServerSetup;
  private readonly bridge: LmBridge;
  private panel: vscode.WebviewPanel | undefined;
  private copilot: CopilotState = 'checking';
  private copilotChoices: ModelChoice[] = [];
  private readonly aiItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

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
    this.disposables.push(
      this.aiItem,
      machineEnvWatcher,
      projectEnvWatcher,
      machineEnvWatcher.onDidChange(refresh),
      machineEnvWatcher.onDidCreate(refresh),
      projectEnvWatcher.onDidChange(refresh),
      projectEnvWatcher.onDidCreate(refresh),
      projectEnvWatcher.onDidDelete(refresh),
      setup.onDidChange(refresh),
      vscode.commands.registerCommand(WELCOME_COMMAND, () => this.show()),
      vscode.commands.registerCommand(CHOOSE_AI_COMMAND, () => this.show('ai')),
    );
    void this.refresh();
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /** Open the page the first time the extension starts (§5.2 step 1), and
   *  the sample test after Create a sample project reopened the window. */
  async onStart(): Promise<void> {
    const openAfter = this.context.globalState.get<string>(OPEN_AFTER_KEY);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (openAfter && folder && path.resolve(folder) === path.resolve(path.dirname(path.dirname(openAfter)))) {
      await this.context.globalState.update(OPEN_AFTER_KEY, undefined);
      await vscode.window.showTextDocument(vscode.Uri.file(openAfter));
    }
    if (!this.context.globalState.get<boolean>(SHOWN_KEY)) {
      await this.context.globalState.update(SHOWN_KEY, true);
      await this.show();
    }
  }

  private get folder(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private ai() {
    const projectEnv = this.folder ? readText(path.join(this.folder, '.env')) : '';
    return currentAi(projectEnv, readText(userRootEnvPath()));
  }

  private async state(): Promise<WelcomeState> {
    const ai = this.ai();
    return {
      server: await this.setup.welcomeServerState(),
      ai: {
        chosen: ai.model ? aiStatusText(ai.model) : null,
        savedFor: ai.savedFor,
        keyHint: keyHintFor(ai.model, ai.key),
        copilot: this.copilot,
        copilotModels: this.copilotChoices,
        blockedByProject: ai.blockedByProject,
      },
      browser: { chromeFound: chromeFound(process.platform, process.env) },
      folderOpen: this.folder !== null,
      providers: PROVIDER_LIST,
    };
  }

  private async refresh(focus?: 'ai'): Promise<void> {
    const ai = this.ai();
    this.aiItem.text = `$(sparkle) ${aiStatusText(ai.model)}`;
    this.aiItem.show();
    if (this.panel) await this.panel.webview.postMessage({ type: 'state', state: await this.state(), focus });
  }

  async show(focus?: 'ai'): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel('steptix.welcome', 'Welcome to Steptix', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      const nonce = randomBytes(16).toString('base64');
      this.panel.webview.html = welcomeHtml({ nonce, cspSource: this.panel.webview.cspSource });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m: FromPage) => void this.onMessage(m));
    }
    await this.checkCopilot();
    await this.refresh(focus);
  }

  /** Does Copilot offer GPT 6 Luna (§7.2)? The answer picks which way of
   *  choosing the AI comes first. */
  private async checkCopilot(): Promise<void> {
    this.copilot = 'checking';
    await this.refresh();
    const models = await copilotModels(this.bridge);
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

  /** The `.env` a choice goes in, or null after the user declined to write a
   *  key into a file git would commit. */
  private async envFor(saveFor: SaveFor): Promise<{ path: string; private: boolean } | null> {
    if (saveFor === 'all' || !this.folder) return { path: userRootEnvPath(), private: true };
    const envPath = path.join(this.folder, '.env');
    if (await envUntrackedByGit(this.folder)) {
      const add = 'Add .env to .gitignore';
      const choice = await vscode.window.showWarningMessage(
        `${envPath} is not in .gitignore, and it will hold your key. Add it before saving?`,
        { modal: true },
        add,
        'Save anyway',
      );
      if (choice === undefined) return null;
      if (choice === add) {
        const gitignore = path.join(this.folder, '.gitignore');
        const text = readText(gitignore);
        writeFileSync(gitignore, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}.env\n`);
      }
    }
    return { path: envPath, private: false };
  }

  private async onMessage(m: FromPage): Promise<void> {
    const post = (message: unknown) => this.panel?.webview.postMessage(message);
    switch (m.type) {
      case 'ready':
        return this.refresh();
      case 'installServer':
        await vscode.commands.executeCommand('steptix.installServer', { addToPath: m.addToPath });
        return this.refresh();
      case 'addToPath':
        await vscode.commands.executeCommand('steptix.addToPath');
        return this.refresh();
      case 'checkCopilot':
        await this.checkCopilot();
        return this.refresh();
      case 'useCopilot': {
        const env = await this.envFor(m.saveFor);
        if (!env) return void post({ type: 'failed', message: 'Nothing was saved.' });
        const result = await useCopilotFor(this.bridge, { modelId: m.modelId, envPath: env.path, privateFile: env.private });
        await post(result.ok ? { type: 'saved' } : { type: 'failed', message: result.message });
        return this.refresh();
      }
      case 'checkKey': {
        const check = await checkProviderKey(m.provider, m.key, (url, init) => fetch(url, init), 'VS Code');
        return void post(
          check.ok
            ? { type: 'keyChecked', ok: true, models: modelChoices(m.provider, check.models) }
            : { type: 'keyChecked', ok: false, message: check.message },
        );
      }
      case 'saveProvider': {
        const env = await this.envFor(m.saveFor);
        if (!env) return void post({ type: 'failed', message: 'Nothing was saved.' });
        const current = readText(env.path);
        // A gateway URL left from Copilot points at this window's bridge,
        // which a provider's model does not use; any other is the user's own.
        const gateway = /^\s*AI_GATEWAY_URL\s*=\s*(\S*)/m.exec(current)?.[1] ?? '';
        const values: Record<string, string | null> = { AI_MODEL: aiModelFor(m.provider, m.model), AI_API_KEY: m.key.trim() };
        if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(gateway)) values['AI_GATEWAY_URL'] = null;
        try {
          mkdirSync(path.dirname(env.path), { recursive: true });
          writeFileSync(env.path, setEnvValues(current, values), env.private ? { mode: 0o600 } : {});
          if (env.private && process.platform !== 'win32') chmodSync(env.path, 0o600);
        } catch (err) {
          return void post({ type: 'failed', message: `Could not write ${env.path}: ${(err as Error).message}` });
        }
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
        return void vscode.commands.executeCommand('workbench.action.files.openFolder');
    }
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
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
  }
}
