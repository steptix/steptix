/**
 * TestBench sidebar webview.
 *
 * The user edits the .md in VS Code's native editor; this panel drives runs,
 * shows the output log, variables, and per-step status. State (file text,
 * breakpoints, statuses, cursor) flows from the host as `activeFile`
 * snapshots — the webview never edits the document directly.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { hostBridge } from "./lib/host-bridge.js";
import { collectVariables, parseParametersInline, maskIfSecretInline } from "./lib/variables-panel.js";
import { extractStepLineIds } from "./lib/step-lines-inline.js";

// Inline narrowing helper. The webview can't import named exports from
// runner-core directly because Vite's CJS interop drops names through
// __exportStar — same workaround as variables-panel.js / step-lines-inline.js.
const HOST_MSG_TYPES = new Set([
  "activeFile",
  "runEvent",
  "runError",
  "prompt",
  "promptDone",
  "parametersResolved",
  "running",
  "breakpointStop",
  "batchBanner",
]);
function isHostMsg(value) {
  if (!value || typeof value !== "object") return false;
  return HOST_MSG_TYPES.has(value.type);
}

const STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  PASS: "pass",
  // Server emitted step:pass with fromCache=true → AI plan replayed
  // from disk. Painted ⚡ instead of ✓ but counted as a pass for the
  // run-summary tally and rendered with the same green color.
  PASS_CACHED: "pass-cached",
  FAIL: "fail",
  SKIP: "skip",
  STOPPED: "stopped",
};

function statusFromTuple(tuples) {
  const map = {};
  for (const [line, status] of tuples) map[line] = status;
  return map;
}

function ChevronIcon({ open }) {
  return (
    <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 120ms" }}>▶</span>
  );
}

function ErrorPanel({ error, onDismiss }) {
  return (
    <div style={{ borderRadius: 4, padding: "8px 10px", background: "var(--vscode-inputValidation-errorBackground, #5A1D1D)", color: "var(--vscode-inputValidation-errorForeground, #ffffff)", border: "1px solid var(--vscode-inputValidation-errorBorder, #BE1100)", fontSize: 12, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <strong>{error.code}</strong>
        {onDismiss && (
          <button onClick={onDismiss} style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", fontSize: 11 }}>✕</button>
        )}
      </div>
      <div style={{ marginTop: 4 }}>{error.diagnosis}</div>
      {error.fix && <div style={{ marginTop: 4, opacity: 0.85 }}>{error.fix}</div>}
    </div>
  );
}

/**
 * Banner shown at the top of the webview while a Test Explorer batch run
 * is in flight. Tells the user where the real action is (Test Results
 * panel) so they don't try to drive the run from the TestBench sidebar.
 * Renders nothing when `state` is null.
 */
function BatchBanner({ state }) {
  if (!state) return null;
  const openResults = () => hostBridge.postFocusTestResults();
  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--vscode-statusBarItem-prominentBackground, #4d4d4d)",
        color: "var(--vscode-statusBarItem-prominentForeground, #fff)",
        fontSize: "12px",
        borderBottom: "1px solid var(--vscode-panel-border, #444)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span>🧪</span>
      <span style={{ flex: 1 }}>
        Batch run: {state.running}/{state.total} tests
      </span>
      <a
        href="#"
        onClick={(e) => { e.preventDefault(); openResults(); }}
        style={{ color: "inherit", textDecoration: "underline" }}
      >
        Open Test Results
      </a>
    </div>
  );
}

/**
 * Per-step right-click menu. Opened from a step row's onContextMenu and
 * positioned at the cursor (clamped into the viewport). The transparent
 * backdrop catches outside clicks; Escape also closes. Menu items either
 * dispatch through `hostBridge` or stay disabled when not applicable
 * (e.g. "Clear status here" when the row has no status to clear).
 */
