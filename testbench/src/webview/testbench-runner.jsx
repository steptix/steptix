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
]);
function isHostMsg(value) {
  if (!value || typeof value !== "object") return false;
  return HOST_MSG_TYPES.has(value.type);
}

const STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  PASS: "pass",
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

  const outputLogRef = useRef(null);
  const outputAtBottomRef = useRef(true);

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

  const onLogScroll = () => {
    const el = outputLogRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    outputAtBottomRef.current = distanceFromBottom < 20;
  };

  const isTestFile = snapshot?.isTestFile === true;
  const statuses = useMemo(() => statusFromTuple(snapshot?.statuses ?? []), [snapshot]);
  const passCount = Object.values(statuses).filter((s) => s === "pass").length;
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
    hostBridge.postRun(snapshot?.selectedLines ?? []);
  };
  const handleRunAll = () => {
    if (!isTestFile) return;
    hostBridge.postRunAll();
  };
  const handleStop = () => hostBridge.postStop();
  const handleCloseSession = () => hostBridge.postRestartSession();
  const handleClearLog = () => setRunLog([]);

  const handleStepClick = (lineNumber) => {
    hostBridge.postRevealLine(lineNumber);
  };

  const handleToggleBreakpoint = (lineNumber, e) => {
    e?.stopPropagation();
    hostBridge.postToggleBreakpoint(lineNumber);
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
      <div style={{ padding: 16, fontFamily: "var(--vscode-font-family)", fontSize: "var(--vscode-font-size, 13px)", color: "var(--vscode-foreground)" }}>
        <div style={{ marginBottom: 12, fontWeight: 600 }}>TestBench</div>
        <div style={{ opacity: 0.8, lineHeight: 1.5 }}>
          Open a Markdown file with a <code>## Steps</code> heading to start a TestBench run.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "var(--vscode-font-family)", fontSize: "var(--vscode-font-size, 13px)", color: "var(--vscode-foreground)", background: "var(--vscode-sideBar-background)" }}>
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
              title="Run the selected step(s) in the editor (F5)"
            >
              ▶ Run
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
              status === STATUS.FAIL ? "tb-step--fail" : "",
              status === STATUS.RUNNING ? "tb-step--running" : "",
              status === STATUS.STOPPED ? "tb-step--stopped" : "",
            ].filter(Boolean).join(" ");
            return (
              <React.Fragment key={lineNumber}>
                <div className={cls} onClick={() => handleStepClick(lineNumber)} title={`Reveal line ${lineNumber}`}>
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
                    {isPaused ? "▶" : status === STATUS.PASS ? "✓" : status === STATUS.FAIL ? "✗" : status === STATUS.RUNNING ? "…" : status === STATUS.STOPPED ? "■" : ""}
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
          // Reserve a fixed slice of vertical space for the output log so it
          // never collapses to zero when the step list is tall. Goes to auto
          // when the user collapses the section so only the header shows.
          height: logCollapsed ? "auto" : 220,
          borderTop: "1px solid var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border, #4444))",
          display: "flex",
          flexDirection: "column",
          background: "var(--vscode-panel-background, var(--vscode-sideBar-background))",
        }}>
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
            {pendingPrompt.mode === "interactive" ? "Interactive: type a step or :help / done / :quit" : pendingPrompt.message}
          </div>
          <textarea
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            rows={pendingPrompt.mode === "interactive" ? 3 : 1}
            placeholder={pendingPrompt.varName ? `{{${pendingPrompt.varName}}}` : ""}
            style={{ width: "100%", padding: "4px 6px", fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: "0.92em", background: "var(--vscode-input-background)", color: "var(--vscode-input-foreground)", border: "1px solid var(--vscode-input-border)", borderRadius: 2, outline: "none", boxSizing: "border-box", resize: "vertical" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (pendingPrompt.mode === "input" || (e.ctrlKey || e.metaKey))) {
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
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<TestBenchRunner />);
}
