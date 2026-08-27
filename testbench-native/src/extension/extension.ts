import * as vscode from 'vscode';
import {
  type HostToWebviewMsg,
  type StepFailureDetail,
  type WebviewToHostMsg,
  stepFailureDetail,
} from 'ai-ui-automation-runner-core';
import { ActiveFileTracker } from './active-file-tracker.js';
import { DecorationManager, computeStepsSummary } from './decorations.js';
// The same builder the ⚠ decoration calls, so the test hook cannot drift from
// what actually renders.
import { staleHoverMessage } from './failure-hover-core.js';
import { TestBenchRunnerView } from './runner-view.js';
import { RunController, defaultApiClientFactory } from './run-controller.js';
import type { ApiClientFactory, SkillDebugContext } from './run-controller.js';
import { registerCommands } from './commands/index.js';
import type { SkillRunTarget } from './skill-run-targets.js';
import { CodeBehindDiffs } from './codebehind-diff.js';
import { disposeOutputChannel, getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';
import { frameTargetUri, workspaceFolderFor } from './workspace.js';
import { TestDiscovery } from './test-discovery.js';
import { TestBenchTestController } from './test-controller.js';
import { InvocationDefinitionProvider } from './definition-provider.js';
import {
  SectionLinkProvider,
  SectionCompletionProvider,
  SectionDiagnostics,
} from './section-providers.js';
import { EnvDataCompletionProvider } from './env-data-completion.js';
import { EnvDataDefinitionProvider } from './env-data-definition.js';
import { CallStackTreeProvider } from './call-stack-view.js';
import { VariablesTreeProvider } from './variables-view.js';
import {
  resolveInspectorTarget,
  shouldReuseDebugSession,
  stepsFileBreakpoints,
} from './inspector-target.js';
import { ServerStatusBar } from './server-status-bar.js';
import { CompileTailSignals } from './compile-tail-signals.js';
import { registerServerCommands } from './server-commands.js';
import {
  AutoStartGuard,
  defaultHealthProbe,
  defaultServerSpawner,
  isLoopbackUrl,
  type HealthProbe,
  type ServerSpawner,
} from './server-manager.js';

const FIRST_ACTIVATION_KEY = 'testbench-native.shownActivationToast';

/**
 * Registry mapping document URI → RunController. Lazy: a controller is
 * created the first time the user runs against a file, then reused.
 */
class RunControllerRegistry implements vscode.Disposable {
  private readonly controllers = new Map<string, RunController>();
  /** Detached, HEADLESS controllers used only by batch (flask / Test Explorer)
   *  runs — see getBatchController(). Kept separate from `controllers` so a
   *  flask run never touches the editor surface, and so it can run concurrently
   *  with an interactive run of the same file. */
  private readonly batchControllers = new Map<string, RunController>();
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

  /** Health probe every controller gets. Swappable for the integration
   *  harness, which must not let a raw fetch escape to a real socket. */
  private healthProbe: HealthProbe = defaultHealthProbe;
  /** Likewise the auto-start spawn — tests substitute a spy. */
  private spawnServer: ServerSpawner = defaultServerSpawner;
  /** Test-only override of the breakpoint-pause keep-alive cadence. */
  private keepAliveIntervalMs: number | undefined;
  /** ONE guard for every controller: a failed auto-start must not be retried
   *  once per test in a Test Explorer batch. */
  private readonly autoStartGuard = new AutoStartGuard();
  /**
   * The workbench-level compile-tail signals — the status bar item and the
   * per-compile toast (stories/compile-tail-progress.md).
   *
   * Owned here rather than by a controller because it aggregates ACROSS them:
   * the compile lock is per test file, so two files can compile at once and
   * only something above the controllers can say "compiling 2".
   */
  readonly compileTailSignals = new CompileTailSignals();

  constructor(
    private readonly view: TestBenchRunnerView,
    private readonly tracker: ActiveFileTracker,
    /** `<globalStorage>/server.log` — where an auto-started server's output
     *  goes. Undefined in tests that never spawn. */
    private readonly serverLogPath?: () => string,
    /** Refreshed immediately after every run start/end, so the item never
     *  lags a deliberate action by up to a poll interval (§6). */
    private readonly serverStatusBar?: {
      refresh(): Promise<void>;
      setProbe(probe: HealthProbe): void;
    },
  ) {
    // The run-state context keys describe the ACTIVE EDITOR's document, so
    // they have to be recomputed when the active editor changes — not only
    // when a run starts or ends. Without this, switching between two tests
    // leaves whichever key the last run edge happened to set: a running test
    // shows Run (its Stop and Pause gone for the rest of its run), and a test
    // that is doing nothing shows Stop and Pause for someone else's run.
    this.trackerSub = tracker.onChange(() => {
      const now = this.activeSignature();
      if (now === this.lastActiveSignature) return;
      this.lastActiveSignature = now;
      // The strip is the ACTIVE file's, and the webview is one surface shared
      // by every controller — so when the active file changes, tell the panel
      // what THAT file's compile is doing (or that it has none). This is what
      // restores a strip mid-tail when the author switches back.
      //
      // Behind the dedupe on purpose: `onChange` fires on selection moves and
      // edits as well as editor switches, and a message per keystroke would
      // re-render the panel on every cursor move for the length of a compile.
      this.postCompileStripFor(now === '<none>' ? null : now);
      this.refreshRunningContext();
    });
  }

  /**
   * Re-post the strip for whichever file just became active. A file with no
   * controller, or one with no tail running, gets an explicit `null` — the
   * webview holds per-file strips, and the file that just became active is
   * entitled to be told it has none.
   */
  private postCompileStripFor(uri: string | null): void {
    if (uri === null) return;
    const state = this.controllers.get(uri)?.compileTailState ?? null;
    this.view.post({ type: 'compileProgress', uri, state });
  }

  /** Disposed with the registry; see the constructor. */
  private readonly trackerSub: vscode.Disposable;
  /** Which document the keys were last computed for. `onChange` fires on
   *  selections and edits as well as editor switches, and recomputing on
   *  those would undo the synchronous leading edge — a run start emits
   *  (statuses cleared) before `controller.active` is set. */
  private lastActiveSignature: string | undefined;

  /** What `active()` depends on, as a comparable string. */
  private activeSignature(): string {
    const editor = this.tracker.activeEditor;
    if (!editor || !this.tracker.isActiveTestFile) return '<none>';
    return editor.document.uri.toString();
  }

  /** Probe/spawn as the registry currently has them, so the manual server
   *  commands go through the same (swappable) collaborators the run path
   *  does. */
  probeHealthNow(...args: Parameters<HealthProbe>): ReturnType<HealthProbe> {
    return this.healthProbe(...args);
  }

  spawnServerNow(...args: Parameters<ServerSpawner>): ReturnType<ServerSpawner> {
    return this.spawnServer(...args);
  }

  /** A successful manual start clears the auto-start backoff, so the next run
   *  doesn't refuse on a stale failure. */
  forgetAutoStartFailure(serverUrl: string): void {
    this.autoStartGuard.clear(serverUrl);
  }

  /** Drop every recorded auto-start failure — the settings just changed. */
  forgetAllAutoStartFailures(): void {
    this.autoStartGuard.clearAll();
  }

  /** Every live controller, editor-attached and batch alike. Three call sites
   *  used to walk both maps by hand. */
  private *allControllers(): Iterable<RunController> {
    yield* this.controllers.values();
    yield* this.batchControllers.values();
  }

  /** Editor-attached controllers — the skill-file session picker's candidate
   *  pool. Batch controllers are excluded on purpose: their sessions are
   *  unique per run and torn down when the batch ends, so there is never one
   *  to inject a step into. */
  editorControllers(): RunController[] {
    return [...this.controllers.values()];
  }

  /**
   * Re-sync the Variables panel's "re-run this skill step" affordance with
   * what is actually parked.
   *
   * An injected run CONSUMES its host's parked failure — `resetFrameState`
   * wipes it even on a continuation — and nothing else tells the panel, which
   * would keep offering an action that can only refuse. Blanking it outright
   * was wrong in the other direction: the panel has ONE slot shared by every
   * test, so a `null` post also erased a second test's still-valid failure.
   * Re-posting whatever is still parked covers both.
   */
  refreshSkillRerunPanel(): void {
    const failure = this.controllerWithSkillFailure()?.skillRerunPayload() ?? null;
    this.view.post({ type: 'skillRerunAvailable', failure });
  }

  /** Test-only: the skill session picker resolves through this instead of a
   *  QuickPick when set — integration tests cannot drive native UI. */
  pickSkillSessionForTest:
    | ((targets: SkillRunTarget[]) => SkillRunTarget | undefined)
    | null = null;

  /** Test-only: swap the health probe / spawn used by every controller.
   *  Discards existing controllers for the same reason the client factory
   *  does — they capture these at construction. */
  setServerHooks(hooks: {
    healthProbe?: HealthProbe;
    spawnServer?: ServerSpawner;
    keepAliveIntervalMs?: number;
  }): void {
    if (hooks.keepAliveIntervalMs !== undefined) {
      this.keepAliveIntervalMs = hooks.keepAliveIntervalMs;
    }
    if (hooks.healthProbe) {
      this.healthProbe = hooks.healthProbe;
      // The status bar polls independently of any run, so it needs the fake
      // too — otherwise the integration suite keeps issuing real fetches at
      // the fixture's SERVER_URL for its whole duration.
      this.serverStatusBar?.setProbe(hooks.healthProbe);
    }
    if (hooks.spawnServer) this.spawnServer = hooks.spawnServer;
    // Swapping the collaborators means the next case starts from scratch —
    // the auto-start backoff is registry-wide and process-lived, so without
    // this one test's deliberate start failure would suppress the next
    // test's spawn.
    this.autoStartGuard.clearAll();
    this.discardControllers();
  }

  /** Test-only: swap the ApiClient factory. Existing controllers are
   *  discarded so the next run picks up the new factory. */
  setApiClientFactory(factory: ApiClientFactory): void {
    this.clientFactory = factory;
    this.discardControllers();
  }

  /** Drop every cached controller so the next run picks up newly-swapped
   *  injectables. Detached batch controllers cache them at construction too,
   *  so they must go as well or a batch run would keep using the old ones
   *  (the integration suite swaps in a FakeApiClient via this path). */
  private discardControllers(): void {
    for (const controller of this.allControllers()) controller.stop();
    this.controllers.clear();
    this.batchControllers.clear();
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
      undefined, // pollSleep — real timer
      {
        healthProbe: this.healthProbe,
        spawnServer: this.spawnServer,
        logPath: this.serverLogPath,
        keepAliveIntervalMs: this.keepAliveIntervalMs,
        autoStartGuard: this.autoStartGuard,
        // `.steps.ts`-breakpoint auto-attach (stories/codebehind-debugging.md
        // §Flow 1). Editor controllers only — batch runs ignore breakpoints
        // by design, and an attach from an earlier editor run covers them
        // anyway if its breakpoints hit.
        onServerReady: (info) => this.autoAttachForStepsBreakpoints({ ...info, folder }),
      },
    );
    controller.attachCompileTailSignals(this.compileTailSignals);
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

  /**
   * Get-or-create a DETACHED, HEADLESS controller for batch (flask / Test
   * Explorer) runs of a document. Unlike `get()`, this controller's `post`
   * callback goes nowhere, it never clears editor statuses, and it is
   * deliberately kept OUT of the `controllers` map. So a flask run never
   * touches the editor surface — no gutter decorations, no sidebar webview
   * updates, no `testbench-native.running` context key (which gates the
   * title-bar Pause/Stop), and the Call Stack / Variables views (which scan
   * `controllers`) never pick it up. That makes a flask run fully independent
   * of the editor: the same file can run interactively AND via the flask at
   * the same time, each with its own browser session — batch runs use a
   * unique `<path>::run-N` id (see issue 032). Cached per-URI so repeated
   * flask runs of one file keep incrementing that controller's run generation,
   * which is what keeps their per-run session ids distinct.
   */
  getBatchController(document: vscode.TextDocument): RunController | undefined {
    const key = document.uri.toString();
    const existing = this.batchControllers.get(key);
    if (existing) return existing;
    const folder = workspaceFolderFor(document.uri);
    if (!folder) return undefined;
    const controller = new RunController(
      document,
      folder,
      () => {}, // headless: no editor / webview / context-key side-effects
      this.clientFactory, // inherit the active factory (test injection)
      () => ({}), // batch ignores breakpoints
      () => {}, // never clear editor statuses
      () => {}, // never disturb the editor's skill-debug context
      undefined, // pollSleep — real timer
      // A flask run needs the same server as an editor run, so it gets the
      // same pre-run check and auto-start.
      { healthProbe: this.healthProbe, spawnServer: this.spawnServer, logPath: this.serverLogPath, keepAliveIntervalMs: this.keepAliveIntervalMs, autoStartGuard: this.autoStartGuard },
    );
    this.batchControllers.set(key, controller);
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
    this.refreshRunningContext();
  }

  /** The controller for the currently-active TestBench file, if any. */
  active(): RunController | undefined {
    const editor = this.tracker.activeEditor;
    if (!editor || !this.tracker.isActiveTestFile) return undefined;
    return this.get(editor.document);
  }

  /**
   * Is the ACTIVE editor's own document running?
   *
   * This — not `anyRunning()` — is what the toolbar asks. Stop, Pause and
   * Continue all act on `registry.active()`, so gating them on "anything,
   * anywhere is running" both hides them from a test that IS running (once
   * another test's run ended last) and offers them on a test that is not.
   */
  runningForActive(): boolean {
    const editor = this.tracker.activeEditor;
    if (!editor || !this.tracker.isActiveTestFile) return false;
    // Deliberately not `active()`, which CREATES a controller on demand:
    // focusing a test file must not allocate one, and a file with no
    // controller has nothing running by definition.
    return this.controllers.get(editor.document.uri.toString())?.isRunning === true;
  }

  /**
   * Does the ACTIVE editor show a parked step-pause?
   *
   * Keyed on the file the yellow ▶ is painted on, not just the controller's
   * own document: a run that stepped into a skill body parks its pause on the
   * SKILL file, and that is where the author drives Step Over / Step Out from.
   */
  private stepPausedForActive(): boolean {
    const active = this.tracker.activeEditor?.document.uri.toString();
    if (active === undefined) return false;
    if (this.stepPausedAt.has(active)) return true;
    for (const [, entry] of this.stepPausedAt) {
      if (entry.uri.toString() === active) return true;
    }
    return false;
  }

  /** True if any controller is currently running. */
  anyRunning(): boolean {
    for (const c of this.controllers.values()) {
      if (c.isRunning) return true;
    }
    return false;
  }

  /** Test-only: true while any controller holds a breakpoint-pause
   *  keep-alive. Batch controllers are included — they take the same
   *  injectables, so a leak there would pin the server just as hard. */
  anyKeepAliveActive(): boolean {
    for (const c of this.allControllers()) {
      if (c.keepAliveActive) return true;
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
      // Which file this message is about. The panel follows the active editor
      // but every controller posts to the same webview, so without the stamp
      // the Output section is one shared pane showing whichever test spoke
      // last, and two concurrent compiles interleave their lines
      // (stories/compile-tail-progress.md §The panel log).
      this.view.post(
        msg.type === 'runEvent' || msg.type === 'compileEvent' || msg.type === 'compileProgress'
          ? { ...msg, uri: uri.toString() }
          : msg,
      );
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
          // A server-side pause inside a top-level section body already
          // paints on the body line (targetUriFor resolves a section frame to
          // the test file). Park the invocation alongside it so that IF this
          // stream drops, the marker left behind is one Continue can resume
          // rather than one it has to refuse as stale.
          const awaitingSection = this.sectionResumeContext(uri, ev.frame);
          this.tracker.setBreakpointStop(target, ev.line, awaitingSection ?? undefined);
          this.stepPausedAt.set(uri.toString(), { uri: target, line: ev.line });
          this.refreshRunningContext();
          // Reveal the frame's file the same way a step:start would, so
          // the user can SEE the line about to execute (e.g. inside a
          // skill body) without having to open it manually.
          if (ev.frame) this.maybeRevealFrame(uri, ev.frame, ev.line);
          break;
        }
        case 'step:pass': {
          const target = this.targetUriFor(uri, ev.frame);
          // How the step passed decides the glyph. `codeBehindStale` outranks
          // everything: the step DID pass, but its compiled entry threw and the
          // AI covered for it, and ⚠ is the only mark that asks for a recompile.
          // Then the code mark (ran as code), then ⚡ (every AI turn served from StepCache),
          // then the plain ✓.
          const status = ev.codeBehindStale
            ? 'pass-stale'
            : ev.fromCodeBehind
              ? 'pass-code-behind'
              : ev.fromCache
                ? 'pass-cached'
                : 'pass';
          // A ⚠ pins the code-behind crash to the line, so the hover and the
          // panel row can say WHAT threw, not just that something did. No
          // `error`: the STEP passed, it is the entry that failed.
          this.tracker.setStatus(
            target,
            ev.line,
            status,
            ev.codeBehindStale
              ? stepFailureDetail({ codeBehindStale: ev.codeBehindStale })
              : undefined,
          );
          break;
        }
        case 'step:fail': {
          const target = this.targetUriFor(uri, ev.frame);
          // Pin the failure text to the line: the ✗ hover and the panel's
          // step row read it back from the tracker. When the failure came out
          // of the step's code-behind (strict replay, `step.expect`, or a
          // heal whose AI attempt failed too) the detail says so.
          const failureDetail = stepFailureDetail(ev);
          this.tracker.setStatus(target, ev.line, 'fail', failureDetail);
          // Propagate the failure to the originating test-file `[skill:]` line
          // so the user sees the red icon on the line they actually authored,
          // not just on the skill's body line they may not even have open.
          let root: { testUri: vscode.Uri; testLine: number } | null = null;
          if (ev.frame) {
            const controller = this.controllers.get(uri.toString());
            root = controller?.markFrameFailed(ev.frame.id) ?? null;
            // The invocation line carries the same failure text as the body
            // line it descends to — the user may only have the test file open.
            if (root) this.tracker.setStatus(root.testUri, root.testLine, 'fail', failureDetail);
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
          //
          // A top-level SECTION failure is the exception: its body lives in
          // the test file and the server can re-enter it at an exact line, so
          // parking on the invocation would make Continue re-run steps the
          // user already watched pass. Park on the failed BODY line instead,
          // carrying the invocation as the resume context.
          const failure = ev.frame
            ? this.controllers.get(uri.toString())?.lastSkillFailure
            : null;
          const sectionFailure =
            failure && failure.kind === 'section' && failure.frameId === ev.frame?.id
              ? failure
              : null;
          if (sectionFailure) {
            this.tracker.setBreakpointStop(
              sectionFailure.testUri,
              sectionFailure.skillLine,
              { kind: 'section-body', callLine: sectionFailure.testLine },
            );
          } else if (root) {
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
        case 'codebehind:awaiting-debugger': {
          // Code-behind step-into (stories/codebehind-debugging.md) — the
          // exact sibling of the tool case: attach (or reuse) the Node
          // debugger, then ack so the server proceeds into the `debugger;`
          // in front of the entry's `run()`.
          const controller = this.controllers.get(uri.toString());
          if (!controller) break;
          void this.handleCodeBehindAwaitingDebugger(controller, ev);
          break;
        }
        case 'done':
          this.lastDoneStatus = ev.status;
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
      this.tracker.setBreakpointStop(uri, msg.line, msg.resumeContext);
      return;
    }
    // A compile's runs paint the gutter the way a run does
    // (stories/codebehind-compile-as-a-run.md §Every run is on the stream):
    // ▶ while a step runs, then ✓ / ⚡ / </> / ⚠ / ✗ by how it ended. What they
    // do NOT do is park a breakpoint stop on a failure or capture a skill
    // failure for re-run: a Replay's session is the compile's own and is
    // closed after the round, so there is nothing to continue into. The
    // compile's own Record runs pre-expanded, so its events carry no frames
    // and the marks land on the test file.
    if (msg.type === 'compileRunEvent') {
      const ev = msg.event;
      switch (ev.type) {
        case 'step:start':
          this.tracker.setStatus(uri, ev.line, 'running');
          break;
        case 'step:pass':
          this.tracker.setStatus(
            uri,
            ev.line,
            ev.codeBehindStale
              ? 'pass-stale'
              : ev.fromCodeBehind
                ? 'pass-code-behind'
                : ev.fromCache
                  ? 'pass-cached'
                  : 'pass',
            ev.codeBehindStale
              ? stepFailureDetail({ codeBehindStale: ev.codeBehindStale })
              : undefined,
          );
          break;
        case 'step:fail':
          // A Replay's red step is the compile's whole point (strict mode:
          // broken code fails instead of healing) — pin the error so the ✗
          // says what the code did wrong.
          this.tracker.setStatus(uri, ev.line, 'fail', stepFailureDetail(ev));
          break;
        default:
          break;
      }
      return;
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
    return frameTargetUri(testUri, frame);
  }

  /**
   * The resume context for a pause reported inside `frame`, or null when the
   * frame is not a top-level section body of this test file.
   *
   * Same gate as the failure path (`recordSkillFailure`): top-level only, so
   * a nested section — where a line anchor cannot be resolved unambiguously —
   * keeps the invocation-line resume it has today.
   */
  private sectionResumeContext(
    testUri: vscode.Uri,
    frame: import('ai-ui-automation-runner-core').FrameInfo | undefined,
  ): { kind: 'section-body'; callLine: number } | null {
    if (!frame || frame.kind !== 'section' || frame.parentId !== null) return null;
    if (vscode.Uri.file(frame.uri).toString() !== testUri.toString()) return null;
    const root = this.controllers.get(testUri.toString())?.rootOfFrame(frame.id);
    if (!root) return null;
    return { kind: 'section-body', callLine: root.testLine };
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
    this.refreshRunningContext();
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
    if (frame.kind !== 'skill' && frame.kind !== 'section') return;
    const controller = this.controllers.get(controllerUri.toString());
    if (!controller) return;

    // A section body lives in the test file the user already has open. The
    // skill behaviour — open the defining file in a column BESIDE — would
    // split the editor to show a second copy of the document they are
    // looking at, and steal the column their other work is in. Reveal in
    // place instead.
    //
    // Compared against the CONTROLLER's document rather than the active
    // editor: the active editor may be somewhere else entirely (the user
    // clicked away mid-run), and the question here is which file the frame
    // belongs to, not what happens to be focused.
    const isOwnDocument = frame.uri === controller.document.uri.fsPath;
    const revealLine = Math.max(0, line - 1);
    const selection = new vscode.Range(revealLine, 0, revealLine, 0);

    if (isOwnDocument) {
      void vscode.window.showTextDocument(controller.document, {
        preserveFocus: true,
        preview: false,
        selection,
      });
      return;
    }

    // A section declared inside a SKILL file lands here too, and wants the
    // skill treatment: its defining file is not the one on screen.
    if (!controller.shouldRevealFrameUri(frame.uri)) return;
    void vscode.window.showTextDocument(vscode.Uri.file(frame.uri), {
      preserveFocus: true,
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
      selection,
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

    const result = await this.attachServerDebugger({
      inspectorUrl: controller.inspectorUrl,
      folder: controller.workspaceFolder,
    });
    if (!result.ok) {
      await ackAndExit(`${result.reason} — running "${ev.toolName}" without a debugger`);
      return;
    }

    if (ev.toolFilePath) {
      vscode.window.setStatusBarMessage(
        `TestBench: stepping into tool "${ev.toolName}" — use the Debug toolbar`,
        4000,
      );
    }
    await controller.ackToolDebugger();
  }

  /**
   * Handle a `codebehind:awaiting-debugger` event
   * (stories/codebehind-debugging.md §Flow 2). Sibling of the tool handler
   * above: attach (or reuse) the Node debugger, then ack so the server
   * proceeds into the cooperative `debugger;` in front of the entry's
   * `run()`. Every failure takes the ack-and-exit path — the step still
   * runs, just undebugged, with a status-bar note saying why.
   */
  private async handleCodeBehindAwaitingDebugger(
    controller: RunController,
    ev: { type: 'codebehind:awaiting-debugger'; file: string; line: number },
  ): Promise<void> {
    const ackAndExit = async (note?: string): Promise<void> => {
      if (note) vscode.window.setStatusBarMessage(`TestBench: ${note}`, 3500);
      await controller.ackToolDebugger();
    };

    if (!controller.isLocalServer()) {
      await ackAndExit(
        'Code-behind step-into requires a local server (SERVER_URL must be 127.0.0.1) — running the entry without a debugger',
      );
      return;
    }

    const result = await this.attachServerDebugger({
      inspectorUrl: controller.inspectorUrl,
      folder: controller.workspaceFolder,
    });
    if (!result.ok) {
      await ackAndExit(`${result.reason} — running the entry without a debugger`);
      return;
    }

    const fileName = ev.file.split(/[\\/]/).pop() ?? ev.file;
    vscode.window.setStatusBarMessage(
      `TestBench: stepping into code-behind for step ${ev.line} (${fileName}) — use the Debug toolbar`,
      4000,
    );
    await controller.ackToolDebugger();
  }

  /**
   * Attach VS Code's Node debugger to the server the controller's pre-run
   * probe answered for — the one attach implementation behind tool
   * step-into, code-behind step-into, and the `.steps.ts`-breakpoint
   * auto-attach. Callers do their own local-server gate first (the message
   * differs per flow) and decide what a failure means.
   *
   * §7: attach to what /health reported, not to a hardcoded setting. The
   * settings are the fallback for servers whose /health predates that
   * story. Getting this wrong is silent: if another node process holds the
   * settings port, the attach succeeds against THAT process, the ack
   * releases the server, its `debugger;` is a no-op, and the user's
   * breakpoint never hits with nothing to explain why.
   */
  private async attachServerDebugger(args: {
    inspectorUrl: string | null | undefined;
    folder: vscode.WorkspaceFolder | undefined;
  }): Promise<{ ok: true; reused: boolean } | { ok: false; reason: string }> {
    const cfg = vscode.workspace.getConfiguration('testbench-native');
    const target = resolveInspectorTarget(args.inspectorUrl, {
      host: cfg.get<string>('inspectorHost', '127.0.0.1'),
      port: cfg.get<number>('inspectorPort', 9229),
    });

    if (target.kind === 'none') {
      return { ok: false, reason: 'server has no inspector — restart it with --inspect' };
    }

    const { host, port } = target;

    // If our pwa-node session is already attached (a previous pause in this
    // run brought it up, or the user launched the server from the Run
    // panel), reuse it. Filter to `pwa-node` only — a Chrome devtools
    // (`chrome` / `pwa-chrome`) session is not the inspector we want, and
    // the port comparison matters as much as the type: a user debugging
    // some unrelated node process would otherwise suppress our attach
    // entirely.
    if (shouldReuseDebugSession(vscode.debug.activeDebugSession, { host, port })) {
      return { ok: true, reused: true };
    }

    try {
      const started = await vscode.debug.startDebugging(args.folder, {
        type: 'pwa-node',
        request: 'attach',
        name: 'TestBench: server',
        address: host,
        port,
        skipFiles: ['<node_internals>/**'],
        sourceMaps: true,
      });
      if (!started) {
        return {
          ok: false,
          reason:
            `couldn't attach Node debugger on ${host}:${port}` +
            (target.source === 'health'
              ? " (reported by the server's /health)"
              : ` — launch the server with --inspect=${port}`),
        };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `debugger attach failed (${reason})` };
    }
    return { ok: true, reused: false };
  }

  /**
   * Run-start auto-attach (stories/codebehind-debugging.md §Flow 1): when
   * the user has enabled breakpoints in any `.steps.ts`, attach the Node
   * debugger before the run's first steps request, so the breakpoints bind
   * by the time the code-behind module loads and its entries execute.
   * Injected into each editor controller's `onServerReady` hook — the seam
   * right after the pre-run health probe, whose `inspector` answer this
   * consumes. Never fails the run: every negative outcome is a log line
   * and (when the user clearly wanted debugging) a status-bar note.
   */
  private async autoAttachForStepsBreakpoints(info: {
    inspectorUrl: string | null | undefined;
    serverUrl: string;
    folder: vscode.WorkspaceFolder | undefined;
    log: (line: string) => void;
  }): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('testbench-native');
    if (cfg.get<boolean>('autoAttachStepsBreakpoints', true) !== true) return;

    const hits = stepsFileBreakpoints(
      vscode.debug.breakpoints
        .filter(
          (bp): bp is vscode.SourceBreakpoint =>
            bp instanceof vscode.SourceBreakpoint && bp.enabled,
        )
        .map((bp) => bp.location.uri.fsPath),
    );
    if (hits.length === 0) return;

    // Same wrong-process gate as the F11 flows: a LOCAL attach for a REMOTE
    // server would land on some unrelated process holding the settings port.
    if (!isLoopbackUrl(info.serverUrl)) {
      info.log('.steps.ts breakpoints set, but SERVER_URL is not local — not attaching a debugger');
      return;
    }

    // Only attach when /health actually REPORTED an inspector. `undefined`
    // means we never got an answer — the server is down, or the probe was
    // skipped — and `resolveInspectorTarget` then falls back to the settings
    // default (127.0.0.1:9229). Dialling that blind costs js-debug's ~10s
    // attach retry on EVERY run, unprompted, for anyone holding a stale
    // enabled breakpoint in any `.steps.ts`. F11 keeps the fallback: it is a
    // deliberate gesture, and the author can be told why it failed.
    if (info.inspectorUrl === undefined) {
      info.log('.steps.ts breakpoints set, but the server reported no inspector — not attaching');
      return;
    }

    const result = await this.attachServerDebugger({
      inspectorUrl: info.inspectorUrl,
      folder: info.folder,
    });
    if (result.ok) {
      info.log(
        `.steps.ts breakpoints in ${hits.length} file(s) — debugger ${result.reused ? 'already attached' : 'attached'}`,
      );
      if (!result.reused) {
        vscode.window.setStatusBarMessage(
          'TestBench: attached debugger for .steps.ts breakpoints',
          3000,
        );
      }
    } else {
      info.log(`.steps.ts breakpoints set, but no debugger: ${result.reason}`);
      vscode.window.setStatusBarMessage(
        `TestBench: ${result.reason} — .steps.ts breakpoints won't bind`,
        4000,
      );
    }
  }

  /**
   * Recompute the run-state context keys from the ACTIVE editor's document.
   *
   * Called on every edge that can change the answer: a run start or end
   * (`done` / `runError`, where the controller is the authority), a step
   * pause opening or clearing, and — the one that was missing — the active
   * editor changing. The keys describe what the toolbar is pointing at, so
   * looking at a different file changes them just as much as a run ending.
   */
  refreshRunningContext(): void {
    const before = this.lastRunningContextValue;
    const running = this.runningForActive();
    this.setRunningContext(running);
    this.setStepPausedContext(this.stepPausedForActive());
    // The panel's buttons answer the same question as the toolbar's, so they
    // follow the active document too. Flagged as a sync so the panel does not
    // mistake "you switched to a running test" for "a new run started" and
    // wipe the variables that run has collected.
    if (running !== before) this.view.post({ type: 'running', running, sync: true });
  }

  /**
   * Tell the webview a run started/stopped, and pin the
   * `testbench-native.running` context key to the same value.
   *
   * The LEADING edge is trusted, and must be: the command handler calls
   * `notifyRunning(true)` synchronously, *before* `controller.runLines()`
   * sets `controller.active`. Recomputing there would read the stale "no
   * active run" state and set the key false, hiding Pause/Stop until the
   * first run event drove a refresh — the "Pause disappeared after Resume"
   * symptom. Every caller starts a run in the ACTIVE editor's document
   * (each takes `registry.active()`), so trusting it stays per-active.
   *
   * The TRAILING edge is not trusted any more. It used to be, on the
   * reasoning that each `notifyRunning(true)` is paired with a
   * `.finally(notifyRunning(false))` for that same run — true, and not
   * enough: the key is global to the window while runs are per document, so
   * one test's run ending slammed it false while another test was still
   * running, and the running test's Stop and Pause vanished for the rest of
   * its run. On exit we ask the controllers instead.
   */
  notifyRunning(running: boolean): void {
    if (running) {
      this.setRunningContext(true);
    } else {
      this.refreshRunningContext();
    }
    this.view.post({ type: 'running', running: this.lastRunningContextValue });
    // A run just started or ended — both change what /health reports, and a
    // 30s poll would leave the item stale for most of that window (§6).
    void this.serverStatusBar?.refresh();
  }

  private setRunningContext(value: boolean): void {
    // Recorded here rather than at the call site so the history is what the
    // key was SET to, which is the thing under test — a request to set false
    // that a still-running document overrules is not a false in the history.
    this.notifyRunningHistory.push(value);
    if (value === this.lastRunningContextValue) return;
    this.lastRunningContextValue = value;
    void vscode.commands.executeCommand('setContext', 'testbench-native.running', value);
  }

  /** Mirror of the last value pushed to `testbench-native.stepPaused`. */
  private lastStepPausedContextValue = false;

  private setStepPausedContext(value: boolean): void {
    if (value === this.lastStepPausedContextValue) return;
    this.lastStepPausedContextValue = value;
    void vscode.commands.executeCommand('setContext', 'testbench-native.stepPaused', value);
  }

  /** Test-only: every value passed through notifyRunning, in order. */
  readonly notifyRunningHistory: boolean[] = [];
  /** Test-only: most recent runError payload posted by any controller. */
  lastRunError: { code: string; diagnosis: string; fix?: string } | null = null;
  /** Test-only: what the most recent compile failed with, or null. Written by
   *  the compile command, which is where the outcome lands. */
  lastCompileError: string | null = null;
  /** Test-only: status of the most recent `done` event. §5 specifies the
   *  Stop-during-spawn outcome as a STATUS ("aborted"), which no error-code
   *  assertion can prove. */
  lastDoneStatus: 'passed' | 'failed' | 'error' | 'aborted' | null = null;

  dispose(): void {
    this.compileTailSignals.dispose();
    this.trackerSub.dispose();
    this.discardControllers();
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
  /** Swap the pre-run health probe, the auto-start spawn, and/or the
   *  breakpoint keep-alive cadence. A raw fetch in the run path would bypass
   *  the harness's fake server and hit a real socket, so the probe has to be
   *  injectable the same way the client is; the cadence is injectable so a
   *  test can observe the ping rather than only the timer. */
  setServerHooks: (hooks: {
    healthProbe?: HealthProbe;
    spawnServer?: ServerSpawner;
    keepAliveIntervalMs?: number;
  }) => void;
  /** `inspector` the active controller recorded from its pre-run probe.
   *  `undefined` (no health data) and `null` (server has no inspector) are
   *  different answers — see §7. */
  inspectorUrl: () => string | null | undefined;
  /** True while any controller holds a breakpoint-pause keep-alive timer. */
  keepAliveActive: () => boolean;
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
  /** Reset {@link lastRunError}. It is registry-wide and sticky, so a test
   *  asserting "this run reported no error" must clear the previous test's
   *  error first or it reads someone else's failure. */
  clearRunError: () => void;
  /** Status of the most recent `done` event, or null. */
  lastDoneStatus: () => 'passed' | 'failed' | 'error' | 'aborted' | null;
  /** What the most recent compile failed with — the text of its error
   *  notification — or null when it succeeded or none has run. Reset at the
   *  start of every compile, so it always describes the latest one. */
  lastCompileError: () => string | null;
  /** The compile mode a controller still remembers for its logical run, by
   *  test URI. A Stop must leave nothing behind for a later caller to
   *  inherit; nothing else makes that observable. */
  rememberedCompileMode: (uri: vscode.Uri) => 'run' | 'steps' | undefined;
  /** Whether that document's run is parked at a breakpoint. The skill-step
   *  picker filters parked sessions out, so a value left stale by Stop makes
   *  the session permanently invisible there. */
  isParkedAtPause: (uri: vscode.Uri) => boolean;
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
  /** Test-only: resolve the skill-file session picker without a QuickPick —
   *  integration tests cannot drive native UI. Pass null to restore the
   *  interactive picker. The callback receives the rows in presentation
   *  order and returns the pick (or undefined to cancel). */
  setSkillSessionPicker: (
    fn: ((targets: SkillRunTarget[]) => SkillRunTarget | undefined) | null,
  ) => void;
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
  /** The Variables view's current description string. Sections and skills
   *  both carry `skillName`, so the label has to key on `kind` — this hook
   *  is how a test proves a paused section reads "section:" not "skill:". */
  /** The N/M pass-summary counts for a document. M must be the author's
   *  main-flow step count: a section body can run zero times or many, so
   *  counting body lines makes M meaningless and lets N exceed it. */
  stepsSummaryForTests: (uri: vscode.Uri) => { passed: number; total: number };
  variablesDescription: () => string;
  /** Run-state signature for arbitrary text. Statuses are pinned to line
   *  numbers and a section heading decides which body a line belongs to, so
   *  a test needs to prove a heading edit changes the signature. */
  stepSignatureForText: (text: string) => string;
  /** Result counts of the most recent batch run, or null if none yet. */
  lastBatchRun: () => { passed: number; failed: number; skipped: number } | null;
  /** Lines streamed to the in-flight (or most recent) test's Test Results
   *  output. Lets a test prove output is emitted DURING the run, not buffered. */
  batchOutput: () => string[];
  /** Test-only readback of the most recent failed test's TestMessages and the
   *  file+line each was anchored at. WHERE a failure is anchored is not
   *  readable back from VS Code, and an in-skill failure must peek at the
   *  skill file — not at that line number in the test file. */
  batchFailureMessages: () => Array<{ text: string; file: string | null; line: number | null }>;
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
  /** Active controller's `lastRunTokens` — token totals recovered for the most
   *  recently finalized run (incl. a STOPPED one, issue 021), or null. Backs the
   *  live stop-report test's token assertion. */
  lastRunTokens: () => { total: number; input: number; output: number } | null;
  /** The compile proposal waiting for Apply or Discard, or null. Backs the
   *  code-behind tests: the diff editors themselves are not readable from the
   *  extension host, but what they were opened WITH is. */
  pendingCodeBehind: () => { testFilePath: string; files: Record<string, string> } | null;
  /** Every host→webview message posted since `mark` and still retained, most
   *  recent last. The webview's own state is not readable from the extension
   *  host, so this is how the per-file scoping of the panel's Output section
   *  and compile strip is asserted: through the URI each message carries. */
  hostMessagesSince: (mark: number) => import('ai-ui-automation-runner-core').HostToWebviewMsg[];
  /** The mark to pass back to `hostMessagesSince`. */
  hostMessageCount: () => number;
  /** Replace how the compile toast is raised, so the harness can observe it. */
  setCompileProgressReporter: (
    reporter: import('./compile-tail-signals.js').ProgressReporter,
  ) => void;
  /** The compile tails the workbench status bar item is aggregating. */
  compileTails: () => import('./compile-progress-core.js').CompileTail[];
  /** The ⚠ decoration's hover text. Applied decorations are not readable back
   *  from the extension host, so this is how a test asserts the mark names the
   *  action AND its precondition ("re-runs this step in the current session")
   *  rather than leaving the author with a bare warning glyph.
   *
   *  Takes the same optional detail the decoration passes, so a test asserts
   *  the string that ACTUALLY renders. Called with no argument it returns the
   *  detail-less fallback; called with one it returns the crash-first text a
   *  ⚠ shows in the normal case, which is what the decoration builds. */
  staleHoverMessage: (failure?: StepFailureDetail) => string;
}

export interface TestBenchExports {
  __testHooks?: TestBenchTestHooks;
}

export function activate(context: vscode.ExtensionContext): TestBenchExports {
  const out = getOutputChannel();
  const ts = () => new Date().toISOString().slice(11, 23);
  out.appendLine(`[${ts()}] TestBench activate() — version=${context.extension.packageJSON.version}`);

  // One rolling log for every server this extension starts. globalStorageUri
  // (not workspaceStorage) because a detached server outlives the window that
  // spawned it and may be shared by several — a per-workspace log would
  // scatter the diagnosis of a single process across folders.
  const serverLogPath = (): string =>
    vscode.Uri.joinPath(context.globalStorageUri, 'server.log').fsPath;

  const tracker = new ActiveFileTracker();
  const decorations = new DecorationManager(context, tracker);
  // Holds a green compile's proposed files until the author applies or
  // discards them (stories/codebehind-compile.md §What the author sees).
  const codeBehindDiffs = new CodeBehindDiffs();
  const view = new TestBenchRunnerView(context, tracker);
  const serverStatusBar = new ServerStatusBar(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  const registry = new RunControllerRegistry(view, tracker, serverLogPath, serverStatusBar);
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
      // `kind` travels alongside the name: a section frame carries
      // `skillName` too, so the view cannot tell the two apart without it.
      return top.skillName !== undefined
        ? { id: top.id, skillName: top.skillName, kind: top.kind }
        : { id: top.id, kind: top.kind };
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
    // Editing the auto-start settings is the user saying "I fixed it" — drop
    // the backoff so the very next run retries instead of repeating a stale
    // "a previous attempt failed moments ago".
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('testbench-native.serverAutoStart')) {
        registry.forgetAllAutoStartFailures();
      }
    }),
    openInEditor,
    // F12 / Ctrl+Click / Peek on `[skill: ...]` / `[tool: ...]` invocations
    // and on bare-name section calls / `### Name` headings.
    vscode.languages.registerDefinitionProvider(
      { language: 'markdown', scheme: 'file' },
      new InvocationDefinitionProvider(),
    ),
    // …and on `${data.…}` / `${env.…}` / `${<source>.…}` references — the
    // key inside the environment's JSON data file, or the assignment line in
    // its .env files (same file resolution as the completion provider below)
    // — plus `{{name}}` runtime variables, which resolve within the document
    // to their Parameters bullet and/or the step that captures them.
    vscode.languages.registerDefinitionProvider(
      { language: 'markdown', scheme: 'file' },
      new EnvDataDefinitionProvider(),
    ),
    // Inline-section authoring: links on resolved calls, completion of
    // section names after a step number, and diagnostics for typos /
    // duplicates / dead sections.
    vscode.languages.registerDocumentLinkProvider(
      { language: 'markdown', scheme: 'file' },
      new SectionLinkProvider(),
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'markdown', scheme: 'file' },
      new SectionCompletionProvider(),
      // Re-offer as the author types: after the ordinal's space, at `[` (the
      // whole-call snippets), after a `[skill` separator (`:` or the space
      // again — names in place), and at `/` stepping into a subfolder name.
      ' ',
      '[',
      ':',
      '/',
    ),
    // `${data.…}` / `${env.…}` / `${<source>.…}` / `${envName}` references,
    // fed by the active environment's files. `{` opens the namespace list as
    // `${` is typed; `.` steps into the next path segment.
    vscode.languages.registerCompletionItemProvider(
      { language: 'markdown', scheme: 'file' },
      new EnvDataCompletionProvider(),
      '{',
      '.',
    ),
    new SectionDiagnostics(),
    // Target of the document links above — reveal a heading line in place.
    vscode.commands.registerCommand(
      'testbench-native.revealSectionLine',
      async (uriStr: string, line: number) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      },
    ),
    // The status bar item's click (stories/compile-tail-progress.md): with one
    // compile running it opens that file's panel, with several it asks which.
    // Registered here rather than in the command module because the aggregator
    // it drives is the registry's, and it is deliberately not in the palette —
    // there is nothing to invoke when no compile is running.
    vscode.commands.registerCommand(CompileTailSignals.clickCommand, () =>
      registry.compileTailSignals.reveal(),
    ),
    ...registerCommands(registry, tracker, codeBehindDiffs),
    codeBehindDiffs,
    serverStatusBar,
    // The probe/spawn are delegated through the registry rather than defaulted
    // inside the command module, so a `setServerHooks` swap reaches the
    // commands too — otherwise a test that executed `startServer` would issue
    // a real fetch and a real detached spawn of whatever the settings held.
    ...registerServerCommands({
      statusBar: serverStatusBar,
      logPath: serverLogPath,
      probe: (url, timeoutMs, signal) => registry.probeHealthNow(url, timeoutMs, signal),
      spawn: (spawnArgs) => registry.spawnServerNow(spawnArgs),
      onStarted: (serverUrl) => registry.forgetAutoStartFailure(serverUrl),
    }),
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
      setServerHooks: (hooks) => registry.setServerHooks(hooks),
      inspectorUrl: () => registry.active()?.inspectorUrl,
      keepAliveActive: () => registry.anyKeepAliveActive(),
      isRunning: () => registry.anyRunning(),
      runningContextValue: () => registry.runningContextValue,
      activeControllerResolves: () => registry.active() !== undefined,
      notifyRunningHistory: () => [...registry.notifyRunningHistory],
      lastRunError: () => registry.lastRunError,
      clearRunError: () => {
        registry.lastRunError = null;
        registry.lastDoneStatus = null;
      },
      lastDoneStatus: () => registry.lastDoneStatus,
      lastCompileError: () => registry.lastCompileError,
      rememberedCompileMode: (uri) =>
        registry.controllerForUri(uri.toString())?.rememberedCompileMode,
      isParkedAtPause: (uri) =>
        registry.controllerForUri(uri.toString())?.isParkedAtPause === true,
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
      setSkillSessionPicker: (fn) => {
        registry.pickSkillSessionForTest = fn;
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
      stepsSummaryForTests: (uri: vscode.Uri) => {
        // The REAL summary function, not a copy — so a regression in
        // decorations.ts turns this test red. See computeStepsSummary.
        const snap = tracker.snapshotFor(uri) ?? tracker.snapshot();
        const { passed, total } = computeStepsSummary(snap);
        return { passed, total };
      },
      variablesDescription: () => variablesProvider.descriptionForTests(),
      stepSignatureForText: (text: string) => tracker.stepSignatureForTests(text),
      lastBatchRun: () => testController.lastRun,
      batchOutput: () => [...testController.liveOutput],
      batchFailureMessages: () => [...testController.lastFailureMessages],
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
      lastRunTokens: () => registry.active()?.lastRunTokens ?? null,
      /** What the panel was TOLD since `mark`, most recent last. The webview's
       *  own state is not readable from here, so the per-file scoping is
       *  asserted through the URI stamp on the messages that carry it. */
      hostMessagesSince: (mark: number) => view.messagesSince(mark),
      /** The mark to pass back to `hostMessagesSince`. Not an array index: the
       *  buffer drops from the front once full, and an index would then point
       *  at a different message than it did when it was taken. */
      hostMessageCount: () => view.sentMessageCount,
      /** Swap how the compile toast is raised. The harness cannot read a real
       *  notification back, and a real one would sit on screen for the length
       *  of the suite. */
      setCompileProgressReporter: (reporter) =>
        registry.compileTailSignals.setProgressReporter(reporter),
      /** Every compile tail the status bar item is currently aggregating. */
      compileTails: () => registry.compileTailSignals.tails,
      pendingCodeBehind: () => codeBehindDiffs.pending,
      staleHoverMessage: (failure) => staleHoverMessage(failure),
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
    case 'compile': {
      await vscode.commands.executeCommand('testbench-native.compileCodeBehind');
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
