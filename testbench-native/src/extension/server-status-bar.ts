import * as vscode from 'vscode';
import * as path from 'node:path';
import { readEnvFile, readEnvOverlayFile, readMachineKey, composeEnv } from 'ai-ui-automation-runner-core';
import { EnvSelector } from './env-selector.js';
import {
  defaultHealthProbe,
  describeHealth,
  type HealthProbe,
  type HealthProbeResult,
} from './server-manager.js';

/** Command the status-bar item invokes. Exported so the registration and the
 *  item cannot drift apart into a silently dead click. */
export const SERVER_MENU_COMMAND = 'testbench-native.serverMenu';

const STATUS_BAR_PRIORITY = 99; // just left of the env selector (100)
const POLL_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;

export interface ServerTarget {
  serverUrl: string;
  apiKey: string;
}

/**
 * SERVER_URL + AIUI_SERVER_API_KEY for out-of-run operations (story
 * server-lifecycle §6.2).
 *
 * There is no test file in play, so the walk-up-from-the-test-file `.env`
 * search that runs use doesn't apply. This reads the **workspace root's**
 * `.env` composed with `.env.<activeEnv>` — the same overlay mechanism,
 * anchored where the env selector enumerates and where the CLI/server read it.
 *
 * A free function rather than a method, so the command layer can resolve a
 * target without holding a UI widget.
 */
export async function resolveServerTarget(
  workspaceRoot: string | undefined,
): Promise<ServerTarget | null> {
  if (!workspaceRoot) return null;
  let env: Record<string, string> = {};
  try {
    env = await readEnvFile(path.join(workspaceRoot, '.env'));
  } catch {
    // No readable base `.env` is not the end of it — §6.2 says the item hides
    // only when the COMPOSITION yields no SERVER_URL, and an overlay alone
    // can supply one.
  }
  const envName = EnvSelector.activeEnv();
  if (envName) {
    try {
      const overlay = await readEnvOverlayFile(workspaceRoot, envName);
      if (overlay) env = composeEnv(env, overlay);
    } catch {
      // A malformed overlay is a run-time error (TB005), not a status-bar one.
    }
  }
  const serverUrl = env['SERVER_URL']?.trim();
  if (!serverUrl) return null;
  // Same chain as a run (stories/machine-key.md): workspace .env, then the
  // extension host's environment, then the machine key. Without the fallback
  // the status bar's stop action would 401 against a machine-key server the
  // runs themselves can talk to.
  const apiKey =
    env['AIUI_SERVER_API_KEY']?.trim() ||
    process.env['AIUI_SERVER_API_KEY']?.trim() ||
    readMachineKey() ||
    '';
  return { serverUrl, apiKey };
}

/**
 * Status-bar item reporting whether the Sessions API server is up (§6).
 *
 * Hidden only when the composed env yields no SERVER_URL — in particular "no
 * env selected, SERVER_URL in the base .env" must still show it, which is the
 * common case.
 */
export class ServerStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping probes when one is slower than the interval. */
  private probing = false;
  /** A deliberate refresh arrived while probing; re-run once on completion. */
  private refreshPending = false;

  constructor(
    private readonly workspaceRoot: string | undefined,
    /** Swappable so the integration harness's fake reaches the poll too — an
     *  un-injected status bar keeps issuing real fetches at the fixture's
     *  SERVER_URL for the whole suite. */
    private probe: HealthProbe = defaultHealthProbe,
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    this.item.command = SERVER_MENU_COMMAND;
    this.disposables.push(
      this.item,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('testbench-native.activeEnv')) void this.refresh();
      }),
      // Catch up as soon as the window is looked at again, since the poll
      // stands down while it isn't.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refresh();
      }),
    );

    this.timer = setInterval(() => void this.refresh({ background: true }), POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.refresh();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const d of this.disposables) d.dispose();
  }

  /** Test-only: point the poll at a different probe. */
  setProbe(probe: HealthProbe): void {
    this.probe = probe;
  }

  /**
   * Re-probe now.
   *
   * `background: true` is the 30 s poll, which stands down while the window
   * is unfocused — otherwise every open window probes forever, including ones
   * with no test files in them; the focus listener catches up on return.
   *
   * Everything else (run start/end, the Start/Stop commands) is a response to
   * a deliberate action and refreshes regardless of focus. During a UI run the
   * driven browser usually holds focus, so gating those too would drop exactly
   * the updates §6 asks for.
   */
  async refresh(opts: { background?: boolean } = {}): Promise<void> {
    if (opts.background && !vscode.window.state.focused) return;
    if (this.probing) {
      // Don't drop a deliberate refresh that lands mid-probe: a Stop Server
      // completing inside the 30s poll's window would otherwise leave the
      // item showing a running server that has just exited, until the next
      // tick. One trailing re-run is enough however many pile up.
      if (!opts.background) this.refreshPending = true;
      return;
    }
    this.probing = true;
    this.refreshPending = false;
    try {
      const target = await resolveServerTarget(this.workspaceRoot);
      if (!target) {
        this.item.hide();
        return;
      }
      this.apply(target.serverUrl, await this.probe(target.serverUrl, PROBE_TIMEOUT_MS));
    } catch {
      // A status indicator must never surface its own failures as run errors.
      this.item.hide();
    } finally {
      this.probing = false;
    }
    if (this.refreshPending) await this.refresh();
  }

  /** Render a probe result the caller already has, instead of making the item
   *  fetch it again — every server command ends holding one. */
  apply(serverUrl: string, result: HealthProbeResult): void {
    const { headline, detail, warn } = describeHealth(serverUrl, result);
    this.item.text =
      result.kind === 'healthy'
        ? `$(play) AIUI ${result.health.version ?? ''}`.trimEnd()
        : result.kind === 'down'
          ? '$(circle-outline) AIUI'
          : '$(warning) AIUI';
    this.item.tooltip = `${headline}\n${detail}`;
    this.item.backgroundColor = warn
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  /** The target the item is tracking. Shared with the server commands so the
   *  bar and the commands can never disagree about which server they mean. */
  resolveTarget(): Promise<ServerTarget | null> {
    return resolveServerTarget(this.workspaceRoot);
  }
}
