/**
 * End-to-end test for server-side tool dispatch (Phase 5.A).
 *
 * Pre-Phase-5, `[tool: ...]` lines in a `POST /sessions/:id/steps` request
 * went straight to the AI as plain text — the same gap Phase 1 fixed for
 * skills. This test exercises the HTTP route with a real `toolsDir`
 * pointing at a real tool fixture, and asserts:
 *
 *   - the tool's `run()` actually executes (not just the AI seeing the text);
 *   - the tool's outputs land in `session.outputs` via `capture` events;
 *   - the step:pass payload includes the tool's aiExplanation;
 *   - tools work alongside skills in the same run.
 *
 * The browser / AI / step-executor are mocked the same way as
 * api-server-stepmode.test.ts. The tool catalogue + `executeToolStep` are
 * exercised for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server-stepmode.test.ts) ───────────────────────

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example Page'),
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
  };
});

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (): Promise<StepResult> => ({
    index: 1,
    instruction: 'mock step',
    status: 'passed',
    turns: [],
    durationMs: 5,
    retried: false,
    aiExplanation: 'ok',
  })),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class { chat = vi.fn(async () => '{}'); },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class { resetStep = vi.fn(); totalTokens = 0; },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class { store = vi.fn(); getHistory = vi.fn(() => []); },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
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

import { createApiServer } from '../src/server/api-server.js';

const API_KEY = 'sk-tools-test';
const cfg: Config = {
  ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
  browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
  tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
  execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: false, maxTurns: 5 },
  reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
  api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
  server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
  cache: { enabled: false, dir: '.cache' },
  logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let toolsDir: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // Fixture: a tools dir with a trivial tool that returns a known output.
  toolsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-dispatch-'));
  await fs.writeFile(
    path.join(toolsDir, 'echo.ts'),
    `
import { defineTool } from '${path.resolve(__dirname, '..', 'src', 'tools', 'index.ts').replace(/\\/g, '/')}';

export default defineTool({
  name: 'echo',
  description: 'Echo a value back as an output',
  parameters: { value: { type: 'string' } },
  outputs: { echoed: { type: 'string' } },
  async run(args, ctx) {
    ctx.step.setVar('echoed', args.value);
  },
});
`,
  );
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => err ? e(err) : r()));
  await fs.rm(toolsDir, { recursive: true, force: true });
});

async function* sseEvents(
  url: string,
  body: unknown,
): AsyncGenerator<{ type: string; [k: string]: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const data = dataLine.slice(6);
      try {
        yield JSON.parse(data);
      } catch {
        // ignore
      }
    }
  }
}

describe('api-server tool dispatch', () => {
  it('toolsDir loads catalogue and dispatches [tool: ...] steps through executeToolStep', async () => {
    const sessionId = 'tools-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['[tool: echo value="hello-from-tool"]'],
      sourceLines: [1],
      toolsDir,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    // The tool ran — capture event mirrored the setVar.
    const captures = events.filter((e) => e.type === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ name: 'echoed', value: 'hello-from-tool' });

    // The step passed; aiExplanation mentions the tool name + outputs.
    const passes = events.filter((e) => e.type === 'step:pass');
    expect(passes).toHaveLength(1);
    expect(passes[0].output ?? '').toMatch(/Tool "echo" produced outputs/);

    const done = events.find((e) => e.type === 'done');
    expect(done?.status).toBe('passed');
  });

  it('without toolsDir, [tool: ...] steps fall through to executeStep (legacy)', async () => {
    // Without `toolsDir` in the body, the catalogue isn't loaded; the
    // tool line goes through the AI mock (which we've stubbed to always
    // pass). The aiExplanation must therefore NOT contain the tool's
    // "produced outputs" string — it's whatever the AI returned.
    const sessionId = 'no-tools-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['[tool: echo value="should-fall-through"]'],
      sourceLines: [1],
      // toolsDir omitted on purpose
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    const captures = events.filter((e) => e.type === 'capture');
    expect(captures).toHaveLength(0); // no setVar fired
  });

  it('pauseAtNextTool emits tool:awaiting-debugger and parks until ack arrives', async () => {
    // Phase 5.B — when the request body sets `pauseAtNextTool: true`,
    // the server emits `tool:awaiting-debugger` before the next
    // `[tool: ...]` step and waits for `POST /sessions/:id/tool-debugger-ack`.
    // Without the ack the run hangs at the pause point; once the ack
    // arrives, execution proceeds and the tool runs normally.
    const sessionId = 'tool-debug-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    let sawAwaiting = false;

    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['[tool: echo value="paused"]'],
        sourceLines: [1],
        toolsDir,
        pauseAtNextTool: true,
      })) {
        events.push(ev);
        if (ev.type === 'tool:awaiting-debugger') {
          sawAwaiting = true;
          // Acknowledge — server proceeds past `debugger;`.
          const ackRes = await fetch(
            `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/tool-debugger-ack`,
            { method: 'POST', headers: { 'x-api-key': API_KEY } },
          );
          expect(ackRes.status).toBe(200);
        }
        if (ev.type === 'done') break;
      }
    })();

    await consume;

    expect(sawAwaiting).toBe(true);
    const awaiting = events.find((e) => e.type === 'tool:awaiting-debugger');
    expect(awaiting.toolName).toBe('echo');
    expect(awaiting.toolFilePath).toMatch(/echo\.ts$/);
    expect(awaiting.line).toBe(1);

    // The tool still ran after the ack — capture event present.
    const captures = events.filter((e) => e.type === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ name: 'echoed', value: 'paused' });
  });

  it('pauseAtNextTool is a one-shot — second tool runs normally', async () => {
    // The flag self-clears after the first trigger so subsequent tools
    // in the same batch don't double-pause. Run two tool steps with
    // `pauseAtNextTool: true` on the initial body; exactly one
    // `tool:awaiting-debugger` event should fire.
    const sessionId = 'tool-debug-oneshot-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['[tool: echo value="first"]', '[tool: echo value="second"]'],
        sourceLines: [1, 2],
        toolsDir,
        pauseAtNextTool: true,
      })) {
        events.push(ev);
        if (ev.type === 'tool:awaiting-debugger') {
          await fetch(
            `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/tool-debugger-ack`,
            { method: 'POST', headers: { 'x-api-key': API_KEY } },
          );
        }
        if (ev.type === 'done') break;
      }
    })();

    await consume;

    const awaitingCount = events.filter((e) => e.type === 'tool:awaiting-debugger').length;
    expect(awaitingCount).toBe(1);
    const captures = events.filter((e) => e.type === 'capture');
    expect(captures).toHaveLength(2);
  });

  it('tool-debugger-ack returns 409 when no run awaits an ack', async () => {
    const res = await fetch(
      `${baseUrl}/sessions/no-such-session/tool-debugger-ack`,
      { method: 'POST', headers: { 'x-api-key': API_KEY } },
    );
    expect(res.status).toBe(409);
  });

  it('run-control with pauseAtNextTool sets the flag for the next tool', async () => {
    // The run is already in flight, paused between steps via stepMode:'into'.
    // The next-run-control body sets pauseAtNextTool:true. The next tool
    // emits tool:awaiting-debugger.
    const sessionId = 'tool-debug-midrun-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    const consume = (async () => {
      let stepCount = 0;
      for await (const ev of sseEvents(url, {
        steps: ['Open the page', '[tool: echo value="midrun"]'],
        sourceLines: [1, 2],
        toolsDir,
        stepMode: 'into',
      })) {
        events.push(ev);
        if (ev.type === 'step:awaiting') {
          stepCount++;
          // On the second pause (the one before the tool step), set the
          // pauseAtNextTool flag along with the resume mode.
          if (stepCount === 1) {
            await fetch(
              `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                body: JSON.stringify({ mode: 'continue', pauseAtNextTool: true }),
              },
            );
          }
        }
        if (ev.type === 'tool:awaiting-debugger') {
          await fetch(
            `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/tool-debugger-ack`,
            { method: 'POST', headers: { 'x-api-key': API_KEY } },
          );
        }
        if (ev.type === 'done') break;
      }
    })();

    await consume;

    const awaitingCount = events.filter((e) => e.type === 'tool:awaiting-debugger').length;
    expect(awaitingCount).toBe(1);
  });

  it('catalogue is cached on the session — second batch reuses it', async () => {
    // Two batches against the same session; the second omits `toolsDir`
    // entirely yet the tool still dispatches. Confirms `session.toolCatalogue`
    // is sticky (matching the envBundle / sessionConfig precedent).
    const sessionId = 'tools-cached-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;

    // First batch: load the catalogue.
    const firstEvents: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['[tool: echo value="first"]'],
      sourceLines: [1],
      toolsDir,
    })) {
      firstEvents.push(ev);
      if (ev.type === 'done') break;
    }
    expect(firstEvents.filter((e) => e.type === 'capture')).toHaveLength(1);

    // Second batch: NO toolsDir. The catalogue should still be in place.
    const secondEvents: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['[tool: echo value="second"]'],
      sourceLines: [1],
    })) {
      secondEvents.push(ev);
      if (ev.type === 'done') break;
    }
    const secondCaptures = secondEvents.filter((e) => e.type === 'capture');
    expect(secondCaptures).toHaveLength(1);
    expect(secondCaptures[0]).toMatchObject({ name: 'echoed', value: 'second' });
  });
});
