import { AIGateway } from '@pkent/aigateway';
import type { CallOptions, Effort, V2ContentBlock } from '@pkent/aigateway';
import type { AiConfig } from '../config/types.js';
import { aiConfigured } from '../config/loader.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { ChatMessage, MessageContentBlock } from './types.js';
import { TokenTracker } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

let nextRequestId = 1;

/**
 * Strip large image base64 payloads from messages so the trace dump remains
 * readable. Images get replaced with `<image:dataUrl-N-bytes>` markers.
 * Text blocks are kept verbatim — they ARE the prompt, and seeing them is
 * the whole point of the trace.
 */
function summarizeMessagesForTrace(messages: ChatMessage[]): unknown {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    const blocks = (m.content as MessageContentBlock[]).map((b) => {
      if (b.type === 'image_url') {
        const len = b.image_url?.url?.length ?? 0;
        return { type: 'image_url', stripped: `<image:dataUrl-${len}-bytes>` };
      }
      return b;
    });
    return { role: m.role, content: blocks };
  });
}

/** Join the `type:'text'` blocks of a v2 response envelope into the response text. */
function textFromV2(content: V2ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/**
 * Which KIND of call this is. Effort is a property of the call site and is
 * known statically — the hot path wants a fast answer, authoring wants a
 * considered one — so there is no runtime difficulty heuristic to tune.
 */
export type CompleteProfile = 'routine' | 'retry' | 'authoring';

/**
 * Effort and its output cap come from ONE record so they cannot drift apart.
 *
 * Reasoning tokens count against the output cap on every provider, and
 * OpenRouter sizes the reasoning budget as a *fraction of* `maxTokens` (`high`
 * at roughly 80% of it). Raising effort without raising the cap leaves the model
 * a few hundred tokens to answer in, and the JSON action list comes back
 * truncated — a failure that reads like a bad model rather than a bad config.
 *
 * `routine` carries NO effort on purpose: unset means the request body is
 * byte-for-byte what it is today, so existing runs and prompt-cache prefixes are
 * untouched. Raising the hot path is opt-in, via `AI_EFFORT`.
 */
const PROFILES: Record<CompleteProfile, { effort?: Effort; maxTokens: number }> = {
  routine: { maxTokens: 4096 },
  retry: { effort: 'medium', maxTokens: 8192 },
  authoring: { effort: 'high', maxTokens: 16384 },
};

/**
 * What every AI request says when the machine has no key
 * (stories/keyless-replay-and-gateway-env.md §Part B, "One reactive
 * backstop"). Named rather than inlined so the runner's tests can assert the
 * exact wording without restating it — a second copy is how the message and
 * the promise drift apart.
 *
 * It replaces the gateway's bare `invalid_api_key`, which reads as "my config
 * is broken" on a machine that was never meant to have a key. The sentences
 * are the things the reader needs: what was resolved, that replay itself is
 * unaffected, what to set, and the one non-obvious rule that can hide a key
 * they know they have.
 *
 * It says "resolved to empty" rather than naming the files the key is missing
 * from, because a blank `AI_API_KEY=` line — the one `.env.example` ships —
 * BLOCKS the machine `.env` on purpose (`withMachineAiFloor` is a floor for
 * unset values, not for empty ones), and that is how a project deliberately
 * forces keyless. A message listing the places with no key would be flatly
 * wrong for the reader who has one in `%LOCALAPPDATA%\aiui\.env` and cannot
 * see why it is being ignored, so the parenthetical names the rule instead.
 */
export const AI_NOT_CONFIGURED_MESSAGE =
  'AI is not configured: AI_API_KEY resolved to empty. Compiled tests replay ' +
  'without AI; this operation needs a model. Set AI_API_KEY in the project ' +
  '.env or the machine .env — and AI_GATEWAY_URL if your org routes through ' +
  'its own endpoint. (A blank AI_API_KEY= line in the project .env ' +
  'deliberately blocks the machine key.)';

/**
 * Thrown by any AI request made on a keyless run. Typed (rather than a bare
 * `Error`) so a caller that wants to distinguish "no AI here" from "the model
 * failed" can, without matching on prose.
 *
 * Every operation that genuinely needs AI — compile, errands, AI-executed
 * steps in an uncompiled test — inherits it with no per-call-site work.
 */
export class AiNotConfiguredError extends Error {
  constructor(message: string = AI_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

/**
 * What a `gateway/` model says when nobody chose the endpoint
 * (stories/copilot-lm-bridge.md §Part B).
 *
 * `gateway/` means "route to `AI_GATEWAY_URL`, whatever it names" — a local
 * bridge, a corporate gateway, Ollama. When that variable was never set, the
 * resolved value is the built-in default, and sending the request anyway would
 * ship the key and the DOM payload to the hosted broker: exactly the egress the
 * corporate reader picked this spelling to avoid. So it is refused rather than
 * routed, and the message names the variable it needs.
 *
 * Deliberately silent about `AI_API_KEY`: a key is not the problem here, and
 * pointing at it would send the reader to edit a line that is already correct.
 */
export const GATEWAY_URL_REQUIRED_MESSAGE =
  'AI_GATEWAY_URL is not set, so a gateway/ model has no endpoint to route to: ' +
  'it resolved to the built-in default, which is not what "gateway/" asks for. ' +
  'Refusing to send this request rather than routing it somewhere you did not ' +
  'choose. Set AI_GATEWAY_URL in the project .env to the endpoint you mean — a ' +
  'local bridge, your org\'s gateway, Ollama — or use ' +
  'AI_MODEL=aibroker/<provider>/<model>, which is the spelling for the hosted ' +
  'broker on the default endpoint.';

/**
 * Thrown when a `gateway/` model is paired with an unset `AI_GATEWAY_URL`.
 * Typed for {@link AiNotConfiguredError}'s reason — a caller distinguishing
 * "misconfigured routing" from "the model failed" should not match on prose.
 */
export class GatewayUrlRequiredError extends Error {
  constructor(message: string = GATEWAY_URL_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'GatewayUrlRequiredError';
  }
}

/**
 * What an AI request says on a run whose policy forbids AI
 * (stories/run-settings.md §9).
 *
 * Its own message rather than {@link AI_NOT_CONFIGURED_MESSAGE}, because that
 * one's advice — "Set AI_API_KEY in the project .env" — is not the move here:
 * the run was asked to spend no AI, and a key changes nothing about that. The
 * actionable move is to stop asking for it, or to compile the step so it
 * replays without a model.
 *
 * It says nothing about whether a key exists, in either direction. Policy wins
 * when both hold (`resolveRunSettings`, src/config/run-settings.ts) — so a
 * keyless machine running with `ai: off` lands here too, and a message
 * asserting a key is configured would be flatly wrong for that reader.
 */
export const AI_FORBIDDEN_BY_POLICY_MESSAGE =
  'This step needs AI and this run forbids AI: it was asked to make no AI ' +
  'calls (runSettings.ai: off, or ai.allowInRuns: false in aiui.config.json). ' +
  'Compiled steps replay either way — compile this step, or run again with ' +
  'ai: "on" (or "default") to allow it.';

/**
 * Thrown by every AI request made while the run's policy veil is up.
 *
 * Typed and distinct from {@link AiNotConfiguredError} so the two never
 * collapse: the echo has to keep "off (policy)" and "off (no key)" apart, and a
 * shared error class is how that distinction quietly stops being true.
 */
export class AiForbiddenByPolicyError extends Error {
  constructor(message: string = AI_FORBIDDEN_BY_POLICY_MESSAGE) {
    super(message);
    this.name = 'AiForbiddenByPolicyError';
  }
}

/**
 * Did someone actually choose this gateway URL, or is it just the built-in?
 *
 * The one definition of "a custom gateway URL", exported so the computer-mode
 * vision check (src/desktop/vision-route.ts, SPEC-use-computer.md §15.4) asks
 * the question the client asks rather than a copy of it. See
 * {@link AiClient}'s `hasCustomGatewayUrl` for why it is a comparison against
 * `DEFAULT_CONFIG` rather than against `undefined`.
 */
export function isCustomGatewayUrl(gatewayUrl: string): boolean {
  const trim = (url: string): string => url.trim().replace(/\/+$/, '');
  return trim(gatewayUrl) !== trim(DEFAULT_CONFIG.ai.gatewayUrl);
}

/**
 * The prefix that makes `model` gateway-routed — sent to `AI_GATEWAY_URL`'s
 * `/v1` surface rather than to a provider's own endpoint — or `null` for a
 * direct model. Two spellings route (see `buildGateway`); the library strips
 * whichever one it was given and forwards the rest as the upstream model id.
 */
export function gatewayRoutePrefix(model: string): 'gateway/' | 'aibroker/' | null {
  if (model.startsWith('gateway/')) return 'gateway/';
  if (model.startsWith('aibroker/')) return 'aibroker/';
  return null;
}

/** Per-call knobs beyond the messages themselves. */
export interface CompleteOptions {
  /** Defaults to `routine` — today's behavior. */
  profile?: CompleteProfile;
}

/** Result of a single AI completion, including which model the gateway actually served. */
export interface CompleteResult {
  /** The assembled text response from the AI */
  text: string;
  /**
   * The model id reported by the gateway's v2 response envelope, or the
   * configured model if the envelope omitted it. `@pkent/aigateway` echoes the
   * BOUND `<provider>/<model>` id (it discards the upstream's returned model),
   * so this is effectively the configured `AI_MODEL`.
   */
  model: string;
}

export class AiClient {
  private config: AiConfig;
  private tokenTracker: TokenTracker;
  /**
   * Lazily-built, memoized gateway. NOT built in the constructor:
   * `new AIGateway(...)` throws `invalid_api_key` on an empty key and binds the
   * model at construction, so building lazily preserves the "construct succeeds;
   * fail at request time" behavior and lets {@link syncAuth} just null this out.
   */
  private gateway: AIGateway | null = null;
  /**
   * The run's policy veil (stories/run-settings.md §9): while it is up, every
   * request is refused whatever the key says.
   *
   * On the client rather than in the executor because the executor's `keyless`
   * option does not reach `executeBranchedStep`, which receives neither it nor
   * `codeBehind` — so an executor-level gate would miss branched AI steps
   * entirely while the report claimed the run made no AI calls. The client is
   * the one choke point both paths share.
   */
  private aiForbidden = false;

  constructor(config: AiConfig, tokenTracker: TokenTracker) {
    this.config = config;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Build the `@pkent/aigateway` client bound to the current `model` + `apiKey`.
   * The model-string prefix drives routing: `baseURL` (the gateway `/v1`
   * surface) is supplied ONLY for gateway-routed models — for direct models
   * (`openai/…`, `anthropic/…`, …) passing it would point the provider's own SDK
   * at the gateway instead of the real upstream.
   *
   * Two prefixes route, and they differ only in what they say about the
   * destination (stories/copilot-lm-bridge.md §Part B). `gateway/` means "route
   * to `AI_GATEWAY_URL`", so it REQUIRES one to have been set; `aibroker/` names
   * the hosted broker application and keeps its fall-through to the built-in
   * default, which is what makes it the zero-config spelling. The library strips
   * whichever first segment it was given and forwards the rest, so the model
   * string goes across verbatim either way.
   */
  private buildGateway(): AIGateway {
    const viaGateway = gatewayRoutePrefix(this.config.model) !== null;
    // Refused before anything is built or sent. The loader keeps no provenance —
    // an explicitly-set URL and the built-in default are indistinguishable on
    // the result — so this is the same value comparison `hasCustomGatewayUrl`
    // makes for the warning below. It also refuses the one edge that comparison
    // cannot see, a URL explicitly set TO the default host; acceptable, because
    // `aibroker/` is precisely the spelling for that.
    if (this.config.model.startsWith('gateway/') && !this.hasCustomGatewayUrl()) {
      throw new GatewayUrlRequiredError();
    }
    if (!viaGateway && this.hasCustomGatewayUrl()) {
      // Someone deliberately pointed this run at an endpoint and it is being
      // ignored — silently, and often in the direction that matters: the
      // request leaves for the provider instead of staying inside the org's
      // gateway. Warned rather than refused, because the pairing is legal (a
      // project may keep a gateway configured and run a direct model on
      // purpose); the cost of guessing wrong is one log line, and the cost of
      // saying nothing is a corporate user who thinks their traffic is routed
      // and it is not.
      //
      // It says what is true and offers both readings rather than prescribing
      // one, because "set AI_MODEL=gateway/<model>" is wrong advice for a whole
      // audience: a `bedrock/` model already reaches the user's own AWS
      // account, and this pairing is unusually likely there — corporate setups
      // keep a gateway URL configured while the approved AI is Bedrock
      // (stories/bedrock-provider.md §"Notes for the builder").
      logger.warn(
        `AI_GATEWAY_URL is set to ${this.config.gatewayUrl}, but the model ` +
          `"${this.config.model}" is not a gateway-routed model — the gateway URL ` +
          'applies only to gateway-routed models (gateway/… and aibroker/…), so this ' +
          'request goes wherever the model prefix points instead: for openai/…, ' +
          'anthropic/… and the like, straight out to that provider. ' +
          'If you meant to route through the gateway, set AI_MODEL=gateway/<model>. ' +
          'If the model already reaches infrastructure you control — a bedrock/ model ' +
          'goes to your own AWS account — nothing is leaving it, and the URL is ' +
          'simply unused here.',
      );
    }
    const opts = viaGateway
      ? { baseURL: `${this.config.gatewayUrl.replace(/\/+$/, '')}/v1` }
      : {};
    return new AIGateway(this.config.model, this.config.apiKey ?? '', opts);
  }

  /**
   * Did someone actually choose this gateway URL, or is it just the built-in?
   *
   * Compared against `DEFAULT_CONFIG` rather than against `undefined` because
   * `gatewayUrl` is a required field with a default — every resolved config has
   * one, so "is it set?" can only ever answer yes. Trailing slashes are
   * normalised the same way {@link buildGateway} normalises them, so a value
   * that differs from the default only by a `/` is not treated as a choice.
   *
   * Two callers, opposite directions: the inert-pair warning fires when a
   * chosen URL is being ignored, and the `gateway/` guard fires when no URL was
   * chosen at all.
   */
  private hasCustomGatewayUrl(): boolean {
    return isCustomGatewayUrl(this.config.gatewayUrl);
  }

  /**
   * Lazily build + memoize the gateway on first use.
   *
   * The single choke point every request passes through, which is why the
   * keyless check sits here rather than in `complete()`: a future request
   * method inherits it for free, and the check can never disagree with the
   * build it guards. The lazy-build contract is unchanged — construction
   * still succeeds with no key, so a keyless run can build a client, replay a
   * compiled test and never come near this line
   * (stories/keyless-replay-and-gateway-env.md §Part B).
   */
  private getGateway(): AIGateway {
    // Policy before the key check: on a policy-off run a key is present, so
    // "AI is not configured" would be a false statement about a correct config.
    if (this.aiForbidden) throw new AiForbiddenByPolicyError();
    if (!aiConfigured(this.config)) throw new AiNotConfiguredError();
    return (this.gateway ??= this.buildGateway());
  }

  /**
   * Raise or lower the policy veil for the batch about to run
   * (stories/run-settings.md §9).
   *
   * Set per batch, never sticky: run settings are retained on the SESSION and
   * re-resolved every request, and a client that stayed veiled after the caller
   * turned AI back on would need a session recycle to recover — the very cost
   * this feature exists to avoid. Leaves the memoized gateway alone: the veil
   * refuses before it is ever handed out, so there is nothing to invalidate.
   */
  setAiPolicy(allowed: boolean): void {
    this.aiForbidden = !allowed;
  }

  /**
   * Re-point the client at a new `model` / `apiKey` / `gatewayUrl` — used when
   * a saved `.env` edit changes `AI_MODEL` / `AI_API_KEY` / `AI_GATEWAY_URL`
   * between runs on a reused session. Only these three fields are env-mutable;
   * every other field (maxInputTokens, streaming) is server-level and left
   * untouched.
   *
   * `@pkent/aigateway` binds the model at construction AND the `baseURL` choice
   * depends on the model prefix, so a model change OR a key change invalidates
   * the cached gateway — it's rebuilt on the next {@link getGateway} call. The
   * gateway URL is baked into that same `baseURL`, which is why it belongs
   * here rather than in the "server-level, left untouched" list it used to sit
   * in: a project's `.env` can now move it
   * (stories/keyless-replay-and-gateway-env.md), and a memoized gateway would
   * keep talking to the old endpoint for the life of the session.
   *
   * `gatewayUrl` is optional so that a caller which does not manage it — the
   * config's value is a required string, so there is no "cleared" state to
   * express — leaves today's URL alone rather than reading as a change.
   *
   * Returns a short, key-safe description of what changed (for logging), or
   * `null` when nothing changed. The returned string NEVER contains the key
   * value — only the fact that it changed.
   */
  syncAuth(model: string, apiKey: string | undefined, gatewayUrl?: string): string | null {
    const changes: string[] = [];
    if (model !== this.config.model) {
      changes.push(`AI model ${this.config.model} → ${model}`);
      this.config.model = model;
    }
    if (apiKey !== this.config.apiKey) {
      changes.push('AI API key changed');
      // Delete rather than assign undefined — `apiKey` is optional and the repo
      // builds with exactOptionalPropertyTypes. A removed key reverts to "no
      // Authorization header" (the server base when AI_API_KEY is absent).
      if (apiKey === undefined) delete this.config.apiKey;
      else this.config.apiKey = apiKey;
    }
    if (gatewayUrl !== undefined && gatewayUrl !== this.config.gatewayUrl) {
      // Safe to log in full: an endpoint is routing, not a secret — the same
      // reason it takes AI_MODEL's precedence rather than AI_API_KEY's.
      changes.push(`AI gateway ${this.config.gatewayUrl} → ${gatewayUrl}`);
      this.config.gatewayUrl = gatewayUrl;
    }
    // A model, key or gateway change invalidates the cached gateway (the model
    // is bound at construction, and the baseURL — both whether there is one and
    // what it points at — is fixed there too).
    if (changes.length > 0) this.gateway = null;
    return changes.length > 0 ? changes.join('; ') : null;
  }

  /**
   * Send messages to the AI and get a complete response.
   * Uses the streaming chat-completions call when streamResponses is true,
   * otherwise the non-streaming call.
   *
   * `signal` is the run's abort signal (from a client "stop"). When it fires,
   * the in-flight HTTP request is cancelled immediately rather than running out
   * the 120s timeout — this is what makes stop feel instant. It's combined with
   * the timeout in `buildSignal`, so either one aborts the request.
   */
  async complete(
    messages: ChatMessage[],
    signal?: AbortSignal,
    options?: CompleteOptions,
  ): Promise<CompleteResult> {
    if (this.config.streamResponses) {
      return this.completeStream(messages, signal, options);
    }
    return this.completeOnce(messages, signal, options);
  }

  /**
   * Resolve a profile into the `effort` + `maxTokens` pair that goes on the
   * call. `AI_EFFORT` overrides the ROUTINE profile only, and raises its cap
   * alongside — the two never move independently. It deliberately does not
   * touch `retry`/`authoring`: letting a global cost knob lower those would
   * make failure diagnosis worse exactly when someone is trying to save money.
   */
  private resolveProfile(profile: CompleteProfile = 'routine'): Pick<CallOptions, 'effort' | 'maxTokens'> {
    const base = PROFILES[profile];
    const override = profile === 'routine' ? this.config.effort : undefined;

    if (override !== undefined) {
      return { effort: override, maxTokens: Math.max(base.maxTokens, 8192) };
    }
    // Spread-or-omit rather than `effort: undefined`: the repo builds with
    // exactOptionalPropertyTypes, and an explicit undefined is not the same as
    // an absent key.
    return { maxTokens: base.maxTokens, ...(base.effort !== undefined && { effort: base.effort }) };
  }

  /** Non-streaming chat completion. */
  private async completeOnce(
    messages: ChatMessage[],
    signal?: AbortSignal,
    options?: CompleteOptions,
  ): Promise<CompleteResult> {
    // Resolved BEFORE anything is logged: on a keyless run this throws, and a
    // `POST …` line for a request that was never built is a false trail
    // through the log the user is reading to work out what happened. Nothing
    // about the keyed path changes — same lines, same request ids, one
    // statement earlier.
    const gateway = this.getGateway();
    const requestId = nextRequestId++;
    const url = `${this.config.gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`;

    logger.debug(`POST ${url} (${messages.length} messages) [req#${requestId}]`);
    logger.trace(`ai.request#${requestId}`, {
      url,
      method: 'POST',
      model: this.config.model,
      messageCount: messages.length,
      streaming: false,
      messages: summarizeMessagesForTrace(messages),
    });

    let v2;
    try {
      // Messages pass through unchanged — `@pkent/aigateway` accepts the
      // consumer's `ChatMessage` shape and handles `cache` hints itself.
      v2 = await gateway.chat(messages, {
        ...this.resolveProfile(options?.profile),
        responseFormat: { type: 'json_object' },
        signal: this.buildSignal(signal),
      });
    } catch (err) {
      logger.trace(`ai.response#${requestId}`, {
        ok: false,
        body: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const text = textFromV2(v2.content);
    if (v2.usage) {
      // v2 field names — the library normalizes upstream usage to input/output.
      this.tokenTracker.addUsage(v2.usage.input_tokens, v2.usage.output_tokens);
      this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
    }

    const model = v2.model ?? this.config.model;
    logger.trace(`ai.response#${requestId}`, {
      ok: true,
      model,
      usage: v2.usage,
      content: text,
    });

    if (!text) {
      throw new Error('AI response contained no content');
    }

    return { text, model };
  }

  /** Streaming chat completion, accumulated into a single response. */
  private async completeStream(
    messages: ChatMessage[],
    signal?: AbortSignal,
    options?: CompleteOptions,
  ): Promise<CompleteResult> {
    // Same reason as `completeOnce`: the keyless throw happens before the log
    // claims a request went out.
    const gateway = this.getGateway();
    const requestId = nextRequestId++;
    const url = `${this.config.gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`;

    logger.debug(`POST ${url} (streaming, ${messages.length} messages) [req#${requestId}]`);
    logger.trace(`ai.request#${requestId}`, {
      url,
      method: 'POST',
      model: this.config.model,
      messageCount: messages.length,
      streaming: true,
      messages: summarizeMessagesForTrace(messages),
    });

    let text = '';
    let model = this.config.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let haveUsage = false;

    try {
      const stream = gateway.stream(messages, {
        ...this.resolveProfile(options?.profile),
        responseFormat: { type: 'json_object' },
        signal: this.buildSignal(signal),
      });

      for await (const delta of stream) text += delta.text;

      const final = await stream.final;
      model = final.model ?? this.config.model;
      if (final.usage && (final.usage.input_tokens || final.usage.output_tokens)) {
        inputTokens = final.usage.input_tokens;
        outputTokens = final.usage.output_tokens;
        haveUsage = true;
      }
    } catch (err) {
      logger.trace(`ai.response#${requestId}`, {
        ok: false,
        body: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (haveUsage) {
      this.tokenTracker.addUsage(inputTokens, outputTokens);
      this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
    } else {
      // Estimate tokens if the stream omitted usage (matches the old behavior).
      this.tokenTracker.addUsage(0, Math.ceil(text.length / 4));
    }

    logger.trace(`ai.response#${requestId}`, {
      ok: true,
      streaming: true,
      model,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      content: text,
    });

    if (!text) {
      throw new Error('AI stream produced no content');
    }

    return { text, model };
  }

  /**
   * Combine the 120s request timeout with the run's abort signal so EITHER
   * cancels the in-flight request: the timeout caps a slow gateway, the run
   * signal makes a client "stop" abort immediately instead of waiting it out.
   * `AbortSignal.any` needs Node ≥18.17 / ≥20.3 — see package.json engines.
   */
  private buildSignal(runSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(120_000);
    return runSignal ? AbortSignal.any([timeout, runSignal]) : timeout;
  }
}
