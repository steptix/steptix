/**
 * §15.4's decision table — SPEC-use-computer.md "Computer mode refuses a blind
 * route" — and the backstop that recognises the bridge's 400.
 *
 * Every case runs the real `checkVisionRoute` against a fake `fetch`, so the
 * thing under test is the decision and the request it makes, not the network.
 * The bodies are the CONTRACT §15.3 gives the bridge (`steptix_bridge.images`,
 * per-model `image_input`), spelled out here rather than imported from the
 * bridge, which is another package built by another hand.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BRIDGE_STRIPS_IMAGES_MESSAGE,
  IMAGE_INPUT_UNSUPPORTED,
  checkVisionRoute,
  imageInputUnsupportedMessage,
  isImageInputUnsupported,
  type VisionRouteAi,
} from '../src/desktop/vision-route.js';
import { isCustomGatewayUrl } from '../src/ai/client.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const BRIDGE_URL = 'http://127.0.0.1:4891';

const BRIDGE_AI: VisionRouteAi = {
  model: 'gateway/copilot/gpt-5.6-luna',
  gatewayUrl: BRIDGE_URL,
  apiKey: 'bridge-key',
};

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that answers every request with `status` and `body`, and records
 *  what it was asked. */
function fakeFetch(status: number, body: unknown): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A `/v1/models` body in §15.3's shape. */
function bridgeBody(
  images: 'forward' | 'strip',
  models: Array<{ id: string; image_input: boolean | null }>,
): unknown {
  return {
    object: 'list',
    steptix_bridge: { name: 'steptix-copilot-bridge', images },
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      owned_by: 'copilot',
      family: m.id.split('/')[1],
      image_input: m.image_input,
    })),
  };
}

