/**
 * W1 + W2 of stories/run-settings.md — the per-session override channel and
 * `GET /config`.
 *
 * Every assertion here is on **what reaches the executor**, not on what was
 * stored. That is deliberate: `runSettings` could be merged onto the session
 * perfectly and still never be applied, because the executor call sites are
 * handed a whole `Config` object and used to be handed the server's startup one
 * unconditionally. Asserting on the stored slice would pass with the feature
 * doing nothing.
 *
 * The two cases that fail silently in production and nowhere else — retention
 * across a settings-free second request, and cross-session isolation — are the
 * reason this file exists at all.
 *
 * Driven over real HTTP through the real app, because the route's request
 * builder is an explicit allow-list: widening `StepRequest` alone compiles
 * cleanly and drops the field at runtime.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — mirrors api-server.test.ts so no real browser or AI is involved
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => null),
};

const mockPageTracker = { getActive: vi.fn(() => mockPage as any) };

const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: mockPageTracker,
};

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    getActive: ReturnType<typeof vi.fn>;
    closeAll: ReturnType<typeof vi.fn>;
    hasActive: ReturnType<typeof vi.fn>;
    ensureLaunched: ReturnType<typeof vi.fn>;
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.closeAll = vi.fn(async () => {});
      this.hasActive = vi.fn(() => true);
      this.ensureLaunched = vi.fn(async () => initialSession);
    }
    /**
     * Lazy twin of the real static (SPEC-use-computer.md §4.6). Modelled, not
     * stubbed: nothing launches until ensureLaunched(), and it launches at
     * most once — so these suites exercise the same launch-at-first-step rule
     * the session manager now follows instead of hiding it behind a mock that
     * always has a browser.
     */
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker(undefined as any);
      let launched: any;
      tracker.hasActive = vi.fn(() => launched !== undefined);
      tracker.getActive = vi.fn(() => {
        if (!launched) throw new Error('no browser has been launched in this session');
        return launched;
      });
      tracker.ensureLaunched = vi.fn(async () => {
        if (!launched) launched = await launch();
        return launched;
      });
      return tracker;
    }
  }
  return {
    launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
    PageTracker: vi.fn(),
    // The 'no browser yet' sentinel (SPEC-use-computer.md §4.6). A mock of
    // this module must export it: api-server and session-manager both do
    // `instanceof` against it, and `instanceof undefined` throws.
    NoBrowserLaunchedError: class NoBrowserLaunchedError extends Error {
      constructor(message = 'no browser has been launched in this session') {
        super(message);
        this.name = 'NoBrowserLaunchedError';
      }
    },
    NO_BROWSER_LAUNCHED_MESSAGE: 'no browser has been launched in this session',
    BrowserTracker,
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
  };
});

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (): Promise<StepResult> => ({
    index: 1,
    instruction: 'mock step',
    status: 'passed',
    turns: [],
    durationMs: 10,
    retried: false,
    aiExplanation: 'ok',
  })),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

/** Shape of the AI config as this file cares about it — the three values a
 *  client's `.env` can move (stories/keyless-replay-and-gateway-env.md). */
type MockAiConfig = { model: string; apiKey?: string | undefined; gatewayUrl: string };

/** Every `syncAuth` the server made, across every session, in order. This is
 *  the only place the model actually takes effect — the executor is handed a
 *  config but the AI call goes through the client — so a model test that did
 *  not look here would be testing the wrong thing. */
const syncAuthCalls: { model: string; apiKey: string | undefined; gatewayUrl: string | undefined }[] = [];

/** The config each AiClient was CONSTRUCTED with, in order. `syncAuth` alone
 *  cannot tell the whole gateway story: a brand-new session's client is built
 *  from `applyEnvToAiConfig` directly, so this is where a dropped env override
 *  would show up on the very first batch. */
const aiClientConfigs: MockAiConfig[] = [];

/**
 * Every `setAiPolicy` the server made, in order — the client-side half of the
 * AI switch (stories/run-settings.md §9).
 *
 * Recorded because `opts.keyless` cannot stand for it: that flag never reaches
 * `executeBranchedStep`, so the veil on the client is the only thing covering a
 * branched AI step, and an assertion on the executor alone would pass with it
 * missing.
 */
const aiPolicyCalls: boolean[] = [];

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    /** Retained and MUTATED by `syncAuth`, exactly as the real client does.
     *  That one detail is not cosmetic: the real client writes the new model
     *  into the config object it was handed, so a mock that merely recorded the
     *  call could not catch the aliasing bug where that object is the SERVER's
     *  own `config.ai`. */
    config: MockAiConfig;
    constructor(config: MockAiConfig) {
      this.config = config;
      aiClientConfigs.push({ ...config });
    }
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn((allowed: boolean) => {
      aiPolicyCalls.push(allowed);
    });
    syncAuth = vi.fn((model: string, apiKey: string | undefined, gatewayUrl?: string) => {
      syncAuthCalls.push({ model, apiKey, gatewayUrl });
      const changed = model !== this.config.model;
      this.config.model = model;
      if (apiKey === undefined) delete this.config.apiKey;
      else this.config.apiKey = apiKey;
      if (gatewayUrl !== undefined) this.config.gatewayUrl = gatewayUrl;
      return changed ? `AI model → ${model}` : null;
    });
  },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    resetStep = vi.fn();
    markRunStart = vi.fn();
    get total() { return 0; }
    get inputTotal() { return 0; }
    get outputTotal() { return 0; }
    get runTotal() { return 0; }
    get runInputTotal() { return 0; }
    get runOutputTotal() { return 0; }
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class {
    store = vi.fn();
    getHistory = vi.fn(() => []);
  },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((r: { testName: string }) => r.testName),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fakeBase64' })),
}));

