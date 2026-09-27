/**
 * Thin bridge over the VS Code webview messaging API.
 *
 * Single instance per webview. Provides typed-ish post helpers and a
 * subscribe(handler) for inbound messages from the extension host. Falls back
 * to a no-op shim when the webview is opened standalone (e.g. for local dev
 * outside VS Code).
 */

// `acquireVsCodeApi()` may only be called once per webview. The host's HTML
// shim calls it first and stashes the handle on window.__tbVsCodeApi — pick
// that up if present, otherwise fall back to acquiring it ourselves (for
// browser-standalone dev where there's no shim).
let vscodeApi = null;
if (typeof window !== 'undefined' && window.__tbVsCodeApi) {
  vscodeApi = window.__tbVsCodeApi;
} else {
  try {
    // eslint-disable-next-line no-undef
    vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  } catch {
    vscodeApi = null;
  }
}

const subscribers = new Set();
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
  for (const fn of subscribers) {
    try {
      fn(data);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('host-bridge subscriber threw', err);
    }
  }
});

function post(message) {
  if (vscodeApi) vscodeApi.postMessage(message);
}

export const hostBridge = {
  /** True when running inside a VS Code webview. */
  get isHosted() { return vscodeApi !== null; },

  /** Subscribe to messages from the host. Returns an unsubscribe function. */
  subscribe(handler) {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
  },

  postReady() { post({ type: 'ready' }); },
  postRun(lines) { post({ type: 'run', lines }); },
  /**
   * Run a chosen set of data rows (stories/data-row-progress-and-selection.md).
   * `payload` is `{ rows?, sectionRows?, lines? }` — run-table rows, section
   * tables keyed by the section name as authored, and any selected step
   * lines. An absent key means "that axis was not narrowed", which the host
   * reads as all of it, so the panel never sends an empty list.
   */
  postRunRows(payload) { post({ type: 'runRows', ...payload }); },
  /**
   * Run every row of one table. `table` is the wire's table ref — `'run'`, or
   * `{ section: '<name as authored>' }`.
   *
   * Deliberately NOT the row numbers on screen, for the same reason
   * `postRerunFailedRows` is not: this list came from a `rows` message that
   * may be a run old, so a row added to the table since would be the one row
   * "run all" left out. The host resolves the set from the file as it is.
   */
  postRunAllRows(table) { post({ type: 'runRows', all: table }); },
  /**
   * Re-run the rows one table left red. `table` is the wire's table ref —
   * `'run'`, or `{ section: '<name as authored>' }`.
   *
   * Deliberately NOT the row numbers the panel is showing: those came from a
   * `rows` message that may be a run old, and re-running a stale number would
   * run whatever row now sits in that position. The host resolves the set
   * from the file as it is, through the same code the palette command uses.
   */
  postRerunFailedRows(table) { post({ type: 'rerunFailedRows', table }); },
  postRunAll() { post({ type: 'runAll' }); },
  postStop() { post({ type: 'stop' }); },
  postRestartSession() { post({ type: 'restartSession' }); },
  postPromptResponse(text) { post({ type: 'promptResponse', text }); },
  postPromptCancel() { post({ type: 'promptCancel' }); },
  postRevealLine(line) { post({ type: 'revealLine', line }); },
  postToggleBreakpoint(line) { post({ type: 'toggleBreakpoint', line }); },
  postResume() { post({ type: 'resume' }); },
  postPause() { post({ type: 'pause' }); },
  postFocusTestResults() { post({ type: 'focusTestResults' }); },
  postClearStatus(line) { post({ type: 'clearStatus', line }); },
  postWebviewState(runtimeVariables) {
    post({ type: 'webviewState', runtimeVariables });
  },
  /** Re-run the failed skill step (identified by its test URI) with the user's
   *  edited captured vars. */
  postRerunSkillStep(testUri, edits) { post({ type: 'rerunSkillStep', testUri, edits }); },
  /** Compile this test's code-behind — from this file's last run when it can
   *  be the recording, recording in this file's session otherwise. */
  postCompile() { post({ type: 'compile' }); },
  // Record Steps (stories/testbench-record-steps.md). Each is a command on the
  // host side; the host owns the recording's state and re-posts it whole as a
  // `recording` message, so none of these change anything here directly.
  /** ● Record — record at the active editor's cursor. */
  postRecordSteps() { post({ type: 'recordSteps' }); },
  /** Record a new test (asks for its name). */
  postRecordNewTest() { post({ type: 'recordNewTest' }); },
  postRecordStop() { post({ type: 'recordStop' }); },
  postRecordCancel() { post({ type: 'recordCancel' }); },
  /** Add check: arms pick mode, or disarms it when armed. */
  postRecordCheck() { post({ type: 'recordCheck' }); },
  /** The ✕ on an action row (`dropped: true`), or putting it back. Also a
   *  `✎ Your step` row's, by the step's id. */
  postRecordDrop(id, dropped) { post({ type: 'recordDrop', id, dropped }); },
  /** Pause (`paused: true`) or Resume (stories/testbench-record-toolbar.md). */
  postRecordPause(paused) { post({ type: 'recordPause', paused }); },
  /** The Add step box: one line is one step, several lines several steps. */
  postRecordAddStep(text) { post({ type: 'recordAddStep', text }); },
};
