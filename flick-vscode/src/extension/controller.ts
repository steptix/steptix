// FlickController owns all extension-host state and the bridge to the webview:
// the session list, per-session history, connectivity polling, and the handlers
// for every WebviewToHost message. The WebviewViewProvider (panel.ts) is a thin
// shell that forwards lifecycle events here.

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { ApiError, SessionsApiClient } from './api-client';
import { Store } from './store';
import { readSettings, writeSettings } from './settings';
import { parseSteps } from '../shared/parse-steps';
import type {
  BatchResult,
  ConnectionStatus,
  HistoryEntry,
  HostToWebview,
  SessionMeta,
  StepResult,
  WebviewToHost,
} from '../shared/protocol';

const IDLE_PING_MS = 15_000;
const BUSY_PING_MS = 4_000;

export class FlickController {
  private readonly api: SessionsApiClient;
  private sessions: SessionMeta[] = [];
  private activeSessionId: string | null = null;
  private readonly busy = new Set<string>();
  private connection: ConnectionStatus = 'unknown';

  private webview: vscode.Webview | null = null;
  private webviewListener: vscode.Disposable | undefined;
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly store: Store) {
    this.api = new SessionsApiClient(readSettings());
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
    this.webviewListener?.dispose();
  }

  // --- webview lifecycle ---------------------------------------------------

  attachWebview(webview: vscode.Webview): void {
    this.webview = webview;
    this.webviewListener?.dispose();
    this.webviewListener = webview.onDidReceiveMessage((msg: WebviewToHost) => {
      void this.handleMessage(msg);
    });
  }

  detachWebview(): void {
    this.webviewListener?.dispose();
    this.webviewListener = undefined;
    this.webview = null;
  }

  /** Called when the VS Code `flick.*` configuration changes. */
  onSettingsChanged(): void {
    const settings = readSettings();
    this.api.update(settings);
    this.post({ type: 'settings', settings });
    this.schedulePing(0);
  }

  // --- commands (invoked from the command palette / view title) ------------

  async commandNewSession(): Promise<void> {
    await this.createSession();
  }

  async openSettingsInUi(): Promise<void> {
    await vscode.commands.executeCommand('flick.chat.focus');
    this.post({ type: 'settings', settings: readSettings() });
    this.post({ type: 'showSettings' });
  }

  // --- message handling ----------------------------------------------------

  private async handleMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.sendInit();
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
        await this.sendHistory(msg.sessionId);
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
    }
  }

  private async sendInit(): Promise<void> {
    this.post({
      type: 'init',
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
      settings: readSettings(),
      connection: this.connection,
    });
    if (this.activeSessionId) {
      await this.sendHistory(this.activeSessionId);
      void this.checkStale(this.activeSessionId);
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
    void this.checkStale(sessionId);
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
    this.post({ type: 'historyAppend', sessionId, entry: this.webviewize(userEntry) });
    this.post({ type: 'historyAppend', sessionId, entry: pendingEntry });

    this.busy.add(sessionId);
    this.post({ type: 'busy', sessionId, busy: true });
    this.schedulePing(0);

    // SPEC-FLICK: send config only on the first request for a session.
    const settings = readSettings();
    const config =
      !session.used && (settings.defaultBaseUrl || settings.defaultTimeout)
        ? { baseUrl: settings.defaultBaseUrl, timeout: settings.defaultTimeout }
        : null;

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
    // in the webview.
    const finalHistory = await this.store.loadHistory(sessionId);
    const idx = finalHistory.findIndex((e) => e.id === pendingId);
    if (idx >= 0) finalHistory[idx] = resultEntry;
    else finalHistory.push(resultEntry);
    await this.store.saveHistory(sessionId, finalHistory);
    await this.persistSessions();

    this.post({
      type: 'historyReplace',
      sessionId,
      entryId: pendingId,
      entry: this.webviewize(resultEntry),
    });
  }

  // --- history -------------------------------------------------------------

  private async sendHistory(sessionId: string): Promise<void> {
    const entries = await this.store.loadHistory(sessionId);
    this.post({
      type: 'history',
      sessionId,
      entries: entries.map((e) => this.webviewize(e)),
    });
  }

  /** Rewrites on-disk screenshot file paths into webview-resolvable URIs. */
  private webviewize(entry: HistoryEntry): HistoryEntry {
    if (entry.kind !== 'result' || !this.webview) return entry;
    const webview = this.webview;
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
    this.pingTimer = setTimeout(() => void this.ping(), delayMs);
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

  private post(msg: HostToWebview): void {
    this.webview?.postMessage(msg);
  }
}