/**
 * The provider registry `aiConfigured` asks whether a model needs a key
 * (stories/bedrock-provider.md §Part B). Stubbed so the suite needs neither a
 * network call nor the optional `@anthropic-ai/bedrock-sdk` peer, which this
 * repo deliberately does not install — the real registry is exercised against
 * the published package by the live probes instead.
 *
 * Safe to mock file-wide: the AI client above is mocked too, so nothing here
 * ever constructs a gateway, and no other model id in this file starts with a
 * self-authenticating prefix.
 */
vi.mock('@pkent/aigateway', () => {
  class FakeAIGateway {
    static providers() {
      return [
        { id: 'anthropic', prefix: 'anthropic/' },
        { id: 'openai', prefix: 'openai/' },
        { id: 'gateway', prefix: 'gateway/' },
        { id: 'bedrock', prefix: 'bedrock/', selfAuthenticating: true },
      ];
    }
  }
  return { AIGateway: FakeAIGateway, default: FakeAIGateway };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(),
    step: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createApiServer } from '../src/server/api-server.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { executeStep } from '../src/runner/step-executor.js';
import { listenFetchable } from './listen-fetchable.cjs';

const stepMock = vi.mocked(executeStep);

const API_KEY = 'run-settings-key';
const SERVER_MODEL = 'server/base-model';
const SERVER_AI_KEY = 'server-ai-key';
/** Deliberately NOT the built-in default: a gateway test against a server
 *  already sitting on the default URL could not tell an applied override from
 *  a dropped one. Same reason capture is off in the config below. */
const SERVER_GATEWAY = 'https://server.gateway.test';

/**
 * The server's own config, chosen so every override is OBSERVABLE.
 *
 * Per-action capture is off and failure capture is on — the live check has the
 * same requirement for the same reason: against a server that already captured
 * every step, `capture: "every-step"` would pass without the feature existing.
 */
const testConfig: Config = {
  ...DEFAULT_CONFIG,
  ai: {
    ...DEFAULT_CONFIG.ai,
    model: SERVER_MODEL,
    apiKey: SERVER_AI_KEY,
    gatewayUrl: SERVER_GATEWAY,
    sendScreenshots: false,
  },
  browser: {
    ...DEFAULT_CONFIG.browser,
    headed: false,
    captureScreenshotsPerAction: false,
    fullPageScreenshots: false,
  },
  execution: { ...DEFAULT_CONFIG.execution, screenshotOnFailure: true },
  server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let tmpRoot: string;

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await listenFetchable(started, '127.0.0.1');
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

/** `base` defaults to the keyed server above; the keyless block below stands up
 *  a second one, because whether a run has AI is a property of the config the
 *  process booted with. */
async function api(
  method: string,
  p: string,
  body?: unknown,
  base: string = baseUrl,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${base}${p}`, opts);
  return { status: res.status, body: await res.json() };
}

/** The whole options object the executor was handed on the Nth (0-based) step
 *  call. Some of what this story ships rides on the options rather than on the
 *  config — `keyless` is deliberately NOT read off `config.ai` at the far end
 *  — so an assertion on {@link configAt} alone cannot see it. */
function optsAt(call: number): Record<string, unknown> {
  const args = stepMock.mock.calls[call];
  expect(args, `no executeStep call #${call}`).toBeDefined();
  return args![3] as unknown as Record<string, unknown>;
}

/** The `config` the executor was handed on the Nth (0-based) step call. */
function configAt(call: number): Config {
  return optsAt(call)['config'] as Config;
}

/** The four values this story owns, as they reached the executor. */
function settingsAt(call: number): {
  model: string;
  perAction: boolean | undefined;
  onFailure: boolean;
  fullPage: boolean;
  sendScreenshots: boolean;
} {
  const config = configAt(call);
  return {
    model: config.ai.model,
    perAction: config.browser.captureScreenshotsPerAction,
    onFailure: config.execution.screenshotOnFailure,
    fullPage: config.browser.fullPageScreenshots,
    sendScreenshots: config.ai.sendScreenshots,
  };
}

async function run(
  sessionId: string,
  body: Record<string, unknown> = {},
  base: string = baseUrl,
): Promise<any> {
  const { status, body: result } = await api(
    'POST',
    `/sessions/${sessionId}/steps`,
    {
      steps: ['do a thing'],
      sourceLines: [1],
      ...body,
    },
    base,
  );
  expect(status, JSON.stringify(result)).toBe(200);
  return result;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'steptix-runsettings-'));
  const { app } = createApiServer(testConfig);
  ({ server, baseUrl } = await listenOnRandomPort(app));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  stepMock.mockClear();
  syncAuthCalls.length = 0;
  aiClientConfigs.length = 0;
  aiPolicyCalls.length = 0;
});

/** Read SSE frames into {event, data} pairs. */
async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: { event: string; data: any }[] = [];
  let currentEvent = 'message';
  let currentData: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (currentData.length > 0) {
          try {
            events.push({ event: currentEvent, data: JSON.parse(currentData.join('\n')) });
          } catch {
            events.push({ event: currentEvent, data: currentData.join('\n') });
          }
        }
        currentEvent = 'message';
        currentData = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = (colon < 0 ? '' : line.slice(colon + 1)).replace(/^ /, '');
      if (field === 'event') currentEvent = value;
      else if (field === 'data') currentData.push(value);
    }
  }
  return events;
}