function StepContextMenu({ menu, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = () => { onClose(); hostBridge.postRun([menu.line]); };
  const reveal = () => { onClose(); hostBridge.postRevealLine(menu.line); };
  const toggleBp = () => { onClose(); hostBridge.postToggleBreakpoint(menu.line); };
  const clearSt = () => { onClose(); hostBridge.postClearStatus(menu.line); };

  return (
    <div
      onMouseDown={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          left: menu.x,
          top: menu.y,
          minWidth: 180,
          background: "var(--vscode-menu-background, #252526)",
          color: "var(--vscode-menu-foreground, #cccccc)",
          border: "1px solid var(--vscode-menu-border, var(--vscode-contrastBorder, #454545))",
          boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          padding: "4px 0",
          borderRadius: 2,
          fontFamily: "var(--vscode-font-family)",
          fontSize: "var(--vscode-font-size, 13px)",
        }}
      >
        <button className="tb-menu-item" onClick={run}>Run this step</button>
        <button className="tb-menu-item" onClick={reveal}>Reveal in editor</button>
        <button className="tb-menu-item" onClick={toggleBp}>
          {menu.hasBreakpoint ? "Remove breakpoint" : "Add breakpoint"}
        </button>
        <button
          className="tb-menu-item"
          disabled={!menu.hasStatus}
          onClick={menu.hasStatus ? clearSt : undefined}
        >
          Clear status here
        </button>
      </div>
    </div>
  );
}

