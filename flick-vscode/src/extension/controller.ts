// FlickController owns all extension-host state and the bridge to the webview
// surfaces: the session list, per-session history, connectivity polling, and
// the handlers for every WebviewToHost message.
//
// Flick can be shown on more than one surface at once — the editor-tab panel
// (FlickPanel) and the sidebar view (FlickSidebarProvider), both in panel.ts.
// Each attached webview is tracked independently; host state is broadcast to
// every webview that has finished booting, so the surfaces stay in sync.

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ApiError, SessionsApiClient } from './api-client';
import { Store } from './store';
import { readSettings, writeSettings } from './settings';
import { parseSteps } from '../shared/parse-steps';
import {
  DEFAULT_CDP_PORTS,
  discoverCdpPorts as realDiscoverCdpPorts,
} from './cdp-discovery';
import {
  detectInstalled as realDetectInstalled,
  launchBrowserWithCdp as realLaunchBrowserWithCdp,
  type CdpLaunchEngine,
  type InstalledBinaries,
  type LaunchOptions,
  type LaunchResult,
} from './browser-launcher';
import type { StepsRequestConfig } from './api-client';
import type {
  BatchResult,
  CdpDiscoveryPort,
  CdpInstalledBrowsers,
  ConnectionStatus,
  HistoryEntry,
  HostToWebview,
  ServerSessionItem,
  SessionMeta,
  StepResult,
  WebviewToHost,
} from '../shared/protocol';

const IDLE_PING_MS = 15_000;
const BUSY_PING_MS = 4_000;
/** Background failures kept for diagnosis; older ones are dropped so a
 *  long-lived controller that keeps failing does not grow without bound. */
const MAX_BACKGROUND_FAILURES = 20;

interface Attachment {
  readonly webview: vscode.Webview;
  readonly listener: vscode.Disposable;
  /** A webview only receives broadcasts once it has booted and sent `ready`. */
  ready: boolean;
  /** Set when "open settings" was requested before this webview was ready. */
  showSettingsOnReady: boolean;
}

/** Injection points for CDP discovery and browser-launching. Tests stub these
 *  to drive the controller without touching the real machine. Mirrors the
 *  `__testSetApiClient` pattern but is constructor-injected so the
 *  controller has the deps it needs from boot rather than mid-flight. */
export interface CdpDeps {
  /** Port list to scan when discoverCdp fires. Default DEFAULT_CDP_PORTS. */
  ports?: readonly number[];
  discoverCdpPorts?: typeof realDiscoverCdpPorts;
  detectInstalled?: typeof realDetectInstalled;
  launchBrowserWithCdp?: (opts: LaunchOptions) => Promise<LaunchResult>;
}

export class FlickController {
  private api: SessionsApiClient;
  private sessions: SessionMeta[] = [];
  private activeSessionId: string | null = null;
  private readonly busy = new Set<string>();
  private connection: ConnectionStatus = 'unknown';

  private readonly attachments = new Map<vscode.Webview, Attachment>();
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  /** Detached async work started by this controller — webview message
   *  handlers, stale checks, connectivity pings. See {@link track}. */
  private readonly inflight = new Set<Promise<void>>();
  /** What that work threw, oldest first — the most recent
   *  {@link MAX_BACKGROUND_FAILURES} of it. Still non-fatal, but kept rather than
   *  dropped: a test waiting for a message the failed work would have posted
   *  can then say why it never came, instead of only that it timed out. */
  private readonly backgroundFailures: unknown[] = [];

  private cdpPorts: readonly number[];
  private cdpDiscover: typeof realDiscoverCdpPorts;
  private cdpDetectInstalled: typeof realDetectInstalled;
  private cdpLaunch: (opts: LaunchOptions) => Promise<LaunchResult>;
  /** Originals captured at construction so `__testSetCdpDeps(null)` can fully
   *  restore production behaviour mid-process. The non-live VS Code suite
   *  spans multiple test files against ONE activated controller, so any test
   *  that overrides a dep must also be able to put it back. */
  private readonly cdpDefaults: Readonly<Required<{
    ports: readonly number[];
    discoverCdpPorts: typeof realDiscoverCdpPorts;
    detectInstalled: typeof realDetectInstalled;
    launchBrowserWithCdp: (opts: LaunchOptions) => Promise<LaunchResult>;
  }>>;

