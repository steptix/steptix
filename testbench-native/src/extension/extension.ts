import * as vscode from 'vscode';
import {
  type HostRowsMsg,
  type HostToWebviewMsg,
  type StepFailureDetail,
  type WebviewToHostMsg,
  isSkippedPass,
  stepFailureDetail,
} from 'ai-ui-automation-runner-core';
import { ActiveFileTracker, markLineMovesFor } from './active-file-tracker.js';
import { moveLineKeyed } from './mark-lines-core.js';
import { DecorationManager, computeStepsSummary, dataTablesOf } from './decorations.js';
// The same builder the ⚠ decoration calls, so the test hook cannot drift from
// what actually renders.
import { staleHoverMessage } from './failure-hover-core.js';
import { skipPaintsOver } from './step-skip-core.js';
import { passPaintsOver, toleratedPaintsOver } from './failure-outcome-core.js';
import { GuardMarks, passMarkFor } from './guard-mark-core.js';
import { lineStatusFromRowStatus, rowHeaderSummary } from './row-summary-core.js';
import {
  allRowsOfTable,
  buildRowsMessage,
  rowSelectionRefusal,
  splitRowSelection,
} from './row-selection-core.js';
import { TestBenchRunnerView } from './runner-view.js';
import { RunController, defaultApiClientFactory } from './run-controller.js';
import type { ApiClientFactory, SkillDebugContext } from './run-controller.js';
import { registerCommands } from './commands/index.js';
import type { SkillRunTarget } from './skill-run-targets.js';
import { CodeBehindDiffs } from './codebehind-diff.js';
import { StepRecorder, type RecordingReport } from './step-recorder.js';
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
import { LmBridge, type BridgeStatus, type LmBridgeTestOptions } from './lm-bridge.js';
import { registerLmBridgeCommands } from './lm-bridge-setup.js';
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
/**
 * What makes two `rows` messages "the same table in the same state".
 *
 * Everything a derivation from the file can know, and nothing it cannot:
 * `durationMs` is deliberately absent, because only a run measures one and a
 * derived message that lacked it would otherwise look like a change and
 * overwrite the run's times with blanks.
 */
