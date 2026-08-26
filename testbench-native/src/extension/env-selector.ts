import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { getOutputChannel } from './output-channel.js';
import { DEFAULT_DATA_DIR, readProjectDirs } from './aiui-config-parse.js';

const SETTING_KEY = 'activeEnv';
const COMMAND_ID = 'testbench-native.selectEnv';
const STATUS_BAR_PRIORITY = 100;
const UNSET_LABEL = '(none)';

/**
 * Status-bar control + command for picking the active environment.
 *
 * - Shows `🌐 env: <name>` (or `🌐 env: (none)`) on the right of the status bar
 *   while a TestBench-eligible Markdown file is the active tab.
 * - Clicking opens a QuickPick listing every env discovered by scanning the
 *   workspace for `fixtures/data/*.json` and `.env.*` files.
 * - Selection writes `testbench-native.activeEnv` to workspace settings so it persists
 *   across reloads and is per-workspace (not global).
 *
 * Reading the setting elsewhere (e.g. run-controller, future Flick app) gives
 * a single source of truth for which env runs should target.
 */
export class EnvSelector implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    this.item.command = COMMAND_ID;
    this.item.tooltip = 'TestBench: pick the environment for the next run';

    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(COMMAND_ID, () => this.pickEnv()),
      // Tab-group event (not onDidChangeActiveTextEditor) so we also fire when
      // the focus moves to a custom-editor tab — `activeTextEditor` is
      // undefined while a TestBench webview is the active editor, which
      // would otherwise hide this item exactly when it's most useful.
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`testbench-native.${SETTING_KEY}`)) this.refresh();
      }),
    );

    this.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** Read the active env from settings — null when unset. */
  static activeEnv(): string | null {
    const cfg = vscode.workspace.getConfiguration('testbench-native');
    const v = cfg.get<string>(SETTING_KEY)?.trim();
    return v ? v : null;
  }

  private refresh(): void {
    const uri = activeTabUri();
    const isMarkdown = uri?.fsPath.toLowerCase().endsWith('.md') === true;
    if (!isMarkdown) {
      this.item.hide();
      return;
    }

    const env = EnvSelector.activeEnv() ?? UNSET_LABEL;
    this.item.text = `$(globe) env: ${env}`;
    this.item.show();
  }

  private async pickEnv(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage('TestBench: open a workspace folder to select an env.');
      return;
    }

    const envs = await discoverEnvs(folder.uri.fsPath);
    const items: vscode.QuickPickItem[] = [
      { label: UNSET_LABEL, description: 'Clear env selection — no .env.<name> or data file loaded' },
      ...envs.map<vscode.QuickPickItem>((e) => ({
        label: e.name,
        description: e.sources.join(' + '),
      })),
    ];

    const current = EnvSelector.activeEnv();
    const pick = await vscode.window.showQuickPick(items, {
      title: 'TestBench — select active environment',
      placeHolder: current ? `currently: ${current}` : 'currently: (none)',
    });
    if (!pick) return;

    const cfg = vscode.workspace.getConfiguration('testbench-native');
    const newValue = pick.label === UNSET_LABEL ? '' : pick.label;
    await cfg.update(SETTING_KEY, newValue, vscode.ConfigurationTarget.Workspace);
    getOutputChannel().appendLine(
      `[${new Date().toISOString().slice(11, 23)}] env selector: active env = ${newValue || '(none)'}`,
    );
    this.refresh();
  }
}

/** URI of the resource shown in the focused tab — works for both plain
 *  text editors and custom editors (TestBench's webview). Returns
 *  `undefined` for tab kinds we don't care about (terminal, diff, etc.). */
function activeTabUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab) return undefined;
  if (tab.input instanceof vscode.TabInputText) return tab.input.uri;
  if (tab.input instanceof vscode.TabInputCustom) return tab.input.uri;
  return undefined;
}

interface DiscoveredEnv {
  name: string;
  /** Which evidence sources this env was discovered from — `.env.foo`, `fixtures/data/foo.json`. */
  sources: string[];
}

/**
 * Scan workspace root for `.env.*` files (excluding `.env.example`) and
 * `<dataDir>/*.json` files (default `data`, overridable via `tests.dataDir` in
 * `aiui.config.json`). Each filename stem is treated as an env name; the source
 * list helps the user pick when an env is half-defined (just .env, no data file
 * or vice versa).
 */
export async function discoverEnvs(root: string): Promise<DiscoveredEnv[]> {
  const found = new Map<string, Set<string>>();

  // Read tests.dataDir from aiui.config.json at the workspace root (default `data`).
  const dataDirRelative = readDataDirFromConfig(root);

  // .env.<name> files at workspace root
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const m = entry.name.match(/^\.env\.([A-Za-z0-9_-]+)$/);
      if (!m) continue;
      const name = m[1]!;
      if (name === 'example') continue;
      addSource(found, name, `.env.${name}`);
    }
  } catch {
    /* no workspace root readable — return whatever we have */
  }

  // <dataDir>/*.json files
  const dataDir = path.join(root, dataDirRelative);
  try {
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const m = entry.name.match(/^([A-Za-z0-9_-]+)\.json$/);
      if (!m) continue;
      addSource(found, m[1]!, `${dataDirRelative}/${m[1]}.json`);
    }
  } catch {
    /* no data dir — fine */
  }

  return Array.from(found.entries())
    .map(([name, sources]) => ({ name, sources: Array.from(sources).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read `tests.dataDir` from `<root>/aiui.config.json` if present; fall back to
 *  the default (`data`). Mirrors the server's config-driven data dir. */
function readDataDirFromConfig(root: string): string {
  return readProjectDirs(path.join(root, 'aiui.config.json'))?.dataDir ?? DEFAULT_DATA_DIR;
}

function addSource(map: Map<string, Set<string>>, name: string, source: string): void {
  let set = map.get(name);
  if (!set) {
    set = new Set();
    map.set(name, set);
  }
  set.add(source);
}
