import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { getLinesFromSelections as getLinesFromSelectionsPure, toggleLineInSet } from "./lib/selection-lines.js";
import { remapLineForChanges, remapLineSet, remapLineMap } from "./lib/line-tracking.js";
import { getGutterContextMenuItems } from "./lib/gutter-menu.js";
import { shouldSnapshotSelection, getSelectionsToRestore } from "./lib/gutter-rightclick.js";
import { hostBridge } from "./lib/host-bridge.js";
import { clearRunningStatuses } from "./lib/status-cleanup.js";
import { nextBreakpointStop } from "./lib/breakpoint.js";
import { collectVariables, parseParametersInline, maskIfSecretInline } from "./lib/variables-panel.js";
import { computeRunnable } from "./lib/runnable-trim.js";
import { filterToStepLines } from "./lib/step-lines-inline.js";

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

// Always start empty. The host posts `init` with the document text shortly
// after the webview mounts; the standalone-dev case (opening the bundle in a
// browser without VS Code) is handled by allowing edits in the empty editor.
const INITIAL_SCRIPT = "";

const STATUS = { IDLE: "idle", RUNNING: "running", PASS: "pass", FAIL: "fail", SKIP: "skip" };

const ChevronIcon = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
    <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ErrorPanel = ({ error }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginTop: 8, borderRadius: 6, overflow: "hidden", border: "1px solid #3d1f1f", background: "#1a0f0f" }}>
      <div onClick={() => setExpanded(!expanded)} style={{ padding: "7px 12px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#f87171", fontSize: 12, fontFamily: "JetBrains Mono, monospace" }}>
        <ChevronIcon open={expanded} />
        <span style={{ color: "#f87171", fontWeight: 600 }}>FAIL</span>
        <span style={{ color: "#c87878", flex: 1 }}>{error.message}</span>
      </div>
      {expanded && (
        <pre style={{ margin: 0, padding: "8px 12px 12px", borderTop: "1px solid #3d1f1f", color: "#9a6a6a", fontSize: 11, lineHeight: 1.7, fontFamily: "JetBrains Mono, monospace", whiteSpace: "pre-wrap", overflowX: "auto" }}>
          {error.detail}
        </pre>
      )}
    </div>
  );
};

const Kbd = ({ children }) => (
  <span style={{ display: "inline-block", padding: "1px 5px", background: "var(--kbd-bg)", border: "1px solid var(--kbd-border)", borderRadius: 3, fontSize: 10, color: "var(--kbd-text)", fontFamily: "JetBrains Mono, monospace" }}>
    {children}
  </span>
);

function detectVscodeTheme() {
  const cls = document.body.classList;
  if (cls.contains("vscode-light") || cls.contains("vscode-high-contrast-light")) return "light";
  return "dark";
}

// Read a `--vscode-*` CSS variable injected by VS Code into the webview.
// Dots in the source name (e.g. "editor.background") map to dashes in the
// CSS-variable form ("--vscode-editor-background"). Returns `fallback` when
// the variable is missing (e.g. standalone-dev where the page is opened
// outside VS Code).
function readVscodeVar(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(`--vscode-${name.replace(/\./g, '-')}`).trim();
  return v || fallback;
}

// Mirror the user's VS Code editor colors into a Monaco theme color map.
// Each fallback matches the previous hand-tuned testbench palette so we
// degrade gracefully when a CSS variable is absent.
function buildEditorThemeColors(isLight) {
  return {
    "editor.background":                  readVscodeVar('editor.background',                  isLight ? '#ffffff' : '#0d1220'),
    "editor.foreground":                  readVscodeVar('editor.foreground',                  isLight ? '#172033' : '#d7e2f2'),
    "editorLineNumber.foreground":        readVscodeVar('editorLineNumber.foreground',        isLight ? '#94a3b8' : '#4a5578'),
    "editorLineNumber.activeForeground":  readVscodeVar('editorLineNumber.activeForeground',  isLight ? '#0f172a' : '#e2e8f0'),
    // Fallback values match VS Code Default Light+/Dark+ exactly so we
    // degrade gracefully when the CSS variable lookup returns empty.
    "editor.selectionBackground":         readVscodeVar('editor.selectionBackground',         isLight ? '#ADD6FF' : '#264F78'),
    "editor.inactiveSelectionBackground": readVscodeVar('editor.inactiveSelectionBackground', isLight ? '#E5EBF1' : '#3A3D41'),
    "editorGutter.background":            readVscodeVar('editorGutter.background',            isLight ? '#f8fafc' : '#090d16'),
    // Hardcoded non-red values for word/occurrence highlights and the
    // drag-and-drop drop target. We don't read these from CSS variables
    // because the user's theme paints them an aggressive red that drowns
    // out the editor. Values mirror VS Code Default Dark+/Light+ palettes
    // — subtle blue/gray with alpha so they layer cleanly over selection.
    "editor.selectionHighlightBackground": isLight ? '#ADD6FF80' : '#ADD6FF26',
    "editor.wordHighlightBackground":      isLight ? '#5757574D' : '#575757B8',
    "editor.wordHighlightStrongBackground":isLight ? '#0E639C40' : '#004972B8',
    "editor.dropBackground":               isLight ? '#5757574D' : '#53595D80',
  };
}

function defineEditorThemes(isLight) {
  const colors = buildEditorThemeColors(isLight);
  monaco.editor.defineTheme("testbench-dark", { base: "vs-dark", inherit: true, rules: [], colors });
  monaco.editor.defineTheme("testbench-light", { base: "vs", inherit: true, rules: [], colors });
}

