/**
 * The extension's side of installing Steptix (docs/specs/SPEC-install.md §4.5,
 * §4.10, §4.12, §5.2–§5.5, §6.2–§6.8, §8, §9.2): the one install question,
 * progress, updates that do not ask, replacing a running server that does not
 * match, `steptix` for VS Code's terminals and for every terminal, and
 * Uninstall Server.
 *
 * The work is in server-installer.ts and the rules in install-core.ts, which
 * have no `vscode` import; this file is the questions and the messages.
 */

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reportError, userRootDir, type ErrorPayload } from 'steptix-runner-core';
import {
  addShellRcLine,
  addToWindowsPath,
  BIN_SCRIPT_MARK,
  binScripts,
  chooseNode,
  clearServerChoice,
  compareVersions,
  findOnPath,
  globalPackageDir,
  isSteptixPackage,
  listInstalledServers,
  NODE_DOWNLOAD_MB,
  npmCliBeside,
  npmPackageOfCommand,
  packageVersionAt,
  pathChangesFile,
  readPathChanges,
  removeFromWindowsPath,
  removeShellRcLine,
  SERVER_DOWNLOAD_MB,
  serverRequirement,
  serverSatisfies,
  shellRcFile,
  staleTerminalNotice,
  unsupportedPlatformMessage,
  type InstalledServer,
  type NodeChoice,
  type PathChange,
  type ServerSource,
} from './install-core.js';
import {
  currentPick,
  defaultRunner,
  ensureNode,
  InstallFailure,
  installServerVersion,
  installServer,
  newestPublishedServer,
  setUpNpmPackage,
  type InstallerDeps,
} from './server-installer.js';
import { describeExtensionBuild, extensionBuild } from './extension-build.js';
import type { WelcomeState } from './welcome-core.js';
import {
  readAutoStartSettings,
  requestServerShutdown,
  waitUntilDown,
  describeServerVersion,
  findInstalledRuntime,
  type HealthProbe,
  type InstalledRuntime,
  type ServerHealth,
} from './server-manager.js';


/** What the run path needs from this, as an interface so a test can fake it. */
export interface RunServerSetup {
  /** False when a developer setting switches install handling off (§4.12). */
  managed(): boolean;
  /** A server to start for a Run, installing one first if need be. */
  ensureRuntime(args: { signal: AbortSignal; log: (line: string) => void }): Promise<EnsureRuntimeResult>;
  /** Whether to use a running server, or replace it with a matching one (§6.4). */
  checkRunning(args: {
    serverUrl: string;
    health: ServerHealth;
    signal: AbortSignal;
    log: (line: string) => void;
    probe: HealthProbe;
    apiKey: () => string | undefined;
  }): Promise<CheckRunningResult>;
}

export type EnsureRuntimeResult =
  | { kind: 'ready'; runtime: InstalledRuntime }
  | { kind: 'fail'; payload: ErrorPayload }
  | { kind: 'aborted' };

export type CheckRunningResult =
  /** It matches, or is not this extension's to judge: use it. */
  | { kind: 'use' }
  /** It was stopped; start a matching one in its place. */
  | { kind: 'replaced' }
  | { kind: 'fail'; payload: ErrorPayload }
  | { kind: 'aborted' };

/** globalState keys. globalState is per user, not per window or folder, which
 *  is where §5.2 says the answer to the install question is remembered. */
const ASKED_KEY = 'steptix.install.asked';
const STALE_DISMISSED_KEY = 'steptix.staleTerminal.dismissed';
const STALE_SHOWN_FOR_KEY = 'steptix.staleTerminal.shownFor';

const PATCH_CHECK_MS = 24 * 60 * 60 * 1000;
const RELEASES_URL = 'https://github.com/steptix/steptix/releases';
const NODEJS_URL = 'https://nodejs.org/';

export const INSTALL_SERVER_COMMAND = 'steptix.installServer';
export const ADD_TO_PATH_COMMAND = 'steptix.addToPath';
export const UNINSTALL_SERVER_COMMAND = 'steptix.uninstallServer';

/** How the install state shows in the status bar. */
export type InstallState = 'not-installed' | 'installing' | null;

export interface InstallStatusSink {
  setInstallState(state: InstallState): void;
  setBuildLine(line: string): void;
}

function sourcePhrase(source: ServerSource | null): string {
  switch (source) {
    case 'npm':
      return 'installed with npm';
    case 'extension':
      return 'installed by the extension';
    case 'offline file':
      return 'installed from an offline file';
    default:
      return 'installed';
  }
}

