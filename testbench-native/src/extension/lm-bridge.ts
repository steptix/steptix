import * as vscode from 'vscode';
import * as http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { getOutputChannel } from './output-channel.js';
import {
  IMAGE_STRIP_WARNING,
  ZERO_USAGE,
  bodyLimitError,
  chatCompletionBody,
  isAuthorized,
  isTerminalError,
  lmUnavailableError,
  mapLmError,
  modelNotFoundError,
  modelSelectorAttempts,
  modelsListBody,
  qualifiedModelId,
  routeFor,
  streamFrames,
  stripJsonFence,
  translateBody,
  unauthorizedError,
  unknownRouteError,
  type BridgeError,
  type BridgeMessage,
  type BridgeUsage,
  type LmSelector,
} from './lm-bridge-core.js';

/**
 * The Copilot bridge: `vscode.lm` published as an OpenAI-compatible endpoint on
 * 127.0.0.1 (stories/copilot-lm-bridge.md §Part A).
 *
 * Why a socket at all: every AI call this framework makes is made by `AiClient`
 * inside the Sessions API SERVER process, and `vscode.lm` is an extension-host
 * API that cannot be pointed at from outside. A protocol adapter is the only
 * join that respects both facts — the server reaches it through routing that
 * already shipped (`AI_MODEL=gateway/…` + `AI_GATEWAY_URL`).
 *
 * This file owns the socket, the token and the `vscode.lm` calls. Every rule
 * about what the bytes MEAN lives in lm-bridge-core.ts, which imports nothing
 * and is unit-tested without a host.
 */

/** Where the token lives across reloads, so written `.env` files never go stale. */
const SECRET_KEY = 'testbench-native.lmBridge.token';

export const LM_BRIDGE_ENABLED = 'lmBridge.enabled';
export const LM_BRIDGE_PORT = 'lmBridge.port';
export const DEFAULT_PORT = 18790;

/** How long to wait before re-attempting a port another window is holding. */
const DEFAULT_RETRY_MS = 15_000;

/**
 * How long usage measurement may take before the completion is served without
 * it.
 *
 * Sized against the largest request this bridge accepts, not against a typical
 * one: `MAX_BODY_BYTES` is 32 MB, which at the measured ~0.03 ms/KB is roughly
 * a second of counting across all N+1 calls. So this is about 2x headroom at
 * the limit and thousands of times that for a realistic compile prompt — a
 * bound on pathology, not a performance budget.
 *
 * The alternative to a bound is worse than a missing number: `countTokens`
 * takes no cancellation token, so an unbounded wait would hold a generated
 * answer until the client gives up at 120 s, discarding a completion the seat
 * has already paid for.
 */
const MEASURE_BUDGET_MS = 2_000;

/** Shown in Copilot's consent dialog, so it says what the seat is being spent on. */
const JUSTIFICATION =
  'TestBench compiles and repairs natural-language test steps using your Copilot seat.';

// ---------------------------------------------------------------------------
// The vscode.lm facade
// ---------------------------------------------------------------------------

