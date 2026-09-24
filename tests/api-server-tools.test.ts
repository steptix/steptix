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
    // Video recording: report 'off' so no recordVideo/finalize path runs under
    // the mock (the mocked BrowserSession has no real page.video()).
    // Real behaviour, not a stub: session-manager uses it to bound page reads
    // while listing, and a mock that resolved instantly would hide a hang.
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
  AiClient: class { chat = vi.fn(async () => '{}'); setAiPolicy = vi.fn(); syncAuth = vi.fn(() => null); },
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
  ApiResponseStore: class { store = vi.fn(); getHistory = vi.fn(() => []); },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
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
  signal?: AbortSignal,
): AsyncGenerator<{ type: string; [k: string]: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    ...(signal && { signal }),
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

    // The tool ran — capture event mirrored the setVar, tagged toolOutput.
    const captures = events.filter((e) => e.type === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      name: 'echoed',
      value: 'hello-from-tool',
      source: 'toolOutput',
    });

    // The step passed; aiExplanation mentions the tool name + outputs.
    const passes = events.filter((e) => e.type === 'step:pass');
    expect(passes).toHaveLength(1);
    expect(passes[0].output ?? '').toMatch(/Tool "echo" produced outputs/);

    const done = events.find((e) => e.type === 'done');
    expect(done?.status).toBe('passed');
  });

  it('non-streaming response tags a tool output as toolOutput in outputSources', async () => {
    // Same echo tool, but via the plain JSON route. The /steps response
    // must carry outputSources alongside outputs with the right provenance.
    const sessionId = 'tools-json-' + Date.now();
    const res = await fetch(
      `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          steps: ['[tool: echo value="json-tool"]'],
          sourceLines: [1],
          toolsDir,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outputs).toMatchObject({ echoed: 'json-tool' });
    expect(body.outputSources).toMatchObject({ echoed: 'toolOutput' });
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

  it('reloads the catalogue when toolsDir is corrected on a later batch (same session)', async () => {
    // Regression: a first batch with a missing/empty toolsDir caches an
    // empty catalogue on the session. Before the fix that empty catalogue
    // was reused for the session's whole life, so fixing the config and
    // hitting Continue / re-running on the SAME session kept failing with
    // "tool not found". The cache must invalidate when the toolsDir changes
    // (or the cached catalogue is empty) so the corrected dir is picked up
    // without a full session restart.
    const sessionId = 'tools-reload-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;

    // Batch 1: point at a directory that doesn't exist → empty catalogue,
    // the [tool: echo] step fails because the tool isn't registered.
    const missingDir = path.join(os.tmpdir(), 'tools-missing-' + Date.now());
    const firstEvents: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['[tool: echo value="v1"]'],
      sourceLines: [1],
      toolsDir: missingDir,
    })) {
      firstEvents.push(ev);
      if (ev.type === 'done') break;
    }
    expect(firstEvents.filter((e) => e.type === 'capture')).toHaveLength(0);
    expect(firstEvents.some((e) => e.type === 'step:fail')).toBe(true);

    // Batch 2: SAME session, corrected toolsDir → catalogue reloads and the
    // tool now runs to completion.
    const secondEvents: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['[tool: echo value="v2"]'],
      sourceLines: [1],
      toolsDir, // the real fixture dir
    })) {
      secondEvents.push(ev);
      if (ev.type === 'done') break;
    }
    const captures = secondEvents.filter((e) => e.type === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      name: 'echoed',
      value: 'v2',
      source: 'toolOutput',
    });
    expect(secondEvents.find((e) => e.type === 'done')?.status).toBe('passed');
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

  it('run-control 409 does NOT leave pauseAtNextTool stuck for the next batch', async () => {
    // Regression: previously the api-server set pauseAtNextTool on the
    // session BEFORE delivering the run-control. When run-control
    // returned 409 (no paused run), the flag stayed armed and the next
    // batch's first `[tool: ...]` step would unexpectedly hang. The
    // fix reorders to set-after-deliver. Verify by:
    //   1. POST a run-control with pauseAtNextTool against a fresh
    //      session that has no paused run — expect 409.
    //   2. Run a batch with a tool step (still using toolsDir but with
    //      NO pauseAtNextTool flag) — assert no `tool:awaiting-debugger`
    //      event fires and the tool runs to completion.
    const sessionId = 'no-leak-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;

    // Phase 1: speculative run-control on a fresh session. Should 409.
    const stuckRes = await fetch(
      `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ mode: 'continue', pauseAtNextTool: true }),
      },
    );
    expect(stuckRes.status).toBe(409);

    // Phase 2: real run with a tool step. If the flag had leaked, the
    // server would emit `tool:awaiting-debugger` and hang waiting for
    // an ack — the test would time out.
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['[tool: echo value="should-not-pause"]'],
      sourceLines: [1],
      toolsDir,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    const awaiting = events.filter((e) => e.type === 'tool:awaiting-debugger');
    expect(awaiting).toHaveLength(0);
    const captures = events.filter((e) => e.type === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ name: 'echoed', value: 'should-not-pause' });
  });

  it('abort while parked awaiting debugger ack unwinds cleanly without hitting debugger;', async () => {
    // When the user clicks Stop while the loop is parked on
    // pendingDebuggerAck, two things must happen:
    //   - The await resolves (so the loop can hit its abort check
    //     at the top of the next iteration).
    //   - executeToolStep is NOT called with pauseBeforeRun:true —
    //     otherwise we'd hit `debugger;` with no debugger attached
    //     (the user just cancelled).
    // Driving the abort here means cancelling the SSE fetch which
    // closes the underlying request. The server's res.on('close')
    // aborts the AbortController. The run reports 'aborted' on done.
    const sessionId = 'abort-park-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const ac = new AbortController();
    const events: any[] = [];
    let aborted = false;

    const consume = (async () => {
      try {
        for await (const ev of sseEvents(url, {
          steps: ['[tool: echo value="aborted"]'],
          sourceLines: [1],
          toolsDir,
          pauseAtNextTool: true,
        }, ac.signal)) {
          events.push(ev);
          if (ev.type === 'tool:awaiting-debugger') {
            // Don't send the ack — abort instead.
            ac.abort();
          }
          if (ev.type === 'done') break;
        }
      } catch (err: any) {
        // Aborting the fetch throws — that's the intended path.
        if (err?.name === 'AbortError' || err?.code === 20) {
          aborted = true;
        } else {
          throw err;
        }
      }
    })();

    await consume;

    // We saw the awaiting event before aborting.
    expect(events.some((e) => e.type === 'tool:awaiting-debugger')).toBe(true);
    // And NO capture event fired — the tool body never ran. (If it
    // had, `debugger;` would still be a no-op because no inspector
    // is attached; but the contract is "don't reach `debugger;` when
    // we know the ack didn't come from a real attach.")
    expect(events.filter((e) => e.type === 'capture')).toHaveLength(0);
    expect(aborted).toBe(true);
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

  // ── Hot-reload across batches on the same session (issue 033) ──────────────
  // The server loads the catalogue with { reload: true }, so an edited tool
  // file is re-imported and a newly-added file is re-indexed on the next batch
  // — no session restart. These drive it through the real HTTP route.

  const defineToolImport = path
    .resolve(__dirname, '..', 'src', 'tools', 'index.ts')
    .replace(/\\/g, '/');

  /** A parameterless tool named `name` whose single `name` output is `value`. */
  function namedTool(name: string, value: string): string {
    return `import { defineTool } from '${defineToolImport}';
export default defineTool({
  name: '${name}', description: '${name}', parameters: {}, outputs: { ${name}: { type: 'string' } },
  async run(_args, ctx) { ctx.step.setVar('${name}', ${JSON.stringify(value)}); },
});
`;
  }

  async function runMarkBatch(sessionId: string, dir: string, ref: string): Promise<any[]> {
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: [`[tool: ${ref}]`],
      sourceLines: [1],
      toolsDir: dir,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    return events;
  }

  it('re-imports an EDITED tool file on a later batch, same session (no restart)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-edit-'));
    try {
      await fs.writeFile(path.join(dir, 'mark.ts'), namedTool('mark', 'V1'));
      const sessionId = 'tools-edit-' + Date.now();

      const first = await runMarkBatch(sessionId, dir, 'mark');
      expect(first.filter((e) => e.type === 'capture')).toEqual([
        expect.objectContaining({ name: 'mark', value: 'V1' }),
      ]);

      // Edit the tool on disk, then re-run on the SAME session.
      await fs.writeFile(path.join(dir, 'mark.ts'), namedTool('mark', 'V2'));
      const second = await runMarkBatch(sessionId, dir, 'mark');
      expect(second.filter((e) => e.type === 'capture')).toEqual([
        expect.objectContaining({ name: 'mark', value: 'V2' }),
      ]);
      expect(second.find((e) => e.type === 'done')?.status).toBe('passed');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('discovers a tool file ADDED mid-session on a later batch, same session', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-add-'));
    try {
      await fs.writeFile(path.join(dir, 'first.ts'), namedTool('first', 'first'));
      const sessionId = 'tools-add-' + Date.now();

      // Batch 1 establishes the cached catalogue (one indexed file).
      const first = await runMarkBatch(sessionId, dir, 'first');
      expect(first.find((e) => e.type === 'done')?.status).toBe('passed');

      // Add a brand-new tool file, then reference it on the SAME session.
      await fs.writeFile(path.join(dir, 'late.ts'), namedTool('late', 'late'));
      const second = await runMarkBatch(sessionId, dir, 'late');
      expect(second.filter((e) => e.type === 'capture')).toEqual([
        expect.objectContaining({ name: 'late', value: 'late' }),
      ]);
      expect(second.find((e) => e.type === 'done')?.status).toBe('passed');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
