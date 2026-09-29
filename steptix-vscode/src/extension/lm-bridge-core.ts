/**
 * The Copilot bridge's translation layer — OpenAI chat-completions wire in,
 * `vscode.lm` shapes out (stories/copilot-lm-bridge.md §Part A).
 *
 * Deliberately free of `vscode`, `node:http` and every other import: message
 * folding, the image forward/strip rule, the fence strip, SSE framing, error
 * mapping and model-id resolution are all data in / data out, so the whole
 * translation table is covered by `node --test` with no extension host.
 * lm-bridge.ts owns the socket, the secret, the `vscode.lm` calls and the
 * feature detection that picks the {@link ImageMode}, and holds no rules of
 * its own.
 *
 * The one shape assumption worth stating: the caller on the other end is
 * always this framework's `AiClient` via `@pkent/aigateway`, which is the
 * OpenAI SDK. So the request is OpenAI-canonical, and the response has to
 * satisfy that SDK's parser — not a hand-rolled reader that would forgive a
 * missing `finish_reason` or a bare `[DONE]`.
 */

/** vscode.lm has two roles and no system role; see {@link translateRequest}. */
export type BridgeRole = 'user' | 'assistant';

/** One image, still base64 — {@link imageBytes} decodes it at the vscode seam. */
export interface BridgeImagePart {
  kind: 'image';
  /** Lower-cased, from the `data:` URL: `image/png` is all the server sends. */
  mime: string;
  base64: string;
}

export interface BridgeTextPart {
  kind: 'text';
  text: string;
}

export type BridgePart = BridgeTextPart | BridgeImagePart;

/**
 * One message, as ordered parts.
 *
 * Adjacent text is coalesced into one part, joined by `\n` — the join the
 * text-only bridge always used — so a message without images has exactly one
 * text part and reaches `vscode.lm` as the same plain string it always did.
 * Only a forwarded image splits a message into several parts, and only in a
 * user message (see {@link translateRequest}).
 */
export interface BridgeMessage {
  role: BridgeRole;
  parts: BridgePart[];
}

/**
 * What the bridge does with an image block (SPEC-use-computer §15.2).
 *
 * `forward` when the running VS Code has `LanguageModelDataPart.image`, `strip`
 * when it does not. Decided by the vscode layer's feature detection and passed
 * in, so this module stays free of `vscode`.
 */
export type ImageMode = 'forward' | 'strip';

/** A text-only message — the warm-up call, and tests. */
export function textMessage(role: BridgeRole, text: string): BridgeMessage {
  return { role, parts: [{ kind: 'text', text }] };
}