/** One model, reduced to what the bridge uses. */
export interface LmModelHandle {
  readonly id: string;
  readonly vendor: string;
  readonly family: string;
  readonly name: string;
  /** Resolves to the response's text fragments; rejects the way `vscode.lm` does. */
  sendRequest(
    messages: BridgeMessage[],
    options: { modelOptions?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<AsyncIterable<string>>;
  /**
   * Tokens in one message or string, by this model's own tokenizer.
   *
   * Measured free of Copilot credits and local (~0.12 ms + 0.03 ms/KB), which
   * is why the bridge can afford to call it per message rather than shipping
   * the zeros it used to.
   */
  countTokens(input: BridgeMessage | string): Promise<number>;
}

/**
 * The seam the integration harness substitutes.
 *
 * `vscode.lm` cannot be driven from a test — a real `selectChatModels` needs a
 * signed-in Copilot seat and a real `sendRequest` spends it — so the namespace
 * is injected exactly the way the run path injects `ApiClient`. Note the seam
 * is the NAMESPACE, not the translation: swapping in a fake must not swap out
 * a single rule about what goes on the wire.
 */
export interface LmFacade {
  /** False on hosts older than the 1.90 floor, where `vscode.lm` is undefined. */
  available(): boolean;
  selectChatModels(selector?: LmSelector): Promise<LmModelHandle[]>;
}

/** Adapter over the real namespace. */
export const realLmFacade: LmFacade = {
  available(): boolean {
    // `engines.vscode` is ^1.90.0 and @types/vscode floats above it, so the
    // compiler believes this is always defined. On a 1.85–1.89 host it is not,
    // and every call here would be a TypeError instead of a clear message.
    const lm = (vscode as Partial<typeof vscode>).lm;
    return typeof lm?.selectChatModels === 'function';
  },
  async selectChatModels(selector?: LmSelector): Promise<LmModelHandle[]> {
    const models = await vscode.lm.selectChatModels(selector);
    return models.map(wrapModel);
  },
};

/**
 * `BridgeMessage` in the shape `vscode.lm` takes.
 *
 * Shared by `sendRequest` and `countTokens` on purpose: counting a different
 * object from the one sent would report tokens for a prompt that was never
 * issued. The overloads are not interchangeable either — a message counts the
 * role framing that a bare string does not, +4 tokens per message on both
 * models measured.
 */
function toLmMessage(m: BridgeMessage): vscode.LanguageModelChatMessage {
  return m.role === 'assistant'
    ? vscode.LanguageModelChatMessage.Assistant(m.text)
    : vscode.LanguageModelChatMessage.User(m.text);
}

function wrapModel(model: vscode.LanguageModelChat): LmModelHandle {
  return {
    id: model.id,
    vendor: model.vendor,
    family: model.family,
    name: model.name,
    async countTokens(input) {
      return await model.countTokens(typeof input === 'string' ? input : toLmMessage(input));
    },
    async sendRequest(messages, options) {
      const lmMessages = messages.map(toLmMessage);
      // The run's own abort (a user Stop, or the client's 120s timeout) closes
      // the HTTP response; without forwarding it, the model keeps generating
      // against a socket nobody is reading and the seat pays for it.
      const cancel = new vscode.CancellationTokenSource();
      // An already-aborted signal fires no event, so check as well as listen.
      if (options.signal?.aborted) cancel.cancel();
      else options.signal?.addEventListener('abort', () => cancel.cancel(), { once: true });
      const response = await model.sendRequest(
        lmMessages,
        {
          justification: JUSTIFICATION,
          ...(options.modelOptions && { modelOptions: options.modelOptions }),
        },
        cancel.token,
      );
      // Wrapped so the token source is disposed when the caller finishes with
      // the response — one leaked disposable per AI call otherwise.
      return (async function* () {
        try {
          for await (const fragment of response.text) yield fragment;
        } finally {
          cancel.dispose();
        }
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export type BridgeState = 'off' | 'listening' | 'standby' | 'error';

export interface BridgeStatus {
  state: BridgeState;
  port: number;
  /** Chat-completions requests forwarded to a model since activation. */
  servedRequests: number;
  /** Why the bridge is not listening, when it isn't. */
  detail: string | null;
}

export class LmBridge implements vscode.Disposable {
  private server: http.Server | null = null;
  private statusItem: vscode.StatusBarItem | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private state: BridgeState = 'off';
  private detail: string | null = null;
  private boundPort = 0;
  private servedRequests = 0;
  /** See {@link ensureToken} — the in-flight or settled mint, memoized. */
  private tokenPromise: Promise<string> | undefined;
  private imageWarningShown = false;
  private zeroUsageWarningShown = false;
  private disposed = false;
  /** Serializes {@link sync}; see its comment. */
  private syncChain: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private facade: LmFacade = realLmFacade,
    private retryMs: number = DEFAULT_RETRY_MS,
  ) {
    // Two windows first-activating together can both find SecretStorage empty
    // and both mint; last writer wins on disk while the loser keeps serving the
    // token it made. Setup then writes the winner's token into `.env` and the
    // loser's bridge 401s it — presenting as "this key came from another
    // machine", which is precisely the wrong diagnosis. Dropping the memo when
    // the secret changes underneath us makes the next request re-read the
    // winner's.
    this.disposables.push(
      context.secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY) this.tokenPromise = undefined;
      }),
    );
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Bring the listener into line with the settings. Safe to call repeatedly.
   *
   * Serialized, because there are three callers that can overlap — activation,
   * the configuration listener, and the setup command flipping the setting —
   * and two concurrent runs would race a close against a bind on the same
   * port, leaving the window in standby behind ITSELF.
   */
  sync(): Promise<void> {
    this.syncChain = this.syncChain.then(
      () => this.syncOnce(),
      () => this.syncOnce(),
    );
    return this.syncChain;
  }

  private async syncOnce(): Promise<void> {
    if (this.disposed) return;
    const config = vscode.workspace.getConfiguration('testbench-native');
    const enabled = config.get<boolean>(LM_BRIDGE_ENABLED, false);
    const port = config.get<number>(LM_BRIDGE_PORT, DEFAULT_PORT);

    if (!enabled) {
      await this.stop('disabled by settings');
      return;
    }
    // Checked here rather than left to `listen`, which answers a bad port two
    // ways and neither is usable: `0` binds an ephemeral port the OS picks, and
    // setup would then write that into a project `.env` — a number nothing will
    // be serving on the next reload. Anything non-integer or out of range makes
    // `listen` throw SYNCHRONOUSLY, inside a promise executor, so it escapes as
    // a rejection on a `sync()` nobody awaits instead of as a state a user can
    // see. `error` is the state the status bar already renders.
    const problem = portProblem(port);
    if (problem) {
      if (this.server) await this.stop('the port setting is not usable');
      if (this.disposed) return;
      this.state = 'error';
      this.detail = problem;
      this.log(problem);
      this.render();
      return;
    }
    // A port change orphans every `.env` written with the old one, so it has to
    // take effect immediately rather than at the next window reload — otherwise
    // the rerun of setup that heals those files writes a port nothing serves.
    if (this.server && this.boundPort === port) return;
    // Only when there is something to stop. A standby retry arrives here with
    // no server, and stopping anyway would drive the status bar item through
    // off→hide→standby→show four times a minute for the life of the window.
    if (this.server) await this.stop('restarting on a new port');
    // Deactivation can land inside that await; without this re-check `listen`
    // binds a socket nobody will ever close and `render` builds a status bar
    // item after the old one was disposed.
    if (this.disposed) return;
    await this.listen(port);
  }

  /** Test seam: swap the `vscode.lm` namespace and the standby retry cadence. */
  configureForTests(opts: { facade?: LmFacade; retryMs?: number }): void {
    if (opts.facade) this.facade = opts.facade;
    if (opts.retryMs !== undefined) this.retryMs = opts.retryMs;
  }

  /**
   * The namespace the setup command should talk to.
   *
   * Shared rather than re-derived so a harness that swapped the facade also
   * swaps what the command sees — a command holding the real `vscode.lm` while
   * the bridge held a fake would put a real consent dialog on screen mid-suite.
   */
  lmFacade(): LmFacade {
    return this.facade;
  }

  status(): BridgeStatus {
    return {
      state: this.state,
      port: this.boundPort || configuredPort(),
      servedRequests: this.servedRequests,
      detail: this.detail,
    };
  }

  /** The bare origin to write into `AI_GATEWAY_URL` — no `/v1`, the client adds it. */
  gatewayUrl(): string {
    return `http://127.0.0.1:${this.status().port}`;
  }

  /**
   * The shared secret, minted once per machine.
   *
   * SecretStorage, not a setting: Settings Sync replicates settings across
   * machines and a replicated token would be a secret in a synced blob AND
   * would mean one leaked machine spends every seat. The cost is the 401 on a
   * copied `.env`, which is what the file's comment block names.
   */
  ensureToken(): Promise<string> {
    // Memoized as a PROMISE, not a value: every request awaits this before its
    // auth check, so two arriving on a cold window would otherwise both find no
    // secret, both mint, and both store — leaving whatever `.env` was written
    // from the loser's token 401ing after the next reload.
    return (this.tokenPromise ??= this.mintToken());
  }

  private async mintToken(): Promise<string> {
    const existing = await this.context.secrets.get(SECRET_KEY);
    if (existing) return existing;
    const minted = randomBytes(32).toString('hex');
    await this.context.secrets.store(SECRET_KEY, minted);
    return minted;
  }

  dispose(): void {
    this.disposed = true;
    void this.stop('extension deactivated');
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.statusItem?.dispose();
    this.statusItem = undefined;
  }

  /**
   * Release the port and settle to `off`.
   *
   * Awaits the close callback, and forces open keep-alive connections shut to
   * get there: the OpenAI SDK holds its socket open between calls, so a plain
   * `close()` would leave the listening handle alive until the client got
   * bored — and the very next `listen` on that port would EADDRINUSE against
   * this same window.
   */
  private stop(reason: string): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    this.state = 'off';
    this.detail = reason;
    this.render();
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /**
   * Claim the port, or stand by for it.
   *
   * One instance per machine, because the token and the models are the same
   * user's either way — which window owns the listener does not matter, only
   * that a second window does not fight it for the port. EADDRINUSE is
   * therefore not an error: it means another window is already serving, and
   * this one retries so the port is re-claimed when that window closes rather
   * than leaving every `.env` on the machine pointing at nothing.
   */
  private listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server = server;

      server.on('error', (err: NodeJS.ErrnoException) => {
        // A later error on a server this bridge has already replaced must not
        // wipe the live one's state — `stop()` detaches by setting this.server,
        // and that is the only identity check available.
        if (this.server !== server) return;
        this.server = null;
        if (err.code === 'EADDRINUSE') {
          // Nothing was ever bound, so there is no handle to release. Silent on
          // a repeat: the retry runs every few seconds for as long as the other
          // window lives, and re-announcing it would fill the output channel
          // users read for run logs.
          const detail = `port ${port} is held by another window; retrying`;
          const firstTime = this.state !== 'standby' || this.detail !== detail;
          this.state = 'standby';
          this.detail = detail;
          if (firstTime) {
            this.log(`port ${port} in use — standing by`);
            this.render();
          }
          this.scheduleRetry();
        } else {
          // An error AFTER a successful bind still holds the listening handle.
          // Detaching without closing would strand the port against this
          // window's own next listen — close is a no-op if it never bound.
          server.close();
          this.boundPort = 0;
          this.state = 'error';
          this.detail = `${err.code ?? 'error'}: ${err.message}`;
          this.log(`listen failed: ${err.message}`);
          this.render();
        }
        resolve();
      });

      server.listen(port, '127.0.0.1', () => {
        this.boundPort = port;
        this.state = 'listening';
        this.detail = null;
        this.log(`listening on http://127.0.0.1:${port}`);
        this.render();
        resolve();
      });
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.disposed || this.state !== 'standby') return;
      // Back through sync() rather than straight to listen(): it re-reads the
      // settings (the port may have moved, or the bridge been switched off
      // while we waited) and it takes the same serialization lock, so a retry
      // can never race a configuration change onto the same port.
      void this.sync();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  // -- status bar -----------------------------------------------------------

  /**
   * `$(copilot) TestBench bridge :18790` while the bridge is up, with the
   * served-request count in the tooltip — the visible answer to "is my seat
   * being spent". Hidden entirely when the bridge is off, so a user who never
   * enabled it never sees it.
   */
  private render(): void {
    if (this.state === 'off') {
      this.statusItem?.hide();
      return;
    }
    if (!this.statusItem) {
      this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
      this.statusItem.command = 'testbench-native.useCopilotForAi';
    }
    const port = this.status().port;
    if (this.state === 'listening') {
      this.statusItem.text = `$(copilot) TestBench bridge :${port}`;
      this.statusItem.tooltip =
        `Copilot bridge serving http://127.0.0.1:${port} — ` +
        `${this.servedRequests} model request${this.servedRequests === 1 ? '' : 's'} this session.\n` +
        'Compiling and repairing spend Copilot premium requests; running a compiled ' +
        'test spends none.\nClick to rerun "TestBench: Use Copilot for AI".';
      this.statusItem.backgroundColor = undefined;
    } else {
      this.statusItem.text = `$(copilot) TestBench bridge (${this.state})`;
      this.statusItem.tooltip = this.detail ?? 'The Copilot bridge is not serving.';
      this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.statusItem.show();
  }

  private log(line: string): void {
    getOutputChannel().appendLine(
      `[${new Date().toISOString().slice(11, 23)}] lm-bridge: ${line}`,
    );
  }

  // -- request handling -----------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const token = await this.ensureToken();
      // Auth first: an unauthenticated caller learns nothing about which paths
      // exist here, and every path spends (or reveals) the user's seat.
      if (!isAuthorized(req.headers.authorization, token)) {
        return this.writeError(res, unauthorizedError());
      }
      const route = routeFor(req.method, req.url);
      if (route === 'unknown') {
        return this.writeError(res, unknownRouteError(req.method, req.url));
      }
      if (!this.facade.available()) {
        return this.writeError(res, lmUnavailableError());
      }
      if (route === 'models') return await this.handleModels(res);
      return await this.handleCompletions(req, res);
    } catch (err) {
      this.log(`unhandled: ${err instanceof Error ? err.message : String(err)}`);
      this.writeError(res, mapLmError(asLmError(err)));
    }
  }

  private async handleModels(res: http.ServerResponse): Promise<void> {
    const models = await this.facade.selectChatModels();
    this.writeJson(
      res,
      200,
      modelsListBody(models, Math.floor(Date.now() / 1000)),
    );
  }

  private async handleCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    if (!body.ok) return this.writeError(res, body.error);

    const translated = translateBody(body.text);
    if (!translated.ok) return this.writeError(res, translated.error);
    const request = translated.value;

    if (request.imagesStripped > 0 && !this.imageWarningShown) {
      this.imageWarningShown = true;
      void vscode.window.showWarningMessage(IMAGE_STRIP_WARNING);
      this.log(`stripped ${request.imagesStripped} image block(s) from a request`);
    }

    const model = await this.resolveModel(request.model);
    if (!model) {
      const all = await this.facade.selectChatModels();
      return this.writeError(
        res,
        modelNotFoundError(request.model, all.map(qualifiedModelId)),
      );
    }

    this.servedRequests++;
    this.render();

    // Buffered ALWAYS, streamed or not. `AiClient` asks for json_object on
    // every request and the fence strip cannot un-emit deltas that already
    // left; the bonus is that a mid-stream vscode.lm failure lands here as a
    // whole-request error carrying the real message (the quota text survives)
    // instead of a truncated completion.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let text = '';
    try {
      const fragments = await model.sendRequest(request.messages, {
        ...(Object.keys(request.modelOptions).length > 0 && {
          modelOptions: request.modelOptions,
        }),
        signal: abort.signal,
      });
      for await (const fragment of fragments) text += fragment;
    } catch (err) {
      const mapped = mapLmError(asLmError(err), { model: request.model });
      this.log(`model request failed: ${mapped.body.error.code}`);
      return this.writeError(res, mapped);
    }

    const payload = {
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      text: request.wantsJson ? stripJsonFence(text) : text,
      // The RAW text, not the fence-stripped payload above: what the model
      // generated is what it spent, and the fence is the bridge's to remove.
      usage: await this.measureUsage(model, request.messages, text, abort.signal),
    };

    if (!request.stream) return this.writeJson(res, 200, chatCompletionBody(payload));

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const frame of streamFrames(payload)) res.write(frame);
    res.end();
  }

