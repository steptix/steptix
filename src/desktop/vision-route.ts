/**
 * Can the model on this route SEE the screen?
 * (docs/specs/SPEC-use-computer.md §15.4, §15.2.)
 *
 * Computer mode's whole input is a screenshot, and one route in this repo can
 * drop it without the server finding out: Steptix's Copilot bridge, reached
 * as `AI_MODEL=gateway/copilot/<model>` + `AI_GATEWAY_URL`, strips every image
 * on a VS Code with no image support for language models — AFTER the request
 * has left the server. The model is then asked to click by coordinates on a
 * screen it was never shown. This module is the two halves of the answer:
 *
 *  - {@link checkVisionRoute}, a precondition on `[use computer]` (§5.1 item
 *    1b), which asks the bridge's `GET /v1/models` what it will do with an
 *    image before any mouse moves or any nut.js loads;
 *  - {@link imageInputUnsupportedMessage}, the backstop for a model changed
 *    after that check — the bridge answers a request carrying an image to a
 *    model that rejects images with a 400 `image_input_unsupported`, and the
 *    computer step turns that into an immediate, unretried failure.
 *
 * Only the bridge is asked. A direct provider, or a real gateway, answers an
 * image sent to a text-only model with an error of its own — loud rather than
 * blind — and the `steptix_bridge` field is how the bridge says it is the bridge
 * and not a corporate gateway that happens to share the URL shape.
 */
import { gatewayRoutePrefix, hasGatewayUrl } from '../ai/client.js';

/** The AI settings a request goes out with: the three that decide where it
 *  goes and who it says it is. */
export interface VisionRouteAi {
  model: string;
  gatewayUrl?: string | undefined;
  apiKey?: string | undefined;
}

