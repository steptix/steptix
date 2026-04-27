import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { getLinesFromSelections as getLinesFromSelectionsPure, toggleLineInSet } from "./selection-lines.js";
import { remapLineForChanges, remapLineSet, remapLineMap } from "./line-tracking.js";
import { getGutterContextMenuItems } from "./gutter-menu.js";
import { shouldSnapshotSelection, getSelectionsToRestore } from "./gutter-rightclick.js";
import appSettings from "./app-settings.json";

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

const INITIAL_SCRIPT = [
  "Navigate to the login page at https://app.example.com/login",
  "Enter username 'qa_user@example.com' in the email field",
  "Enter password 'TestPass123!' in the password field",
  "Click the 'Sign In' button",
  "Verify the dashboard heading reads 'Welcome back'",
  "Click the 'New Report' button in the top navigation",
  "Set report name to 'Q4 Summary' and click Save",
].join("\n");

const MOCK_ERRORS = {
  5: {
    message: "Assertion failed: Expected element text to equal 'Welcome back' but got 'Welcome, QA User'",
    detail: `AssertionError: text mismatch
  Expected : "Welcome back"
  Received : "Welcome, QA User"
  
  Selector  : h1.dashboard-heading
  Timeout   : 5000ms
  Elapsed   : 312ms
  
  Stack:
    at verifyText (runner.js:142)
    at executeStep (runner.js:89)`,
  },
};

