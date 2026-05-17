import * as vscode from 'vscode';
import { maskIfSecret } from 'ai-ui-automation-runner-core';

/**
 * Read-only TreeView contributed to the TestBench activity-bar container.
 * Shows the current variable scope emitted by the server's `frame:scope`
 * events.
 *
 * Phase 4 ships a flat scope view: the server emits the entire
 * `resolvedParameters` map per step (including any `__skillN_x`
 * namespaced internals). Per-frame filtering / reverse-rename resolution
 * is tracked as a Phase 4.B follow-up — for now the user sees the actual
 * runtime state, leaky abstractions and all, which is better than
 * mystery hiding.
 *
 * Secret-named entries (`password`, `token`, `apikey`, ...) are masked
 * via `maskIfSecret` from runner-core. Names that contain none of those
 * patterns show the raw value.
 */
export interface ScopeSource {
  /** Current scope to render, or empty when no run is in flight. */
  currentScope(): Record<string, string>;
}

interface VariableNode {
  name: string;
  rawValue: string;
}

export class VariablesTreeProvider implements vscode.TreeDataProvider<VariableNode> {
  private readonly emitter = new vscode.EventEmitter<VariableNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly source: ScopeSource) {}

  dispose(): void {
    this.emitter.dispose();
  }

  /** External refresh trigger. Both frame:scope events and frame-stack
   *  transitions (which change which frame is "current") need to cause
   *  a re-render, so the caller multiplexes them through this. */
  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: VariableNode): vscode.TreeItem {
    const display = maskIfSecret(node.name, node.rawValue);
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.description = display;
    item.iconPath = new vscode.ThemeIcon('symbol-variable');
    // Tooltip shows the unmasked length so users can sanity-check a
    // captured token / cookie without revealing it. The full value is
    // available via the "copy variable value" command if we ever add
    // one — out of scope for Phase 4 MVP.
    item.tooltip = `${node.name} (${node.rawValue.length} chars)`;
    return item;
  }

  getChildren(node?: VariableNode): VariableNode[] {
    if (node) return [];
    const scope = this.source.currentScope();
    // Sort alphabetically so updates don't reorder the visible list
    // when a single variable changes. Skill-internal names
    // (`__skillN_x`) bubble to the top because of the underscore — not
    // ideal, but acceptable until Phase 4.B filters them per frame.
    const names = Object.keys(scope).sort();
    return names.map((name) => ({ name, rawValue: scope[name] ?? '' }));
  }
}
