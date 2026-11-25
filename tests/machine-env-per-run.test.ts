/**
 * Issue #128: a change to the machine-wide settings file
 * (`%LOCALAPPDATA%\steptix\.env`, `~/.steptix/.env` elsewhere) takes effect on
 * the next run, with no server restart.
 *
 * The server is the real one, in this process, built from `loadConfig` the way
 * `serve` builds it — that is the only path that knows which AI values the
 * server's own settings left for the machine file to fill. A hand-built
 * `Config` would test a server no one starts.
 *
 * Every assertion is on what the run actually used: the model, key and gateway
 * the AI client was pointed at (`syncAuth` and the constructor, the only two
 * places they take effect) and the config the executor was handed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — the same set api-server-run-settings.test.ts uses, so no real
// browser or AI is involved.
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => null),
};
const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: { getActive: vi.fn(() => mockPage as any) },
};

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    getActive: ReturnType<typeof vi.fn>;
    closeAll = vi.fn(async () => {});
    hasActive: ReturnType<typeof vi.fn>;
    ensureLaunched: ReturnType<typeof vi.fn>;
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.hasActive = vi.fn(() => true);
      this.ensureLaunched = vi.fn(async () => initialSession);
    }
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

type MockAiConfig = { model: string; apiKey?: string | undefined; gatewayUrl?: string | undefined };

/** What each AI client was built with, then every re-pointing, in order. */
const aiClientConfigs: MockAiConfig[] = [];
const syncAuthCalls: { model: string; apiKey: string | undefined; gatewayUrl: string | null | undefined }[] = [];

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    config: MockAiConfig;
    constructor(config: MockAiConfig) {
      this.config = config;
      aiClientConfigs.push({ ...config });
    }
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    isConfigured = vi.fn(() => true);
    syncAuth = vi.fn((model: string, apiKey: string | undefined, gatewayUrl?: string | null) => {
      syncAuthCalls.push({ model, apiKey, gatewayUrl });
      const changed = model !== this.config.model;
      this.config.model = model;
      this.config.apiKey = apiKey;
      this.config.gatewayUrl = gatewayUrl ?? undefined;
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

vi.mock('@steptix/aigateway', () => {
  class FakeAIGateway {
    static providers() {
      return [
        { id: 'anthropic', prefix: 'anthropic/' },
        { id: 'gateway', prefix: 'gateway/' },
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
import { loadConfig } from '../src/config/loader.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { executeStep } from '../src/runner/step-executor.js';
import { logger } from '../src/utils/logger.js';
import { listenFetchable } from './listen-fetchable.cjs';
import { modelForRunLine } from '../src/server/run-helpers.js';

const stepMock = vi.mocked(executeStep);

const API_KEY = 'machine-env-per-run-key';
const MODEL_A = 'gateway/machine-model-a';
const MODEL_B = 'gateway/machine-model-b';

/** The variables this file moves, restored in `afterAll`. */
const TOUCHED_ENV = ['LOCALAPPDATA', 'XDG_CONFIG_HOME', 'AI_MODEL', 'AI_API_KEY', 'AI_GATEWAY_URL'];
const savedEnv: Record<string, string | undefined> = {};

let server: Server;
let baseUrl: string;
let tmpRoot: string;
/** `<tmpRoot>/user-root/steptix/.env` — the machine file. */
let machineEnvPath: string;
/** A project whose `.env` names no model, so the machine file decides. */
let testFilePath: string;

function writeMachineEnv(lines: string[]): void {
  writeFileSync(machineEnvPath, lines.join('\n') + '\n', { mode: 0o600 });
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

/** Run one batch in `sessionId`, sending the project `.env` a client sends. */
async function run(
  sessionId: string,
  env: Record<string, string> = { BASE_URL: 'https://example.test' },
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { status, body } = await api('POST', `/sessions/${sessionId}/steps`, {
    steps: ['do a thing'],
    sourceLines: [1],
    testFilePath,
    env,
    ...extra,
  });
  expect(status, JSON.stringify(body)).toBe(200);
}

/** The model, key and gateway the AI client was last pointed at. */
function lastAi(): MockAiConfig {
  const last = syncAuthCalls.at(-1);
  expect(last, 'the run never pointed its AI client anywhere').toBeDefined();
  return { model: last!.model, apiKey: last!.apiKey, gatewayUrl: last!.gatewayUrl ?? undefined };
}

/** The config the executor got on the most recent step. */
function lastRunConfig(): Config {
  const calls = stepMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return (calls.at(-1)![3] as unknown as { config: Config }).config;
}

beforeAll(async () => {
  for (const k of TOUCHED_ENV) savedEnv[k] = process.env[k];
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'steptix-machine-env-'));
  const userRootBase = path.join(tmpRoot, 'user-root');
  // Both, so the same file is the machine file on every platform.
  process.env['LOCALAPPDATA'] = userRootBase;
  process.env['XDG_CONFIG_HOME'] = userRootBase;
  // The server's own environment names no AI value, as when VS Code starts it.
  delete process.env['AI_MODEL'];
  delete process.env['AI_API_KEY'];
  delete process.env['AI_GATEWAY_URL'];
  mkdirSync(path.join(userRootBase, 'steptix'), { recursive: true });
  machineEnvPath = path.join(userRootBase, 'steptix', '.env');
  writeMachineEnv([`AI_MODEL=${MODEL_A}`, 'AI_API_KEY=machine-key-a', 'AI_GATEWAY_URL=https://a.gateway.test']);

  const project = path.join(tmpRoot, 'project');
  mkdirSync(path.join(project, 'tests'), { recursive: true });
  writeFileSync(path.join(project, 'steptix.config.json'), '{}\n');
  writeFileSync(path.join(project, '.env'), 'BASE_URL=https://example.test\n');
  testFilePath = path.join(project, 'tests', 't.md');
  writeFileSync(testFilePath, '# T\n\n1. do a thing\n');

  // The server's own folder has no steptix.config.json, like a fresh install.
  const serverRoot = path.join(tmpRoot, 'server');
  mkdirSync(serverRoot, { recursive: true });
  const loaded = await loadConfig(undefined, serverRoot);
  const config: Config = {
    ...loaded,
    browser: { ...loaded.browser, headed: false },
    server: { ...loaded.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
    logging: { ...loaded.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  };
  const { app } = createApiServer(config);
  server = createServer(app);
  await listenFetchable(server, '127.0.0.1');
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
}, 30_000);

afterAll(async () => {
  try {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  } finally {
    for (const k of TOUCHED_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  }
});

beforeEach(() => {
  stepMock.mockClear();
  vi.mocked(logger.info).mockClear();
  syncAuthCalls.length = 0;
  aiClientConfigs.length = 0;
  writeMachineEnv([`AI_MODEL=${MODEL_A}`, 'AI_API_KEY=machine-key-a', 'AI_GATEWAY_URL=https://a.gateway.test']);
});

describe('a change to the machine settings file, with the server still running', () => {
  it('reaches the next run in the same session', async () => {
    await run('per-run-model');
    expect(lastAi().model).toBe(MODEL_A);

    writeMachineEnv([`AI_MODEL=${MODEL_B}`, 'AI_API_KEY=machine-key-a', 'AI_GATEWAY_URL=https://a.gateway.test']);
    await run('per-run-model');

    expect(lastAi().model).toBe(MODEL_B);
    expect(lastRunConfig().ai.model).toBe(MODEL_B);
  });
});

describe('the other AI values in the machine file', () => {
  it('a changed key and gateway reach the next run', async () => {
    await run('per-run-key');
    expect(lastAi()).toEqual({ model: MODEL_A, apiKey: 'machine-key-a', gatewayUrl: 'https://a.gateway.test' });

    writeMachineEnv([`AI_MODEL=${MODEL_A}`, 'AI_API_KEY=machine-key-b', 'AI_GATEWAY_URL=https://b.gateway.test']);
    await run('per-run-key');

    expect(lastAi()).toEqual({ model: MODEL_A, apiKey: 'machine-key-b', gatewayUrl: 'https://b.gateway.test' });
    expect(lastRunConfig().ai.apiKey).toBe('machine-key-b');
    expect(lastRunConfig().ai.gatewayUrl).toBe('https://b.gateway.test');
  });

  it('a removed line goes back to the built-in value, not the one read at startup', async () => {
    await run('per-run-removed');
    writeMachineEnv(['AI_API_KEY=machine-key-a']);
    await run('per-run-removed');

    expect(lastAi().model).toBe(DEFAULT_CONFIG.ai.model);
    expect(lastAi().gatewayUrl).toBeUndefined();
  });
});

describe('a session opened after the change', () => {
  it('is built with the file as it is now', async () => {
    writeMachineEnv([`AI_MODEL=${MODEL_B}`, 'AI_API_KEY=machine-key-b']);
    await run('per-run-new-session');

    expect(aiClientConfigs.at(-1)?.model).toBe(MODEL_B);
    expect(aiClientConfigs.at(-1)?.apiKey).toBe('machine-key-b');
  });
});

describe('a project that sets its own values', () => {
  it('keeps its own model, whatever the machine file says', async () => {
    const env = { AI_MODEL: 'gateway/project-model' };
    await run('per-run-project-model', env);
    writeMachineEnv([`AI_MODEL=${MODEL_B}`]);
    await run('per-run-project-model', env);

    expect(lastAi().model).toBe('gateway/project-model');
  });

  it('a blank AI_API_KEY= stays keyless when the machine file gains a key', async () => {
    const env = { AI_API_KEY: '' };
    writeMachineEnv([`AI_MODEL=${MODEL_A}`]);
    await run('per-run-keyless', env);
    writeMachineEnv([`AI_MODEL=${MODEL_A}`, 'AI_API_KEY=machine-key-b']);
    await run('per-run-keyless', env);

    // The client is what makes the AI calls, so this is the key that matters.
    expect(lastAi().apiKey).toBe('');
  });
});

describe('the settings report (GET /config, and the MCP get_run_settings that reads it)', () => {
  it('names the model the next run will use, not the one read at startup', async () => {
    writeMachineEnv([`AI_MODEL=${MODEL_B}`]);

    const { status, body } = await api('GET', '/config');

    expect(status).toBe(200);
    expect(body.server.model).toBe(MODEL_B);
    expect(body.server.sources.model).toBe('server');
    expect(body.config.ai.model).toBe(MODEL_B);
  });

  it('reports a session that ran after the change with the new model as the server\'s', async () => {
    await run('per-run-report');
    writeMachineEnv([`AI_MODEL=${MODEL_B}`]);
    await run('per-run-report');

    const { body } = await api('GET', '/config?sessionId=per-run-report');

    expect(body.session.effective.model).toBe(MODEL_B);
    // The machine file is part of the server's base, as it was before: a
    // change there must not make the run look like the project chose it.
    expect(body.session.effective.sources.model).toBe('server');
  });
});

/** Every "AI model for this run" line logged since the last `beforeEach`. */
function modelLines(): string[] {
  return vi
    .mocked(logger.info)
    .mock.calls.map((c) => String(c[0]))
    .filter((m) => m.startsWith('AI model for this run:'));
}

describe('the line saying which model a run uses and where it came from', () => {
  it('names the machine file, with its path, when that chose the model', async () => {
    await run('line-machine');

    expect(modelLines()).toEqual([
      `AI model for this run: ${MODEL_A}, from the machine-wide settings file (${machineEnvPath}).`,
    ]);
  });

  it('is said once per run, not once per batch, and again at the next run', async () => {
    await run('line-once', undefined, { runStart: {} });
    await run('line-once');
    await run('line-once');
    expect(modelLines()).toHaveLength(1);

    await run('line-once', undefined, { runStart: {} });
    expect(modelLines()).toHaveLength(2);
  });

  it('is said again, mid-run, when the machine file changes the model', async () => {
    await run('line-change', undefined, { runStart: {} });
    writeMachineEnv([`AI_MODEL=${MODEL_B}`, 'AI_API_KEY=machine-key-a']);
    await run('line-change');

    expect(modelLines().at(-1)).toBe(
      `AI model for this run: ${MODEL_B}, from the machine-wide settings file (${machineEnvPath}).`,
    );
  });

  it("names the project's .env when that chose the model", async () => {
    await run('line-project', { AI_MODEL: 'gateway/project-model' });

    expect(modelLines()).toEqual([
      "AI model for this run: gateway/project-model, from this project's .env file.",
    ]);
  });

  it('names the session when a run setting chose the model', async () => {
    await run('line-session', undefined, { runSettings: { model: 'gateway/session-model' } });

    expect(modelLines()).toEqual(['AI model for this run: gateway/session-model, set for this session.']);
  });

  it('names the built-in default when nothing chose a model', async () => {
    writeMachineEnv(['AI_API_KEY=machine-key-a']);
    await run('line-default');

    expect(modelLines()).toEqual([
      `AI model for this run: ${DEFAULT_CONFIG.ai.model}, Steptix's built-in default — no settings file names a model.`,
    ]);
  });

  it('is not said for a run with no AI, and is said once AI comes back', async () => {
    await run('line-keyless', { AI_API_KEY: '' });
    expect(modelLines()).toEqual([]);

    await run('line-keyless');
    expect(modelLines()).toHaveLength(1);
  });

  it("names the server's own settings when they chose the model", () => {
    // Not driven through a run: the server above was started with no AI_MODEL
    // in its environment, which is the point of it.
    expect(modelForRunLine('gateway/m', 'server-settings', 'unused')).toBe(
      "AI model for this run: gateway/m, from the server's own settings " +
        '(the environment it was started with, or its steptix.config.json).',
    );
  });
});
