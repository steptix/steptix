import * as vscode from 'vscode';
import type { FrameInfo } from 'steptix-runner-core';

/**
 * Read-only TreeView contributed to the Steptix activity-bar container.
 * Renders the active run's frame stack so the user can see which file +
 * frame execution is currently inside when a test descends into a
 * `[skill: ...]` invocation.
 *
 * Frames are listed top-down: the outermost (root) frame at the top of
 * the tree, the deepest (currently-executing) frame at the bottom. Phase
 * 2 ships this view read-only — clicking a frame doesn't navigate yet.
 * That lands in a later phase alongside the Step Into / Out commands so
 * frame navigation is reserved for the debugger keybindings.
 */
export interface FrameStackSource {
  /** Latest frame stack, outermost first. */
  currentStack(): readonly FrameInfo[];
  /** The test file the active run is in (the conceptual root frame). */
  currentTestUri(): vscode.Uri | null;
  /** Fires when the stack content changes. */
  onChange: vscode.Event<void>;
}

type CallStackNode =
  | { kind: 'test'; uri: vscode.Uri }
  | { kind: 'frame'; frame: FrameInfo };

export class CallStackTreeProvider implements vscode.TreeDataProvider<CallStackNode> {
  private readonly emitter = new vscode.EventEmitter<CallStackNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly source: FrameStackSource) {
    this.subs.push(source.onChange(() => this.emitter.fire()));
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }

  getTreeItem(node: CallStackNode): vscode.TreeItem {
    if (node.kind === 'test') {
      const label = node.uri.path.split(/[\\/]/).pop() ?? node.uri.fsPath;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = '(test)';
      item.iconPath = new vscode.ThemeIcon('file');
      item.tooltip = node.uri.fsPath;
      return item;
    }
    const frame = node.frame;
    const skillLabel = frame.skillName ?? 'skill';
    const item = new vscode.TreeItem(skillLabel, vscode.TreeItemCollapsibleState.None);
    item.description = `${shortenPath(frame.uri)}:${frame.line}`;
    item.iconPath = new vscode.ThemeIcon('symbol-method');
    item.tooltip = `${frame.uri}:${frame.line}`;
    return item;
  }

  getChildren(node?: CallStackNode): CallStackNode[] {
    if (node) return [];
    const stack = this.source.currentStack();
    const testUri = this.source.currentTestUri();
    const nodes: CallStackNode[] = [];
    if (testUri) nodes.push({ kind: 'test', uri: testUri });
    // Outermost first → deepest last, so the list reads top-to-bottom as
    // call chain. The frame stack itself already runs in that order.
    for (const frame of stack) nodes.push({ kind: 'frame', frame });
    return nodes;
  }
}

function shortenPath(p: string): string {
  return p.split(/[\\/]/).slice(-2).join('/');
}
