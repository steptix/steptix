import * as vscode from 'vscode';
import {
  ApiClient,
  ApiClientError,
  EnvParseError,
  extractSteps,
  readEnvFile,
  reportError,
  resolveEnvFile,
  type ErrorPayload,
  type HostToWebviewMsg,
  type RunEvent,
} from 'ai-ui-automation-runner-core';
import { getOutputChannel } from './output-channel.js';

/** A run-context is one document opened in one editor. */
export interface RunContext {
  document: vscode.TextDocument;
  webview: vscode.Webview;
  workspaceFolder: vscode.WorkspaceFolder;
}

/** Outcome reported back to callers — used by tests + commands. */
export interface RunOutcome {
  ok: boolean;
  error?: ErrorPayload;
}

/**
 * One controller per open editor. Owns the abort controller for the active
 * run; refuses to start a second run while one is in flight.
 *
 * All error paths funnel through `reportError(...)` so the user-facing
 * payload is built from a single source of truth.
 */
export class RunController {
  private active: AbortController | null = null;
  /** Last resolved .env path — exposed for the "Reveal .env" command. */
  private lastResolvedEnvPath: string | null = null;

  constructor(private readonly ctx: RunContext) {}

  get isRunning(): boolean {
    return this.active !== null;
  }

  get lastEnvPath(): string | null {
    return this.lastResolvedEnvPath;
  }

  stop(): void {
    this.active?.abort();
  }

  /** Send the `init` message to the webview after it reports ready. */
  sendInit(wordWrap: boolean): void {
    this.post({
      type: 'init',
      text: this.ctx.document.getText(),
      wordWrap,
      filePath: this.ctx.document.uri.fsPath,
    });
  }

  async runLines(lines: number[]): Promise<RunOutcome> {
    if (this.isRunning) {
      return { ok: false };
    }

    const out = getOutputChannel();
    const log = (line: string) => out.appendLine(`[${timestamp()}] ${line}`);

    const filePath = this.ctx.document.uri.fsPath;
    log(`run requested for ${filePath}: lines=[${lines.join(',')}]`);

    // 1. Resolve .env (walk-up + fallback)
    const settings = vscode.workspace.getConfiguration('testbench');
    const fallbackSetting = settings.get<string>('defaultEnvFile') ?? '';

    const envResolution = await resolveEnvFile({
      testFile: filePath,
      workspaceRoot: this.ctx.workspaceFolder.uri.fsPath,
      fallbackPath: fallbackSetting,
    });

    if (!envResolution.hit) {
      log(`.env not found. Searched: ${envResolution.searchedDirs.join(' → ')}; fallback: "${envResolution.fallbackPath || 'unset'}"`);
      const payload = reportError('TB001', {
        searchedDirs: envResolution.searchedDirs,
        fallbackSetting: fallbackSetting,
      });
      this.lastResolvedEnvPath = null;
      return this.fail(payload, log);
    }

    log(`.env resolved (${envResolution.source}): ${envResolution.path}`);
    this.lastResolvedEnvPath = envResolution.path;

    // 2. Parse .env
    let env: Record<string, string>;
    try {
      env = await readEnvFile(envResolution.path);
    } catch (err) {
      if (err instanceof EnvParseError) {
        const payload = reportError('TB005', {
          envPath: envResolution.path,
          lineNumber: err.lineNumber,
          line: err.line,
        });
        log(`TB005 ${payload.diagnosis}`);
        return this.fail(payload, log);
      }
      throw err;
    }

    // 3. Validate required keys + URL
    if (!env['SERVER_URL'] || env['SERVER_URL'].trim() === '') {
      const payload = reportError('TB002', { envPath: envResolution.path });
      return this.fail(payload, log);
    }
    const serverUrl = env['SERVER_URL'].trim();
    try {
      new URL(serverUrl);
    } catch {
      const payload = reportError('TB004', { envPath: envResolution.path, value: serverUrl });
      return this.fail(payload, log);
    }
    if (!env['SERVER_API_KEY'] || env['SERVER_API_KEY'].trim() === '') {
      const payload = reportError('TB003', { envPath: envResolution.path });
      return this.fail(payload, log);
    }
    const apiKey = env['SERVER_API_KEY'].trim();

    // 4. Extract step instructions for the requested lines
    const text = this.ctx.document.getText();
    const allSteps = extractStepsForRun(text, lines);
    if (allSteps.length === 0) {
      const payload = reportError('TB021', {});
      return this.fail(payload, log);
    }

    log(`running ${allSteps.length} step(s) on ${serverUrl}`);

    // 5. Stream events
    const sessionId = filePath;
    const client = new ApiClient({ serverUrl, apiKey });
    const ac = new AbortController();
    this.active = ac;

    try {
      const events = client.streamSteps(
        sessionId,
        {
          steps: allSteps.map((s) => s.instruction),
          sourceLines: allSteps.map((s) => s.line),
          env,
        },
        ac.signal,
      );

      for await (const event of events) {
        log(`event ${event.type}${'line' in event ? ` line=${event.line}` : ''}`);
        this.post({ type: 'runEvent', event });
      }

      log(`run completed`);
      return { ok: true };
    } catch (err) {
      const payload = mapApiErrorToPayload(err, { serverUrl, envPath: envResolution.path });
      // Tell the webview the run is over (so the UI can clear "running" state).
      this.post({ type: 'runEvent', event: { type: 'done', status: 'error' } as RunEvent });
      return this.fail(payload, log);
    } finally {
      this.active = null;
    }
  }

