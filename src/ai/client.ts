import OpenAI from 'openai';
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

/**
 * Map the consumer's `ChatMessage[]` onto the OpenAI SDK's
 * `ChatCompletionMessageParam[]`. The shapes are already compatible (`role` +
 * `content` string | array of `{type:'text',text}` / `{type:'image_url',image_url:{url}}`);
 * the only transform is stripping the `cache` hint from content blocks, since
 * OpenAI's content-part types don't carry it and the gateway does no caching.
 *
 * The SDK's `ChatCompletionMessageParam` is a narrower role-discriminated union
 * (e.g. `role:'tool'` requires `tool_call_id`; `system`/`tool` content is
 * text-only). The consumer never emits `role:'tool'` and system content is
 * text-only blocks, so a `cache`-stripped `ChatMessage[]` is value-compatible —
 * a narrowing cast bridges what the compiler can't prove.
 */
function toOpenAIMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const mapped = messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    const content = (m.content as MessageContentBlock[]).map((b) => {
      if (b.type === 'image_url') {
        return { type: 'image_url', image_url: { url: b.image_url.url } };
      }
      return { type: 'text', text: b.text };
    });
    return { role: m.role, content };
  });
  return mapped as OpenAI.ChatCompletionMessageParam[];
}

/** Result of a single AI completion, including which model the gateway actually served. */
export interface CompleteResult {
  /** The assembled text response from the AI */
  text: string;
  /** The model reported by the gateway response envelope, or the configured model if the gateway omitted it */
  model: string;
}

export class AiClient {
  private config: AiConfig;
  private tokenTracker: TokenTracker;
  private client: OpenAI;

  constructor(config: AiConfig, tokenTracker: TokenTracker) {
    this.config = config;
    this.tokenTracker = tokenTracker;
    this.client = this.buildClient();
  }

  /**
   * Build the `openai` client bound to the gateway's `/v1` surface. The Bearer
   * token (`apiKey`) is bound at construction, so a key change requires a
   * rebuild (see {@link syncAuth}). `maxRetries: 0` matches the old fetch
   * client — no auto-retry, avoiding duplicate calls / surprise latency.
   */
  private buildClient(): OpenAI {
    return new OpenAI({
      baseURL: `${this.config.gatewayUrl.replace(/\/+$/, '')}/v1`,
      apiKey: this.config.apiKey ?? '',
      maxRetries: 0,
    });
  }

  /**
   * Re-point an already-bound client at a new `model` / `apiKey` — used when a
   * saved `.env` edit changes `AI_MODEL` / `AI_API_KEY` between runs on a reused
   * session. Only these two fields are env-mutable; every other field
   * (gatewayUrl, maxInputTokens, streaming) is server-level and left untouched.
   *
   * A `model` change applies per request via the `model` field (no rebuild). An
   * `apiKey` change rebuilds the `openai` client, since the key is bound at
   * construction.
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
      // The Bearer token is bound at construction — rebuild so the next request
      // authenticates with the new key.
      this.client = this.buildClient();
    }
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

    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: toOpenAIMessages(messages),
          max_completion_tokens: 4096,
          response_format: { type: 'json_object' },
        },
        { signal: this.buildSignal(signal) },
      );
    } catch (err) {
      logger.trace(`ai.response#${requestId}`, {
        ok: false,
        body: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const text = res.choices[0]?.message?.content ?? '';
    if (res.usage) {
      this.tokenTracker.addUsage(res.usage.prompt_tokens, res.usage.completion_tokens);
      this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
    }

    const model = res.model || this.config.model;
    logger.trace(`ai.response#${requestId}`, {
      ok: true,
      model,
      usage: res.usage,
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
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: toOpenAIMessages(messages),
          max_completion_tokens: 4096,
          response_format: { type: 'json_object' },
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: this.buildSignal(signal) },
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) text += delta;
        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }
    } catch (err) {
      logger.trace(`ai.response#${requestId}`, {
        ok: false,
        body: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (promptTokens > 0 || completionTokens > 0) {
      this.tokenTracker.addUsage(promptTokens, completionTokens);
      this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
    } else {
      // Estimate tokens if the stream omitted usage (matches the old behavior).
      this.tokenTracker.addUsage(0, Math.ceil(text.length / 4));
    }

    logger.trace(`ai.response#${requestId}`, {
      ok: true,
      streaming: true,
      model,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
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
