import * as vscode from 'vscode';
import {
  compareVariableNames,
  maskIfSecret,
  type FrameInfo,
  type ScopeMasking,
} from 'steptix-runner-core';

/**
 * Read-only TreeView contributed to the Steptix activity-bar container.
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
 * carries the rule and the reason. A FLAT name is the author's own word and
 * takes the server's SUBSTRING rule (`password`, `secret`, `token` or `key`
 * anywhere in it), so a flat `keyword` and a flat `monkey` are masked here —
 * the accepted price of copying the server, because the report beside this
 * view masks them too. A DOTTED `record.column` is half the page's word, and
 * it is the narrower record-column rule on the property that keeps
 * `payment.keyword` and `payment.sort_key` readable. The whole dotted name is
 * read as one credential key as well (`api.key` → `api_key`), because not
 * every dotted name is a loop binding.
 *
 * The same call also masks the secret COLUMNS inside a value that holds
 * records — a `readTable` capture is a whole table under one ordinary name,
 * which no name rule can catch. Every other name shows the raw value.
 *
 * A surface whose names are author-chosen END TO END — a data row's cells, a
 * `[store as:]` capture banner — uses `maskIfSecretAuthored` instead, which
 * puts the whole key through the flat rule. This view is not one of those: a
 * scope holds a loop's bindings.
 *
 * And it holds the author's own dotted names beside them, which is why the
 * mask call takes the `frame:scope` event's `bindings` list: a dotted name a
 * pass bound takes the two-segment rule, and one nobody bound — a data file's
 * `user.apikey` heading — takes the flat author rule on the whole key, the
 * same split `isSecretParameterName` makes server-side. Before that list was
 * on the wire this view had to guess, guessed the narrow way, and printed
 * `uk_live_1234` beside a report that starred it (§7.6).
 *
 * `## Config`'s `unmask` hatch reaches here too, on the same event: a name in
 * it renders in full, exempt from every rule, exactly as the server's
 * `formatParameterBlock` exempts it. That is deliberately a place where this
 * view and the report differ — the hatch governs what is shown LIVE and never
 * what is written to a file, so the report still stars an unmasked `keyword`
 * and an `unmask` line cannot put a credential into an artefact. Nothing
 * fires it from Steptix yet, mind: `RunController`'s per-session `config`
 * carries `baseUrl`, `timeout` and `viewport` and never `unmask`, so a
 * Steptix run declares none and the field never arrives (spec §14). This
 * view is ready for the run that does. Both fields are optional and their
 * absence — an older server, or a run with no hatch — leaves this view
 * rendering what it always did.
 */
export interface ScopeSource {
  /** Current scope to render, or empty when no run is in flight. */
  currentScope(): Record<string, string>;
  /**
   * How to READ that scope: the `bindings` and `unmask` the same
   * `frame:scope` event carried. `{}` when no run is in flight, or when the
   * server is an older one that sends neither — which the masker treats as
   * "nothing known" and answers exactly as it did before the fields existed.
   *
   * Optional on the interface so a test double that only cares about names
   * can keep supplying two methods.
   */
  currentMasking?(): ScopeMasking;
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
  /**
   * The masking rules that came with the scope this node was read out of,
   * snapshotted at `getChildren` time rather than re-read in `getTreeItem`.
   *
   * VS Code calls the two separately, and a `frame:scope` landing between
   * them would otherwise render this row's value under the NEXT pass's
   * bindings — the one case where the two halves of one event come apart. The
   * value is snapshotted for the same reason; this is the rest of the pair.
   * A shared reference to the controller's own object, so the snapshot costs
   * a pointer per row rather than a copy.
   */
  masking: ScopeMasking;
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
    const display = maskIfSecret(node.name, node.rawValue, node.masking);
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
    // Read once for the whole render, beside the scope it describes.
    const masking = this.source.currentMasking?.() ?? {};
    return names.map((name) => ({ name, rawValue: scope[name] ?? '', masking }));
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
