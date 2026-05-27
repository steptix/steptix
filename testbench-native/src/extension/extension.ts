import * as vscode from 'vscode';
import {
  type HostToWebviewMsg,
  type WebviewToHostMsg,
} from 'ai-ui-automation-runner-core';
import { ActiveFileTracker } from './active-file-tracker.js';
import { DecorationManager } from './decorations.js';
import { TestBenchRunnerView } from './runner-view.js';
import { RunController, defaultApiClientFactory } from './run-controller.js';
import type { ApiClientFactory, SkillDebugContext } from './run-controller.js';
import { registerCommands } from './commands/index.js';
import { disposeOutputChannel, getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';
import { workspaceFolderFor } from './workspace.js';
import { TestDiscovery } from './test-discovery.js';
import { TestBenchTestController } from './test-controller.js';
import { InvocationDefinitionProvider } from './definition-provider.js';
import { CallStackTreeProvider } from './call-stack-view.js';
import { VariablesTreeProvider } from './variables-view.js';

const FIRST_ACTIVATION_KEY = 'testbench-native.shownActivationToast';

/**
 * Registry mapping document URI → RunController. Lazy: a controller is
 * created the first time the user runs against a file, then reused.
 */
class RunControllerRegistry implements vscode.Disposable {
  private readonly controllers = new Map<string, RunController>();
  private clientFactory: ApiClientFactory = defaultApiClientFactory;
  /** Mirror of the last value pushed to the `testbench-native.running` context
   *  key. VS Code doesn't expose context keys for read, so this is the
   *  only handle the integration suite has on toolbar visibility. */
  private lastRunningContextValue = false;

  /** Fires whenever any controller's frame stack changes. The Call Stack
   *  view re-renders against this — driving its tree off a single registry
   *  event keeps the view decoupled from individual controllers (which
   *  come and go as documents open). */
  private readonly anyFrameStackEmitter = new vscode.EventEmitter<void>();
  readonly onAnyFrameStackChange = this.anyFrameStackEmitter.event;
  /** Fires whenever any controller's scope-per-frame map updates. Same
   *  bridging pattern as `onAnyFrameStackChange`. */
  private readonly anyScopeEmitter = new vscode.EventEmitter<void>();
  readonly onAnyScopeChange = this.anyScopeEmitter.event;
  /** Per-controller subscription handle so we don't leak listeners when a
   *  controller is removed. */
  private readonly frameSubs = new Map<string, vscode.Disposable>();
  private readonly scopeSubs = new Map<string, vscode.Disposable>();
  /** Per-controller record of where a step:awaiting yellow ▶ is currently
   *  painted. Set on step:awaiting, cleared on the next step:start (or on
   *  done). Lets us drop the marker even when it lives on a different URI
   *  from the controller's own document (skill files). */
  private readonly stepPausedAt = new Map<
    string,
    { uri: vscode.Uri; line: number }
  >();

  /** Test-only readback of the `testbench-native.running` context key. */
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
    const controller = new RunController(
      document,
      folder,
      post,
      this.clientFactory,
      // Re-evaluated on every request so a breakpoint added mid-session
      // (between batches) reaches the server next time. Filters to .md
      // files; the server skips entries matching testFilePath since the
      // client trims those before sending.
      () => this.tracker.allMarkdownBreakpoints(),
      // At run start, controller asks us to clear statuses on the test
      // file + every skill file the previous run descended into. This
      // gives a "re-run = fresh slate" UX: the new run repaints as it
      // goes, and lines/files the new run doesn't touch correctly stay
      // blank instead of showing stale ✓s from the prior run.
      (uris) => {
        for (const uri of uris) this.tracker.clearStatuses(uri);
      },
      // Fresh-run hook: a full run from the top drops this test's skill-debug
      // context (the banner + "run on stopped session" affordance go stale).
      () => this.clearSkillDebugIfOwnedBy(document.uri.toString()),
    );
    this.controllers.set(key, controller);
    // Re-fire the controller's frame-stack changes through the registry
    // so a single view subscriber catches every controller's transitions.
    this.frameSubs.set(
      key,
      controller.onFrameStackChange(() => this.anyFrameStackEmitter.fire()),
    );
    this.scopeSubs.set(
      key,
      controller.onScopeChange(() => this.anyScopeEmitter.fire()),
    );
    return controller;
  }

  /** The currently-running controller, if any. The Call Stack view reads
   *  the active frame stack from this. Only one run can be in flight at
   *  a time today; if that ever changes the view will need to disambiguate. */
  runningController(): RunController | undefined {
    for (const c of this.controllers.values()) {
      if (c.isRunning) return c;
    }
    return undefined;
  }

  /** Phase 3.1.b — true when this controller has an outstanding
   *  step:awaiting (the SSE stream is open and the server is blocked on
   *  pendingRunControl). Used by dispatchStep to distinguish step-paused
   *  from running-but-mid-step, which need different diagnostics. */
  isStepPaused(controllerUri: vscode.Uri): boolean {
    return this.stepPausedAt.has(controllerUri.toString());
  }

  /** Where a step:awaiting yellow ▶ is currently parked for this
   *  controller — `null` if no pause is in flight. Used by Phase 5
   *  dispatch to decide whether F11 should request a tool-debugger
   *  pause (when the parked line is a `[tool: ...]` invocation). */
  stepPausedEntry(controllerUri: vscode.Uri): { uri: vscode.Uri; line: number } | null {
    return this.stepPausedAt.get(controllerUri.toString()) ?? null;
  }

  /** Last-known webview-side runtimeVariables map, posted by the
   *  webview on every change via `webviewState` messages. Test hook
   *  reads this to verify the webview's Variables panel actually
   *  sees the data flowing through `frame:scope` (which is rendered
   *  by `collectVariables` in the React component — invisible to
   *  the host except via this readback channel). */
  private lastWebviewRuntimeVariables: Record<string, string> = {};
  private webviewStateUpdateCount = 0;

  recordWebviewRuntimeVariables(runtimeVariables: Record<string, string>): void {
    this.lastWebviewRuntimeVariables = { ...runtimeVariables };
    this.webviewStateUpdateCount += 1;
  }

  getWebviewRuntimeVariables(): Record<string, string> {
    return { ...this.lastWebviewRuntimeVariables };
  }

  /** Count of `webviewState` messages received from the webview since
   *  activation. Used by tests to confirm the webview is actually
   *  mounted and posting state, not just returning the default {}. */
  getWebviewStateUpdateCount(): number {
    return this.webviewStateUpdateCount;
  }

  /** Phase 3.1.a — clear every step-paused yellow ▶ marker across all
   *  tracked controllers. Called on Stop so a step:awaiting on a skill
   *  file's URI doesn't linger after the user has cancelled the run.
   *  (The active-editor-only setBreakpointStop(null) in the Stop
   *  handlers misses skill-file markers.) */
  clearAllStepPausedMarkers(): void {
    for (const [, entry] of this.stepPausedAt) {
      this.tracker.setBreakpointStop(entry.uri, null);
    }
    this.stepPausedAt.clear();
    void vscode.commands.executeCommand(
      'setContext',
      'testbench-native.stepPaused',
      false,
    );
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

  /** The controller for a specific test document URI string, if one exists.
   *  Used to route the re-run action to the test that owns the displayed
   *  failure (by the `testUri` echoed from the panel). */
  controllerForUri(uri: string): RunController | undefined {
    return this.controllers.get(uri);
  }

  /** The controller holding a parked skill-step failure, if any. Fallback for
   *  the re-run routing when the test URI doesn't resolve a controller. At most
   *  one is parked at a time in practice. */
  controllerWithSkillFailure(): RunController | undefined {
    for (const c of this.controllers.values()) {
      if (c.lastSkillFailure) return c;
    }
    return undefined;
  }

  /** Single active "debug a skill after Stop" context — the stopped test whose
   *  skill the user is iterating on (see stories/specs/skill-debug-after-stop.md).
   *  At most one at a time; the latest Stop-in-a-skill replaces the previous.
   *  Drives the "Run selected skill steps on stopped session" command and the
   *  status-bar banner. */
  private _skillDebug: SkillDebugContext | null = null;
  /** Wired by activate() to refresh the status-bar banner when this changes. */
  onSkillDebugChange?: () => void;

  /** The current skill-debug context, or null. */
  get skillDebug(): SkillDebugContext | null {
    return this._skillDebug;
  }

  /** Set/replace the skill-debug context (latest Stop wins). */
  setSkillDebug(ctx: SkillDebugContext): void {
    this._skillDebug = ctx;
    this.onSkillDebugChange?.();
  }

  /** Clear the context unconditionally (Close Session; dead-session pre-flight). */
  clearSkillDebug(): void {
    if (!this._skillDebug) return;
    this._skillDebug = null;
    this.onSkillDebugChange?.();
  }

  /** Clear it only if owned by `testUri` — used when that test starts a fresh run. */
  clearSkillDebugIfOwnedBy(testUri: string): void {
    if (this._skillDebug?.testUri.toString() === testUri) this.clearSkillDebug();
  }

  /**
   * Build the `post` callback for a controller. Each event flows to:
   *  1. the sidebar webview (UI updates)
   *  2. the ActiveFileTracker (status icons + error decorations on the editor)
   *  3. the `testbench-native.running` context key (for menu visibility)
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
        case 'step:start': {
          // A step:start means we've advanced past whatever step:awaiting
          // we were paused on. Clear that marker (and its context key) so
          // the yellow ▶ doesn't linger while the new step is running.
          this.clearStepPaused(uri);
          const target = this.targetUriFor(uri, ev.frame);
          this.tracker.setStatus(target, ev.line, 'running');
          if (ev.frame) this.maybeRevealFrame(uri, ev.frame, ev.line);
          break;
        }
        case 'step:awaiting': {
          // The server has paused between steps and is waiting on a
          // run-control. Paint the yellow ▶ on the next step's
          // line+frame so the user sees where execution will resume.
          const target = this.targetUriFor(uri, ev.frame);
          this.tracker.setBreakpointStop(target, ev.line);
          this.stepPausedAt.set(uri.toString(), { uri: target, line: ev.line });
          void vscode.commands.executeCommand(
            'setContext',
            'testbench-native.stepPaused',
            true,
          );
          // Reveal the frame's file the same way a step:start would, so
          // the user can SEE the line about to execute (e.g. inside a
          // skill body) without having to open it manually.
          if (ev.frame) this.maybeRevealFrame(uri, ev.frame, ev.line);
          break;
        }
        case 'step:pass': {
          const target = this.targetUriFor(uri, ev.frame);
          // The server marks a step:pass with `fromCache: true` when every
          // AI turn for that step was served from StepCache (no AI call
          // happened). The gutter painter renders that with a ⚡ glyph and
          // the run-log marks the line `(cached)`. Absent / false flows
          // through the standard ✓ path.
          this.tracker.setStatus(target, ev.line, ev.fromCache ? 'pass-cached' : 'pass');
          break;
        }
        case 'step:fail': {
          const target = this.targetUriFor(uri, ev.frame);
          this.tracker.setStatus(target, ev.line, 'fail');
          // Propagate the failure to the originating test-file `[skill:]` line
          // so the user sees the red icon on the line they actually authored,
          // not just on the skill's body line they may not even have open.
          let root: { testUri: vscode.Uri; testLine: number } | null = null;
          if (ev.frame) {
            const controller = this.controllers.get(uri.toString());
            root = controller?.markFrameFailed(ev.frame.id) ?? null;
            if (root) this.tracker.setStatus(root.testUri, root.testLine, 'fail');
            // Park the failure context so the Variables panel can offer
            // "re-run this skill step with its variables". No-ops on the
            // controller for nested frames (v1 is top-level skills only), in
            // which case the payload is null and the panel offers nothing.
            controller?.recordSkillFailure(ev.frame, ev.line);
            this.view.post({
              type: 'skillRerunAvailable',
              failure: controller?.skillRerunPayload() ?? null,
            });
          }
          // Paused-on-error: park a breakpointStop on the failed step so the
          // user can edit the line and hit Continue to retry against the
          // still-alive server session. Routed to the same spot the fail
          // icon went — the test-file [skill: ...] line for in-skill
          // failures, otherwise the failed step's own line. The existing
          // run-start clear wipes it before any fresh run, and Stop clears
          // it explicitly. If the user does nothing, it stays parked but
          // is harmless (the run is idle).
          if (root) {
            this.tracker.setBreakpointStop(root.testUri, root.testLine);
          } else {
            this.tracker.setBreakpointStop(uri, ev.line);
          }
          break;
        }
        case 'frame:push': {
          const controller = this.controllers.get(uri.toString());
          controller?.handleFramePush(ev.frame);
          // First descent into a skill file this run: wipe any statuses a
          // PREVIOUS run left on it. Skill state is keyed only by the skill
          // file's URI, shared across every test, and the run-start clear
          // only wipes skills THIS controller descended into before. So
          // Test B stepping into a skill Test A had fully passed would
          // otherwise show B's ✗ on the failing step plus A's stale ✓ on the
          // steps B never reaches. Clearing on descent makes a shared skill
          // always reflect the most recent run. Suppressed for continuations
          // (shouldClearDescentStatuses returns false) so Resume keeps its
          // pre-pause marks.
          const frameUri = vscode.Uri.file(ev.frame.uri);
          if (
            controller &&
            frameUri.toString() !== uri.toString() &&
            controller.shouldClearDescentStatuses(frameUri.toString())
          ) {
            this.tracker.clearStatuses(frameUri);
          }
          // Aggregate test-file status: a top-level skill (parentId === null)
          // is the one anchored on the test's `[skill:]` line. Mark it
          // `running` so the user sees activity on that line even though
          // the step events for the descent will land on the skill file.
          if (ev.frame.parentId === null && ev.frame.line > 0) {
            this.tracker.setStatus(uri, ev.frame.line, 'running');
          }
          break;
        }
        case 'frame:pop': {
          const controller = this.controllers.get(uri.toString());
          const result = controller?.handleFramePop(ev.frameId);
          if (result?.root) {
            // Only overwrite the aggregate status with `pass` when the
            // descent had no failures — failures already painted `fail`
            // synchronously in the step:fail branch and we don't want to
            // step on them here.
            if (!result.failed) {
              this.tracker.setStatus(result.root.testUri, result.root.testLine, 'pass');
            }
          }
          break;
        }
        case 'frame:scope': {
          // Phase 4 — pipe the scope payload into the controller's
          // per-frame map. The Variables view subscribes via the
          // registry's onAnyScopeChange bridge.
          const controller = this.controllers.get(uri.toString());
          controller?.handleFrameScope(ev.frameId, ev.scope);
          break;
        }
        case 'tool:awaiting-debugger': {
          // Phase 5 — tool step-into. The server is parked at its
          // cooperative `debugger;` waiting for us to attach VS Code's
          // Node debugger. Hand off to the in-extension flow that
          // resolves the inspector port from settings, calls
          // `vscode.debug.startDebugging` with a Node attach config, and
          // — once attached — POSTs the ack so the server can proceed.
          const controller = this.controllers.get(uri.toString());
          if (!controller) break;
          void this.handleToolAwaitingDebugger(controller, ev);
          break;
        }
        case 'done':
          this.refreshRunningContext();
          // The per-controller revealedFrameUris is cleared by
          // resetFrameState() at the START of the next run, so we don't
          // need to wipe anything here — the auto-reveal gate stays
          // honored until then.
          //
          // Phase 3: any step-paused marker dies with the run. The
          // yellow ▶ would otherwise be left behind if the user clicks
          // Stop while step-paused.
          this.clearStepPaused(uri);
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

  /**
   * Resolve the URI a step event's status should be written against. When
   * the server supplies a `frame`, the step lives in that frame's source
   * file (a skill `.md` for skill-body steps; the test file for inline
   * steps). Otherwise the legacy assumption holds — everything lives in
   * the controller's own document.
   */
  private targetUriFor(testUri: vscode.Uri, frame: import('ai-ui-automation-runner-core').FrameInfo | undefined): vscode.Uri {
    if (!frame) return testUri;
    return vscode.Uri.file(frame.uri);
  }

  /**
   * Drop the step-paused yellow ▶ for this controller (if any). Called
   * when execution advances past a step:awaiting (next step:start) and
   * when the run completes (done). The breakpointStop marker on the
   * tracker is the same field the breakpoint-pause UI uses, so we wipe
   * just the URI we set it on — leaving any unrelated breakpoint pause
   * on other URIs alone.
   */
  private clearStepPaused(controllerUri: vscode.Uri): void {
    const entry = this.stepPausedAt.get(controllerUri.toString());
    if (!entry) return;
    this.stepPausedAt.delete(controllerUri.toString());
    this.tracker.setBreakpointStop(entry.uri, null);
    void vscode.commands.executeCommand(
      'setContext',
      'testbench-native.stepPaused',
      false,
    );
  }

  /**
   * On the first `step:start` inside a non-test frame, open the frame's
   * file in a non-preview tab next to the user's current editor. Without
   * this the user runs a test and "nothing happens" while the descent is
   * executing — the test file's line shows `running` aggregate but the
   * actual stepping is invisible. The reveal is best-effort and uses
   * `preserveFocus: true` so it never steals keyboard focus.
   *
   * The first-time-per-run gate lives on the controller (not on the
   * registry) so two controllers running back-to-back can both reveal
   * the same skill — the previous controller's reveal set doesn't bleed
   * into the next run.
   */
  private maybeRevealFrame(
    controllerUri: vscode.Uri,
    frame: import('ai-ui-automation-runner-core').FrameInfo,
    line: number,
  ): void {
    if (frame.kind !== 'skill') return;
    const controller = this.controllers.get(controllerUri.toString());
    if (!controller?.shouldRevealFrameUri(frame.uri)) return;
    const target = vscode.Uri.file(frame.uri);
    const revealLine = Math.max(0, line - 1);
    void vscode.window.showTextDocument(target, {
      preserveFocus: true,
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
      selection: new vscode.Range(revealLine, 0, revealLine, 0),
    });
  }

  /**
   * Phase 5 — handle a `tool:awaiting-debugger` event. The server is
   * blocked at its cooperative pause point waiting for VS Code's Node
   * debugger to attach. Steps:
   *
   *  1. Local-server check: tool step-into requires a Node inspector
   *     reachable from this machine. Fail with a status-bar diagnostic
   *     when the run is against a remote `SERVER_URL`.
   *  2. Resolve the inspector port + host from settings (defaults
   *     9229 / 127.0.0.1). If an attach is already in flight from a
   *     previous tool in the same session we just reuse it.
   *  3. `vscode.debug.startDebugging` with a Node attach config. When
   *     the user already has a Node debug session attached (e.g. they
   *     launched the server from VS Code's Run panel) startDebugging is
   *     a no-op and we proceed.
   *  4. Ack the server, which then hits `debugger;` and the inspector
   *     traps execution inside the tool's `.ts` source.
   *
   * Errors at any step fall back to a "send the ack anyway" path so the
   * run isn't left hanging — the user still ends up inside the tool
   * (just without a debugger to drive it).
   */
  private async handleToolAwaitingDebugger(
    controller: RunController,
    ev: {
      type: 'tool:awaiting-debugger';
      toolName: string;
      toolFilePath?: string;
      line: number;
    },
  ): Promise<void> {
    const ackAndExit = async (note?: string): Promise<void> => {
      if (note) vscode.window.setStatusBarMessage(`TestBench: ${note}`, 3500);
      await controller.ackToolDebugger();
    };

    if (!controller.isLocalServer()) {
      await ackAndExit(
        `Tool step-into requires a local server (SERVER_URL must be 127.0.0.1) — running "${ev.toolName}" without a debugger attached`,
      );
      return;
    }

    const cfg = vscode.workspace.getConfiguration('testbench-native');
    const port = cfg.get<number>('inspectorPort', 9229);
    const host = cfg.get<string>('inspectorHost', '127.0.0.1');

    // If our pwa-node session is already attached (a previous tool
    // in this run brought it up), reuse it. Filter to `pwa-node`
    // only — a Chrome devtools (`chrome` / `pwa-chrome`) session is
    // not the inspector we want and treating it as "attached" would
    // skip the real attach call.
    const alreadyAttached = vscode.debug.activeDebugSession?.type === 'pwa-node';

    if (!alreadyAttached) {
      try {
        const folder = controller.workspaceFolder;
        const started = await vscode.debug.startDebugging(folder, {
          type: 'pwa-node',
          request: 'attach',
          name: 'TestBench: tool step-into',
          address: host,
          port,
          skipFiles: ['<node_internals>/**'],
          sourceMaps: true,
        });
        if (!started) {
          await ackAndExit(
            `Couldn't attach Node debugger on ${host}:${port}. Launch the server with --inspect=${port} to enable tool step-into.`,
          );
          return;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await ackAndExit(`Debugger attach failed (${reason})`);
        return;
      }
    }

    if (ev.toolFilePath) {
      vscode.window.setStatusBarMessage(
        `TestBench: stepping into tool "${ev.toolName}" — use the Debug toolbar`,
        4000,
      );
    }
    await controller.ackToolDebugger();
  }

  /** Refresh the `testbench-native.running` context key from current state. Used
   *  on event-driven boundaries (e.g. `done` arrived and `this.active` is
   *  still set inside the controller's try-block) where anyRunning() is
   *  the authoritative answer. */
  refreshRunningContext(): void {
    this.setRunningContext(this.anyRunning());
  }

  /**
   * Tell the webview a run started/stopped, and pin the
   * `testbench-native.running` context key to the same value.
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
    void vscode.commands.executeCommand('setContext', 'testbench-native.running', value);
  }

  /** Test-only: every value passed through notifyRunning, in order. */
  readonly notifyRunningHistory: boolean[] = [];
  /** Test-only: most recent runError payload posted by any controller. */
  lastRunError: { code: string; diagnosis: string; fix?: string } | null = null;

  dispose(): void {
    for (const c of this.controllers.values()) c.stop();
    this.controllers.clear();
    for (const sub of this.frameSubs.values()) sub.dispose();
    this.frameSubs.clear();
    for (const sub of this.scopeSubs.values()) sub.dispose();
    this.scopeSubs.clear();
    this.anyFrameStackEmitter.dispose();
    this.anyScopeEmitter.dispose();
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
  /** Last value mirrored to the `testbench-native.running` context key. The
   *  editor title bar's Pause/Stop visibility hinges on this — VS Code
   *  doesn't let us read context keys, so the registry tracks them. */
  runningContextValue: () => boolean;
  /** Diagnostic: does registry.active() resolve to a controller right now? */
  activeControllerResolves: () => boolean;
  /** Diagnostic: every value notifyRunning has seen in this session. */
  notifyRunningHistory: () => boolean[];
  /** Diagnostic: last runError payload, or null if none. */
  lastRunError: () => { code: string; diagnosis: string; fix?: string } | null;
  /** True when any controller has a parked skill-step failure (the Variables
   *  re-run panel would be offered). Used to assert a refused dead-session
   *  re-run does NOT wipe the parked failure. */
  skillFailureParked: () => boolean;
  /** True when a "debug a skill after Stop" context is parked (the "Run on
   *  stopped session" command + status-bar banner are offered). */
  skillDebugActive: () => boolean;
  /** The parked skill-debug context as plain data (or null) — lets tests assert
   *  which test/skill/frame it points at and that it clears on Close/fresh-run. */
  skillDebugContext: () =>
    | { testUri: string; testLine: number; skillUri: string; skillName: string; frameId: string }
    | null;
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
  /** Test-only: wipe all in-memory + persisted run state. The suite calls
   *  this before each test because run state now persists to a
   *  `.testbench/run-state.json` file in the (reused) workspace folder, so it
   *  would otherwise leak across cases. */
  resetRunState: () => void;
  /** Frame stack of the currently-running controller, outermost first.
   *  Empty when no run is in flight or when the run is in the test (root)
   *  frame. Used by Phase 2 tests to assert that frame events drive the
   *  call-stack model. */
  runningFrameStack: () => Array<import('ai-ui-automation-runner-core').FrameInfo>;
  /** Scope of the currently-running controller's top frame (or the test
   *  frame if no skill frames are active). Used by Phase 4 tests to
   *  assert that frame:scope events flow from server → controller →
   *  Variables view. */
  runningScope: () => Record<string, string>;
  /** Render the Variables view's children as { name, description }
   *  pairs. The `description` is what the view actually shows — for
   *  secret-named variables it's the masked form via runner-core's
   *  `maskIfSecret`. Used by Phase 4.1 tests to assert the view's
   *  render path actually applies masking (the integration tests at
   *  the `runningScope` layer alone wouldn't catch a render-side
   *  regression that bypassed maskIfSecret). */
  variablesViewItems: () => Array<{ name: string; description: string }>;
  /** Test-only: is the running controller's run currently parked on a
   *  step:awaiting (Phase 3 step-paused state)? */
  isStepPaused: () => boolean;
  /** Last-known runtimeVariables map from inside the Test Runner
   *  webview, posted on every state change via the `webviewState`
   *  message. Lets tests verify the webview-rendered Variables
   *  section actually reflects `frame:scope` events — independent of
   *  the separate Variables TreeView's `variablesViewItems()` hook. */
  webviewRuntimeVariables: () => Record<string, string>;
  /** Diagnostic counter — how many `webviewState` messages the host
   *  has received since activation. Zero means the webview never
   *  mounted (e.g. sidebar never opened); positive means it's posting. */
  webviewStateUpdateCount: () => number;
  /** Active controller's `lastReportPath` — the absolute HTML report
   *  path from the most recently completed run, or null if none.
   *  Backs the integration test that verifies the protocol's
   *  reportPath field flows controller-side. */
  lastReportPath: () => string | null;
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

  // Call Stack view — read-only tree showing the running controller's
  // frame stack. Bridged to the registry's union event so a single tree
  // provider sees every controller's transitions.
  const callStackProvider = new CallStackTreeProvider({
    currentStack: () => registry.runningController()?.frameStack ?? [],
    currentTestUri: () => registry.runningController()?.document.uri ?? null,
    onChange: registry.onAnyFrameStackChange,
  });

  // Phase 4 Variables view — flat scope of the currently-running
  // controller's top frame. Both the frame-stack and scope emitters
  // need to feed the view: scope events when the server pushes a new
  // scope, frame-stack events to flip which frame's scope is
  // "current" when the user steps in/out. Phase 4 ships a single
  // current-scope renderer; per-frame click-to-select is Phase 4.B.
  const variablesProvider = new VariablesTreeProvider({
    currentScope: () => registry.runningController()?.currentScope() ?? {},
    // The "current frame" the view is rendering is the controller's top
    // frame, or the test (root) frame when no skill is active. Used by
    // the view to (a) update its title to "Variables (skill: name)" /
    // "Variables (test)" and (b) decide whether to hide
    // skill-internal `__skillN_x` names from the rendered list.
    currentFrame: () => {
      const controller = registry.runningController();
      if (!controller) return null;
      const top = controller.frameStack[controller.frameStack.length - 1];
      if (!top) return { id: '' };
      return top.skillName !== undefined
        ? { id: top.id, skillName: top.skillName }
        : { id: top.id };
    },
  });
  const variablesScopeSub = registry.onAnyScopeChange(() =>
    variablesProvider.refresh(),
  );
  const variablesFrameSub = registry.onAnyFrameStackChange(() =>
    variablesProvider.refresh(),
  );
  // Use createTreeView (not registerTreeDataProvider) so we can drive
  // the title/description from the active frame. The provider keeps a
  // handle so refresh() can update it.
  const variablesView = vscode.window.createTreeView(
    'testbench-native.variables',
    { treeDataProvider: variablesProvider },
  );
  variablesProvider.attachView(variablesView);

  // "Detach to editor" command. Spawns a webview panel in the editor area
  // wired to the same broadcaster as the sidebar — once the panel is a
  // tab, VS Code's "Move Editor Into New Window" lets the user pop it
  // out into a floating window. The retainContextWhenHidden flag matches
  // the sidebar so the panel keeps its React state when stashed in a
  // background tab. We don't dedupe: each invocation opens a new panel
  // so power users can keep multiple visible at once.
  const openInEditor = vscode.commands.registerCommand('testbench-native.openInEditor', async () => {
    const panel = vscode.window.createWebviewPanel(
      TestBenchRunnerView.viewId,
      'TestBench Runner',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
        ],
      },
    );
    await view.attachPanel(panel);
  });

  // "Debug a skill after Stop" banner — a status-bar item naming the stopped
  // test whose skill the user is iterating on (skill-debug-after-stop.md).
  // Visible only while a skill-debug context is parked; clicking it runs the
  // selected skill steps on that stopped session. Also drives a context key
  // for the command's editor-menu `when` clause.
  const skillDebugStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0,
  );
  skillDebugStatus.command = 'testbench-native.runSkillStepsOnStoppedSession';
  const refreshSkillDebugBanner = (): void => {
    const ctx = registry.skillDebug;
    void vscode.commands.executeCommand(
      'setContext',
      'testbench-native.skillDebugActive',
      ctx !== null,
    );
    if (!ctx) {
      skillDebugStatus.hide();
      return;
    }
    const testName = ctx.testUri.path.split('/').pop() ?? 'test';
    skillDebugStatus.text = `$(debug-alt) Debugging skill ${ctx.skillName} · ${testName}`;
    skillDebugStatus.tooltip =
      `Run selected skill steps on the stopped session of ${testName} ` +
      '(no selection = the whole skill). The browser stays where the test stopped.';
    skillDebugStatus.show();
  };
  registry.onSkillDebugChange = refreshSkillDebugBanner;
  refreshSkillDebugBanner();

  context.subscriptions.push(
    skillDebugStatus,
    tracker,
    decorations,
    registry,
    discovery,
    testController,
    vscode.window.registerWebviewViewProvider(TestBenchRunnerView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider('testbench-native.callStack', callStackProvider),
    callStackProvider,
    // Variables view registered via createTreeView (above) so the view
    // handle can drive title/description per active frame. The
    // TreeView itself is disposable so it goes into subscriptions too.
    variablesView,
    variablesProvider,
    variablesScopeSub,
    variablesFrameSub,
    new EnvSelector(),
    openInEditor,
    // F12 / Ctrl+Click / Peek on `[skill: ...]` and `[tool: ...]` step
    // invocations — jumps to the skill `.md` or tool `.ts` file.
    vscode.languages.registerDefinitionProvider(
      { language: 'markdown', scheme: 'file' },
      new InvocationDefinitionProvider(),
    ),
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
        if (choice === 'Show Run Log') void vscode.commands.executeCommand('testbench-native.showRunLog');
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
      skillFailureParked: () => registry.controllerWithSkillFailure() !== undefined,
      skillDebugActive: () => registry.skillDebug !== null,
      skillDebugContext: () => {
        const c = registry.skillDebug;
        return c
          ? {
              testUri: c.testUri.toString(),
              testLine: c.testLine,
              skillUri: c.skillUri,
              skillName: c.skillName,
              frameId: c.frameId,
            }
          : null;
      },
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
      resetRunState: () => tracker.resetAllStateForTests(),
      waitFor: async (predicate, timeoutMs = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('waitFor: predicate did not become true within ' + timeoutMs + 'ms');
      },
      runningFrameStack: () => {
        const controller = registry.runningController();
        return controller ? [...controller.frameStack] : [];
      },
      isStepPaused: () => {
        const controller = registry.runningController();
        return controller ? registry.isStepPaused(controller.document.uri) : false;
      },
      webviewRuntimeVariables: () => registry.getWebviewRuntimeVariables(),
      webviewStateUpdateCount: () => registry.getWebviewStateUpdateCount(),
      runningScope: () => {
        const controller = registry.runningController();
        return controller ? { ...controller.currentScope() } : {};
      },
      variablesViewItems: () => {
        const nodes = variablesProvider.getChildren();
        return nodes.map((node) => {
          const item = variablesProvider.getTreeItem(node);
          // TreeItem.label is the string we supply; description is the
          // string the view renders after it (the value, masked when
          // secret-named).
          return {
            name: typeof item.label === 'string' ? item.label : node.name,
            description: typeof item.description === 'string' ? item.description : '',
          };
        });
      },
      lastReportPath: () => registry.active()?.lastReportPath ?? null,
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
    // The four run-lifecycle controls delegate to their commands so the
    // sidebar buttons and the editor/keybinding commands share ONE
    // implementation. Re-implementing them here is what caused the
    // "fixed in one place" drift class — e.g. the command Continue
    // preserved pass marks (isContinuation) while a hand-rolled webview
    // Resume cleared them, and the command Close Session stopped the run
    // while the webview one didn't.
    case 'stop': {
      await vscode.commands.executeCommand('testbench-native.stop');
      return;
    }
    case 'pause': {
      await vscode.commands.executeCommand('testbench-native.pause');
      return;
    }
    case 'resume': {
      await vscode.commands.executeCommand('testbench-native.continueRun');
      return;
    }
    case 'restartSession': {
      await vscode.commands.executeCommand('testbench-native.restartSession');
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
    case 'webviewState': {
      // Test-hook channel: the webview posts its current
      // `runtimeVariables` map on every state change. We cache it
      // on the registry so integration tests can read the
      // webview-visible variable state without round-tripping a
      // query. Production code path is unchanged.
      registry.recordWebviewRuntimeVariables(msg.runtimeVariables);
      return;
    }
    case 'rerunSkillStep': {
      // Route to the controller that owns the DISPLAYED failure by its test
      // URI. Critical when two tests share a skill and both have a parked
      // failure — `active()` / first-match could pick the wrong one and re-run
      // it with the other test's edits.
      const controller =
        registry.controllerForUri(msg.testUri) ?? registry.controllerWithSkillFailure();
      if (!controller || !controller.lastSkillFailure) {
        vscode.window.setStatusBarMessage('TestBench: no failed skill step to re-run', 2500);
        return;
      }
      // Probe liveness BEFORE notifyRunning / resetFrameState, so refusing a
      // dead session leaves the parked failure (and its Variables panel)
      // intact rather than wiping it on the way to an aborted run.
      const live = await controller.isRerunSessionLive();
      if (!live) {
        vscode.window.setStatusBarMessage(
          'TestBench: the browser session for this test is no longer open — re-run the whole test instead.',
          4000,
        );
        return;
      }
      registry.notifyRunning(true);
      void controller
        .rerunSkillStepFromFailure(msg.edits)
        .finally(() => registry.notifyRunning(false));
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
