import * as vscode from 'vscode';
import { getOutputChannel } from './output-channel.js';
import { SERVER_MENU_COMMAND, type ServerStatusBar } from './server-status-bar.js';
import {
  decideServerAction,
  defaultHealthProbe,
  defaultServerSpawner,
  describeHealth,
  normalizeBaseUrl,
  readAutoStartSettings,
  startServerAndWait,
  HEALTH_PROBE_TIMEOUT_MS,
  type HealthProbe,
  type ServerSpawner,
} from './server-manager.js';

/**
 * Manual server control (story server-lifecycle §6): Start / Stop / Status /
 * Show Log, plus the QuickPick the status-bar item opens.
 *
 * Both the triage (`decideServerAction`) and the spawn+poll
 * (`startServerAndWait`) are shared with the pre-run auto-start. A Start
 * Server that decided differently from the automatic one would be a second
 * thing to debug — and did: an earlier draft of this file lost the
 * "only auto-start a localhost URL" rule.
 */
export function registerServerCommands(args: {
  statusBar: ServerStatusBar;
  /** `<globalStorage>/server.log`. */
  logPath: () => string;
  probe?: HealthProbe;
  spawn?: ServerSpawner;
  /** Told when a manual start succeeds, so the run path's auto-start backoff
   *  doesn't refuse the next run on a stale failure. */
  onStarted?: (serverUrl: string) => void;
}): vscode.Disposable[] {
  const { statusBar, logPath, onStarted } = args;
  const probe = args.probe ?? defaultHealthProbe;
  const spawn = args.spawn ?? defaultServerSpawner;
  const log = (line: string): void =>
    getOutputChannel().appendLine(`[${new Date().toISOString().slice(11, 23)}] server: ${line}`);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const startServer = async (): Promise<void> => {
    const target = await statusBar.resolveTarget();
    if (!target) {
      void vscode.window.showWarningMessage(
        'TestBench: no SERVER_URL — add one to the workspace root .env (or the active .env.<name>).',
      );
      return;
    }

    const result = await probe(target.serverUrl, HEALTH_PROBE_TIMEOUT_MS);
    const config = readAutoStartSettings(vscode.workspace.getConfiguration('testbench-native'));
    const action = decideServerAction(target.serverUrl, result, config);

    switch (action.kind) {
      case 'proceed':
        statusBar.apply(target.serverUrl, result);
        void vscode.window.showInformationMessage(
          `TestBench: a server is already running on ${target.serverUrl}.`,
        );
        return;
      case 'refuse-foreign':
        statusBar.apply(target.serverUrl, result);
        void vscode.window.showErrorMessage(
          `TestBench: ${target.serverUrl} is served by "${action.service}", not ai-ui-automation. ` +
            'Refusing to start a server on top of it.',
        );
        return;
      case 'legacy':
        statusBar.apply(target.serverUrl, result);
        void vscode.window.showWarningMessage(
          `TestBench: something is already answering on ${target.serverUrl} (${action.detail}) — ` +
            'not starting another server on that port.',
        );
        return;
      case 'skip':
        // Same preconditions the run path enforces: localhost only, and a
        // command must be configured.
        await offerAutoStartSettings(`TestBench: cannot start a server — ${action.reason}.`);
        return;
      case 'spawn':
        break;
    }

    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'TestBench: starting server…' },
      () =>
        startServerAndWait({
          serverUrl: target.serverUrl,
          config: action.config,
          logPath: logPath(),
          probe,
          spawn,
          sleep,
          log,
        }),
    );

    switch (started.kind) {
      case 'ready':
        onStarted?.(target.serverUrl);
        statusBar.apply(target.serverUrl, { kind: 'healthy', health: started.health });
        void vscode.window.showInformationMessage(
          `TestBench: server started on ${target.serverUrl}` +
            (started.health.version ? ` (v${started.health.version})` : ''),
        );
        return;
      case 'refused':
        await offerAutoStartSettings(`TestBench: cannot start the server — ${started.reason}.`);
        break;
      case 'foreign':
        void vscode.window.showErrorMessage(
          `TestBench: "${started.service}" took ${target.serverUrl} while we were starting.`,
        );
        break;
      case 'timeout':
        await offerServerLog(
          `TestBench: the server did not come up within ${started.seconds}s` +
            (started.logTail ? ` — ${started.logTail}` : '.'),
        );
        break;
      case 'aborted':
        break;
    }
    await statusBar.refresh();
  };

  const stopServer = async (force = false): Promise<void> => {
    const target = await statusBar.resolveTarget();
    if (!target) {
      void vscode.window.showWarningMessage('TestBench: no SERVER_URL to stop.');
      return;
    }
    if (!target.apiKey) {
      void vscode.window.showErrorMessage(
        'TestBench: no AIUI_SERVER_API_KEY anywhere — not in the workspace .env, the process ' +
          'environment, or the machine key file — cannot authenticate the stop.',
      );
      return;
    }

    let res: Response;
    try {
      res = await fetch(`${normalizeBaseUrl(target.serverUrl)}/admin/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': target.apiKey },
        body: JSON.stringify({ force }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      void vscode.window.showWarningMessage(
        `TestBench: no server answered at ${target.serverUrl} (${err instanceof Error ? err.message : String(err)}).`,
      );
      await statusBar.refresh();
      return;
    }

    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        runsInFlight?: number;
        openSessions?: number;
      };
      // Say what force costs before they press it: tearing the session down
      // under the open SSE stream surfaces in the runner panel as TB014.
      const choice = await vscode.window.showWarningMessage(
        `TestBench: ${body.runsInFlight ?? '?'} run(s) still executing (${body.openSessions ?? '?'} session(s) open). ` +
          'Open sessions alone never block a stop — only an executing run does.',
        'Force stop (the current run will fail with a dropped-stream error)',
      );
      if (choice) await stopServer(true);
      return;
    }

    if (res.status === 401) {
      void vscode.window.showErrorMessage(
        `TestBench: ${target.serverUrl} rejected AIUI_SERVER_API_KEY. The key TestBench resolved ` +
          '(workspace .env, process environment, or the machine key file) must match the one the ' +
          'server process was started with (e.g. its --env-file).',
      );
      return;
    }

    // 503 means the shutdown gate is already up — an idle expiry or another
    // stop got there first, which is success, not failure.
    if (!res.ok && res.status !== 503) {
      void vscode.window.showErrorMessage(`TestBench: stop failed — HTTP ${res.status}.`);
      return;
    }

    log(`stop accepted by ${target.serverUrl}${res.status === 503 ? ' (already shutting down)' : ''}`);
    void vscode.window.showInformationMessage(`TestBench: stopping the server on ${target.serverUrl}.`);
    // Teardown closes browsers before exiting, so give it a beat — otherwise
    // the status bar would still report "running".
    await sleep(600);
    await statusBar.refresh();
  };

  const serverStatus = async (): Promise<void> => {
    const target = await statusBar.resolveTarget();
    if (!target) {
      void vscode.window.showWarningMessage('TestBench: no SERVER_URL resolved.');
      return;
    }
    const result = await probe(target.serverUrl, HEALTH_PROBE_TIMEOUT_MS);
    // One probe, two consumers — the toast and the item render the same
    // answer rather than each fetching their own.
    statusBar.apply(target.serverUrl, result);
    const { headline, detail, warn } = describeHealth(target.serverUrl, result);
    const show = warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`TestBench: ${headline}. ${detail.replace(/\n/g, ' · ')}`);
  };

  const showServerLog = async (): Promise<void> => {
    const uri = vscode.Uri.file(logPath());
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } catch {
      void vscode.window.showInformationMessage(
        `TestBench: no server log yet at ${uri.fsPath} — it appears once TestBench starts a server.`,
      );
    }
  };

  /** The status-bar click target: every command above, in one list. */
  const serverMenu = async (): Promise<void> => {
    const pick = await vscode.window.showQuickPick(
      COMMANDS.map((c) => ({ label: c.label, command: c.id })),
      { title: 'TestBench — server' },
    );
    if (pick) await vscode.commands.executeCommand(pick.command);
  };

  async function offerAutoStartSettings(message: string): Promise<void> {
    const open = await vscode.window.showErrorMessage(message, 'Open Settings');
    if (open) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'testbench-native.serverAutoStart',
      );
    }
  }

  async function offerServerLog(message: string): Promise<void> {
    const open = await vscode.window.showErrorMessage(message, 'Show Server Log');
    if (open) await showServerLog();
  }

  /** Single table: the QuickPick and the registrations read the same rows, so
   *  a command can't appear in the menu without being registered. */
  const COMMANDS: Array<{ id: string; label: string; run: () => Promise<void> }> = [
    { id: 'testbench-native.startServer', label: '$(play) Start Server', run: startServer },
    { id: 'testbench-native.stopServer', label: '$(debug-stop) Stop Server', run: () => stopServer(false) },
    { id: 'testbench-native.serverStatus', label: '$(info) Server Status', run: serverStatus },
    { id: 'testbench-native.showServerLog', label: '$(output) Show Server Log', run: showServerLog },
  ];

  return [
    ...COMMANDS.map((c) => vscode.commands.registerCommand(c.id, c.run)),
    vscode.commands.registerCommand(SERVER_MENU_COMMAND, serverMenu),
  ];
}