/** The text of a message, image parts left out, text parts joined by `\n`. */
export function messageText(message: BridgeMessage): string {
  return message.parts
    .filter((p): p is BridgeTextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * The same message with its images removed — what `countTokens` is given.
 *
 * Image tokens are NOT measured. `countTokens` hands the message to the
 * provider's tokenizer, and nothing documents what one does with a data part:
 * it may throw, or it may count the base64 as text, which for a screenshot is a
 * six-figure number of tokens that were never charged. Usage is a nicety and
 * must not fail a completion that already succeeded, so an image contributes
 * nothing and the prompt count is a floor on image-carrying requests.
 */
export function textProjection(message: BridgeMessage): BridgeMessage {
  if (message.parts.length === 1 && message.parts[0]!.kind === 'text') return message;
  return textMessage(message.role, messageText(message));
}

/** An image part's bytes, in a fresh buffer of their own (no pooled offset). */
export function imageBytes(part: BridgeImagePart): Uint8Array {
  return Uint8Array.from(Buffer.from(part.base64, 'base64'));
}

/** OpenAI's error envelope, which the OpenAI SDK unwraps into its exception. */
export interface BridgeErrorBody {
  error: { message: string; type: string; code: string };
}

/** An error response, ready to write: HTTP status + JSON body. */
export interface BridgeError {
  status: number;
  body: BridgeErrorBody;
}

/** A request, reduced to the parts `vscode.lm` can actually act on. */
export interface TranslatedRequest {
  /** Whatever followed `gateway/` in AI_MODEL — see {@link modelSelectorAttempts}. */
  model: string;
  messages: BridgeMessage[];
  /** `stream: true` — answered as ONE delta plus `[DONE]`, never incrementally. */
  stream: boolean;
  /** `response_format: {type: "json_object"}` — drives the fence strip. */
  wantsJson: boolean;
  /** Passed straight to `sendRequest`'s `modelOptions`; empty when nothing mapped. */
  modelOptions: Record<string, unknown>;
  /**
   * Image blocks replaced by {@link IMAGE_OMITTED_NOTE}, in either mode. On the
   * `strip` path this drives the once-per-window warning; on `forward` it
   * counts only the blocks that cannot be forwarded (a non-`data:` URL, or an
   * image in an assistant or system message).
   */
  imagesStripped: number;
  /** Image parts that will reach the model; > 0 arms the 400 in {@link mapCompletionError}. */
  imagesForwarded: number;
}

export type TranslateResult =
  | { ok: true; value: TranslatedRequest }
  | { ok: false; error: BridgeError };

export interface TranslateOptions {
  /** Defaults to `strip`: forwarding is only safe once the caller has detected support. */
  imageMode?: ImageMode;
}

/**
 * Substituted inline wherever an image block is dropped, so the model is told
 * something was removed rather than silently answering about a screenshot it
 * never saw. Every strip uses it, in both modes: a host without
 * `LanguageModelDataPart` (the whole `strip` mode), and on `forward` an image
 * the bridge cannot send — a non-`data:` URL it has no business fetching, or
 * one in an assistant or system message. Stripping rather than refusing,
 * because the diagnosis pass attaches a screenshot regardless of
 * `ai.sendScreenshots`, so a refusal would break diagnosis on every failed
 * keyed run on an older VS Code. The wording is load-bearing, not cosmetic:
 * the computer-mode prompt tells the model not to guess coordinates when a
 * message says its screenshot was omitted (SPEC-use-computer §15.5).
 */
export const IMAGE_OMITTED_NOTE = '[screenshot omitted — images unsupported over the bridge]';

/**
 * Shown once per window the first time an image is dropped on the `strip`
 * path — the only path where "your VS Code cannot do this" is the reason.
 *
 * It names every sender because the wire cannot tell them apart: an
 * `image_url` block from `ai.sendScreenshots`, one the diagnosis pass captured
 * on its own, and a computer-mode turn's screen all look identical here.
 * Naming only the setting would send someone to turn off a setting that is
 * already off.
 */
export const IMAGE_STRIP_WARNING =
  'Steptix Copilot bridge: an image was dropped from an AI request because ' +
  'this VS Code has no image support for language models (no ' +
  'vscode.LanguageModelDataPart), so the request went through text-only. Update ' +
  'VS Code to send screenshots to the model. Three things attach images: ' +
  'computer-mode steps ([use computer]), which cannot work without them; ' +
  "`ai.sendScreenshots` in the project's steptix.config.json (off by default); and " +
  'the failure-diagnosis pass, which captures its own screenshot regardless of ' +
  'that setting.';

/** Usage as the OpenAI wire spells it. */
export interface BridgeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * What goes on the wire when counting could not be done.
 *
 * `vscode.lm` reports no usage of its own, so the bridge measures it with the
 * model's own `countTokens` — free of Copilot credits and about 0.12 ms plus
 * 0.03 ms/KB, both measured. When that fails the completion still has to be
 * served: usage is a nicety, the answer is the product. Zeros are the honest
 * way to say "not measured", and `AiClient` already treats zero-or-absent usage
 * on the streaming path as missing.
 *
 * Frozen because it is a module singleton every fallback spreads: a consumer
 * that aliased it instead of copying could otherwise corrupt the constant for
 * the rest of the extension host's life, at exactly the moment something has
 * already gone wrong.
 */
export const ZERO_USAGE: Readonly<BridgeUsage> = Object.freeze({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type BridgeRoute = 'models' | 'completions' | 'unknown';

/**
 * Which endpoint a request is for. Query strings and a trailing slash are
 * tolerated; anything else is `unknown` and answered with a 404 that names the
 * two paths — a bridge that 404s silently reads exactly like a bridge that is
 * not running, and the two have completely different fixes.
 */
export function routeFor(method: string | undefined, url: string | undefined): BridgeRoute {
  const path = (url ?? '').split('?')[0]!.replace(/\/+$/, '') || '/';
  const verb = (method ?? '').toUpperCase();
  if (verb === 'GET' && path === '/v1/models') return 'models';
  if (verb === 'POST' && path === '/v1/chat/completions') return 'completions';
  return 'unknown';
}

/**
 * `Authorization: Bearer <token>` and nothing else.
 *
 * This is the whole of what stops any other local process from spending the
 * user's Copilot seat: the token lives in SecretStorage and the project's
 * gitignored `.env`, the same trust level as `AI_API_KEY`. The comparison runs
 * over the full length regardless of where it first differs — a length-only
 * short-circuit is fine (that much is public), a value-dependent one is not.
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!token) return false;
  const raw = (header ?? '').trim();
  if (!/^bearer\s/i.test(raw)) return false;
  const presented = raw.replace(/^bearer\s+/i, '');
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `data:image/<type>[;params];base64,<data>` → mime + base64, or `null`.
 *
 * `null` for anything else — an `https:` URL (the bridge has no business
 * fetching the network on a prompt's behalf), a non-image `data:` URL, or a
 * payload that is not base64 — and the caller strips it with the note. The
 * alphabet check matters because `Buffer.from(…, 'base64')` never fails: it
 * skips what it cannot read, so a corrupt payload would otherwise reach the
 * model as a silently different image.
 */
export function parseImageDataUrl(url: string): { mime: string; base64: string } | null {
  const head = /^data:(image\/[a-z0-9.+-]+)(?:;[^;,]*)*;base64,/i.exec(url);
  if (!head) return null;
  const base64 = url.slice(head[0].length);
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  return { mime: head[1]!.toLowerCase(), base64 };
}

/** The URL of an OpenAI image block: `image_url: {url}`, or a bare string. */
function imageUrlOf(block: Record<string, unknown>): string | null {
  const field = block['image_url'];
  if (typeof field === 'string') return field;
  if (isRecord(field) && typeof field['url'] === 'string') return field['url'];
  return null;
}

interface ExtractedContent {
  parts: BridgePart[];
  stripped: number;
  forwarded: number;
}

/**
 * One message's `content` as ordered parts.
 *
 * Adjacent text coalesces with `\n` — see {@link BridgeMessage} — and a
 * stripped image becomes {@link IMAGE_OMITTED_NOTE} text that coalesces like
 * any other, so the `strip` output is byte-for-byte what the text-only bridge
 * produced. On `forward`, a `data:` image becomes an image part in place.
 *
 * Unknown block types are dropped without a word: the same rule the whole
 * translation table applies to unknown request fields, and for the same
 * reason — this bridge sits under a client that is free to add fields, and an
 * error there would break a compile over something cosmetic.
 */
function extractContent(content: unknown, mode: ImageMode): ExtractedContent {
  const parts: BridgePart[] = [];
  let stripped = 0;
  let forwarded = 0;
  const pushText = (text: string): void => {
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') last.text = `${last.text}\n${text}`;
    else parts.push({ kind: 'text', text });
  };

  if (typeof content === 'string') return { parts: [{ kind: 'text', text: content }], stripped, forwarded };
  if (!Array.isArray(content)) return { parts, stripped, forwarded };
  for (const block of content) {
    if (typeof block === 'string') {
      pushText(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const type = block['type'];
    if (type === 'text' && typeof block['text'] === 'string') {
      pushText(block['text']);
    } else if (type === 'image_url' || type === 'image' || type === 'input_image') {
      const url = mode === 'forward' ? imageUrlOf(block) : null;
      const image = url === null ? null : parseImageDataUrl(url);
      if (image) {
        parts.push({ kind: 'image', ...image });
        forwarded++;
      } else {
        pushText(IMAGE_OMITTED_NOTE);
        stripped++;
      }
    }
  }
  return { parts, stripped, forwarded };
}

/** No image and no non-empty text — the old `if (!text) continue`, for parts. */
function isEmpty(parts: BridgePart[]): boolean {
  return !parts.some((p) => p.kind === 'image' || p.text !== '');
}

/** The folded system text, ahead of a user message's first part. */
function prependText(prefix: string, parts: BridgePart[]): BridgePart[] {
  const [first, ...rest] = parts;
  if (first?.kind === 'text') return [{ kind: 'text', text: `${prefix}\n\n${first.text}` }, ...rest];
  return [{ kind: 'text', text: prefix }, ...parts];
}

/**
 * Reduce an OpenAI request to {@link TranslatedRequest}, or refuse it.
 *
 * The two structural rules from the translation table:
 *
 * - **System folds.** `vscode.lm` has only User and Assistant, so every
 *   `system` (and `developer`) message is joined in order and prepended to the
 *   FIRST user message. Dropping it instead would silently discard the entire
 *   instruction half of every prompt this framework sends.
 * - **Images forward or strip** (SPEC-use-computer §15.2). On `forward`, a
 *   `data:` image in a user message becomes an image part, in order with its
 *   text. Everything else strips to {@link IMAGE_OMITTED_NOTE}: every image on
 *   `strip`, and on `forward` a non-`data:` URL, an image in an assistant
 *   message (the spec gives vscode.lm assistant messages no data parts, and
 *   the server never sends one), and an image in a system message (the fold
 *   below is a text join, unchanged).
 *
 * Everything the table marks "drop silently" — `reasoning_effort`,
 * `stream_options`, `temperature`, unknown keys — is simply never read: the
 * `retry`/`authoring` profiles send effort and every stream carries
 * `stream_options`, so erroring on them would break the paths this bridge
 * exists to serve.
 */
export function translateRequest(raw: unknown, options: TranslateOptions = {}): TranslateResult {
  const imageMode = options.imageMode ?? 'strip';
  if (!isRecord(raw)) {
    return { ok: false, error: badRequest('The request body must be a JSON object.') };
  }

  const model = typeof raw['model'] === 'string' ? raw['model'].trim() : '';
  if (!model) {
    return {
      ok: false,
      error: badRequest(
        'The request has no "model". Set AI_MODEL=gateway/<vendor>/<id> in the ' +
          "project .env; GET /v1/models on this bridge lists the ids this seat offers.",
      ),
    };
  }

  const rawMessages = raw['messages'];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, error: badRequest('The request has no "messages".') };
  }

  const systemParts: string[] = [];
  const messages: BridgeMessage[] = [];
  let imagesStripped = 0;
  let imagesForwarded = 0;

  for (const entry of rawMessages) {
    if (!isRecord(entry)) continue;
    const role = typeof entry['role'] === 'string' ? entry['role'] : 'user';
    const isSystem = role === 'system' || role === 'developer';
    // `tool` / `function` / anything unrecognised lands as User: vscode.lm has
    // no third role, and losing the turn entirely is worse than mislabelling it.
    const bridgeRole: BridgeRole = role === 'assistant' ? 'assistant' : 'user';
    // Only a user message can carry an image part; see the doc comment.
    const mode: ImageMode = isSystem || bridgeRole === 'assistant' ? 'strip' : imageMode;
    const { parts, stripped, forwarded } = extractContent(entry['content'], mode);
    imagesStripped += stripped;
    imagesForwarded += forwarded;
    if (isEmpty(parts)) continue;
    if (isSystem) {
      // Always a single text part: `strip` mode leaves nothing else.
      systemParts.push(messageText({ role: 'user', parts }));
      continue;
    }
    messages.push({ role: bridgeRole, parts });
  }

  if (systemParts.length > 0) {
    const folded = systemParts.join('\n\n');
    const firstUser = messages.findIndex((m) => m.role === 'user');
    if (firstUser === -1) {
      // A system-only request (or system + assistant) still has to arrive as
      // something vscode.lm will answer, and only a User message qualifies.
      messages.unshift(textMessage('user', folded));
    } else {
      messages[firstUser] = {
        role: 'user',
        parts: prependText(folded, messages[firstUser]!.parts),
      };
    }
  }

  if (messages.length === 0) {
    return {
      ok: false,
      error: badRequest('The request carried no message content the bridge could forward.'),
    };
  }

  const responseFormat = raw['response_format'];
  const wantsJson = isRecord(responseFormat) && responseFormat['type'] === 'json_object';

  // `max_completion_tokens` is the ONLY spelling that arrives: @pkent/aigateway
  // writes the consumer's `maxTokens` under that name, and never sends
  // `max_tokens`. Passed under modelOptions, which providers read at their own
  // discretion — a provider that ignores the key just uses its own default,
  // which is why this is "where supported" rather than a hard mapping.
  const cap = raw['max_completion_tokens'];
  const modelOptions: Record<string, unknown> =
    typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? { max_tokens: cap } : {};

  return {
    ok: true,
    value: {
      model,
      messages,
      stream: raw['stream'] === true,
      wantsJson,
      modelOptions,
      imagesStripped,
      imagesForwarded,
    },
  };
}

/** JSON.parse in front of {@link translateRequest}, both failures shaped alike. */
export function translateBody(text: string, options: TranslateOptions = {}): TranslateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: bridgeError(
        400,
        `The request body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_request_error',
        'bad_request',
      ),
    };
  }
  return translateRequest(parsed, options);
}

/**
 * Refused beyond this; a prompt this large is a bug, not a big page.
 *
 * Unchanged by image forwarding, because it already has room: the server caps
 * the longer side of a computer-mode screenshot at 1600 px
 * (`DEFAULT_MAX_IMAGE_WIDTH`, src/desktop/capture.ts) and sends it as PNG
 * base64. A realistic 1600×670 screen is a few hundred KB of base64; even the
 * worst case, a 1600×1600 RGBA image that does not compress at all, is
 * 10.2 MB raw → 13.7 MB of base64 — under half the cap with a 1 MB page
 * snapshot beside it. Nothing the server sends today gets near it.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The 413 for a body of `size` bytes, or `null` while it is still acceptable.
 *
 * A predicate over a byte count rather than a check inside the read loop, so
 * the boundary is testable without pushing 32MB through a socket. The cap
 * itself is allowed — only what exceeds it is refused.
 */
export function bodyLimitError(size: number): BridgeError | null {
  if (size <= MAX_BODY_BYTES) return null;
  return bridgeError(
    413,
    `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
    'invalid_request_error',
    'payload_too_large',
  );
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export interface LmSelector {
  vendor?: string;
  family?: string;
  id?: string;
}

/**
 * The selectors to try, in order, for a requested model string.
 *
 * `gateway/copilot/gpt-4.1` reaches this as `copilot/gpt-4.1` — the routing
 * library strips exactly the first segment and forwards the rest verbatim.
 * Exact id first, so a seat whose ids genuinely contain a slash still wins;
 * then the vendor split (open question 1); then `family`, because Copilot's
 * `family` is the readable name a user is most likely to have copied and the
 * `id` is documented as opaque.
 *
 * The caller stops at the first selector that returns a model.
 */
export function modelSelectorAttempts(model: string): LmSelector[] {
  const trimmed = model.trim();
  const attempts: LmSelector[] = [{ id: trimmed }];
  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    const vendor = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash + 1);
    attempts.push({ vendor, id: rest }, { vendor, family: rest });
  } else {
    attempts.push({ family: trimmed });
  }
  return attempts;
}

/** The id written into `.env` after `gateway/`, and advertised by /v1/models. */
export function qualifiedModelId(model: { vendor: string; id: string }): string {
  return `${model.vendor}/${model.id}`;
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/**
 * Strip ONE leading/trailing ``` fence pair.
 *
 * `vscode.lm` has no JSON mode, and a model asked for JSON without one likes
 * to wrap it in markdown. Code-behind compile parses a strict `{"entry":…}`
 * envelope out of this response, so a stray fence is a failed compile with a
 * confusing message. Exactly one pair, and only when the fence brackets the
 * WHOLE response — a fence in the middle of prose belongs to the content.
 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) return text;
  // Only a bare language tag may sit on the opening line; anything else means
  // this is content that happens to start with a fence.
  const tag = trimmed.slice(3, firstNewline).trim();
  if (tag && !/^[A-Za-z0-9_+-]+$/.test(tag)) return text;
  const rest = trimmed.slice(firstNewline + 1);
  const close = rest.lastIndexOf('```');
  if (close === -1) return text;
  if (rest.slice(close + 3).trim() !== '') return text;
  return rest.slice(0, close).replace(/\r?\n$/, '');
}

export interface CompletionShape {
  id: string;
  created: number;
  model: string;
  text: string;
  /** Measured by `countTokens`, or {@link ZERO_USAGE} when that was not possible. */
  usage: BridgeUsage;
}

/** The non-streaming `chat.completion` body. */
export function chatCompletionBody(c: CompletionShape): Record<string, unknown> {
  return {
    id: c.id,
    object: 'chat.completion',
    created: c.created,
    model: c.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: c.text },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { ...c.usage },
  };
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * The whole SSE body for a `stream: true` request: one delta carrying the
 * complete text, one empty delta carrying `finish_reason`, then `[DONE]`.
 *
 * Single-delta because the response was already buffered — the fence strip
 * cannot un-emit deltas that already left. The upside is that a mid-stream
 * `vscode.lm` failure becomes a whole-request error carrying the real message
 * (the quota text survives) instead of a truncated completion that looks like
 * a model returning nonsense.
 *
 * Usage rides on the finish chunk because `stream_options: {include_usage:
 * true}` is on every streamed request. It matters that this is real:
 * `completeStream` treats absent-or-zero usage as missing and estimates output
 * tokens at `len/4`, so a measured count is what stops a streamed bridge call
 * reporting a number derived from the response's string length.
 *
 * It rides on a chunk that still carries a `choices` entry, which works because
 * the client reads usage off ANY chunk that has it (@pkent/aigateway's
 * `openaiCompatible` provider). OpenAI's own `include_usage` convention is a
 * separate trailing chunk with `choices: []`, so a stricter client than the one
 * this bridge is built for would drop these numbers on the floor. Worth knowing
 * before pointing anything else at it.
 */
export function streamFrames(c: CompletionShape): string[] {
  const base = { id: c.id, object: 'chat.completion.chunk', created: c.created, model: c.model };
  return [
    sse({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: c.text }, finish_reason: null }],
    }),
    sse({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { ...c.usage },
    }),
    'data: [DONE]\n\n',
  ];
}

