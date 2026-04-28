import * as vscode from 'vscode';
import {
  ApiClient,
  ApiClientError,
  EnvParseError,
  classifySelectedSteps,
  extractSteps,
  interpretReplCommand,
  maskIfSecret,
  parseConfig,
  parseParameters,
  readEnvFile,
  reportError,
  resolveEnvFile,
  resolveSection,
  type ClassifiedStep,
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
  /**
   * True once a run has succeeded for this controller's session. Subsequent
   * F5s skip the `config` field in the request body, since the server only
   * accepts config on the first request. Reset by `closeSession`.
   */
  private configSentForSession = false;
  /** Resolver for the currently open prompt, if any. */
  private pendingPrompt: { resolve: (text: string | null) => void } | null = null;

  constructor(private readonly ctx: RunContext) {}

  get isRunning(): boolean {
    return this.active !== null;
  }

  get lastEnvPath(): string | null {
    return this.lastResolvedEnvPath;
  }

  stop(): void {
    // Cancel any open prompt first so the run-loop unblocks immediately.
    this.cancelPrompt();
    this.active?.abort();
  }

  /** Called by the editor-provider when the webview submits text. */
  resolvePrompt(text: string): void {
    const p = this.pendingPrompt;
    this.pendingPrompt = null;
    if (p) p.resolve(text);
  }

  /** Called by the editor-provider when the user clicks Cancel. */
  cancelPrompt(): void {
    const p = this.pendingPrompt;
    this.pendingPrompt = null;
    if (p) p.resolve(null);
  }

  /**
   * Tell the server to drop this session and close its browser. Safe to call
   * even when no run is in flight. Returns once the DELETE has been issued
   * (best-effort — the server may already be gone).
   */
  async closeSession(): Promise<void> {
    const out = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);

    // Resolve env just to get SERVER_URL + SERVER_API_KEY. Anything missing
    // is silently ignored — we want close to be cheap and forgiving.
    const settings = vscode.workspace.getConfiguration('testbench');
    const fallbackSetting = settings.get<string>('defaultEnvFile') ?? '';
    const filePath = this.ctx.document.uri.fsPath;

    const envResolution = await resolveEnvFile({
      testFile: filePath,
      workspaceRoot: this.ctx.workspaceFolder.uri.fsPath,
      fallbackPath: fallbackSetting,
    });
    if (!envResolution.hit) return;

    let env: Record<string, string>;
    try {
      env = await readEnvFile(envResolution.path);
    } catch {
      return;
    }
    const serverUrl = env['SERVER_URL']?.trim();
    const apiKey = env['SERVER_API_KEY']?.trim();
    if (!serverUrl || !apiKey) return;

    out.appendLine(`[${ts()}] closing server session for ${filePath}`);
    this.active?.abort();

    const client = new ApiClient({ serverUrl, apiKey });
    await client.closeSession(filePath);
    // Reset so the next F5 sends config to recreate the session.
    this.configSentForSession = false;
    out.appendLine(`[${ts()}] session closed`);
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

    // 4. Classify the requested lines into normal steps / [input:] / [interactive].
    const text = this.ctx.document.getText();
    const classified = classifySelectedSteps(text, lines);
    if (classified.length === 0) {
      const payload = reportError('TB021', {});
      return this.fail(payload, log);
    }

    // Parse Config / Parameters from the test file. $VAR references in
    // values are resolved against the loaded .env so secrets stay out of
    // the file under source control.
    const rawConfig = parseConfig(text);
    const rawParameters = parseParameters(text);
    const resolvedParameters = resolveSection(rawParameters, env);
    const sessionConfig: { baseUrl?: string; timeout?: string } = {};
    const baseUrl = rawConfig['baseUrl'];
    if (baseUrl) sessionConfig.baseUrl = resolveValue(baseUrl, env);
    const timeout = rawConfig['timeout'];
    if (timeout) sessionConfig.timeout = resolveValue(timeout, env);

    log(
      `running ${classified.length} item(s) on ${serverUrl}` +
        (sessionConfig.baseUrl ? ` baseUrl=${sessionConfig.baseUrl}` : '') +
        (Object.keys(resolvedParameters).length > 0
          ? ` parameters=[${Object.keys(resolvedParameters).join(',')}]`
          : ''),
    );

    const sessionId = filePath;
    const client = new ApiClient({ serverUrl, apiKey });
    const ac = new AbortController();
    this.active = ac;

    // Mutable parameters bag — `[input:]` answers get folded in here as the
    // run progresses, so subsequent steps can reference them.
    const params: Record<string, string> = { ...resolvedParameters };
    let anyFailed = false;

    try {
      let i = 0;
      while (i < classified.length) {
        if (ac.signal.aborted) break;
        const item = classified[i]!;

        if (item.kind === 'step') {
          // Take the largest contiguous block of normal steps starting at i
          // and send it as a single streamSteps request.
          const block: ClassifiedStep[] = [];
          while (i < classified.length && classified[i]!.kind === 'step') {
            block.push(classified[i]!);
            i++;
          }
          const ok = await this.runStepBlock({
            block,
            client,
            sessionId,
            env,
            params,
            sessionConfig,
            signal: ac.signal,
            log,
          });
          if (!ok) {
            anyFailed = true;
            break;
          }
          continue;
        }

        if (item.kind === 'input') {
          log(`prompt input on line ${item.line} → {{${item.varName}}}`);
          const answer = await this.requestPrompt({
            mode: 'input',
            message: item.prompt,
            varName: item.varName,
          });
          if (answer === null) {
            log(`input on line ${item.line} canceled — aborting run`);
            break;
          }
          params[item.varName] = answer;
          this.postOutput(`✎ ${item.varName} ← ${maskIfSecret(item.varName, answer)}`, 'info');
          i++;
          continue;
        }

        if (item.kind === 'interactive') {
          log(`interactive on line ${item.line}: ${item.hint}`);
          const exitedCleanly = await this.runInteractive({
            hint: item.hint,
            client,
            sessionId,
            env,
            params,
            sessionConfig,
            signal: ac.signal,
            log,
          });
          if (!exitedCleanly) break;
          i++;
          continue;
        }
      }

      // Mark config as sent so the next F5 reuses the existing session.
      this.configSentForSession = true;

      // Final `done` for the webview's "running" state. Status reflects
      // whether anything failed.
      const status: 'passed' | 'failed' | 'aborted' =
        ac.signal.aborted ? 'aborted' : anyFailed ? 'failed' : 'passed';
      this.post({ type: 'runEvent', event: { type: 'done', status } });
      log(`run ${status}`);
      return { ok: !anyFailed };
    } catch (err) {
      const payload = mapApiErrorToPayload(err, { serverUrl, envPath: envResolution.path });
      this.post({ type: 'runEvent', event: { type: 'done', status: 'error' } });
      return this.fail(payload, log);
    } finally {
      this.active = null;
      // Belt-and-braces — if a prompt was somehow still open, drop it.
      this.cancelPrompt();
      this.post({ type: 'promptDone' });
    }
  }

  // -------------------------------------------------------------------------
  // State-machine helpers
  // -------------------------------------------------------------------------

  /** Run a contiguous block of normal steps. Returns false if we should stop. */
  private async runStepBlock(args: {
    block: ClassifiedStep[];
    client: ApiClient;
    sessionId: string;
    env: Record<string, string>;
    params: Record<string, string>;
    sessionConfig: { baseUrl?: string; timeout?: string };
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<boolean> {
    const { block, client, sessionId, env, params, sessionConfig, signal, log } = args;
    const includeConfig = !this.configSentForSession;
    const stepInstructions = block.map((b) => (b.kind === 'step' ? b.instruction : ''));
    const stepLines = block.map((b) => b.line);

    try {
      const events = client.streamSteps(
        sessionId,
        {
          steps: stepInstructions,
          sourceLines: stepLines,
          env,
          ...(includeConfig && Object.keys(sessionConfig).length > 0 && {
            config: sessionConfig,
          }),
          ...(Object.keys(params).length > 0 && { parameters: params }),
        },
        signal,
      );

      let sawFail = false;
      for await (const event of events) {
        log(`event ${event.type}${'line' in event ? ` line=${event.line}` : ''}`);
        if (event.type === 'step:fail') sawFail = true;
        // Suppress the per-block 'done' — the outer loop emits one final
        // 'done' for the whole run.
        if (event.type === 'done') continue;
        this.post({ type: 'runEvent', event });
      }
      // After the first successful block, the server has the session.
      this.configSentForSession = true;
      return !sawFail;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Run the interactive REPL: keep the composer open, treat each user
   * submission as a single ad-hoc step (or REPL command). Returns true if
   * the user exited cleanly (`done` / `exit`), false to abort the whole run.
   */
  private async runInteractive(args: {
    hint: string;
    client: ApiClient;
    sessionId: string;
    env: Record<string, string>;
    params: Record<string, string>;
    sessionConfig: { baseUrl?: string; timeout?: string };
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<boolean> {
    const { hint, client, sessionId, env, params, sessionConfig, signal, log } = args;

    // Open the composer once. Subsequent loops re-await without re-posting.
    const firstAnswer = await this.requestPrompt({ mode: 'interactive', message: hint });
    let answer: string | null = firstAnswer;

    while (answer !== null) {
      if (signal.aborted) return false;

      const action = interpretReplCommand(answer, () =>
        listStepInstructions(this.ctx.document.getText()),
      );

      if (action.kind === 'exit-section') return true;
      if (action.kind === 'quit-run') return false;

      if (action.kind === 'output') {
        this.postOutput(action.msg, action.level);
      } else if (action.kind === 'send-step') {
        log(`interactive step: ${action.text}`);
        this.postOutput(`> ${action.text}`, 'info');
        try {
          const events = client.streamSteps(
            sessionId,
            {
              steps: [action.text],
              sourceLines: [0],
              env,
              ...(!this.configSentForSession &&
                Object.keys(sessionConfig).length > 0 && { config: sessionConfig }),
              ...(Object.keys(params).length > 0 && { parameters: params }),
            },
            signal,
          );
          for await (const event of events) {
            if (event.type === 'done') continue;
            this.post({ type: 'runEvent', event });
          }
          this.configSentForSession = true;
        } catch (err) {
          this.postOutput(
            `interactive step errored: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        }
      }
      // action.kind === 'noop' — fall through and re-prompt.

      // Re-arm the prompt for the next submission.
      answer = await this.requestPrompt({ mode: 'interactive', message: hint });
    }
    // Cancel — abort the whole run.
    return false;
  }

  /**
   * Show the composer in the webview and resolve once the user submits or
   * cancels. Returns null if canceled (or if a prior prompt is still open,
   * which shouldn't happen in normal flow).
   */
  private requestPrompt(opts: {
    mode: 'input' | 'interactive';
    message: string;
    varName?: string;
  }): Promise<string | null> {
    if (this.pendingPrompt) {
      // Defensive — a previous prompt was never resolved. Drop it.
      this.pendingPrompt.resolve(null);
      this.pendingPrompt = null;
    }
    return new Promise<string | null>((resolve) => {
      this.pendingPrompt = { resolve };
      this.post({
        type: 'prompt',
        mode: opts.mode,
        message: opts.message,
        ...(opts.varName !== undefined && { varName: opts.varName }),
      });
    });
  }

  private postOutput(msg: string, kind: 'info' | 'warn' | 'error'): void {
    this.post({ type: 'runEvent', event: { type: 'output', msg, kind } });
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

function listStepInstructions(text: string): string {
  return extractSteps(text)
    .map((s) => `  ${s.line.toString().padStart(3, ' ')}  ${s.instruction}`)
    .join('\n');
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

/** Resolve a `$VAR` reference against env, or return the literal value. */
function resolveValue(value: string, env: Record<string, string>): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  return env[name] ?? value;
}
