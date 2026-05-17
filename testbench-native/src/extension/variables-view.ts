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
  /**
   * Identity of the frame whose scope is being rendered. Lets the view
   * distinguish the test (root) frame — where skill-internal `__skillN_x`
   * names are noise from previous descents and should be hidden — from
   * a skill frame where those names are the actual locals.
   *
   * `null` when no run is in flight. The empty string is the test
   * (root) frame; any other value is a skill frame's id, with
   * `skillName` carrying a human-readable label for the view title.
   */
  currentFrame(): { id: string; skillName?: string } | null;
}

/** Matches the expander's per-instance internal-variable rename scheme.
 *  See src/skills/expander.ts `applySkillScope` → `internalRenames`. */
const SKILL_INTERNAL_PREFIX = /^__skill\d+_/;

interface VariableNode {
  name: string;
  rawValue: string;
}

export class VariablesTreeProvider implements vscode.TreeDataProvider<VariableNode> {
  private readonly emitter = new vscode.EventEmitter<VariableNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /**
   * View handle from `createTreeView` so the title/description can be
   * updated as the active frame changes. Optional — supplied via
   * `attachView` after construction, since the constructor needs to
   * exist before VS Code can create the TreeView around it.
   */
  private view: vscode.TreeView<VariableNode> | null = null;

  constructor(private readonly source: ScopeSource) {}

  /** Wire up a TreeView handle so frame transitions can update the
   *  view title ("Variables (skill: name)"). Optional — without it, the
   *  static `package.json` "Variables" title stays. */
  attachView(view: vscode.TreeView<VariableNode>): void {
    this.view = view;
    this.updateTitle();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** External refresh trigger. Both frame:scope events and frame-stack
   *  transitions (which change which frame is "current") need to cause
   *  a re-render, so the caller multiplexes them through this. */
  refresh(): void {
    this.emitter.fire();
    this.updateTitle();
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
    const frame = this.source.currentFrame();
    // Phase 4.1.b: when rendering the test (root) frame's scope, hide
    // skill-internal names (`__skillN_x`). They survive in
    // `resolvedParameters` after a skill exits — the expander never
    // garbage-collects them — and would otherwise clutter the test view
    // with names the user never wrote. Inside a skill frame the same
    // names ARE the user's locals (just rewritten for namespacing) so
    // they're shown there. Phase 4.B will replace this with a real
    // per-frame filter that reverse-resolves the renames.
    const isTestFrame = !frame || frame.id === '';
    const names = Object.keys(scope)
      .filter((name) => !isTestFrame || !SKILL_INTERNAL_PREFIX.test(name))
      .sort();
    return names.map((name) => ({ name, rawValue: scope[name] ?? '' }));
  }

  /** Drive the TreeView's title from the active frame: "Variables (test)"
   *  at the root, "Variables (skill: name)" inside a skill. Gives the
   *  user an anchor for which scope they're inspecting — without it,
   *  switching between test and skill frames was a silent re-render. */
  private updateTitle(): void {
    if (!this.view) return;
    const frame = this.source.currentFrame();
    if (!frame) {
      this.view.title = 'Variables';
      this.view.description = '';
      return;
    }
    if (frame.id === '') {
      this.view.title = 'Variables';
      this.view.description = 'test';
      return;
    }
    this.view.title = 'Variables';
    this.view.description = frame.skillName ? `skill: ${frame.skillName}` : 'frame';
  }
}
