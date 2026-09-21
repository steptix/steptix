import * as vscode from 'vscode';
import { compareVariableNames, maskIfSecret, type FrameInfo } from 'ai-ui-automation-runner-core';

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
 * Secret-named entries are masked via `maskIfSecret` from runner-core, which
 * carries the rule and the reason: a flat name by the author's word list
 * (`password`, `secret`, `token`, `key`, each as a WORD, so `api_key` masks
 * and `keyword` does not), a dotted `record.column` by the narrower
 * record-column rule on its property. The same call also masks the secret
 * COLUMNS inside a value that holds records — a `readTable` capture is a whole
 * table under one ordinary name, which no name rule can catch. Every other
 * name shows the raw value.
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
   * (root) frame; any other value is a skill or section frame's id, with
   * `skillName` carrying a human-readable label for the view title and
   * `kind` distinguishing the two — a section frame carries `skillName`
   * as well (it holds the section name), so the label cannot be derived
   * from that field's presence alone.
   */
  currentFrame(): { id: string; skillName?: string; kind?: FrameInfo['kind'] } | null;
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
    // `compareVariableNames`, not a plain `.sort()`: a record's `_row` has to
    // lead its columns (§7.4), and code-unit order puts `_` between the upper
    // and the lower case letters — so an `Amount` alias came out ahead of it.
    const names = Object.keys(scope)
      .filter((name) => !isTestFrame || !SKILL_INTERNAL_PREFIX.test(name))
      .sort(compareVariableNames);
    return names.map((name) => ({ name, rawValue: scope[name] ?? '' }));
  }

  /** Test-only readback of the description the view would show. Keeps the
   *  label rule (kind-derived, not skillName-presence) assertable without
   *  reaching into a live TreeView. */
  descriptionForTests(): string {
    return this.computeDescription();
  }

  /** Drive the TreeView's description from the active frame: "test" at the
   *  root, "skill: name" / "section: name" inside one. Gives the user an
   *  anchor for which scope they're inspecting — without it, switching
   *  between frames was a silent re-render. */
  private updateTitle(): void {
    if (!this.view) return;
    this.view.title = 'Variables';
    this.view.description = this.computeDescription();
  }

  /**
   * The description string for the current frame.
   *
   * Keyed on `kind`, NOT on `skillName` presence: a section frame carries
   * `skillName` too (it holds the section name), so a presence check labelled
   * every paused section "skill: <section name>".
   */
  private computeDescription(): string {
    const frame = this.source.currentFrame();
    if (!frame) return '';
    if (frame.id === '') return 'test';
    if (!frame.skillName) return 'frame';
    return `${frame.kind === 'section' ? 'section' : 'skill'}: ${frame.skillName}`;
  }
}
