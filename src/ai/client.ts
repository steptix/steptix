import type { AiConfig } from '../config/types.js';
import type {
  ChatMessage,
  LegacyStreamChunk,
  LegacyVisionResponse,
  ResponseContentBlock,
  StreamEvent,
  StreamResponseEnvelope,
  VisionRequest,
  VisionResponse,
} from './types.js';
import { TokenTracker } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

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

  constructor(config: AiConfig, tokenTracker: TokenTracker) {
    this.config = config;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Send messages to the AI and get a complete response.
   * Uses /v2/stream when streamResponses is true, otherwise /v2/vision.
   */
  async complete(messages: ChatMessage[]): Promise<CompleteResult> {
    if (this.config.streamResponses) {
      return this.completeStream(messages);
    }
    return this.completeVision(messages);
  }

  /** Call POST /v2/vision for non-streaming multimodal completion */
  private async completeVision(messages: ChatMessage[]): Promise<CompleteResult> {
    const url = `${this.config.gatewayUrl}/v2/vision`;

    const request: VisionRequest = {
      model: this.config.model,
      messages,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    };

    logger.debug(`POST ${url} (${messages.length} messages)`);

    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as VisionResponse | LegacyVisionResponse;

    if (data.usage) {
      this.tokenTracker.addUsage(
        data.usage.input_tokens,
        data.usage.output_tokens,
      );
      this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
    }

    const content = this.extractTextResponse(data);
    if (!content) {
      throw new Error(`AI response contained no content. Response keys: ${Object.keys(data).join(', ')}`);
    }

    const model = this.extractModel(data) ?? this.config.model;
    return { text: content, model };
  }

  /** Call POST /v2/stream for streaming multimodal completion, collect full response */
  private async completeStream(messages: ChatMessage[]): Promise<CompleteResult> {
    const url = `${this.config.gatewayUrl}/v2/stream`;

    const request: VisionRequest = {
      model: this.config.model,
      messages,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    };

    logger.debug(`POST ${url} (streaming, ${messages.length} messages)`);

    const response = await this.fetchWithAuth(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API stream error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('AI stream response has no body');
    }

    return this.consumeSseStream(response.body);
  }

  /** Consume an SSE stream and accumulate the full content string */
  private async consumeSseStream(body: ReadableStream<Uint8Array>): Promise<CompleteResult> {
    const { createParser } = await import('eventsource-parser');

    const decoder = new TextDecoder();
    let fullContent = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let streamedModel: string | undefined;

    await new Promise<void>((resolve, reject) => {
      const parser = createParser({
        onEvent: (event) => {
          if (event.data === '[DONE]') {
            resolve();
            return;
          }

          try {
            const parsed = JSON.parse(event.data) as StreamEvent | LegacyStreamChunk;

            if ('type' in parsed) {
              if (parsed.type === 'response.error') {
                reject(new Error(parsed.error.message));
                return;
              }

              if (parsed.type === 'response.start') {
                streamedModel = parsed.response.model ?? streamedModel;
              }

              if (parsed.type === 'response.content_block.delta' && parsed.delta.type === 'text_delta') {
                fullContent += parsed.delta.text;
              }

              if (parsed.type === 'response.completed') {
                const completed = parsed.response as StreamResponseEnvelope;
                promptTokens = completed.usage?.input_tokens ?? promptTokens;
                completionTokens = completed.usage?.output_tokens ?? completionTokens;
                streamedModel = completed.model ?? streamedModel;

                if (!fullContent) {
                  fullContent = this.extractTextFromBlocks(completed.content);
                }

                resolve();
              }
            } else {
              const delta = parsed.choices[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
              }

              if (parsed.usage) {
                promptTokens = parsed.usage.input_tokens;
                completionTokens = parsed.usage.output_tokens;
              }

              if (parsed.choices[0]?.finish_reason === 'stop') {
                resolve();
              }
            }
          } catch {
            // Ignore malformed chunks
          }
        },
      });

      const reader = body.getReader();

      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) {
            resolve();
            return;
          }
          parser.feed(decoder.decode(value, { stream: true }));
          pump();
        }, reject);
      };

      pump();
    });

    if (promptTokens > 0 || completionTokens > 0) {
      this.tokenTracker.addUsage(promptTokens, completionTokens);
      this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
    } else {
      // Estimate tokens if not provided
      const estimatedTokens = Math.ceil(fullContent.length / 4);
      this.tokenTracker.addUsage(0, estimatedTokens);
    }

    if (!fullContent) {
      throw new Error('AI stream produced no content');
    }

    return { text: fullContent, model: streamedModel ?? this.config.model };
  }

  private extractModel(data: VisionResponse | LegacyVisionResponse): string | undefined {
    const candidate = (data as Record<string, unknown>).model;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  }

  private extractTextResponse(data: VisionResponse | LegacyVisionResponse): string {
    if ('content' in data && Array.isArray(data.content)) {
      return this.extractTextFromBlocks(data.content);
    }

    const legacy = data as LegacyVisionResponse;
    return legacy.choices?.[0]?.message?.content
      ?? ((legacy as Record<string, unknown>).response as string | undefined)
      ?? '';
  }

  private extractTextFromBlocks(blocks: ResponseContentBlock[]): string {
    return blocks
      .filter((block): block is Extract<ResponseContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }

  private fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);

    if (this.config.apiKey) {
      headers.set('Authorization', `Bearer ${this.config.apiKey}`);
    }

    return fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
  }
}
