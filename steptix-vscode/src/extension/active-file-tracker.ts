import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  isTestFile,
  extractSections,
  extractSteps,
  sectionBodyLinesAt,
} from 'steptix-runner-core';
import type { ErrorPayload, StepFailureDetail } from 'steptix-runner-core';
import { extractStepLineIds, shiftAnchorForChanges } from './step-lines.js';
import { markLineMoves, moveLineKeyed } from './mark-lines-core.js';
import { selectionLinesFrom } from './selection-lines-core.js';
import { dataTablesOf } from './data-tables-core.js';
import { restoredStatuses } from './run-state-core.js';

/**
 * What the gutter says about one step line.
 *
 * `pass-code-behind` (the `</>` code mark) and `pass-stale` (⚠) are both passes — the step
 * succeeded either way (stories/codebehind-compile.md §What the author sees).
 * They differ in what ran: compiled TypeScript, or the AI after the compiled
 * entry threw. The second is the one that wants a recompile.
 *
 * `fail-tolerated` is a FAILURE the run carried on past — an `otherwise continue`
 * tail (stories/step-failure-outcomes.md, decision 6). An amber ✗: the step did
 * not do what it said, so never a pass, and the run is not red for it, so never a
 * red one either.
 */
export type LineStatus =
  | 'running'
  | 'pass'
  | 'pass-code-behind'
  | 'pass-stale'
  | 'fail'
  | 'fail-tolerated'
  | 'skip'
  | 'stopped';

/**
 * Run statuses + errors are persisted to a `.steptix/run-state.json` file
 * at the workspace-folder root so the gutter ✓/✗ marks survive closing the
 * `.md`, restarting VS Code, AND being zipped/copied to another machine.
 * Entries are keyed by the file's path RELATIVE to the workspace folder
 * (forward-slashed) so they still match after the project moves to a
 * different absolute path. `running` statuses and the transient
 * `breakpointStop` pause-arrow are NOT persisted — there is no live run after
 * a reload.
 *
 * `signature` is a hash of the file's step lines (their 1-based line numbers
 * + text) at persist time. On reopen we recompute it from the live document
 * and discard the whole file's state on mismatch: a status is pinned to a
 * line number, so if the file changed while closed (an edit elsewhere, a
 * `git pull`, a branch switch, a teammate's edits) the saved lines can no
 * longer be trusted and we'd otherwise paint marks on the wrong steps.
 */
interface PersistedFileState {
  statuses: Array<[number, LineStatus]>;
  errors: Array<[number, ErrorPayload]>;
  /** Failure text behind ✗/⚠ statuses. Optional: files written before the
   *  field existed load as "no details", never as an error. */
  failures?: Array<[number, StepFailureDetail]>;
  signature: string;
}

/** On-disk shape of `.steptix/run-state.json`. `files` is keyed by
 *  workspace-relative, forward-slashed path. */
interface RunStateFile {
  version: 1;
  files: Record<string, PersistedFileState>;
}

const RUN_STATE_DIR = '.steptix';
const RUN_STATE_FILE = 'run-state.json';
const PERSIST_DEBOUNCE_MS = 400;

/**
 * Per-document RUN state. Breakpoints are NOT stored here — they live in
 * `vscode.debug.breakpoints` (the canonical store, which gives us free
 * persistence + native gutter-click UX) and are read on demand. This struct
 * only holds state that's transient to the current run.
 *
 * The maps are keyed by 1-based line, and the keys follow the text as it is
 * edited (`moveMarks`) — the repaint on every keystroke reads them.
 */
export interface FileState {
  statuses: Map<number, LineStatus>;
  errors: Map<number, ErrorPayload>;
  /** Why a line wears ✗ or ⚠ — keyed like `statuses`, cleared with them,
   *  and replaced whenever the line's status is rewritten. */
  failures: Map<number, StepFailureDetail>;
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
  failures: Array<[number, StepFailureDetail]>;
  breakpointStop: number | null;
  selectedLines: number[];
  cursorLine: number;
}

type Listener = (snapshot: FileStateSnapshot) => void;

