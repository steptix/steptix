import * as vscode from 'vscode';
import { isTestFile } from 'ai-ui-automation-runner-core';
import type { ErrorPayload } from 'ai-ui-automation-runner-core';

export type LineStatus = 'running' | 'pass' | 'fail' | 'skip' | 'stopped';

/**
 * Per-document RUN state. Breakpoints are NOT stored here — they live in
 * `vscode.debug.breakpoints` (the canonical store, which gives us free
 * persistence + native gutter-click UX) and are read on demand. This struct
 * only holds state that's transient to the current run.
 */
export interface FileState {
  statuses: Map<number, LineStatus>;
  errors: Map<number, ErrorPayload>;
  /** Line where a breakpoint paused the run (for the yellow ▶ arrow). */
  breakpointStop: number | null;
}

/** Snapshot of state — what the sidebar webview cares about. */
export interface FileStateSnapshot {
  uri: string | null;
  filePath: string | null;
  isTestFile: boolean;
  text: string;
  breakpoints: number[];
  statuses: Array<[number, LineStatus]>;
  errors: Array<[number, ErrorPayload]>;
  breakpointStop: number | null;
  selectedLines: number[];
  cursorLine: number;
}

type Listener = (snapshot: FileStateSnapshot) => void;

/**
 * Tracks which TextEditor is the "current TestBench file" and maintains
 * per-document state (breakpoints, run statuses, pause point). Drives the
 * `testbench.activeFile` context key so menu/keybinding `when` clauses
 * activate only on test markdown.
 *
 * The sidebar webview reads its content from this tracker — switching tabs
 * causes the sidebar to follow.
 */