  /** Run every step in the document. */
  async runAll(): Promise<RunOutcome> {
    // Empty `lines` triggers extractStepsForRun's "everything" branch.
    return this.runLines([]);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private post(msg: HostToWebviewMsg): void {
    void this.ctx.webview.postMessage(msg);
  }

  private fail(payload: ErrorPayload, log: (line: string) => void): RunOutcome {
    log(`${payload.code} ${payload.diagnosis}. ${payload.fix}`);
    this.post({ type: 'runError', payload });
    return { ok: false, error: payload };
  }
}

/**
 * Pick the steps to actually send. When `requestedLines` is empty, return
 * every step in the document. Otherwise, return only the steps whose source
 * line is in the set, preserving document order.
 */
function extractStepsForRun(
  text: string,
  requestedLines: number[],
): { line: number; instruction: string }[] {
  const all = extractSteps(text);
  if (requestedLines.length === 0) return all;
  const set = new Set(requestedLines);
  return all.filter((s) => set.has(s.line));
}

function mapApiErrorToPayload(
  err: unknown,
  ctx: { serverUrl: string; envPath: string },
): ErrorPayload {
  if (err instanceof ApiClientError) {
    switch (err.kind) {
      case 'unauthorized':
        return reportError('TB011', { envPath: ctx.envPath, serverUrl: ctx.serverUrl });
      case 'not-found':
        return reportError('TB012', { serverUrl: ctx.serverUrl });
      case 'server-error':
        return reportError('TB013', {
          serverUrl: ctx.serverUrl,
          status: err.status ?? 0,
          ...(err.bodyExcerpt && { bodyExcerpt: err.bodyExcerpt }),
        });
      case 'stream-dropped':
        return reportError('TB014', { serverUrl: ctx.serverUrl, reason: err.message });
      case 'aborted':
        // User-initiated stop is not a real error — fold into a benign code.
        return reportError('TB014', { serverUrl: ctx.serverUrl, reason: 'aborted by user' });
      case 'connect-failed':
      default:
        return reportError('TB010', { serverUrl: ctx.serverUrl, reason: err.message });
    }
  }
  const reason = err instanceof Error ? err.message : String(err);
  return reportError('TB010', { serverUrl: ctx.serverUrl, reason });
}

function timestamp(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}
