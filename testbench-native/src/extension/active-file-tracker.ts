import * as vscode from 'vscode';
import { isTestFile } from 'ai-ui-automation-runner-core';
import type { ErrorPayload } from 'ai-ui-automation-runner-core';

export type LineStatus = 'running' | 'pass' | 'pass-cached' | 'fail' | 'skip' | 'stopped';

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
 * `testbench-native.activeFile` context key so menu/keybinding `when` clauses
 * activate only on test markdown.
 *
 * The sidebar webview reads its content from this tracker — switching tabs
 * causes the sidebar to follow.
 */
export class ActiveFileTracker {
  private readonly states = new Map<string, FileState>();
  private currentEditor: vscode.TextEditor | undefined;
  // True when the *active tab* is a text editor (not a webview panel). The
  // sticky `currentEditor` keeps the sidebar populated while a webview is
  // focused, but the `activeFile` context key — which gates the editor/title
  // run buttons — must follow the real active tab so the buttons don't leak
  // onto webview panels (our detached runner, the Settings UI, other
  // extensions' panels, …).
  private activeTabIsTextEditor = false;
  private readonly listeners = new Set<Listener>();
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // `undefined` means no text editor has focus — typically a webview
        // panel (the detached TestBench runner, the Test Results panel, a
        // Settings UI, etc.) just got focus. We don't want that to wipe the
        // sidebar back to "Open a Markdown file…", so we keep the previous
        // editor as long as its document is still open. The onDidClose
        // handler below clears it cleanly when the document actually goes
        // away. The context key, however, must drop — the active tab is a
        // webview, and the editor/title buttons must not appear on it.
        if (editor === undefined) {
          this.activeTabIsTextEditor = false;
          if (this.currentEditor && !this.currentEditor.document.isClosed) {
            this.updateContextKey();
            return;
          }
        } else {
          this.activeTabIsTextEditor = true;
        }
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
        // If the closed doc was our sticky reference, release it so the
        // sidebar correctly falls back to "no test file" instead of
        // reporting on a disposed document.
        if (this.currentEditor?.document === doc) {
          this.currentEditor = undefined;
          this.updateContextKey();
          this.emit();
        }
      }),
      // Mirror VS Code's debug breakpoint store into our snapshot. Adding /
      // removing a SourceBreakpoint via gutter-click, F9, or our right-click
      // menu all funnel through here, so the snapshot stays consistent
      // regardless of which path the user took.
      vscode.debug.onDidChangeBreakpoints(() => this.emit()),
    );
    // Initial sync — the active editor may already exist when we activate.
    this.currentEditor = vscode.window.activeTextEditor;
    this.activeTabIsTextEditor = this.currentEditor !== undefined;
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

  /**
   * Every enabled SourceBreakpoint across markdown files, grouped by
   * absolute file path. Used at run-start to ship the full per-URI map
   * to the server so it can pause before any step (test file OR
   * expanded skill body line) that matches a breakpoint.
   *
   * Filters to `.md` files only — VS Code's breakpoint store is global
   * across all languages, but we only care about TestBench files.
   */
  allMarkdownBreakpoints(): Record<string, number[]> {
    const out: Record<string, Set<number>> = {};
    for (const bp of vscode.debug.breakpoints) {
      if (!(bp instanceof vscode.SourceBreakpoint)) continue;
      if (!bp.enabled) continue;
      const uri = bp.location.uri;
      if (uri.scheme !== 'file') continue;
      if (!uri.fsPath.toLowerCase().endsWith('.md')) continue;
      const key = uri.fsPath;
      if (!out[key]) out[key] = new Set();
      out[key].add(bp.location.range.start.line + 1);
    }
    const result: Record<string, number[]> = {};
    for (const [key, set] of Object.entries(out)) {
      result[key] = [...set].sort((a, b) => a - b);
    }
    return result;
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

  /** Single-line variant used by the webview's per-step "Clear status here"
   *  menu item. Leaves other lines' statuses and the breakpoint-stop marker
   *  untouched. */
  clearStatus(uri: vscode.Uri, line: number): void {
    const state = this.state(uri);
    const had = state.statuses.delete(line);
    const hadErr = state.errors.delete(line);
    if (had || hadErr) this.emit();
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

  /**
   * Flip every `running` status across every tracked URI to `stopped`.
   * Used on Stop: a run that descended into a skill leaves `running`
   * statuses on both the test file's `[skill: ...]` aggregate line AND
   * on the skill file's own body lines. The single-URI `markRunningStopped`
   * only catches one of those, so a Stop while inside a skill would
   * leave skill-file lines spinning indefinitely.
   */
  markAllRunningStopped(): void {
    let changed = false;
    for (const state of this.states.values()) {
      for (const [line, status] of state.statuses) {
        if (status !== 'running') continue;
        state.statuses.set(line, 'stopped');
        changed = true;
      }
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
    void vscode.commands.executeCommand('setContext', 'testbench-native.paused', line != null);
    this.emit();
  }

  /**
   * Snapshot for an arbitrary URI. Returns null when no state exists for
   * the URI — the caller can treat that as "no decorations needed."
   * Distinct from `snapshot()` which returns the active-editor snapshot
   * for the sidebar webview; this variant lets the DecorationManager
   * paint every visible editor against its own per-URI state, which is
   * what Phase 2 needs when a run descends into a skill `.md` that lives
   * in a different file from the test.
   */
  snapshotFor(uri: vscode.Uri): FileStateSnapshot | null {
    const key = uri.toString();
    const state = this.states.get(key);
    if (!state) return null;
    if (
      state.statuses.size === 0 &&
      state.errors.size === 0 &&
      state.breakpointStop === null
    ) {
      return null;
    }
    // Editor may not currently be open — fall back to an empty doc text;
    // decorations only need the URI + line numbers, not the document body.
    const editor = this.findEditorFor(uri);
    const document = editor?.document;
    const text = document?.getText() ?? '';
    return {
      uri: key,
      filePath: uri.fsPath,
      isTestFile: document ? isTestbenchDocument(document) : false,
      text,
      breakpoints: [...this.breakpoints(uri)].sort((a, b) => a - b),
      statuses: [...state.statuses.entries()],
      errors: [...state.errors.entries()],
      breakpointStop: state.breakpointStop,
      selectedLines: [],
      cursorLine: 1,
    };
  }

  private findEditorFor(uri: vscode.Uri): vscode.TextEditor | undefined {
    const target = uri.toString();
    return vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === target,
    );
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
    // Only true when the active *tab* is a TestBench test-file text editor.
    // While a webview panel is focused `activeTabIsTextEditor` is false, so
    // the run buttons stay off it even though `currentEditor` is still set
    // (sticky) to keep the sidebar populated.
    void vscode.commands.executeCommand(
      'setContext',
      'testbench-native.activeFile',
      this.activeTabIsTextEditor && this.isActiveTestFile,
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