  constructor(
    private readonly store: Store,
    cdpDeps?: CdpDeps,
  ) {
    this.api = new SessionsApiClient(readSettings());
    this.cdpPorts = cdpDeps?.ports ?? DEFAULT_CDP_PORTS;
    this.cdpDiscover = cdpDeps?.discoverCdpPorts ?? realDiscoverCdpPorts;
    this.cdpDetectInstalled = cdpDeps?.detectInstalled ?? realDetectInstalled;
    this.cdpLaunch = cdpDeps?.launchBrowserWithCdp ?? realLaunchBrowserWithCdp;
    this.cdpDefaults = {
      ports: this.cdpPorts,
      discoverCdpPorts: this.cdpDiscover,
      detectInstalled: this.cdpDetectInstalled,
      launchBrowserWithCdp: this.cdpLaunch,
    };
  }

  async start(): Promise<void> {
    await this.store.init();
    this.sessions = await this.store.loadSessions();
    if (this.sessions.length > 0) {
      this.activeSessionId = this.sessions[0].id;
    }
    this.schedulePing(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    for (const att of this.attachments.values()) att.listener.dispose();
    this.attachments.clear();
  }

  /** Run a fire-and-forget task, keeping a handle on it so {@link drain} can
   *  wait for it. Replaces bare `void this.x()`: the work is still detached
   *  from its caller and a failure is still non-fatal, but it is no longer
   *  invisible — which is what let a write outlive the thing that started it. */
  private track(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      (err: unknown) => {
        this.backgroundFailures.push(err);
        if (this.backgroundFailures.length > MAX_BACKGROUND_FAILURES) this.backgroundFailures.shift();
      },
    );
    this.inflight.add(settled);
    void settled.finally(() => this.inflight.delete(settled));
  }

  /** Resolve once every task started by {@link track} has settled.
   *
   *  `dispose()` stops NEW work starting; this waits for work already in
   *  flight. Callers that delete the Store's directory must do both, in that
   *  order — otherwise a `saveHistory()` still in its writeFile/rename pair
   *  lands after the directory is gone, and the resulting rejection surfaces
   *  against whatever runs next. Draining can itself let a handler start more
   *  work, so loop until the set is genuinely empty. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  // --- webview lifecycle ---------------------------------------------------

  attachWebview(webview: vscode.Webview): void {
    const listener = webview.onDidReceiveMessage((msg: WebviewToHost) => {
      this.track(this.handleMessage(msg, webview));
    });
    this.attachments.set(webview, {
      webview,
      listener,
      ready: false,
      showSettingsOnReady: false,
    });
  }

  detachWebview(webview: vscode.Webview): void {
    const att = this.attachments.get(webview);
    if (!att) return;
    att.listener.dispose();
    this.attachments.delete(webview);
  }

  /** Called when the VS Code `flick.*` configuration changes. */
  onSettingsChanged(): void {
    const settings = readSettings();
    this.api.update(settings);
    this.post({ type: 'settings', settings });
    this.schedulePing(0);
  }

