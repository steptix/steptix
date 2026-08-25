/**
 * The while-typing layer for inline sections: document links, completion,
 * and diagnostics.
 *
 * Bare-name invocation was a deliberate language choice, and its failure mode
 * is silent — a typo or a stale call site after a rename is not an error, it
 * is a plausible AI instruction. These providers surface that in the editor
 * before a run:
 *
 *  - a resolved call is UNDERLINED (a link), so a step meant as a call that
 *    stays plain is instantly visible;
 *  - a near-miss or an orphaned section is SQUIGGLED;
 *  - section names COMPLETE after a step number.
 *
 * Everything is built on `buildSectionIndex` from runner-core — the same
 * function the run-time pre-flight uses — so the editor and the runtime can
 * never disagree about what is a call. See
 * testbench-native/stories/specs/inline-sections-authoring.md.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildSectionIndex,
  isTestFile,
  matchText,
  sectionNameError,
} from 'ai-ui-automation-runner-core';
import { resolveProjectDirs } from './aiui-config.js';
import {
  computeSectionDiagnostics,
  type PlainDiagnostic,
} from './section-diagnostics-core.js';
import { inStepRegion } from './step-region-core.js';

/** The `N. ` ordinal prefix, so completion only fires at the start of a step. */
const STEP_START_RE = /^\s*\d+\.\s+\S*$/;

// ---------------------------------------------------------------------------
// Document links
// ---------------------------------------------------------------------------

/**
 * Underlines the section-name text of every resolved call — main-flow and
 * body lines alike — linking it to the `### Name` heading.
 *
 * This is the anti-footgun: authors learn a call renders as a link, so a call
 * that stays plain text stands out. Trustworthy because the index matches iff
 * the expander matches — `1. **Login**` gets no link *and* is no call.
 */
export class SectionLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    if (!isTestFile(document.getText())) return [];
    const index = buildSectionIndex(document.getText());
    const links: vscode.DocumentLink[] = [];

    for (const call of index.calls) {
      const section = index.sections.get(matchText(call.name));
      if (!section) continue;
      const lineIdx = call.line - 1;
      const nameLen = lineText(document, lineIdx).length - call.nameStart;
      const range = new vscode.Range(lineIdx, call.nameStart, lineIdx, call.nameStart + nameLen);
      // A `command:` URI so the click lands on the heading LINE. A plain
      // `file://…#L<n>` fragment is a web anchor convention VS Code does not
      // honour in the editor — it would open the file at the top. The command
      // is `revealLine`, registered in extension.ts and given the target as a
      // JSON-encoded argument.
      const args = encodeURIComponent(
        JSON.stringify([document.uri.toString(), section.headingLine - 1]),
      );
      const link = new vscode.DocumentLink(
        range,
        vscode.Uri.parse(`command:testbench-native.revealSectionLine?${args}`),
      );
      link.tooltip = `Go to section "${section.name}" (line ${section.headingLine})`;
      links.push(link);
    }
    return links;
  }
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Offers the file's section names after a step number, plus `[skill: ]`
 * snippet items for the project's skills.
 *
 * Sections sort first (they're the file-local reuse mechanism); skills are a
 * cheap `readdir` and a bonus.
 */
export class SectionCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const text = document.getText();
    if (!isTestFile(text)) return [];
    const prefix = document.lineAt(position.line).text.slice(0, position.character);
    // Right after the ordinal — `1. ` or `1. Lo`, not mid-prose. It matches an
    // INDENTED `1.` too; that's harmless (an indented ordinal is prose, never
    // a call, so the dropdown is ignorable) and not worth a second regex.
    if (!STEP_START_RE.test(prefix)) return [];
    // And only where a step could actually be: inside the `## Steps` span and
    // not in a fenced block. A step being typed reads as `prose` mid-keystroke
    // (no content yet), so this checks the SPAN rather than the line kind —
    // the surrounding lines tell us we're in the step region even when this
    // one isn't a step yet.
    if (!inStepRegion(text, position.line)) return [];

    const items: vscode.CompletionItem[] = [];
    const index = buildSectionIndex(document.getText());
    let order = 0;
    for (const [, section] of index.sections) {
      // Skip invalid names, matching the diagnostics' liveness and near-miss
      // filters — offering `Steps` or `[foo]` as a completion would insert a
      // step the same document flags as an Error.
      if (sectionNameError(section.name)) continue;
      const item = new vscode.CompletionItem(section.name, vscode.CompletionItemKind.Function);
      item.detail = 'inline section';
      item.documentation = new vscode.MarkdownString(
        `Calls the \`### ${section.name}\` section (${section.stepCount} step${
          section.stepCount === 1 ? '' : 's'
        }).`,
      );
      // Sections before skills before whatever markdown offers.
      item.sortText = `0_${String(order++).padStart(4, '0')}`;
      items.push(item);
    }

    for (const skill of this.skillNames(document.uri)) {
      const item = new vscode.CompletionItem(
        `[skill: ${skill}]`,
        vscode.CompletionItemKind.Reference,
      );
      item.detail = 'skill invocation';
      item.insertText = new vscode.SnippetString(`[skill: ${skill}$0]`);
      item.sortText = `1_${skill}`;
      items.push(item);
    }

    return items;
  }

  private skillNames(docUri: vscode.Uri): string[] {
    const dirs = resolveProjectDirs(docUri);
    if (!dirs?.skillsDir) return [];
    return collectSkillNames(dirs.skillsDir, '').sort();
  }
}