/** Run a batch over the streaming route and return its `done` frame — the only
 *  channel the echo travels on. */
async function doneFrameOf(
  sessionId: string,
  body: Record<string, unknown> = {},
  base: string = baseUrl,
): Promise<any> {
  const res = await fetch(`${base}/sessions/${sessionId}/steps?stream=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ steps: ['do a thing'], sourceLines: [1], ...body }),
  });
  expect(res.status).toBe(200);
  return (await readSse(res)).find((e) => e.event === 'done')?.data;
}

describe('runSettings reaching the executor', () => {
  it('applies capture, fullPage and sendScreenshots to the config the executor gets', async () => {
    // executeStep's signature is (line, total, instruction, opts) — the whole
    // Config rides on `opts.config`, which is why the resolved object has to be
    // complete rather than partial.
    await run('rs-apply', {
      runSettings: { capture: 'every-step', fullPage: true, sendScreenshots: true },
    });

    expect(settingsAt(0)).toEqual({
      model: SERVER_MODEL,
      perAction: true,
      onFailure: true,
      fullPage: true,
      sendScreenshots: true,
    });
    // And the server's own config is untouched — this is a per-session override,
    // not a process-wide one.
    expect(testConfig.browser.captureScreenshotsPerAction).toBe(false);
  });

  it('leaves every other config value exactly as the server has it', async () => {
    // The risk the story names explicitly: the merge must be complete, or a
    // setting nobody asked to change gets blanked out.
    await run('rs-complete', { runSettings: { capture: 'none' } });

    const config = configAt(0);
    expect(config.execution.timeout).toBe(testConfig.execution.timeout);
    expect(config.execution.maxTurns).toBe(testConfig.execution.maxTurns);
    expect(config.browser.viewport).toEqual(testConfig.browser.viewport);
    expect(config.tests.dir).toBe(testConfig.tests.dir);
    expect(config.ai.maxInputTokens).toBe(testConfig.ai.maxInputTokens);
    expect(config.logging).toEqual(testConfig.logging);
  });

  it('maps each capture value onto the two booleans', async () => {
    await run('rs-map-a', { runSettings: { capture: 'every-step' } });
    expect(settingsAt(0).perAction).toBe(true);
    expect(settingsAt(0).onFailure).toBe(true);

    await run('rs-map-b', { runSettings: { capture: 'on-failure' } });
    expect(settingsAt(1).perAction).toBe(false);
    expect(settingsAt(1).onFailure).toBe(true);

    await run('rs-map-c', { runSettings: { capture: 'none' } });
    expect(settingsAt(2).perAction).toBe(false);
    expect(settingsAt(2).onFailure).toBe(false);
  });

  it('changes only the keys it names', async () => {
    await run('rs-partial', { runSettings: { capture: 'every-step' } });
    // `fullPage` and `sendScreenshots` were not sent, so they keep the server's.
    expect(settingsAt(0).fullPage).toBe(false);
    expect(settingsAt(0).sendScreenshots).toBe(false);
  });
});

describe('retention', () => {
  it('a second request with no runSettings still runs with the first one\'s values', async () => {
    // THE test. Retention is what makes a forgotten re-send benign instead of a
    // silent revert to the server default — and a revert is invisible until
    // someone wants a screenshot and there isn't one.
    await run('rs-retain', { runSettings: { capture: 'every-step', fullPage: true } });
    await run('rs-retain');

    expect(settingsAt(1).perAction).toBe(true);
    expect(settingsAt(1).onFailure).toBe(true);
    expect(settingsAt(1).fullPage).toBe(true);
  });

  it('merges per key across requests rather than replacing the slice', async () => {
    await run('rs-merge', { runSettings: { capture: 'every-step' } });
    await run('rs-merge', { runSettings: { sendScreenshots: true } });

    // The second request said nothing about capture, so capture survives.
    expect(settingsAt(1).perAction).toBe(true);
    expect(settingsAt(1).sendScreenshots).toBe(true);
  });

  it('"default" restores the base value rather than the last override', async () => {
    // Without an explicit `default`, going back is inexpressible — the caller
    // would have to already know the server's value to restore it.
    await run('rs-default', { runSettings: { capture: 'every-step' } });
    expect(settingsAt(0).perAction).toBe(true);

    await run('rs-default', { runSettings: { capture: 'default' } });
    expect(settingsAt(1).perAction).toBe(false);
    expect(settingsAt(1).onFailure).toBe(true);

    // And it stays cleared on the next settings-free request, rather than the
    // pre-`default` override coming back.
    await run('rs-default');
    expect(settingsAt(2).perAction).toBe(false);
  });

  it('null clears a boolean override', async () => {
    await run('rs-null', { runSettings: { fullPage: true } });
    expect(settingsAt(0).fullPage).toBe(true);

    await run('rs-null', { runSettings: { fullPage: null } });
    expect(settingsAt(1).fullPage).toBe(false);
  });
});

describe('isolation between sessions', () => {
  it('session A\'s settings do not appear in session B\'s resolved config', async () => {
    // The same server also serves Steptix. A setting that leaked across
    // sessions would let an agent silently change the cost and speed of a run
    // somebody is doing by hand.
    await run('rs-iso-a', { runSettings: { capture: 'every-step', sendScreenshots: true } });
    await run('rs-iso-b');

    expect(settingsAt(0).perAction).toBe(true);
    expect(settingsAt(1).perAction).toBe(false);
    expect(settingsAt(1).sendScreenshots).toBe(false);
  });
});

describe('the model override', () => {
  it('is what syncAuth is called with, and beats AI_MODEL from env', async () => {
    // `request.env` is where a project's `.env` arrives. The override is applied
    // after it and wins — otherwise "use gemini for this one" would lose to
    // whatever the project's .env last said.
    await run('rs-model', {
      env: { AI_MODEL: 'from-dot-env', AI_API_KEY: 'from-dot-env-key' },
      runSettings: { model: 'override/model' },
    });

    expect(syncAuthCalls.at(-1)).toEqual({
      model: 'override/model',
      apiKey: 'from-dot-env-key',
      // No AI_GATEWAY_URL in this request's `.env`, so the server's own.
      gatewayUrl: SERVER_GATEWAY,
    });
    // The key still comes from env — only the model is overridden.
    expect(syncAuthCalls.at(-1)?.apiKey).not.toBe(SERVER_AI_KEY);
  });

  it('is retained, so the next batch runs on it too', async () => {
    await run('rs-model-retain', { runSettings: { model: 'override/model' } });
    await run('rs-model-retain');

    expect(syncAuthCalls.at(-1)?.model).toBe('override/model');
  });

  it('does not leak into the server base, so a later session starts clean', async () => {
    // Caught live, and it was NOT theoretical: `applyEnvToAiConfig` used to
    // return the server's own `config.ai` object by reference when a request
    // carried no `env`, so `new AiClient(...)` held the server's config and
    // `syncAuth` mutated it in place. One session's model override rewrote the
    // server's startup model — the process-wide leak this whole feature is
    // scoped to avoid.
    await run('rs-leak-a', { runSettings: { model: 'leaky/model' } });
    expect(syncAuthCalls.at(-1)?.model).toBe('leaky/model');

    // The server's own config is untouched...
    expect(testConfig.ai.model).toBe(SERVER_MODEL);
    const { body } = await api('GET', '/config');
    expect(body.server.model).toBe(SERVER_MODEL);

    // ...so a session created AFTER the override runs on the base model.
    await run('rs-leak-b');
    expect(syncAuthCalls.at(-1)?.model).toBe(SERVER_MODEL);
  });

  it('a blank AI_API_KEY= clears the key rather than being ignored', async () => {
    // Present-but-empty is a VALUE. A blank line is how a project pins itself
    // keyless, and `applyEnvToAiConfig` used to require `length > 0`, so the
    // server kept its OWN key — which `withMachineAiFloor` fills from the
    // machine `.env`. Four documents in this repo promise the opposite.
    //
    // The sharp edge is Bedrock SigV4, whose whole setup is "no key, let the
    // AWS credential chain sign": an explicit key outranks every AWS source, so
    // the machine's gateway key would travel to AWS as a bearer token and SigV4
    // would never run. That is a credential going somewhere it was never meant
    // to, which is why this is asserted through the real route rather than a
    // unit test of the helper.
    await run('rs-blank-key', {
      env: { AI_API_KEY: '', AI_MODEL: 'bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0' },
    });

    const last = syncAuthCalls.at(-1);
    expect(last?.model).toBe('bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(last?.apiKey).toBe('');
    expect(last?.apiKey).not.toBe(SERVER_AI_KEY);
  });

  it('an absent AI_API_KEY still inherits the server key — only a blank one clears', async () => {
    // The other half of the guard: "not mentioned" must keep meaning "fall
    // back", or every project without the line would lose the machine key.
    await run('rs-absent-key', { env: { AI_MODEL: 'openai/gpt-4o' } });

    expect(syncAuthCalls.at(-1)?.apiKey).toBe(SERVER_AI_KEY);
  });

  it('null falls back to env, then to the server base', async () => {
    await run('rs-model-clear', { runSettings: { model: 'override/model' } });
    await run('rs-model-clear', {
      env: { AI_MODEL: 'from-dot-env' },
      runSettings: { model: null },
    });
    expect(syncAuthCalls.at(-1)?.model).toBe('from-dot-env');

    await run('rs-model-clear');
    expect(syncAuthCalls.at(-1)?.model).toBe(SERVER_MODEL);
  });
});

// ---------------------------------------------------------------------------
// AI_GATEWAY_URL (stories/keyless-replay-and-gateway-env.md Part A)
//
// Here rather than in a loader unit test because the loader is not on this
// path at all: Steptix ships the project's `.env` as `request.env`, and the
// server folds it in with `applyEnvToAiConfig`. A var added to the loader and
// not there passes every loader test and does nothing through the extension —
// the exact trap the codebehind-env-data work hit with `envName`.
//
// There is no `runSettings` gateway knob on purpose, so unlike the model there
// is nothing above `.env` to lose to.
// ---------------------------------------------------------------------------
describe('AI_GATEWAY_URL from the request env', () => {
  it('reaches the AiClient a new session is built with', async () => {
    await run('gw-new', { env: { AI_GATEWAY_URL: 'https://llm.corp.example' } });

    // Construction, not just the re-apply: the first batch of a session builds
    // its client straight from `applyEnvToAiConfig`.
    expect(aiClientConfigs.at(-1)?.gatewayUrl).toBe('https://llm.corp.example');
    expect(syncAuthCalls.at(-1)?.gatewayUrl).toBe('https://llm.corp.example');
  });

  it('is trimmed, and a blank one leaves the server base', async () => {
    await run('gw-blank', { env: { AI_GATEWAY_URL: '   ' } });
    expect(syncAuthCalls.at(-1)?.gatewayUrl).toBe(SERVER_GATEWAY);

    await run('gw-pad', { env: { AI_GATEWAY_URL: '  https://llm.corp.example  ' } });
    expect(syncAuthCalls.at(-1)?.gatewayUrl).toBe('https://llm.corp.example');
  });

  it('an edit between batches re-points a REUSED session, with no recycle', async () => {
    // Verification rule (4). The gateway is baked into the client's `baseURL`
    // at build time, so this is the case that fails silently: the value is
    // resolved correctly every batch and the session keeps calling the old
    // endpoint until someone closes it.
    await run('gw-reuse', { env: { AI_GATEWAY_URL: 'https://old.corp.example' } });
    await run('gw-reuse', { env: { AI_GATEWAY_URL: 'https://new.corp.example' } });

    // One session → one client, built with the OLD url — so the new one can
    // only have arrived through syncAuth, which is the point.
    expect(aiClientConfigs).toEqual([
      expect.objectContaining({ gatewayUrl: 'https://old.corp.example' }),
    ]);
    expect(syncAuthCalls.at(-1)?.gatewayUrl).toBe('https://new.corp.example');
  });

  it('a removed line reverts to the server base rather than sticking', async () => {
    await run('gw-revert', { env: { AI_GATEWAY_URL: 'https://llm.corp.example' } });
    await run('gw-revert', { env: { AI_MODEL: 'from-dot-env' } });

    expect(syncAuthCalls.at(-1)?.gatewayUrl).toBe(SERVER_GATEWAY);
  });

  it('does not leak into the server base, so a later session starts clean', async () => {
    await run('gw-leak-a', { env: { AI_GATEWAY_URL: 'https://leaky.corp.example' } });
    expect(testConfig.ai.gatewayUrl).toBe(SERVER_GATEWAY);

    await run('gw-leak-b');
    expect(aiClientConfigs.at(-1)?.gatewayUrl).toBe(SERVER_GATEWAY);
    expect(syncAuthCalls.at(-1)?.gatewayUrl).toBe(SERVER_GATEWAY);
  });
});

// ---------------------------------------------------------------------------
// Keyless (stories/keyless-replay-and-gateway-env.md Part B)
//
// The server path decides keylessness for itself — `runTest`'s answer never
// reaches it — and it decides it from a value that is NOT on the config the
// executor is handed, so nothing in the assertions above can see it. Deleting
// the flag entirely left the whole suite green until this block existed.
//
// A second server, because a run is keyless when the config it booted with has
// no key: the one above deliberately has one, and overrides only ever ADD a
// key on this path.
// ---------------------------------------------------------------------------
describe('keyless reaching the executor', () => {
  let keylessServer: Server;
  let keylessBase: string;

  beforeAll(async () => {
    // Built from DEFAULT_CONFIG.ai rather than by deleting a key from
    // `testConfig.ai`, and DEFAULT_CONFIG carries no `apiKey` at all — the
    // minimum-scenario rule: a fixture that inherits the dev machine's key
    // would condition the very thing under test out of the test.
    const keylessConfig: Config = {
      ...testConfig,
      ai: { ...DEFAULT_CONFIG.ai, model: SERVER_MODEL, gatewayUrl: SERVER_GATEWAY },
    };
    const { app } = createApiServer(keylessConfig);
    ({ server: keylessServer, baseUrl: keylessBase } = await listenOnRandomPort(app));
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      keylessServer.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it('passes keyless:true when the server has no key', async () => {
    await run('kl-none', {}, keylessBase);
    expect(optsAt(0)['keyless']).toBe(true);
  });

  it('drops it again when the request\'s .env ships a key', async () => {
    // THE case. `runConfig.ai` is rebuilt from the server's startup config with
    // only run settings re-sourced, so on this run it still has no key — read
    // the flag off it instead of off `applyEnvToAiConfig`'s result and a
    // project that brought its own key would be refused a heal on a keyless
    // server, with the test above still passing.
    await run('kl-env-key', { env: { AI_API_KEY: 'from-dot-env-key' } }, keylessBase);

    expect(optsAt(0)).not.toHaveProperty('keyless');
    expect(configAt(0).ai.apiKey).toBeUndefined();
    // ...and the key really did arrive — otherwise the assertion above would
    // pass for the wrong reason.
    expect(syncAuthCalls.at(-1)?.apiKey).toBe('from-dot-env-key');
  });

  it('is absent on a keyed server, so a keyed run\'s options are unchanged', async () => {
    await run('kl-keyed');
    expect(optsAt(0)).not.toHaveProperty('keyless');
  });

  it('reports the echo as off for want of a key, and NOT as policy', async () => {
    // The half of the distinction the keyed server cannot produce. Support has
    // to be able to tell "somebody asked for this" from "this machine has no
    // model", because the fix is the opposite in each case.
    const done = await doneFrameOf('kl-echo', {}, keylessBase);

    expect(done.effectiveSettings.ai).toBe('off');
    expect(done.effectiveSettings.aiOffReason).toBe('no-key');
    // Nothing was chosen, so the source stays where the policy came from.
    expect(done.effectiveSettings.sources.ai).toBe('server');
  });

  it('says policy, not no-key, when a keyless run was ALSO asked to forbid AI', async () => {
    // Both are true and only one is useful: a key is not the fix on a run that
    // was asked to spend nothing.
    const done = await doneFrameOf('kl-both', { runSettings: { ai: 'off' } }, keylessBase);

    expect(done.effectiveSettings.aiOffReason).toBe('policy');
    expect(optsAt(0)['keylessReason']).toBe('policy');
  });

  it('does NOT claim policy for a keyless run the caller left alone', async () => {
    // …and the executor's explanation follows the same rule: absent means
    // 'no-key', which is what keeps today's keyless wording on today's path.
    await run('kl-reason', {}, keylessBase);

    expect(optsAt(0)['keyless']).toBe(true);
    expect(optsAt(0)).not.toHaveProperty('keylessReason');
  });

  it('stops being keyless when the session overrides to a self-authenticating model', async () => {
    // The mirror of the Bedrock override case below, and the one that keeps the
    // two halves of `runKeyless` asking about the SAME model
    // (stories/bedrock-provider.md §Part B). Read off the pre-override model,
    // the key half answers for `server/base-model` — no key, so keyless — while
    // the echo answers for the override and says AI is on. The executor would
    // then refuse to heal a broken entry on a run that has a model, and the
    // done frame would insist it does.
    const done = await doneFrameOf('kl-to-selfauth', {
      runSettings: { model: 'bedrock/global.anthropic.claude-opus-4-6-v1' },
    }, keylessBase);

    expect(done.effectiveSettings.ai).toBe('on');
    expect(optsAt(0)).not.toHaveProperty('keyless');
  });
});

// ---------------------------------------------------------------------------
// Keyless but configured — a self-authenticating provider
// (stories/bedrock-provider.md §Part B)
//
// A third server, with no key AND a `bedrock/` model. Everything above says a
// keyless server means a keyless run; this block is where that stops being
// true, and the two interesting cases are compositions rather than states:
// what a MODEL OVERRIDE does to the answer, and which reason an `ai: "off"`
// run reports when a key was never the problem.
//
// Driven over HTTP because the pre/post-override distinction lives in the
// session manager, not in `resolveRunSettings` — the resolver is deliberately
// handed the pre-override model, and only the executor's options can show
// which one the keyless answer was actually taken from.
// ---------------------------------------------------------------------------
describe('a keyless run on a self-authenticating provider', () => {
  const BEDROCK_MODEL = 'bedrock/global.anthropic.claude-opus-4-6-v1';
  let bedrockServer: Server;
  let bedrockBase: string;

  beforeAll(async () => {
    // Same minimum-scenario rule as the keyless server above: built from
    // DEFAULT_CONFIG.ai, which carries no `apiKey`, so nothing on the dev
    // machine can quietly key this run.
    const bedrockConfig: Config = {
      ...testConfig,
      ai: { ...DEFAULT_CONFIG.ai, model: BEDROCK_MODEL, gatewayUrl: SERVER_GATEWAY },
    };
    const { app } = createApiServer(bedrockConfig);
    ({ server: bedrockServer, baseUrl: bedrockBase } = await listenOnRandomPort(app));
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      bedrockServer.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it('is not keyless at all, and the echo says AI is on', async () => {
    const done = await doneFrameOf('bd-on', {}, bedrockBase);

    expect(optsAt(0)).not.toHaveProperty('keyless');
    expect(done.effectiveSettings.ai).toBe('on');
    expect(done.effectiveSettings.aiOffReason).toBeNull();
    // The key really is absent — otherwise this passes for the wrong reason.
    expect(configAt(0).ai.apiKey).toBeUndefined();
  });

  it('becomes keyless when the session overrides the model to a keyed provider', async () => {
    // THE composition. The run now talks to Anthropic with an empty key, so
    // asking the pre-override model would report `on` and then fail at the
    // first call — with every assertion above still green.
    const done = await doneFrameOf('bd-override', {
      runSettings: { model: 'anthropic/claude-opus-4-8' },
    }, bedrockBase);

    expect(configAt(0).ai.model).toBe('anthropic/claude-opus-4-8');
    expect(optsAt(0)['keyless']).toBe(true);
    expect(done.effectiveSettings.ai).toBe('off');
    expect(done.effectiveSettings.aiOffReason).toBe('no-key');
    // …and the client really was re-pointed, so the flag is describing the
    // model the run used rather than one nobody reached.
    expect(syncAuthCalls.at(-1)?.model).toBe('anthropic/claude-opus-4-8');
  });

  it('stays non-keyless when the override names another self-authenticating model', async () => {
    // The control for the case above: an override is not disqualifying, it
    // just moves which model the question is about.
    await run('bd-override-ok', {
      runSettings: { model: 'bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0' },
    }, bedrockBase);

    expect(optsAt(0)).not.toHaveProperty('keyless');
  });

  it('says policy, never no key, when a working Bedrock run is switched off', async () => {
    // The other trap. This run HAS AI and was told not to spend it, so
    // `off (no key)` would send the reader to add a key Bedrock has no use for
    // — the exact wrong advice Part B exists to stop.
    const done = await doneFrameOf('bd-off', { runSettings: { ai: 'off' } }, bedrockBase);

    expect(done.effectiveSettings.ai).toBe('off');
    expect(done.effectiveSettings.aiOffReason).toBe('policy');
    expect(optsAt(0)['keyless']).toBe(true);
    expect(optsAt(0)['keylessReason']).toBe('policy');
    // The client-side veil is down too, so a branched AI step refuses with the
    // policy error rather than with "AI is not configured".
    expect(aiPolicyCalls.at(-1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The AI switch (stories/run-settings.md §9)
//
// The server this block runs against is KEYED, which is the whole point: `ai:
// "off"` has to make a run behave like a keyless one *while a key is present*,
// and against a keyless server every assertion here would pass for the wrong
// reason. The no-key half is asserted on the second server below.
// ---------------------------------------------------------------------------
describe('the AI switch', () => {
  it('reaches the executor as keyless-by-policy, and veils the client', async () => {
    await run('ai-off', { runSettings: { ai: 'off' } });

    // Reuses keyless, so a compiled step still replays and a broken entry takes
    // the skip + sidecar rather than healing under a model.
    expect(optsAt(0)['keyless']).toBe(true);
    // …but says which kind, because the two need different explanations on the
    // skipped step: "no AI on this machine" is false when a key is right there.
    expect(optsAt(0)['keylessReason']).toBe('policy');
    // The client-side half. `keyless` never reaches `executeBranchedStep`, so
    // without this a branched AI step would run on a real key while the run
    // reported zero-by-policy.
    expect(aiPolicyCalls).toEqual([false]);
  });

  it('leaves a keyed run untouched when nothing asked for the switch', async () => {
    // The control the case above is only meaningful against.
    await run('ai-control');

    expect(optsAt(0)).not.toHaveProperty('keyless');
    expect(optsAt(0)).not.toHaveProperty('keylessReason');
    expect(aiPolicyCalls).toEqual([true]);
  });

  it('is retained, so a second request that says nothing still runs with AI off', async () => {
    // The silent-regression case, for `capture`'s reason: a forgotten re-send
    // must be benign, not a revert that quietly starts spending money again.
    await run('ai-retain', { runSettings: { ai: 'off' } });
    await run('ai-retain');

    expect(optsAt(1)['keyless']).toBe(true);
    expect(optsAt(1)['keylessReason']).toBe('policy');
    expect(aiPolicyCalls).toEqual([false, false]);
  });

  it('"default" restores the project value rather than the last override', async () => {
    await run('ai-default', { runSettings: { ai: 'off' } });
    expect(optsAt(0)['keyless']).toBe(true);

    await run('ai-default', { runSettings: { ai: 'default' } });
    expect(optsAt(1)).not.toHaveProperty('keyless');
    expect(aiPolicyCalls).toEqual([false, true]);
  });

  it('"on" turns it back on without waiting for a new session', async () => {
    await run('ai-back-on', { runSettings: { ai: 'off' } });
    await run('ai-back-on', { runSettings: { ai: 'on' } });

    expect(optsAt(1)).not.toHaveProperty('keyless');
    expect(aiPolicyCalls.at(-1)).toBe(true);
  });

  it('does not leak into another session', async () => {
    await run('ai-iso-a', { runSettings: { ai: 'off' } });
    await run('ai-iso-b');

    expect(optsAt(1)).not.toHaveProperty('keyless');
  });

  it('names the mode and the reason on the done event', async () => {
    const done = await doneFrameOf('ai-echo', { runSettings: { ai: 'off' } });

    expect(done.effectiveSettings.ai).toBe('off');
    expect(done.effectiveSettings.aiOffReason).toBe('policy');
    expect(done.effectiveSettings.sources.ai).toBe('session');
  });

  it('does not gate a compile, and does not consume the session\'s setting doing it', async () => {
    // Compile This Step and Repair this step ride `compile: "steps"` on THIS
    // route, so a carve-out that only covered the in-process compile endpoint
    // would leave both of them gated on an `ai: off` session.
    //
    // A `testFilePath` that does not exist is fine here: the compile fails
    // later, in generation, and what is under test is what the executor and the
    // client were handed before that.
    await run('ai-compile', { runSettings: { ai: 'off' } });
    expect(optsAt(0)['keyless']).toBe(true);

    await doneFrameOf('ai-compile', {
      compile: 'steps',
      testFilePath: path.join(tmpRoot, 'compile-carveout.md'),
    });
    expect(optsAt(1)).not.toHaveProperty('keyless');
    expect(aiPolicyCalls).toEqual([false, true]);

    // And the retained `off` survived it — the reason the carve-out is a
    // per-request flag rather than compile sending `runSettings: {ai: "on"}`,
    // which `mergeRunSettings` would keep for every later run.
    await run('ai-compile');
    expect(optsAt(2)['keyless']).toBe(true);
    expect(aiPolicyCalls).toEqual([false, true, false]);
  });
});

describe('refusals', () => {
  it('400s an unknown capture value, naming the valid ones, and runs nothing', async () => {
    // Never a silent fallback: an agent that asked for "all" and quietly got the
    // server default has no way to notice.
    const { status, body } = await api('POST', '/sessions/rs-bad-enum/steps', {
      steps: ['do a thing'],
      runSettings: { capture: 'all' },
    });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('every-step');
    expect(String(body.error)).toContain('on-failure');
    expect(String(body.error)).toContain('default');
    expect(stepMock).not.toHaveBeenCalled();

    // And no session was created by the refused request.
    const { body: sessions } = await api('GET', '/sessions');
    expect(sessions.sessions.map((s: { sessionId: string }) => s.sessionId)).not.toContain(
      'rs-bad-enum',
    );
  });

  it('400s an unknown runSettings key rather than dropping it', async () => {
    const { status, body } = await api('POST', '/sessions/rs-bad-key/steps', {
      steps: ['do a thing'],
      runSettings: { sendScreenShots: true },
    });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('sendScreenShots');
    expect(String(body.error)).toContain('sendScreenshots');
  });

  it('400s an empty model and a non-boolean flag', async () => {
    const empty = await api('POST', '/sessions/rs-bad-model/steps', {
      steps: ['x'],
      runSettings: { model: '   ' },
    });
    expect(empty.status).toBe(400);
    expect(String(empty.body.error)).toContain('non-empty');

    const flag = await api('POST', '/sessions/rs-bad-flag/steps', {
      steps: ['x'],
      runSettings: { fullPage: 'yes' },
    });
    expect(flag.status).toBe(400);
    expect(String(flag.body.error)).toContain('boolean');
  });

  it('400s an unknown ai value, naming the valid ones, and runs nothing', async () => {
    const { status, body } = await api('POST', '/sessions/rs-bad-ai/steps', {
      steps: ['do a thing'],
      runSettings: { ai: 'no' },
    });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('runSettings.ai');
    expect(String(body.error)).toContain('"on"');
    expect(String(body.error)).toContain('"off"');
    expect(String(body.error)).toContain('"default"');
    expect(stepMock).not.toHaveBeenCalled();
  });

  it('names ai among the valid keys, so a misspelling points at the right one', async () => {
    // The key has to be on the allow-list at all: before §9 the route refused
    // `ai` outright as unknown, so "accepted on the wire" is a claim worth
    // pinning from the refusal side too.
    const { status, body } = await api('POST', '/sessions/rs-ai-key/steps', {
      steps: ['do a thing'],
      runSettings: { Ai: 'off' },
    });

    expect(status).toBe(400);
    expect(String(body.error)).toContain('"Ai"');
    expect(String(body.error)).toMatch(/Valid keys are .*\bai\b/);
  });

  it('400s a non-object runSettings', async () => {
    const { status } = await api('POST', '/sessions/rs-bad-shape/steps', {
      steps: ['x'],
      runSettings: ['every-step'],
    });
    expect(status).toBe(400);
  });
});

describe('the echo on the done event', () => {
  it('names the settings the run actually used, and where each came from', async () => {
    const res = await fetch(`${baseUrl}/sessions/rs-echo/steps?stream=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        steps: ['do a thing'],
        sourceLines: [1],
        runSettings: { capture: 'every-step', model: 'echo/model' },
      }),
    });
    const events = await readSse(res);
    const done = events.find((e) => e.event === 'done');

    expect(done?.data.effectiveSettings).toEqual({
      model: 'echo/model',
      capture: 'every-step',
      fullPage: false,
      sendScreenshots: false,
      ai: 'on',
      aiOffReason: null,
      sources: {
        model: 'session',
        capture: 'session',
        // Untouched values report where they really came from, which for a
        // server with no project config in play is the server.
        fullPage: 'server',
        sendScreenshots: 'server',
        ai: 'server',
      },
    });
  });
});

describe('GET /config', () => {
  it('redacts both api keys to booleans', async () => {
    const { status, body } = await api('GET', '/config');

    expect(status).toBe(200);
    // Removed, not blanked to a redacted-looking string: a string is still a
    // string, and a client echoing config into a log would carry it around.
    expect(body.config.ai.apiKey).toBeUndefined();
    expect(body.config.server.apiKey).toBeUndefined();
    expect(body.config.ai.apiKeySet).toBe(true);
    expect(body.config.server.apiKeySet).toBe(true);
    // And nothing anywhere in the payload spells either secret out.
    expect(JSON.stringify(body)).not.toContain(SERVER_AI_KEY);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('reports the server defaults with no session named', async () => {
    const { body } = await api('GET', '/config');

    expect(body.server).toEqual({
      model: SERVER_MODEL,
      capture: 'on-failure',
      fullPage: false,
      sendScreenshots: false,
      ai: 'on',
      aiOffReason: null,
      sources: {
        model: 'server',
        capture: 'server',
        fullPage: 'server',
        sendScreenshots: 'server',
        ai: 'server',
      },
    });
    expect(body.session).toBeNull();
  });

  it('includes a session\'s retained overrides', async () => {
    await run('rs-config-session', {
      runSettings: { capture: 'every-step', model: 'session/model' },
    });

    const { status, body } = await api('GET', '/config?sessionId=rs-config-session');

    expect(status).toBe(200);
    expect(body.session.sessionId).toBe('rs-config-session');
    expect(body.session.overrides).toEqual({ capture: 'every-step', model: 'session/model' });
    expect(body.session.effective.capture).toBe('every-step');
    expect(body.session.effective.model).toBe('session/model');
    expect(body.session.effective.sources.capture).toBe('session');
    // The base is still reported, so "is this a default or did someone change
    // it?" is answerable from one call.
    expect(body.server.capture).toBe('on-failure');
  });

  it('404s an unknown session rather than answering with the base config', async () => {
    const { status, body } = await api('GET', '/config?sessionId=no-such-session');

    expect(status).toBe(404);
    expect(String(body.error)).toContain('not found');
  });

  it('400s an empty sessionId', async () => {
    const { status } = await api('GET', '/config?sessionId=');
    expect(status).toBe(400);
  });

  // Behind the api key, unlike /health — this body carries project paths and
  // the resolved model. tests/api-server.test.ts proves that for every route
  // by walking the app's router.
});

describe('the project bundle as a source', () => {
  it('reports a project-set value as project-sourced, and a session override beats it', async () => {
    // A project whose own config differs from the server's on one of the four.
    const root = path.join(tmpRoot, 'proj');
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(
      path.join(root, 'steptix.config.json'),
      JSON.stringify({ browser: { fullPageScreenshots: true } }),
    );
    const testFilePath = path.join(root, 'tests', 't.md');

    await run('rs-project', { testFilePath });
    expect(settingsAt(0).fullPage).toBe(true);

    const first = await api('GET', '/config?sessionId=rs-project');
    expect(first.body.session.effective.fullPage).toBe(true);
    expect(first.body.session.effective.sources.fullPage).toBe('project');

    // A session override beats the project's value, and says so.
    await run('rs-project', { testFilePath, runSettings: { fullPage: false } });
    expect(settingsAt(1).fullPage).toBe(false);

    const second = await api('GET', '/config?sessionId=rs-project');
    expect(second.body.session.effective.sources.fullPage).toBe('session');
  });
});