  // Test-only accessors. Kept on the controller (not gated by a flag) so the
  // @vscode/test-electron suite can drive the host without forking production
  // behaviour. None of these are wired into the production extension surface.
  get __testSessions(): readonly SessionMeta[] {
    return this.sessions;
  }
  get __testActiveSessionId(): string | null {
    return this.activeSessionId;
  }
  /** Failures of detached work started by {@link track}, oldest first. */
  get __testBackgroundFailures(): readonly unknown[] {
    return this.backgroundFailures;
  }
  /** Replace the API client wholesale — e.g. to point at a fake HTTP server. */
  __testSetApiClient(client: SessionsApiClient): void {
    this.api = client;
  }
  /** Override any subset of the CDP dependency seams after construction.
   *  Symmetric with `__testSetApiClient`; useful when a test needs to bind
   *  to a fake browser server whose port isn't known until after start().
   *  Pass `null` to restore every dep to its construction-time default —
   *  required for the non-live VS Code suite, which runs many `.test.cjs`
   *  files against ONE activated extension and must not leak overrides
   *  between cases. */
  __testSetCdpDeps(deps: CdpDeps | null): void {
    if (deps === null) {
      this.cdpPorts = this.cdpDefaults.ports;
      this.cdpDiscover = this.cdpDefaults.discoverCdpPorts;
      this.cdpDetectInstalled = this.cdpDefaults.detectInstalled;
      this.cdpLaunch = this.cdpDefaults.launchBrowserWithCdp;
      return;
    }
    if (deps.ports) this.cdpPorts = deps.ports;
    if (deps.discoverCdpPorts) this.cdpDiscover = deps.discoverCdpPorts;
    if (deps.detectInstalled) this.cdpDetectInstalled = deps.detectInstalled;
    if (deps.launchBrowserWithCdp) this.cdpLaunch = deps.launchBrowserWithCdp;
  }
  /** Feed a message into the controller as if it came from `webview`. */
  async __testDispatch(webview: vscode.Webview, msg: WebviewToHost): Promise<void> {
    await this.handleMessage(msg, webview);
  }
  /** Every webview currently attached to this controller. */
  get __testAttachedWebviews(): vscode.Webview[] {
    return [...this.attachments.keys()];
  }

  // --- commands (invoked from the command palette / view title) ------------

  async commandNewSession(): Promise<void> {
    await this.createSession();
  }

  openSettingsInUi(): void {
    // Deliver to every webview that is ready now; webviews still booting get
    // it flushed when their `ready` message arrives.
    for (const att of this.attachments.values()) {
      if (att.ready) this.postShowSettings(att.webview);
      else att.showSettingsOnReady = true;
    }
  }

  private postShowSettings(webview: vscode.Webview): void {
    this.postTo(webview, { type: 'settings', settings: readSettings() });
    this.postTo(webview, { type: 'showSettings' });
  }

  // --- message handling ----------------------------------------------------

