/**
 * The Copilot bridge's translation layer — OpenAI chat-completions wire in,
 * `vscode.lm` shapes out (stories/copilot-lm-bridge.md §Part A).
 *
 * Deliberately free of `vscode`, `node:http` and every other import: message
 * folding, the fence strip, SSE framing, error mapping and model-id resolution
 * are all text in / text out, so the whole translation table is covered by
 * `node --test` with no extension host. lm-bridge.ts owns the socket, the
 * secret and the `vscode.lm` calls, and holds no rules of its own.
 *
 * The one shape assumption worth stating: the caller on the other end is
 * always this framework's `AiClient` via `@pkent/aigateway`, which is the
 * OpenAI SDK. So the request is OpenAI-canonical, and the response has to
 * satisfy that SDK's parser — not a hand-rolled reader that would forgive a
 * missing `finish_reason` or a bare `[DONE]`.
 */

/** vscode.lm has two roles and no system role; see {@link translateRequest}. */
export type BridgeRole = 'user' | 'assistant';

export interface BridgeMessage {
  role: BridgeRole;
  text: string;
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
  /** Image blocks dropped from this request; drives the once-per-session warning. */
  imagesStripped: number;
}

export type TranslateResult =
  | { ok: true; value: TranslatedRequest }
  | { ok: false; error: BridgeError };

/**
 * Substituted inline wherever an image block was dropped, so the model is told
 * something was removed rather than silently answering about a screenshot it
 * never saw. `LanguageModelDataPart` postdates the ^1.90 floor this story sets,
 * and the diagnosis pass attaches a screenshot regardless of
 * `ai.sendScreenshots`, so refusing the request instead would break diagnosis
 * on every failed keyed run.
 */
export const IMAGE_OMITTED_NOTE = '[screenshot omitted — images unsupported over the bridge]';

/**
 * Shown once per window the first time an image is dropped.
 *
 * It names BOTH senders because the wire cannot tell them apart: an
 * `image_url` block from `ai.sendScreenshots` and one the diagnosis pass
 * captured on its own look identical here. Naming only the setting would send
 * someone to turn off a setting that is already off.
 */
export const IMAGE_STRIP_WARNING =
  'TestBench Copilot bridge: an image was dropped from an AI request — the ' +
  'vscode.lm API this bridge speaks carries text only, so the request went ' +
  "through text-only. Two things attach images: `ai.sendScreenshots` in the " +
  "project's aiui.config.json (off by default), and the failure-diagnosis pass, " +
  'which captures its own screenshot regardless of that setting.';

/** `vscode.lm` reports no token usage, so this is what goes on the wire. */
export const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } as const;

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
 * Text of one message's `content`, with image blocks replaced by the note.
 *
 * Unknown block types are dropped without a word: the same rule the whole
 * translation table applies to unknown request fields, and for the same
 * reason — this bridge sits under a client that is free to add fields, and an
 * error there would break a compile over something cosmetic.
 */
function extractContent(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const type = block['type'];
    if (type === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    } else if (type === 'image_url' || type === 'image' || type === 'input_image') {
      images++;
      parts.push(IMAGE_OMITTED_NOTE);
    }
  }
  return { text: parts.join('\n'), images };
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
 * - **Images strip.** See {@link IMAGE_OMITTED_NOTE}.
 *
 * Everything the table marks "drop silently" — `reasoning_effort`,
 * `stream_options`, `temperature`, unknown keys — is simply never read: the
 * `retry`/`authoring` profiles send effort and every stream carries
 * `stream_options`, so erroring on them would break the paths this bridge
 * exists to serve.
 */
export function translateRequest(raw: unknown): TranslateResult {
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

  for (const entry of rawMessages) {
    if (!isRecord(entry)) continue;
    const role = typeof entry['role'] === 'string' ? entry['role'] : 'user';
    const { text, images } = extractContent(entry['content']);
    imagesStripped += images;
    if (!text) continue;
    if (role === 'system' || role === 'developer') {
      systemParts.push(text);
      continue;
    }
    // `tool` / `function` / anything unrecognised lands as User: vscode.lm has
    // no third role, and losing the turn entirely is worse than mislabelling it.
    messages.push({ role: role === 'assistant' ? 'assistant' : 'user', text });
  }

  if (systemParts.length > 0) {
    const folded = systemParts.join('\n\n');
    const firstUser = messages.findIndex((m) => m.role === 'user');
    if (firstUser === -1) {
      // A system-only request (or system + assistant) still has to arrive as
      // something vscode.lm will answer, and only a User message qualifies.
      messages.unshift({ role: 'user', text: folded });
    } else {
      messages[firstUser] = { role: 'user', text: `${folded}\n\n${messages[firstUser]!.text}` };
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
    },
  };
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
    usage: { ...ZERO_USAGE },
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
 * The zero usage rides on the finish chunk because `stream_options:
 * {include_usage: true}` is on every streamed request; `completeStream` treats
 * absent-or-zero usage as missing and estimates output tokens at `len/4`, so
 * streamed bridge calls report an estimate either way.
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
      usage: { ...ZERO_USAGE },
    }),
    'data: [DONE]\n\n',
  ];
}

/** `GET /v1/models` — what the seat offers, in OpenAI's list shape. */
export function modelsListBody(
  models: Array<{ id: string; vendor: string; family?: string }>,
  created: number,
): Record<string, unknown> {
  return {
    object: 'list',
    data: models.map((m) => ({
      // The vendor-qualified form, because that is what goes in `.env` after
      // `gateway/` — a list whose ids had to be edited before use would not
      // meet the "see valid ids without guessing" this endpoint exists for.
      id: qualifiedModelId(m),
      object: 'model',
      created,
      owned_by: m.vendor,
      ...(m.family !== undefined && { family: m.family }),
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
 * Settings Sync replicates `lmBridge.enabled`/`.port` but not SecretStorage,
 * so a `.env` copied to a second machine authenticates against a token that
 * was never minted there. That is the single likeliest cause, so it is the one
 * the message names.
 */
export function unauthorizedError(): BridgeError {
  return bridgeError(
    401,
    'The TestBench Copilot bridge needs "Authorization: Bearer <token>" with the ' +
      'token from AI_API_KEY, written by "TestBench: Use Copilot for AI". If that ' +
      'line came from another machine it will not work here — the token lives in ' +
      "this machine's VS Code SecretStorage, which Settings Sync does not " +
      'replicate. Rerun the setup command in this window.',
    'invalid_request_error',
    'invalid_api_key',
  );
}

/** 404 on any path other than the two this bridge serves. */
export function unknownRouteError(method: string | undefined, url: string | undefined): BridgeError {
  return bridgeError(
    404,
    `The TestBench Copilot bridge serves GET /v1/models and POST /v1/chat/completions; ` +
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
      '"TestBench: Use Copilot for AI" to pick one again — a subscription tier change ' +
      'can remove a model that used to be there.',
    'invalid_request_error',
    'model_not_found',
  );
}

/** The host is older than the `vscode.lm` chat API this bridge is built on. */
export function lmUnavailableError(): BridgeError {
  return bridgeError(
    503,
    'This VS Code window has no vscode.lm language-model API, so the TestBench ' +
      'Copilot bridge has nothing to call. It was finalized in VS Code 1.90 — ' +
      'update VS Code, then rerun "TestBench: Use Copilot for AI".',
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
      'TestBench has no permission to use Copilot language models — consent was ' +
        'never granted in this window, or it was revoked. Run "TestBench: Use ' +
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
        'model. Rerun "TestBench: Use Copilot for AI" and pick a model again; GET ' +
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
