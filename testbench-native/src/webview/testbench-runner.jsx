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
import { collectVariables, parseParametersInline, maskIfSecretInline, classifyCaptureSource } from "./lib/variables-panel.js";
import { extractStepLineIds } from "./lib/step-lines-inline.js";
import {
  stripDetailInline,
  stripFractionInline,
  stripHeadlineInline,
} from "./lib/compile-strip-inline.js";
import {
  appendLogLine,
  clearLogFor,
  logFor,
  setStrip,
  stripFor,
} from "./lib/panel-scope-inline.js";
import { describeStepFailure, formatStepFailure } from "./lib/failure-text-inline.js";
import {
  applyRowClick,
  buildRunRowsPayload,
  buildTableRowsPayload,
  countSelectedRows,
  formatRowDuration,
  isRowLoopRunning,
  prefixRowFailure,
  rowFailuresFor,
  rowGlyph,
  rowGroups,
  rowKey,
  rowsCollapseKey,
  rowsFor,
  rowStatusClass,
  runButtonLabel,
  runTableRowCount,
  runButtonTitle,
  setRowFailuresFor,
  setRowsFor,
  variablesHeaderSuffix,
} from "./lib/rows-panel.js";

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
  "rows",
  "rowSummary",
  "running",
  "breakpointStop",
  "batchBanner",
  "skillRerunAvailable",
  "compileEvent",
  "compileProgress",
  "compileRunEvent",
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
  // Ran its compiled code-behind entry — no model call at all. Painted
  // with the code mark (`CodeBehindIcon`, the gutter's status-code-behind.svg).
  PASS_CODE_BEHIND: "pass-code-behind",
  // Passed under AI because the compiled entry threw. ⚠ — recompile.
  PASS_STALE: "pass-stale",
  FAIL: "fail",
  SKIP: "skip",
  STOPPED: "stopped",
};

function statusFromTuple(tuples) {
  const map = {};
  for (const [line, status] of tuples) map[line] = status;
  return map;
}

/**
 * The code-behind mark: `</>` — the same drawing as the gutter's
 * status-code-behind.svg and the editor-title button's `$(code)`, so "ran as
 * code" and "make it code" look the same everywhere. Inherits the text colour.
 */
function CodeBehindIcon({ size = 13, style }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ verticalAlign: "-0.15em", flexShrink: 0, ...style }}
    >
      <path
        d="M5.4 4.3L1.9 8l3.5 3.7M10.6 4.3L14.1 8l-3.5 3.7M9.4 2.6L6.6 13.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
 * The compile tail's status strip (stories/compile-tail-progress.md).
 *
 * Visible only for the TAIL — from the moment the run's steps are done until
 * the proposal arrives. During the run itself the steps painting ARE the
 * progress; the strip exists for the stretch that has nothing else to show.
 *
 * `state` is the active file's, and only ever the active file's: the strip is
 * part of that file's run context and leaves the panel with the rest of it when
 * the author switches away.
 */
