import { AIGateway } from '@pkent/aigateway';
import type { V2ContentBlock } from '@pkent/aigateway';
import type { AiConfig } from '../config/types.js';
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

  constructor(config: AiConfig, tokenTracker: TokenTracker) {
    this.config = config;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Build the `@pkent/aigateway` client bound to the current `model` + `apiKey`.
   * The model-string prefix drives routing: `baseURL` (the gateway `/v1`
   * surface) is supplied ONLY for `aibroker/` models — for direct models
   * (`openai/…`, `anthropic/…`, …) passing it would point the provider's own SDK
   * at the gateway instead of the real upstream.
   */
  private buildGateway(): AIGateway {
    const opts = this.config.model.startsWith('aibroker/')
      ? { baseURL: `${this.config.gatewayUrl.replace(/\/+$/, '')}/v1` }
      : {};
    return new AIGateway(this.config.model, this.config.apiKey ?? '', opts);
  }

  /** Lazily build + memoize the gateway on first use. */
  private getGateway(): AIGateway {
    return (this.gateway ??= this.buildGateway());
  }

  /**
   * Re-point the client at a new `model` / `apiKey` — used when a saved `.env`
   * edit changes `AI_MODEL` / `AI_API_KEY` between runs on a reused session.
   * Only these two fields are env-mutable; every other field (gatewayUrl,
   * maxInputTokens, streaming) is server-level and left untouched.
   *
   * `@pkent/aigateway` binds the model at construction AND the `baseURL` choice
   * depends on the model prefix, so a model change OR a key change invalidates
   * the cached gateway — it's rebuilt on the next {@link getGateway} call.
   *
   * Returns a short, key-safe description of what changed (for logging), or
   * `null` when nothing changed. The returned string NEVER contains the key
   * value — only the fact that it changed.
   */
  syncAuth(model: string, apiKey: string | undefined): string | null {
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
    // A model or key change invalidates the cached gateway (the model is bound
    // at construction and the baseURL choice depends on the model prefix).
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
  async complete(messages: ChatMessage[], signal?: AbortSignal): Promise<CompleteResult> {
    if (this.config.streamResponses) {
      return this.completeStream(messages, signal);
    }
    return this.completeOnce(messages, signal);
  }

  /** Non-streaming chat completion. */
  private async completeOnce(messages: ChatMessage[], signal?: AbortSignal): Promise<CompleteResult> {
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
      v2 = await this.getGateway().chat(messages, {
        maxTokens: 4096,
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
  private async completeStream(messages: ChatMessage[], signal?: AbortSignal): Promise<CompleteResult> {
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
      const stream = this.getGateway().stream(messages, {
        maxTokens: 4096,
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