  /**
   * Token usage for one served completion.
   *
   * Per MESSAGE for the prompt, because the message overload counts role
   * framing that a bare string does not — +4 tokens per message on both models
   * measured (stories/copilot-lm-bridge.md, resolved question 3) — so summing
   * messages is closer to what the provider would charge than counting one
   * joined string would be.
   *
   * Cost is proportional to the prompt, not flat: ~0.12 ms per call plus
   * ~0.03 ms/KB, so a handful of short messages is around a millisecond while a
   * 100 KB page snapshot is a few on its own.
   *
   * Never throws, and never outlives its usefulness. A failed count must not
   * fail a completion that already succeeded — the caller wants the answer, the
   * seat has already been spent, and `AiClient` copes with zeros. That
   * principle is why the two guards below exist rather than just the try:
   * a disconnected client is not owed N+1 tokenizer calls, and an unbounded
   * `countTokens` would otherwise let a wedged tokenizer discard a generated
   * answer at the client's 120 s timeout.
   */
  private async measureUsage(
    model: LmModelHandle,
    messages: BridgeMessage[],
    text: string,
    signal: AbortSignal,
  ): Promise<BridgeUsage> {
    // Nobody is reading this response. The completion is already generated and
    // the seat already spent; counting it now buys a number no one will see.
    if (signal.aborted) return { ...ZERO_USAGE };

    let expired: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.countUsage(model, messages, text),
        new Promise<never>((_, reject) => {
          expired = setTimeout(
            () => reject(new Error(`counting exceeded ${MEASURE_BUDGET_MS}ms`)),
            MEASURE_BUDGET_MS,
          );
        }),
      ]);
    } catch (err) {
      this.log(`usage not measured: ${err instanceof Error ? err.message : String(err)}`);
      return { ...ZERO_USAGE };
    } finally {
      clearTimeout(expired);
    }
  }

  /** The counting itself; {@link measureUsage} owns the guards around it. */
  private async countUsage(
    model: LmModelHandle,
    messages: BridgeMessage[],
    text: string,
  ): Promise<BridgeUsage> {
    let prompt = 0;
    for (const message of messages) prompt += await model.countTokens(message);
    const completion = await model.countTokens(text);

    // A model whose tokenizer answers 0 for real text is a thing that exists:
    // `copilotcli/auto` is a router entry with maxInputTokens 0 whose
    // countTokens returns 0 for any input. Its zeros are indistinguishable on
    // the wire from the not-measured fallback, so the difference gets said
    // rather than leaving someone to wonder why a busy compile reports nothing
    // — once per bridge, like the image-strip warning above, because the cause
    // is a configured model and every later request would say the same thing.
    if (prompt === 0 && !this.zeroUsageWarningShown && messages.some((m) => m.text.trim() !== '')) {
      this.zeroUsageWarningShown = true;
      this.log(
        `usage measured as 0 for a non-empty prompt — ${qualifiedModelId(model)} ` +
          'reports no usable tokenizer (a router alias like copilotcli/auto does ' +
          'this); point AI_MODEL at a concrete model to get real counts',
      );
    }

    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
  }

  /** First selector that resolves wins; see `modelSelectorAttempts`. */
  private async resolveModel(model: string): Promise<LmModelHandle | null> {
    for (const selector of modelSelectorAttempts(model)) {
      const found = await this.facade.selectChatModels(selector);
      if (found.length > 0) return found[0]!;
    }
    return null;
  }

  private writeJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: http.OutgoingHttpHeaders = {},
  ): void {
    // The catch-all in `handle` can be reached after the SSE head has gone out;
    // writing a second head there would replace a served response with a
    // "headers already sent" crash in the extension host.
    if (res.headersSent) {
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }

  private writeError(res: http.ServerResponse, error: BridgeError): void {
    // See `isTerminalError`: without this the client's own retry policy turns
    // one quota-exhausted call into three.
    this.writeJson(
      res,
      error.status,
      error.body,
      isTerminalError(error) ? { 'x-should-retry': 'false' } : {},
    );
  }
}