function rowsComparisonKey(msg: HostRowsMsg): string {
  return JSON.stringify(
    msg.tables.map((t) => [t.table, t.rows.map((r) => [r.row, r.line, r.values, r.status])]),
  );
}

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
  /**
   * Lines a tolerated failure has painted amber this run, keyed by the URI the
   * mark landed on (stories/step-failure-outcomes.md, decision 6).
   *
   * Remembered rather than read back off the line, because the line does not keep
   * it: a second trip through the same step emits `step:start` first, which paints
   * `running` over the amber ✗ and drops its failure detail. And a second trip is
   * the NORMAL shape here — the run carrying on is the point of `otherwise
   * continue` — so without this the mark disappears on exactly the runs it exists
   * for.
   *
   * Worst-of, like the data-row repaint one rung up. The detail is kept with the
   * line so the repaint restores the hover too, and both are cleared with the
   * statuses at run start, so a mark is always THIS run's.
   */
  private readonly toleratedLines = new Map<string, Map<number, StepFailureDetail>>();
  /**
   * The `</>` / ⚠ a guard's `step:pass` painted on its line this run, so the
   * clean `frame:pop` of that line's section tail repaints it instead of a plain
   * ✓ (stories/codebehind-loops-and-conditions.md, decision 15; the rule is in
   * guard-mark-core.ts). Remembered for the same reason `toleratedLines` is — the
   * tail's `frame:push` paints ▶ over the mark first — and cleared with it.
   */
  private readonly guardMarks = new GuardMarks<StepFailureDetail>();

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

  /**
   * The window's one Record Steps recorder (stories/testbench-record-steps.md).
   * Here, beside the controllers, because the commands and the panel's
   * messages both reach it through the registry, and the recording it runs
   * lives in a controller's session.
   */
  readonly recorder: StepRecorder;

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
    this.recorder = new StepRecorder((msg) => this.view.post(msg));
    // The run-state context keys describe the ACTIVE EDITOR's document, so
    // they have to be recomputed when the active editor changes — not only
    // when a run starts or ends. Without this, switching between two tests
    // leaves whichever key the last run edge happened to set: a running test
    // shows Run (its Stop and Pause gone for the rest of its run), and a test
    // that is doing nothing shows Stop and Pause for someone else's run.
    this.trackerSub = tracker.onChange(() => {
      // OUTSIDE the signature dedupe: the Rows section has to answer to the
      // document as well as to the editor switch — a table gains a row, a
      // reload restores yesterday's ✗ marks, Clear Run Statuses wipes them —
      // and none of those change which file is active.
      this.postRowsForActiveFile();
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
      this.refreshFailedRowsContext();
    });
    this.editSub = vscode.workspace.onDidChangeTextDocument((event) =>
      this.moveRememberedMarks(event),
    );
  }

  /** Disposed with the registry; see `moveRememberedMarks`. */
  private readonly editSub: vscode.Disposable;

  /**
   * Move `toleratedLines` and `guardMarks` with an edit, the way the tracker
   * moves the marks they repaint (`moveMarks`, active-file-tracker.ts).
   *
   * Both remember a line THIS run painted so a later event can paint it again,
   * and a run outlives an edit whenever it is parked: a breakpoint or a failure
   * pauses it, the author edits, and Continue is the same run. Left on their
   * old numbers, the Continue's events — which carry the new ones — looked up
   * whatever had slid into the old line: a step that passed on the second call
   * of a section wore the amber ✗ and hover of the step above it, which went
   * green, and a guard's tail popped to a plain ✓ over the `</>` it earned.
   *
   * They move while a stream is LIVE too, although its later events still
   * carry the numbers the run started with (the accepted gap in `moveMarks`,
   * active-file-tracker.ts). Every lookup is made for the line the event is
   * about to paint, by the same number, so what matters is that the memory
   * describes the mark on THAT line — and moved, it stays under the mark it
   * remembers. Held on the run-start numbers instead, it answered for the step
   * the stream meant and the paint landed on another: a step inserted above a
   * tolerated one mid-run wore that step's amber ✗ and hover on the next call,
   * and the step that failed went green; a guard's tail popping after an
   * insert above it put the guard's ⚠ and its hover on the step that slid
   * into the guard's old line, where moved it repaints that step's own ✓.
   * And a Continue after the run parked, which sends the edited text, would
   * miss every mark an edit during the stream had moved. Holding would also
   * need an owner to ask whether a stream is live, and a skill file's memory
   * is written by the TEST's controller, not one keyed by the skill's URI.
   */
  private moveRememberedMarks(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) return;
    const key = event.document.uri.toString();
    const tolerated = this.toleratedLines.get(key);
    const guarded = this.guardMarks.linesOf(key);
    if (!tolerated && guarded.length === 0) return;
    const moves = markLineMovesFor(event, [...(tolerated?.keys() ?? []), ...guarded]);
    if (!moves) return;
    if (tolerated) moveLineKeyed(tolerated, moves);
    this.guardMarks.move(key, moves);
  }

  /** The `(row, line, values, status)` of the last `rows` message this
   *  registry derived for each file — what a fresh derivation is compared
   *  against, so an editor event that changed nothing posts nothing. */
  private lastDerivedRows = new Map<string, string>();
  /** Which file the last rows derivation was for, so an editor switch is
   *  distinguishable from an edit to the file already showing. */
  private lastRowsActiveUri: string | null = null;

  /**
   * Keep the panel's Rows section true for the file the author is looking at,
   * run or no run.
   *
   * It used to be fed only from inside a run, so opening a data-driven test
   * showed an empty Rows section, and reloading the window emptied it again
   * even though the ✓/✗ marks were still painted on the rows — the marks
   * persist, the message that described them did not. This derives the same
   * message from the file plus the tracker's statuses, which is what makes the
   * section right the moment the file opens and right again after a reload.
   *
   * Three rules keep it out of a live run's way:
   *  - Nothing is posted while that file is running. The controller's matrix
   *    is the authority then, and a derived post between the row boundary's
   *    status clear and the controller's re-post would flash an all-`pending`
   *    table.
   *  - The comparison ignores `durationMs`, which only a run can know, so a
   *    finished run's `8.2s` is not overwritten by a derivation that has none.
   *  - After a run the tracker was painted FROM the controller's message, so
   *    a derivation of it is identical and posts nothing at all.
   */
  private postRowsForActiveFile(): void {
    const uri = this.activeSignature();
    // An editor switch always re-posts, even when nothing about the file
    // changed: the panel is one webview shared by every file, it can be
    // disposed and rebuilt whenever the view is hidden, and the file that just
    // became active is entitled to be told what its rows are — the same reason
    // `postCompileStripFor` re-posts a strip on every switch.
    const switched = this.lastRowsActiveUri !== uri;
    this.lastRowsActiveUri = uri;
    if (uri === '<none>') return;
    if (this.controllers.get(uri)?.isRunning === true) return;
    const snap = this.tracker.snapshot();
    if (!snap.isTestFile || snap.uri !== uri) return;
    const statuses = new Map(snap.statuses);
    const hovers = new Map(
      [...snap.failures].map(([line, detail]) => [line, detail.error]),
    );
    const msg = buildRowsMessage(uri, snap.text, (line) => {
      const status = statuses.get(line);
      const hover = hovers.get(line);
      if (status === undefined && hover === undefined) return undefined;
      return { ...(status !== undefined && { status }), ...(hover !== undefined && { hover }) };
    });
    if (!msg) {
      // A file whose table was deleted (or which never had one) still has to
      // be told, or the panel keeps showing the table that is gone.
      const had = this.lastDerivedRows.delete(uri);
      if (had || switched) this.view.post({ type: 'rows', uri, tables: [] });
      return;
    }
    const key = rowsComparisonKey(msg);
    if (!switched && this.lastDerivedRows.get(uri) === key) return;
    this.lastDerivedRows.set(uri, key);
    this.view.post(msg);
    this.refreshFailedRowsContext();
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
        for (const uri of uris) this.clearStatusesFor(uri);
      },
      // Fresh-run hook: a full run from the top drops this test's skill-debug
      // context (the banner + "run on stopped session" affordance go stale).
      () => this.clearSkillDebugIfOwnedBy(document.uri.toString()),
      // NOTE: `lineStatuses` / `lineHovers` are set on the instance below —
      // the positional list is already long enough that a ninth argument
      // would need two `undefined` placeholders to reach.
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
    // What the gutter shows right now. A run that narrows an axis seeds the
    // rows it did NOT select from these, so an unselected row keeps the mark
    // it already had across the row boundary's status clear (decision 6).
    controller.lineStatuses = () =>
      new Map(this.tracker.snapshotFor(document.uri)?.statuses ?? []);
    controller.lineHovers = () => {
      const out = new Map<number, string>();
      for (const [line, detail] of this.tracker.snapshotFor(document.uri)?.failures ?? []) {
        if (detail.error !== undefined) out.set(line, detail.error);
      }
      return out;
    };
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

  /**
   * Wipe one file's run marks — the statuses AND the amber-line memory that
   * outlives an individual status write.
   *
   * One method so the two cannot drift: a clear that left `toleratedLines` behind
   * would make the NEXT run refuse to paint a green ✓ on a line this one
   * tolerated — a stale mark no event will ever correct. `guardMarks` likewise:
   * left behind, the next run's clean `frame:pop` would repaint a `</>` this run
   * earned on a line the next run decided with the model.
   */
  private clearStatusesFor(uri: vscode.Uri): void {
    this.tracker.clearStatuses(uri);
    this.toleratedLines.delete(uri.toString());
    this.guardMarks.clear(uri.toString());
  }

  /** Remember an amber line and what it said, so a later trip through the
   *  same line can be put back the way it was. */
  private rememberTolerated(
    uri: vscode.Uri,
    line: number,
    failure: StepFailureDetail,
  ): void {
    const key = uri.toString();
    const lines = this.toleratedLines.get(key);
    if (lines) lines.set(line, failure);
    else this.toleratedLines.set(key, new Map([[line, failure]]));
  }

  /** The detail of a tolerated failure this run already painted on the line,
   *  or undefined (`passPaintsOver`, failure-outcome-core.ts). */
  private toleratedEarlierThisRun(
    uri: vscode.Uri,
    line: number,
  ): StepFailureDetail | undefined {
    return this.toleratedLines.get(uri.toString())?.get(line);
  }

  private applyToTracker(uri: vscode.Uri, msg: HostToWebviewMsg): void {
    // The worst status each line reached across a data-driven run's rows,
    // applied once when the loop ends. Every row repaints the same lines, so
    // without this the last clean row would erase a failure three rows back
    // and the gutter would go green on a run that had red in it.
    //
    // KNOWN LIMITATION — an amber ✗ does not survive a row boundary
    // (stories/step-failure-outcomes.md §Known limitations). The boundary clears
    // the file's statuses AND `toleratedLines`, so a step tolerated on row 1 has
    // no amber memory left by the time row 2 paints it, and this summary has only
    // `fail` to put back: `rowSummary.failures` carries no `tolerated` flag and
    // `lineStatusFromRowStatus` has no tolerated member, because a row whose only
    // failures were tolerated is a PASSED row. Until a flag on this message and a
    // third summary status exist, the amber mark is per-row and the run log is
    // where an earlier row's tolerated failure stays visible.
    if (msg.type === 'rowSummary') {
      const target = vscode.Uri.parse(msg.uri);
      for (const failure of msg.failures) {
        const rows = failure.rows.join(', ');
        this.tracker.setStatus(target, failure.line, 'fail', {
          error:
            failure.rows.length === 1
              ? `Failed on row ${rows}.`
              : `Failed on rows ${rows}.`,
        });
      }
      return;
    }
    // The live data-row matrix. One message feeds two surfaces: the Runner
    // panel renders the Rows section from it, and this paints the same rows
    // in the table itself, using the status vocabulary the steps already have
    // (stories/data-row-progress-and-selection.md §Row status in the table).
    //
    // Applied in one batch — the matrix rewrites every row at every boundary,
    // which is exactly what restores rows 1..n-1 after the row boundary's
    // file-wide status clear, and a per-line write would emit a snapshot for
    // each of them.
    if (msg.type === 'rows') {
      // Remembered as if we had derived it: after the run, a derivation of
      // the tracker (which this very call is about to paint) is identical, so
      // the comparison in `postRowsForActiveFile` finds no change and the
      // durations this message carries survive.
      this.lastDerivedRows.set(msg.uri, rowsComparisonKey(msg));
      const target = vscode.Uri.parse(msg.uri);
      this.tracker.setStatuses(
        target,
        msg.tables.flatMap((table) =>
          table.rows.map((row) => {
            const status = lineStatusFromRowStatus(row.status);
            return {
              line: row.line,
              status,
              // A passed row has no hover, as a passed step has none. A failed
              // or skipped one carries its reason, which is the only place the
              // reason exists once the run log has scrolled.
              ...(row.hover !== undefined && { failure: { error: row.hover } }),
            };
          }),
        ),
      );
      return;
    }
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
          // How the step passed decides the glyph (`passMarkFor`,
          // guard-mark-core.ts). `output: 'skipped'` paints ◌, because the
          // step did not run at all: the untaken half of a decision, or the
          // whole body of a `While` that never entered (stories/control-flow.md
          // — "the other line and its section paint as skipped, so you can read
          // which way it went off the editor"). It rides the PASS event because
          // a branch that was not taken is not a failure and the wire has no
          // third verdict; painting it ✓ would claim work that was never done.
          //
          // `codeBehindStale` outranks it: ⚠ is the only mark that asks for a
          // recompile. On a step that ran, its compiled entry threw and the AI
          // covered for it; on a skipped chain member, its CONDITION entry
          // threw on the visit that then took another member — the ⚠ lands on
          // the line whose entry broke, with a hover saying both facts. Then
          // the code mark (ran as code), then the plain ✓.
          const skipped = isSkippedPass(ev);
          const mark = passMarkFor(ev, skipped);
          const status = mark.status;
          // The same precedence a `step:skip` gets, and for the same reason:
          // a ✗ is the one status a run must not lose, and the two producers
          // of a skipped step must not disagree about that
          // (`skipPaintsOver`, step-skip-core.ts). A skipped ⚠ is still a
          // skip here — the line did not run.
          const current = this.tracker.state(target).statuses.get(ev.line);
          if (skipped && !skipPaintsOver(current)) {
            break;
          }
          // …and the amber ✗ survives a later PASS on the same line
          // (`passPaintsOver`, failure-outcome-core.ts). Tolerating a failure is
          // precisely the case where the same line runs again and passes — a loop's
          // next trip, a section called twice. Asked of the run's MEMORY as well as
          // the line, because the second trip's `step:start` painted `running` over
          // the amber ✗ before this pass arrived; put back rather than skipped,
          // since skipping leaves that `step:start`'s ▶ spinning on a finished step.
          const tolerated = this.toleratedEarlierThisRun(target, ev.line);
          if (!passPaintsOver(current) || tolerated) {
            this.tracker.setStatus(target, ev.line, 'fail-tolerated', tolerated);
            // What this pass left on the line is the amber ✗, not a code mark,
            // so a section tail's pop on this line goes back to its plain ✓.
            this.guardMarks.notePass(target.toString(), ev.line, 'fail-tolerated');
            break;
          }
          // A ⚠ pins the code-behind crash to the line, so the hover and the
          // panel row can say WHAT threw, not just that something did. No
          // `error`: the STEP passed (or did not run), it is the entry that
          // failed; a skipped ⚠ carries its skip reason as `notTaken`.
          //
          // A ◌ pins its reason the same way a `step:skip` does, which is what
          // gives the untaken branch a hover at all — it had none, so the
          // commonest skip in the codebase explained itself least. `reason` is
          // absent on an older server, and an absent detail is exactly the
          // hoverless ◌ that used to be the only outcome.
          const detail = mark.detail ? stepFailureDetail(mark.detail) : undefined;
          this.tracker.setStatus(target, ev.line, status, detail);
          // Remembered for the `frame:pop` below: when this line is a guard
          // whose tail is a section, the tail's frame is pushed and popped on
          // this same line, and its pop must not flatten this `</>` / ⚠ to ✓
          // (decision 15). Every pass records, so a loop's latest visit wins.
          this.guardMarks.notePass(target.toString(), ev.line, status, detail);
          break;
        }
        case 'step:skip': {
          // A step an `If … then return` left behind
          // (stories/step-flow-control.md, decision 9). Routed by `frame` the
          // way step:pass is — a section body line reports with the section
          // frame, whose `uri` is the test file, a skill-body line with the
          // skill file — so ◌ lands in the editor the author is looking at.
          //
          // Two things this deliberately does NOT do. It does not touch the
          // returned frame's own CALL line: that frame ran and returned, and
          // the ✓ it earns comes from the clean `frame:pop` the next executed
          // step's transition emits. And it never paints over a ✗, the one
          // status a run must not lose (`skipPaintsOver`).
          const target = this.targetUriFor(uri, ev.frame);
          if (skipPaintsOver(this.tracker.state(target).statuses.get(ev.line))) {
            // The reason as the line's detail, so the hover can say WHY this
            // line is blank — the run log is the only other place it exists,
            // and it scrolls.
            this.tracker.setStatus(target, ev.line, 'skip', stepFailureDetail({ error: ev.reason }));
          }
          break;
        }
        case 'step:fail': {
          const target = this.targetUriFor(uri, ev.frame);
          // Pin the failure text to the line: the ✗ hover and the panel's
          // step row read it back from the tracker. When the failure came out
          // of the step's code-behind (strict replay, `step.expect`, or a
          // heal whose AI attempt failed too) the detail says so.
          const failureDetail = stepFailureDetail(ev);
          // A TOLERATED failure paints amber and stops there
          // (stories/step-failure-outcomes.md, decision 6). Each omission below is
          // load-bearing: the frame did NOT fail, so the `[skill:]` invocation line
          // must not go red and `frame:pop` must still paint it ✓; the Variables
          // panel must not offer "re-run from the failed step", there being no
          // parked failure; and nothing may park a breakpoint stop, because a
          // yellow ▶ on a step the run is past offers a Continue that re-runs it.
          if (ev.tolerated) {
            // Never over a real ✗, the one status a run must not lose
            // (`toleratedPaintsOver`, failure-outcome-core.ts) — reachable
            // whenever one source line runs twice, as a loop body does.
            if (toleratedPaintsOver(this.tracker.state(target).statuses.get(ev.line))) {
              this.rememberTolerated(target, ev.line, failureDetail);
              this.tracker.setStatus(target, ev.line, 'fail-tolerated', failureDetail);
            }
            break;
          }
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
            this.clearStatusesFor(frameUri);
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
            //
            // "Pass" is the call line's remembered `</>` / ⚠ when a guard put
            // one there this run — a section tail's frame sits on its guard's
            // line, and a plain ✓ would erase how the decision was made along
            // with the ⚠'s hover (guard-mark-core.ts). Plain ✓ otherwise.
            if (!result.failed) {
              const { testUri, testLine } = result.root;
              const mark = this.guardMarks.forFramePop(testUri.toString(), testLine);
              this.tracker.setStatus(testUri, testLine, mark.status, mark.detail);
            }
          }
          break;
        }
        case 'frame:scope': {
          // Phase 4 — pipe the scope payload into the controller's
          // per-frame map. The Variables view subscribes via the
          // registry's onAnyScopeChange bridge.
          //
          // `bindings` and `unmask` travel with it, spread conditionally so a
          // field the server did not send stays UNDEFINED rather than becoming
          // an empty array. The difference is the whole contract: `[]` means
          // "this run bound nothing", which makes a dotted name the author's
          // and masks `user.apikey`, while absent means "an older server said
          // nothing", which leaves the maskers on their pre-wire reading
          // (docs/specs/SPEC-structured-table-reads.md §7.6).
          const controller = this.controllers.get(uri.toString());
          controller?.handleFrameScope(ev.frameId, ev.scope, {
            ...(ev.bindings !== undefined && { bindings: ev.bindings }),
            ...(ev.unmask !== undefined && { unmask: ev.unmask }),
          });
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
    // ▶ while a step runs, then ✓ / </> / ⚠ / ✗ by how it ended. What they
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
        case 'step:pass': {
          // A compile of a file with a chain is allowed — its steps run at
          // most once — and the Record run emits `step:pass output:'skipped'`
          // for the untaken branch. Same rule as the run gutter above: the
          // step did not run, so it is not a ✓, and like a `step:skip` it
          // never paints over a ✗.
          // The same `passMarkFor` the run gutter above paints with.
          const skipped = isSkippedPass(ev);
          const mark = passMarkFor(ev, skipped);
          const current = this.tracker.state(uri).statuses.get(ev.line);
          if (skipped && !skipPaintsOver(current)) {
            break;
          }
          // Same amber-survives-a-pass rule as the run gutter above: a Record and
          // each Replay round repaint the same lines, so without this the round
          // after a tolerated failure would erase it.
          if (!passPaintsOver(current)) break;
          this.tracker.setStatus(
            uri,
            ev.line,
            mark.status,
            mark.detail ? stepFailureDetail(mark.detail) : undefined,
          );
          break;
        }
        case 'step:fail':
          // A Replay's red step is the compile's whole point (strict mode:
          // broken code fails instead of healing) — pin the error so the ✗
          // says what the code did wrong.
          //
          // A TOLERATED one is amber here too: on a proving replay it is neither
          // proven nor failed (decision 11), and red would say the entry is broken
          // when the tail is doing exactly what it says.
          if (ev.tolerated) {
            if (toleratedPaintsOver(this.tracker.state(uri).statuses.get(ev.line))) {
              this.tracker.setStatus(uri, ev.line, 'fail-tolerated', stepFailureDetail(ev));
            }
            break;
          }
          this.tracker.setStatus(uri, ev.line, 'fail', stepFailureDetail(ev));
          break;
        case 'step:skip':
          // A compile's run can return too — an entry that calls
          // `step.exit()`, or the AI step it was generated from. The replay
          // then never reaches the rest of that flow, which is why such a
          // compile ends `partial` rather than green
          // (stories/step-flow-control.md, decision 12). Painted here so the
          // gutter says which lines the round never got to, instead of
          // leaving last run's marks standing.
          if (skipPaintsOver(this.tracker.state(uri).statuses.get(ev.line))) {
            this.tracker.setStatus(uri, ev.line, 'skip', stepFailureDetail({ error: ev.reason }));
          }
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

  /** `clearStepPaused` for a caller outside the router: Record Steps ending
   *  ONE test's paused run, where Stop's `clearAllStepPausedMarkers` would
   *  also wipe other tests' markers. */
  clearStepPausedFor(controllerUri: vscode.Uri): void {
    this.clearStepPaused(controllerUri);
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
      // A run that just ended is where a failing row set comes from, and
      // *Re-run Failed Rows* is gated on there being one.
      this.refreshFailedRowsContext();
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

  /** Mirror of the last value pushed to `testbench-native.hasFailedRows` —
   *  the ACTIVE file's, since the palette entry acts on the active file. */
  private lastFailedRowsContextValue = false;

  /**
   * Publish whether the active file's last run left a failing row, so
   * *Re-run Failed Rows* appears in the palette on exactly the files where it
   * would do something. Deduped like the other keys: this is recomputed on
   * every editor switch and every run edge.
   */
  refreshFailedRowsContext(): void {
    const controller = this.active();
    const value = controller !== undefined && controller.failedRowsToRerun !== null;
    if (value === this.lastFailedRowsContextValue) return;
    this.lastFailedRowsContextValue = value;
    void vscode.commands.executeCommand(
      'setContext',
      'testbench-native.hasFailedRows',
      value,
    );
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
    this.recorder.dispose();
    this.compileTailSignals.dispose();
    this.trackerSub.dispose();
    this.editSub.dispose();
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
  /** Every data table in a document, with the header summary the decoration
   *  renders and the status now on each row line. Built from the same scan and
   *  the same summary function the decoration pass uses — the rendered
   *  after-text cannot be read back from the extension host, so a test that
   *  reimplemented the counting would pass while the header was wrong. */
  rowTablesForTests: (uri: vscode.Uri) => Array<{
    /** The section's name as authored, or null for the table under `## Steps`. */
    section: string | null;
    headerLine: number;
    rowLines: number[];
    statuses: Array<string | null>;
    summary: string;
  }>;
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
  /** The Copilot bridge's listener state, bound port and served-request count. */
  lmBridgeStatus: () => BridgeStatus;
  /** Swap the `vscode.lm` namespace the bridge (and the setup command) calls,
   *  and shorten the EADDRINUSE standby retry so the adopt is observable inside
   *  a test's timeout. A real `vscode.lm` in the harness would need a signed-in
   *  Copilot seat and would spend it. `imagePart` forces the image path; see
   *  LmBridge.configureForTests. */
  configureLmBridge: (opts: LmBridgeTestOptions) => void;
  /** The bridge token, so a test can present the header a real client would.
   *  Minting it here is not a side effect the suite has to undo: it is the same
   *  SecretStorage entry the extension would mint on first use, inside the
   *  harness's own user-data-dir. */
  lmBridgeToken: () => Promise<string>;
  /** Re-read the bridge settings now, instead of waiting on the configuration
   *  event. Returns once the listen attempt has settled. */
  syncLmBridge: () => Promise<void>;
  /** Record Steps: the panel's Recording block as the host holds it, or null
   *  when nothing is recording (stories/testbench-record-steps.md). */
  recordingState: () => import('ai-ui-automation-runner-core').RecordingPanelState | null;
  /** Record Steps: the status bar text while recording, or null. */
  recordingStatusText: () => string | null;
  /** Record Steps: how the last recording ended and what the author was told
   *  — notifications are not readable from the extension host. */
  recordingReport: () => RecordingReport | null;
  /** Record Steps: why the last Record gesture was refused, or null. */
  recordingRefusal: () => string | null;
  /** Record Steps: settles when the current recording, insertion included,
   *  is over. */
  recordingSettled: () => Promise<void>;
}

export interface TestBenchExports {
  __testHooks?: TestBenchTestHooks;
}

/**
 * Was this extension host launched by the integration harness?
 *
 * `TESTBENCH_TEST_REPORT` is the path Mocha's JSON reporter writes to. Both
 * runners set it (tests/integration/runTest.cjs, runLiveTest.cjs), the suite
 * entry reads it, and nothing in a user's VS Code does — which makes it the
 * one signal available to `activate()` that distinguishes a test host from a
 * real window. Checked at activation rather than per hook: the whole surface
 * is either present or absent, so there is no half-exposed shape for a caller
 * to probe.
 */
function underIntegrationHarness(): boolean {
  return (process.env['TESTBENCH_TEST_REPORT'] ?? '') !== '';
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

  // Copilot bridge (stories/copilot-lm-bridge.md). Constructed always, started
  // only when the User-scoped `lmBridge.enabled` says so — a window that never
  // opted in opens no listener and shows no status bar item.
  const lmBridge = new LmBridge(context);

  /**
   * Fire-and-forget `sync()`, with the rejection handled.
   *
   * `sync()` settles for every state it models — disabled, standby, a port it
   * refuses — so this catch is for the one it does not: an unmodelled failure on
   * a call nobody awaits is otherwise an unhandled rejection, which stops
   * nothing and tells no one. The bridge's own channel, so the line lands next
   * to the `lm-bridge:` lines a user is already reading.
   */
  const syncLmBridge = (): void => {
    void lmBridge.sync().catch((err: unknown) => {
      out.appendLine(
        `[${ts()}] lm-bridge: sync failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

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
    // How to read that scope — the `bindings` / `unmask` that arrived on the
    // same event. Read through the controller so it always describes the
    // frame `currentScope` just returned.
    currentMasking: () => registry.runningController()?.currentScopeMasking() ?? {},
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
    lmBridge,
    ...registerLmBridgeCommands(lmBridge),
    // Both bridge settings take effect immediately. The port especially: it is
    // baked into every `.env` the setup command has written, so a change that
    // waited for a window reload would leave those files pointing at a port
    // nothing is serving.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('testbench-native.lmBridge')) syncLmBridge();
    }),
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

  // Not awaited: activation must not block on a socket, and a bridge that ends
  // up in standby behind another window is a normal outcome, not a failure.
  syncLmBridge();

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

  // Withheld outside the harness. `exports` is readable by any co-installed
  // extension through `vscode.extensions.getExtension(...)`, and these hooks are
  // not merely diagnostic: `lmBridgeToken` hands out the bearer token that
  // guards the Copilot bridge, and `configureLmBridge` swaps the `vscode.lm`
  // namespace the bridge calls — between them, everything needed to spend
  // somebody's Copilot seat or read what is being sent to it.
  if (!underIntegrationHarness()) return {};

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
      rowTablesForTests: (uri: vscode.Uri) => {
        // The REAL table scan and the REAL summary function, against the same
        // snapshot the decoration pass reads — so a regression in either turns
        // this test red. The rendered after-text itself cannot be read back.
        const snap = tracker.snapshotFor(uri) ?? tracker.snapshot();
        const statusByLine = new Map(snap.statuses);
        return dataTablesOf(snap.text).map((table) => ({
          section: table.section,
          headerLine: table.headerLine,
          rowLines: [...table.rowLines],
          statuses: table.rowLines.map((line) => statusByLine.get(line) ?? null),
          summary: rowHeaderSummary(
            table.rowLines.map((line) => statusByLine.get(line)),
            table.kind,
          ),
        }));
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
      lmBridgeStatus: () => lmBridge.status(),
      configureLmBridge: (opts) => lmBridge.configureForTests(opts),
      lmBridgeToken: () => lmBridge.ensureToken(),
      syncLmBridge: () => lmBridge.sync(),
      recordingState: () => registry.recorder.state,
      recordingStatusText: () => registry.recorder.statusText,
      recordingReport: () => registry.recorder.lastReport,
      recordingRefusal: () => registry.recorder.lastRefusal,
      recordingSettled: () => registry.recorder.settled,
    },
  };
}

/**
 * Every row of the named table, read out of the document as it is NOW — the
 * ▷ Run all rows selection.
 *
 * `null` when that table has no rows (it was deleted, or it no longer parses),
 * which the caller reports rather than sending: an empty `rows` is not a
 * narrowing, and would silently run the whole file.
 */
function allRowsOf(
  controller: { document: vscode.TextDocument },
  table: 'run' | { section: string },
): { rows?: number[]; sectionRows?: Record<string, number[]> } | null {
  const section = typeof table === 'object' ? table.section : null;
  const rows = allRowsOfTable(controller.document.getText(), section);
  if (rows.length === 0) return null;
  return section === null ? { rows } : { sectionRows: { [section]: rows } };
}

async function handleWebviewMessage(
  msg: WebviewToHostMsg,
  registry: RunControllerRegistry,
  tracker: ActiveFileTracker,
): Promise<void> {
  switch (msg.type) {
    case 'ready':
      // Tracker.onChange already pushed a snapshot. A panel rebuilt mid-
      // recording has lost its Recording block, though, and nothing else
      // would re-send it until the next action.
      registry.recorder.republish();
      return;
    // Record Steps (stories/testbench-record-steps.md). Delegated to the
    // commands, like Stop and Pause below, so the panel and the editor title
    // bar are one implementation each.
    case 'recordSteps':
      await vscode.commands.executeCommand('testbench-native.recordSteps');
      return;
    case 'recordNewTest':
      await vscode.commands.executeCommand('testbench-native.recordNewTest');
      return;
    case 'recordStop':
      await vscode.commands.executeCommand('testbench-native.stopRecording');
      return;
    case 'recordCancel':
      await vscode.commands.executeCommand('testbench-native.cancelRecording');
      return;
    case 'recordCheck':
      await vscode.commands.executeCommand('testbench-native.recordAddCheck');
      return;
    case 'recordDrop':
      // Shown at once and sent as `drop` / `restore` (decision 9: redraft now).
      await registry.recorder.setDropped(msg.id, msg.dropped === true);
      return;
    case 'run': {
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      // With nothing picked in the panel, `lines` is the EDITOR highlight
      // (`snapshot.selectedLines`), data-row lines included. Split them the
      // way `runSelected` does, or the rows are dropped as non-steps and the
      // highlighted steps run for every row of the table.
      const text = controller.document.getText();
      const split = splitRowSelection(text, msg.lines);
      const refusal = rowSelectionRefusal(text, split);
      if (refusal) {
        void vscode.window.showWarningMessage(refusal);
        return;
      }
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      void controller
        .runLines(split.lines, {
          breakpoints,
          ...(split.rows && { rows: split.rows }),
          ...(split.sectionRows && { sectionRows: split.sectionRows }),
        })
        .finally(() => registry.notifyRunning(false));
      return;
    }
    case 'runRows': {
      // The panel's Rows section and its ▷ Run all rows land here. Wrapped
      // exactly like `run`: the row axis narrows what runs, it does not change
      // what a run IS.
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      // ▷ Run all rows names the TABLE, not the numbers on screen — the same
      // rule ↻ Re-run failed follows, and for the same reason: the panel's
      // list came from a `rows` message that may predate an edit to the table,
      // so a row added since would be the one row "run all" left out.
      const selection = msg.all === undefined ? msg : allRowsOf(controller, msg.all);
      if (selection === null) {
        vscode.window.setStatusBarMessage(
          'TestBench: that table has no rows any more',
          2500,
        );
        return;
      }
      const refusal = rowSelectionRefusal(controller.document.getText(), selection);
      if (refusal) {
        void vscode.window.showWarningMessage(refusal);
        return;
      }
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      void controller
        .runLines(msg.all === undefined ? (msg.lines ?? []) : [], {
          breakpoints,
          ...(selection.rows && { rows: selection.rows }),
          ...(selection.sectionRows && { sectionRows: selection.sectionRows }),
        })
        .finally(() => registry.notifyRunning(false));
      return;
    }
    case 'rerunFailedRows': {
      // The panel's ↻ button names the TABLE, not the rows: its own `rows`
      // message can be a run old, and re-running a remembered number would
      // run whatever row now sits in that position. The host answers from the
      // file as it is, through the same `failedRowsToRerun` the palette
      // command uses, so the two cannot pick different rows.
      const controller = registry.active();
      if (!controller) return notifyNoActive();
      const failed = controller.failedRowsToRerun;
      const section = typeof msg.table === 'object' ? msg.table.section : null;
      const rows =
        section === null
          ? failed?.rows
          : failed?.sectionRows?.[section];
      if (!rows || rows.length === 0) {
        vscode.window.setStatusBarMessage(
          'TestBench: no failing rows in that table any more',
          2500,
        );
        return;
      }
      const selection = section === null ? { rows } : { sectionRows: { [section]: rows } };
      const breakpoints = tracker.breakpoints(controller.document.uri);
      registry.notifyRunning(true);
      void controller
        .runLines([], { breakpoints, ...selection })
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