  private async handleMessage(msg: WebviewToHost, webview: vscode.Webview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.handleReady(webview);
        break;
      case 'newSession':
        await this.createSession();
        break;
      case 'switchSession':
        await this.switchSession(msg.sessionId);
        break;
      case 'renameSession':
        await this.renameSession(msg.sessionId, msg.name);
        break;
      case 'deleteSession':
        await this.deleteSession(msg.sessionId);
        break;
      case 'requestHistory':
        await this.sendHistory(msg.sessionId, webview);
        break;
      case 'submitSteps':
        await this.submitSteps(msg.sessionId, msg.rawText);
        break;
      case 'openSettings':
        // no-op; the webview drives its own settings panel — kept for symmetry
        break;
      case 'saveSettings':
        await writeSettings(msg.settings);
        // onSettingsChanged fires via the configuration listener and re-posts.
        break;
      case 'listServerSessions':
        await this.handleListServerSessions(webview);
        break;
      case 'adoptServerSession':
        await this.adoptServerSession(msg.item);
        break;
      case 'discoverCdp':
        await this.handleDiscoverCdp(webview);
        break;
      case 'adoptCdpTab':
        await this.adoptCdpTab(msg.port, msg.targetId, msg.title, msg.url);
        break;
      case 'newTabInCdp':
        await this.newTabInCdp(msg.port);
        break;
      case 'launchBrowserCdp':
        await this.launchBrowserCdp(msg.engine, msg.port, webview);
        break;
    }
  }

  // --- adopt-server-session flow ------------------------------------------

  private async handleListServerSessions(webview: vscode.Webview): Promise<void> {
    try {
      const sessions = await this.api.listSessions();
      this.postTo(webview, { type: 'serverSessions', sessions, error: null });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      this.postTo(webview, { type: 'serverSessions', sessions: null, error: message });
    }
  }

  /**
   * Attach an existing server session as a local tab. If a local tab already
   * represents this server id, just activate it — never duplicate. Newly
   * adopted sessions are marked `used: true` so the SPEC-FLICK "send config
   * only on the first request" rule treats them as already-initialized.
   */
  private async adoptServerSession(item: ServerSessionItem): Promise<void> {
    const existing = this.sessions.find((s) => s.id === item.sessionId);
    if (existing) {
      this.activeSessionId = existing.id;
      this.postSessions();
      await this.sendHistory(existing.id);
      return;
    }
    const session: SessionMeta = {
      id: item.sessionId,
      name: deriveAdoptedName(item),
      order: this.sessions.length,
      stale: false,
      used: true,
    };
    this.sessions.push(session);
    this.activeSessionId = session.id;
    await this.persistSessions();
    await this.store.saveHistory(session.id, []);
    this.postSessions();
    await this.sendHistory(session.id);
  }

  // --- CDP discovery / adoption / launch ----------------------------------

  private async handleDiscoverCdp(webview: vscode.Webview): Promise<void> {
    // Discovery + install detection are independent network/fs probes; run
    // them in parallel along with the persisted lastLaunched read.
    const [ports, installed, lastLaunched] = await Promise.all([
      this.cdpDiscover(this.cdpPorts),
      Promise.resolve(this.cdpDetectInstalled()),
      this.store.loadCdpLastLaunched(),
    ]);
    this.postTo(webview, this.buildCdpDiscoveryMessage(ports, installed, lastLaunched));
  }

  private buildCdpDiscoveryMessage(
    ports: CdpDiscoveryPort[],
    installed: InstalledBinaries,
    lastLaunched: 'chrome' | 'edge' | null,
  ): HostToWebview {
    const payload: CdpInstalledBrowsers = {
      chrome: !!installed.chrome,
      edge: !!installed.edge,
      lastLaunched,
    };
    return { type: 'cdpDiscovery', ports, installed: payload };
  }

  /**
   * Adopt an existing CDP tab as a new local session. Dedupe by
   * `{port, targetId}` — re-adopting the same tab just activates the
   * existing local session, matching `adoptServerSession`'s behaviour.
   * Unlike server-session adoption, `used: false` so the first submit
   * carries the CDP hint through to the runner.
   */
  private async adoptCdpTab(
    port: number,
    targetId: string,
    title?: string,
    url?: string,
  ): Promise<void> {
    const tab = `targetId:${targetId}`;
    const existing = this.sessions.find(
      (s) => s.cdp?.port === port && s.cdp?.tab === tab,
    );
    if (existing) {
      this.activeSessionId = existing.id;
      this.postSessions();
      await this.sendHistory(existing.id);
      return;
    }
    const session: SessionMeta = {
      id: crypto.randomUUID(),
      name: deriveCdpName(title, url),
      order: this.sessions.length,
      stale: false,
      used: false,
      cdp: { port, tab },
    };
    this.sessions.push(session);
    this.activeSessionId = session.id;
    await this.persistSessions();
    await this.store.saveHistory(session.id, []);
    this.postSessions();
    await this.sendHistory(session.id);
  }

  /** Each "+ New tab in this X" click should spawn a fresh local session
   *  even when one for the same port already exists — no dedupe here. The
   *  runner opens the tab on attach and closes it at teardown. */
  private async newTabInCdp(port: number): Promise<void> {
    const session: SessionMeta = {
      id: crypto.randomUUID(),
      name: deriveCdpName(undefined, undefined),
      order: this.sessions.length,
      stale: false,
      used: false,
      cdp: { port, tab: 'new' },
    };
    this.sessions.push(session);
    this.activeSessionId = session.id;
    await this.persistSessions();
    await this.store.saveHistory(session.id, []);
    this.postSessions();
    await this.sendHistory(session.id);
  }

  private async launchBrowserCdp(
    engine: CdpLaunchEngine,
    port: number,
    _webview: vscode.Webview,
  ): Promise<void> {
    const profileDir = this.resolveCdpProfileDir(engine);
    const result = await this.cdpLaunch({ engine, port, profileDir });
    // Broadcast both outcomes so every attached webview (sidebar + editor
    // panel) clears its per-engine "Launching…" state, not just the one that
    // sent the click.
    if (!result.ok) {
      this.post({
        type: 'cdpLaunchResult',
        engine,
        ok: false,
        error: result.error ?? 'Unknown error',
      });
      return;
    }
    await this.store.saveCdpLastLaunched(engine);
    this.post({ type: 'cdpLaunchResult', engine, ok: true, port });
    // Re-discover so the freshly spawned browser's tabs surface immediately
    // across every webview without the user clicking the refresh button.
    const [ports, installed, lastLaunched] = await Promise.all([
      this.cdpDiscover(this.cdpPorts),
      Promise.resolve(this.cdpDetectInstalled()),
      this.store.loadCdpLastLaunched(),
    ]);
    this.post(this.buildCdpDiscoveryMessage(ports, installed, lastLaunched));
  }

  private resolveCdpProfileDir(engine: CdpLaunchEngine): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return path.join(folder.uri.fsPath, '.flick', `${engine}-profile`);
    // No workspace open (single-file mode) — fall back to the store's base
    // dir so we still have a writeable, per-installation profile.
    return path.join(this.store.baseDir, 'cdp-profiles', engine);
  }

  private async handleReady(webview: vscode.Webview): Promise<void> {
    const att = this.attachments.get(webview);
    if (!att) return;
    await this.sendInit(webview);
    att.ready = true;
    if (att.showSettingsOnReady) {
      att.showSettingsOnReady = false;
      this.postShowSettings(webview);
    }
  }

  private async sendInit(webview: vscode.Webview): Promise<void> {
    this.postTo(webview, {
      type: 'init',
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
      settings: readSettings(),
      connection: this.connection,
    });
    if (this.activeSessionId) {
      await this.sendHistory(this.activeSessionId, webview);
      this.track(this.checkStale(this.activeSessionId));
    }
  }

  // --- session management --------------------------------------------------

  private async createSession(): Promise<void> {
    const session: SessionMeta = {
      id: crypto.randomUUID(),
      name: 'New Session',
      order: this.sessions.length,
      stale: false,
      used: false,
    };
    this.sessions.push(session);
    this.activeSessionId = session.id;
    await this.persistSessions();
    await this.store.saveHistory(session.id, []);
    this.postSessions();
    await this.sendHistory(session.id);
  }

  private async switchSession(sessionId: string): Promise<void> {
    if (!this.sessions.some((s) => s.id === sessionId)) return;
    this.activeSessionId = sessionId;
    this.postSessions();
    await this.sendHistory(sessionId);
    this.track(this.checkStale(sessionId));
  }

  private async renameSession(sessionId: string, name: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const trimmed = name.trim();
    session.name = trimmed.length > 0 ? trimmed : 'New Session';
    await this.persistSessions();
    this.postSessions();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    // SPEC-FLICK: confirmation before deleting. Use VS Code's native modal —
    // the idiomatic equivalent of the spec's confirmation dialog.
    const choice = await vscode.window.showWarningMessage(
      `Delete "${session.name}"? This will close the browser session.`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') return;

    // Best-effort: tell the server to close the browser. Failure here must not
    // block the local cleanup (the server may already be gone).
    if (session.used && !session.stale) {
      try {
        await this.api.submitSteps(sessionId, ['Close the browser'], null);
      } catch {
        // ignore — local removal proceeds regardless
      }
    }

    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.sessions.forEach((s, i) => (s.order = i));
    this.busy.delete(sessionId);
    await this.persistSessions();
    await this.store.deleteSessionData(sessionId);

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
    }
    this.postSessions();
    if (this.activeSessionId) {
      await this.sendHistory(this.activeSessionId);
    }
    // With no sessions left, the webview's `sessions` handler renders the
    // empty state on its own — no history message needed.
  }

  // --- step submission -----------------------------------------------------

  private async submitSteps(sessionId: string, rawText: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const steps = parseSteps(rawText);
    if (steps.length === 0) return;

    // Guard against a double-submit (two messages racing in before the `busy`
    // round-trip reaches the webview): a concurrent run would reload the same
    // history snapshot and clobber this batch's entries on save.
    if (this.busy.has(sessionId)) {
      this.post({
        type: 'toast',
        level: 'info',
        message: 'Steps are still running for this session.',
      });
      return;
    }

    const history = await this.store.loadHistory(sessionId);

    // Echo the user's input immediately as a user-message card.
    const userEntry: HistoryEntry = {
      kind: 'user',
      id: crypto.randomUUID(),
      ts: Date.now(),
      text: rawText.trim(),
    };
    history.push(userEntry);

    // A pending placeholder that the result card will replace.
    const pendingId = crypto.randomUUID();
    const pendingEntry: HistoryEntry = { kind: 'pending', id: pendingId, ts: Date.now() };
    history.push(pendingEntry);

    await this.store.saveHistory(sessionId, history);
    this.post({ type: 'historyAppend', sessionId, entry: userEntry });
    this.post({ type: 'historyAppend', sessionId, entry: pendingEntry });

    this.busy.add(sessionId);
    this.post({ type: 'busy', sessionId, busy: true });
    this.schedulePing(0);

    // SPEC-FLICK: send config only on the first request for a session.
    // For CDP-adopted sessions the `cdp` hint is also first-request-only,
    // gated by the same `!session.used` rule — so a non-null config may be
    // required even when baseUrl/timeout are both empty.
    const settings = readSettings();
    let config: StepsRequestConfig | null = null;
    if (!session.used) {
      const out: StepsRequestConfig = {};
      if (settings.defaultBaseUrl) out.baseUrl = settings.defaultBaseUrl;
      if (settings.defaultTimeout) out.timeout = settings.defaultTimeout;
      if (session.cdp) {
        out.cdp = { port: session.cdp.port, tab: session.cdp.tab };
      }
      if (out.baseUrl || out.timeout || out.cdp) config = out;
    }

    let resultEntry: HistoryEntry;
    try {
      const raw = await this.api.submitSteps(sessionId, steps, config);
      const results: StepResult[] = [];
      for (let i = 0; i < raw.results.length; i++) {
        const r = raw.results[i];
        const screenshotPath = await this.store.saveScreenshot(sessionId, i, r.screenshot);
        results.push({
          step: r.step,
          status: r.status,
          actions: r.actions ?? [],
          reasoning: r.reasoning ?? '',
          outputs: r.outputs ?? {},
          screenshotUri: screenshotPath,
        });
      }
      const batch: BatchResult = {
        status: raw.status,
        stepsCompleted: raw.stepsCompleted,
        stepsTotal: raw.stepsTotal,
        results,
        outputs: raw.outputs ?? {},
        // Pass provenance through when the server supplies it; older servers
        // omit `outputSources` entirely, so leave it undefined in that case.
        outputSources: raw.outputSources,
        error: raw.error ?? null,
      };
      resultEntry = { kind: 'result', id: pendingId, ts: Date.now(), batch };
      session.used = true;
      session.stale = false;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      resultEntry = {
        kind: 'result',
        id: pendingId,
        ts: Date.now(),
        batch: {
          status: 'error',
          stepsCompleted: 0,
          stepsTotal: steps.length,
          results: [],
          outputs: {},
          error: { step: 0, message },
        },
      };
      this.post({ type: 'toast', level: 'error', message });
    } finally {
      this.busy.delete(sessionId);
      this.post({ type: 'busy', sessionId, busy: false });
      this.schedulePing(0);
    }

    // Replace the pending placeholder with the result entry, both on disk and
    // in every attached webview.
    const finalHistory = await this.store.loadHistory(sessionId);
    const idx = finalHistory.findIndex((e) => e.id === pendingId);
    if (idx >= 0) finalHistory[idx] = resultEntry;
    else finalHistory.push(resultEntry);
    await this.store.saveHistory(sessionId, finalHistory);
    await this.persistSessions();

    this.post({ type: 'historyReplace', sessionId, entryId: pendingId, entry: resultEntry });
  }

  // --- history -------------------------------------------------------------

  /** Send a session's history. Targets one webview when `target` is given
   *  (the `ready`/`requestHistory` reply path), otherwise broadcasts. */
  private async sendHistory(sessionId: string, target?: vscode.Webview): Promise<void> {
    const entries = await this.store.loadHistory(sessionId);
    const msg: HostToWebview = { type: 'history', sessionId, entries };
    if (target) this.postTo(target, msg);
    else this.post(msg);
  }

  /** Rewrites on-disk screenshot file paths into URIs the given webview can
   *  load. Webview URIs are per-webview, so this runs once per target. */
  private webviewize(entry: HistoryEntry, webview: vscode.Webview): HistoryEntry {
    if (entry.kind !== 'result') return entry;
    return {
      ...entry,
      batch: {
        ...entry.batch,
        results: entry.batch.results.map((r) => ({
          ...r,
          screenshotUri: r.screenshotUri
            ? webview.asWebviewUri(vscode.Uri.file(r.screenshotUri)).toString()
            : null,
        })),
      },
    };
  }

  // --- stale-session detection --------------------------------------------

  private async checkStale(sessionId: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || !session.used) return;
    const state = await this.api.sessionState(sessionId);
    if (state === 'missing' && !session.stale) {
      session.stale = true;
      await this.persistSessions();
      this.postSessions();
    } else if (state === 'active' && session.stale) {
      session.stale = false;
      await this.persistSessions();
      this.postSessions();
    }
  }

  // --- connectivity polling -----------------------------------------------

  private schedulePing(delayMs: number): void {
    if (this.disposed) return;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => this.track(this.ping()), delayMs);
  }

  private async ping(): Promise<void> {
    if (this.disposed) return;
    const ok = await this.api.ping();
    const next: ConnectionStatus = ok ? 'connected' : 'disconnected';
    if (next !== this.connection) {
      const previous = this.connection;
      this.connection = next;
      this.post({ type: 'connection', connection: next });
      if (previous !== 'unknown') {
        this.post({
          type: 'toast',
          level: next === 'connected' ? 'info' : 'error',
          message: next === 'connected' ? 'Connected to server' : 'Cannot connect to server',
        });
      }
    }
    this.schedulePing(this.busy.size > 0 ? BUSY_PING_MS : IDLE_PING_MS);
  }

  // --- helpers -------------------------------------------------------------

  private postSessions(): void {
    this.post({
      type: 'sessions',
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
    });
  }

  private async persistSessions(): Promise<void> {
    this.sessions.forEach((s, i) => (s.order = i));
    await this.store.saveSessions(this.sessions);
  }

  /** Broadcast to every webview that has finished booting. */
  private post(msg: HostToWebview): void {
    for (const att of this.attachments.values()) {
      if (att.ready) void att.webview.postMessage(this.localizeForWebview(msg, att.webview));
    }
  }

  /** Send to one webview regardless of its `ready` flag — used for the `init`
   *  burst that answers a webview's own `ready` message. */
  private postTo(webview: vscode.Webview, msg: HostToWebview): void {
    void webview.postMessage(this.localizeForWebview(msg, webview));
  }

  /** Rewrites on-disk screenshot paths in entry-bearing messages into URIs the
   *  target webview can load; other message types pass through unchanged. */
  private localizeForWebview(msg: HostToWebview, webview: vscode.Webview): HostToWebview {
    if (msg.type === 'history') {
      return { ...msg, entries: msg.entries.map((e) => this.webviewize(e, webview)) };
    }
    if (msg.type === 'historyAppend' || msg.type === 'historyReplace') {
      return { ...msg, entry: this.webviewize(msg.entry, webview) };
    }
    return msg;
  }
}

/**
 * Pick the most human-readable label for an adopted session tab. Prefers the
 * page title (truncated), falls back to the URL host, then a short id.
 */
function deriveAdoptedName(item: ServerSessionItem): string {
  const title = item.pageTitle?.trim();
  if (title) return title.length > 32 ? `${title.slice(0, 31)}…` : title;
  if (item.currentUrl) {
    try {
      return new URL(item.currentUrl).host || item.currentUrl;
    } catch {
      return item.currentUrl;
    }
  }
  return `Session ${item.sessionId.slice(0, 8)}`;
}

/**
 * Pick a label for a CDP-adopted session tab. Prefers the discovered page
 * title, then the URL host, then a literal "CDP tab" — mirrors the spirit
 * of deriveAdoptedName but cannot fall back to a session id since CDP
 * sessions are id'd by random UUID, which carries no information.
 */
function deriveCdpName(title: string | undefined, url: string | undefined): string {
  const t = title?.trim();
  if (t) return t.length > 32 ? `${t.slice(0, 31)}…` : t;
  if (url) {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  }
  return 'CDP tab';
}
