import * as vscode from 'vscode';
import {
  extractSteps,
  type HostToWebviewMsg,
  type WebviewToHostMsg,
} from 'ai-ui-automation-runner-core';
import { ActiveFileTracker } from './active-file-tracker.js';
import { DecorationManager } from './decorations.js';
import { TestBenchRunnerView } from './runner-view.js';
import { RunController, defaultApiClientFactory } from './run-controller.js';
import type { ApiClientFactory } from './run-controller.js';
import { registerCommands } from './commands/index.js';
import { disposeOutputChannel, getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';
import { workspaceFolderFor } from './workspace.js';
import { TestDiscovery } from './test-discovery.js';
import { TestBenchTestController } from './test-controller.js';

const FIRST_ACTIVATION_KEY = 'testbench.shownActivationToast';

/**
 * Registry mapping document URI → RunController. Lazy: a controller is
 * created the first time the user runs against a file, then reused.
 */
class RunControllerRegistry implements vscode.Disposable {
  private readonly controllers = new Map<string, RunController>();
  private clientFactory: ApiClientFactory = defaultApiClientFactory;
  /** Mirror of the last value pushed to the `testbench.running` context
   *  key. VS Code doesn't expose context keys for read, so this is the
   *  only handle the integration suite has on toolbar visibility. */
  private lastRunningContextValue = false;

  /** Test-only readback of the `testbench.running` context key. */
  get runningContextValue(): boolean {
    return this.lastRunningContextValue;
  }

  constructor(
    private readonly view: TestBenchRunnerView,
    private readonly tracker: ActiveFileTracker,
  ) {}

  /** Test-only: swap the ApiClient factory. Existing controllers are
   *  discarded so the next run picks up the new factory. */
  setApiClientFactory(factory: ApiClientFactory): void {
    this.clientFactory = factory;
    for (const controller of this.controllers.values()) controller.stop();
    this.controllers.clear();
  }

  /**
   * Get-or-create the controller for a document. Returns undefined if the
   * document isn't inside a workspace folder (TB030 case).
   */
  get(document: vscode.TextDocument): RunController | undefined {
    const key = document.uri.toString();
    const existing = this.controllers.get(key);
    if (existing) return existing;
    const folder = workspaceFolderFor(document.uri);
    if (!folder) return undefined;

    const post = this.makePostCallback(document.uri);
    const controller = new RunController(document, folder, post, this.clientFactory);
    this.controllers.set(key, controller);
    return controller;
  }

  /** The controller for the currently-active TestBench file, if any. */
  active(): RunController | undefined {
    const editor = this.tracker.activeEditor;
    if (!editor || !this.tracker.isActiveTestFile) return undefined;
    return this.get(editor.document);
  }

  /** True if any controller is currently running. */
  anyRunning(): boolean {
    for (const c of this.controllers.values()) {
      if (c.isRunning) return true;
    }
    return false;
  }

  /**
   * Build the `post` callback for a controller. Each event flows to:
   *  1. the sidebar webview (UI updates)
   *  2. the ActiveFileTracker (status icons + error decorations on the editor)
   *  3. the `testbench.running` context key (for menu visibility)
   */
  private makePostCallback(uri: vscode.Uri): (msg: HostToWebviewMsg) => void {
    return (msg: HostToWebviewMsg) => {
      this.applyToTracker(uri, msg);
      this.view.post(msg);
    };
  }

  private applyToTracker(uri: vscode.Uri, msg: HostToWebviewMsg): void {
    if (msg.type === 'runEvent') {
      const ev = msg.event;
      switch (ev.type) {
        case 'step:start':
          this.tracker.setStatus(uri, ev.line, 'running');
          break;
        case 'step:pass':
          this.tracker.setStatus(uri, ev.line, 'pass');
          break;
        case 'step:fail':
          this.tracker.setStatus(uri, ev.line, 'fail');
          break;
        case 'done':
          this.refreshRunningContext();
          break;
      }
      return;
    }
    if (msg.type === 'runError') {
      this.lastRunError = {
        code: msg.payload.code,
        diagnosis: msg.payload.diagnosis,
        ...(msg.payload.fix !== undefined && { fix: msg.payload.fix }),
      };
      this.refreshRunningContext();
      return;
    }
    if (msg.type === 'breakpointStop') {
      this.tracker.setBreakpointStop(uri, msg.line);
    }
  }

  /** Refresh the `testbench.running` context key from current state. Used
   *  on event-driven boundaries (e.g. `done` arrived and `this.active` is
   *  still set inside the controller's try-block) where anyRunning() is
   *  the authoritative answer. */
  refreshRunningContext(): void {
    this.setRunningContext(this.anyRunning());
  }

  /**
   * Tell the webview a run started/stopped, and pin the
   * `testbench.running` context key to the same value.
   *
   * IMPORTANT: this trusts the caller's intent — it does NOT poll
   * `anyRunning()`. Polling fails on the leading edge: the command
   * handler calls `notifyRunning(true)` synchronously, *before*
   * `controller.runLines()` sets `controller.active`. If we polled,
   * we'd read the stale "no active run" state and set the context key
   * to false, which hides Pause/Stop in the editor title bar until the
   * first run event drives a refresh — exactly the "Pause disappeared
   * after Resume" symptom.
   *
   * For `running=false` we still trust the caller. Each command handler
   * pairs `notifyRunning(true)` with a `.finally(notifyRunning(false))`,
   * so the second call always corresponds to that run's exit.
   */
  notifyRunning(running: boolean): void {
    this.notifyRunningHistory.push(running);
    this.view.post({ type: 'running', running });
    this.setRunningContext(running);
  }

  private setRunningContext(value: boolean): void {
    this.lastRunningContextValue = value;
    void vscode.commands.executeCommand('setContext', 'testbench.running', value);
  }

  /** Test-only: every value passed through notifyRunning, in order. */
  readonly notifyRunningHistory: boolean[] = [];
  /** Test-only: most recent runError payload posted by any controller. */
  lastRunError: { code: string; diagnosis: string; fix?: string } | null = null;

  dispose(): void {
    for (const c of this.controllers.values()) c.stop();
    this.controllers.clear();
  }
}

/** Test-only handles surfaced via `extension.exports.__testHooks` so the
 *  integration suite can drive the state machine with a fake ApiClient
 *  without spinning up the real Sessions API server. Production code must
 *  not rely on these. */
export interface TestBenchTestHooks {
  tracker: ActiveFileTracker;
  setApiClientFactory: (factory: ApiClientFactory) => void;
  isRunning: () => boolean;
  /** Last value mirrored to the `testbench.running` context key. The
   *  editor title bar's Pause/Stop visibility hinges on this — VS Code
   *  doesn't let us read context keys, so the registry tracks them. */
  runningContextValue: () => boolean;
  /** Diagnostic: does registry.active() resolve to a controller right now? */
  activeControllerResolves: () => boolean;
  /** Diagnostic: every value notifyRunning has seen in this session. */
  notifyRunningHistory: () => boolean[];
  /** Diagnostic: last runError payload, or null if none. */
  lastRunError: () => { code: string; diagnosis: string; fix?: string } | null;
  /** Drive the webview→host message path directly so tests can verify it
   *  mirrors the registered command behavior (markRunningStopped, etc).
   *  Guards the two-handler regression class. */
  dispatchWebviewMessage: (msg: WebviewToHostMsg) => Promise<void>;
  /** Test runner discovery cache — eligible tests in the workspace. */
  discoveredTests: () => Array<{ uri: string; title: string | null; tags: string[] }>;
  /** Wait for the initial discovery scan to complete. */
  discoveryReady: () => Promise<void>;
  /** Force a full re-scan of the workspace; useful for tests that write
   *  fixture files synchronously and can't wait on the watcher. */
  discoveryRefresh: () => Promise<void>;
  /** Result counts of the most recent batch run, or null if none yet. */
  lastBatchRun: () => { passed: number; failed: number; skipped: number } | null;
  /** Test-only: run a batch identified by file URIs. Returns the counts
   *  once the TestRun has ended. */
  runBatchByUris: (uris: vscode.Uri[]) => Promise<{ passed: number; failed: number; skipped: number }>;
  /** Test-only readback of every TestItem.id currently in
   *  `vscode.TestController.items`. Source of truth for what the Test
   *  Explorer would render. */
  controllerItemIds: () => string[];
  /** Test-only: invoke the TestController's `resolveHandler` with
   *  `undefined` (root-resolve), the same call VS Code makes to populate
   *  the test tree's top level on first render. */
  triggerInitialResolve: () => Promise<void>;
  /** Test-only readback of a single TestItem's rendered metadata
   *  (label / description / tag ids). */
  testItemMetadata: (uri: vscode.Uri) => { label: string; description: string; tags: string[] } | undefined;
  /** Best-effort: wait until tracker.snapshot() satisfies the predicate. */
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
}

export interface TestBenchExports {
  __testHooks?: TestBenchTestHooks;
}

export function activate(context: vscode.ExtensionContext): TestBenchExports {
  const out = getOutputChannel();
  const ts = () => new Date().toISOString().slice(11, 23);
  out.appendLine(`[${ts()}] TestBench activate() — version=${context.extension.packageJSON.version}`);

  const tracker = new ActiveFileTracker();
  const decorations = new DecorationManager(context, tracker);
  const view = new TestBenchRunnerView(context, tracker);
  const registry = new RunControllerRegistry(view, tracker);
  const discovery = new TestDiscovery();
  const testController = new TestBenchTestController(discovery, registry, {
    // Forward batch progress to the sidebar webview banner. `null` clears
    // the banner; non-null { running, total } shows it. The test
    // controller never directly references the webview view — this sink
    // is the only coupling.
    set: (state) => {
      view.post({ type: 'batchBanner', state });
    },
  });

  // Wire webview → host messages.
  view.setMessageHandler((msg) => handleWebviewMessage(msg, registry, tracker));

  context.subscriptions.push(
    tracker,
    decorations,
    registry,
    discovery,
    testController,
    vscode.window.registerWebviewViewProvider(TestBenchRunnerView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    new EnvSelector(),
    ...registerCommands(registry, tracker),
  );

  out.appendLine(`[${ts()}] activation complete — ${context.subscriptions.length} disposables`);

  if (!context.globalState.get<boolean>(FIRST_ACTIVATION_KEY)) {
    void context.globalState.update(FIRST_ACTIVATION_KEY, true);
    void vscode.window
      .showInformationMessage(
        'TestBench is active. Open a Markdown file with a "## Steps" heading and use the TestBench sidebar to run it.',
        'Show Run Log',
      )
      .then((choice) => {
        if (choice === 'Show Run Log') void vscode.commands.executeCommand('testbench.showRunLog');
      });
  }

  return {
    __testHooks: {
      tracker,
      setApiClientFactory: (factory) => registry.setApiClientFactory(factory),
      isRunning: () => registry.anyRunning(),
      runningContextValue: () => registry.runningContextValue,
      activeControllerResolves: () => registry.active() !== undefined,
      notifyRunningHistory: () => [...registry.notifyRunningHistory],
      lastRunError: () => registry.lastRunError,
      dispatchWebviewMessage: (msg) => handleWebviewMessage(msg, registry, tracker),
      discoveredTests: () =>
        discovery.eligibleTests().map((t) => ({
          uri: t.uri.toString(),
          title: t.title,
          tags: t.frontmatter.tags ?? [],
        })),
      discoveryReady: () => discovery.ready(),
      discoveryRefresh: () => discovery.refresh(),
      lastBatchRun: () => testController.lastRun,
      runBatchByUris: (uris) => testController.runByUris(uris),
      controllerItemIds: () => testController.controllerItemIds(),
      triggerInitialResolve: () => testController.triggerInitialResolve(),
      testItemMetadata: (uri) => testController.itemMetadata(uri),
      waitFor: async (predicate, timeoutMs = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('waitFor: predicate did not become true within ' + timeoutMs + 'ms');
      },
    },
  };
}

async function handleWebviewMessage(
  msg: WebviewToHostMsg,
  registry: RunControllerRegistry,
  tracker: ActiveFileTracker,
): Promise<void> {
  switch (msg.type) {
    case 'ready':
      // Tracker.onChange already pushed a snapshot; nothing more to do.
      return;
    case 'run': {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      void controller
        .runLines(msg.lines, { breakpoints })
        .finally(() => registry.notifyRunning(false));
      return;
    }
    case 'runAll': {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      void controller
        .runLines([], { breakpoints })
        .finally(() => registry.notifyRunning(false));
      return;
    }
    case 'stop': {
      const controller = registry.active();
      controller?.stop();
      // Also clear any breakpoint pause so the user fully exits the run.
      // Without this, hitting Stop while paused at a breakpoint would leave
      // the yellow ▶ marker stuck and the Resume button still active.
      const editor = tracker.activeEditor;
      if (editor && tracker.isActiveTestFile) {
        tracker.setBreakpointStop(editor.document.uri, null);
        tracker.markRunningStopped(editor.document.uri);
      }
      registry.notifyRunning(false);
      return;
    }
    case 'pause': {
      const controller = registry.active();
      controller?.pause();
      // The run-controller's abort handler will publish breakpointStop +
      // done(aborted) once the stream actually unwinds. We don't flip
      // running=false here — the .finally on the running runLines() does.
      return;
    }
    case 'resume': {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const state = tracker.state(controller.document.uri);
      if (state.breakpointStop == null) return;
      const startLine = state.breakpointStop;
      // Clear the pause indicator before kicking off — the run will set a
      // new one if it hits another breakpoint.
      tracker.setBreakpointStop(controller.document.uri, null);
      registry.notifyRunning(true);
      // Resume continues from startLine through the rest of the document
      // (or until the next breakpoint). Passing `[startLine]` alone would
      // collapse through resolveRunLines to a single-step run — useful if
      // we wanted "step over" semantics, but Resume's contract is to
      // *continue execution*, matching how F5 works in a debugger.
      const resumeLines = extractSteps(controller.document.getText())
        .map((s) => s.line)
        .filter((line) => line >= startLine);
      void controller
        .runLines(resumeLines, {
          breakpoints: tracker.breakpoints(controller.document.uri),
          // First step is the pause line itself; let it through.
          skipBreakpointAtStart: true,
        })
        .finally(() => registry.notifyRunning(false));
      return;
    }
    case 'restartSession': {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      await controller.closeSession();
      vscode.window.setStatusBarMessage(
        'TestBench: session closed — next F5 starts a fresh browser',
        3000,
      );
      return;
    }
    case 'promptResponse': {
      const controller = registry.active();
      controller?.resolvePrompt(msg.text);
      return;
    }
    case 'promptCancel': {
      const controller = registry.active();
      controller?.cancelPrompt();
      return;
    }
    case 'revealLine': {
      const editor = tracker.activeEditor;
      if (!editor) return;
      const line = Math.max(0, msg.line - 1);
      const range = new vscode.Range(line, 0, line, 0);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    case 'toggleBreakpoint': {
      const editor = tracker.activeEditor;
      if (!editor || !tracker.isActiveTestFile) return;
      tracker.toggleBreakpoint(editor.document.uri, msg.line);
      return;
    }
    case 'clearStatus': {
      const editor = tracker.activeEditor;
      if (!editor || !tracker.isActiveTestFile) return;
      tracker.clearStatus(editor.document.uri, msg.line);
      return;
    }
    case 'focusTestResults': {
      // Triggered by the batch-run banner's "Open Test Results" link.
      void vscode.commands.executeCommand('workbench.panel.testResults.focus');
      return;
    }
  }
}

function notifyNoActive(): void {
  vscode.window.setStatusBarMessage(
    'TestBench: open a Markdown file with a "## Steps" heading first',
    2500,
  );
}

export function deactivate(): void {
  disposeOutputChannel();
}