/**
 * Tracks which TextEditor is the "current Steptix file" and maintains
 * per-document state (breakpoints, run statuses, pause point). Drives the
 * `steptix.activeFile` context key so menu/keybinding `when` clauses
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
  /** Test-only readback of the `steptix.paused` context key. VS Code
   *  doesn't expose context keys to extensions, so we mirror the last value
   *  pushed. The Continue/Resume button's visibility hinges on this key, and
   *  it is per-active-file (see `refreshPausedContextKey`). */
  lastPausedContextValue = false;
  /** Test-only readback of the `steptix.staleStepLines` context key —
   *  the active file's ⚠ lines, ascending. Mirrored for the same reason
   *  `lastPausedContextValue` is: VS Code does not read context keys back, and
   *  "Repair this step" is visible in the gutter menu only on a line this
   *  array contains (see `refreshStaleStepsContextKeys`). */
  lastStaleLinesContextValue: number[] = [];
  /** Same, for `steptix.dataRowLines` — the array *Run This Row*'s
   *  `when` clause tests the clicked line against. Also the test-only
   *  readback: a `when` clause's evaluation is not observable from the
   *  extension host, so without this nothing pins which lines offer the item. */
  lastDataRowLinesContextValue: number[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly subs: vscode.Disposable[] = [];
  /** Step-line signature each URI's persisted state was captured against.
   *  Compared to the live document on reopen to detect line drift. */
  private readonly signatures = new Map<string, string>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Live resume marker for the paused run, kept as a position (not a raw
   * line) so it shifts with edits the way VS Code's own breakpoints do.
   * Single-valued — only one run is live at a time — and deliberately NOT
   * on the per-URI `FileState`, which is persisted; the anchor is transient.
   * `setBreakpointStop` is the one writer; the `onDidChangeTextDocument`
   * handler shifts/snaps/clears it, and the snapshots derive the line
   * number every consumer still sees from `position.line + 1`. See
   * stories/specs/resume-position-anchor.md.
   */
  private breakpointAnchor: { uri: string; position: vscode.Position } | null = null;
  /**
   * What the resume marker is anchored *inside*, when that is a section body.
   *
   * A body line alone is not enough to resume from: the server needs the
   * invocation the body executes under so it can expand the section and
   * anchor within that expansion. `callPosition` is that invocation, held as
   * a position for the same reason the anchor is — it has to survive the user
   * editing the file before pressing Continue. `null` means the body was run
   * detached (nothing invoked it), which resumes differently.
   *
   * Its ABSENCE is load-bearing. A body-line marker with no context is one we
   * cannot resume — left behind by a dropped stream or a restarted server —
   * and Continue refuses it. Before this field existed the two were
   * indistinguishable and both were refused. See
   * stories/specs/sections-run-and-resume.md §5.1.
   */
  private resumeContext:
    | { uri: string; kind: 'section-body'; callPosition: vscode.Position | null }
    | null = null;

  constructor() {
    // Restore persisted run state before wiring listeners or painting, then
    // reconcile every already-open document (VS Code restores editors before
    // our `onStartupFinished` activation) so stale marks are dropped up front.
    this.hydrate();
    for (const doc of vscode.workspace.textDocuments) this.reconcile(doc);

    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // `undefined` means no text editor has focus — typically a webview
        // panel (the detached Steptix runner, the Test Results panel, a
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
        // Keep the resume anchor (if this is the document holding it) shifting
        // with the user's edits so Continue resumes the step they paused on,
        // not whatever slid into its old line. Done before emit() so the
        // derived breakpointStop in the snapshot reflects the new position.
        this.maintainAnchor(event);
        // The run marks move with the text the same way, for the same reason:
        // the repaint below reads their line numbers.
        const marksMoved = this.moveMarks(event);
        if (event.document === this.currentEditor?.document) {
          // `## Steps` may have been added/removed; re-check context key.
          this.updateContextKey();
          this.emit();
        } else if (marksMoved) {
          // A skill file open beside the test, edited while it carries marks
          // from a descent: nothing else repaints it.
          this.emit();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // Run state is intentionally KEPT on close — it lives on in the
        // `.steptix/run-state.json` file so the ✓/✗ marks reappear when the
        // file is reopened (after a restart, or for whoever the project is
        // zipped to). `reconcile` validates it against the live document on
        // the next open. Breakpoints persist independently via
        // vscode.debug.breakpoints.
        //
        // We only release the sticky `currentEditor` reference so the
        // sidebar falls back to "no test file" instead of reporting on a
        // disposed document.
        if (this.currentEditor?.document === doc) {
          this.currentEditor = undefined;
          this.updateContextKey();
          this.emit();
        }
      }),
      // Reopening a file (or any other doc opening) is where we check the
      // persisted state's signature against the live text and drop it on
      // drift.
      vscode.workspace.onDidOpenTextDocument((doc) => this.reconcile(doc)),
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
    // Flush any debounced write so state isn't lost on a quick quit.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.persist();
    }
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
    return isSteptixDocument(editor.document);
  }

  /** Per-document run state, allocated lazily. */
  state(uri: vscode.Uri): FileState {
    const key = uri.toString();
    let s = this.states.get(key);
    if (!s) {
      s = {
        statuses: new Map(),
        errors: new Map(),
        failures: new Map(),
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
   * across all languages, but we only care about Steptix files.
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
    this.clearAnchorFor(uri);
    this.emit();
  }

  clearStatuses(uri: vscode.Uri): void {
    const state = this.state(uri);
    state.statuses.clear();
    state.errors.clear();
    state.failures.clear();
    state.breakpointStop = null;
    this.clearAnchorFor(uri);
    this.emit();
  }

  /** Drop the live resume anchor if it belongs to `uri`. Used by the
   *  clear paths that null `breakpointStop` without going through
   *  `setBreakpointStop`. */
  private clearAnchorFor(uri: vscode.Uri): void {
    if (this.breakpointAnchor?.uri === uri.toString()) this.breakpointAnchor = null;
    if (this.resumeContext?.uri === uri.toString()) this.resumeContext = null;
  }

  /** Single-line variant used by the webview's per-step "Clear status here"
   *  menu item. Leaves other lines' statuses and the breakpoint-stop marker
   *  untouched. */
  clearStatus(uri: vscode.Uri, line: number): void {
    const state = this.state(uri);
    const had = state.statuses.delete(line);
    const hadErr = state.errors.delete(line);
    const hadFailure = state.failures.delete(line);
    if (had || hadErr || hadFailure) this.emit();
  }

  /**
   * `failure` is the error text behind a ✗ (or the code-behind crash behind a
   * ⚠) — what the gutter hover and the panel's step row show. Every status
   * write clears the line's previous detail first, so a re-run that passes
   * doesn't keep last run's failure text pinned under a green mark.
   */
  setStatus(
    uri: vscode.Uri,
    line: number,
    status: LineStatus,
    failure?: StepFailureDetail,
  ): void {
    const state = this.state(uri);
    state.statuses.set(line, status);
    state.failures.delete(line);
    if (failure) state.failures.set(line, failure);
    this.emit();
  }

  /**
   * Apply many lines' statuses at once — one `emit()`, not one per line.
   *
   * The data-row matrix rewrites every row of every table at each boundary
   * (that is what puts the earlier rows back after the boundary's file-wide
   * clear), and a per-line emit would mean a full snapshot, a persist
   * schedule and two context-key refreshes per row per boundary.
   *
   * `status: null` clears the line — a `pending` row has no mark at all.
   * Lines whose status and detail are already what they should be are
   * skipped, so a matrix re-post that changes one row is one write.
   */
  setStatuses(
    uri: vscode.Uri,
    entries: Array<{
      line: number;
      status: LineStatus | null;
      failure?: StepFailureDetail;
    }>,
  ): void {
    const state = this.state(uri);
    let changed = false;
    for (const { line, status, failure } of entries) {
      const currentStatus = state.statuses.get(line);
      const currentError = state.failures.get(line)?.error;
      if (status === null) {
        if (state.statuses.delete(line)) changed = true;
        if (state.failures.delete(line)) changed = true;
        continue;
      }
      if (currentStatus === status && currentError === failure?.error) continue;
      state.statuses.set(line, status);
      state.failures.delete(line);
      if (failure) state.failures.set(line, failure);
      changed = true;
    }
    if (changed) this.emit();
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

  setBreakpointStop(
    uri: vscode.Uri,
    line: number | null,
    context?: { kind: 'section-body'; callLine: number | null },
  ): void {
    const state = this.state(uri);
    state.breakpointStop = line;
    // Capture (or clear) the position anchor alongside the raw line. The
    // anchor is the source of truth that shifts on edit; `state.breakpointStop`
    // is kept in lockstep with it (here and in the change handler) so the
    // snapshots AND the direct consumer reads in commands/index.ts always see
    // the current line.
    this.breakpointAnchor =
      line != null ? { uri: uri.toString(), position: new vscode.Position(line - 1, 0) } : null;
    // The context rides the anchor exactly — set together, cleared together,
    // in one statement each — so no code path can leave a context describing
    // a marker that is gone, or a body-line marker whose context was dropped
    // (which Continue would then read as "stale, refuse").
    this.resumeContext =
      line != null && context
        ? {
            uri: uri.toString(),
            kind: context.kind,
            callPosition:
              context.callLine != null ? new vscode.Position(context.callLine - 1, 0) : null,
          }
        : null;
    // `paused` is derived from the *active* file's resume point inside emit(),
    // not set globally here — a stop parked on one test must not light up the
    // Continue button on a different test you switch to. See
    // refreshPausedContextKey.
    this.emit();
  }

  /**
   * The current resume line for a URI, anchor-derived so it reflects any
   * edits the user made between pausing and Continue/Step. The breakpoint-
   * paused branches of `continueRun` and `dispatchStep` read this instead of
   * `state(uri).breakpointStop` directly so they filter against the live
   * position rather than the stale pause-time line.
   */
  breakpointStopFor(uri: vscode.Uri): number | null {
    return this.derivedBreakpointStop(uri.toString(), this.state(uri));
  }

  /**
   * What the parked resume marker for `uri` sits inside, or null when it is
   * an ordinary main-flow marker (or there is no marker at all).
   *
   * `callLine` is anchor-derived like `breakpointStopFor`, so both Continue
   * consumers see the invocation's current line rather than its pause-time
   * one. `callLine: null` inside a non-null result means "detached" — the
   * body ran with no invocation — which is a different resume, not a missing
   * one. See stories/specs/sections-run-and-resume.md §5.3.
   */
  resumeContextFor(
    uri: vscode.Uri,
  ): { kind: 'section-body'; callLine: number | null } | null {
    const ctx = this.resumeContext;
    if (!ctx || ctx.uri !== uri.toString()) return null;
    return {
      kind: ctx.kind,
      callLine: ctx.callPosition ? ctx.callPosition.line + 1 : null,
    };
  }

  /**
   * Shift / snap / clear the resume anchor in response to a document edit,
   * imitating how VS Code keeps its own breakpoints pinned to the text as it
   * changes. No-op unless the edited document is the one holding the anchor.
   *
   * The actual shift/snap/clear math lives in `shiftAnchorForChanges`, which
   * classifies ALL of the event's changes against the original anchor line in
   * one pass (above edits sum their deltas; an edit touching the anchor line
   * collapses to that edit's start and snaps to the first surviving step at or
   * after it; no survivor clears the anchor). The post-edit step lines are
   * extracted only when some change actually touches the anchor, so plain
   * typing above/below the anchor doesn't re-parse on every keystroke.
   * `state.breakpointStop` is kept in lockstep so the direct consumer reads
   * stay current too.
   */
  private maintainAnchor(event: vscode.TextDocumentChangeEvent): void {
    const anchor = this.breakpointAnchor;
    if (!anchor || anchor.uri !== event.document.uri.toString()) return;
    if (event.contentChanges.length === 0) return;

    const before = anchor.position.line;
    const changes = event.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      endLine: c.range.end.line,
      endCharacter: c.range.end.character,
      addedLines: countNewlines(c.text),
    }));

    // Snap candidates are resolved lazily — `shiftAnchorForChanges` calls
    // these only when a change actually replaces content on the line being
    // shifted, so plain typing above or below never re-parses the document.
    // Both use the same extractors the Continue/Step consumers use, so there
    // is no parallel parser to drift.
    //
    // The two positions snap against DIFFERENT sets, because they are
    // different kinds of step. A body anchor snaps among the body lines of
    // its OWN section (`sectionBodyLinesAt`, which spans heading-to-heading so
    // a just-deleted step still resolves): snapping among all body lines would
    // let a deleted last-step-of-a-section slide the resume point into the
    // next section's body — a different flow entirely, run silently.
    const inSectionBody = this.resumeContext?.uri === anchor.uri;
    const anchorCandidates = inSectionBody
      ? (target: number) => sectionBodyLinesAt(event.document.getText(), target)
      : () => extractSteps(event.document.getText()).map((s) => s.line);

    const line = shiftAnchorForChanges(before, changes, anchorCandidates);

    // The invocation the body runs under shifts in the same pass, against the
    // same original coordinates. It is a main-flow step, so it snaps among
    // main-flow lines. Computed BEFORE the early return below: an edit can
    // move the call line while leaving the body anchor untouched (inserting a
    // step above the invocation does exactly that), and a stale call line
    // resumes the wrong invocation.
    const ctx = this.resumeContext;
    let callLine: number | null | undefined;
    if (ctx?.uri === anchor.uri && ctx.callPosition) {
      callLine = shiftAnchorForChanges(ctx.callPosition.line, changes, () =>
        extractSteps(event.document.getText()).map((s) => s.line),
      );
    }

    if (line === before && callLine === undefined) return; // nothing moved

    const uri = event.document.uri;
    const state = this.state(uri);
    if (line === null || callLine === null) {
      // Either half gone is the whole resume point gone: a body line with no
      // invocation, or an invocation whose body step was deleted, is not
      // something to guess about. Continue then refuses and offers Run All.
      this.breakpointAnchor = null;
      this.resumeContext = null;
      state.breakpointStop = null;
      // `paused` is recomputed from the active file in emit()/updateContextKey
      // (both run after this returns), so no direct setContext here.
    } else {
      anchor.position = new vscode.Position(line, 0);
      state.breakpointStop = line + 1;
      if (ctx && callLine !== undefined) {
        ctx.callPosition = new vscode.Position(callLine, 0);
      }
    }
    // Repaint the arrow at its new home. When the edited document is the
    // current editor the change handler already emits; emit here only
    // otherwise so a background skill-file edit still repaints.
    if (event.document !== this.currentEditor?.document) this.emit();
  }

  /**
   * Move the edited document's run marks — statuses, failure details and
   * error bands — with its text, so each stays on the step it belongs to.
   * The rule (what moves, what stays, what is removed) is `markLineMoves`'s,
   * mark-lines-core.ts.
   *
   * One set of moves for all three stores, computed over the union of their
   * lines, so a removed step loses its ✗ and its hover together.
   *
   * This is also what keeps the persisted state honest. `persist()` stamps
   * the signature from the live text every time it writes, so line numbers
   * left behind by an edit would be saved as valid and restored onto the
   * wrong steps after a reopen.
   *
   * What it cannot do: an edit made while a stream is live leaves the server
   * reporting the lines it was sent, so the marks that stream paints from then
   * on land by the old numbering — and the step that was running when the
   * line moved keeps its ▶, its result painted on its old line, until the run
   * ends and turns the ▶ to ■. The marks from before the edit are right. A Run
   * or Continue after the edit sends the current text, so what it paints lands
   * by the new numbering, and the registry moves its memory of the marks this
   * run already painted with the same edit (`moveRememberedMarks`,
   * extension.ts). One store does not move: a parked DATA-ROW run's Continue
   * repaints the rows from the matrix it built when it started (`rowTables`,
   * run-controller.ts), on the lines the rows had then.
   *
   * Returns true when any mark moved or was removed.
   */
  private moveMarks(event: vscode.TextDocumentChangeEvent): boolean {
    if (event.contentChanges.length === 0) return false;
    const state = this.states.get(event.document.uri.toString());
    if (!state) return false;
    const moves = markLineMovesFor(event, [
      ...state.statuses.keys(),
      ...state.errors.keys(),
      ...state.failures.keys(),
    ]);
    if (!moves) return false;
    moveLineKeyed(state.statuses, moves);
    moveLineKeyed(state.errors, moves);
    moveLineKeyed(state.failures, moves);
    return true;
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
      isTestFile: document ? isSteptixDocument(document) : false,
      text,
      breakpoints: [...this.breakpoints(uri)].sort((a, b) => a - b),
      statuses: [...state.statuses.entries()],
      errors: [...state.errors.entries()],
      failures: [...state.failures.entries()],
      breakpointStop: this.derivedBreakpointStop(key, state),
      selectedLines: [],
      cursorLine: 1,
    };
  }

  /**
   * The current resume line for a URI: derived from the live position anchor
   * when it belongs to this URI (so it reflects edits made since the pause),
   * else the URI's stored `breakpointStop`. Both snapshots and the Continue /
   * Step consumers go through this so the decorations, webview, and resume
   * filter all agree on one current line number.
   */
  private derivedBreakpointStop(key: string, state: FileState): number | null {
    if (this.breakpointAnchor?.uri === key) {
      return this.breakpointAnchor.position.line + 1;
    }
    return state.breakpointStop;
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
    if (!document || !isSteptixDocument(document)) {
      return {
        uri: null,
        filePath: null,
        isTestFile: false,
        text: '',
        breakpoints: [],
        statuses: [],
        errors: [],
        failures: [],
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
      failures: [...state.failures.entries()],
      breakpointStop: this.derivedBreakpointStop(document.uri.toString(), state),
      selectedLines: editor ? selectionLines(editor) : [],
      cursorLine: editor?.selection.active.line ? editor.selection.active.line + 1 : 1,
    };
  }

  /** Emit the latest snapshot to all subscribers. */
  emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
    // Every state mutation funnels through emit(), so this is the single
    // chokepoint for keeping the persisted store in sync. Debounced because
    // emit() also fires on selection moves, which don't change run state.
    this.schedulePersist();
    // Same chokepoint keeps the per-file `paused` context key honest: any
    // change to the active file's resume point (or to which file is active)
    // re-derives it. Deduped, so the selection-move emits are free.
    this.refreshPausedContextKey();
    // And the ⚠ lines the gutter's Repair item is gated on — every status
    // change funnels through here, which is exactly when a step becomes (or
    // stops being) stale.
    this.refreshStaleStepsContextKeys();
    // The data-row lines the gutter's Run This Row item is gated on. Same
    // chokepoint, and cheap: an edit reaches here too, which is when a table
    // gains or loses a row.
    this.refreshDataRowLinesContextKey();
  }

  // ---- persistence -------------------------------------------------------

  /** Absolute path to a workspace folder's run-state file. */
  private runStateFilePath(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, RUN_STATE_DIR, RUN_STATE_FILE);
  }

  /** A file URI's key relative to its workspace folder, forward-slashed so
   *  the persisted key is portable across machines and OSes. */
  private relativeKey(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
    return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  }

  /** Restore persisted run state from each workspace folder's
   *  `.steptix/run-state.json` into the in-memory map. Drops any `running`
   *  status (no run is in flight after a reload). */
  private hydrate(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      let parsed: RunStateFile | undefined;
      try {
        parsed = JSON.parse(
          fs.readFileSync(this.runStateFilePath(folder), 'utf8'),
        ) as RunStateFile;
      } catch {
        continue; // missing or unreadable — nothing to restore for this folder
      }
      if (!parsed || typeof parsed.files !== 'object') continue;
      for (const [rel, persisted] of Object.entries(parsed.files)) {
        const key = vscode.Uri.joinPath(folder.uri, rel).toString();
        // The status strings are taken as written rather than checked against
        // `LineStatus`, which is what makes the union safe to widen: a file written
        // before `fail-tolerated` has no entry carrying it, and one written after is
        // readable by an older build too (which paints nothing for a status it does
        // not know). `running` is dropped — no run is in flight after a reload — and
        // a status this build retired (the step cache's `pass-cached`) is mapped to
        // what it reads as now; `restoredStatuses` (run-state-core.ts) owns both.
        const statuses = new Map<number, LineStatus>(restoredStatuses(persisted.statuses));
        const errors = new Map<number, ErrorPayload>(persisted.errors);
        const failures = new Map<number, StepFailureDetail>(persisted.failures ?? []);
        if (statuses.size === 0 && errors.size === 0) continue;
        this.states.set(key, { statuses, errors, failures, breakpointStop: null });
        this.signatures.set(key, persisted.signature);
      }
    }
  }

  /** Test-only accessor for the run-state signature. */
  stepSignatureForTests(text: string): string {
    return this.stepSignature(text);
  }

  /** Hash of the step lines (1-based line number + text) — the surface a
   *  status is pinned to. Two documents with the same steps in the same
   *  places share a signature even if surrounding prose differs. */
  private stepSignature(text: string): string {
    const lines = text.split(/\r?\n/);
    const parts = extractStepLineIds(text).map((id) => `${id}:${lines[id - 1] ?? ''}`);
    // Section headings join the signature even though they are not steps.
    // Statuses are pinned to line numbers, and a heading is what decides
    // WHICH body a line belongs to — rename a section, or move a boundary so
    // a step falls into a different one, and the same line now means
    // something else. Without this the persisted ✓ from the old structure
    // would be restored onto the new one.
    for (const section of extractSections(text)) {
      parts.push(`h${section.headingLine}:${section.name}`);
    }
    // Data rows carry statuses too (stories/data-row-progress-and-selection.md
    // §Row status in the table), so they have to join the signature or a ✓
    // would be restored onto a row that now holds different values. Every
    // table's rows: the one under `## Steps` and each section's.
    //
    // A malformed table is not a reason to drop the whole signature — the
    // step lines are still a valid surface and the file still has statuses on
    // them — so a throw here just contributes nothing.
    // `dataRowSignatureLines` makes that "contributes nothing" explicit per
    // table rather than letting one bad table hide another's rows.
    for (const line of dataRowSignatureLines(text)) {
      parts.push(`r${line}:${lines[line - 1] ?? ''}`);
    }
    return hashString(parts.join('\n'));
  }

  /**
   * Validate a document's persisted state against its live text. On a
   * signature mismatch the file changed while our state was stored, so the
   * saved line numbers are untrustworthy — drop the state rather than paint
   * marks on the wrong steps. A match (or first sighting) just refreshes the
   * stored signature.
   */
  private reconcile(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (!this.states.has(key)) return;
    const expected = this.signatures.get(key);
    const actual = this.stepSignature(doc.getText());
    if (expected === undefined || expected === actual) {
      this.signatures.set(key, actual);
      return;
    }
    this.states.delete(key);
    this.signatures.delete(key);
    // The resume anchor is tracker-level, so dropping the per-URI state would
    // otherwise leave it dangling — `derivedBreakpointStop` would still report
    // a pause on a file whose run state was just invalidated (e.g. reopened
    // after a git pull / branch switch changed the steps). Clear it in step.
    this.clearAnchorFor(doc.uri);
    this.schedulePersist();
    if (this.currentEditor?.document === doc) this.emit();
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Write every tracked URI's run state to `.steptix/run-state.json` under
   * the workspace folder that owns it, excluding `running` statuses and the
   * transient breakpoint-stop marker. URIs outside every workspace folder are
   * skipped — there's nowhere portable to write them. Best-effort: a
   * read-only filesystem must never break the run UX.
   */
  private persist(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return;

    // Bucket non-empty state by owning workspace folder, keyed by relative path.
    const buckets = new Map<string, Record<string, PersistedFileState>>();
    for (const [key, state] of this.states) {
      const statuses = [...state.statuses.entries()].filter(([, s]) => s !== 'running');
      if (statuses.length === 0 && state.errors.size === 0) continue;
      const uri = vscode.Uri.parse(key);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) continue;
      // Capture the signature from the live document when one is open; the
      // statuses were written against its current text. Otherwise keep the
      // signature we last stored for this URI.
      const editor = this.findEditorFor(uri);
      if (editor) this.signatures.set(key, this.stepSignature(editor.document.getText()));
      const bucket = buckets.get(folder.uri.toString()) ?? {};
      bucket[this.relativeKey(folder, uri)] = {
        statuses,
        errors: [...state.errors.entries()],
        failures: [...state.failures.entries()],
        signature: this.signatures.get(key) ?? '',
      };
      buckets.set(folder.uri.toString(), bucket);
    }

    for (const folder of folders) {
      const files = buckets.get(folder.uri.toString());
      const filePath = this.runStateFilePath(folder);
      try {
        if (files && Object.keys(files).length > 0) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(
            filePath,
            JSON.stringify({ version: 1, files } satisfies RunStateFile, null, 2),
          );
        } else if (fs.existsSync(filePath)) {
          // Folder had state before; it's all been cleared — drop the file.
          fs.rmSync(filePath, { force: true });
        }
      } catch {
        // best-effort — persistence must not break the run
      }
    }
  }

  /**
   * Test-only: wipe every in-memory and persisted run state. The integration
   * suite reuses one workspace folder across cases, so without an explicit
   * reset the run-state file would leak statuses across test cases (and across
   * separate test runs). Production code never calls this — closing a file
   * deliberately keeps its state.
   */
  resetAllStateForTests(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.states.clear();
    this.signatures.clear();
    // The resume anchor is tracker-level, not per-URI, so clearing `states`
    // alone leaves it behind — a stale anchor from a paused test would then
    // surface via `derivedBreakpointStop` in the next case (the idle Continue
    // no-op test would see a phantom pause and hang opening a stream).
    this.breakpointAnchor = null;
    this.resumeContext = null;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        fs.rmSync(this.runStateFilePath(folder), { force: true });
      } catch {
        // ignore — best-effort cleanup
      }
    }
    this.emit();
  }

  private updateContextKey(): void {
    // Only true when the active *tab* is a Steptix test-file text editor.
    // While a webview panel is focused `activeTabIsTextEditor` is false, so
    // the run buttons stay off it even though `currentEditor` is still set
    // (sticky) to keep the sidebar populated.
    void vscode.commands.executeCommand(
      'setContext',
      'steptix.activeFile',
      this.activeTabIsTextEditor && this.isActiveTestFile,
    );
    // Editor switches reach here without an emit() (the webview-focus branch),
    // so keep the per-file `paused` / ⚠ keys in lockstep here too.
    this.refreshPausedContextKey();
    this.refreshStaleStepsContextKeys();
    this.refreshDataRowLinesContextKey();
  }

  /**
   * Recompute the `steptix.paused` context key from the *active*
   * editor's own parked resume point. The Continue/Resume button is gated on
   * this key, so it must be per-file: a failure (or breakpoint pause) parks a
   * `breakpointStop` on the test that stopped, and only that test should offer
   * Continue. The previous global flag stuck to whichever file last parked a
   * stop and bled the button onto every other test the user opened afterwards.
   * Deduped against the last pushed value so the per-keystroke / per-selection
   * emit()s don't spam setContext.
   */
  private refreshPausedContextKey(): void {
    const paused = this.activeFileResumeLine() != null;
    if (paused === this.lastPausedContextValue) return;
    this.lastPausedContextValue = paused;
    void vscode.commands.executeCommand('setContext', 'steptix.paused', paused);
  }

  /**
   * Publish the active file's ⚠ (`pass-stale`) step lines as context keys, so
   * "Repair this step" appears in the gutter menu on exactly those lines and
   * nowhere else (stories/codebehind-selector-ambiguity.md §Repair, which
   * already works and cannot be found).
   *
   * Two keys, from one walk:
   *
   *  - `steptix.staleStepLines` — the array the gutter menu tests
   *    with `editorLineNumber in ...`. VS Code's line-number context menu puts
   *    the clicked line in `editorLineNumber`, and its `in` operator does an
   *    `includes` against an array-valued key, which is the only way a `when`
   *    clause can be per-line.
   *  - `steptix.hasStaleStep` — the same fact as a boolean, because a
   *    `when` clause cannot ask whether an array is empty and the command
   *    palette has no line to test. Keeps Repair off the palette for a file
   *    with nothing to repair.
   *
   * Deduped against the last pushed value, like the `paused` key: emit() also
   * fires on every keystroke and selection move, which change neither.
   */
  private refreshStaleStepsContextKeys(): void {
    const lines = this.activeFileStaleLines();
    const previous = this.lastStaleLinesContextValue;
    if (lines.length === previous.length && lines.every((l, i) => l === previous[i])) return;
    this.lastStaleLinesContextValue = lines;
    void vscode.commands.executeCommand(
      'setContext',
      'steptix.staleStepLines',
      lines,
    );
    void vscode.commands.executeCommand(
      'setContext',
      'steptix.hasStaleStep',
      lines.length > 0,
    );
  }

  /**
   * Publish the active file's data-row lines, so *Run This Row* appears in the
   * gutter menu on exactly those lines — the same mechanism *Repair this step*
   * uses (`editorLineNumber in <array key>`, the only per-line `when` VS Code
   * offers).
   *
   * Unlike the stale-step key this is a fact about the TEXT, not about run
   * state: a table nobody has run still has rows to run. So it is refreshed
   * where the text can change — the active-editor switch and the document
   * change — rather than on every status write, and deduped against the last
   * pushed value so a keystroke inside a step costs one array compare.
   */
  private refreshDataRowLinesContextKey(): void {
    const doc = this.currentEditor?.document;
    const lines =
      doc && this.isActiveTestFile ? dataRowSignatureLines(doc.getText()) : [];
    const previous = this.lastDataRowLinesContextValue;
    if (lines.length === previous.length && lines.every((l, i) => l === previous[i])) return;
    this.lastDataRowLinesContextValue = lines;
    void vscode.commands.executeCommand(
      'setContext',
      'steptix.dataRowLines',
      lines,
    );
  }

  /**
   * The active editor's ⚠ lines, ascending. Reads `states` directly rather
   * than via `state()` so merely looking at a file with no run state doesn't
   * lazily allocate one for it — same rule as `activeFileResumeLine`.
   */
  private activeFileStaleLines(): number[] {
    const uri = this.currentEditor?.document.uri;
    if (!uri) return [];
    const state = this.states.get(uri.toString());
    if (!state) return [];
    const lines: number[] = [];
    for (const [line, status] of state.statuses) {
      if (status === 'pass-stale') lines.push(line);
    }
    return lines.sort((a, b) => a - b);
  }

  /**
   * The active editor's resume line (anchor-derived, the same way the
   * snapshots compute it), or null when the active file has no parked stop.
   * Reads `states` directly rather than via `state()` so merely looking at a
   * file with no run state doesn't lazily allocate one for it.
   */
  private activeFileResumeLine(): number | null {
    const uri = this.currentEditor?.document.uri;
    if (!uri) return null;
    const key = uri.toString();
    if (this.breakpointAnchor?.uri === key) return this.breakpointAnchor.position.line + 1;
    return this.states.get(key)?.breakpointStop ?? null;
  }
}