function CompileStrip({ state }) {
  if (!state) return null;
  const headline = stripHeadlineInline(state);
  const detail = stripDetailInline(state);
  const fraction = stripFractionInline(state);
  return (
    <div
      style={{
        flexShrink: 0,
        padding: "6px 12px 0",
        borderBottom: "1px solid var(--vscode-panel-border, #444)",
        background: "var(--vscode-editorWidget-background, var(--vscode-sideBar-background))",
        fontSize: "0.92em",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Spinner />
        <span style={{ flex: 1, minWidth: 0 }}>{headline}</span>
      </div>
      {detail && (
        <div style={{ opacity: 0.7, paddingLeft: 20, marginTop: 1 }}>{detail}</div>
      )}
      <div
        // A 2px rule under the text: a dim track, filled to the fraction the
        // server reported. With no counts (an older server sends no
        // `compile:progress`) the track stays empty rather than pretending to
        // a position it does not have — the spinner is what says "working".
        style={{
          height: 2,
          marginTop: 6,
          background: "var(--vscode-progressBar-background, #0e70c0)",
          opacity: 0.25,
        }}
      >
        {fraction !== null && (
          <div
            style={{
              height: "100%",
              width: `${Math.round(fraction * 100)}%`,
              background: "var(--vscode-progressBar-background, #0e70c0)",
              transition: "width 160ms linear",
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A CSS-only spinner — the webview has no codicon font to lean on. */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 11,
        height: 11,
        flexShrink: 0,
        borderRadius: "50%",
        border: "1.5px solid var(--vscode-progressBar-background, #0e70c0)",
        borderTopColor: "transparent",
        display: "inline-block",
        animation: "tb-spin 900ms linear infinite",
      }}
    />
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

/**
 * Per-row right-click menu (stories/data-row-progress-and-selection.md
 * §"How you run one row, or some"). Same shell as `StepContextMenu` — the
 * transparent backdrop catches outside clicks, Escape closes — with the two
 * gestures a row has: run the row you pointed at, and, when a multi-row
 * selection is in play, run all of it.
 *
 * Both send whole rows (no `lines`): "run this row" has always meant the flow
 * for that row, not a slice of it.
 */
function RowContextMenu({ menu, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runThis = () => { onClose(); hostBridge.postRunRows(menu.thisRowPayload); };
  const runSelected = () => { onClose(); hostBridge.postRunRows(menu.selectedPayload); };
  const reveal = () => { onClose(); hostBridge.postRevealLine(menu.line); };

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
        {/* Disabled while a run is in flight or parked at a breakpoint, like
            the group header's ▷ Run all — a second run cannot start, and an
            item that does nothing when clicked is worse than a greyed one. */}
        <button className="tb-menu-item" onClick={runThis} disabled={menu.runDisabled}>
          Run this row
        </button>
        {menu.selectedCount > 1 && (
          <button className="tb-menu-item" onClick={runSelected} disabled={menu.runDisabled}>
            Run selected rows ({menu.selectedCount})
          </button>
        )}
        <button className="tb-menu-item" onClick={reveal}>Reveal in editor</button>
      </div>
    </div>
  );
}

// Minimum heights (px) that keep each resizable section usable when the
// panel is short. Steps is the protected region — it never shrinks below
// ~a few rows, so the Output panel can no longer cover it. Output yields
// first, collapsing toward just its header (OUTPUT_MIN_HEIGHT).
const STEPS_MIN_HEIGHT = 120;
const OUTPUT_MIN_HEIGHT = 36;

function TestBenchRunner() {
  const [snapshot, setSnapshot] = useState(null);
  const [running, setRunning] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [composerText, setComposerText] = useState("");
  /**
   * The Output section's lines, PER FILE (stories/compile-tail-progress.md
   * §The panel log). The panel follows the active editor but every run
   * controller posts to this one webview, so a single shared array showed
   * whichever test spoke last — and two concurrent compiles interleaved their
   * generation lines. Keyed by the document URI each message is stamped with.
   */
  const [logsByUri, setLogsByUri] = useState({});
  /**
   * The compile tail's status strip, per file. Same keying and the same
   * reason: the strip describes ONE file's compile, and a panel showing
   * github.md with securebank.md's counts on it reads as the wrong file's
   * state. The workbench's status bar item is what covers the author who has
   * navigated away.
   */
  const [stripByUri, setStripByUri] = useState({});
  const [runtimeVariables, setRuntimeVariables] = useState({});
  // Parallel to runtimeVariables: records the `source` discriminator from
  // each `capture` event (runner-core CaptureEvent → 'capture' | 'toolOutput')
  // keyed by variable name. Lets the Variables panel mark a value a skill or
  // tool returned apart from one scraped off the page. frame:scope and
  // parametersResolved carry no such discriminator, so they leave this map
  // untouched — those rows render as parameters / plain captures.
  const [runtimeSources, setRuntimeSources] = useState({});
  const [variablesCollapsed, setVariablesCollapsed] = useState(false);
  // "Re-run a skill step with its variables": { skillName, scope, paramNames }
  // when a top-level skill step fails on a live session, else null.
  // `rerunEdits` holds the user's in-progress edits to the editable rows.
  const [skillRerun, setSkillRerun] = useState(null);
  const [rerunEdits, setRerunEdits] = useState({});
  const [stepsCollapsed, setStepsCollapsed] = useState(false);
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
  /**
   * The Rows section (stories/data-row-progress-and-selection.md). Per file,
   * like the Output lines are: the panel is one webview that every controller
   * posts to, and a file's rows belong to that file. Replaced wholesale by
   * each `rows` message — the host decides what the table looks like now.
   */
  const [rowsByUri, setRowsByUri] = useState({});
  /**
   * `rowSummary`'s `{ line → rows[] }` per file — the rows each step line
   * failed on across a loop, which prefixes that line's failure text with
   * `(row 3)` / `(rows 2, 4)` once the loop is over.
   */
  const [rowFailuresByUri, setRowFailuresByUri] = useState({});
  /**
   * Webview-local multi-selection of ROW lines, kept apart from
   * `webviewSelection` (steps) because the two are different axes: a
   * selection may span both lists, and Run then sends the rows AND the steps.
   * Entries are `<tableKey>#<row>` so a row of the run table and row 2 of a
   * section table never collide.
   */
  const [rowSelection, setRowSelection] = useState(() => new Set());
  /** Shift+click pivot for the Rows list — `{ tableKey, row }`, so a range
   *  never spans two tables. The Steps list has its own. */
  const rowAnchorRef = useRef(null);
  /** Collapse state per table, keyed by `tableKey`. Absent = expanded. */
  const [rowsCollapsed, setRowsCollapsed] = useState({});
  /** Per-row right-click menu — cursor coords plus the payloads the two items
   *  would post, resolved at open time from the row and the selection. */
  const [rowMenu, setRowMenu] = useState(null);
  /** Output panel height in pixels — user-resizable via a drag handle on
   *  the top edge. Clamped to [80, viewport - 120] at drag time. */
  const [outputHeight, setOutputHeight] = useState(220);

  const outputLogRef = useRef(null);
  const outputAtBottomRef = useRef(true);
  /**
   * The active file's URI, as a ref so the message handler (subscribed once,
   * on mount) can read it without going stale. Only used as the fallback
   * bucket for a message that carries no `uri` — a host that predates the
   * stamp, or a hand-built one in a test.
   */
  const activeUriRef = useRef(null);
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
          activeUriRef.current = msg.snapshot.uri ?? null;
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
          // `sync` means the ACTIVE DOCUMENT changed and this is its run
          // state, not a run starting. Switching to an already-running test
          // must not wipe the variables that run has collected.
          if (msg.running && !runningRef.current && !msg.sync) {
            setRuntimeVariables({});
            setRuntimeSources({});
            // A new run invalidates any parked skill-failure re-run offer (its
            // captured scope is wiped on the host side too).
            setSkillRerun(null);
            setRerunEdits({});
            // Same reasoning for the `(row N)` prefixes: they describe the
            // last loop, and the run starting now has not failed on any row
            // yet. The map is cleared whole rather than for one file because
            // `running` carries no URI — a lost prefix on some other file is
            // cheaper than one that lies about this run.
            setRowFailuresByUri({});
          }
          runningRef.current = msg.running;
          setRunning(msg.running);
          break;
        case "runEvent":
          handleRunEvent(msg.event, msg.uri);
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
        case "rows":
          // The whole state of every table, as of now. Each message replaces
          // the file's rows rather than merging into them, so a row the host
          // no longer lists cannot linger with a mark from two runs ago.
          setRowsByUri((prev) => setRowsFor(prev, msg.uri ?? activeUriRef.current, msg.tables));
          break;
        case "rowSummary":
          setRowFailuresByUri((prev) =>
            setRowFailuresFor(prev, msg.uri ?? activeUriRef.current, msg.failures),
          );
          break;
        case "batchBanner":
          setBatchBanner(msg.state);
          break;
        case "skillRerunAvailable":
          setSkillRerun(msg.failure);
          setRerunEdits({});
          break;
        case "compileEvent":
          log(msg.line, "info", msg.uri);
          break;
        case "compileProgress":
          // `state: null` takes the strip down. Kept per file so switching
          // away and back mid-tail finds it where it was.
          setStripByUri((prev) => setStrip(prev, msg.uri ?? activeUriRef.current, msg.state));
          break;
        case "compileRunEvent":
          // The log line for this event arrived as `compileEvent`; what is
          // left to do here is what a run's event would do to the Variables
          // panel. The gutter is the host's.
          if (msg.event.type === "capture") {
            setRuntimeVariables((prev) => ({ ...prev, [msg.event.name]: msg.event.value }));
            setRuntimeSources((prev) => ({
              ...prev,
              [msg.event.name]: classifyCaptureSource(msg.event.source),
            }));
          }
          break;
        default:
          break;
      }
    });
    hostBridge.postReady();
    return unsubscribe;
  }, []);

  const handleRunEvent = (event, uri) => {
    switch (event.type) {
      case "step:start":
        log(`Running step on line ${event.line}…`, "info", uri);
        setRunning(true);
        break;
      case "step:pass":
        if (event.codeBehindStale) {
          log(
            `⚠ Step on line ${event.line} passed under AI — code-behind failed: ${event.codeBehindStale.error}`,
            "warn",
            uri,
          );
        } else {
          log(
            `✓ Step on line ${event.line} passed${event.fromCodeBehind ? " (code-behind)" : ""}`,
            "pass",
            uri,
          );
        }
        if (event.output) log(event.output, "info", uri);
        break;
      case "step:fail":
        // A heal whose AI attempt failed too carries both errors — say so,
        // or the code-behind crash that started it would be invisible here.
        log(`✗ Step on line ${event.line} failed: ${describeStepFailure(event)}`, "fail", uri);
        break;
      case "output":
        log(event.msg, event.kind, uri);
        break;
      case "capture":
        setRuntimeVariables((prev) => ({ ...prev, [event.name]: event.value }));
        // Record where the value came from. An older server omits `source`;
        // classifyCaptureSource collapses absent/unknown to 'capture' (the
        // conservative default), so this never crashes on legacy events.
        setRuntimeSources((prev) => ({ ...prev, [event.name]: classifyCaptureSource(event.source) }));
        log(`✎ ${event.name} ← ${maskIfSecretInline(event.name, event.value)}`, "info", uri);
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
        log(
          `Run ${event.status}`,
          event.status === "passed" ? "pass" : event.status === "failed" || event.status === "error" ? "fail" : "info",
          uri,
        );
        setRunning(false);
        break;
      default:
        break;
    }
  };

  /**
   * Append one line to a FILE's log.
   *
   * `uri` is the document the host stamped the message with. A message that
   * carries none — an older host, or a hand-built one — falls back to whatever
   * file is active, which is what the single shared log always did.
   */
  const log = (msg, kind = "info", uri) => {
    const entry = { msg, kind, ts: new Date().toLocaleTimeString() };
    setLogsByUri((prev) => appendLogLine(prev, uri ?? activeUriRef.current, entry));
  };

  /** The active file's log, and the active file's strip. Everything else's
   *  stays in its own bucket until the author switches to it. */
  const runLog = logFor(logsByUri, snapshot?.uri);
  const compileStrip = stripFor(stripByUri, snapshot?.uri);

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
    // The row selection is file-scoped for the same reason, and its entries
    // name tables of the file you just left. The rows THEMSELVES stay put in
    // `rowsByUri` — they are that file's last run, like its Output lines.
    setRowSelection(new Set());
    rowAnchorRef.current = null;
    setRowMenu(null);
    setRuntimeVariables({});
    setRuntimeSources({});
    setSkillRerun(null);
    setRerunEdits({});
  }, [snapshot?.uri]);

  const onLogScroll = () => {
    const el = outputLogRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    outputAtBottomRef.current = distanceFromBottom < 20;
  };

  const isTestFile = snapshot?.isTestFile === true;
  const statuses = useMemo(() => statusFromTuple(snapshot?.statuses ?? []), [snapshot]);
  const passCount = Object.values(statuses).filter(
    (s) => s === "pass" || s === "pass-cached" || s === "pass-code-behind" || s === "pass-stale",
  ).length;
  const codeBehindCount = Object.values(statuses).filter((s) => s === "pass-code-behind").length;
  const staleCount = Object.values(statuses).filter((s) => s === "pass-stale").length;
  const failCount = Object.values(statuses).filter((s) => s === "fail").length;
  const errorMap = useMemo(() => {
    const m = {};
    for (const [line, payload] of snapshot?.errors ?? []) m[line] = payload;
    return m;
  }, [snapshot]);
  // Failure text pinned to ✗/⚠ lines by the host's tracker — rendered inline
  // under the step row so a failed code-behind's error is visible without
  // digging through the Output log.
  const failureMap = useMemo(() => {
    const m = {};
    for (const [line, failure] of snapshot?.failures ?? []) m[line] = failure;
    return m;
  }, [snapshot]);

  const variableRows = useMemo(() => {
    if (!snapshot?.text) return [];
    const declared = parseParametersInline(snapshot.text);
    return collectVariables(snapshot.text, declared, runtimeVariables, runtimeSources);
  }, [snapshot, runtimeVariables, runtimeSources]);

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

  // ── Rows ───────────────────────────────────────────────────────────────
  // The active file's tables, and only ever the active file's. Everything
  // below is derived from them, so a file with no `rows` message renders no
  // Rows section and every row-aware label falls back to what it says today.
  const rowTables = rowsFor(rowsByUri, snapshot?.uri);
  const groups = useMemo(() => rowGroups(rowTables), [rowTables]);
  const selectedRowCount = useMemo(
    () => countSelectedRows(rowTables, rowSelection),
    [rowTables, rowSelection],
  );
  const rowFailures = rowFailuresFor(rowFailuresByUri, snapshot?.uri);
  // During a loop the Steps list shows the CURRENT row's failures, so a
  // `(row N)` prefix from the last loop would name the wrong one.
  const rowLoopRunning = isRowLoopRunning(rowTables);
  const varsSuffix = variablesHeaderSuffix(rowTables);
  const rowRunDisabled = running || snapshot?.breakpointStop != null;
  // The multiplier a plain step selection is subject to in a data-driven file:
  // with no rows ticked, every selected step runs once per row, and the Run
  // button has to say so (`Run (×5 rows)`).
  const runTableRows = runTableRowCount(rowTables);

  /**
   * Click on a row line. The Steps list's gestures, applied to the other
   * axis: plain click replaces (and drops the step selection — a plain click
   * means "start over"), Ctrl/⌘ toggles, Shift extends a range inside the
   * same table. A plain or range click also reveals the row in the editor.
   */
  const handleRowClick = (group, row, e) => {
    const next = applyRowClick({
      selection: rowSelection,
      group,
      row: row.row,
      toggle: Boolean(e && (e.ctrlKey || e.metaKey)),
      range: Boolean(e && e.shiftKey),
      anchor: rowAnchorRef.current,
    });
    setRowSelection(next.selection);
    rowAnchorRef.current = next.anchor;
    if (next.clearSteps) {
      setWebviewSelection(new Set());
      selectionAnchorRef.current = null;
    }
    if (next.reveal) hostBridge.postRevealLine(row.line);
  };

  /**
   * Right-click on a row. Like the Steps list, a right-click on a row that
   * is not already selected makes it the lone selection, so *Run this row*
   * operates on the row you pointed at rather than on a stale batch. Both
   * payloads are resolved here, from the selection as it will be.
   */
  const handleRowContextMenu = (group, row, e) => {
    e.preventDefault();
    e.stopPropagation();
    let selection = rowSelection;
    if (!rowSelection.has(rowKey(group.key, row.row))) {
      selection = new Set([rowKey(group.key, row.row)]);
      setRowSelection(selection);
      setWebviewSelection(new Set());
      selectionAnchorRef.current = null;
      rowAnchorRef.current = { tableKey: group.key, row: row.row };
    }
    const MENU_W = 200;
    const MENU_H = 110;
    setRowMenu({
      x: Math.max(0, Math.min(e.clientX, window.innerWidth - MENU_W - 4)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - MENU_H - 4)),
      line: row.line,
      selectedCount: countSelectedRows(rowTables, selection),
      runDisabled: rowRunDisabled,
      thisRowPayload: buildTableRowsPayload(group, [row.row]),
      selectedPayload: buildRunRowsPayload({ tables: rowTables, rowSelection: selection }),
    });
  };
  const closeRowMenu = () => setRowMenu(null);

  /**
   * ▷ Run all — every row of THIS table, whatever their marks.
   *
   * Sends the TABLE, like ↻ Re-run failed below: the numbers on screen came
   * from a `rows` message that may predate an edit to the table, so a row
   * added since would be the one row "run all rows" left out. The host reads
   * the file as it is now.
   */
  const handleRunAllRows = (group) => {
    hostBridge.postRunAllRows(group.table.table);
  };
  /**
   * ↻ Re-run failed — the rows of this table that are red.
   *
   * Sends the TABLE, not the numbers on screen: this list came from a `rows`
   * message that may predate an edit to the table, and re-running a
   * remembered number would run whatever row now sits in that position. The
   * host re-reads the file, through the same `failedRowsToRerun` the palette
   * command uses.
   */
  const handleRerunFailedRows = (group) => {
    hostBridge.postRerunFailedRows(group.table.table);
  };

  const handleRun = () => {
    if (!isTestFile) return;
    // Webview selection wins when it's non-empty; otherwise fall back to
    // the editor cursor selection that flows in via the snapshot. Pass the
    // lines sorted so the run-controller emits step:start events in
    // document order regardless of the order the user clicked.
    const fromWebview = [...webviewSelection].sort((a, b) => a - b);
    // With rows in the selection this is a `runRows`, not a `run`: the
    // selection narrows two axes, and the step lines it carries are the
    // panel's own — the editor's cursor selection is the host's separate path
    // to the same controller and must not be folded in behind the user's back.
    if (selectedRowCount > 0) {
      hostBridge.postRunRows(
        buildRunRowsPayload({ tables: rowTables, rowSelection, stepLines: fromWebview }),
      );
      return;
    }
    const lines = fromWebview.length > 0 ? fromWebview : (snapshot?.selectedLines ?? []);
    hostBridge.postRun(lines);
  };
  const handleRunAll = () => {
    if (!isTestFile) return;
    hostBridge.postRunAll();
  };
  const handleCompile = () => {
    if (!isTestFile) return;
    hostBridge.postCompile();
  };
  const handleStop = () => hostBridge.postStop();
  const handleCloseSession = () => hostBridge.postRestartSession();
  /** Clear the ACTIVE file's log only. Another file's compile is still
   *  running and its lines are still its own. */
  const handleClearLog = () => setLogsByUri((prev) => clearLogFor(prev, snapshot?.uri));

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

    // A plain click means "start over", in BOTH lists — otherwise clicking
    // one step after picking three rows would leave `Run (4)` on the button
    // and quietly run the rows too.
    setWebviewSelection(new Set([lineNumber]));
    selectionAnchorRef.current = lineNumber;
    setRowSelection(new Set());
    rowAnchorRef.current = null;
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
        @keyframes tb-spin { to { transform: rotate(360deg); } }
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
        /* A row the loop planned and did not reach. The gutter's skip icon is
           a hollow slate circle; this is that colour, so ◌ reads the same in
           both places. */
        .tb-step--skip { color: var(--vscode-descriptionForeground, #94a3b8); }
        /* One row line of the Rows section. Same shell as a step row — the
           tb-step hover, selection and status colours all apply — with a
           monospace values column that elides rather than wraps, because a
           five-column table will not fit in a sidebar and the full text is
           one hover away. */
        .tb-row-values {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--vscode-editor-font-family, monospace);
          font-size: 0.92em;
        }
        .tb-row-detail { flex-shrink: 0; font-size: 0.85em; opacity: 0.85; }
        .tb-row-duration {
          flex-shrink: 0;
          font-size: 0.85em;
          opacity: 0.55;
          font-variant-numeric: tabular-nums;
        }
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
              title={runButtonTitle({ rows: selectedRowCount, steps: webviewSelection.size, tableRows: runTableRows })}
            >
              ▶ {runButtonLabel({ rows: selectedRowCount, steps: webviewSelection.size, tableRows: runTableRows })}
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
          <button
            className="tb-btn"
            onClick={handleCompile}
            disabled={running}
            title="Run this test once and generate code-behind for every step that ran under AI, then offer the result as a diff. The entries are unproven — the next run proves them."
          >
            <CodeBehindIcon style={{ marginRight: 5 }} />
            {"Run & Compile"}
          </button>
        </div>
        {(passCount > 0 || failCount > 0) && (
          <div style={{ display: "flex", gap: 12, fontSize: "0.85em" }}>
            {passCount > 0 && <span style={{ color: "var(--vscode-testing-iconPassed, #22c55e)" }}>✓ {passCount} passed</span>}
            {codeBehindCount > 0 && <span style={{ opacity: 0.75 }}><CodeBehindIcon size={12} style={{ marginRight: 3 }} /> {codeBehindCount} code-behind</span>}
            {staleCount > 0 && <span style={{ color: "var(--vscode-editorWarning-foreground, #f59e0b)" }}>⚠ {staleCount} stale</span>}
            {failCount > 0 && <span style={{ color: "var(--vscode-testing-iconFailed, #f87171)" }}>✗ {failCount} failed</span>}
          </div>
        )}
      </div>

      <CompileStrip state={compileStrip} />

      {hostError && (
        <div style={{ padding: 10 }}>
          <ErrorPanel error={hostError} onDismiss={() => setHostError(null)} />
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {skillRerun && !running && (
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--vscode-sideBarSectionHeader-border, transparent)", padding: "6px 8px" }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              Re-run “{skillRerun.skillName}” from the failed step
            </div>
            <div style={{ opacity: 0.8, fontSize: "0.9em", marginBottom: 6 }}>
              Edit the captured variables, then re-run from the failed step to the end of the skill on the live page.
            </div>
            {Object.entries(skillRerun.scope).map(([name, value]) => {
              const isParam = skillRerun.paramNames.includes(name);
              const masked = /password|secret|token|apikey|api_key/i.test(name);
              const readOnly = isParam || masked;
              const current = name in rerunEdits ? rerunEdits[name] : value;
              return (
                <div key={name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, fontSize: "0.92em" }}>
                  <span
                    title={isParam ? `${name} (parameter — read-only; edit the [skill:] line and Continue to change it)` : name}
                    style={{ flex: "0 0 40%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 }}
                  >
                    {name}{isParam ? " (param)" : ""}
                  </span>
                  {readOnly ? (
                    <span style={{ flex: 1, fontFamily: "var(--vscode-editor-font-family, monospace)", opacity: 0.65 }}>
                      {maskIfSecretInline(name, value)}
                    </span>
                  ) : (
                    <input
                      type="text"
                      value={current}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRerunEdits((prev) => ({ ...prev, [name]: v }));
                      }}
                      style={{ flex: 1, minWidth: 0, fontFamily: "var(--vscode-editor-font-family, monospace)", background: "var(--vscode-input-background)", color: "var(--vscode-input-foreground)", border: "1px solid var(--vscode-input-border, transparent)", borderRadius: 2, padding: "1px 4px" }}
                    />
                  )}
                </div>
              );
            })}
            <button
              onClick={() => hostBridge.postRerunSkillStep(skillRerun.testUri, rerunEdits)}
              title="Re-run from the failed step to the end of the skill on the live session"
              style={{ marginTop: 4, padding: "2px 10px", cursor: "pointer", background: "var(--vscode-button-background)", color: "var(--vscode-button-foreground)", border: "none", borderRadius: 2 }}
            >
              ↻ Re-run from failed step
            </button>
          </div>
        )}
        {/* The Rows section — the report's matrix table, live. Present only
            while the host's latest `rows` message for this file carries a
            table; a test with no data table is exactly as it was. One group
            per table, each collapsible on its own, so a file with a run table
            and three section tables does not bury the run table. */}
        {groups.length > 0 && (
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--vscode-sideBarSectionHeader-border, transparent)", maxHeight: 220, overflowY: "auto" }}>
            {groups.map((group) => {
              // Per file as well as per table: the panel is one webview shared
              // by every test, so a bare table key collapsed the Rows section
              // on every data-driven file at once.
              const collapseKey = rowsCollapseKey(snapshot?.uri, group.key);
              const collapsed = rowsCollapsed[collapseKey] === true;
              return (
                <div key={group.key}>
                  <div
                    className="tb-section-header"
                    onClick={() => setRowsCollapsed((prev) => ({ ...prev, [collapseKey]: !collapsed }))}
                  >
                    <ChevronIcon open={!collapsed} />
                    <span style={{ textTransform: "none", letterSpacing: 0 }}>{group.label}</span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button
                        className="tb-btn"
                        onClick={(e) => { e.stopPropagation(); handleRunAllRows(group); }}
                        disabled={rowRunDisabled}
                        title="Run every row of this table, whatever their marks"
                        style={{ padding: "1px 6px", fontSize: "0.85em" }}
                      >▷ Run all rows</button>
                      {/* Only while the last run of this file left a red row
                          in THIS table — a button that would run nothing is
                          worse than no button. */}
                      {group.hasFailed && (
                        <button
                          className="tb-btn"
                          onClick={(e) => { e.stopPropagation(); handleRerunFailedRows(group); }}
                          disabled={rowRunDisabled}
                          title="Run just the rows that failed"
                          style={{ padding: "1px 6px", fontSize: "0.85em" }}
                        >↻ Re-run failed</button>
                      )}
                    </span>
                  </div>
                  {!collapsed && (
                    <div className="tb-section-body">
                      {group.rows.length === 0 && (
                        <div style={{ padding: "2px 4px", opacity: 0.6, fontStyle: "italic" }}>
                          No rows in this table.
                        </div>
                      )}
                      {group.rows.map((row) => {
                        const selected = rowSelection.has(rowKey(group.key, row.row));
                        const cls = [
                          "tb-step",
                          rowStatusClass(row.status),
                          selected ? "tb-step--selected" : "",
                        ].filter(Boolean).join(" ");
                        const duration = formatRowDuration(row.durationMs);
                        return (
                          <div
                            key={row.row}
                            className={cls}
                            onClick={(e) => handleRowClick(group, row, e)}
                            onContextMenu={(e) => handleRowContextMenu(group, row, e)}
                            title={`${row.values}${row.detail ? ` — ${row.detail}` : ""}\nReveal line ${row.line}`}
                          >
                            <span style={{ width: 14, textAlign: "center", flexShrink: 0 }}>
                              {rowGlyph(row.status)}
                            </span>
                            <span style={{ width: 16, textAlign: "right", flexShrink: 0, opacity: 0.7 }}>
                              {row.row}
                            </span>
                            <span className="tb-row-values" title={row.values}>{row.values}</span>
                            {row.detail && <span className="tb-row-detail">{row.detail}</span>}
                            {duration && <span className="tb-row-duration">{duration}</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {variableRows.length > 0 && (
          <div style={{ flexShrink: 0, borderBottom: "1px solid var(--vscode-sideBarSectionHeader-border, transparent)" }}>
            <div className="tb-section-header" onClick={() => setVariablesCollapsed((v) => !v)}>
              <ChevronIcon open={!variablesCollapsed} />
              <span>Variables</span>
              {/* `· row 3 of 5` while the run-row loop is on a row: these
                  values are that row's, and the header is where a reader
                  looks to know whose values they are. */}
              {varsSuffix && (
                <span style={{ opacity: 0.7, textTransform: "none", letterSpacing: 0 }}>{varsSuffix}</span>
              )}
            </div>
            {!variablesCollapsed && (
              <div className="tb-section-body" style={{ maxHeight: 180, overflowY: "auto" }}>
                {variableRows.map((row) => {
                  // Mark values a skill/tool returned (capture event with
                  // source: 'toolOutput') apart from page captures and from
                  // parameters. The badge sits beside the name; absent
                  // captureSource (parameters, plain page captures, legacy
                  // servers that omit `source`) renders no badge — those rows
                  // stay visually as before.
                  const isToolOutput = row.captureSource === "toolOutput";
                  return (
                    <div key={row.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6, padding: "2px 4px", fontSize: "0.92em" }}>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 4, minWidth: 0 }}>
                        <span style={{ opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
                        {isToolOutput && (
                          <span
                            title="Returned by a [tool:] / [skill:] invocation"
                            style={{
                              flexShrink: 0,
                              fontSize: "0.82em",
                              lineHeight: 1.2,
                              padding: "0 4px",
                              borderRadius: 3,
                              textTransform: "uppercase",
                              letterSpacing: "0.4px",
                              background: "var(--vscode-badge-background, #4d4d4d)",
                              color: "var(--vscode-badge-foreground, #fff)",
                            }}
                          >tool</span>
                        )}
                      </span>
                      <span style={{ fontFamily: "var(--vscode-editor-font-family, monospace)", color: "var(--vscode-textPreformat-foreground, inherit)" }}>
                        {maskIfSecretInline(row.name, row.value)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div style={{
          display: "flex",
          flexDirection: "column",
          // Steps is the protected region: it grows to fill space and never
          // shrinks below STEPS_MIN_HEIGHT, so the Output panel can no longer
          // cover it on a short panel. Collapsing it hands its space to Output
          // (which gets flexGrow while steps are collapsed) rather than leaving
          // a void.
          flex: stepsCollapsed ? "0 0 auto" : "1 1 auto",
          minHeight: stepsCollapsed ? undefined : STEPS_MIN_HEIGHT,
          overflow: "hidden",
        }}>
          <div className="tb-section-header" onClick={() => setStepsCollapsed((v) => !v)}>
            <ChevronIcon open={!stepsCollapsed} />
            <span>Steps</span>
            {stepRows.length > 0 && (
              <span style={{ opacity: 0.6, fontSize: "0.85em", textTransform: "none", letterSpacing: 0 }}>
                ({stepRows.length})
              </span>
            )}
          </div>
          {!stepsCollapsed && (
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {stepRows.length === 0 && (
            <div style={{ padding: "4px 12px", opacity: 0.6, fontStyle: "italic" }}>No steps under <code>## Steps</code> yet.</div>
          )}
          {stepRows.map(({ lineNumber, text }) => {
            const status = statuses[lineNumber];
            const isPaused = snapshot?.breakpointStop === lineNumber;
            const hasBreakpoint = (snapshot?.breakpoints ?? []).includes(lineNumber);
            const stepError = errorMap[lineNumber];
            const stepFailure =
              failureMap[lineNumber] && (status === STATUS.FAIL || status === STATUS.PASS_STALE)
                ? // After a row loop, say WHICH rows this line failed on —
                  // the same cross-reference the gutter hover carries. While
                  // the loop is still running the painting is the current
                  // row's, so it needs no prefix.
                  prefixRowFailure(
                    formatStepFailure(failureMap[lineNumber], status === STATUS.PASS_STALE),
                    rowLoopRunning ? undefined : rowFailures[lineNumber],
                  )
                : null;
            const cls = [
              "tb-step",
              status === STATUS.PASS ? "tb-step--pass" : "",
              // Cache replays share the green pass color — the ⚡ glyph
              // is the only visual difference. Counted as pass in the
              // run summary too (see passCount filter above).
              status === STATUS.PASS_CACHED ? "tb-step--pass" : "",
              // Code-behind and stale are passes too — the glyph carries the
              // difference, the colour stays green.
              status === STATUS.PASS_CODE_BEHIND ? "tb-step--pass" : "",
              status === STATUS.PASS_STALE ? "tb-step--pass" : "",
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
                    {isPaused ? "▶" : status === STATUS.PASS ? "✓" : status === STATUS.PASS_CACHED ? "⚡︎" : status === STATUS.PASS_CODE_BEHIND ? <CodeBehindIcon /> : status === STATUS.PASS_STALE ? "⚠" : status === STATUS.FAIL ? "✗" : status === STATUS.RUNNING ? "…" : status === STATUS.STOPPED ? "■" : ""}
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
                  <span style={{ opacity: 0.5, fontSize: "0.85em" }}>{lineNumber}</span>
                </div>
                {stepFailure && (
                  // Same click/right-click behaviour as the row above it, so
                  // the error reads as part of its step rather than as loose
                  // text that swallows a click. Not nested INSIDE `tb-step`:
                  // that is a flex row, and a multi-line block would become a
                  // fourth column instead of sitting under the step.
                  <div
                    onClick={(e) => handleStepClick(lineNumber, e)}
                    onContextMenu={(e) => {
                      if (!webviewSelection.has(lineNumber)) {
                        setWebviewSelection(new Set([lineNumber]));
                        selectionAnchorRef.current = lineNumber;
                      }
                      handleStepContextMenu(e, lineNumber, hasBreakpoint, Boolean(status));
                    }}
                    title={`Reveal line ${lineNumber}`}
                    style={{
                      padding: "1px 24px 6px 37px",
                      cursor: "pointer",
                      fontFamily: "var(--vscode-editor-font-family, monospace)",
                      fontSize: "0.85em",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      maxHeight: 120,
                      overflowY: "auto",
                      background: webviewSelection.has(lineNumber)
                        ? "var(--vscode-list-inactiveSelectionBackground, transparent)"
                        : "transparent",
                      color:
                        status === STATUS.FAIL
                          ? "var(--vscode-testing-iconFailed, #f87171)"
                          : "var(--vscode-editorWarning-foreground, #fbbf24)",
                    }}
                  >
                    {stepFailure}
                  </div>
                )}
                {stepError && (
                  <div style={{ padding: "0 8px 6px 36px" }}>
                    <ErrorPanel error={stepError} />
                  </div>
                )}
              </React.Fragment>
            );
          })}
          </div>
          )}
        </div>

        <div style={{
          // Output yields before Steps: flexShrink lets it give back height on
          // a short panel (down to OUTPUT_MIN_HEIGHT — about its header), and it
          // only grows to fill space when Steps is collapsed.
          flexShrink: 1,
          flexGrow: stepsCollapsed && !logCollapsed ? 1 : 0,
          minHeight: logCollapsed ? undefined : OUTPUT_MIN_HEIGHT,
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
      {rowMenu && <RowContextMenu menu={rowMenu} onClose={closeRowMenu} />}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<TestBenchRunner />);
}
