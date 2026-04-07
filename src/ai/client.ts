import type { AiConfig } from '../config/types.js';
import type {
  ChatMessage,
  VisionRequest,
  VisionResponse,
  StreamChunk,
} from './types.js';
import { TokenTracker } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

export class AiClient {
  private config: AiConfig;
  private tokenTracker: TokenTracker;

  constructor(config: AiConfig, tokenTracker: TokenTracker) {
    this.config = config;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Send messages to the AI and get a complete response.
   * Uses /v1/stream when streamResponses is true, otherwise /v1/vision.
   */
  async complete(messages: ChatMessage[]): Promise<string> {
    if (this.config.streamResponses) {
      return this.completeStream(messages);
    }
    return this.completeVision(messages);
  }

  /** Call POST /v1/vision for non-streaming multimodal completion */
  private async completeVision(messages: ChatMessage[]): Promise<string> {
    const url = `${this.config.gatewayUrl}/v1/vision`;

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

    const data = (await response.json()) as VisionResponse;

    if (data.usage) {
      this.tokenTracker.addUsage(
        data.usage.input_tokens,
        data.usage.output_tokens,
      );
      this.tokenTracker.checkStepBudget(this.config.maxInputTokens);
    }

    // Support both OpenAI-style (choices[0].message.content) and gateway-style (response) formats
    const content = data.choices?.[0]?.message?.content
      ?? (data as unknown as Record<string, unknown>).response as string | undefined;
    if (!content) {
      throw new Error(`AI response contained no content. Response keys: ${Object.keys(data).join(', ')}`);
    }

    return content;
  }

  /** Call POST /v1/stream for streaming multimodal completion, collect full response */
  private async completeStream(messages: ChatMessage[]): Promise<string> {
    const url = `${this.config.gatewayUrl}/v1/stream`;

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
  private async consumeSseStream(body: ReadableStream<Uint8Array>): Promise<string> {
    const { createParser } = await import('eventsource-parser');

    const decoder = new TextDecoder();
    let fullContent = '';
    let promptTokens = 0;
    let completionTokens = 0;

    await new Promise<void>((resolve, reject) => {
      const parser = createParser((event) => {
        if (event.type !== 'event') return;
        if (event.data === '[DONE]') {
          resolve();
          return;
        }

        try {
          const chunk = JSON.parse(event.data) as StreamChunk;

            // Accumulate content delta
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
            }

            // Check for usage info (some providers include it in the last chunk)
            const chunkWithUsage = chunk as StreamChunk & {
              usage?: { input_tokens: number; output_tokens: number };
            };
            if (chunkWithUsage.usage) {
              promptTokens = chunkWithUsage.usage.input_tokens;
              completionTokens = chunkWithUsage.usage.output_tokens;
            }

            // Check finish reason
            if (chunk.choices[0]?.finish_reason === 'stop') {
              resolve();
            }
        } catch {
          // Ignore malformed chunks
        }
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

    return fullContent;
  }

  private fetchWithAuth(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);

    if (this.config.apiKey) {
      headers.set('Authorization', `Bearer ${this.config.apiKey}`);
    }

    return fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
  }
}