function TestBenchRunner() {
  const [snapshot, setSnapshot] = useState(null);
  const [running, setRunning] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [composerText, setComposerText] = useState("");
  const [runLog, setRunLog] = useState([]);
  const [runtimeVariables, setRuntimeVariables] = useState({});
  const [variablesCollapsed, setVariablesCollapsed] = useState(false);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [hostError, setHostError] = useState(null);
  /**
   * Batch-run banner state. Non-null while a Test Explorer batch is in
   * flight; carries the progress (running / total). Cleared when the batch
   * ends — final results live in VS Code's Test Results panel, so the
   * banner doesn't need to linger.
   */
  const [batchBanner, setBatchBanner] = useState(null);
  /**
   * Per-step right-click menu. Non-null carries cursor coords + the row's
   * state (line, hasBreakpoint, hasStatus) so the menu can label items
   * correctly and disable "Clear status here" when nothing is set.
   */
  const [stepMenu, setStepMenu] = useState(null);
  /**
   * Webview-local multi-selection of step rows. Plain click replaces, Ctrl/⌘
   * click toggles, Shift+click extends a range from the last anchor. When
   * non-empty this takes precedence over the editor's `selectedLines` for
   * the Run Selected toolbar button — lets users build a "run just 3, 5, 7"
   * set from the sidebar without juggling editor selections.
   */
  const [webviewSelection, setWebviewSelection] = useState(() => new Set());
  const selectionAnchorRef = useRef(null);
  /** Output panel height in pixels — user-resizable via a drag handle on
   *  the top edge. Clamped to [80, viewport - 120] at drag time. */
  const [outputHeight, setOutputHeight] = useState(220);

  const outputLogRef = useRef(null);
  const outputAtBottomRef = useRef(true);
  // Tracks the previous `running` value so the message handler can detect
  // the false→true transition without depending on React state batching
  // order (parametersResolved may arrive in the same tick as running:true,
  // so a useEffect on [running] would clear AFTER parametersResolved merged
  // — clobbering it).
  const runningRef = useRef(false);

  // Diagnostic — push the current runtimeVariables map to the host on
  // every change so test hooks can observe the webview-side state
  // without round-tripping a request. Test-only consumer; production
  // code reads the same state from the controller's per-frame map.
  useEffect(() => {
    hostBridge.postWebviewState(runtimeVariables);
  }, [runtimeVariables]);

  // Subscribe to host messages on mount.
  useEffect(() => {
    const unsubscribe = hostBridge.subscribe((msg) => {
      if (!isHostMsg(msg)) return;
      switch (msg.type) {
        case "activeFile":
          setSnapshot(msg.snapshot);
          if (!msg.snapshot.isTestFile) {
            setHostError(null);
            setPendingPrompt(null);
          }
          break;
        case "running":
          // A fresh run must not inherit variables from the previous run.
          // Mirrors resetFrameState() on the host. Clearing in the handler
          // (rather than via useEffect on [running]) avoids the React-batching
          // race where parametersResolved — which arrives moments after — would
          // already be merged into runtimeVariables before the effect fires.
          if (msg.running && !runningRef.current) {
            setRuntimeVariables({});
          }
          runningRef.current = msg.running;
          setRunning(msg.running);
          break;
        case "runEvent":
          handleRunEvent(msg.event);
          break;
        case "runError":
          setHostError(msg.payload);
          setRunning(false);
          break;
        case "prompt":
          setPendingPrompt({ mode: msg.mode, message: msg.message, varName: msg.varName });
          setComposerText("");
          break;
        case "promptDone":
          setPendingPrompt(null);
          break;
        case "parametersResolved":
          setRuntimeVariables((prev) => ({ ...prev, ...msg.values }));
          break;
        case "batchBanner":
          setBatchBanner(msg.state);
          break;
        default:
          break;
      }
    });
    hostBridge.postReady();
    return unsubscribe;
  }, []);

  const handleRunEvent = (event) => {
    switch (event.type) {
      case "step:start":
        log(`Running step on line ${event.line}…`);
        setRunning(true);
        break;
      case "step:pass":
        log(`✓ Step on line ${event.line} passed`, "pass");
        if (event.output) log(event.output, "info");
        break;
      case "step:fail":
        log(`✗ Step on line ${event.line} failed: ${event.error}`, "fail");
        break;
      case "output":
        log(event.msg, event.kind);
        break;
      case "capture":
        setRuntimeVariables((prev) => ({ ...prev, [event.name]: event.value }));
        log(`✎ ${event.name} ← ${maskIfSecretInline(event.name, event.value)}`, "info");
        break;
      case "frame:scope":
        // Phase 4 / Phase 5 follow-up — surface the server's per-frame
        // scope payload in the webview's Variables panel too. The
        // separate TreeView Variables provider already subscribes to
        // these events, but the webview-internal Variables section
        // (which renders based on the active file's declared
        // parameters + a runtimeValues map) was reading only
        // `parametersResolved` + `capture` events. When the active
        // editor is on a skill `.md` and we're paused inside that
        // skill, the skill's declared parameter (e.g. `query`) needs
        // the caller-supplied value here — without this merge, the
        // panel falls back to the parameter's DESCRIPTION text from
        // the skill's `## Parameters` section, which reads as if the
        // parameter wasn't passed in at all.
        setRuntimeVariables((prev) => ({ ...prev, ...event.scope }));
        break;
      case "done":
        log(`Run ${event.status}`, event.status === "passed" ? "pass" : event.status === "failed" || event.status === "error" ? "fail" : "info");
        setRunning(false);
        break;
      default:
        break;
    }
  };

  const log = (msg, kind = "info") =>
    setRunLog((entries) => [...entries, { msg, kind, ts: new Date().toLocaleTimeString() }]);

  // Auto-scroll output log to bottom unless the user has scrolled up.
  useEffect(() => {
    if (!outputAtBottomRef.current) return;
    const el = outputLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [runLog]);

  // Drop the webview's multi-selection AND the runtimeVariables map when
  // the user switches files — both are file-scoped. Without clearing
  // runtimeVariables, a frame:scope event captured for test A would still
  // render in test B's Variables panel after the user switches over.
  useEffect(() => {
    setWebviewSelection(new Set());
    selectionAnchorRef.current = null;
    setRuntimeVariables({});
  }, [snapshot?.uri]);

  const onLogScroll = () => {
    const el = outputLogRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    outputAtBottomRef.current = distanceFromBottom < 20;
  };

  const isTestFile = snapshot?.isTestFile === true;
  const statuses = useMemo(() => statusFromTuple(snapshot?.statuses ?? []), [snapshot]);
  const passCount = Object.values(statuses).filter((s) => s === "pass" || s === "pass-cached").length;
  const failCount = Object.values(statuses).filter((s) => s === "fail").length;
  const errorMap = useMemo(() => {
    const m = {};
    for (const [line, payload] of snapshot?.errors ?? []) m[line] = payload;
    return m;
  }, [snapshot]);

  const variableRows = useMemo(() => {
    if (!snapshot?.text) return [];
    const declared = parseParametersInline(snapshot.text);
    return collectVariables(snapshot.text, declared, runtimeVariables);
  }, [snapshot, runtimeVariables]);

  const stepLines = useMemo(() => {
    if (!snapshot?.text) return [];
    return extractStepLineIds(snapshot.text);
  }, [snapshot]);

  const stepRows = useMemo(() => {
    if (!snapshot?.text) return [];
    const lines = snapshot.text.split(/\r?\n/);
    return stepLines.map((lineNumber) => ({
      lineNumber,
      text: (lines[lineNumber - 1] ?? "").replace(/^\s*\d+\.\s*/, ""),
    }));
  }, [snapshot, stepLines]);

  const handleRun = () => {
    if (!isTestFile) return;
    // Webview selection wins when it's non-empty; otherwise fall back to
    // the editor cursor selection that flows in via the snapshot. Pass the
    // lines sorted so the run-controller emits step:start events in
    // document order regardless of the order the user clicked.
    const fromWebview = [...webviewSelection].sort((a, b) => a - b);
    const lines = fromWebview.length > 0 ? fromWebview : (snapshot?.selectedLines ?? []);
    hostBridge.postRun(lines);
  };
  const handleRunAll = () => {
    if (!isTestFile) return;
    hostBridge.postRunAll();
  };
  const handleStop = () => hostBridge.postStop();
  const handleCloseSession = () => hostBridge.postRestartSession();
  const handleClearLog = () => setRunLog([]);

  /**
   * Click on a step row. Plain click → replace selection with this line and
   * reveal in editor. Ctrl/⌘ click → toggle this line in/out of the
   * selection. Shift+click → select the contiguous range from the last
   * anchor to this line. Updates the anchor on plain and ctrl clicks so
   * subsequent shift-clicks pivot off the most recently clicked row.
   */
  const handleStepClick = (lineNumber, e) => {
    const isToggle = e && (e.ctrlKey || e.metaKey);
    const isRange = e && e.shiftKey;

    if (isRange && selectionAnchorRef.current != null) {
      const all = stepRows.map((r) => r.lineNumber);
      const anchorIdx = all.indexOf(selectionAnchorRef.current);
      const targetIdx = all.indexOf(lineNumber);
      if (anchorIdx >= 0 && targetIdx >= 0) {
        const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
        setWebviewSelection(new Set(all.slice(lo, hi + 1)));
      }
      hostBridge.postRevealLine(lineNumber);
      return;
    }

    if (isToggle) {
      setWebviewSelection((prev) => {
        const next = new Set(prev);
        if (next.has(lineNumber)) next.delete(lineNumber);
        else next.add(lineNumber);
        return next;
      });
      selectionAnchorRef.current = lineNumber;
      return;
    }

    setWebviewSelection(new Set([lineNumber]));
    selectionAnchorRef.current = lineNumber;
    hostBridge.postRevealLine(lineNumber);
  };

  const handleToggleBreakpoint = (lineNumber, e) => {
    e?.stopPropagation();
    hostBridge.postToggleBreakpoint(lineNumber);
  };

  /**
   * Right-click on a step row → open the per-step context menu at the cursor.
   * Clamp the coordinates so a menu opened near the viewport edge doesn't
   * spill off-screen; the estimated 200×140 box matches the rendered menu's
   * actual size closely enough to avoid the flash that a post-mount layout
   * adjustment would cause.
   */
  const handleStepContextMenu = (e, lineNumber, hasBreakpoint, hasStatus) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_W = 200;
    const MENU_H = 140;
    const x = Math.max(0, Math.min(e.clientX, window.innerWidth - MENU_W - 4));
    const y = Math.max(0, Math.min(e.clientY, window.innerHeight - MENU_H - 4));
    setStepMenu({ x, y, line: lineNumber, hasBreakpoint, hasStatus });
  };
  const closeStepMenu = () => setStepMenu(null);

  /**
   * Vertical sash for the Output panel. Mousedown captures the starting
   * cursor Y and current height; subsequent mousemove updates the height
   * by the inverse delta (dragging up grows the panel). Listeners live
   * on `document` so a fast drag doesn't lose focus when the cursor
   * exits the 4-pixel handle strip.
   */
  const startResizeOutput = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = outputHeight;
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      const next = Math.max(80, Math.min(window.innerHeight - 120, startHeight + dy));
      setOutputHeight(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const handleResume = () => hostBridge.postResume();
  const handlePause = () => hostBridge.postPause();

  const submitComposer = () => {
    const text = composerText.trim();
    if (!text) return;
    hostBridge.postPromptResponse(text);
    setComposerText("");
  };

  const cancelComposer = () => {
    hostBridge.postPromptCancel();
    setComposerText("");
  };

  if (!isTestFile) {
    return (
      <div style={{ fontFamily: "var(--vscode-font-family)", fontSize: "var(--vscode-font-size, 13px)", color: "var(--vscode-foreground)" }}>
        <BatchBanner state={batchBanner} />
        <div style={{ padding: 16 }}>
          <div style={{ marginBottom: 12, fontWeight: 600 }}>TestBench</div>
          <div style={{ opacity: 0.8, lineHeight: 1.5 }}>
            Open a Markdown file with a <code>## Steps</code> heading to start a TestBench run.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "var(--vscode-font-family)", fontSize: "var(--vscode-font-size, 13px)", color: "var(--vscode-foreground)", background: "var(--vscode-sideBar-background)" }}>
      <BatchBanner state={batchBanner} />
      <style>{`
        body { padding: 0 !important; margin: 0; }
        .tb-btn {
          padding: 4px 10px;
          border: none;
          border-radius: 2px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          font-family: inherit;
          font-size: inherit;
          line-height: 1.4;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .tb-btn:hover:not(:disabled) {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .tb-btn:disabled { cursor: default; opacity: 0.5; }
        .tb-btn--primary {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
        }
        .tb-btn--primary:hover:not(:disabled) {
          background: var(--vscode-button-hoverBackground);
        }
        .tb-step {
          padding: 4px 8px;
          display: flex;
          gap: 8px;
          align-items: center;
          cursor: pointer;
          border-radius: 2px;
        }
        .tb-step:hover { background: var(--vscode-list-hoverBackground); }
        .tb-menu-item {
          display: block;
          width: 100%;
          padding: 4px 24px 4px 16px;
          background: transparent;
          color: var(--vscode-menu-foreground, #cccccc);
          border: none;
          text-align: left;
          font-family: inherit;
          font-size: inherit;
          cursor: pointer;
        }
        .tb-menu-item:hover:not(:disabled) {
          background: var(--vscode-menu-selectionBackground, #094771);
          color: var(--vscode-menu-selectionForeground, #ffffff);
        }
        .tb-menu-item:disabled { opacity: 0.4; cursor: default; }
        .tb-step--selected { background: var(--vscode-list-inactiveSelectionBackground); }
        .tb-step--pass { color: var(--vscode-testing-iconPassed, #22c55e); }
        .tb-step--fail { color: var(--vscode-testing-iconFailed, #f87171); }
        .tb-step--running { color: var(--vscode-testing-iconQueued, #60a5fa); }
        .tb-section-header {
          padding: 6px 10px;
          font-size: 0.92em;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
          background: var(--vscode-sideBarSectionHeader-background, transparent);
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          user-select: none;
        }
        .tb-section-body { padding: 4px 8px; }
      `}</style>

      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid var(--vscode-sideBarSectionHeader-border, transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.9em", opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={snapshot?.filePath ?? ""}>
          {(snapshot?.filePath ?? "").split(/[/\\]/).slice(-1)[0]}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {/* Primary action slot: Run / Pause / Resume swap based on state.
              Per debugging-ux spec, the user always sees one obvious next
              action that matches the current state. */}
          {running ? (
            <button
              className="tb-btn tb-btn--primary"
              onClick={handlePause}
              title="Pause the run — keep statuses, can Resume from where it left off (F5)"
            >
              ⏸ Pause
            </button>
          ) : snapshot?.breakpointStop != null ? (
            <button
              className="tb-btn tb-btn--primary"
              onClick={handleResume}
              title={`Resume from line ${snapshot.breakpointStop} (F5)`}
            >
              ▶ Resume (line {snapshot.breakpointStop})
            </button>
          ) : (
            <button
              className="tb-btn tb-btn--primary"
              onClick={handleRun}
              title={
                webviewSelection.size > 0
                  ? `Run ${webviewSelection.size} selected step${webviewSelection.size === 1 ? "" : "s"}`
                  : "Run the selected step(s) — use the sidebar list (Ctrl/Shift+click for multi-select) or the editor cursor (F5)"
              }
            >
              ▶ Run{webviewSelection.size > 1 ? ` (${webviewSelection.size})` : ""}
            </button>
          )}
          <button
            className="tb-btn"
            onClick={handleRunAll}
            disabled={running || snapshot?.breakpointStop != null}
            title="Run every step in the file"
          >
            Run All
          </button>
          <button
            className="tb-btn"
            onClick={handleStop}
            disabled={!running && snapshot?.breakpointStop == null}
            title={running ? "Stop the run (Shift+F5)" : "Clear the pause and end the run (Shift+F5)"}
          >
            ◼ Stop
          </button>
          <button
            className="tb-btn"
            onClick={handleCloseSession}
            disabled={running || snapshot?.breakpointStop != null}
            title="Close the server-side session for this file"
          >
            Close Session
          </button>
        </div>
        {(passCount > 0 || failCount > 0) && (
          <div style={{ display: "flex", gap: 12, fontSize: "0.85em" }}>
            {passCount > 0 && <span style={{ color: "var(--vscode-testing-iconPassed, #22c55e)" }}>✓ {passCount} passed</span>}
            {failCount > 0 && <span style={{ color: "var(--vscode-testing-iconFailed, #f87171)" }}>✗ {failCount} failed</span>}
          </div>
        )}
      </div>

      {hostError && (
        <div style={{ padding: 10 }}>
          <ErrorPanel error={hostError} onDismiss={() => setHostError(null)} />
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {variableRows.length > 0 && (
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--vscode-sideBarSectionHeader-border, transparent)" }}>
            <div className="tb-section-header" onClick={() => setVariablesCollapsed((v) => !v)}>
              <ChevronIcon open={!variablesCollapsed} /> Variables
            </div>
            {!variablesCollapsed && (
              <div className="tb-section-body" style={{ maxHeight: 180, overflowY: "auto" }}>
                {variableRows.map((row) => (
                  <div key={row.name} style={{ display: "flex", justifyContent: "space-between", padding: "2px 4px", fontSize: "0.92em" }}>
                    <span style={{ opacity: 0.8 }}>{row.name}</span>
                    <span style={{ fontFamily: "var(--vscode-editor-font-family, monospace)", color: "var(--vscode-textPreformat-foreground, inherit)" }}>
                      {maskIfSecretInline(row.name, row.value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ flex: 1, overflow: "auto" }}>
          <div className="tb-section-header" style={{ cursor: "default" }}>Steps</div>
          {stepRows.length === 0 && (
            <div style={{ padding: "4px 12px", opacity: 0.6, fontStyle: "italic" }}>No steps under <code>## Steps</code> yet.</div>
          )}
          {stepRows.map(({ lineNumber, text }) => {
            const status = statuses[lineNumber];
            const isPaused = snapshot?.breakpointStop === lineNumber;
            const hasBreakpoint = (snapshot?.breakpoints ?? []).includes(lineNumber);
            const stepError = errorMap[lineNumber];
            const cls = [
              "tb-step",
              status === STATUS.PASS ? "tb-step--pass" : "",
              // Cache replays share the green pass color — the ⚡ glyph
              // is the only visual difference. Counted as pass in the
              // run summary too (see passCount filter above).
              status === STATUS.PASS_CACHED ? "tb-step--pass" : "",
              status === STATUS.FAIL ? "tb-step--fail" : "",
              status === STATUS.RUNNING ? "tb-step--running" : "",
              status === STATUS.STOPPED ? "tb-step--stopped" : "",
              webviewSelection.has(lineNumber) ? "tb-step--selected" : "",
            ].filter(Boolean).join(" ");
            return (
              <React.Fragment key={lineNumber}>
                <div
                  className={cls}
                  onClick={(e) => handleStepClick(lineNumber, e)}
                  onContextMenu={(e) => {
                    // Right-click on a row that isn't already selected → make
                    // it the lone selection. Right-click on a selected row
                    // keeps the existing multi-selection so "Run this step"
                    // operates on the row you clicked, not the whole batch.
                    if (!webviewSelection.has(lineNumber)) {
                      setWebviewSelection(new Set([lineNumber]));
                      selectionAnchorRef.current = lineNumber;
                    }
                    handleStepContextMenu(e, lineNumber, hasBreakpoint, Boolean(status));
                  }}
                  title={`Reveal line ${lineNumber}`}
                >
                  <span
                    onClick={(e) => handleToggleBreakpoint(lineNumber, e)}
                    title={hasBreakpoint ? "Remove breakpoint" : "Add breakpoint"}
                    style={{
                      width: 16,
                      textAlign: "center",
                      fontSize: 12,
                      cursor: "pointer",
                      opacity: hasBreakpoint ? 1 : 0.25,
                      color: hasBreakpoint ? "#E51400" : "inherit",
                      transition: "opacity 80ms ease",
                    }}
                    onMouseEnter={(e) => { if (!hasBreakpoint) e.currentTarget.style.opacity = 0.6; }}
                    onMouseLeave={(e) => { if (!hasBreakpoint) e.currentTarget.style.opacity = 0.25; }}
                  >●</span>
                  <span style={{ width: 14, textAlign: "center" }}>
                    {isPaused ? "▶" : status === STATUS.PASS ? "✓" : status === STATUS.PASS_CACHED ? "⚡︎" : status === STATUS.FAIL ? "✗" : status === STATUS.RUNNING ? "…" : status === STATUS.STOPPED ? "■" : ""}
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
                  <span style={{ opacity: 0.5, fontSize: "0.85em" }}>{lineNumber}</span>
                </div>
                {stepError && (
                  <div style={{ padding: "0 8px 6px 36px" }}>
                    <ErrorPanel error={stepError} />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        <div style={{
          flexShrink: 0,
          // Reserve a vertical slice for the output log so it never collapses
          // to zero when the step list is tall. User can resize via the sash
          // handle on the top edge; goes to auto when collapsed so only the
          // header shows.
          height: logCollapsed ? "auto" : outputHeight,
          borderTop: "1px solid var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border, #4444))",
          display: "flex",
          flexDirection: "column",
          background: "var(--vscode-panel-background, var(--vscode-sideBar-background))",
        }}>
          {!logCollapsed && (
            <div
              onMouseDown={startResizeOutput}
              title="Drag to resize the Output panel"
              style={{
                height: 4,
                marginTop: -2,
                cursor: "ns-resize",
                background: "transparent",
                flexShrink: 0,
                transition: "background 80ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--vscode-sash-hoverBorder, rgba(99,143,255,0.5))"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            />
          )}
          <div className="tb-section-header" onClick={() => setLogCollapsed((v) => !v)}>
            <ChevronIcon open={!logCollapsed} />
            <span>Output</span>
            {runLog.length > 0 && (
              <span style={{ opacity: 0.6, fontSize: "0.85em", textTransform: "none", letterSpacing: 0 }}>
                ({runLog.length})
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button
                className="tb-btn"
                onClick={(e) => { e.stopPropagation(); handleClearLog(); }}
                title="Clear the output log"
                style={{ padding: "1px 6px", fontSize: "0.85em" }}
              >Clear</button>
            </span>
          </div>
          {!logCollapsed && (
            <div ref={outputLogRef} onScroll={onLogScroll} style={{ flex: 1, overflowY: "auto", padding: "4px 8px", fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: "0.92em", minHeight: 0 }}>
              {runLog.length === 0 && <div style={{ opacity: 0.5 }}>No output yet. Run a step to see logs here.</div>}
              {runLog.map((entry, idx) => (
                <div
                  key={idx}
                  style={{
                    color:
                      entry.kind === "fail" || entry.kind === "error"
                        ? "var(--vscode-testing-iconFailed, #f87171)"
                        : entry.kind === "pass"
                        ? "var(--vscode-testing-iconPassed, #22c55e)"
                        : entry.kind === "warn"
                        ? "var(--vscode-editorWarning-foreground, #fbbf24)"
                        : "inherit",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {entry.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {pendingPrompt && (
        <div style={{ padding: 10, borderTop: "1px solid var(--vscode-sideBarSectionHeader-border, transparent)" }}>
          <div style={{ fontSize: "0.92em", marginBottom: 6 }}>
            {pendingPrompt.mode === "interactive"
              ? "Interactive: type a step or :help / done / :quit (Enter submits, Shift+Enter newline)"
              : pendingPrompt.message}
          </div>
          <textarea
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            rows={pendingPrompt.mode === "interactive" ? 3 : 1}
            placeholder={pendingPrompt.varName ? `{{${pendingPrompt.varName}}}` : ""}
            style={{ width: "100%", padding: "4px 6px", fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: "0.92em", background: "var(--vscode-input-background)", color: "var(--vscode-input-foreground)", border: "1px solid var(--vscode-input-border)", borderRadius: 2, outline: "none", boxSizing: "border-box", resize: "vertical" }}
            onKeyDown={(e) => {
              // Chat-style: Enter submits, Shift+Enter inserts a newline.
              // Same for both input and interactive modes — having different
              // submit gestures per mode was confusing in practice.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitComposer();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelComposer();
              }
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "flex-end" }}>
            <button className="tb-btn" onClick={cancelComposer}>Cancel</button>
            <button className="tb-btn tb-btn--primary" onClick={submitComposer} disabled={!composerText.trim()}>Submit</button>
          </div>
        </div>
      )}

      {stepMenu && <StepContextMenu menu={stepMenu} onClose={closeStepMenu} />}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<TestBenchRunner />);
}