export class ServerSetup implements RunServerSetup, vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly out: vscode.OutputChannel;
  private readonly status: InstallStatusSink | undefined;
  private readonly version: string;
  private readonly requires: string;
  private readonly platform = process.platform;
  private readonly arch = process.arch;
  /** The install in progress in this window, which a Run waits for (§5.2). */
  private pending: Promise<InstalledServer | null> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the install starts, moves on or ends, for the welcome page. */
  readonly onDidChange = this.changed.event;
  /** What the install in progress is doing, in a few words. */
  private progressText: string | null = null;

  private setState(state: InstallState): void {
    this.status?.setInstallState(state);
    if (state !== 'installing') this.progressText = null;
    this.changed.fire();
  }

  constructor(context: vscode.ExtensionContext, out: vscode.OutputChannel, status?: InstallStatusSink) {
    this.context = context;
    this.out = out;
    this.status = status;
    const manifest = context.extension.packageJSON as { version?: string; steptixServer?: string };
    this.version = String(manifest.version);
    this.requires = serverRequirement(manifest) ?? this.version;
  }

  dispose(): void {
    this.changed.dispose();
    if (this.timer) clearInterval(this.timer);
    for (const d of this.disposables) d.dispose();
  }

  private log(line: string): void {
    this.out.appendLine(`[${new Date().toISOString().slice(11, 23)}] install: ${line}`);
  }

  /** The Node.js the server would run on now, asked at most once a minute:
   *  every start checks it (§4.6), and asking costs a process. */
  private nodeCache: { at: number; choice: Promise<NodeChoice | null> } | undefined;

  private nodeNow(): Promise<NodeChoice | null> {
    if (!this.nodeCache || Date.now() - this.nodeCache.at > 60_000) {
      this.nodeCache = {
        at: Date.now(),
        choice: chooseNode({ userRoot: this.userRoot, env: process.env, platform: this.platform }),
      };
    }
    return this.nodeCache.choice;
  }

  private get userRoot(): string {
    return userRootDir();
  }

  private get binDir(): string {
    return path.join(this.userRoot, 'bin');
  }

  managed(): boolean {
    const settings = readAutoStartSettings(vscode.workspace.getConfiguration('steptix'));
    return !settings.command && settings.useInstalledRuntime;
  }

  private deps(extra: Partial<InstallerDeps> = {}): InstallerDeps {
    return {
      userRoot: this.userRoot,
      platform: this.platform,
      arch: this.arch,
      env: process.env,
      log: (line) => this.log(line),
      ...extra,
    };
  }

  // -------------------------------------------------------------------------
  // Finding what is on the machine
  // -------------------------------------------------------------------------

  /**
   * A `steptix` command on PATH other than the script this extension put in
   * bin/: npm's, or the Windows runtime installer's. Either makes the PATH
   * offer moot (§5.2, §5.5).
   */
  private steptixOnPath(): string | null {
    return findOnPath('steptix', process.env, this.platform, [this.binDir]);
  }

  /** npm's own `steptix` package behind that command, which is a server on
   *  the machine (§5.3). The installer's command has none. */
  private npmPackageOnPath(): string | null {
    const command = this.steptixOnPath();
    return command ? npmPackageOfCommand(command, this.platform) : null;
  }

  /**
   * npm's own install of the `steptix` package (§5.3): behind the command on
   * PATH, else where npm says it installs global packages, for when VS Code
   * could not read the shell's PATH.
   */
  private async npmPackage(node: NodeChoice | null): Promise<string | null> {
    const fromPath = this.npmPackageOnPath();
    if (fromPath) return fromPath;
    if (!node) return null;
    const npmCli = npmCliBeside(node.exe, this.platform);
    if (!npmCli) return null;
    const prefix = await defaultRunner(node.exe, [npmCli, 'prefix', '-g'], { env: process.env });
    if (prefix.code !== 0) return null;
    const dir = globalPackageDir(prefix.stdout.trim(), this.platform);
    return isSteptixPackage(dir) ? dir : null;
  }

  private logUsing(server: InstalledServer, chosen: boolean): void {
    this.log(
      `using Steptix server ${server.version}, ${sourcePhrase(server.source)}, from ${server.dir}` +
        (chosen ? ' (chosen with steptix server use)' : ''),
    );
  }

  // -------------------------------------------------------------------------
  // When the extension starts (§5.2–§5.4, §6.2, §6.8)
  // -------------------------------------------------------------------------

  /** Register the commands and, with `checks`, look for a server, ask, update
   *  and start the daily check. */
  async activate(opts: { checks: boolean }): Promise<void> {
    this.status?.setBuildLine(describeExtensionBuild(this.version, extensionBuild()));
    this.log(`${describeExtensionBuild(this.version, extensionBuild())}; needs a Steptix server ${this.requires} or a later patch`);
    this.disposables.push(
      vscode.commands.registerCommand(INSTALL_SERVER_COMMAND, (args?: { addToPath?: boolean }) =>
        this.installCommand(args?.addToPath === true),
      ),
      vscode.commands.registerCommand(ADD_TO_PATH_COMMAND, () => this.addToPath()),
      vscode.commands.registerCommand(UNINSTALL_SERVER_COMMAND, () => this.uninstallServer()),
    );
    if (!opts.checks) return;
    if (!this.managed()) {
      this.log('"steptix.serverAutoStart.command" is set or "useInstalledRuntime" is off: installing and updating servers is left to you');
      return;
    }
    try {
      await this.findOrFetchOnStart();
    } catch (err) {
      this.log(`checking for a server failed: ${(err as Error).message}`);
    }
    void this.staleTerminalCheck().catch((err: unknown) => this.log(`terminal version check failed: ${(err as Error).message}`));
    this.timer = setInterval(() => void this.patchCheck(), PATCH_CHECK_MS);
    this.timer.unref?.();
  }

  private async findOrFetchOnStart(): Promise<void> {
    const pick = currentPick(this.userRoot, this.requires);
    if (pick.kind === 'run') {
      this.logUsing(pick.server, pick.chosen);
      await this.prepareTerminals(await this.nodeNow());
      void this.patchCheck();
      return;
    }
    if (pick.kind === 'chosen-mismatch') {
      this.log(`you chose Steptix server ${pick.chosen} with steptix server use, which does not match this extension; a Run says what to do`);
      return;
    }
    const found = await this.useNpmPackage();
    if (found) return;
    if (this.anythingInstalled()) {
      // A server is on the machine by some route, so the user has said yes to
      // having one: the matching one comes without asking (§4.5, §6.2).
      void this.install({ mode: 'update' });
      return;
    }
    this.setState('not-installed');
    if (!this.context.globalState.get<boolean>(ASKED_KEY)) void this.askAndInstall('start');
  }

  /** A server of another major.minor, or npm's own package, is on the machine. */
  private anythingInstalled(): boolean {
    return listInstalledServers(path.join(this.userRoot, 'runtimes')).length > 0 || this.npmPackageOnPath() !== null;
  }

  /** §5.3: set up npm's own copy, which costs no download. True when that
   *  gave a server that matches. */
  private async useNpmPackage(): Promise<boolean> {
    const node = await this.nodeNow();
    if (!node) return false;
    const pkg = await this.npmPackage(node);
    if (!pkg) return false;
    try {
      const server = await setUpNpmPackage(this.deps(), node, pkg);
      if (!serverSatisfies(server.version, this.requires)) {
        this.log(`npm's steptix is ${server.version}, which does not match this extension; fetching a matching one`);
        return false;
      }
      this.logUsing(server, false);
      void vscode.window.showInformationMessage(`Using Steptix ${server.version} installed with npm.`);
      await this.prepareTerminals(node);
      return true;
    } catch (err) {
      this.log(`could not set up npm's steptix in ${pkg}: ${(err as Error).message}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // The install question (§4.5, §5.2)
  // -------------------------------------------------------------------------

  /**
   * Ask, then install on a yes. `start` is the one question right after the
   * extension is installed, asked once for the user; `run` is the same
   * question when a Run needs the server, with Cancel for Not now.
   */
  private async askAndInstall(when: 'start' | 'run'): Promise<InstalledServer | 'declined' | null> {
    const unsupported = unsupportedPlatformMessage(this.platform, this.arch);
    if (unsupported) {
      void vscode.window.showInformationMessage(unsupported);
      return null;
    }
    const node = await this.nodeNow();
    const mb = SERVER_DOWNLOAD_MB + (node ? 0 : NODE_DOWNLOAD_MB);
    const install = 'Install';
    const withPath = 'Install and add steptix to PATH';
    const notNow = when === 'start' ? 'Not now' : 'Cancel';
    const answers = [install, ...(this.steptixOnPath() ? [] : [withPath]), notNow];
    if (when === 'start') await this.context.globalState.update(ASKED_KEY, true);
    const answer = await vscode.window.showInformationMessage(
      when === 'start'
        ? `Steptix needs its local server to run tests. About ${mb} MB to download.`
        : `Steptix needs its local server to run this test. About ${mb} MB to download.`,
      ...answers,
    );
    if (answer !== install && answer !== withPath) {
      this.log(`install question answered "${answer ?? 'dismissed'}"`);
      return 'declined';
    }
    return this.install({ mode: 'install', addToPath: answer === withPath });
  }

  /** **Steptix: Install Server**, and the welcome page's button. */
  private async installCommand(addToPath: boolean): Promise<void> {
    const pick = currentPick(this.userRoot, this.requires);
    if (pick.kind === 'run') {
      void vscode.window.showInformationMessage(
        `Steptix server ${pick.server.version} is installed, ${sourcePhrase(pick.server.source)}.`,
      );
      if (addToPath) await this.addToPath();
      return;
    }
    if (!(await this.useNpmPackage())) await this.install({ mode: 'install', addToPath });
  }

  // -------------------------------------------------------------------------
  // Installing and updating (§5.2 step 4, §6.2, §8)
  // -------------------------------------------------------------------------

  /**
   * Install the newest matching server, or `version`, with progress. One at
   * a time in this window: a second call, a Run included, waits for the
   * first. `install` is the user's yes; `update` comes without asking.
   */
  install(opts: { mode: 'install' | 'update'; addToPath?: boolean; version?: string }): Promise<InstalledServer | null> {
    if (this.pending) {
      // One install at a time; a caller who also asked for PATH still gets it.
      if (!opts.addToPath) return this.pending;
      return this.pending.then(async (server) => {
        if (server) await this.addToPath();
        return server;
      });
    }
    const unsupported = unsupportedPlatformMessage(this.platform, this.arch);
    if (unsupported) {
      void vscode.window.showInformationMessage(unsupported);
      return Promise.resolve(null);
    }
    this.pending = this.runInstall(opts).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async runInstall(opts: { mode: 'install' | 'update'; addToPath?: boolean; version?: string }): Promise<InstalledServer | null> {
    this.setState('installing');
    this.nodeCache = undefined;
    try {
      const server = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: opts.mode === 'update' ? 'Updating the Steptix server' : 'Installing the Steptix server',
        },
        async (progress) => {
          const deps = this.deps({
            onStep: (message) => {
              progress.report({ message });
              this.progressText = message;
              this.changed.fire();
              this.log(message);
            },
            onWait: () => {
              const message = 'Waiting for Steptix to finish installing in another window';
              progress.report({ message });
              this.log(message);
            },
          });
          const node = await ensureNode(deps, true);
          if (!node) throw new InstallFailure('node-download', 'No Node.js could be found or downloaded.');
          this.log(`Node.js: ${node.origin === 'yours' ? 'using yours' : "using Steptix's own copy"}, ${node.version} (${node.exe})`);
          const version = opts.version ?? (await newestPublishedServer(deps, node, this.requires));
          progress.report({
            message: version
              ? `${opts.mode === 'update' ? 'Updating the Steptix server to' : 'Installing Steptix'} ${version}…`
              : 'Downloading the Steptix server…',
          });
          const result = version
            ? await installServerVersion(deps, node, version)
            : await installServer(deps, node, this.requires);
          return { server: result.server, node };
        },
      );
      this.setState(null);
      this.logUsing(server.server, false);
      void vscode.window.showInformationMessage(`Steptix server ${server.server.version} is ready.`);
      await this.prepareTerminals(server.node);
      if (opts.addToPath) await this.addToPath();
      return server.server;
    } catch (err) {
      this.setState(currentPick(this.userRoot, this.requires).kind === 'run' ? null : 'not-installed');
      this.reportFailure(err, () => void this.install(opts));
      return null;
    }
  }

  /** §8's message for a failed install, with the buttons that fix it. */
  private reportFailure(err: unknown, retry: () => void): void {
    const failure = err instanceof InstallFailure ? err : new InstallFailure('other', (err as Error).message);
    this.log(`install failed: ${failure.message}${failure.details ? `\n${failure.details}` : ''}`);
    if (failure.kind === 'node-download') {
      void vscode.window
        .showErrorMessage(
          `Could not download Node.js. Install Node.js 22.21 or later yourself and press Retry. (${failure.message})`,
          'Open nodejs.org',
          'Retry',
        )
        .then((choice) => {
          if (choice === 'Open nodejs.org') void vscode.env.openExternal(vscode.Uri.parse(NODEJS_URL));
          if (choice === 'Retry') retry();
        });
      return;
    }
    const message =
      failure.kind === 'server-download'
        ? `Could not download the Steptix server: ${failure.message}. If your company uses its own npm registry, ` +
          'check that npm works in a terminal (npm view steptix). Without network access, install from the offline files instead.'
        : `Could not install the Steptix server: ${failure.message}`;
    void vscode.window.showErrorMessage(message, 'Retry', 'Offline install', 'Show details').then((choice) => {
      if (choice === 'Retry') retry();
      if (choice === 'Offline install') void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
      if (choice === 'Show details') this.out.show(true);
    });
  }

  /** §6.2: a newer published patch of this major.minor comes without asking,
   *  at start and once a day. */
  private async patchCheck(): Promise<void> {
    if (!this.managed() || this.pending) return;
    const pick = currentPick(this.userRoot, this.requires);
    if (pick.kind !== 'run') return;
    const node = await this.nodeNow();
    if (!node) return;
    const newest = await newestPublishedServer(this.deps(), node, this.requires);
    const installed = listInstalledServers(path.join(this.userRoot, 'runtimes'))
      .filter((s) => serverSatisfies(s.version, this.requires))
      .at(-1);
    if (!newest || (installed && compareVersions(newest, installed.version) <= 0)) return;
    this.log(`Steptix server ${newest} is published; this machine has ${installed?.version ?? 'none'}`);
    if (pick.chosen) {
      this.log('a version was chosen with steptix server use, so the new one is installed beside it and not run');
    }
    await this.install({ mode: 'update', version: newest });
  }

  // -------------------------------------------------------------------------
  // The welcome page's server step (§7.1)
  // -------------------------------------------------------------------------

  /** The welcome page's **Use newest server**: undo a `steptix server use`
   *  choice, as a Run's Use newest does. */
  useNewestServer(): void {
    clearServerChoice(this.userRoot);
    this.log('cleared the steptix server use choice: the newest matching server runs');
    this.changed.fire();
  }

  async welcomeServerState(): Promise<WelcomeState['server']> {
    const onPath = this.steptixOnPath() !== null || readPathChanges(this.userRoot).length > 0;
    if (!this.managed()) {
      return { state: 'yours', detail: 'Steptix starts the server your settings name ("steptix.serverAutoStart").', progress: null, onPath };
    }
    if (this.pending) {
      return { state: 'installing', detail: 'Installing the Steptix server.', progress: this.progressText, onPath };
    }
    const pick = currentPick(this.userRoot, this.requires);
    if (pick.kind === 'chosen-mismatch') {
      // Installing would not help: the choice still wins over what is installed.
      return {
        state: 'chosen',
        detail:
          `You chose Steptix server ${pick.chosen} with steptix server use, but this extension is ${this.version}. ` +
          `Install extension ${pick.chosen} to match, or go back to the newest server.`,
        progress: null,
        onPath,
      };
    }
    if (pick.kind === 'run') {
      const node = await this.nodeNow();
      const runsOn = node ? `, running on ${node.origin === 'yours' ? 'your' : "Steptix's own"} Node.js ${node.version}` : '';
      return {
        state: 'ready',
        detail: `Steptix ${pick.server.version}, ${sourcePhrase(pick.server.source)}${runsOn}.` +
          (onPath ? ' The steptix command works in every terminal.' : " The steptix command works in VS Code's terminal."),
        progress: null,
        onPath,
      };
    }
    const unsupported = unsupportedPlatformMessage(this.platform, this.arch);
    if (unsupported) return { state: 'unsupported', detail: unsupported, progress: null, onPath };
    const node = await this.nodeNow();
    return {
      state: 'not-installed',
      detail: `Runs your tests on this machine. About ${SERVER_DOWNLOAD_MB + (node ? 0 : NODE_DOWNLOAD_MB)} MB to download.`,
      progress: null,
      onPath,
    };
  }

  // -------------------------------------------------------------------------
  // For a Run (§5.2, §6.4, §6.5)
  // -------------------------------------------------------------------------

  async ensureRuntime(args: { signal: AbortSignal; log: (line: string) => void }): Promise<EnsureRuntimeResult> {
    if (this.pending) {
      args.log('waiting for the Steptix server install to finish');
      await this.pending;
      if (args.signal.aborted) return { kind: 'aborted' };
    }
    let pick = currentPick(this.userRoot, this.requires);
    if (pick.kind === 'chosen-mismatch') {
      const useNewest = 'Use newest';
      const choice = await vscode.window.showWarningMessage(
        `You chose Steptix server ${pick.chosen}, but this extension is ${this.version}. Install extension ` +
          `${pick.chosen} to match (Extensions view → Steptix → Install Another Version), or go back to the newest server.`,
        useNewest,
        'Show how',
      );
      if (choice === 'Show how') {
        void vscode.commands.executeCommand('workbench.extensions.search', `@id:${this.context.extension.id}`);
      }
      if (choice !== useNewest) {
        return {
          kind: 'fail',
          payload: reportError('STX035', {
            serverUrl: '',
            serverVersion: pick.chosen,
            extensionVersion: this.version,
            reason: 'chosen',
          }),
        };
      }
      clearServerChoice(this.userRoot);
      args.log('cleared the steptix server use choice: the newest matching server runs');
      pick = currentPick(this.userRoot, this.requires);
    }

    let server: InstalledServer | null = pick.kind === 'run' ? pick.server : null;
    if (!server) {
      // A matching runtime from the Windows runtime installer, which ships
      // until the release that replaces it, runs as it did before: through
      // its own steptix.cmd, which finds its Node.js itself.
      const legacy = findInstalledRuntime(path.join(this.userRoot, 'runtimes'));
      if (legacy && serverSatisfies(legacy.version, this.requires)) {
        args.log(`Steptix server ${legacy.version} from the Windows runtime installer, in ${legacy.dir}`);
        return { kind: 'ready', runtime: legacy };
      }
    }
    if (!server && (await this.useNpmPackage())) {
      const again = currentPick(this.userRoot, this.requires);
      server = again.kind === 'run' ? again.server : null;
    }
    if (!server) {
      const unsupported = unsupportedPlatformMessage(this.platform, this.arch);
      if (unsupported) return { kind: 'fail', payload: reportError('STX034', { situation: 'unsupported', detail: unsupported }) };
      const got = this.anythingInstalled() ? await this.install({ mode: 'update' }) : await this.askAndInstall('run');
      if (args.signal.aborted) return { kind: 'aborted' };
      if (got === 'declined') return { kind: 'fail', payload: reportError('STX034', { situation: 'declined' }) };
      if (!got) {
        return { kind: 'fail', payload: reportError('STX034', { situation: 'failed', detail: 'see the message and the Output panel for why' }) };
      }
      server = got;
    }

    // §4.6, checked at every start: the user's own Node.js when it is new
    // enough, else Steptix's own, else one is downloaded: the server is on
    // the machine, so the user has already said yes to what it needs.
    let node: NodeChoice | null;
    try {
      node = (await this.nodeNow()) ?? (await ensureNode(this.deps(), true));
    } catch (err) {
      this.reportFailure(err, () => undefined);
      return { kind: 'fail', payload: reportError('STX034', { situation: 'failed', detail: (err as Error).message }) };
    }
    if (!node) return { kind: 'fail', payload: reportError('STX034', { situation: 'failed', detail: 'no Node.js 22.21 or later was found' }) };
    args.log(`Steptix server ${server.version}, ${sourcePhrase(server.source)}, on Node.js ${node.version} (${node.origin === 'yours' ? 'yours' : "Steptix's own"})`);
    return { kind: 'ready', runtime: { version: server.version, dir: server.dir, node: node.exe } };
  }

  async checkRunning(args: {
    serverUrl: string;
    health: ServerHealth;
    signal: AbortSignal;
    log: (line: string) => void;
    probe: HealthProbe;
    apiKey: () => string | undefined;
  }): Promise<CheckRunningResult> {
    const { serverUrl, health, signal, log } = args;
    // A server too old to say its version is left to the legacy path.
    if (!health.version || serverSatisfies(health.version, this.requires)) return { kind: 'use' };
    const shown = describeServerVersion(health) ?? health.version;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    if (health.startedBy !== 'vscode') {
      log(`the server at ${serverUrl} is ${shown}, started by ${health.startedBy ?? 'someone, by hand'}, and does not match ${this.requires}`);
      const stop = 'Stop it';
      const choice = await vscode.window.showWarningMessage(
        `A Steptix server you started (${health.version}, at ${serverUrl}) does not match this extension (${this.version}). ` +
          'Stop it and press Run again, or start a matching one yourself with `steptix serve`.',
        stop,
        'Cancel',
      );
      if (choice !== stop) {
        return {
          kind: 'fail',
          payload: reportError('STX035', { serverUrl, serverVersion: health.version, extensionVersion: this.version, reason: 'person' }),
        };
      }
    } else if ((health.runsInFlight ?? 0) > 0) {
      // Another window, still on the old extension, is running a test in it:
      // wait for that, then replace it (§6.4).
      const finished = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Waiting for a test in another window to finish before updating the Steptix server' },
        async () => {
          for (;;) {
            if (signal.aborted) return false;
            await sleep(1_000);
            const now = await args.probe(serverUrl, 1_000, signal);
            if (now.kind !== 'healthy' || (now.health.runsInFlight ?? 0) === 0) return true;
          }
        },
      );
      if (!finished) return { kind: 'aborted' };
    }

    const key = args.apiKey();
    log(`stopping the Steptix server ${shown} at ${serverUrl} to start ${this.requires}'s major.minor in its place`);
    const stopped = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating the Steptix server to ${this.requires.replace(/\.\d+$/, '')}…` },
      async () =>
        (key !== undefined && (await requestServerShutdown(serverUrl, key))) &&
        waitUntilDown({ serverUrl, probe: args.probe, sleep, timeoutMs: 30_000, signal }),
    );
    if (signal.aborted) return { kind: 'aborted' };
    if (!stopped) {
      return {
        kind: 'fail',
        payload: reportError('STX035', {
          serverUrl,
          serverVersion: health.version,
          extensionVersion: this.version,
          reason: 'not-stopped',
        }),
      };
    }
    return { kind: 'replaced' };
  }

  // -------------------------------------------------------------------------
  // `steptix` in terminals (§5.5)
  // -------------------------------------------------------------------------

  /**
   * Put the `steptix` script in `<user root>/bin` and that folder on the
   * PATH of VS Code's own terminals, unless npm's `steptix` is on PATH
   * already. Rewritten each time, so the Node.js it names stays current.
   */
  private async prepareTerminals(node: NodeChoice | null): Promise<void> {
    const collection = this.context.environmentVariableCollection;
    if (this.steptixOnPath() || !node) {
      collection.delete('PATH');
      return;
    }
    try {
      this.writeBinScripts(node);
    } catch (err) {
      this.log(`could not write the steptix command into ${this.binDir}: ${(err as Error).message}`);
      return;
    }
    collection.description = 'Puts the steptix command in this terminal';
    collection.append('PATH', path.delimiter + this.binDir);
  }

  private writeBinScripts(node: NodeChoice): void {
    mkdirSync(this.binDir, { recursive: true });
    for (const [name, file] of Object.entries(binScripts({ nodeExe: node.exe, requires: this.requires, platform: this.platform, binDir: this.binDir }))) {
      const target = path.join(this.binDir, name);
      if (existsSync(target) && !readFileSync(target, 'utf-8').includes(BIN_SCRIPT_MARK)) {
        throw new Error(`${target} belongs to another Steptix install, so it was left as it is`);
      }
      writeFileSync(target, file.content);
      if (file.mode !== undefined) chmodSync(target, file.mode);
    }
  }

  /** Remove what writeBinScripts and Add steptix to PATH wrote, and bin/ when
   *  that leaves it empty. Another install's files there stay. */
  private removeBinScripts(): void {
    let names: string[];
    try {
      names = readdirSync(this.binDir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.binDir, name);
      let text = '';
      try {
        text = readFileSync(file, 'utf-8');
      } catch {
        // A folder, or unreadable: not one of ours.
      }
      const ours =
        name === 'run-newest.mjs' || name === path.basename(pathChangesFile(this.userRoot)) || text.includes(BIN_SCRIPT_MARK);
      if (ours) rmSync(file, { force: true });
    }
    if (readdirSync(this.binDir).length === 0) rmSync(this.binDir, { recursive: true, force: true });
  }

  /** **Steptix: Add steptix to PATH**: `steptix` in every terminal, not only VS Code's. */
  async addToPath(): Promise<void> {
    if (this.steptixOnPath()) {
      void vscode.window.showInformationMessage(`steptix is already on PATH: ${this.steptixOnPath()}.`);
      return;
    }
    const node = await this.nodeNow();
    if (!node || currentPick(this.userRoot, this.requires).kind !== 'run') {
      void vscode.window.showWarningMessage('Install the Steptix server first: run "Steptix: Install Server".');
      return;
    }
    try {
      this.writeBinScripts(node);
      const change = this.platform === 'win32' ? await this.addToWindowsUserPath() : this.addToPosixPath();
      const changes = readPathChanges(this.userRoot).filter((c) => !(c.kind === change?.kind && c.target === change.target));
      if (change) changes.push(change);
      writeFileSync(pathChangesFile(this.userRoot), JSON.stringify(changes, null, 2) + '\n');
      const said =
        change?.kind === 'rc-line'
          ? ` Added a line to ${change.target.replace(os.homedir(), '~')}.`
          : change?.kind === 'link'
            ? ` Added a link in ${path.dirname(change.target).replace(os.homedir(), '~')}.`
            : '';
      void vscode.window.showInformationMessage(`steptix is on PATH. Reopen any terminal that is already open.${said}`);
    } catch (err) {
      this.log(`adding steptix to PATH failed: ${(err as Error).message}`);
      void vscode.window.showErrorMessage(
        `Could not add steptix to PATH: ${(err as Error).message}. Add ${this.binDir} to PATH yourself.`,
      );
    }
  }

  /** Windows: the folder at the end of the user's own `Path`, every other
   *  entry as it was, in PowerShell, which every supported Windows has. */
  private async addToWindowsUserPath(): Promise<PathChange | null> {
    const current = await this.windowsUserPath();
    const next = addToWindowsPath(current, this.binDir);
    if (next !== null) await this.setWindowsUserPath(next);
    return { kind: 'windows-user-path', target: this.binDir };
  }

  private windowsUserPath(): Promise<string> {
    return this.powershell(
      "$v = (Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames'); [Console]::Out.Write($v)",
    );
  }

  private async setWindowsUserPath(value: string): Promise<void> {
    // The value goes in through the environment, so nothing in it is ever
    // read as PowerShell. Kept as REG_EXPAND_SZ so %VARIABLE% entries still
    // expand, then the change is announced so new terminals see it.
    await this.powershell(
      "Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value $env:STEPTIX_NEW_PATH -Type ExpandString;" +
        "Add-Type -Namespace Steptix -Name Native -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);';" +
        '$r = [System.UIntPtr]::Zero; [void][Steptix.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r)',
      { STEPTIX_NEW_PATH: value },
    );
  }

  private powershell(script: string, env: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
        (err, stdout, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve(String(stdout))),
      );
    });
  }

  /** macOS and Linux: a link in ~/.local/bin when that is on PATH, else one
   *  line in the shell's startup file. */
  private addToPosixPath(): PathChange {
    const home = os.homedir();
    const localBin = path.join(home, '.local', 'bin');
    const onPath = (process.env['PATH'] ?? '').split(':').some((d) => path.resolve(d) === localBin);
    if (onPath) {
      const link = path.join(localBin, 'steptix');
      mkdirSync(localBin, { recursive: true });
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
      } catch {
        // No link yet.
      }
      symlinkSync(path.join(this.binDir, 'steptix'), link);
      return { kind: 'link', target: link };
    }
    const rc = shellRcFile(home, process.env['SHELL']);
    const content = existsSync(rc) ? readFileSync(rc, 'utf-8') : '';
    const next = addShellRcLine(content, this.binDir);
    if (next !== null) writeFileSync(rc, next);
    return { kind: 'rc-line', target: rc };
  }

  // -------------------------------------------------------------------------
  // Uninstall Server (§9.2)
  // -------------------------------------------------------------------------

  async uninstallServer(): Promise<void> {
    const remove = 'Remove';
    const choice = await vscode.window.showWarningMessage(
      'Remove every Steptix server, the Node.js Steptix downloaded, and the steptix command it set up? ' +
        'Your test projects, the machine key and downloaded browsers stay.',
      { modal: true },
      remove,
    );
    if (choice !== remove) return;
    const runtimes = listInstalledServers(path.join(this.userRoot, 'runtimes'));
    const problems: string[] = [];
    const newest = runtimes.at(-1);
    if (newest) {
      const node = await this.nodeNow();
      if (!node) {
        problems.push('no Node.js was found to run the removal');
      } else {
        // The launcher's own removal: it waits for nothing to run from a
        // version, and refuses while a server does.
        const result = await defaultRunner(node.exe, [path.join(newest.dir, 'dist', 'index.js'), 'uninstall', '--yes'], {
          env: process.env,
        });
        this.log(`steptix uninstall: ${result.stdout.trim()} ${result.stderr.trim()}`);
        if (result.code !== 0) problems.push(result.stderr.trim() || result.stdout.trim() || 'steptix uninstall failed');
      }
    }
    if (problems.length > 0) {
      void vscode.window.showErrorMessage(
        `Steptix: nothing was removed. ${problems.join(' ')} Stop the server first ("Steptix: Stop Server"), then try again.`,
      );
      return;
    }
    for (const change of readPathChanges(this.userRoot)) {
      try {
        if (change.kind === 'windows-user-path') {
          const next = removeFromWindowsPath(await this.windowsUserPath(), change.target);
          if (next !== null) await this.setWindowsUserPath(next);
        } else if (change.kind === 'link') {
          if (lstatSync(change.target).isSymbolicLink()) unlinkSync(change.target);
        } else {
          const next = removeShellRcLine(readFileSync(change.target, 'utf-8'), this.binDir);
          if (next !== null) writeFileSync(change.target, next);
        }
      } catch (err) {
        problems.push(`could not undo the PATH change in ${change.target}: ${(err as Error).message}`);
      }
    }
    this.context.environmentVariableCollection.delete('PATH');
    this.nodeCache = undefined;
    try {
      this.removeBinScripts();
      rmSync(path.join(this.userRoot, 'node'), { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      problems.push((err as Error).message);
    }
    this.setState('not-installed');
    if (problems.length > 0) {
      void vscode.window.showWarningMessage(`Steptix: the servers are removed, but ${problems.join('; ')}.`);
      return;
    }
    void vscode.window.showInformationMessage(
      'Removed the Steptix server, its Node.js and the steptix command. To remove the extension too, uninstall it from the Extensions view.',
    );
  }

  // -------------------------------------------------------------------------
  // The terminal falls behind (§6.8)
  // -------------------------------------------------------------------------

  private async staleTerminalCheck(): Promise<void> {
    if (this.context.globalState.get<boolean>(STALE_DISMISSED_KEY)) return;
    const node = await this.nodeNow();
    const pkg = await this.npmPackage(node);
    const terminal = pkg ? packageVersionAt(pkg) : null;
    if (!terminal) return;
    const notice = staleTerminalNotice(terminal, this.version);
    if (!notice || this.context.globalState.get<string>(STALE_SHOWN_FOR_KEY) === terminal) return;
    await this.context.globalState.update(STALE_SHOWN_FOR_KEY, terminal);
    const older = compareVersions(terminal, this.version) < 0;
    const copy = 'Copy command';
    const never = "Don't show again";
    const choice = await vscode.window.showInformationMessage(notice, ...(older ? [copy] : []), never);
    if (choice === copy) await vscode.env.clipboard.writeText('npm i -g steptix');
    if (choice === never) await this.context.globalState.update(STALE_DISMISSED_KEY, true);
  }
}