/**
 * Every skill under `dir`, named the way a step must reference it: relative to
 * the skills root, no `.md`, **forward slashes on every platform** — a skill at
 * `skills/auth/login.md` completes as `[skill: auth/login]`, which is exactly
 * what `parseSkillCall` canonicalises to.
 *
 * Each directory read is guarded independently, so one unreadable subfolder
 * costs its own entries and not the whole list.
 */
function collectSkillNames(dir: string, prefix: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    // Dot-directories are never skills, and `.aiui-codebehind-cache/` — which
    // sits beside the skill files, recordings and all — would be the bulk of
    // the walk on every completion request.
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      names.push(
        ...collectSkillNames(path.join(dir, entry.name), `${prefix}${entry.name}/`),
      );
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      names.push(`${prefix}${entry.name.slice(0, -3)}`);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Refreshes `testbench-sections` diagnostics on open/change (debounced).
 *
 * Every row but the near-miss restates a parse or expansion error, so authors
 * see them while typing rather than at run time. The near-miss is the only
 * heuristic — conservative (a unique near-match only) and a Warning.
 */
export class SectionDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('testbench-sections');
  private readonly subs: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DEBOUNCE_MS = 400;

  constructor() {
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.schedule(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri)),
    );
    for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.subs.forEach((s) => s.dispose());
    this.collection.dispose();
  }

  private schedule(document: vscode.TextDocument): void {
    if (document.languageId !== 'markdown') return;
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(document);
      }, SectionDiagnostics.DEBOUNCE_MS),
    );
  }

  /** Compute the diagnostics for a document's text, as vscode types. */
  static compute(text: string): vscode.Diagnostic[] {
    return computeSectionDiagnostics(text).map((d) => {
      const range = new vscode.Range(d.line, d.startCol, d.line, d.endCol);
      return diag(range, d.message, toSeverity(d.severity));
    });
  }

  private refresh(document: vscode.TextDocument): void {
    if (document.languageId !== 'markdown') return;
    this.collection.set(document.uri, SectionDiagnostics.compute(document.getText()));
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineText(document: vscode.TextDocument, lineIdx: number): string {
  return document.lineAt(lineIdx).text;
}



const SEVERITY: Record<PlainDiagnostic['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

/** Total by construction: the key is a `PlainDiagnostic['severity']`. */
function toSeverity(s: PlainDiagnostic['severity']): vscode.DiagnosticSeverity {
  return SEVERITY[s];
}

function diag(
  range: vscode.Range,
  message: string,
  severity: vscode.DiagnosticSeverity,
): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = 'testbench-sections';
  return d;
}
