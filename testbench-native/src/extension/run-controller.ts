import * as vscode from 'vscode';
import {
  ApiClient,
  ApiClientError,
  EnvParseError,
  isUserAbort,
  classifySelectedSteps,
  extractSteps,
  resolveRunLines,
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
import { EnvSelector } from './env-selector.js';

/**
 * Subset of the ApiClient surface we depend on. Defining it lets tests
 * inject a fake that scripts the event stream without spinning up the
 * real Sessions API server. The default factory still hands back a real
 * `new ApiClient(...)` for production use.
 */
export interface ApiClientLike {
  streamSteps(
    sessionId: string,
    request: unknown,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent>;
  closeSession(sessionId: string): Promise<void>;
}

export type ApiClientFactory = (config: { serverUrl: string; apiKey: string }) => ApiClientLike;

/** Default factory — the real one. */
export const defaultApiClientFactory: ApiClientFactory = (config) => new ApiClient(config);

/** Outcome reported back to callers — used by tests + commands. */
export interface RunOutcome {
  ok: boolean;
  error?: ErrorPayload;
}

/**
 * One controller per .md test document. Owns the abort controller for the
 * active run; refuses to start a second run while one is in flight.
 *
 * The extension keeps a Map<URI, RunController> in run-controller-registry,
 * lazily creating controllers as files are opened. Each controller posts
 * run events to a `post` callback (which routes to the sidebar webview).
 */
export class RunController {
  private active: AbortController | null = null;
  private lastResolvedEnvPath: string | null = null;
  private configSentForSession = false;
  private pendingPrompt: { resolve: (text: string | null) => void } | null = null;
  /** Set by pause() so the abort handler knows to mark a resume point
   *  rather than treating the abort as a full Stop. */
  private pauseRequested = false;
  /** Line of the most recent step:start event in the current run. Used as
   *  the resume point when the user pauses mid-step. */
  private lastStepStartLine: number | null = null;
  /** False until the first runLines call clears any stale server session
   *  for this file. VS Code reloads create a fresh controller but the
   *  server still has the previous session keyed on the file path — left
   *  unattended, the server can short-circuit the new run with an instant
   *  `done` and no step events, which the runner misreads as "all steps
   *  passed" and pins the pause indicator on the breakpoint line without
   *  any preceding step having actually run. Closing on first use gives a
   *  clean slate; subsequent runs in the same activation reuse the
   *  session as intended. */
  private staleSessionCleared = false;
  /** Per-run event listener, set by runLines via options.onEvent and
   *  cleared in finally. Batch runners hook this to drive TestRun results
   *  without having to subscribe to the host→webview message channel. */
  private currentEventListener: ((event: RunEvent) => void) | null = null;

  constructor(
    public readonly document: vscode.TextDocument,
    public readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly post: (msg: HostToWebviewMsg) => void,
    private readonly clientFactory: ApiClientFactory = defaultApiClientFactory,
  ) {}

  get isRunning(): boolean {
    return this.active !== null;
  }

  get lastEnvPath(): string | null {
    return this.lastResolvedEnvPath;
  }

  stop(): void {
    this.pauseRequested = false;
    this.cancelPrompt();
    this.active?.abort();
  }

  /** Post a run event to the webview AND notify any registered per-run
   *  event listener. Used by every code path that emits step:start /
   *  step:pass / step:fail / output / capture / done. */
  private emitRunEvent(event: RunEvent): void {
    this.post({ type: 'runEvent', event });
    this.currentEventListener?.(event);
  }

  /**
   * Halt the run mid-flight without abandoning it. Aborts the current
   * stream (same mechanism as stop) but flips a flag so the abort handler
   * publishes a `breakpointStop` at the line that was executing, leaving
   * the runner in `paused` state. The user can then Resume to pick up
   * from there. No-op if no run is in flight.
   */
  pause(): void {
    if (!this.active) return;
    this.pauseRequested = true;
    this.cancelPrompt();
    this.active.abort();
  }

  resolvePrompt(text: string): void {
    const p = this.pendingPrompt;
    this.pendingPrompt = null;
    if (p) p.resolve(text);
  }

  cancelPrompt(): void {
    const p = this.pendingPrompt;
    this.pendingPrompt = null;
    if (p) p.resolve(null);
  }

  /**
   * Tell the server to drop this session and close its browser.
   */
  async closeSession(): Promise<void> {
    const out = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);

    const settings = vscode.workspace.getConfiguration('testbench');
    const fallbackSetting = settings.get<string>('defaultEnvFile') ?? '';
    const filePath = this.document.uri.fsPath;

    const envResolution = await resolveEnvFile({
      testFile: filePath,
      workspaceRoot: this.workspaceFolder.uri.fsPath,
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

    const client = this.clientFactory({ serverUrl, apiKey });
    await client.closeSession(filePath);
    this.configSentForSession = false;
    out.appendLine(`[${ts()}] session closed`);
  }

  async runLines(
    lines: number[],
    options: {
      breakpoints?: Set<number>;
      skipBreakpointAtStart?: boolean;
      /** Batch / Test Explorer mode. Interactive `[input: ...]` and
       *  `[interactive]` steps cannot prompt the user in a batch, so we
       *  short-circuit them as step:fail events. */
      batchMode?: boolean;
      /** Force a fresh session before this run. Batch mode uses this for
       *  per-test isolation; single-file flow leaves it false so sessions
       *  are reused within a TestBench session. */
      forceFreshSession?: boolean;
      /** Env name to send to the server (selects `data/<name>.json` etc).
       *  When omitted, falls back to `EnvSelector.activeEnv()`. */
      envOverride?: string | null;
      /** Hook for batch runners to observe every RunEvent emitted during
       *  this call (step:start, step:pass, step:fail, output, capture,
       *  done). Receives events in flight order. */
      onEvent?: (event: RunEvent) => void;
    } = {},
  ): Promise<RunOutcome> {
    if (this.isRunning) {
      return { ok: false };
    }

    // Clear any stale pause indicator IMMEDIATELY — synchronously, before
    // we do any async env-file work. If we waited until after env resolution
    // (~50-200ms on Windows), the user would see the yellow ▶ from the
    // previous pause linger at that line while the new run boots, which
    // reads as "the arrow jumped straight to the breakpoint."
    this.post({ type: 'breakpointStop', line: null });

    // First run on this controller? Close any session the server may still
    // be holding from a previous VS Code session — see staleSessionCleared
    // doc comment for full reasoning. Best-effort: a missing .env, a
    // server outage, or no existing session all just no-op here, and the
    // run that follows surfaces the real error if there is one.
    //
    // Batch mode opts into forceFreshSession to give every test a clean
    // slate; that path bypasses the first-run-only gate.
    const forceFresh = options.forceFreshSession === true;
    if (forceFresh || !this.staleSessionCleared) {
      this.staleSessionCleared = true;
      try {
        await this.closeSession();
      } catch {
        // Swallow — cleanup must not block the run.
      }
    }

    // Hook the per-run event listener (batch runner uses this to drive
    // TestRun pass/fail). Cleared in finally so it never leaks across runs.
    this.currentEventListener = options.onEvent ?? null;

    const breakpoints = options.breakpoints ?? new Set<number>();
    const skipFirstBreakpoint = options.skipBreakpointAtStart === true;

    const out = getOutputChannel();
    const log = (line: string) => out.appendLine(`[${timestamp()}] ${line}`);

    const filePath = this.document.uri.fsPath;
    log(`run requested for ${filePath}: lines=[${lines.join(',')}]`);

    const settings = vscode.workspace.getConfiguration('testbench');
    const fallbackSetting = settings.get<string>('defaultEnvFile') ?? '';

    const envResolution = await resolveEnvFile({
      testFile: filePath,
      workspaceRoot: this.workspaceFolder.uri.fsPath,
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

    const text = this.document.getText();
    const effectiveLines = resolveRunLines(text, lines);
    const allClassified = classifySelectedSteps(text, effectiveLines);
    if (allClassified.length === 0) {
      const payload = reportError('TB021', {});
      return this.fail(payload, log);
    }

    // Trim the run at the first breakpoint we encounter (skipping the very
    // first item when resuming). The pause line is reported back via the
    // `breakpointStop` message so the gutter shows the yellow ▶ arrow.
    const { runnable: classified, pausedAt } = trimAtBreakpoint(
      allClassified,
      breakpoints,
      skipFirstBreakpoint,
    );

    // Stale pause was already cleared at the top of runLines. The *new*
    // pause indicator (if any) is posted only when execution actually
    // reaches the pause point — putting the yellow ▶ on the breakpoint
    // line before the steps before it have run reads as "we're already
    // there" instead of "we will pause here."
    if (pausedAt !== null) {
      log(`⏸ Will pause before breakpoint on line ${pausedAt} — Resume to continue`);
    }

    if (classified.length === 0) {
      // Hit a breakpoint on the first selected step — nothing to send to
      // the server. We *are* immediately at the pause point, so post the
      // indicator now and treat it as a successful "paused at start"
      // outcome.
      if (pausedAt !== null) this.post({ type: 'breakpointStop', line: pausedAt });
      this.emitRunEvent({ type: 'done', status: 'aborted' });
      return { ok: true };
    }

    const rawConfig = parseConfig(text);
    const rawParameters = parseParameters(text);
    const resolvedParameters = resolveSection(rawParameters, env);
    const sessionConfig: { baseUrl?: string; timeout?: string } = {};
    const baseUrl = rawConfig['baseUrl'];
    if (baseUrl) sessionConfig.baseUrl = resolveValue(baseUrl, env);
    const timeout = rawConfig['timeout'];
    if (timeout) sessionConfig.timeout = resolveValue(timeout, env);

    const logging = resolveLoggingOverride(rawConfig, settings);

    if (Object.keys(resolvedParameters).length > 0) {
      this.post({ type: 'parametersResolved', values: { ...resolvedParameters } });
    }

    log(
      `running ${classified.length} item(s) on ${serverUrl}` +
        (sessionConfig.baseUrl ? ` baseUrl=${sessionConfig.baseUrl}` : '') +
        (Object.keys(resolvedParameters).length > 0
          ? ` parameters=[${Object.keys(resolvedParameters).join(',')}]`
          : ''),
    );

    const sessionId = filePath;
    const client = this.clientFactory({ serverUrl, apiKey });
    const ac = new AbortController();
    this.active = ac;
    this.pauseRequested = false;
    this.lastStepStartLine = null;

    // Resolve which env name to send to the server. Explicit override (batch
    // mode passes one per test) wins over the workspace-level EnvSelector.
    const effectiveEnvName =
      options.envOverride !== undefined ? options.envOverride : EnvSelector.activeEnv();

    const params: Record<string, string> = { ...resolvedParameters };
    let anyFailed = false;
    const batchMode = options.batchMode === true;

    try {
      let i = 0;
      while (i < classified.length) {
        if (ac.signal.aborted) break;
        const item = classified[i]!;

        if (item.kind === 'step') {
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
            envName: effectiveEnvName,
            params,
            sessionConfig,
            logging,
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
          if (batchMode) {
            // Batch mode can't show prompts. Auto-fail the test with a clear
            // pointer to the offending line so the user knows to run it from
            // the editor (F5) instead.
            log(`[batch] input on line ${item.line} → auto-fail (interactive steps not supported in batch)`);
            this.emitRunEvent({
              type: 'step:fail',
              line: item.line,
              error: `Step on line ${item.line} requires interactive input ([input: ${item.varName}]) — interactive and [input: ...] steps cannot run in batch mode. Run this test from its editor (F5) to provide a value.`,
            });
            anyFailed = true;
            break;
          }
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
          if (batchMode) {
            log(`[batch] interactive on line ${item.line} → auto-fail`);
            this.emitRunEvent({
              type: 'step:fail',
              line: item.line,
              error: `Step on line ${item.line} is [interactive] — interactive steps cannot run in batch mode. Run this test from its editor (F5) instead.`,
            });
            anyFailed = true;
            break;
          }
          log(`interactive on line ${item.line}: ${item.hint}`);
          const exitedCleanly = await this.runInteractive({
            hint: item.hint,
            client,
            sessionId,
            env,
            envName: effectiveEnvName,
            params,
            sessionConfig,
            logging,
            signal: ac.signal,
            log,
          });
          if (!exitedCleanly) break;
          i++;
          continue;
        }
      }

      this.configSentForSession = true;

      const status: 'passed' | 'failed' | 'aborted' =
        ac.signal.aborted ? 'aborted' : anyFailed ? 'failed' : 'passed';
      // Now that all preceding steps actually finished, surface the pause
      // indicator so the yellow ▶ shows up on the paused line. Skip on
      // failure/abort — the user didn't reach the pause point, so the
      // arrow would be misleading.
      if (status === 'passed' && pausedAt !== null) {
        this.post({ type: 'breakpointStop', line: pausedAt });
      }
      this.emitRunEvent({ type: 'done', status });
      log(`run ${status}`);
      return { ok: !anyFailed };
    } catch (err) {
      if (isUserAbort(err)) {
        // Pause vs Stop: the user-abort path is the same (AbortController),
        // so the controller's pauseRequested flag tells us which intent.
        // On pause we publish breakpointStop so the UI shows the yellow ▶
        // and offers Resume; on stop we just mark the run aborted.
        if (this.pauseRequested) {
          // Resume point: the line that was executing when pause fired.
          // Fall back to the first step in the run if no step:start has
          // arrived yet (e.g. the user hit Pause immediately after Run,
          // before the server emitted the first event). Without this
          // fallback, paused state is never set and the Resume button
          // doesn't render.
          const firstStepLine = classified.find((c) => c.kind === 'step')?.line ?? null;
          const resumeLine = this.lastStepStartLine ?? firstStepLine;
          if (resumeLine != null) {
            this.post({ type: 'breakpointStop', line: resumeLine });
            this.emitRunEvent({ type: 'done', status: 'aborted' });
            log(`run paused at line ${resumeLine} — Resume to continue`);
            return { ok: true };
          }
        }
        this.emitRunEvent({ type: 'done', status: 'aborted' });
        log('run aborted by user');
        return { ok: true };
      }
      const payload = mapApiErrorToPayload(err, { serverUrl, envPath: envResolution.path });
      this.emitRunEvent({ type: 'done', status: 'error' });
      return this.fail(payload, log);
    } finally {
      this.active = null;
      this.pauseRequested = false;
      this.cancelPrompt();
      this.post({ type: 'promptDone' });
      this.currentEventListener = null;
    }
  }

  private async runStepBlock(args: {
    block: ClassifiedStep[];
    client: ApiClientLike;
    sessionId: string;
    env: Record<string, string>;
    /** Resolved env name to send to the server. `null` means none active. */
    envName: string | null;
    params: Record<string, string>;
    sessionConfig: { baseUrl?: string; timeout?: string };
    logging?: LoggingOverride;
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<boolean> {
    const { block, client, sessionId, env, envName, params, sessionConfig, logging, signal, log } = args;
    const includeConfig = !this.configSentForSession;
    const stepInstructions = block.map((b) => (b.kind === 'step' ? b.instruction : ''));
    const stepLines = block.map((b) => b.line);

    const events = client.streamSteps(
      sessionId,
      {
        steps: stepInstructions,
        sourceLines: stepLines,
        env,
        ...(envName && { envName }),
        ...(includeConfig && Object.keys(sessionConfig).length > 0 && {
          config: sessionConfig,
        }),
        ...(Object.keys(params).length > 0 && { parameters: params }),
        ...(logging && { logging }),
      },
      signal,
    );

    let sawFail = false;
    for await (const event of events) {
      this.configSentForSession = true;
      log(`event ${event.type}${'line' in event ? ` line=${event.line}` : ''}`);
      // Track the step that's currently executing — used as the resume
      // point if the user pauses mid-step.
      if (event.type === 'step:start') this.lastStepStartLine = event.line;
      if (event.type === 'step:fail') sawFail = true;
      if (event.type === 'done') continue;
      this.emitRunEvent(event);
    }
    return !sawFail;
  }

  private async runInteractive(args: {
    hint: string;
    client: ApiClientLike;
    sessionId: string;
    env: Record<string, string>;
    envName: string | null;
    params: Record<string, string>;
    sessionConfig: { baseUrl?: string; timeout?: string };
    logging?: LoggingOverride;
    signal: AbortSignal;
    log: (line: string) => void;
  }): Promise<boolean> {
    const { hint, client, sessionId, env, envName, params, sessionConfig, logging, signal, log } = args;

    const firstAnswer = await this.requestPrompt({ mode: 'interactive', message: hint });
    let answer: string | null = firstAnswer;

    while (answer !== null) {
      if (signal.aborted) return false;

      const action = interpretReplCommand(answer, () =>
        listStepInstructions(this.document.getText()),
      );

      if (action.kind === 'exit-section') return true;
      if (action.kind === 'quit-run') return false;

      if (action.kind === 'output') {
        this.postOutput(action.msg, action.level);
      } else if (action.kind === 'resume') {
        this.postOutput(
          '/resume is not yet supported in the testbench — use /continue or /exit, or run from the CLI for resume support.',
          'warn',
        );
      } else if (action.kind === 'screenshot') {
        this.postOutput(
          '/screenshot is not yet wired in the testbench — run from the CLI for on-demand captures.',
          'warn',
        );
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
              ...(envName && { envName }),
              ...(!this.configSentForSession &&
                Object.keys(sessionConfig).length > 0 && { config: sessionConfig }),
              ...(Object.keys(params).length > 0 && { parameters: params }),
              ...(logging && { logging }),
            },
            signal,
          );
          for await (const event of events) {
            this.configSentForSession = true;
            if (event.type === 'done') continue;
            this.emitRunEvent(event);
          }
        } catch (err) {
          this.postOutput(
            `interactive step errored: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        }
      }

      answer = await this.requestPrompt({ mode: 'interactive', message: hint });
    }
    return false;
  }

  private requestPrompt(opts: {
    mode: 'input' | 'interactive';
    message: string;
    varName?: string;
  }): Promise<string | null> {
    // Cancel any prior pending prompt so a stale resolver doesn't fire when
    // the new prompt resolves.
    if (this.pendingPrompt) {
      this.pendingPrompt.resolve(null);
      this.pendingPrompt = null;
    }

    if (opts.mode === 'input') {
      // One-shot input → use VS Code's native InputBox. Native styling, no
      // webview round-trip, free Esc-to-cancel + Enter-to-submit.
      return new Promise<string | null>((resolve) => {
        void vscode.window
          .showInputBox({
            prompt: opts.message || `Enter value for {{${opts.varName ?? 'input'}}}`,
            placeHolder: opts.varName ? `{{${opts.varName}}}` : undefined,
            ignoreFocusOut: true,
          })
          .then((value) => resolve(value === undefined ? null : value));
      });
    }

    // Interactive REPL — multi-turn composer in the sidebar webview.
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
    this.emitRunEvent({ type: 'output', msg, kind });
  }

  async runAll(): Promise<RunOutcome> {
    return this.runLines([]);
  }

  private fail(payload: ErrorPayload, log: (line: string) => void): RunOutcome {
    log(`${payload.code} ${payload.diagnosis}. ${payload.fix}`);
    this.post({ type: 'runError', payload });
    return { ok: false, error: payload };
  }
}

/**
 * Walk the classified items in order; if any step's source line is in the
 * breakpoint set, return everything *before* that step (so the breakpoint
 * line itself doesn't run) and the line we paused at. `skipFirst=true`
 * lets a Resume run past the breakpoint that triggered the pause.
 */
function trimAtBreakpoint(
  items: ClassifiedStep[],
  breakpoints: Set<number>,
  skipFirst: boolean,
): { runnable: ClassifiedStep[]; pausedAt: number | null } {
  if (breakpoints.size === 0) return { runnable: items, pausedAt: null };
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // Only proper step lines carry breakpoints; [input:] / [interactive]
    // markers don't appear under ## Steps as numbered list items.
    if (item.kind !== 'step') continue;
    if (!breakpoints.has(item.line)) continue;
    if (skipFirst && i === 0) continue;
    return { runnable: items.slice(0, i), pausedAt: item.line };
  }
  return { runnable: items, pausedAt: null };
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
        return reportError('TB014', { serverUrl: ctx.serverUrl, reason: 'aborted' });
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

function resolveValue(value: string, env: Record<string, string>): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  return env[name] ?? value;
}

const VALID_LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug']);
const VALID_LOG_FILES = new Set(['off', 'compact', 'full']);

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
type LogFileMode = 'off' | 'compact' | 'full';

interface LoggingOverride {
  consoleLogLevel?: LogLevel;
  serverFileLogLevel?: LogFileMode;
}

function resolveLoggingOverride(
  rawConfig: Record<string, string>,
  settings: vscode.WorkspaceConfiguration,
): LoggingOverride | undefined {
  const settingLevel = (settings.get<string>('consoleLogLevel') ?? '').trim();
  const settingFile = (settings.get<string>('serverFileLogLevel') ?? '').trim();
  const fmLevel = (rawConfig['consoleLogLevel'] ?? '').trim();
  const fmFile = (rawConfig['serverFileLogLevel'] ?? '').trim();

  const levelRaw = fmLevel || settingLevel;
  const fileRaw = fmFile || settingFile;

  const out: LoggingOverride = {};
  if (levelRaw && VALID_LOG_LEVELS.has(levelRaw)) {
    out.consoleLogLevel = levelRaw as LogLevel;
  }
  if (fileRaw && VALID_LOG_FILES.has(fileRaw)) {
    out.serverFileLogLevel = fileRaw as LogFileMode;
  }
  return (out.consoleLogLevel || out.serverFileLogLevel) ? out : undefined;
}