/** Count `\n` occurrences in a string — the number of lines an edit's
 *  replacement text adds. */
function countNewlines(s: string): number {
  return s.split('\n').length - 1;
}

/**
 * `markLineMoves` (mark-lines-core.ts) for a live change event: where each of
 * `lines` (1-based) goes, or null when none of them moved.
 *
 * Exported so every store that pins something to a line by the run's marks
 * moves by the one rule — the tracker's own maps here, and the run registry's
 * memory of marks it will paint again (extension.ts). `event.document` is the
 * text AFTER the event, which is what the rule's line-length question asks
 * about.
 */
export function markLineMovesFor(
  event: vscode.TextDocumentChangeEvent,
  lines: Iterable<number>,
): Map<number, number | null> | null {
  const doc = event.document;
  return markLineMoves(
    lines,
    event.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      startCharacter: c.range.start.character,
      endLine: c.range.end.line,
      endCharacter: c.range.end.character,
      text: c.text,
      rangeLength: c.rangeLength,
    })),
    (line) => (line < doc.lineCount ? doc.lineAt(line).text.length : 0),
  );
}

/**
 * Every data-row line in the file — the run table's and each section's —
 * ascending. Used by the run-state signature, so a table edit drops that
 * table's row marks.
 *
 * A projection of `dataTablesOf`, which is where the two guarded scans live
 * (a half-written table throws, and the signature is still a useful surface
 * without it — the step lines anchor the state on their own). Sharing that
 * function rather than repeating its scans is also what keeps this off the hot
 * path: `dataTablesOf` memoises on the document text, and this is asked for on
 * every tracker emit, i.e. every caret move.
 */
