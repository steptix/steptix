/**
 * Minimal ambient declaration for `@pkent/aigateway` (a plain-JS package that
 * ships no `.d.ts`). Declares only the surface {@link AiClient} consumes:
 * the `AIGateway` class plus the v2 response/stream shapes.
 *
 * Kept deliberately narrow — `messages` and call-options are `unknown`/loosely
 * typed because the consumer passes its own `ChatMessage[]` straight through and
 * the library validates/normalizes them itself. Mirrors the runtime shapes in
 * `../aigateway/src/{AIGateway,lib/v2,stream/ChatStream}.js`.
 */
declare module '@pkent/aigateway' {
  /** Usage block on the v2 envelope (absent on the stream estimate-fallback path). */
  export interface V2Usage {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    /** Input tokens the provider served from its prompt cache, normalised by
     *  the library from OpenAI's `prompt_tokens_details.cached_tokens` and
     *  Anthropic's `cache_read_input_tokens`. Absent when not reported. */
    cached_input_tokens?: number;
  }

  /** A single normalized content block; only `type:'text'` blocks carry `text`. */
  export interface V2ContentBlock {
    type: string;
    text?: string;
  }

  /** The v2 response envelope returned by `chat()` and resolved by `stream().final`. */
  export interface V2Response {
    /** The bound `<provider>/<model>` id the gateway echoes (not the upstream's model). */
    model?: string;
    content: V2ContentBlock[];
    usage?: V2Usage;
  }

  /** A single streamed delta yielded by the async iterator. */
  export interface V2TextDelta {
    type: 'text_delta';
    text: string;
  }

  /**
   * Async-iterable stream of text deltas plus a `.final` promise resolving to
   * the full v2 envelope once the upstream stream completes.
   */
  export type ChatStream = AsyncIterable<V2TextDelta> & {
    final: Promise<V2Response>;
  };

  /**
   * Reasoning effort — the union of the three upstream vocabularies. The
   * library forwards it verbatim and does not translate between them, so a
   * level the bound model does not support comes back as that provider's own
   * error. Unset leaves the request body byte-for-byte what it is without it.
   */
  export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Options accepted by a single `chat`/`stream` call. */
  export interface CallOptions {
    maxTokens?: number;
    effort?: Effort;
    temperature?: number;
    responseFormat?: { type: string };
    signal?: AbortSignal;
    timeout?: number;
  }

  /** Options accepted by the `AIGateway` constructor. */
  export interface GatewayOptions {
    /** Required by the `aibroker` provider; the gateway URL (with `/v1`). */
    baseURL?: string;
    maxTokens?: number;
    effort?: Effort;
    timeout?: number;
    referer?: string;
    title?: string;
    client?: unknown;
  }

  /**
   * One registered provider, as reported by {@link AIGateway.providers}.
   *
   * Exactly three fields, deliberately: this file is a hand-maintained mirror
   * that goes stale silently, so every field declared here is one more thing to
   * keep true. `selfAuthenticating` is present only on providers that resolve
   * their own credentials (Bedrock signs with the AWS credential chain), which
   * is why it is optional rather than a boolean on every entry.
   */
  export interface ProviderEntry {
    id: string;
    prefix: string;
    selfAuthenticating?: boolean;
  }

  /**
   * A provider-neutral LLM client bound to one model + one API key. The model
   * string selects the provider via prefix matching; `new AIGateway(...)` throws
   * on an empty key — unless the provider self-authenticates — and binds the
   * model at construction.
   */
  export class AIGateway {
    constructor(model: string, key: string, options?: GatewayOptions);
    get model(): string;
    get provider(): string;
    chat(messages: unknown, callOptions?: CallOptions): Promise<V2Response>;
    stream(messages: unknown, callOptions?: CallOptions): ChatStream;
    /**
     * The registered providers and their `<id>/` model prefixes. Asked rather
     * than mirrored: the alternative is a second list of key-free prefixes in
     * this repo, drifting against the library's.
     */
    static providers(): ProviderEntry[];
  }

  export default AIGateway;

  export class AIGatewayError extends Error {
    code?: string;
  }
}
