import * as vscode from 'vscode';
import { getOutputChannel } from './output-channel.js';
import { describeServerUrlOrigin } from './server-url.js';
import { SERVER_MENU_COMMAND, type ServerStatusBar } from './server-status-bar.js';
import {
  decideServerAction,
  defaultHealthProbe,
  defaultServerSpawner,
  describeHealth,
  describeServerVersion,
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

  /** The one reason `resolveTarget` comes back empty that a user can act on
   *  from here; the other (an unreadable machine .env) a Run names as STX007. */
  const noTarget = (): void => {
    void vscode.window.showWarningMessage(
      'Steptix: open a folder first — the server is resolved from its .env.',
    );
  };

  const startServer = async (): Promise<void> => {
    const target = await statusBar.resolveTarget();
    if (!target) return noTarget();

    const result = await probe(target.serverUrl, HEALTH_PROBE_TIMEOUT_MS);
    const config = readAutoStartSettings(vscode.workspace.getConfiguration('steptix'));
    const action = decideServerAction(target.serverUrl, result, config);

    switch (action.kind) {
      case 'proceed':
        statusBar.apply(target.serverUrl, result);
        void vscode.window.showInformationMessage(
          `Steptix: a server is already running on ${target.serverUrl}.`,
        );
        return;
      case 'refuse-foreign':
        statusBar.apply(target.serverUrl, result);
        void vscode.window.showErrorMessage(
          `Steptix: ${target.serverUrl} is served by "${action.service}", not steptix. ` +
            'Refusing to start a server on top of it.',
        );
        return;
      case 'legacy':
        statusBar.apply(target.serverUrl, result);
        void vscode.window.showWarningMessage(
          `Steptix: something is already answering on ${target.serverUrl} (${action.detail}) — ` +
            'not starting another server on that port.',
        );
        return;
      case 'skip':
        // Same preconditions the run path enforces: localhost only, and a
        // command setting or an installed runtime to start.
        await offerAutoStartSettings(`Steptix: cannot start a server — ${action.reason}.`);
        return;
      case 'refuse-port': {
        // The run path's STX033: a server on another port is one nothing
        // here would talk to.
        const { servePort } = action;
        const port = new URL(target.serverUrl).port || '80';
        void vscode.window.showErrorMessage(
          servePort.ok
            ? `Steptix: ${target.serverUrl} (from ${describeServerUrlOrigin(target.origin)}) is not running, and ` +
                `"steptix.serverAutoStart.command" would start a server on port ${servePort.port} ` +
                `(from ${servePort.source}) instead. Start one yourself with \`steptix serve -p ${port}\`, ` +
                `or add -p ${port} after serve in the command.`
            : `Steptix: cannot start a server — it would not start: ${servePort.reason}.`,
        );
        return;
      }
      case 'spawn':
        if (action.runtime) {
          log(`using the Steptix runtime ${action.runtime.version} installed in ${action.runtime.dir}`);
        }
        break;
    }

    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Steptix: starting server…' },
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
          `Steptix: server started on ${target.serverUrl}` +
            (started.health.version ? ` — v${describeServerVersion(started.health)}` : ''),
        );
        return;
      case 'refused':
        await offerAutoStartSettings(`Steptix: cannot start the server — ${started.reason}.`);
        break;
      case 'foreign':
        void vscode.window.showErrorMessage(
          `Steptix: "${started.service}" took ${target.serverUrl} while we were starting.`,
        );
        break;
      case 'timeout':
        await offerServerLog(
          `Steptix: the server did not come up within ${started.seconds}s` +
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
    if (!target) return noTarget();
    if (!target.apiKey) {
      void vscode.window.showErrorMessage(
        'Steptix: no STEPTIX_SERVER_API_KEY anywhere — not in the workspace .env, the process ' +
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
        `Steptix: no server answered at ${target.serverUrl} (${err instanceof Error ? err.message : String(err)}).`,
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
      // under the open SSE stream surfaces in the runner panel as STX014.
      const choice = await vscode.window.showWarningMessage(
        `Steptix: ${body.runsInFlight ?? '?'} run(s) still executing (${body.openSessions ?? '?'} session(s) open). ` +
          'Open sessions alone never block a stop — only an executing run does.',
        'Force stop (the current run will fail with a dropped-stream error)',
      );
      if (choice) await stopServer(true);
      return;
    }

    if (res.status === 401) {
      void vscode.window.showErrorMessage(
        `Steptix: ${target.serverUrl} rejected STEPTIX_SERVER_API_KEY. The key Steptix resolved ` +
          '(workspace .env, process environment, or the machine key file) must match the one the ' +
          'server process was started with (e.g. its --env-file).',
      );
      return;
    }

    // 503 means the shutdown gate is already up — an idle expiry or another
    // stop got there first, which is success, not failure.
    if (!res.ok && res.status !== 503) {
      void vscode.window.showErrorMessage(`Steptix: stop failed — HTTP ${res.status}.`);
      return;
    }

    log(`stop accepted by ${target.serverUrl}${res.status === 503 ? ' (already shutting down)' : ''}`);
    void vscode.window.showInformationMessage(`Steptix: stopping the server on ${target.serverUrl}.`);
    // Teardown closes browsers before exiting, so give it a beat — otherwise
    // the status bar would still report "running".
    await sleep(600);
    await statusBar.refresh();
  };

  const serverStatus = async (): Promise<void> => {
    const target = await statusBar.resolveTarget();
    if (!target) return noTarget();
    const result = await probe(target.serverUrl, HEALTH_PROBE_TIMEOUT_MS);
    // One probe, two consumers — the toast and the item render the same
    // answer rather than each fetching their own.
    statusBar.apply(target.serverUrl, result);
    const { headline, detail, warn } = describeHealth(target.serverUrl, result);
    const show = warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`Steptix: ${headline}. ${detail.replace(/\n/g, ' · ')}`);
  };

  const showServerLog = async (): Promise<void> => {
    const uri = vscode.Uri.file(logPath());
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } catch {
      void vscode.window.showInformationMessage(
        `Steptix: no server log yet at ${uri.fsPath} — it appears once Steptix starts a server.`,
      );
    }
  };

  /** The status-bar click target: every command above, in one list. */
  const serverMenu = async (): Promise<void> => {
    const pick = await vscode.window.showQuickPick(
      COMMANDS.map((c) => ({ label: c.label, command: c.id })),
      { title: 'Steptix — server' },
    );
    if (pick) await vscode.commands.executeCommand(pick.command);
  };

  async function offerAutoStartSettings(message: string): Promise<void> {
    const open = await vscode.window.showErrorMessage(message, 'Open Settings');
    if (open) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'steptix.serverAutoStart',
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
    { id: 'steptix.startServer', label: '$(play) Start Server', run: startServer },
    { id: 'steptix.stopServer', label: '$(debug-stop) Stop Server', run: () => stopServer(false) },
    { id: 'steptix.serverStatus', label: '$(info) Server Status', run: serverStatus },
    { id: 'steptix.showServerLog', label: '$(output) Show Server Log', run: showServerLog },
  ];

  return [
    ...COMMANDS.map((c) => vscode.commands.registerCommand(c.id, c.run)),
    vscode.commands.registerCommand(SERVER_MENU_COMMAND, serverMenu),
  ];
}