const STATUS = { IDLE: "idle", RUNNING: "running", PASS: "pass", FAIL: "fail", SKIP: "skip" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function TestBenchRunner() {
  const [theme, setTheme] = useState("light");
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

  const editorHostRef = useRef(null);
  const editorRef = useRef(null);
  const decorationsRef = useRef(null);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const stopRef = useRef(false);
  const selectedLinesRef = useRef(new Set([1]));
  const preservedSelectionsRef = useRef(null);

  const isLight = theme === "light";
  const colors = {
    page: isLight ? "#f5f7fb" : "#0b0f1a",
    header: isLight ? "#ffffff" : "#0d1220",
    panel: isLight ? "#ffffff" : "#0d1220",
    panelAlt: isLight ? "#f8fafc" : "#090d16",
    border: isLight ? "#d8e0ed" : "#1a2240",
    borderStrong: isLight ? "#b9c6d8" : "#2d3a5a",
    text: isLight ? "#172033" : "#c8d4e8",
    textStrong: isLight ? "#0f172a" : "#e2e8f0",
    muted: isLight ? "#64748b" : "#6b7a99",
    faint: isLight ? "#94a3b8" : "#3a4a6a",
    selectedLine: isLight ? "#dbeafe" : "#16213a",
    menu: isLight ? "#ffffff" : "#0f1726",
    splitter: isLight ? "#e2e8f0" : "#0b0f1a",
    logEmpty: isLight ? "#94a3b8" : "#2a3450",
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

  const waitForRunControl = async () => {
    while (pausedRef.current && !stopRef.current) {
      await sleep(50);
    }
    return !stopRef.current;
  };

  const controlledSleep = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await waitForRunControl())) return false;
      await sleep(Math.min(50, end - Date.now()));
    }
    return waitForRunControl();
  };

  const executeSteps = useCallback(async (selectedSteps, preserveSelection = true, label = "selected lines") => {
    if (runningRef.current || selectedSteps.length === 0) return;

    runningRef.current = true;
    pausedRef.current = false;
    stopRef.current = false;
    setRunning(true);
    setPaused(false);
    setBreakpointStop(null);

    log(`▶ Starting ${label}: ${selectedSteps.map((step) => step.id).join(", ")}`, "start");

    for (const step of selectedSteps) {
      if (!(await waitForRunControl())) {
        log("■ Run stopped", "fail");
        finishRun();
        return;
      }

      if (breakpoints.has(step.id) && step.id !== selectedSteps[0].id) {
        setSelectedId(step.id);
        setBreakpointStop(step.id);
        log(`Stopped at breakpoint on line ${step.id}`, "start");
        finishRun();
        return;
      }

      setSelectedId(step.id);
      if (!preserveSelection) {
        setSelectedLines(new Set([step.id]));
        selectEditorLine(step.id);
      }
      setStatuses((prev) => ({ ...prev, [step.id]: STATUS.RUNNING }));
      log(`Running step ${step.id}…`);

      const duration = 600 + Math.random() * 800;
      if (!(await controlledSleep(duration))) {
        setStatuses((prev) => ({ ...prev, [step.id]: STATUS.IDLE }));
        log("■ Run stopped", "fail");
        finishRun();
        return;
      }

      if (!step.text.trim()) {
        setStatuses((prev) => ({ ...prev, [step.id]: STATUS.SKIP }));
        setErrors((prev) => { const next = { ...prev }; delete next[step.id]; return next; });
        log(`Skipped blank line ${step.id}`, "info");
        continue;
      }

      if (MOCK_ERRORS[step.id]) {
        setStatuses((prev) => ({ ...prev, [step.id]: STATUS.FAIL }));
        setErrors((prev) => ({ ...prev, [step.id]: MOCK_ERRORS[step.id] }));
        log(`✗ Step ${step.id} failed: ${MOCK_ERRORS[step.id].message}`, "fail");
        editorRef.current?.focus();
        finishRun();
        return;
      }

      setStatuses((prev) => ({ ...prev, [step.id]: STATUS.PASS }));
      setErrors((prev) => { const next = { ...prev }; delete next[step.id]; return next; });
      log(`✓ Step ${step.id} passed`, "pass");
    }

    log(`✓ ${label[0].toUpperCase()}${label.slice(1)} completed`, "pass");
    finishRun();
  }, [breakpoints, selectEditorLine]);

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
    stopRef.current = true;
    finishRun();
    const editor = editorRef.current;
    if (editor) {
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.focus();
    }
  };

  const handlePauseResume = () => {
    if (!runningRef.current) return;
    const nextPaused = !pausedRef.current;
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
    log(nextPaused ? "Paused run" : "Resumed run", "start");
  };

  const handleStop = () => {
    if (!runningRef.current) return;
    stopRef.current = true;
    pausedRef.current = false;
    setPaused(false);
  };

  useEffect(() => {
    if (!editorHostRef.current || editorRef.current) return;
    try {
      monaco.editor.defineTheme("testbench-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#0d1220",
          "editor.foreground": "#d7e2f2",
          "editorLineNumber.foreground": "#4a5578",
          "editorLineNumber.activeForeground": "#e2e8f0",
          "editor.selectionBackground": "#264f78",
          "editor.inactiveSelectionBackground": "#1e3a5f",
          "editorGutter.background": "#090d16",
        },
      });
      monaco.editor.defineTheme("testbench-light", {
        base: "vs",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#ffffff",
          "editor.foreground": "#172033",
          "editorLineNumber.foreground": "#94a3b8",
          "editorLineNumber.activeForeground": "#0f172a",
          "editor.selectionBackground": "#bfdbfe",
          "editor.inactiveSelectionBackground": "#dbeafe",
          "editorGutter.background": "#f8fafc",
        },
      });

      const editor = monaco.editor.create(editorHostRef.current, {
        value: INITIAL_SCRIPT,
        language: "plaintext",
        theme: isLight ? "testbench-light" : "testbench-dark",
        fontFamily: "JetBrains Mono, Cascadia Code, monospace",
        fontSize: 14,
        lineHeight: 22,
        glyphMargin: true,
        lineNumbers: "on",
        lineNumbersMinChars: 2,
        lineDecorationsWidth: 16,
        minimap: { enabled: false },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderLineHighlight: "all",
        contextmenu: false,
        wordWrap: appSettings?.editor?.wordWrap === false ? "off" : "on",
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
    monaco.editor.setTheme(isLight ? "testbench-light" : "testbench-dark");
  }, [isLight]);

  useEffect(() => {
    selectedLinesRef.current = selectedLines;
  }, [selectedLines]);

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

  const passCount = Object.values(statuses).filter((status) => status === STATUS.PASS).length;
  const failCount = Object.values(statuses).filter((status) => status === STATUS.FAIL).length;
  const runCount = Object.values(statuses).filter((status) => status !== STATUS.IDLE).length;

  return (
    <div style={{
      minHeight: "100vh",
      background: colors.page,
      fontFamily: "JetBrains Mono, 'Cascadia Code', monospace",
      color: colors.text,
      display: "flex",
      flexDirection: "column",
      "--kbd-bg": isLight ? "#eef2f7" : "#1e2433",
      "--kbd-border": colors.borderStrong,
      "--kbd-text": colors.muted,
      "--selected-line": colors.selectedLine,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${colors.page}; }
        ::-webkit-scrollbar-thumb { background: ${colors.borderStrong}; border-radius: 3px; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        @keyframes slideIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
        .tb-selected-line { background: var(--selected-line) !important; }
        .tb-selected-line-number {
          background: var(--selected-line);
          background-clip: content-box;
          padding-left: 8px;
          border-radius: 4px;
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
          left: 5px;
          top: 6px;
          width: 9px;
          height: 9px;
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
          top: 3px;
          width: 14px;
          height: 14px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 700;
          font-family: JetBrains Mono, monospace;
        }
        .tb-status-running::before { content: "●"; color: ${isLight ? "#15803d" : "#4ade80"}; background: ${isLight ? "#dcfce7" : "#1a2a1a"}; box-shadow: 0 0 10px ${isLight ? "#86efac88" : "#4ade8055"}; animation: pulse 1s ease-in-out infinite; }
        .tb-status-pass::before { content: "✓"; color: ${isLight ? "#15803d" : "#22c55e"}; background: ${isLight ? "#dcfce7" : "#0f2318"}; }
        .tb-status-fail::before { content: "✗"; color: ${isLight ? "#b91c1c" : "#f87171"}; background: ${isLight ? "#fee2e2" : "#2a1a1a"}; }
        .tb-status-skip::before { content: "—"; color: ${isLight ? "#475569" : "#6b7280"}; background: ${isLight ? "#e2e8f0" : "#1e2433"}; }
        .tb-breakpoint-stopped { cursor: grab; }
        .tb-breakpoint-stopped::before { content: "▶"; color: ${isLight ? "#b45309" : "#fbbf24"}; background: ${isLight ? "#fef3c7" : "#2a2210"}; box-shadow: 0 0 8px ${isLight ? "#fcd34d88" : "#fbbf2455"}; pointer-events: none; }
      `}</style>

      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: 16, background: colors.header }}>
        <div>
          <div style={{ fontSize: 11, color: colors.faint, letterSpacing: 2, fontWeight: 700 }}>TESTBENCH</div>
          <div style={{ fontSize: 16, fontFamily: "Syne, sans-serif", fontWeight: 800, color: colors.textStrong }}>
            Login Flow — Smoke Test
          </div>
        </div>
        <div style={{ flex: 1 }} />

        {runCount > 0 && (
          <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
            <span style={{ color: "#22c55e" }}>✓ {passCount} passed</span>
            {failCount > 0 && <span style={{ color: "#f87171" }}>✗ {failCount} failed</span>}
            <span style={{ color: colors.faint }}>{runCount}/{steps.length} steps</span>
          </div>
        )}

        <button onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} style={{ padding: "6px 12px", background: "transparent", border: `1px solid ${colors.borderStrong}`, borderRadius: 5, color: colors.muted, fontSize: 11, cursor: "pointer" }}>
          {isLight ? "Dark" : "Light"}
        </button>
        <button onClick={handleReset} disabled={running} style={{ padding: "6px 12px", background: "transparent", border: `1px solid ${colors.borderStrong}`, borderRadius: 5, color: colors.muted, fontSize: 11, cursor: "pointer" }}>
          Reset
        </button>
        <button onClick={handlePauseResume} disabled={!running} style={{ padding: "6px 12px", background: paused ? "#172554" : "transparent", border: `1px solid ${colors.borderStrong}`, borderRadius: 5, color: paused ? "#93c5fd" : colors.muted, fontSize: 11, cursor: running ? "pointer" : "not-allowed" }}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button onClick={handleStop} disabled={!running} style={{ padding: "6px 12px", background: running ? "#2a1010" : "transparent", border: "1px solid #5a2020", borderRadius: 5, color: running ? "#f87171" : "#5f3940", fontSize: 11, cursor: running ? "pointer" : "not-allowed" }}>
          Stop
        </button>
        <button onClick={runSelected} disabled={running || !monacoReady} style={{ padding: "6px 16px", background: running ? "#1a2a1a" : "linear-gradient(135deg, #1d4ed8, #2563eb)", border: "none", borderRadius: 5, color: running ? "#4ade80" : "#fff", fontSize: 12, cursor: running || !monacoReady ? "not-allowed" : "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          {running ? <><span style={{ animation: "pulse 1s infinite" }}>●</span> Running…</> : <><span>▶</span> Run <Kbd>F5</Kbd></>}
        </button>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div data-testid="toolbar" role="toolbar" aria-label="Editor toolbar" style={{ display: "flex", gap: 16, fontSize: 10, color: colors.faint, padding: "4px 4px 0", alignItems: "center", flexWrap: "wrap" }}>
            <button onMouseDown={(event) => event.preventDefault()} onClick={runSelected} disabled={running || !monacoReady} style={{ padding: "2px 8px", background: running ? "#1a2a1a" : isLight ? "#eef2f7" : "#1e2433", border: `1px solid ${colors.borderStrong}`, borderRadius: 3, fontSize: 10, color: running ? "#4ade80" : colors.muted, fontFamily: "JetBrains Mono, monospace", cursor: running || !monacoReady ? "not-allowed" : "pointer" }}>
              F5
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", border: `1px solid ${colors.border}`, borderRadius: 6, background: colors.panel }}>
            <div ref={editorHostRef} style={{ width: "100%", height: "100%" }} />
            {editorLoadError && (
              <div style={{ padding: 16, color: "#f87171", fontSize: 12 }}>
                {editorLoadError}
              </div>
            )}
          </div>

          {errors[selectedId] && (
            <div style={{ flexShrink: 0 }}>
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
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${colors.border}`, fontSize: 10, color: colors.faint, letterSpacing: 2, fontWeight: 700 }}>
            OUTPUT LOG
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
            {runLog.length === 0 && (
              <div style={{ fontSize: 11, color: colors.logEmpty, padding: 4, textAlign: "center", marginTop: 20 }}>
                No output yet.<br />Press Run to start.
              </div>
            )}
            {runLog.map((entry, index) => (
              <div key={index} style={{ fontSize: 10, lineHeight: 1.6, padding: "2px 6px", borderRadius: 3, color: entry.type === "fail" ? "#f87171" : entry.type === "pass" ? "#22c55e" : entry.type === "start" ? "#60a5fa" : "#4a6090", animation: "slideIn 0.15s ease-out", background: entry.type === "fail" ? isLight ? "#fee2e2" : "#1a0808" : "transparent", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                <span style={{ color: colors.logEmpty, marginRight: 6 }}>{entry.ts}</span>
                {entry.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<TestBenchRunner />);