export class ActiveFileTracker {
  private readonly states = new Map<string, FileState>();
  private currentEditor: vscode.TextEditor | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.currentEditor = editor;
        this.updateContextKey();
        this.emit();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === this.currentEditor) this.emit();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === this.currentEditor?.document) {
          // `## Steps` may have been added/removed; re-check context key.
          this.updateContextKey();
          this.emit();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // Drop run state when the user closes the file. Breakpoints live in
        // vscode.debug.breakpoints and persist independently — VS Code
        // restores them on next session.
        this.states.delete(doc.uri.toString());
      }),
      // Mirror VS Code's debug breakpoint store into our snapshot. Adding /
      // removing a SourceBreakpoint via gutter-click, F9, or our right-click
      // menu all funnel through here, so the snapshot stays consistent
      // regardless of which path the user took.
      vscode.debug.onDidChangeBreakpoints(() => this.emit()),
    );
    // Initial sync — the active editor may already exist when we activate.
    this.currentEditor = vscode.window.activeTextEditor;
    this.updateContextKey();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.listeners.clear();
  }

  /** Subscribe to snapshot changes. The callback runs immediately with the
   *  current snapshot so subscribers don't miss the initial state. */
  onChange(listener: Listener): vscode.Disposable {
    this.listeners.add(listener);
    listener(this.snapshot());
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The TextEditor the sidebar should reflect (or undefined if none). */
  get activeEditor(): vscode.TextEditor | undefined {
    return this.currentEditor;
  }

  /** True when the active editor is a markdown file with `## Steps`. */
  get isActiveTestFile(): boolean {
    const editor = this.currentEditor;
    if (!editor) return false;
    return isTestbenchDocument(editor.document);
  }

  /** Per-document run state, allocated lazily. */
  state(uri: vscode.Uri): FileState {
    const key = uri.toString();
    let s = this.states.get(key);
    if (!s) {
      s = {
        statuses: new Map(),
        errors: new Map(),
        breakpointStop: null,
      };
      this.states.set(key, s);
    }
    return s;
  }

  /** Read breakpoints for a URI from VS Code's debug store. */
  breakpoints(uri: vscode.Uri): Set<number> {
    const out = new Set<number>();
    for (const bp of vscode.debug.breakpoints) {
      if (!(bp instanceof vscode.SourceBreakpoint)) continue;
      if (!bp.enabled) continue;
      if (bp.location.uri.toString() !== uri.toString()) continue;
      out.add(bp.location.range.start.line + 1);
    }
    return out;
  }

  toggleBreakpoint(uri: vscode.Uri, line: number): void {
    // Find an existing SourceBreakpoint on this line; remove if present,
    // otherwise add a new one. Goes through vscode.debug so VS Code's
    // gutter UI updates and the breakpoint persists across sessions.
    const existing = vscode.debug.breakpoints.filter(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint &&
        bp.location.uri.toString() === uri.toString() &&
        bp.location.range.start.line === line - 1,
    );
    if (existing.length > 0) {
      vscode.debug.removeBreakpoints(existing);
    } else {
      const bp = new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(line - 1, 0)),
        true,
      );
      vscode.debug.addBreakpoints([bp]);
    }
    // No emit() — onDidChangeBreakpoints will fire and we emit there.
  }

  clearBreakpoints(uri: vscode.Uri): void {
    const existing = vscode.debug.breakpoints.filter(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint &&
        bp.location.uri.toString() === uri.toString(),
    );
    if (existing.length > 0) vscode.debug.removeBreakpoints(existing);
    const state = this.state(uri);
    state.breakpointStop = null;
    this.emit();
  }

  clearStatuses(uri: vscode.Uri): void {
    const state = this.state(uri);
    state.statuses.clear();
    state.errors.clear();
    state.breakpointStop = null;
    this.emit();
  }

  setStatus(uri: vscode.Uri, line: number, status: LineStatus): void {
    const state = this.state(uri);
    state.statuses.set(line, status);
    this.emit();
  }

  markRunningStopped(uri: vscode.Uri): void {
    const state = this.state(uri);
    let changed = false;
    for (const [line, status] of state.statuses) {
      if (status !== 'running') continue;
      state.statuses.set(line, 'stopped');
      changed = true;
    }
    if (changed) this.emit();
  }

  setError(uri: vscode.Uri, line: number, error: ErrorPayload): void {
    const state = this.state(uri);
    state.errors.set(line, error);
    this.emit();
  }

  setBreakpointStop(uri: vscode.Uri, line: number | null): void {
    const state = this.state(uri);
    state.breakpointStop = line;
    void vscode.commands.executeCommand('setContext', 'testbench.paused', line != null);
    this.emit();
  }

  /** Snapshot for the sidebar webview. */
  snapshot(): FileStateSnapshot {
    const editor = this.currentEditor;
    const document = editor?.document;
    if (!document || !isTestbenchDocument(document)) {
      return {
        uri: null,
        filePath: null,
        isTestFile: false,
        text: '',
        breakpoints: [],
        statuses: [],
        errors: [],
        breakpointStop: null,
        selectedLines: [],
        cursorLine: 1,
      };
    }
    const state = this.state(document.uri);
    return {
      uri: document.uri.toString(),
      filePath: document.uri.fsPath,
      isTestFile: true,
      text: document.getText(),
      breakpoints: [...this.breakpoints(document.uri)].sort((a, b) => a - b),
      statuses: [...state.statuses.entries()],
      errors: [...state.errors.entries()],
      breakpointStop: state.breakpointStop,
      selectedLines: editor ? selectionLines(editor) : [],
      cursorLine: editor?.selection.active.line ? editor.selection.active.line + 1 : 1,
    };
  }

  /** Emit the latest snapshot to all subscribers. */
  emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private updateContextKey(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'testbench.activeFile',
      this.isActiveTestFile,
    );
  }
}

function isTestbenchDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return false;
  if (doc.languageId !== 'markdown' && !doc.fileName.toLowerCase().endsWith('.md')) {
    return false;
  }
  return isTestFile(doc.getText());
}

/**
 * 1-based line numbers covered by every *range* selection in the editor.
 * Cursor-only "selections" (no highlighted range) are ignored — they
 * represent "I'm parked here", not "run this." Treating a cursor as a
 * single-line selection caused empty-trim bugs when the cursor sat on a
 * step that also had a breakpoint (e.g. after a reload mid-pause): the
 * trimmed run was empty, the pause indicator went up immediately, and the
 * user thought their test had silently jumped to the breakpoint without
 * running the preceding steps. With this rule, cursor-only → [] → run
 * everything; explicit highlight → run those lines.
 */
function selectionLines(editor: vscode.TextEditor): number[] {
  const set = new Set<number>();
  for (const sel of editor.selections) {
    if (sel.isEmpty) continue;
    const start = sel.start.line;
    const end = sel.end.line;
    for (let i = start; i <= end; i++) set.add(i + 1);
  }
  return [...set].sort((a, b) => a - b);
}