export function dataRowSignatureLines(text: string): number[] {
  const lines = dataTablesOf(text).flatMap((t) => t.rowLines);
  return [...new Set(lines)].sort((a, b) => a - b);
}

/** djb2 string hash, base-36 encoded. Not cryptographic — only needs to
 *  change when the step lines change, to invalidate stale persisted state. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function isSteptixDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return false;
  if (doc.languageId !== 'markdown' && !doc.fileName.toLowerCase().endsWith('.md')) {
    return false;
  }
  return isTestFile(doc.getText());
}

/**
 * 1-based line numbers covered by every *range* selection in the editor.
 *
 * The rules — cursor-only selections are ignored, and a selection ending at
 * column 0 of a later line does not include that line unless dropping it would
 * leave the selection naming nothing runnable — live in
 * `selection-lines-core.ts` so the fast `node --test` suite can pin them.
 * Exported because `runSelected`, `snapshot.selectedLines` and the data-row
 * split must all read a selection the same way.
 *
 * The runnable set is the document's step lines (main flow and section bodies
 * alike, which is what `extractStepLineIds` returns) plus every data-row line
 * — exactly the lines a selection can name and have narrow the run.
 */
export function selectionLines(editor: vscode.TextEditor): number[] {
  return selectionLinesFrom(editor.selections, runnableLinesOf(editor.document.getText()));
}

/**
 * The lines a selection can name — step lines and data rows — as a set.
 *
 * One entry, keyed by the document text, for the same reason `dataTablesOf`
 * has one: `selectionLines` is called on every tracker emit, i.e. every caret
 * move, and `extractStepLineIds` classifies the whole file.
 */
let runnableCache: { text: string; lines: Set<number> } | null = null;
function runnableLinesOf(text: string): ReadonlySet<number> {
  if (runnableCache !== null && runnableCache.text === text) return runnableCache.lines;
  const lines = new Set<number>([...extractStepLineIds(text), ...dataRowSignatureLines(text)]);
  runnableCache = { text, lines };
  return lines;
}
