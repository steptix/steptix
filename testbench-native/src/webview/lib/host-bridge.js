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
  /** Compile this test's code-behind. `fromSessionId` skips the Record phase
   *  by compiling from the run that just finished. */
  postCompile(fromSessionId) {
    post(fromSessionId ? { type: 'compile', fromSessionId } : { type: 'compile' });
  },
};