describe('checkVisionRoute — which routes are asked', () => {
  it('a direct (non-gateway) model is not checked: no fetch', async () => {
    const { fetch, calls } = fakeFetch(200, bridgeBody('strip', []));
    const result = await checkVisionRoute(
      { model: 'openai/gpt-5.6-luna', gatewayUrl: BRIDGE_URL, apiKey: 'k' },
      { fetch },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('a gateway model on the built-in default URL is not checked: no fetch', async () => {
    const { fetch, calls } = fakeFetch(200, bridgeBody('strip', []));
    const result = await checkVisionRoute(
      { model: 'aibroker/openai/gpt-5.6-luna', gatewayUrl: DEFAULT_CONFIG.ai.gatewayUrl, apiKey: 'k' },
      { fetch },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('uses the AI client\'s own notion of a custom gateway URL by default', async () => {
    // A trailing slash is not a choice — the client says so, and so must this.
    expect(isCustomGatewayUrl(`${DEFAULT_CONFIG.ai.gatewayUrl}/`)).toBe(false);
    const { fetch, calls } = fakeFetch(200, bridgeBody('strip', []));
    await checkVisionRoute(
      { model: 'gateway/copilot/x', gatewayUrl: `${DEFAULT_CONFIG.ai.gatewayUrl}/`, apiKey: 'k' },
      { fetch },
    );
    expect(calls).toHaveLength(0);
  });

  it('the injected custom-URL predicate is the one consulted', async () => {
    const isCustom = vi.fn(() => false);
    const { fetch, calls } = fakeFetch(200, bridgeBody('strip', []));
    const result = await checkVisionRoute(BRIDGE_AI, { fetch, isCustomGatewayUrl: isCustom });
    expect(isCustom).toHaveBeenCalledWith(BRIDGE_URL);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('checkVisionRoute — the request', () => {
  it('GETs {gatewayUrl}/v1/models with the configured key as a Bearer token', async () => {
    const { fetch, calls } = fakeFetch(200, bridgeBody('forward', []));
    await checkVisionRoute({ ...BRIDGE_AI, gatewayUrl: `${BRIDGE_URL}/` }, { fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BRIDGE_URL}/v1/models`);
    expect(calls[0]!.init?.method).toBe('GET');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer bridge-key');
  });

  it('sends no Authorization header when there is no key', async () => {
    const { fetch, calls } = fakeFetch(200, bridgeBody('forward', []));
    await checkVisionRoute({ model: BRIDGE_AI.model, gatewayUrl: BRIDGE_URL }, { fetch });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('checkVisionRoute — the bridge refuses', () => {
  it('images: "strip" refuses with §15.4\'s message, exactly', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('strip', [{ id: 'copilot/gpt-5.6-luna', image_input: null }]),
    );
    const result = await checkVisionRoute(BRIDGE_AI, { fetch });
    expect(result).toEqual({ ok: false, error: BRIDGE_STRIPS_IMAGES_MESSAGE });
    expect(BRIDGE_STRIPS_IMAGES_MESSAGE).toBe(
      'Computer mode needs the model to see the screen, but the Steptix Copilot bridge drops ' +
        'images on this VS Code (it has no image support for language models). Update VS Code, ' +
        'or run computer-mode steps with a model that is not routed through the bridge.',
    );
  });

  it('forward + image_input: false refuses, naming the model and suggesting others', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [
        { id: 'copilot/o3-mini', image_input: false },
        { id: 'copilot/gpt-5.6-luna', image_input: false },
        { id: 'copilot/claude-sonnet-5', image_input: true },
        { id: 'copilot/gpt-4.1', image_input: null },
        { id: 'copilot/text-only-2', image_input: false },
      ]),
    );
    const result = await checkVisionRoute(BRIDGE_AI, { fetch });
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('gateway/copilot/gpt-5.6-luna does not accept images');
    // Suggestions: every entry that is not `false`, spelled as AI_MODEL takes them.
    expect(error).toContain('gateway/copilot/claude-sonnet-5');
    expect(error).toContain('gateway/copilot/gpt-4.1');
    expect(error).not.toContain('o3-mini');
    expect(error).not.toContain('text-only-2');
  });

  it('suggests at most five models', async () => {
    const models = [
      { id: 'copilot/blind', image_input: false },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `copilot/seeing-${i}`, image_input: null })),
    ];
    const { fetch } = fakeFetch(200, bridgeBody('forward', models));
    const result = await checkVisionRoute({ ...BRIDGE_AI, model: 'gateway/copilot/blind' }, { fetch });
    const error = (result as { error: string }).error;
    expect(error.match(/gateway\/copilot\/seeing-\d/g)).toHaveLength(5);
  });

  it('says so when the bridge lists nothing else that sees', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [{ id: 'copilot/gpt-5.6-luna', image_input: false }]),
    );
    const result = await checkVisionRoute(BRIDGE_AI, { fetch });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('lists no other model that accepts images');
  });

  it('matches the model id case-insensitively when there is no exact match', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [{ id: 'copilot/GPT-5.6-Luna', image_input: false }]),
    );
    const result = await checkVisionRoute(BRIDGE_AI, { fetch });
    expect(result.ok).toBe(false);
  });

  it('prefers the exact match over a case-insensitive one', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [
        { id: 'copilot/GPT-5.6-LUNA', image_input: false },
        { id: 'copilot/gpt-5.6-luna', image_input: null },
      ]),
    );
    const result = await checkVisionRoute(BRIDGE_AI, { fetch });
    expect(result.ok).toBe(true);
  });

  it('handles the aibroker/ prefix the same way', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [
        { id: 'copilot/o3-mini', image_input: false },
        { id: 'copilot/gpt-4.1', image_input: true },
      ]),
    );
    const result = await checkVisionRoute(
      { model: 'aibroker/copilot/o3-mini', gatewayUrl: BRIDGE_URL, apiKey: 'k' },
      { fetch },
    );
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('aibroker/copilot/o3-mini does not accept images');
    expect(error).toContain('aibroker/copilot/gpt-4.1');
  });
});

describe('checkVisionRoute — everything else proceeds', () => {
  it('forward + image_input: null proceeds (the normal answer: the model decides)', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [{ id: 'copilot/gpt-5.6-luna', image_input: null }]),
    );
    expect((await checkVisionRoute(BRIDGE_AI, { fetch })).ok).toBe(true);
  });

  it('forward + image_input: true proceeds', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [{ id: 'copilot/gpt-5.6-luna', image_input: true }]),
    );
    expect((await checkVisionRoute(BRIDGE_AI, { fetch })).ok).toBe(true);
  });

  it('forward + the model missing from the list proceeds', async () => {
    const { fetch } = fakeFetch(
      200,
      bridgeBody('forward', [{ id: 'copilot/something-else', image_input: false }]),
    );
    expect((await checkVisionRoute(BRIDGE_AI, { fetch })).ok).toBe(true);
  });

  it('an endpoint with no steptix_bridge field is not the bridge: proceeds', async () => {
    const { fetch } = fakeFetch(200, {
      object: 'list',
      data: [{ id: 'copilot/gpt-5.6-luna', object: 'model', image_input: false }],
    });
    expect((await checkVisionRoute(BRIDGE_AI, { fetch })).ok).toBe(true);
  });

  it.each([401, 404, 500])('a %i proceeds', async (status) => {
    const { fetch } = fakeFetch(status, bridgeBody('strip', []));
    const result = await checkVisionRoute(BRIDGE_AI, { fetch });
    expect(result.ok).toBe(true);
  });

  it('a body that is not JSON proceeds', async () => {
    const { fetch } = fakeFetch(200, '<html>not json</html>');
    expect((await checkVisionRoute(BRIDGE_AI, { fetch })).ok).toBe(true);
  });

  it('a network error proceeds', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const result = await checkVisionRoute(BRIDGE_AI, { fetch });
    expect(result.ok).toBe(true);
    expect((result as { note?: string }).note).toContain('fetch failed');
  });

  it('a timeout proceeds, and aborts the request', async () => {
    let aborted = false;
    // Never answers on its own; honours the abort the way a real fetch does.
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof globalThis.fetch;
    const started = Date.now();
    const result = await checkVisionRoute(BRIDGE_AI, { fetch, timeoutMs: 30 });
    expect(result.ok).toBe(true);
    expect((result as { note?: string }).note).toContain('timed out');
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a timeout proceeds even when the fetch ignores its signal', async () => {
    const fetch = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;
    const result = await checkVisionRoute(BRIDGE_AI, { fetch, timeoutMs: 30 });
    expect(result.ok).toBe(true);
  });

  it('defaults to a 3-second timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetch = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;
      let settled = false;
      const pending = checkVisionRoute(BRIDGE_AI, { fetch }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(2_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
      expect((await pending).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The backstop: the bridge's 400 (§15.2)
// ---------------------------------------------------------------------------

/** What the OpenAI SDK throws for the bridge's 400 — the shape
 *  `APIError.generate` builds (node_modules/openai/core/error.mjs): the body's
 *  `error` object on `.error`, its `code` on `.code`, and a message of
 *  `"400 <error.message>"` that does NOT contain the code. */
function openAiBadRequest(message: string): Error {
  const body = { message, type: 'invalid_request_error', code: IMAGE_INPUT_UNSUPPORTED };
  return Object.assign(new Error(`400 ${message}`), {
    name: 'BadRequestError',
    status: 400,
    error: body,
    code: body.code,
    type: body.type,
  });
}

const BRIDGE_400_MESSAGE =
  'copilot/o3-mini does not accept images. Computer mode and ai.sendScreenshots need a ' +
  'model that does — pick another Copilot model.';

describe('imageInputUnsupportedMessage', () => {
  it('recognises the SDK error by its code and returns the bridge\'s own message', () => {
    const err = openAiBadRequest(BRIDGE_400_MESSAGE);
    expect(err.message).not.toContain(IMAGE_INPUT_UNSUPPORTED);
    expect(isImageInputUnsupported(err)).toBe(true);
    expect(imageInputUnsupportedMessage(err)).toBe(BRIDGE_400_MESSAGE);
  });

  it('recognises the code on .error alone', () => {
    const err = Object.assign(new Error(`400 ${BRIDGE_400_MESSAGE}`), {
      error: { message: BRIDGE_400_MESSAGE, code: IMAGE_INPUT_UNSUPPORTED },
    });
    expect(imageInputUnsupportedMessage(err)).toBe(BRIDGE_400_MESSAGE);
  });

  it('recognises a message that carries the raw body, and unwraps it', () => {
    const raw = JSON.stringify({
      error: { message: BRIDGE_400_MESSAGE, type: 'invalid_request_error', code: IMAGE_INPUT_UNSUPPORTED },
    });
    expect(imageInputUnsupportedMessage(new Error(`400 ${raw}`))).toBe(BRIDGE_400_MESSAGE);
  });

  it('recognises it through a cause chain', () => {
    const wrapped = new Error('request failed', { cause: openAiBadRequest(BRIDGE_400_MESSAGE) });
    expect(imageInputUnsupportedMessage(wrapped)).toBe(BRIDGE_400_MESSAGE);
  });

  it('falls back to a message of its own when the error carries only the code', () => {
    const message = imageInputUnsupportedMessage(Object.assign(new Error(''), { code: IMAGE_INPUT_UNSUPPORTED }));
    expect(message).toContain(IMAGE_INPUT_UNSUPPORTED);
    expect(message).toContain('accepts images');
  });

  it('returns null for every other error', () => {
    expect(imageInputUnsupportedMessage(new Error('400 context_length_exceeded'))).toBeNull();
    expect(
      imageInputUnsupportedMessage(Object.assign(new Error('429 slow down'), { status: 429, code: 'rate_limit' })),
    ).toBeNull();
    expect(imageInputUnsupportedMessage(undefined)).toBeNull();
    expect(imageInputUnsupportedMessage('network down')).toBeNull();
  });
});