function TestBenchRunner() {
  const [theme, setTheme] = useState(detectVscodeTheme);
  const [scriptText, setScriptText] = useState(INITIAL_SCRIPT);
  const [statuses, setStatuses] = useState({});
  const [errors, setErrors] = useState({});
  const [breakpoints, setBreakpoints] = useState(new Set());
  const [breakpointStop, setBreakpointStop] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedId, setSelectedId] = useState(1);
  const [selectedLines, setSelectedLines] = useState(new Set([1]));
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [outputWidth, setOutputWidth] = useState(300);
  const [resizingOutput, setResizingOutput] = useState(false);
  const [splitterHover, setSplitterHover] = useState(false);
  const [runLog, setRunLog] = useState([]);
  const [monacoReady, setMonacoReady] = useState(false);
  const [editorLoadError, setEditorLoadError] = useState(null);
  // Composer state — the inline prompt UI for [input:] / [interactive].
  // null means "no prompt active". Otherwise: { mode, message, varName? }.
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [composerText, setComposerText] = useState("");
  const composerInputRef = useRef(null);
  // Live values for the Variables panel: [input:] answers we collected and
  // [output:] captures the server emitted via `capture` events. Declared
  // parameter values are derived from the script + workspace .env at run
  // start (we don't have direct access to .env here; the host fills these
  // when it sees the prompt cycle, and parseParameters' raw $VARs render
  // as-is when no .env data is available).
  const [runtimeVariables, setRuntimeVariables] = useState({});
  const [variablesCollapsed, setVariablesCollapsed] = useState(false);

  const editorHostRef = useRef(null);
  const editorRef = useRef(null);
  const decorationsRef = useRef(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const stopRef = useRef(false);
  const selectedLinesRef = useRef(new Set([1]));
  const preservedSelectionsRef = useRef(null);
  // Remembers the breakpoint trim line for the in-flight run, so the `done`
  // handler can decide whether to land the yellow arrow on it.
  const pausedAtRef = useRef(null);
  // Output-log auto-scroll: pin to bottom by default, but pause when the
  // user scrolls up so they can read past entries without the view jumping.
  // Resumes once the user scrolls back within 20px of the bottom.
  const outputLogRef = useRef(null);
  const outputAtBottomRef = useRef(true);

  const isLight = theme === "light";
  // Each entry maps to a VS Code CSS variable when one is available, falling
  // back to the previous hand-tuned testbench palette. This keeps the UI
  // chrome (toolbar, buttons, output panel) in the user's chosen VS Code
  // color scheme instead of the bespoke navy palette.
  const colors = {
    page:         readVscodeVar('sideBar-background',                  isLight ? "#f5f7fb" : "#0b0f1a"),
    // Toolbar shares the editor's background so the chrome reads as one
    // continuous surface — no visible seam where the toolbar ends and the
    // editor begins.
    header:       readVscodeVar('editor-background',                   isLight ? "#ffffff" : "#0d1220"),
    panel:        readVscodeVar('editor-background',                   isLight ? "#ffffff" : "#0d1220"),
    panelAlt:     readVscodeVar('sideBar-background',                  isLight ? "#f8fafc" : "#090d16"),
    border:       readVscodeVar('panel-border',                        isLight ? "#d8e0ed" : "#1a2240"),
    borderStrong: readVscodeVar('input-border',                        isLight ? "#b9c6d8" : "#2d3a5a"),
    text:         readVscodeVar('foreground',                          isLight ? "#172033" : "#c8d4e8"),
    textStrong:   readVscodeVar('foreground',                          isLight ? "#0f172a" : "#e2e8f0"),
    muted:        readVscodeVar('descriptionForeground',               isLight ? "#64748b" : "#6b7a99"),
    faint:        readVscodeVar('disabledForeground',                  isLight ? "#94a3b8" : "#3a4a6a"),
    // Hardcoded subtle gray (not from CSS var) — some user themes paint
    // list.inactiveSelectionBackground as red/salmon, which then blends
    // visibly under Monaco's blue text-selection making the selected
    // region look pink instead of blue.
    selectedLine: isLight ? "#E5EBF1" : "#37373D",
    menu:         readVscodeVar('menu-background',                     isLight ? "#ffffff" : "#0f1726"),
    splitter:     readVscodeVar('panel-border',                        isLight ? "#e2e8f0" : "#0b0f1a"),
    logEmpty:     readVscodeVar('disabledForeground',                  isLight ? "#94a3b8" : "#2a3450"),
  };

  const steps = useMemo(() => {
    return scriptText.split(/\r?\n/).map((text, index) => ({ id: index + 1, text }));
  }, [scriptText]);

  const log = (msg, type = "info") => setRunLog((entries) => [...entries, { msg, type, ts: new Date().toLocaleTimeString() }]);

  const getLinesFromSelections = useCallback(
    (selections) => getLinesFromSelectionsPure(selections, selectedId),
    [selectedId]
  );

  const syncSelectionFromEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const selections = editor.getSelections() || [];
    const cursorLine = editor.getPosition()?.lineNumber ?? 1;
    setSelectedId(cursorLine);

    // Only treat the editor as having "selected lines" when there is real
    // content selection (a non-empty range, or multiple cursors). A bare
    // cursor moving around shouldn't paint the whole line.
    const realSelection =
      selections.length > 1 ||
      selections.some(
        (s) => s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn
      );
    if (realSelection) {
      setSelectedLines(getLinesFromSelections(selections));
    } else {
      setSelectedLines(new Set());
    }
  }, [getLinesFromSelections]);

  const selectEditorLine = useCallback((lineNumber, additive = false) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;

    const buildLineSelection = (line) =>
      new monaco.Selection(line, 1, line, model.getLineMaxColumn(line));

    if (!additive) {
      const selection = buildLineSelection(lineNumber);
      editor.setSelection(selection);
      queueMicrotask(() => editor.setSelection(selection));
      editor.focus();
      setSelectedId(lineNumber);
      setSelectedLines(new Set([lineNumber]));
      return;
    }

    // Drive the toggle from React state (via ref) rather than
    // editor.getSelections(). Monaco's default mousedown handler may run
    // before this listener and insert its own selection — most importantly
    // for the LAST line, where that selection is single-line and would
    // confuse a getSelections-based toggle into removing the line.
    const nextSet = toggleLineInSet(selectedLinesRef.current, lineNumber);
    const nextSelections = [...nextSet]
      .sort((a, b) => a - b)
      .map(buildLineSelection);

    editor.setSelections(nextSelections);
    queueMicrotask(() => editor.setSelections(nextSelections));
    editor.focus();
    setSelectedId(lineNumber);
    setSelectedLines(nextSet);
    selectedLinesRef.current = nextSet;
  }, []);

  const toggleBreakpoint = useCallback((lineNumber) => {
    setBreakpoints((current) => {
      const next = new Set(current);
      if (next.has(lineNumber)) {
        next.delete(lineNumber);
      } else {
        next.add(lineNumber);
      }
      return next;
    });
  }, []);

  const openGutterMenu = (event, lineNumber) => {
    event.preventDefault();
    setSelectedId(lineNumber);
    setContextMenu({ x: event.clientX, y: event.clientY, lineNumber });
  };

  const handleBreakpointMenuClick = () => {
    if (!contextMenu) return;
    toggleBreakpoint(contextMenu.lineNumber);
    setContextMenu(null);
  };

  const handleClearStatusesMenuClick = () => {
    setContextMenu(null);
    // Clears every per-line gutter status (running / pass / fail / skip) and
    // the inline error panel. Run log is intentionally left alone — that's
    // the user's history of what happened.
    setStatuses({});
    setErrors({});
    setBreakpointStop(null);
  };

  const handleClearBreakpointsMenuClick = () => {
    setContextMenu(null);
    setBreakpoints(new Set());
    // Drop the paused-at arrow too — without breakpoints the pause indicator
    // is meaningless.
    setBreakpointStop(null);
  };

  const handleRunStepMenuClick = () => {
    if (!contextMenu) return;
    setContextMenu(null);
    const selectedSorted = [...selectedLines].sort((a, b) => a - b);
    const lineIds = selectedSorted.length >= 2
      ? selectedSorted
      : [contextMenu.lineNumber];
    const stepsToRun = lineIds
      .map((id) => steps.find((s) => s.id === id))
      .filter(Boolean);
    if (!stepsToRun.length) return;
    const label = stepsToRun.length > 1
      ? "selected lines"
      : `step ${stepsToRun[0].id}`;
    executeSteps(stepsToRun, true, label);
  };

  const finishRun = () => {
    runningRef.current = false;
    pausedRef.current = false;
    setRunning(false);
    setPaused(false);
  };

  // Execute by sending a `run` message to the host. Per-step events flow back
  // via the message subscription effect below.
  const executeSteps = useCallback((selectedSteps, _preserveSelection = true, label = "selected lines", options = {}) => {
    if (runningRef.current || selectedSteps.length === 0) return;

    // The selection can include non-step lines (headings / blanks / prose).
    // Filter to real step lines first so the breakpoint trim operates on
    // the same line set the host will actually run; otherwise a breakpoint
    // on the first real step gets bypassed when the user starts running
    // from a heading or blank line above it.
    //
    // Edge case: no step lines in the selection at all — then we just hand
    // the raw line ids to the host and let resolveRunLines expand them.
    // No trim is applicable in that case.
    const stepOnly = filterToStepLines(scriptText, selectedSteps);
    const trimInput = stepOnly.length > 0 ? stepOnly : selectedSteps;
    const { runnable, pausedAt } =
      stepOnly.length > 0
        ? computeRunnable(stepOnly, breakpoints, options)
        : { runnable: trimInput, pausedAt: null };

    if (runnable.length === 0) {
      // Hit a breakpoint on the very first line — nothing to send to the
      // server. Land the arrow now and let the user decide (Resume / Stop).
      if (pausedAt != null) {
        log(`⏸ Paused at breakpoint on line ${pausedAt}`, "info");
        setBreakpointStop(pausedAt);
        pausedAtRef.current = null;
      }
      return;
    }

    runningRef.current = true;
    pausedRef.current = false;
    stopRef.current = false;
    setRunning(true);
    setPaused(false);
    // Clear any prior pause indicator and stash the new trim point — the
    // arrow lands on `pausedAt` only when the run reaches it cleanly
    // (handled in the `done` event branch below via nextBreakpointStop).
    setBreakpointStop(null);
    pausedAtRef.current = pausedAt;

    const lineIds = runnable.map((step) => step.id);

    // Clear any stale errors on targeted lines. Don't pre-mark them as
    // RUNNING — only the line the server is actively executing should
    // blink. The `step:start` events drive that per-line state.
    setErrors((prev) => {
      const next = { ...prev };
      for (const id of lineIds) delete next[id];
      return next;
    });
    setStatuses((prev) => {
      const next = { ...prev };
      // Also clear any prior pass/fail indicator on these lines so the
      // gutter doesn't show a stale ✓ or ✗ before the new run starts.
      for (const id of lineIds) delete next[id];
      return next;
    });

    log(`▶ Starting ${label}: ${lineIds.join(", ")}`, "start");
    if (pausedAt != null) {
      log(`⏸ Will pause before breakpoint on line ${pausedAt} — press F5 again to continue`, "info");
    }
    hostBridge.postRun(lineIds);
  }, [breakpoints]);

  const runSelected = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const selections = editor.getSelections() || [];
    const hasSelection = selections.some((selection) => !selection.isEmpty()) || selections.length > 1;

    if (hasSelection) {
      const lineIds = [...getLinesFromSelections(selections)].sort((a, b) => a - b);
      const selectedSteps = lineIds.map((id) => steps.find((step) => step.id === id)).filter(Boolean);
      executeSteps(selectedSteps, true, "selected lines");
      return;
    }

    const selectedIndex = steps.findIndex((step) => step.id === selectedId);
    executeSteps(selectedIndex === -1 ? [] : steps.slice(selectedIndex), false, `from step ${selectedId}`);
  }, [executeSteps, getLinesFromSelections, selectedId, steps]);

  const handleReset = () => {
    setStatuses({});
    setErrors({});
    setBreakpoints(new Set());
    setBreakpointStop(null);
    setSelectedId(1);
    setSelectedLines(new Set());
    selectedLinesRef.current = new Set();
    setRunLog([]);
    setRuntimeVariables({});
    stopRef.current = true;
    finishRun();
    const editor = editorRef.current;
    if (editor) {
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.focus();
    }
  };

  const handleResume = () => {
    // Continue from a breakpoint pause: rerun starting at the paused-at line,
    // letting the same breakpoint trim logic stop at the next breakpoint
    // (if any). Arrow disappears the moment we kick the run off.
    if (runningRef.current) return;
    const target = breakpointStop;
    if (target == null) return;
    setBreakpointStop(null);
    const editor = editorRef.current;
    if (editor) {
      editor.setPosition({ lineNumber: target, column: 1 });
      editor.focus();
    }
    setSelectedId(target);
    setSelectedLines(new Set());
    selectedLinesRef.current = new Set();
    const startIdx = steps.findIndex((step) => step.id === target);
    if (startIdx === -1) return;
    executeSteps(steps.slice(startIdx), false, `from breakpoint at line ${target}`, {
      // Skip the breakpoint check on the first step — that's the line the
      // user is explicitly resuming through.
      skipBreakpointAtStart: true,
    });
  };

  const handleStop = () => {
    // Two cases — both should respond to Stop:
    //   1. A run is in progress → tell the host to abort.
    //   2. We're paused at a breakpoint → clear the pause so the user
    //      can pick a fresh starting point.
    if (runningRef.current) {
      stopRef.current = true;
      pausedRef.current = false;
      setPaused(false);
      hostBridge.postStop();
      log("■ Stop requested", "fail");
    }
    if (breakpointStop != null) {
      setBreakpointStop(null);
      pausedAtRef.current = null;
      log("■ Breakpoint pause cleared", "info");
    }
  };

  const handleRenumber = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || selectedLines.size < 2) return;

    const selected = [...selectedLines].sort((a, b) => a - b);
    const firstSelected = selected[0];

    // Continue from the last `N.` prefix above the first selected line.
    const NUM_PREFIX = /^(\s*)(\d+)\.(\s)/;
    let next = 1;
    for (let line = firstSelected - 1; line >= 1; line--) {
      const match = model.getLineContent(line).match(NUM_PREFIX);
      if (match) { next = parseInt(match[2], 10) + 1; break; }
    }

    const edits = [];
    for (const line of selected) {
      const content = model.getLineContent(line);
      const match = content.match(NUM_PREFIX);
      if (!match) continue;
      const indent = match[1];
      const oldDigits = match[2];
      edits.push({
        range: new monaco.Range(line, indent.length + 1, line, indent.length + 1 + oldDigits.length),
        text: String(next),
        forceMoveMarkers: false,
      });
      next++;
    }
    if (edits.length === 0) return;
    editor.executeEdits("renumber", edits);
  };

  const submitComposer = () => {
    if (!pendingPrompt) return;
    const text = composerText;
    // Stash [input: var] answers for the Variables panel — the host already
    // pipes them into per-request parameters; this just lets the UI reflect
    // them immediately.
    if (pendingPrompt.mode === "input" && pendingPrompt.varName) {
      const varName = pendingPrompt.varName;
      setRuntimeVariables((prev) => ({ ...prev, [varName]: text }));
    }
    hostBridge.postPromptResponse(text);
    if (pendingPrompt.mode === "interactive") {
      // Stay open — host will either send another `prompt` (after a step
      // runs) or `promptDone` (when the user typed done/exit). Clear the
      // textarea so the next input starts fresh.
      setComposerText("");
    } else {
      // One-shot input — hide composer immediately; host will follow up
      // with promptDone but the UX feels snappier this way.
      setPendingPrompt(null);
      setComposerText("");
    }
  };

  const cancelComposer = () => {
    if (!pendingPrompt) return;
    hostBridge.postPromptCancel();
    setPendingPrompt(null);
    setComposerText("");
  };

  const handleCloseSession = () => {
    hostBridge.postRestartSession();
    log("↻ Close session requested — next run will start a fresh browser", "info");
    // Clear local UI state for a clean slate.
    setStatuses({});
    setErrors({});
    setBreakpointStop(null);
  };

  useEffect(() => {
    if (!editorHostRef.current || editorRef.current) return;
    try {
      defineEditorThemes(isLight);

      // Pull font from VS Code's CSS variables so Monaco's character-width
      // measurements line up with what's actually rendered. JetBrains Mono
      // (loaded via Google Fonts @import) is blocked by the webview CSP, so
      // it never actually loaded — Monaco was measuring against the declared
      // font and rendering a fallback, which is what caused the
      // selection/cursor offsets.
      const editorFontFamily = readVscodeVar('editor-font-family', "Consolas, 'Courier New', monospace");
      const editorFontSize = parseFloat(readVscodeVar('editor-font-size', '14')) || 14;

      const editor = monaco.editor.create(editorHostRef.current, {
        value: INITIAL_SCRIPT,
        // Markdown tokenization gives headings, list bullets, quote markers
        // and code spans distinct colors via the inherited vs/vs-dark theme
        // rules. Test files are .md and Monaco's bundled markdown grammar
        // handles them well.
        language: "markdown",
        theme: isLight ? "testbench-light" : "testbench-dark",
        fontFamily: editorFontFamily,
        fontSize: editorFontSize,
        glyphMargin: true,
        lineNumbers: "on",
        lineNumbersMinChars: 2,
        lineDecorationsWidth: 16,
        minimap: { enabled: false },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        // "gutter" keeps the active-line indicator in the line-number column
        // but drops the full-line body band — the band picks up
        // editor.lineHighlightBackground from the user's theme, which can
        // flash visibly while dragging a multi-line selection.
        renderLineHighlight: "gutter",
        // Highlight other instances of the selected text + the word at
        // the cursor. Colors come from our theme, not the user's VS Code
        // theme, so they stay subtle (some user themes paint these red).
        selectionHighlight: true,
        occurrencesHighlight: "singleFile",
        contextmenu: false,
        // Initial wordWrap; host overrides it via { type: 'init' } / 'settingsChanged'.
        wordWrap: "on",
      });

      editorRef.current = editor;
      decorationsRef.current = editor.createDecorationsCollection();

      editor.onDidChangeModelContent((event) => {
        const value = editor.getValue();
        const lineCount = editor.getModel().getLineCount();
        const changes = event.changes;
        setScriptText(value);
        setSelectedId((id) => {
          const mapped = remapLineForChanges(id, changes);
          if (mapped == null) return Math.min(id, lineCount);
          return Math.min(Math.max(1, mapped), lineCount);
        });
        setSelectedLines((current) => remapLineSet(current, changes, lineCount));
        setStatuses((prev) => remapLineMap(prev, changes, lineCount));
        setErrors((prev) => remapLineMap(prev, changes, lineCount));
        setBreakpoints((prev) => remapLineSet(prev, changes, lineCount));
        setBreakpointStop((prev) => {
          if (prev == null) return prev;
          const mapped = remapLineForChanges(prev, changes);
          return mapped != null && mapped >= 1 && mapped <= lineCount ? mapped : null;
        });
      });

      editor.onDidChangeCursorSelection(syncSelectionFromEditor);

      editor.onMouseDown((event) => {
        // Ignore non-left-button presses so right-click for the gutter
        // context menu doesn't collapse the user's existing selection.
        if (event.event.browserEvent.button !== 0) return;

        const targetType = event.target.type;
        const lineNumber = event.target.position?.lineNumber || event.target.range?.startLineNumber;
        if (!lineNumber) return;

        if (targetType === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
          event.event.preventDefault();
          selectEditorLine(lineNumber, event.event.browserEvent.altKey);
          return;
        }

        if (targetType === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
          event.event.preventDefault();
          toggleBreakpoint(lineNumber);
          return;
        }

        if (event.event.browserEvent.altKey) {
          event.event.preventDefault();
          selectEditorLine(lineNumber, true);
          return;
        }

        setSelectedId(lineNumber);
        setSelectedLines(new Set([lineNumber]));
      });

      const host = editorHostRef.current;
      const onMouseDownCapture = (browserEvent) => {
        if (shouldSnapshotSelection(browserEvent.button)) {
          preservedSelectionsRef.current = editor.getSelections() || null;
        }
      };
      host?.addEventListener("mousedown", onMouseDownCapture, true);

      editor.onContextMenu((event) => {
        const gutterTargets = new Set([
          monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
          monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
          monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
        ]);
        if (!gutterTargets.has(event.target.type)) return;

        const lineNumber = event.target.position?.lineNumber || event.target.range?.startLineNumber;
        if (!lineNumber) return;
        event.event.preventDefault();
        openGutterMenu(event.event.browserEvent, lineNumber);

        // Restore the selections Monaco collapsed when the right-click hit.
        const preserved = getSelectionsToRestore(preservedSelectionsRef.current);
        preservedSelectionsRef.current = null;
        if (preserved) {
          queueMicrotask(() => {
            editor.setSelections(preserved);
          });
        }
      });

      setMonacoReady(true);
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.focus();
      setSelectedId(1);
      setSelectedLines(new Set());
      selectedLinesRef.current = new Set();
    } catch (error) {
      setEditorLoadError(error.message || "Monaco failed to load.");
    }

    return () => {
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!monaco || !editorRef.current) return;
    // Re-read VS Code CSS variables — they change with the user's theme —
    // and rebuild the Monaco theme before applying.
    defineEditorThemes(isLight);
    monaco.editor.setTheme(isLight ? "testbench-light" : "testbench-dark");
  }, [isLight]);

  // VS Code toggles `vscode-light` / `vscode-dark` / `vscode-high-contrast`
  // classes on <body> when the user changes their color theme. Observe and
  // mirror so the webview follows the IDE without a manual toggle.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(detectVscodeTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    selectedLinesRef.current = selectedLines;
  }, [selectedLines]);

  // Pin output log to the bottom whenever new entries arrive — but only if
  // the user hasn't scrolled up. Programmatic scrollTop=scrollHeight lands
  // exactly at the bottom, so the next onScroll keeps atBottom true.
  useEffect(() => {
    if (!outputAtBottomRef.current) return;
    const el = outputLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [runLog]);

  // Track text the host most recently sent us so we don't echo it back as
  // an `edit` (which would create a feedback loop).
  const hostShadowText = useRef(null);
  // Edits we've posted to the host but haven't yet seen echoed back as
  // `documentChanged`. Each `applyEdit` on the host triggers
  // onDidChangeTextDocument which echoes back; while edits are in flight, the
  // model is ahead of the host and we must not call setValue (it would scroll
  // to top and drop the in-flight keystrokes).
  const pendingEditEchoes = useRef(0);

  // Host messaging — subscribe once, post `ready`, then react to inbound
  // messages. We subscribe unconditionally; postReady is a no-op if the host
  // bridge can't reach VS Code (standalone-dev), so this is safe.
  useEffect(() => {
    const unsubscribe = hostBridge.subscribe((msg) => {
      switch (msg.type) {
        case "init":
          hostShadowText.current = msg.text;
          setScriptText(msg.text);
          if (editorRef.current) {
            const model = editorRef.current.getModel();
            if (model && model.getValue() !== msg.text) {
              model.setValue(msg.text);
            }
          }
          break;

        case "documentChanged":
          hostShadowText.current = msg.text;
          // If this is just an echo of an edit we sent, accept the host's
          // view but don't touch the model — the keystrokes are already there
          // and setValue would reset cursor/scroll.
          if (pendingEditEchoes.current > 0) {
            pendingEditEchoes.current--;
            break;
          }
          if (editorRef.current) {
            const model = editorRef.current.getModel();
            if (model && model.getValue() !== msg.text) {
              model.setValue(msg.text);
            }
          }
          setScriptText(msg.text);
          break;

        case "runEvent": {
          const event = msg.event;
          if (event.type === "step:start") {
            setStatuses((prev) => ({ ...prev, [event.line]: STATUS.RUNNING }));
            setErrors((prev) => { const next = { ...prev }; delete next[event.line]; return next; });
            log(`Running step on line ${event.line}…`);
          } else if (event.type === "step:pass") {
            setStatuses((prev) => ({ ...prev, [event.line]: STATUS.PASS }));
            log(`✓ Step on line ${event.line} passed`, "pass");
          } else if (event.type === "step:fail") {
            setStatuses((prev) => ({ ...prev, [event.line]: STATUS.FAIL }));
            setErrors((prev) => ({
              ...prev,
              [event.line]: { message: event.error, detail: event.error },
            }));
            log(`✗ Step on line ${event.line} failed: ${event.error}`, "fail");
          } else if (event.type === "output") {
            log(event.msg, event.kind === "error" ? "fail" : "info");
          } else if (event.type === "capture") {
            setRuntimeVariables((prev) => ({ ...prev, [event.name]: event.value }));
            log(`✎ ${event.name} ← ${maskIfSecretInline(event.name, event.value)}`, "info");
          } else if (event.type === "done") {
            log(event.status === "passed" ? "✓ Run completed" : `■ Run ended (${event.status})`,
                event.status === "passed" ? "pass" : "fail");
            runningRef.current = false;
            pausedRef.current = false;
            setRunning(false);
            setPaused(false);
            // Demote any line still marked RUNNING so the gutter stops
            // blinking — happens when Stop/abort cuts a step off mid-flight
            // and no step:pass / step:fail ever arrives for it.
            setStatuses((prev) => clearRunningStatuses(prev));
            // Land the breakpoint arrow only if we reached the trim point
            // cleanly. Failures, aborts, and errors leave the gutter clean.
            const arrow = nextBreakpointStop(pausedAtRef.current, event.status);
            setBreakpointStop(arrow);
            pausedAtRef.current = null;
          }
          break;
        }

        case "runError": {
          const payload = msg.payload;
          log(`${payload.code}: ${payload.diagnosis}. ${payload.fix}`, "fail");
          // Pin the error to whatever line is currently running, or to the
          // cursor line if nothing is running.
          const targetLine = selectedId;
          setErrors((prev) => ({
            ...prev,
            [targetLine]: { message: `${payload.code}: ${payload.diagnosis}`, detail: payload.fix },
          }));
          runningRef.current = false;
          setRunning(false);
          break;
        }

        case "settingsChanged":
          if (editorRef.current && typeof msg.wordWrap === "boolean") {
            editorRef.current.updateOptions({ wordWrap: msg.wordWrap ? "on" : "off" });
          }
          break;

        case "prompt":
          // Show / update the composer. Clear any leftover text only when
          // mode changes — re-arming an interactive prompt should keep what
          // the user is mid-typing if the host posts back-to-back.
          setPendingPrompt({ mode: msg.mode, message: msg.message, varName: msg.varName });
          setComposerText("");
          // Focus the textarea on next tick so it's ready for input.
          setTimeout(() => composerInputRef.current?.focus(), 0);
          log(`▸ ${msg.mode === "input" ? "Input needed" : "Interactive mode"}: ${msg.message}`, "info");
          break;

        case "promptDone":
          setPendingPrompt(null);
          setComposerText("");
          break;

        case "parametersResolved":
          // Host has loaded .env and resolved $VAR references. Fold the
          // values into runtimeVariables so the panel shows real values
          // instead of $VAR placeholders. Existing maskIfSecretInline
          // (name-pattern based) still applies at render time.
          if (msg.values && typeof msg.values === "object") {
            setRuntimeVariables((prev) => ({ ...prev, ...msg.values }));
          }
          break;

        default:
          break;
      }
    });

    hostBridge.postReady();
    return unsubscribe;
    // selectedId intentionally omitted — handler reads latest via closure refresh on each render of subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push edits back to the host so the underlying TextDocument stays in sync.
  // Skip until we've received `init` (otherwise our empty initial state would
  // wipe the host document before init arrives) and skip when the change
  // came from the host (avoids an init→edit→documentChanged loop).
  useEffect(() => {
    if (!hostBridge.isHosted) return;
    if (hostShadowText.current === null) return;
    if (hostShadowText.current === scriptText) return;
    pendingEditEchoes.current++;
    hostBridge.postEdit(scriptText);
  }, [scriptText]);

  useEffect(() => {
    const host = editorHostRef.current;
    const editor = editorRef.current;
    if (!host || !editor || breakpointStop == null || running) return;

    const onMouseDown = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (!event.target.classList.contains("tb-breakpoint-stopped")) return;
      event.preventDefault();
      event.stopPropagation();
      document.body.style.cursor = "grabbing";

      const onMove = (moveEvent) => {
        const target = editor.getTargetAtClientPoint(moveEvent.clientX, moveEvent.clientY);
        const line = target?.position?.lineNumber || target?.range?.startLineNumber;
        if (line && line >= 1 && line <= steps.length) {
          setBreakpointStop(line);
          setSelectedId(line);
        }
      };
      const onUp = () => {
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

    host.addEventListener("mousedown", onMouseDown, true);
    return () => host.removeEventListener("mousedown", onMouseDown, true);
  }, [breakpointStop, running, steps.length]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !monaco || !decorationsRef.current) return;

    const decorations = steps.flatMap((step) => {
      const status = statuses[step.id] || STATUS.IDLE;
      const hasStatus = status !== STATUS.IDLE;
      const selected = selectedLines.has(step.id);
      const breakpoint = breakpoints.has(step.id);

      const result = [
        {
          range: new monaco.Range(step.id, 1, step.id, 1),
          options: {
            glyphMarginClassName: breakpoint ? "tb-breakpoint-slot tb-breakpoint-active" : "tb-breakpoint-slot",
            glyphMarginHoverMessage: { value: breakpoint ? "Remove breakpoint" : "Add breakpoint" },
          },
        },
      ];

      if (selected) {
        result.push({
          range: new monaco.Range(step.id, 1, step.id, 1),
          options: {
            isWholeLine: true,
            className: "tb-selected-line",
            lineNumberClassName: "tb-selected-line-number",
          },
        });
      }
      if (breakpointStop === step.id) {
        result.push({
          range: new monaco.Range(step.id, 1, step.id, 1),
          options: {
            linesDecorationsClassName: "tb-status-icon tb-breakpoint-stopped",
            linesDecorationsTooltip: "Next line to execute — drag to move",
          },
        });
      } else if (hasStatus) {
        result.push({
          range: new monaco.Range(step.id, 1, step.id, 1),
          options: {
            linesDecorationsClassName: `tb-status-icon tb-status-${status}`,
            linesDecorationsTooltip: status,
          },
        });
      }
      return result;
    });

    decorationsRef.current.set(decorations);
  }, [breakpoints, breakpointStop, selectedLines, statuses, steps]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: running });
  }, [running]);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === "F5") {
        event.preventDefault();
        runSelected();
      }
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("keydown", handler);
    window.addEventListener("click", closeMenu);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("click", closeMenu);
    };
  }, [runSelected]);

  useEffect(() => {
    if (!resizingOutput) return;

    const handleMove = (event) => {
      const nextWidth = Math.min(Math.max(window.innerWidth - event.clientX, 220), window.innerWidth - 220);
      setOutputWidth(nextWidth);
    };
    const handleUp = () => setResizingOutput(false);

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizingOutput]);

  const variablesRows = useMemo(() => {
    // Show declared `## Parameters` values raw ($VAR placeholders included).
    // The host resolves them against .env when sending the request, but the
    // webview never sees that resolution. Live captures fill in real values
    // via the runtime map.
    const declared = parseParametersInline(scriptText);
    return collectVariables(scriptText, declared, runtimeVariables);
  }, [scriptText, runtimeVariables]);

  const passCount = Object.values(statuses).filter((status) => status === STATUS.PASS).length;
  const failCount = Object.values(statuses).filter((status) => status === STATUS.FAIL).length;
  const runCount = Object.values(statuses).filter((status) => status !== STATUS.IDLE).length;

  return (
    <div style={{
      height: "100vh",
      background: colors.page,
      fontFamily: "JetBrains Mono, 'Cascadia Code', monospace",
      color: colors.text,
      display: "flex",
      flexDirection: "column",
      "--kbd-bg": isLight ? "#eef2f7" : "#1e2433",
      "--kbd-border": colors.borderStrong,
      "--kbd-text": colors.muted,
      // Active-step line highlight. Hardcoded via colors.selectedLine
       // (not pulled from --vscode-list-inactiveSelectionBackground) so
       // it stays a subtle gray even when the user's theme paints list
       // selection backgrounds in a color that would clash with the
       // editor's blue text-selection.
       "--selected-line": colors.selectedLine,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Syne:wght@700;800&display=swap');
        /* VS Code injects 20px padding on the webview <body> by default,
           which creates a visible gap to the left of Monaco's glyph margin
           (and on the other three sides). Reset it. */
        body { padding: 0 !important; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${colors.page}; }
        ::-webkit-scrollbar-thumb { background: ${colors.borderStrong}; border-radius: 3px; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        @keyframes slideIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
        .tb-selected-line { background: var(--selected-line) !important; }
        .tb-selected-line-number {
          background: var(--selected-line);
          color: ${colors.textStrong} !important;
          font-weight: 700;
        }
        .tb-breakpoint-slot {
          cursor: pointer;
          position: relative;
        }
        .tb-breakpoint-slot::before {
          content: "";
          position: absolute;
          left: 3px;
          /* Center vertically against the inherited line-box rather than
             pinning to a hardcoded top offset — adapts automatically when
             the user changes their editor font size. */
          top: 50%;
          transform: translateY(-50%);
          /* Size scales with the editor font (em = font-size). 0.5em ≈ 7px
             at 14px, 9px at 18px, etc. */
          width: 0.5em;
          height: 0.5em;
          border-radius: 50%;
          border: 1px solid transparent;
        }
        .tb-breakpoint-slot:hover::before {
          border-color: #fb7185;
          background: transparent;
        }
        .tb-breakpoint-slot.tb-breakpoint-active::before {
          border-color: #fb7185;
          background: #e11d48;
        }
        .tb-status-icon {
          position: relative;
          width: 24px !important;
          margin-left: 2px;
        }
        .tb-status-icon::before {
          position: absolute;
          left: 4px;
          /* Vertical centering + em sizing so the status badge tracks
             whatever editor font size the user has configured. */
          top: 50%;
          transform: translateY(-50%);
          width: 1em;
          height: 1em;
          border-radius: 0.3em;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7em;
          font-weight: 700;
          font-family: var(--vscode-editor-font-family);
        }
        .tb-status-running::before { content: "●"; color: ${isLight ? "#15803d" : "#4ade80"}; background: ${isLight ? "#dcfce7" : "#1a2a1a"}; box-shadow: 0 0 10px ${isLight ? "#86efac88" : "#4ade8055"}; animation: pulse 1s ease-in-out infinite; }
        .tb-status-pass::before { content: "✓"; color: ${isLight ? "#15803d" : "#22c55e"}; background: ${isLight ? "#dcfce7" : "#0f2318"}; }
        .tb-status-fail::before { content: "✗"; color: ${isLight ? "#b91c1c" : "#f87171"}; background: ${isLight ? "#fee2e2" : "#2a1a1a"}; }
        .tb-status-skip::before { content: "—"; color: ${isLight ? "#475569" : "#6b7280"}; background: ${isLight ? "#e2e8f0" : "#1e2433"}; }
        .tb-breakpoint-stopped { cursor: grab; }
        .tb-breakpoint-stopped::before { content: "▶"; color: ${isLight ? "#b45309" : "#fbbf24"}; background: ${isLight ? "#fef3c7" : "#2a2210"}; box-shadow: 0 0 8px ${isLight ? "#fcd34d88" : "#fbbf2455"}; pointer-events: none; }

        /* Toolbar buttons styled to match VS Code's button conventions:
           solid color (no gradient/border), tight padding, 2px corners,
           --vscode-button-* for colors so they track the user's theme. */
        .tb-btn {
          padding: 4px 11px;
          border: none;
          border-radius: 2px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          font-size: 12px;
          font-family: var(--vscode-font-family);
          line-height: 1.4;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          transition: background-color 100ms ease;
        }
        .tb-btn:hover:not(:disabled) {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .tb-btn:disabled {
          cursor: default;
          opacity: 0.5;
        }
        .tb-btn--primary {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
        }
        .tb-btn--primary:hover:not(:disabled) {
          background: var(--vscode-button-hoverBackground);
        }
        .tb-btn--running {
          background: ${isLight ? "#dcfce7" : "#1a2a1a"};
          color: ${isLight ? "#15803d" : "#4ade80"};
        }
        .tb-btn--danger {
          background: ${isLight ? "#fee2e2" : "#2a1010"};
          color: ${isLight ? "#b91c1c" : "#f87171"};
        }
        .tb-btn--danger:hover:not(:disabled) {
          background: ${isLight ? "#fecaca" : "#3a1818"};
        }
        .tb-btn--warning {
          background: ${isLight ? "#fef3c7" : "#3a2a05"};
          color: ${isLight ? "#92400e" : "#fbbf24"};
          font-weight: 600;
        }
        .tb-btn--warning:hover:not(:disabled) {
          background: ${isLight ? "#fde68a" : "#4a3a15"};
        }
      `}</style>

      <div style={{ padding: "8px 12px", borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: 8, background: colors.header }}>
        <div style={{ flex: 1 }} />

        {runCount > 0 && (
          <div style={{ display: "flex", gap: 12, fontSize: 11, marginRight: 8 }}>
            <span style={{ color: "#22c55e" }}>✓ {passCount} passed</span>
            {failCount > 0 && <span style={{ color: "#f87171" }}>✗ {failCount} failed</span>}
            <span style={{ color: colors.faint }}>{runCount}/{steps.length} steps</span>
          </div>
        )}

        <button
          onClick={handleRenumber}
          disabled={running || selectedLines.size < 2}
          title="Rewrite the leading '1.' / '2.' prefixes on the selected lines so they're sequential. Continues from the last numbered line above the selection."
          className="tb-btn"
        >
          Renumber
        </button>
        <button onClick={handleReset} disabled={running} className="tb-btn">
          Reset
        </button>
        <button
          onClick={handleCloseSession}
          disabled={running}
          title="Close the server-side session for this file. Next run starts a fresh browser with the current Config."
          className="tb-btn"
        >
          Close Session
        </button>
        <button
          onClick={handleResume}
          disabled={running || breakpointStop == null}
          title={breakpointStop != null ? `Resume from breakpoint on line ${breakpointStop}` : "Resume — only available when paused at a breakpoint"}
          className={`tb-btn${breakpointStop != null ? " tb-btn--warning" : ""}`}
        >
          {breakpointStop != null ? `▶ Resume (line ${breakpointStop})` : "Resume"}
        </button>
        <button
          onClick={handleStop}
          disabled={!running && breakpointStop == null}
          className={`tb-btn${(running || breakpointStop != null) ? " tb-btn--danger" : ""}`}
        >
          Stop
        </button>
        <button
          onClick={runSelected}
          disabled={running || !monacoReady}
          className={`tb-btn ${running ? "tb-btn--running" : "tb-btn--primary"}`}
        >
          {running ? <><span style={{ animation: "pulse 1s infinite" }}>●</span> Running…</> : <><span>▶</span> Run <Kbd>F5</Kbd></>}
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* Background tracks VS Code's editorGutter color (falling back to
              editor.background, then panelAlt for standalone-dev) so the
              left-padding strip matches whatever the user's VS Code theme
              renders for the editor gutter. */}
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", background: `var(--vscode-editorGutter-background, var(--vscode-editor-background, ${colors.panelAlt}))`, paddingLeft: 6 }}>
            <div ref={editorHostRef} style={{ width: "100%", height: "100%" }} />
            {editorLoadError && (
              <div style={{ padding: 16, color: "#f87171", fontSize: 12 }}>
                {editorLoadError}
              </div>
            )}
          </div>

          {errors[selectedId] && (
            <div style={{ flexShrink: 0, padding: "0 8px 8px" }}>
              <ErrorPanel error={errors[selectedId]} />
            </div>
          )}
        </div>

        {contextMenu && (() => {
          const items = getGutterContextMenuItems({
            lineNumber: contextMenu.lineNumber,
            hasBreakpoint: breakpoints.has(contextMenu.lineNumber),
            running,
            selectedLineCount: selectedLines.size,
          });
          const handlers = {
            "toggle-breakpoint": handleBreakpointMenuClick,
            "run-step": handleRunStepMenuClick,
            "clear-statuses": handleClearStatusesMenuClick,
            "clear-breakpoints": handleClearBreakpointsMenuClick,
          };
          return (
            <div onClick={(event) => event.stopPropagation()} style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 20, minWidth: 150, padding: 4, background: colors.menu, border: `1px solid ${colors.borderStrong}`, borderRadius: 6, boxShadow: "0 12px 30px #0008" }}>
              {items.map((item) => (
                <button key={item.id} onClick={handlers[item.id]} disabled={item.disabled} style={{ width: "100%", padding: "7px 10px", border: "none", borderRadius: 4, background: "transparent", color: item.disabled ? colors.faint : colors.text, textAlign: "left", fontSize: 12, cursor: item.disabled ? "not-allowed" : "pointer", fontFamily: "JetBrains Mono, monospace" }}>
                  {item.label}
                </button>
              ))}
            </div>
          );
        })()}

        <div onMouseDown={() => setResizingOutput(true)} onMouseEnter={() => setSplitterHover(true)} onMouseLeave={() => setSplitterHover(false)} title="Resize output log" style={{ width: 5, flexShrink: 0, cursor: "col-resize", background: resizingOutput ? "#1d4ed8" : splitterHover ? colors.border : "transparent", borderLeft: resizingOutput || splitterHover ? "none" : `1px solid ${colors.border}`, transition: "background 120ms ease" }} />

        <div style={{ width: outputWidth, flexShrink: 0, background: colors.panelAlt, display: "flex", flexDirection: "column" }}>
          {variablesRows.length > 0 && (
            <div style={{ borderBottom: `1px solid ${colors.border}`, background: colors.panelAlt, flexShrink: 0 }}>
              <div
                onClick={() => setVariablesCollapsed((v) => !v)}
                style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 10, color: colors.faint, letterSpacing: 2, fontWeight: 700, userSelect: "none" }}
              >
                <ChevronIcon open={!variablesCollapsed} />
                <span>VARIABLES</span>
                <span style={{ marginLeft: "auto", letterSpacing: 0, fontWeight: 400 }}>
                  {variablesRows.length}
                </span>
              </div>
              {!variablesCollapsed && (
                <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 2, maxHeight: 220, overflowY: "auto" }}>
                  {variablesRows.map((row) => {
                    const hasValue = row.value !== undefined && row.value !== "";
                    const display = hasValue ? maskIfSecretInline(row.name, String(row.value)) : "(unset)";
                    const badgeColor =
                      row.source === "param"
                        ? isLight ? "#1e40af" : "#60a5fa"
                        : row.source === "input"
                          ? isLight ? "#7c3aed" : "#c4b5fd"
                          : isLight ? "#15803d" : "#4ade80";
                    return (
                      <div key={row.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, padding: "2px 6px", borderRadius: 3, fontFamily: "JetBrains Mono, monospace" }}>
                        <span style={{ fontSize: 8, fontWeight: 700, color: badgeColor, letterSpacing: 0.5, minWidth: 38, textTransform: "uppercase" }}>
                          {row.source}
                        </span>
                        <span style={{ color: colors.textStrong, minWidth: 0, flexShrink: 0 }}>{row.name}</span>
                        <span style={{ color: colors.faint }}>=</span>
                        <span style={{ color: hasValue ? colors.text : colors.faint, fontStyle: hasValue ? "normal" : "italic", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={display}>
                          {display}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${colors.border}`, fontSize: 10, color: colors.faint, letterSpacing: 2, fontWeight: 700 }}>
            OUTPUT LOG
          </div>
          <div
            ref={outputLogRef}
            onScroll={() => {
              const el = outputLogRef.current;
              if (!el) return;
              outputAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 20;
            }}
            style={{ flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 2 }}
          >
            {runLog.length === 0 && (
              <div style={{ fontSize: 11, color: colors.logEmpty, padding: 4, textAlign: "center", marginTop: 20 }}>
                No output yet.<br />Press Run to start.
              </div>
            )}
            {runLog.map((entry, index) => (
              <div key={index} style={{ fontSize: 10, lineHeight: 1.6, padding: "2px 6px", borderRadius: 3, color: entry.type === "fail" ? "#f87171" : entry.type === "pass" ? "#22c55e" : entry.type === "start" ? "#60a5fa" : (isLight ? "#475569" : "#94a3b8"), animation: "slideIn 0.15s ease-out", background: entry.type === "fail" ? isLight ? "#fee2e2" : "#1a0808" : "transparent", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                <span style={{ color: colors.muted, marginRight: 6 }}>{entry.ts}</span>
                {entry.msg}
              </div>
            ))}
          </div>

          {pendingPrompt && (
            <div style={{ borderTop: `1px solid ${colors.border}`, background: isLight ? "#fffbeb" : "#1f1a0a", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 10, color: isLight ? "#92400e" : "#fbbf24", letterSpacing: 1, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                <span>⏸</span>
                <span>WAITING FOR INPUT{pendingPrompt.mode === "interactive" ? " — INTERACTIVE" : ""}</span>
              </div>
              <div style={{ fontSize: 11, color: colors.text, whiteSpace: "pre-wrap" }}>
                {pendingPrompt.message}
                {pendingPrompt.varName && (
                  <span style={{ color: colors.muted }}> {` → {{${pendingPrompt.varName}}}`}</span>
                )}
              </div>
              <textarea
                ref={composerInputRef}
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitComposer();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelComposer();
                  }
                }}
                placeholder={pendingPrompt.mode === "interactive" ? "Type a step, or :help / :list / done / :quit…" : "Type your answer and press Enter…"}
                rows={pendingPrompt.mode === "interactive" ? 2 : 1}
                style={{ width: "100%", resize: "vertical", padding: "6px 8px", fontFamily: "JetBrains Mono, monospace", fontSize: 11, lineHeight: 1.5, background: colors.panel, color: colors.text, border: `1px solid ${colors.borderStrong}`, borderRadius: 4, outline: "none", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button onClick={cancelComposer} style={{ padding: "4px 10px", background: "transparent", border: `1px solid ${colors.borderStrong}`, borderRadius: 4, color: colors.muted, fontSize: 10, cursor: "pointer" }}>
                  Cancel
                </button>
                <button onClick={submitComposer} style={{ padding: "4px 14px", background: "linear-gradient(135deg, #1d4ed8, #2563eb)", border: "none", borderRadius: 4, color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                  Send <Kbd>↵</Kbd>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Hide the inline diagnostic loading message once React mounts.
const loading = document.getElementById("testbench-loading");
if (loading) loading.style.display = "none";

const root = createRoot(document.getElementById("root"));
root.render(<TestBenchRunner />);