/**
 * Why `lmBridge.port` cannot be bound, in words the status bar can show, or
 * `null` when it can.
 *
 * `0` is refused rather than read as "any free port": the OS would happily
 * grant one, but the whole contract of this port is that setup writes it into a
 * project `.env` and the next window binds the same number.
 *
 * `unknown` in, because `package.json` constrains what the settings UI offers
 * and not what a hand-edited `settings.json` can hold — a string arrives here
 * as readily as a number.
 */
function portProblem(port: unknown): string | null {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return (
      `testbench-native.${LM_BRIDGE_PORT} is ${JSON.stringify(port) ?? String(port)}, ` +
      'which is not a port: it must be a whole number from 1 to 65535. The bridge ' +
      'is not listening.'
    );
  }
  return null;
}

/**
 * The configured port, falling back to the default when the setting is not
 * usable.
 *
 * The fallback is what keeps an unusable setting out of the files: `status()`
 * feeds {@link LmBridge.gatewayUrl}, which setup writes into a project `.env`,
 * and `http://127.0.0.1:0` there would be a permanent connection-refused with
 * nothing on screen explaining it. The bridge is in `error` either way, and the
 * setup command warns before it writes.
 */
function configuredPort(): number {
  const port = vscode.workspace
    .getConfiguration('testbench-native')
    .get<number>(LM_BRIDGE_PORT, DEFAULT_PORT);
  return portProblem(port) === null ? port : DEFAULT_PORT;
}

/** `unknown` from a catch, narrowed to what {@link mapLmError} reads. */
function asLmError(err: unknown): { code?: string; name?: string; message?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return {
      ...(typeof code === 'string' && { code }),
      name: err.name,
      message: err.message,
    };
  }
  return { message: String(err) };
}

async function readBody(
  req: http.IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; error: BridgeError }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Checked per chunk rather than at the end: the point is to stop reading,
    // not to refuse afterwards.
    const tooLarge = bodyLimitError(size);
    if (tooLarge) return { ok: false, error: tooLarge };
    chunks.push(buf);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}