/** `steptix_bridge.name` on `GET /v1/models` — how the server recognises this bridge. */
export const BRIDGE_NAME = 'steptix-copilot-bridge';

/**
 * `GET /v1/models` — what the seat offers, in OpenAI's list shape, plus two
 * additive fields (SPEC-use-computer §15.3) that are a contract with the
 * server's computer-mode precondition (§15.4):
 *
 * - `steptix_bridge: {name, images}` — its presence is how the server tells this
 *   bridge from a corporate gateway, and `images` is what §15.2's detection
 *   found: `strip` means computer mode would be blind here.
 * - `image_input` per model — `true`/`false` when the running VS Code exposes
 *   the model's capabilities on the consumer object, `null` when it does not
 *   ("forwarded; the model decides").
 */
export function modelsListBody(
  models: Array<{ id: string; vendor: string; family?: string; imageInput?: boolean | null }>,
  created: number,
  images: ImageMode,
): Record<string, unknown> {
  return {
    object: 'list',
    steptix_bridge: { name: BRIDGE_NAME, images },
    data: models.map((m) => ({
      // The vendor-qualified form, because that is what goes in `.env` after
      // `gateway/` — a list whose ids had to be edited before use would not
      // meet the "see valid ids without guessing" this endpoint exists for.
      id: qualifiedModelId(m),
      object: 'model',
      created,
      owned_by: m.vendor,
      ...(m.family !== undefined && { family: m.family }),
      image_input: m.imageInput ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function bridgeError(
  status: number,
  message: string,
  type: string,
  code: string,
): BridgeError {
  return { status, body: { error: { message, type, code } } };
}

/**
 * Codes whose response must carry `x-should-retry: false`.
 *
 * The OpenAI SDK retries a 429 and every 5xx twice by default, so ONE failed
 * AI call becomes three round trips into `vscode.lm` — and each retry re-runs
 * the model request, which on a partly-generated response has already spent
 * premium requests. On a bridge whose entire reason for existing is quota
 * arithmetic, tripling the cost of the quota-exhausted error is the wrong way
 * round. The SDK reads this header ahead of its status-code table, so naming
 * the terminal conditions turns three calls back into one.
 *
 * `lm_error` counts as terminal for the same reason: an unclassified provider
 * failure has already reached the model, and asking twice more buys nothing
 * but spend. What is deliberately NOT here is anything the client could
 * usefully retry — there is nothing in that set today, which is the point.
 */
const TERMINAL_CODES = new Set([
  'quota_exhausted',
  'no_permissions',
  'model_not_found',
  'lm_unavailable',
  'lm_error',
  // A 400, which the SDK does not retry anyway — listed because the model WAS
  // called, and a retry would send the same image to the same model.
  'image_input_unsupported',
]);

/** Should the client be told not to retry this? See {@link TERMINAL_CODES}. */
export function isTerminalError(error: BridgeError): boolean {
  return TERMINAL_CODES.has(error.body.error.code);
}

function badRequest(message: string): BridgeError {
  return bridgeError(400, message, 'invalid_request_error', 'bad_request');
}

/**
 * 401 — no token, the wrong token, or a token from another machine.
 *
 * The token is minted per machine and kept in SecretStorage, which is never
 * synced, so a `.env` copied to a second machine authenticates against a token
 * that was never minted there. That is the single likeliest cause, so it is the
 * one the message names first.
 *
 * The overlay is named second, unconditionally, because it is the cause a
 * reader cannot get to on their own: the `.env` in front of them is correct,
 * and nothing in a 401 suggests another file beat it. It cannot be detected
 * here — one listener serves every window, `activeEnv` is per workspace, and a
 * request carries only a Bearer token — so the message names the MECHANISM and
 * never a value. The value is logged by the window that owns the workspace, on
 * every run (run-controller's `.env.<name> overlaid` line).
 */
export function unauthorizedError(): BridgeError {
  return bridgeError(
    401,
    'The Steptix Copilot bridge needs "Authorization: Bearer <token>" with the ' +
      'token from AI_API_KEY, written by "Steptix: Use Copilot for AI". If that ' +
      'line came from another machine it will not work here — the token lives in ' +
      "this machine's VS Code SecretStorage, which Settings Sync does not " +
      'replicate. Rerun the setup command in this window. Or this workspace has an ' +
      'active environment (steptix.activeEnv) whose .env.<name> sets its ' +
      'own AI_API_KEY over .env — then that file is the one to fix, and rerunning ' +
      'setup with the environment active offers to write it there.',
    'invalid_request_error',
    'invalid_api_key',
  );
}

/** 404 on any path other than the two this bridge serves. */
export function unknownRouteError(method: string | undefined, url: string | undefined): BridgeError {
  return bridgeError(
    404,
    `The Steptix Copilot bridge serves GET /v1/models and POST /v1/chat/completions; ` +
      `${(method ?? '?').toUpperCase()} ${url ?? '?'} is neither. AI_GATEWAY_URL must be the ` +
      'bare origin (http://127.0.0.1:<port>) — the client appends /v1 itself.',
    'invalid_request_error',
    'unknown_route',
  );
}

/**
 * 404 — nothing on this seat answers to the requested model.
 *
 * Two causes with one fix each, and the message carries both because the wire
 * cannot tell them apart: a typo in `AI_MODEL`, or a model that a subscription
 * tier change removed from a seat that used to have it.
 */
export function modelNotFoundError(model: string, available: string[]): BridgeError {
  const list =
    available.length > 0
      ? ` This seat currently offers: ${available.join(', ')}.`
      : ' This seat currently offers no models at all — sign in to GitHub Copilot in VS Code.';
  return bridgeError(
    404,
    `No language model on this Copilot seat matches "${model}" (the part of AI_MODEL ` +
      `after "gateway/").${list} GET /v1/models on this bridge lists them, or rerun ` +
      '"Steptix: Use Copilot for AI" to pick one again — a subscription tier change ' +
      'can remove a model that used to be there.',
    'invalid_request_error',
    'model_not_found',
  );
}

/** The host is older than the `vscode.lm` chat API this bridge is built on. */
export function lmUnavailableError(): BridgeError {
  return bridgeError(
    503,
    'This VS Code window has no vscode.lm language-model API, so the Steptix ' +
      'Copilot bridge has nothing to call. It was finalized in VS Code 1.90 — ' +
      'update VS Code, then rerun "Steptix: Use Copilot for AI".',
    'api_error',
    'lm_unavailable',
  );
}

/** The subset of `vscode.LanguageModelError` this module needs, as plain data. */
export interface LmErrorShape {
  code?: string | undefined;
  name?: string | undefined;
  message?: string | undefined;
}

/** Message patterns that mean "the seat is out of allowance", whatever the code. */
const QUOTA_PATTERN =
  /\b(quota|premium request|rate.?limit|too many requests|monthly limit|usage limit|exhaust)/i;

/**
 * Map a `vscode.lm` failure onto an OpenAI-style error the server can surface.
 *
 * PR #110 carries `error.message` into step hovers and panel rows verbatim, so
 * these strings are the whole user-facing explanation — each one names the
 * action that fixes it. The original provider message is appended rather than
 * replaced: the classification here is a guess about a provider we do not
 * control, and swallowing its text would leave nothing to debug when the guess
 * is wrong.
 */
export function mapLmError(err: LmErrorShape, context: { model?: string } = {}): BridgeError {
  const raw = (err.message ?? '').trim();
  const original = raw ? ` Original error: ${raw}` : '';
  const code = err.code ?? err.name ?? '';

  if (code === 'NoPermissions') {
    return bridgeError(
      403,
      'Steptix has no permission to use Copilot language models — consent was ' +
        'never granted in this window, or it was revoked. Run "Steptix: Use ' +
        'Copilot for AI" from the Command Palette to grant it again: that command ' +
        'is the consent moment, because VS Code only raises the dialog for a ' +
        'user-initiated request and this one was triggered by the test runner.' +
        original,
      'permission_error',
      'no_permissions',
    );
  }

  // `Blocked` is what the API documents for "quota limits exceeded"; the
  // message match catches providers that report the same condition as Unknown.
  if (code === 'Blocked' || QUOTA_PATTERN.test(raw)) {
    return bridgeError(
      429,
      'Copilot premium requests are exhausted, so this AI call was refused. The ' +
        'allowance resets monthly. Running a compiled test spends no quota at all — ' +
        'only compiling, repairing and AI-executed steps call a model, and ' +
        'runSettings `ai: "off"` makes a run keyless by policy.' +
        original,
      'insufficient_quota',
      'quota_exhausted',
    );
  }

  if (code === 'NotFound') {
    const named = context.model ? `"${context.model}"` : 'the configured model';
    return bridgeError(
      404,
      `Copilot no longer offers ${named} — a subscription tier change can remove a ` +
        'model. Rerun "Steptix: Use Copilot for AI" and pick a model again; GET ' +
        '/v1/models on this bridge lists what the seat offers now.' +
        original,
      'invalid_request_error',
      'model_not_found',
    );
  }

  return bridgeError(
    502,
    `The Copilot language model failed this request.${original || ' No message was reported.'}`,
    'api_error',
    'lm_error',
  );
}

/**
 * 400 — the model refused a request that carried an image (§15.2).
 *
 * The text is a contract with the server (§15.4 fails a computer-mode step
 * with it, verbatim, and does not retry), so it carries no provider text; the
 * bridge logs that to its output channel instead.
 */
export function imageInputUnsupportedError(model: string): BridgeError {
  return bridgeError(
    400,
    `${model} does not accept images. Computer mode and ai.sendScreenshots need a ` +
      'model that does — pick another Copilot model.',
    'invalid_request_error',
    'image_input_unsupported',
  );
}

export interface CompletionFailureContext {
  /** As requested — the part of AI_MODEL after `gateway/`. */
  model: string;
  /** Image parts the failed request carried to the model. */
  imagesForwarded: number;
  /** The model's advertised image support; `null` when the host does not say. */
  imageInput: boolean | null;
  /** The client hung up or the run was stopped before the model answered. */
  cancelled: boolean;
}

/** vscode's `CancellationError` is named `Canceled`; an AbortSignal's is `AbortError`. */
function isCancellation(err: LmErrorShape): boolean {
  const tag = err.code ?? err.name ?? '';
  return tag === 'Canceled' || tag === 'AbortError' || tag === 'CancellationError';
}

/**
 * Map a failed `sendRequest` — thrown, or from the response stream — for the
 * completions endpoint.
 *
 * The rule for a request that carried images: it becomes
 * {@link imageInputUnsupportedError} only when the failure is one
 * {@link mapLmError} could NOT classify (its 502 `lm_error` bucket), the
 * request was not cancelled, and the model does not advertise image support
 * (`imageInput` is `false` or unknown). Everything classified keeps its
 * mapping whether or not images were present — consent (403), quota (429,
 * by code or by message) and a vanished model (404) each name a cause that is
 * not the image and a fix that is not "pick another model", and relabelling
 * them would send the user to the wrong fix. A cancellation is nobody's
 * answer. And a model that says it takes images and then fails for some
 * unclassified reason has failed for that reason, so it keeps `lm_error` with
 * the provider's own words rather than a claim its capabilities contradict.
 *
 * The provider's text for an image refusal is not documented anywhere this
 * bridge could match on, which is why the rule is "unclassified", not a
 * message pattern: a pattern that missed Copilot's wording would turn the one
 * error this exists for back into a generic 502.
 */
export function mapCompletionError(
  err: LmErrorShape,
  context: CompletionFailureContext,
): BridgeError {
  const mapped = mapLmError(err, { model: context.model });
  if (
    context.imagesForwarded > 0 &&
    mapped.body.error.code === 'lm_error' &&
    !context.cancelled &&
    !isCancellation(err) &&
    context.imageInput !== true
  ) {
    return imageInputUnsupportedError(context.model);
  }
  return mapped;
}