/** Test seams. Production passes none. */
export interface VisionRouteDeps {
  fetch?: typeof fetch;
  /** Default {@link VISION_ROUTE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * `ok: true` proceeds; `note` says why, for the `[computer]` log line.
 * `ok: false` fails the `[use computer]` step with `error`.
 */
export type VisionRouteResult = { ok: true; note?: string } | { ok: false; error: string };

/** §15.4: "3-second timeout". A bridge that is slow to answer is not refused —
 *  the first real request will say whatever is wrong. */
export const VISION_ROUTE_TIMEOUT_MS = 3_000;

/** §15.4's message for `steptix_bridge.images === "strip"`, verbatim. */
export const BRIDGE_STRIPS_IMAGES_MESSAGE =
  'Computer mode needs the model to see the screen, but the Steptix Copilot bridge drops ' +
  'images on this VS Code (it has no image support for language models). Update VS Code, or ' +
  'run computer-mode steps with a model that is not routed through the bridge.';

/** The most models a refusal suggests. Copilot lists a dozen or more, and the
 *  message is read in a report row. */
const MAX_SUGGESTIONS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * §15.4's decision table. Never throws: every way of not getting an answer is
 * "proceed", because the question is "is this route KNOWN to be blind?", and
 * an unreachable bridge is not known to be anything yet.
 */
export async function checkVisionRoute(
  ai: VisionRouteAi,
  deps: VisionRouteDeps = {},
): Promise<VisionRouteResult> {
  try {
    return await decide(ai, deps);
  } catch (err) {
    // `decide` guards its own I/O; this is for a defect in it, which must not
    // be what stops a `[use computer]` step.
    return { ok: true, note: `vision check skipped: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function decide(ai: VisionRouteAi, deps: VisionRouteDeps): Promise<VisionRouteResult> {
  const prefix = gatewayRoutePrefix(ai.model);
  if (prefix === null) {
    return { ok: true, note: `${ai.model} is not gateway-routed; not checked` };
  }
  // The client refuses this route itself (GatewayUrlRequiredError), so there is
  // nothing to ask and nothing the screenshot could be sent to.
  if (!hasGatewayUrl(ai.gatewayUrl)) {
    return { ok: true, note: 'no gateway URL is set; not checked' };
  }

  const url = `${ai.gatewayUrl.trim().replace(/\/+$/, '')}/v1/models`;
  const answer = await getModels(url, ai.apiKey, deps);
  if (answer.kind !== 'body') {
    return {
      ok: true,
      note:
        answer.kind === 'status'
          ? `GET ${url} answered ${answer.status}; not checked`
          : `no answer from GET ${url} (${answer.reason}); not checked`,
    };
  }

  const body = answer.body;
  if (!isRecord(body) || !isRecord(body.steptix_bridge)) {
    return { ok: true, note: `${url} is not the Steptix Copilot bridge; not checked` };
  }
  if (body.steptix_bridge.images === 'strip') {
    return { ok: false, error: BRIDGE_STRIPS_IMAGES_MESSAGE };
  }

  const models = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  const upstreamId = ai.model.slice(prefix.length);
  const lower = upstreamId.toLowerCase();
  const entry =
    models.find((m) => m.id === upstreamId) ??
    models.find((m) => typeof m.id === 'string' && m.id.toLowerCase() === lower);
  if (!entry) {
    return { ok: true, note: `the bridge does not list ${upstreamId}; the first request will say` };
  }
  if (entry.image_input === false) {
    return { ok: false, error: textOnlyModelMessage(ai.model, prefix, entry.id, models) };
  }
  return {
    ok: true,
    note: `the bridge forwards images; ${String(entry.id)} image_input: ${JSON.stringify(entry.image_input ?? null)}`,
  };
}

type ModelsAnswer =
  | { kind: 'body'; body: unknown }
  | { kind: 'status'; status: number }
  | { kind: 'none'; reason: string };

/**
 * `GET {gatewayUrl}/v1/models`, bounded by the timeout however the fetch
 * behaves: the abort covers a fetch that honours its signal, and the race
 * covers one that does not — including the body read, which is where a
 * server that sends headers and then stalls would otherwise hang the step.
 */
async function getModels(
  url: string,
  apiKey: string | undefined,
  deps: VisionRouteDeps,
): Promise<ModelsAnswer> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? VISION_ROUTE_TIMEOUT_MS;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey !== undefined && apiKey.trim() !== '') headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ModelsAnswer>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'none', reason: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });
  const request = (async (): Promise<ModelsAnswer> => {
    const res = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    if (res.status !== 200) return { kind: 'status', status: res.status };
    return { kind: 'body', body: await res.json() };
  })().catch(
    (err: unknown): ModelsAnswer => ({
      kind: 'none',
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
  try {
    return await Promise.race([request, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** §15.4: "the step fails naming the model and suggesting one whose entry is
 *  not `false`". Suggestions are spelled the way `AI_MODEL` takes them. */
function textOnlyModelMessage(
  model: string,
  prefix: string,
  selectedId: unknown,
  models: Array<Record<string, unknown>>,
): string {
  const suggestions: string[] = [];
  for (const m of models) {
    if (typeof m.id !== 'string' || m.id === selectedId || m.image_input === false) continue;
    const spelled = `${prefix}${m.id}`;
    if (!suggestions.includes(spelled)) suggestions.push(spelled);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  const head =
    `Computer mode needs the model to see the screen, but the Steptix Copilot bridge ` +
    `reports that ${model} does not accept images.`;
  return suggestions.length > 0
    ? `${head} Models on the same bridge not marked text-only: ${suggestions.join(', ')}. ` +
        "Set one as AI_MODEL (or as the run settings' model), or run computer-mode steps " +
        'with a model that is not routed through the bridge.'
    : `${head} The bridge lists no other model that accepts images; run computer-mode steps ` +
        'with a model that is not routed through the bridge.';
}

// ---------------------------------------------------------------------------
// The backstop: a request the bridge refused (§15.2, §15.4)
// ---------------------------------------------------------------------------

/** The bridge's error code for a model that rejected an image (§15.2). */
export const IMAGE_INPUT_UNSUPPORTED = 'image_input_unsupported';

/**
 * Did this AI request fail because the model rejects images?
 *
 * The error reaches the runner as the OpenAI SDK's `BadRequestError` —
 * `@pkent/aigateway` passes provider errors through unwrapped — whose `message`
 * is `"400 <the bridge's message>"` and does NOT contain the code: the code is
 * on `.code` and on `.error.code` (the body's `error` object). So all three are
 * read, plus a `cause` chain, plus the message as a last resort for a layer
 * that stringified the body instead.
 */
export function isImageInputUnsupported(err: unknown, depth = 0): boolean {
  if (depth > 4 || err === null || err === undefined) return false;
  if (typeof err === 'string') return err.includes(IMAGE_INPUT_UNSUPPORTED);
  if (typeof err !== 'object') return false;
  const rec = err as Record<string, unknown>;
  if (rec.code === IMAGE_INPUT_UNSUPPORTED) return true;
  if (isRecord(rec.error)) {
    if (rec.error.code === IMAGE_INPUT_UNSUPPORTED) return true;
    if (isRecord(rec.error.error) && rec.error.error.code === IMAGE_INPUT_UNSUPPORTED) return true;
  }
  if (typeof rec.message === 'string' && rec.message.includes(IMAGE_INPUT_UNSUPPORTED)) return true;
  return isImageInputUnsupported(rec.cause, depth + 1);
}

/**
 * The bridge's own message for an `image_input_unsupported` error, or `null`
 * for any other error. The bridge's words are the ones worth showing — they
 * name the model and say what computer mode needs — so the SDK's `400 ` status
 * prefix is dropped and a JSON body left in a message is unwrapped.
 */
export function imageInputUnsupportedMessage(err: unknown): string | null {
  if (!isImageInputUnsupported(err)) return null;
  return bridgeMessageOf(err, 0) ?? FALLBACK_MESSAGE;
}

const FALLBACK_MESSAGE =
  `The model rejected the screenshot (${IMAGE_INPUT_UNSUPPORTED}): computer mode needs a ` +
  'model that accepts images.';

function bridgeMessageOf(err: unknown, depth: number): string | null {
  if (depth > 4 || err === null || err === undefined) return null;
  if (typeof err === 'string') return fromMessageText(err);
  if (typeof err !== 'object') return null;
  const rec = err as Record<string, unknown>;
  if (isRecord(rec.error)) {
    const inner = rec.error;
    if (typeof inner.message === 'string' && inner.message.trim() !== '') return inner.message.trim();
    if (isRecord(inner.error) && typeof inner.error.message === 'string' && inner.error.message.trim() !== '') {
      return inner.error.message.trim();
    }
  }
  if (isImageInputUnsupported(rec.cause)) {
    const fromCause = bridgeMessageOf(rec.cause, depth + 1);
    if (fromCause !== null) return fromCause;
  }
  return typeof rec.message === 'string' ? fromMessageText(rec.message) : null;
}

/** `400 {"error":{"message":"…"}}` → `…`; `400 …` → `…`. */
function fromMessageText(message: string): string | null {
  const text = message.replace(/^\s*\d{3}\s+/, '').trim();
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const parsed: unknown = JSON.parse(text.slice(brace));
      if (isRecord(parsed)) {
        const error = isRecord(parsed.error) ? parsed.error : parsed;
        if (typeof error.message === 'string' && error.message.trim() !== '') return error.message.trim();
      }
    } catch {
      // Not JSON after all — the text itself is the message.
    }
  }
  if (text === '' || text === IMAGE_INPUT_UNSUPPORTED) return null;
  return text;
}
