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
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.closeAll = vi.fn(async () => {});
    }
  }
  return {
    launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
    PageTracker: vi.fn(),
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

/** Every `syncAuth` the server made, across every session, in order. This is
 *  the only place the model actually takes effect — the executor is handed a
 *  config but the AI call goes through the client — so a model test that did
 *  not look here would be testing the wrong thing. */
const syncAuthCalls: { model: string; apiKey: string | undefined }[] = [];

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    /** Retained and MUTATED by `syncAuth`, exactly as the real client does.
     *  That one detail is not cosmetic: the real client writes the new model
     *  into the config object it was handed, so a mock that merely recorded the
     *  call could not catch the aliasing bug where that object is the SERVER's
     *  own `config.ai`. */
    config: { model: string; apiKey?: string | undefined };
    constructor(config: { model: string; apiKey?: string | undefined }) {
      this.config = config;
    }
    chat = vi.fn(async () => '{}');
    syncAuth = vi.fn((model: string, apiKey: string | undefined) => {
      syncAuthCalls.push({ model, apiKey });
      const changed = model !== this.config.model;
      this.config.model = model;
      if (apiKey === undefined) delete this.config.apiKey;
      else this.config.apiKey = apiKey;
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

const stepMock = vi.mocked(executeStep);

const API_KEY = 'run-settings-key';
const SERVER_MODEL = 'server/base-model';
const SERVER_AI_KEY = 'server-ai-key';

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
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => resolve()); });
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${p}`, opts);
  return { status: res.status, body: await res.json() };
}

/** The `config` the executor was handed on the Nth (0-based) step call. */
function configAt(call: number): Config {
  const args = stepMock.mock.calls[call];
  expect(args, `no executeStep call #${call}`).toBeDefined();
  return (args![3] as unknown as { config: Config }).config;
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

async function run(sessionId: string, body: Record<string, unknown> = {}): Promise<any> {
  const { status, body: result } = await api('POST', `/sessions/${sessionId}/steps`, {
    steps: ['do a thing'],
    sourceLines: [1],
    ...body,
  });
  expect(status, JSON.stringify(result)).toBe(200);
  return result;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'aiui-runsettings-'));
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
});

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
    // The same server also serves TestBench. A setting that leaked across
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

  it('400s a non-object runSettings', async () => {
    const { status } = await api('POST', '/sessions/rs-bad-shape/steps', {
      steps: ['x'],
      runSettings: ['every-step'],
    });
    expect(status).toBe(400);
  });
});

describe('the echo on the done event', () => {
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
      sources: {
        model: 'session',
        capture: 'session',
        // Untouched values report where they really came from, which for a
        // server with no project config in play is the server.
        fullPage: 'server',
        sendScreenshots: 'server',
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
      sources: {
        model: 'server',
        capture: 'server',
        fullPage: 'server',
        sendScreenshots: 'server',
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

  it('requires the api key', async () => {
    // Unlike /health, which is deliberately open: this body carries project
    // paths and the resolved model.
    const res = await fetch(`${baseUrl}/config`);
    expect(res.status).toBe(401);
  });
});

describe('the project bundle as a source', () => {
  it('reports a project-set value as project-sourced, and a session override beats it', async () => {
    // A project whose own config differs from the server's on one of the four.
    const root = path.join(tmpRoot, 'proj');
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(
      path.join(root, 'aiui.config.json'),
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
