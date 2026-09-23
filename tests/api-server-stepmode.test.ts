/**
 * End-to-end test for the step-into wire protocol over HTTP:
 *
 *  - `POST /sessions/:id/steps` with `skillsDir` + `testFilePath`
 *    triggers server-side skill expansion and emits frame:push / frame:pop
 *    events around the skill body. (Catches the Phase 1 wiring gap where
 *    the api-server's field validator was dropping these.)
 *  - `stepMode: 'into'` on the request body pauses the run after every
 *    step, emitting `step:awaiting` events the client can resume from.
 *  - `POST /sessions/:id/run-control { mode }` resolves the paused run
 *    and the SSE stream continues with the next step.
 *  - `runControl` returns 409 when no run is paused.
 *
 * The browser / AI / step-executor are mocked the same way `api-server.test.ts`
 * mocks them; the skill expander and the api-server's request handling
 * are exercised for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ── Mocks (mirror api-server.test.ts) ────────────────────────────────

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

const API_KEY = 'sk-stepmode-test';
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
let skillsDir: string;
let testFilePath: string;
let sessionManager: import('../src/server/session-manager.js').SessionManager;

beforeAll(async () => {
  const created = createApiServer(cfg);
  const { app } = created;
  sessionManager = created.sessionManager;
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // Fixture skill + test file in a temp dir.
  skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stepmode-skills-'));
  await fs.writeFile(
    path.join(skillsDir, 'demo_skill.md'),
    `---
type: skill
---
# demo_skill

## Steps
1. First skill step
2. Second skill step
`,
  );
  // A second skill that declares a parameter — needed for the
  // scope-shows-inputs regression test. The expander INLINES the
  // value into the step text at expansion time, so without the
  // frameInputs side-channel the value would never appear in the
  // runtime scope.
  await fs.writeFile(
    path.join(skillsDir, 'parameterized_skill.md'),
    `---
type: skill
---
# parameterized_skill

## Parameters
- query: the search term

## Steps
1. First step using {{query}}
2. Second step also using {{query}}
`,
  );
  // Nested-skill fixtures for the call-stack / output-flow tests.
  // outer takes `outer_arg`, declares output `outer_result`. Its body
  // calls inner and captures inner's `inner_result`, then stores its
  // own value into outer_result.
  await fs.writeFile(
    path.join(skillsDir, 'outer_skill.md'),
    `---
type: skill
---
# outer_skill

## Parameters
- outer_arg: caller-supplied outer value

## Outputs
- outer_result: the value outer exposes back to its caller

## Steps
1. [skill: inner_skill inner_arg="INNER_PASSED" out.inner_result="captured_from_inner"]
2. [output: outer_result] Determine outer's final value
`,
  );
  await fs.writeFile(
    path.join(skillsDir, 'inner_skill.md'),
    `---
type: skill
---
# inner_skill

## Parameters
- inner_arg: caller-supplied inner value

## Outputs
- inner_result: the value inner exposes back to its caller

## Steps
1. First inner step using {{inner_arg}}
2. [output: inner_result] Inner produces a value
`,
  );
  // A skill called twice in the same test — used for the per-instance
  // input-isolation regression test. Same skill file; different
  // caller args on each invocation.
  await fs.writeFile(
    path.join(skillsDir, 'reentrant_skill.md'),
    `---
type: skill
---
# reentrant_skill

## Parameters
- token: caller-supplied token

## Steps
1. Use {{token}} in step one
2. Use {{token}} in step two
`,
  );
  testFilePath = path.join(skillsDir, 'fake-test.md');
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => err ? e(err) : r()));
  await fs.rm(skillsDir, { recursive: true, force: true });
});

/** Open an SSE stream and yield parsed events as they arrive. */
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
        // ignore non-JSON (keep-alive comments etc.)
      }
    }
  }
}

async function runControl(sessionId: string, mode: string): Promise<number> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ mode }),
  });
  return res.status;
}

describe('api-server step-into protocol', () => {
  it('skillsDir triggers expansion and emits frame:push/frame:pop around the skill body', async () => {
    const sessionId = 'frame-events-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['Open the page', '[skill: demo_skill]', 'Verify result'],
      sourceLines: [1, 2, 3],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    const types = events.map((e) => e.type);
    // Frame events must surround the skill body.
    const pushIdx = types.indexOf('frame:push');
    const popIdx = types.indexOf('frame:pop');
    expect(pushIdx).toBeGreaterThan(-1);
    expect(popIdx).toBeGreaterThan(pushIdx);

    // Step events inside the skill body must carry the frame payload.
    const insideFrame = events.filter(
      (e, i) => i > pushIdx && i < popIdx && e.type === 'step:start',
    );
    expect(insideFrame.length).toBeGreaterThan(0);
    for (const ev of insideFrame) {
      expect(ev.frame).toBeDefined();
      expect(ev.frame.skillName).toBe('demo_skill');
    }

    // Top-level skill frame MUST carry its invocation line on the
    // wire — the client uses `frame.line` to paint pass/running on
    // the test file's `[skill: ...]` step row. A regression that
    // dropped the sourceLines thread-through left `line: 0`, which
    // silently no-ops the client paint (it checks `line > 0`), so
    // the row stayed blank even on a successful run.
    const push = events[pushIdx];
    expect(push.frame.parentId).toBeNull();
    expect(push.frame.line).toBe(2); // sourceLines[1] = 2 (the [skill:] line)
  });

  it('report StepResults use ordinal indexes and carry sourceSkill (parity with CLI runner)', async () => {
    // The server emits step:* events keyed by source line so the client
    // gutter can paint accurately. But the HTML report needs different
    // identity — ordinal indexes ("Step 1, 2, 3…") and per-step
    // sourceSkill chips, matching what the CLI's test-runner produces.
    // This test asserts the session-manager re-stamps both before
    // pushing into the report's StepResults array.
    const { generateReport } = await import('../src/report/generator.js');
    const reportMock = vi.mocked(generateReport);
    reportMock.mockClear();

    const sessionId = 'report-parity-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    for await (const ev of sseEvents(url, {
      // Test layout: inline → skill expansion (multiple body steps) → inline.
      // The skill is `demo_skill`, defined in this test file's skillsDir.
      steps: ['Open the page', '[skill: demo_skill]', 'Verify result'],
      sourceLines: [10, 20, 30],
      skillsDir,
      testFilePath,
    })) {
      if (ev.type === 'done') break;
    }

    expect(reportMock).toHaveBeenCalledOnce();
    const report = reportMock.mock.calls[0]![0];
    const steps = report.steps;

    // Index sequencing: ordinal 1, 2, 3, … regardless of where the
    // steps came from (test vs skill body) or what their source lines
    // are. Pre-fix this was effectiveSourceLines values like 10, <skill
    // body lines>, 30 — leaking the skill-file line numbers into the
    // report header.
    expect(steps.map((s: { index: number }) => s.index)).toEqual(
      steps.map((_: unknown, i: number) => i + 1),
    );

    // sourceSkill: present on the skill-body steps, absent on the
    // inline top-level steps. CLI's test-runner.ts threads
    // `test.sourceSkills[i]` into result.sourceSkill at the same point.
    const sourceSkills = steps.map(
      (s: { sourceSkill?: string }) => s.sourceSkill ?? null,
    );
    // First and last steps are inline (no chip); the middle steps come
    // from demo_skill expansion (chip = 'demo_skill').
    expect(sourceSkills[0]).toBeNull();
    expect(sourceSkills[sourceSkills.length - 1]).toBeNull();
    const middleSkills = sourceSkills.slice(1, -1);
    expect(middleSkills.length).toBeGreaterThan(0);
    for (const name of middleSkills) {
      expect(name).toBe('demo_skill');
    }
  });

  it('edits to a skill file between requests are picked up — skill cache is invalidated per /steps call', async () => {
    // Regression: the module-level skill cache in src/skills/expander.ts is
    // keyed by `filePath::envName` with no mtime invalidation. The Electron
    // UI runner clears the cache at run-start; the API server (which
    // testbench-native talks to) did not. Result: editing a skill file
    // during a paused run was masked by the stale parse until the server
    // restarted.
    //
    // The fix: executeSteps() calls clearSkillCache() at the top of every
    // request. This test exercises that wiring end-to-end.
    const { executeStep } = await import('../src/runner/step-executor.js');
    const exec = vi.mocked(executeStep);
    const defaultImpl = exec.getMockImplementation();

    const skillName = 'edit_pickup';
    const skillPath = path.join(skillsDir, `${skillName}.md`);
    await fs.writeFile(
      skillPath,
      `---
type: skill
---
# ${skillName}

## Steps
1. ORIGINAL skill body line
`,
    );

    const capturedInstructions: string[] = [];
    exec.mockImplementation(async (_idx, _total, instr: string) => {
      capturedInstructions.push(instr);
      return {
        index: 1, instruction: instr, status: 'passed',
        turns: [], durationMs: 5, retried: false, aiExplanation: 'ok',
      };
    });

    // Batch 1 — should run the ORIGINAL body.
    const sessionId = 'skill-cache-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    for await (const ev of sseEvents(url, {
      steps: [`[skill: ${skillName}]`],
      sourceLines: [1],
      skillsDir,
      testFilePath,
    })) {
      if (ev.type === 'done') break;
    }
    const firstBatch = [...capturedInstructions];
    expect(firstBatch.some((i) => i.includes('ORIGINAL'))).toBe(true);

    // Edit the skill on disk — same path, new body.
    capturedInstructions.length = 0;
    await fs.writeFile(
      skillPath,
      `---
type: skill
---
# ${skillName}

## Steps
1. UPDATED skill body line
`,
    );

    // Batch 2 — without the cache clear, would still execute the ORIGINAL
    // line because expander's module-level Map still holds the first parse.
    for await (const ev of sseEvents(url, {
      steps: [`[skill: ${skillName}]`],
      sourceLines: [1],
      skillsDir,
      testFilePath,
    })) {
      if (ev.type === 'done') break;
    }
    const secondBatch = [...capturedInstructions];

    expect(secondBatch.some((i) => i.includes('UPDATED'))).toBe(true);
    expect(secondBatch.some((i) => i.includes('ORIGINAL'))).toBe(false);

    exec.mockReset();
    if (defaultImpl) exec.mockImplementation(defaultImpl);
    await fs.rm(skillPath);
  });

  describe('step cache wiring', () => {
    // The api-server-stepmode test infrastructure puts its skillsDir at
    // `os.tmpdir()/stepmode-skills-XXXX`, NOT inside a real project. For
    // cache tests we need a directory tree the project-root resolver can
    // find an aiui.config marker in, so we set one up per-test.
    let cacheRoot: string;
    let cacheTestFile: string;

    beforeEach(async () => {
      cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stepmode-cache-'));
      await fs.writeFile(path.join(cacheRoot, 'aiui.config.json'), '{}\n');
      cacheTestFile = path.join(cacheRoot, 'test.md');
      await fs.writeFile(cacheTestFile, '# test\n');
    });

    afterEach(async () => {
      await fs.rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
    });

    it('wires stepCache into executeStep when cacheEnabled is true and testFilePath resolves a project root', async () => {
      // The simplest wiring assertion: when `cacheEnabled: true` is sent AND a
      // testFilePath is supplied AND a project marker (aiui.config.json) exists
      // above it, executeStep receives a non-undefined `stepCache` with
      // `cacheEnabled: true`. Caching is opt-in, so the flag must be explicit.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      let observedOpts: any;
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        observedOpts = opts;
        return {
          index: idx, instruction: instr, status: 'passed',
          turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
        };
      });

      const sessionId = 'cache-wiring-' + Date.now();
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
      for await (const ev of sseEvents(url, {
        steps: ['just one step'],
        sourceLines: [1],
        testFilePath: cacheTestFile,
        cacheEnabled: true,
      })) {
        if (ev.type === 'done') break;
      }

      expect(observedOpts).toBeDefined();
      expect(observedOpts.stepCache).toBeDefined();
      expect(observedOpts.cacheEnabled).toBe(true);

      exec.mockReset();
      if (defaultImpl) exec.mockImplementation(defaultImpl);
    });

    it('cacheEnabled: false on the request disables cache wiring even with testFilePath', async () => {
      // Opt-out should propagate. Useful for "debug this run, ignore the
      // cache entirely" workflows.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      let observedOpts: any;
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        observedOpts = opts;
        return {
          index: idx, instruction: instr, status: 'passed',
          turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
        };
      });

      const sessionId = 'cache-disable-' + Date.now();
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
      for await (const ev of sseEvents(url, {
        steps: ['just one step'],
        sourceLines: [1],
        testFilePath: cacheTestFile,
        cacheEnabled: false,
      })) {
        if (ev.type === 'done') break;
      }

      expect(observedOpts.cacheEnabled).toBe(false);

      exec.mockReset();
      if (defaultImpl) exec.mockImplementation(defaultImpl);
    });

    it('a strict run refuses before its first step when the code-behind file does not load', async () => {
      // A compile's replay runs strict: its question is whether the code works
      // on its own. A file that never loaded has no code, so the answer is a
      // failure before any step — not "passed" under AI, which is what a
      // project without node_modules got live. Strict is an in-process knob,
      // so this drives the manager directly.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();
      exec.mockImplementation(async (idx, _total, instr) => ({
        index: idx, instruction: instr, status: 'passed',
        turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
      }));
      const stepsFile = cacheTestFile.replace(/.md$/, '.steps.ts');
      await fs.writeFile(
        stepsFile,
        [
          "import { defineSteps } from 'ai-ui-automation/codebehind';",
          "export default defineSteps([{ source: 'just one step', async run() { const x = ; } }]);",
          '',
        ].join('\n'),
      );
      try {
        const events: any[] = [];
        const response = await sessionManager.executeSteps(
          'strict-load-' + Date.now(),
          { steps: ['just one step'], sourceLines: [1], testFilePath: cacheTestFile },
          (e) => events.push(e),
          undefined,
          { codeBehind: { strict: true } },
        );
        expect(response.status).toBe('failed');
        expect(response.error?.message).toContain('could not be loaded');
        expect(response.error?.message).toContain('test.steps.ts');
        expect(events.some((e) => e.type === 'output' && e.kind === 'error' && e.msg.includes('could not be loaded'))).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
        expect(exec).not.toHaveBeenCalled();
      } finally {
        await fs.rm(stepsFile, { force: true });
        exec.mockReset();
        if (defaultImpl) exec.mockImplementation(defaultImpl);
      }
    });

    it('captureStepContext on the request reaches the step, and its absence leaves it off', async () => {
      // The step route's request builder is a per-field allow-list, so a field
      // the TYPE admits can still vanish at runtime. `captureStepContext` is
      // what makes an ordinary run a recording `POST /codebehind/compile` can
      // use (stories/codebehind-compile-as-a-run.md), and a dropped flag here
      // would mean every compile records the test again, silently.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      const observed: any[] = [];
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        observed.push(opts);
        return {
          index: idx, instruction: instr, status: 'passed',
          turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
        };
      });

      for (const captureStepContext of [true, undefined]) {
        const sessionId = `capture-context-${captureStepContext}-` + Date.now();
        const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
        for await (const ev of sseEvents(url, {
          steps: ['just one step'],
          sourceLines: [1],
          testFilePath: cacheTestFile,
          ...(captureStepContext !== undefined && { captureStepContext }),
        })) {
          if (ev.type === 'done') break;
        }
      }

      expect(observed).toHaveLength(2);
      expect(observed[0].captureStepContext).toBe(true);
      expect(observed[1].captureStepContext).toBeUndefined();

      // The run that asked to capture left its recording beside the test
      // (stories/codebehind-recording-on-disk.md); the server keeps none of it.
      const { recordingDirFor } = await import('../src/codebehind/recording.js');
      const manifest = JSON.parse(
        await fs.readFile(path.join(recordingDirFor(cacheTestFile), 'recording.json'), 'utf-8'),
      );
      expect(manifest).toMatchObject({ status: 'passed', steps: 1, source: 'server' });

      exec.mockReset();
      if (defaultImpl) exec.mockImplementation(defaultImpl);
    });

    it('hands the step the env/data context a code-behind entry reads ${data.url} through, and redacts its secrets from the recording', async () => {
      // The context is assembled on the server from the request's `envName`
      // and the project's files (stories/codebehind-env-data.md). It has to
      // reach `executeStep` as `envData` for `step.getVar('data.url')` to
      // answer — and the step text the executor gets is the interpolated one,
      // which is the same context doing the same job one layer up.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      await fs.writeFile(
        path.join(cacheRoot, '.env.uat'),
        ['GITHUB_USERNAME=octocat', 'GITHUB_PASSWORD=hunter2-uat-secret', ''].join('\n'),
      );
      await fs.mkdir(path.join(cacheRoot, 'data'), { recursive: true });
      await fs.writeFile(
        path.join(cacheRoot, 'data', 'uat.json'),
        JSON.stringify({ url: 'https://uat.example/', users: { admin: { password: '$GITHUB_PASSWORD' } } }),
      );

      let observedOpts: any;
      let observedInstruction: string | undefined;
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        observedOpts = opts;
        observedInstruction = instr;
        return {
          index: idx, instruction: instr, status: 'passed',
          turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
          stepContext: {
            domBefore: '<input value="hunter2-uat-secret">',
            urlBefore: 'about:blank',
            domAfter: '<p>signed in as octocat</p>',
            urlAfter: 'https://uat.example/',
          },
        };
      });

      try {
        const sessionId = 'env-data-context-' + Date.now();
        const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
        for await (const ev of sseEvents(url, {
          steps: ['Navigate to ${data.url}'],
          sourceLines: [1],
          testFilePath: cacheTestFile,
          envName: 'uat',
          captureStepContext: true,
        })) {
          if (ev.type === 'done') break;
        }

        expect(observedInstruction).toBe('Navigate to https://uat.example/');
        expect(observedOpts.envData).toBeDefined();
        expect(observedOpts.envData.envName).toBe('uat');
        expect(observedOpts.envData.data.url).toBe('https://uat.example/');
        expect(observedOpts.envData.env.GITHUB_USERNAME).toBe('octocat');
        // The `$VAR` leaf in the data file resolved against the same env.
        expect(observedOpts.envData.data.users.admin.password).toBe('hunter2-uat-secret');

        // The recording beside the test carries neither the env var's value
        // nor the data leaf's — same value here, secret by both names.
        const { recordingDirFor } = await import('../src/codebehind/recording.js');
        const before = await fs.readFile(path.join(recordingDirFor(cacheTestFile), 'step-01.before.html'), 'utf-8');
        const after = await fs.readFile(path.join(recordingDirFor(cacheTestFile), 'step-01.after.html'), 'utf-8');
        expect(before).toBe('<input value="***">');
        expect(after).toBe('<p>signed in as octocat</p>');
      } finally {
        exec.mockReset();
        if (defaultImpl) exec.mockImplementation(defaultImpl);
      }
    });

    it('hands the step no context when the request names no environment', async () => {
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();
      let observedOpts: any;
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        observedOpts = opts;
        return { index: idx, instruction: instr, status: 'passed', turns: [], durationMs: 1, retried: false, aiExplanation: 'ok' };
      });
      try {
        const sessionId = 'env-data-none-' + Date.now();
        const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
        for await (const ev of sseEvents(url, { steps: ['just one step'], sourceLines: [1], testFilePath: cacheTestFile })) {
          if (ev.type === 'done') break;
        }
        expect(observedOpts.envData).toBeUndefined();
      } finally {
        exec.mockReset();
        if (defaultImpl) exec.mockImplementation(defaultImpl);
      }
    });

    it('absent cacheEnabled with testFilePath leaves the cache OFF (opt-in default)', async () => {
      // Caching is opt-in: a request that says nothing about caching gets
      // none, even with a resolvable testFilePath. This is the default that
      // testbench-native relies on until it explicitly opts a run in.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      let observedOpts: any;
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        observedOpts = opts;
        return {
          index: idx, instruction: instr, status: 'passed',
          turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
        };
      });

      const sessionId = 'cache-default-off-' + Date.now();
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
      for await (const ev of sseEvents(url, {
        steps: ['just one step'],
        sourceLines: [1],
        testFilePath: cacheTestFile,
      })) {
        if (ev.type === 'done') break;
      }

      expect(observedOpts.stepCache).toBeUndefined();
      expect(observedOpts.cacheEnabled).toBe(false);

      exec.mockReset();
      if (defaultImpl) exec.mockImplementation(defaultImpl);
    });

    it('no testFilePath: cache wiring is silently disabled (no errors)', async () => {
      // Sanity: requests without testFilePath (legacy clients, headless
      // callers) skip cache initialization without exploding.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      let observedOpts: any;
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        observedOpts = opts;
        return {
          index: idx, instruction: instr, status: 'passed',
          turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
        };
      });

      const sessionId = 'cache-no-testfile-' + Date.now();
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
      let sawError = false;
      for await (const ev of sseEvents(url, {
        steps: ['just one step'],
        sourceLines: [1],
      })) {
        if (ev.type === 'output' && ev.kind === 'error') sawError = true;
        if (ev.type === 'done') break;
      }

      expect(sawError).toBe(false);
      expect(observedOpts.stepCache).toBeUndefined();
      expect(observedOpts.cacheEnabled).toBe(false);

      exec.mockReset();
      if (defaultImpl) exec.mockImplementation(defaultImpl);
    });

    it('step:pass events carry fromCache: true when executeStep returns fromCache', async () => {
      // The wire format: step:pass event must carry through the fromCache
      // flag from StepResult so the client can paint the ⚡ glyph and log
      // the (cached) marker. Mocks executeStep to return fromCache: true.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      exec.mockImplementation(async (idx, _total, instr) => ({
        index: idx, instruction: instr, status: 'passed',
        turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
        fromCache: true,
      }));

      const sessionId = 'cache-fromcache-' + Date.now();
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
      const passEvents: any[] = [];
      for await (const ev of sseEvents(url, {
        steps: ['Step A', 'Step B'],
        sourceLines: [1, 2],
        testFilePath: cacheTestFile,
      })) {
        if (ev.type === 'step:pass') passEvents.push(ev);
        if (ev.type === 'done') break;
      }

      expect(passEvents.length).toBe(2);
      for (const ev of passEvents) {
        expect(ev.fromCache).toBe(true);
      }

      exec.mockReset();
      if (defaultImpl) exec.mockImplementation(defaultImpl);
    });

    it('fullSteps stabilises the cache hash across batched runs (same hash, different batch slices)', async () => {
      // The breakpoint batch-split case. Without fullSteps, batch 1 hashes
      // [stepA, stepB] and batch 2 hashes [stepC, stepD] — different hash
      // dirs, no cache hit possible. With fullSteps = [stepA, stepB,
      // stepC, stepD] on both, the hash dirs match and a second run can
      // hit cache entries written by the first.
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();

      const cacheRoots: string[] = [];
      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        // Capture the cache directory each call sees so we can compare
        // namespaces across the two batches.
        if (opts?.stepCache) {
          cacheRoots.push((opts.stepCache as any).cacheDir);
        }
        return {
          index: idx, instruction: instr, status: 'passed',
          turns: [], durationMs: 1, retried: false, aiExplanation: 'ok',
        };
      });

      const sessionId = 'cache-fullsteps-' + Date.now();
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
      // Batch 1 — first half of the run.
      for await (const ev of sseEvents(url, {
        steps: ['stepA', 'stepB'],
        sourceLines: [1, 2],
        fullSteps: ['stepA', 'stepB', 'stepC', 'stepD'],
        testFilePath: cacheTestFile,
        cacheEnabled: true,
      })) {
        if (ev.type === 'done') break;
      }
      // Batch 2 — second half of the same logical run.
      for await (const ev of sseEvents(url, {
        steps: ['stepC', 'stepD'],
        sourceLines: [3, 4],
        fullSteps: ['stepA', 'stepB', 'stepC', 'stepD'],
        testFilePath: cacheTestFile,
        cacheEnabled: true,
      })) {
        if (ev.type === 'done') break;
      }

      // Every call should have seen the same cache directory — proves
      // the bundle hash is stable across batches.
      expect(cacheRoots.length).toBe(4);
      const unique = new Set(cacheRoots);
      expect(unique.size).toBe(1);

      exec.mockReset();
      if (defaultImpl) exec.mockImplementation(defaultImpl);
    });
  });

  it('stepMode=into pauses after every step and emits step:awaiting', async () => {
    const sessionId = 'stepmode-into-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    // Drive the SSE stream in parallel with run-control POSTs. Each
    // step:awaiting → POST 'into' → next step:pass → next step:awaiting.
    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['Step one', 'Step two', 'Step three'],
        sourceLines: [1, 2, 3],
        stepMode: 'into',
      })) {
        events.push(ev);
        if (ev.type === 'step:awaiting') {
          // Resume by sending another 'into' until done.
          await runControl(sessionId, 'into');
        }
        if (ev.type === 'done') break;
      }
    })();

    await consume;

    const awaitingCount = events.filter((e) => e.type === 'step:awaiting').length;
    const passCount = events.filter((e) => e.type === 'step:pass').length;
    // 3 steps → 3 step:pass, 2 pauses between them (no pause after the last).
    expect(passCount).toBe(3);
    expect(awaitingCount).toBe(2);
  });

  it('run-control returns 409 when no run is paused', async () => {
    const status = await runControl('no-such-session-' + Date.now(), 'into');
    expect(status).toBe(409);
  });

  it('run-control rejects unknown modes with 400', async () => {
    const res = await fetch(`${baseUrl}/sessions/whatever/run-control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ mode: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  it('stepMode=continue runs straight through without pausing', async () => {
    const sessionId = 'stepmode-continue-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['Step one', 'Step two'],
      sourceLines: [1, 2],
      stepMode: 'continue',
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    const awaitingCount = events.filter((e) => e.type === 'step:awaiting').length;
    expect(awaitingCount).toBe(0);
  });

  it('emits frame:scope after every step:pass carrying resolvedParameters', async () => {
    // Phase 4.6 — the server snapshots the variable scope after every
    // step so the Variables view stays current. With no [output: ...]
    // captures and no parameters in the request, the scope is empty,
    // but the event itself MUST fire — its presence is what drives the
    // panel's per-step refresh.
    const sessionId = 'frame-scope-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['Step one', 'Step two'],
      sourceLines: [1, 2],
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    const scopes = events.filter((e) => e.type === 'frame:scope');
    const passes = events.filter((e) => e.type === 'step:pass');
    expect(passes.length).toBe(2);
    // 3 frame:scope events: 1 initial (at run start, so a paused-at-step-1
    // breakpoint can see scope), then 1 after each step:pass.
    expect(scopes.length).toBe(3);
    for (const ev of scopes) {
      expect(ev.frameId).toBe('');
      expect(typeof ev.scope).toBe('object');
    }
  });

  it('frame:scope carries request parameters back to the client', async () => {
    // Variables view's first use case: parameters declared in the
    // request body show up as initial scope entries. Sanity check that
    // the round-trip works.
    const sessionId = 'frame-scope-params-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      steps: ['Step one'],
      sourceLines: [1],
      parameters: { username: 'alice', token: 'sk-supersecret' },
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    const scope = events.find((e) => e.type === 'frame:scope')?.scope;
    expect(scope).toBeDefined();
    expect(scope.username).toBe('alice');
    // Note: server emits the raw value; secret masking happens client-
    // side via runner-core's maskIfSecret. So `token` is present here
    // unmasked.
    expect(scope.token).toBe('sk-supersecret');
  });

  it('stepMode=over skips a [skill: ...] body atomically', async () => {
    // Phase 3.1.e — covers the "Step Over a skill" end-to-end path that
    // wasn't exercised in Phase 3. Three inline steps with the middle
    // one being [skill: demo_skill] which expands to 2 body steps. With
    // mode='over' the server should pause AFTER step 1 (next is the
    // first skill body at depth 1 → don't pause yet... actually that's
    // 'over' = pause when nextDepth ≤ curDepth, and curDepth here is 0
    // so the SKILL body executes atomically. The next pause is when
    // we're back to depth 0 — i.e., after the skill body finishes.
    const sessionId = 'stepmode-over-skill-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['Open the page', '[skill: demo_skill]', 'Verify result'],
        sourceLines: [1, 2, 3],
        skillsDir,
        testFilePath,
        stepMode: 'over',
      })) {
        events.push(ev);
        if (ev.type === 'step:awaiting') {
          await runControl(sessionId, 'over');
        }
        if (ev.type === 'done') break;
      }
    })();
    await consume;

    // Three step:awaiting pauses total: one after step 1 (about to enter
    // skill), one after the skill body completes (about to run step 3),
    // and none after step 3 (last step). Wait — let's compute carefully:
    //
    //   step 1 (depth 0, inline): pass. nextDepth = 1 (skill body).
    //     'over': 1 > 0 → DON'T pause.
    //   step 2 (skill body #1, depth 1): pass. nextDepth = 1.
    //     'over': 1 ≤ 1 → PAUSE. ⚠ This pauses INSIDE the skill body —
    //     because once the user IS at depth 1, 'over' is interpreted in
    //     the now-deeper frame. That's debugger-correct: 'over' steps
    //     one statement of the current frame.
    //
    // So the user would hit pause inside the skill body. Subsequent
    // 'over' commands step through the rest of the skill body, then
    // back to depth 0. Total step:awaiting: depends on number of
    // skill-body steps. demo_skill has 2 body steps, so 1 pause inside
    // (between body steps), 1 pause back at depth 0 (before step 3).
    const awaitingCount = events.filter((e) => e.type === 'step:awaiting').length;
    expect(awaitingCount).toBeGreaterThan(0);

    // The frame:push / frame:pop pair MUST surround the skill body in
    // the trace, regardless of how step:awaitings interleave.
    const types = events.map((e) => e.type);
    expect(types.indexOf('frame:push')).toBeGreaterThan(-1);
    expect(types.indexOf('frame:pop')).toBeGreaterThan(types.indexOf('frame:push'));

    // Total step:pass count: 1 (step 1 inline) + 2 (skill body) + 1
    // (step 3 inline) = 4. The skill INVOCATION line (step 2) doesn't
    // emit its own step:pass because expansion replaces it with the
    // skill's body — the invocation line is folded away.
    const passCount = events.filter((e) => e.type === 'step:pass').length;
    expect(passCount).toBe(4);

    // The done event should report passed status.
    const done = events.find((e) => e.type === 'done');
    expect(done?.status).toBe('passed');
  });

  // ─────────────────────────────────────────────────────────────────
  // Server-side breakpoints (skill-file breakpoint support).
  //
  // Pre-fix: a breakpoint set inside a skill `.md` was completely
  // ignored — the extension's client-side `trimAtBreakpoint` only
  // looked at the TEST file's breakpoints, and skill expansion is
  // server-side so the skill body steps weren't in the pre-expansion
  // step list. The fix moves breakpoint checking to the server for
  // non-test-file URIs.
  // ─────────────────────────────────────────────────────────────────

  it('frame:scope fires immediately after frame:push (scope visible at skill entry)', async () => {
    // Bug fix: when paused at a breakpoint on the FIRST step of a
    // skill, the Variables view was empty because frame:scope only
    // fired after step:pass/fail. Now frame:scope is emitted right
    // after frame:push so the entry-time scope (including the input
    // parameters the expander injected) is observable from the
    // moment the descent begins.
    const sessionId = 'scope-on-push-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: ['[skill: demo_skill]'],
      sourceLines: [1],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    // Find the first frame:push and the first frame:scope that follows
    // it carrying that frame's id. The scope event MUST come BEFORE
    // any step:pass inside the skill body — that's the contract.
    const pushIdx = events.findIndex((e) => e.type === 'frame:push');
    expect(pushIdx).toBeGreaterThan(-1);
    const pushedFrameId = events[pushIdx].frame.id;

    const firstSkillPassIdx = events.findIndex(
      (e, i) => i > pushIdx && e.type === 'step:pass',
    );
    const skillScopeIdx = events.findIndex(
      (e, i) =>
        i > pushIdx &&
        e.type === 'frame:scope' &&
        e.frameId === pushedFrameId,
    );
    expect(skillScopeIdx).toBeGreaterThan(-1);
    expect(skillScopeIdx).toBeLessThan(firstSkillPassIdx);
    // And it must follow IMMEDIATELY after push (no other events
    // between — the entry-time snapshot is the contract).
    expect(skillScopeIdx).toBe(pushIdx + 1);
  });

  it('skill input parameters are visible in the frame:scope on entry (and stay visible across steps)', async () => {
    // The bug this fixes: the expander INLINES the caller's parameter
    // values directly into the skill body's step text at expansion
    // time. They never reach `resolvedParameters`, so a debugger pause
    // inside the skill saw an empty Variables view — "the param
    // doesn't look like it's being passed in." Fix: the expander
    // records `call.args` on the `ExpandedFrame.inputs` field; the
    // server merges that into the `frame:scope` payload on entry AND
    // on every subsequent step:pass / step:fail emit inside the
    // frame, so the param stays visible for the whole frame lifetime.
    const sessionId = 'skill-inputs-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: ['[skill: parameterized_skill query="OpenAI GPT-5"]'],
      sourceLines: [1],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    // The frame:scope event emitted right after the skill's
    // frame:push MUST contain query="OpenAI GPT-5".
    const pushIdx = events.findIndex((e) => e.type === 'frame:push');
    expect(pushIdx).toBeGreaterThan(-1);
    const pushedFrameId = events[pushIdx].frame.id;
    const entryScope = events[pushIdx + 1];
    expect(entryScope?.type).toBe('frame:scope');
    expect(entryScope?.frameId).toBe(pushedFrameId);
    expect(entryScope?.scope?.query).toBe('OpenAI GPT-5');

    // And query must STILL be present in every later frame:scope
    // event for this frame (i.e. after each step:pass), so the
    // Variables view doesn't wipe the param between steps.
    const skillScopes = events.filter(
      (e) => e.type === 'frame:scope' && e.frameId === pushedFrameId,
    );
    expect(skillScopes.length).toBeGreaterThanOrEqual(2);
    for (const s of skillScopes) {
      expect(s.scope.query).toBe('OpenAI GPT-5');
    }
  });

  it('breakpointsByUri pauses execution before the matching skill-body step', async () => {
    const sessionId = 'skill-bp-pause-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    const skillPath = path.join(skillsDir, 'demo_skill.md');

    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['[skill: demo_skill]'],
        sourceLines: [1],
        skillsDir,
        testFilePath,
        // demo_skill.md has "1. First skill step" on line 7. Setting a
        // breakpoint there should pause BEFORE that step runs.
        breakpointsByUri: { [skillPath]: [7] },
      })) {
        events.push(ev);
        if (ev.type === 'step:awaiting') {
          // Continue past the pause; let the rest of the run complete.
          await runControl(sessionId, 'continue');
        }
        if (ev.type === 'done') break;
      }
    })();
    await consume;

    // The pause MUST come before the first skill body step:pass.
    const awaitingIdx = events.findIndex((e) => e.type === 'step:awaiting');
    const firstSkillPassIdx = events.findIndex(
      (e) => e.type === 'step:pass' && e.frame?.skillName === 'demo_skill',
    );
    expect(awaitingIdx).toBeGreaterThan(-1);
    expect(firstSkillPassIdx).toBeGreaterThan(awaitingIdx);

    // The step:awaiting payload should point at the skill file's line.
    expect(events[awaitingIdx]).toMatchObject({
      type: 'step:awaiting',
      line: 7,
    });
    expect(events[awaitingIdx].frame?.skillName).toBe('demo_skill');

    // Done as passed — both skill body steps ran after the resume.
    const done = events.find((e) => e.type === 'done');
    expect(done?.status).toBe('passed');
  });

  it('skill breakpoint + trailing test step: frame:pop fires BEFORE the trailing step (so the [skill:] line can paint pass)', async () => {
    // User-reported regression: skill-demo.md has
    //   1. [skill: duckduckgo_search ...]
    //   2. Navigate to {{target_url}}
    // and a breakpoint sits inside the skill body. After Continue
    // and a clean run completion, the test file's step 1 (the
    // [skill:] line) should show the green ✓. Internally that means
    // the server MUST emit frame:pop between the last skill-body
    // step:pass and the trailing test step:start — the extension's
    // frame:pop handler is what paints `pass` on the [skill:] line.
    const sessionId = 'skill-bp-trailing-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    const skillPath = path.join(skillsDir, 'demo_skill.md');

    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['[skill: demo_skill]', 'Trailing test step'],
        sourceLines: [1, 2],
        skillsDir,
        testFilePath,
        // Breakpoint on skill body line 7 (demo_skill's first step).
        breakpointsByUri: { [skillPath]: [7] },
      })) {
        events.push(ev);
        if (ev.type === 'step:awaiting') {
          await runControl(sessionId, 'continue');
        }
        if (ev.type === 'done') break;
      }
    })();
    await consume;

    // Locate critical anchors:
    //   - last skill-body step:pass (highest index where frame.skillName === demo_skill)
    //   - frame:pop for the skill
    //   - step:start for the trailing test step (line 2, no frame OR test-root frame)
    const lastSkillPassIdx = (() => {
      let idx = -1;
      events.forEach((e, i) => {
        if (e.type === 'step:pass' && e.frame?.skillName === 'demo_skill') idx = i;
      });
      return idx;
    })();
    const framePopIdx = events.findIndex((e) => e.type === 'frame:pop');
    const trailingStartIdx = events.findIndex(
      (e) => e.type === 'step:start' && e.line === 2,
    );

    expect(lastSkillPassIdx).toBeGreaterThan(-1);
    expect(framePopIdx).toBeGreaterThan(lastSkillPassIdx);
    expect(trailingStartIdx).toBeGreaterThan(framePopIdx);

    // Clean run.
    const done = events.find((e) => e.type === 'done');
    expect(done?.status).toBe('passed');
  });

  it('a step:fail inside a skill body stops the run — no further skill steps run, no trailing test step runs', async () => {
    // Regression: a user observation that "a failed step in the skill
    // doesn't seem to stop the test" prompted a careful audit of the
    // failure path. The server's step loop MUST `break` on stepResult
    // status !== 'passed', short-circuiting both:
    //   (a) the remaining skill-body steps for that frame, and
    //   (b) any trailing test-frame steps after the skill.
    // We verify by mocking executeStep to fail on its SECOND call,
    // then asserting:
    //   - exactly one step:pass + one step:fail land on demo_skill body lines,
    //   - no step:start for skill body line 8 (the second skill step never starts),
    //   - no step:start for the trailing test step (line 2),
    //   - frame:pop fires (call-stack cleanup happens),
    //   - done.status === 'failed'.
    const { executeStep } = await import('../src/runner/step-executor.js');
    const exec = vi.mocked(executeStep);
    // Save & restore the default impl so subsequent tests still get a
    // passing executor — vitest mocks are shared across the file.
    const defaultImpl = exec.getMockImplementation();
    let afterFailureCalls = 0;
    exec.mockImplementationOnce(async () => ({
      index: 1,
      instruction: 'first skill step',
      status: 'passed',
      turns: [],
      durationMs: 5,
      retried: false,
      aiExplanation: 'ok',
    }));
    exec.mockImplementationOnce(async () => ({
      index: 2,
      instruction: 'failing skill step',
      status: 'failed',
      error: 'simulated failure inside skill',
      turns: [],
      durationMs: 5,
      retried: false,
      aiExplanation: 'failed',
    }));
    // Catches "test didn't actually stop" silently: if a third
    // executeStep call ever happens we count it AND log loudly so the
    // assertion below has something concrete to fail on. We don't throw
    // because throwing after the fail-path's break would mask the real
    // signal we're checking — and the retry path legitimately calls
    // executeStep again on transient failures, which we DO want to allow
    // for the same step index.
    exec.mockImplementation(async () => {
      afterFailureCalls++;
      return {
        index: 99,
        instruction: 'should-not-run',
        status: 'failed',
        error: 'executeStep called after a failed step — run should have stopped',
        turns: [],
        durationMs: 5,
        retried: false,
        aiExplanation: 'leaked',
      };
    });

    const sessionId = 'skill-fail-stops-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: ['[skill: demo_skill]', 'Trailing test step'],
      sourceLines: [1, 2],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    // demo_skill has 2 body steps on lines 7 and 8 — the first runs
    // (mock returns passed), the second fails.
    const passes = events.filter(
      (e) => e.type === 'step:pass' && e.frame?.skillName === 'demo_skill',
    );
    expect(passes.map((e) => e.line)).toEqual([7]);

    const fails = events.filter((e) => e.type === 'step:fail');
    expect(fails).toHaveLength(1);
    expect(fails[0].line).toBe(8);
    expect(fails[0].frame?.skillName).toBe('demo_skill');

    // The second skill step's start IS emitted (since failure is
    // reported AFTER executeStep returns), but no second skill step:pass.
    // The crucial assertion: no step:start for the trailing test step.
    const trailingStart = events.find(
      (e) => e.type === 'step:start' && e.line === 2 && !e.frame?.skillName,
    );
    expect(trailingStart).toBeUndefined();

    // No leaked executeStep calls — the server stopped the loop cleanly.
    // (Some retry attempts on the failing step are fine; the mock for
    // the second `mockImplementationOnce` is consumed only once and any
    // retry attempt for that step would also fall into the third
    // implementation, but those would be retries OF THE SAME index — so
    // we only get worried if we see brand-new step indexes leaking
    // through. Since trailingStart is verified absent above, this is a
    // secondary safety net.)
    expect(afterFailureCalls).toBeLessThanOrEqual(2); // retry budget

    // frame:pop still fires — the call stack cleanup happens on early
    // exit too (transitionToFrame('') in the finally-side of the run).
    const pops = events.filter((e) => e.type === 'frame:pop');
    expect(pops.length).toBeGreaterThanOrEqual(1);

    // Done event reports the failure.
    const done = events.find((e) => e.type === 'done');
    expect(done?.status).toBe('failed');

    // Restore the file-wide default so the next test in the suite
    // doesn't inherit the per-call queue or the post-fail impl.
    exec.mockReset();
    if (defaultImpl) exec.mockImplementation(defaultImpl);
  });

  it('breakpointsByUri does NOT loop — once consumed, the same step does not re-pause', async () => {
    // Regression: without consumedBreakpoints tracking, the server
    // would re-pause on the SAME step every time Continue arrived.
    const sessionId = 'skill-bp-noloop-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];
    const skillPath = path.join(skillsDir, 'demo_skill.md');

    let awaitingCount = 0;
    const consume = (async () => {
      for await (const ev of sseEvents(url, {
        steps: ['[skill: demo_skill]'],
        sourceLines: [1],
        skillsDir,
        testFilePath,
        breakpointsByUri: { [skillPath]: [7] },
      })) {
        events.push(ev);
        if (ev.type === 'step:awaiting') {
          awaitingCount++;
          if (awaitingCount > 5) throw new Error('runaway loop — server kept pausing');
          await runControl(sessionId, 'continue');
        }
        if (ev.type === 'done') break;
      }
    })();
    await consume;

    expect(awaitingCount).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Multi-frame scope coverage — call stack chain + per-frame
  // isolation + same-skill-twice independence. The previous tests
  // covered single-skill scope; these protect the nested and
  // repeated-invocation cases that are easy to break with subtle
  // changes to the expander's frame-input recording.
  // ─────────────────────────────────────────────────────────────────

  it('nested skills: each frame:scope carries its OWN caller-supplied inputs (no cross-contamination)', async () => {
    // Test → outer_skill (outer_arg="OUTER") → inner_skill
    //                                          (inner_arg="INNER_PASSED")
    //
    // Three scope contracts to verify simultaneously:
    //   1. Outer's entry frame:scope contains outer_arg, NOT inner_arg
    //      (the inner skill hasn't been entered yet).
    //   2. Inner's entry frame:scope contains inner_arg, NOT outer_arg
    //      (outer's params are inlined into outer's step text, not
    //       stored as variables — the frame chain isolates them).
    //   3. The call-stack chain is test → outer → inner at maximum
    //      depth (two frame:push events with the right parentId
    //      relationship).
    //
    // Catches: frame input collection that accidentally inherits
    // ancestor frame's inputs; or that drops inputs on nested calls;
    // or that emits scope events in the wrong order around push/pop.
    const sessionId = 'nested-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: ['[skill: outer_skill outer_arg="OUTER" out.outer_result="from_outer"]'],
      sourceLines: [1],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    // Locate the two frame:push events in order.
    const pushes = events.filter((e) => e.type === 'frame:push');
    expect(pushes).toHaveLength(2);
    expect(pushes[0].frame.skillName).toBe('outer_skill');
    expect(pushes[1].frame.skillName).toBe('inner_skill');
    expect(pushes[1].frame.parentId).toBe(pushes[0].frame.id);

    // The frame:scope event paired with each push lives at index
    // pushIdx + 1 (the contract documented in
    // session-manager.ts: "every push is paired with a frame:scope
    // snapshot"). Verify per-frame isolation:
    const outerPushIdx = events.indexOf(pushes[0]);
    const outerScope = events[outerPushIdx + 1];
    expect(outerScope?.type).toBe('frame:scope');
    expect(outerScope?.frameId).toBe(pushes[0].frame.id);
    expect(outerScope?.scope?.outer_arg).toBe('OUTER');
    expect(outerScope?.scope?.inner_arg).toBeUndefined();

    const innerPushIdx = events.indexOf(pushes[1]);
    const innerScope = events[innerPushIdx + 1];
    expect(innerScope?.type).toBe('frame:scope');
    expect(innerScope?.frameId).toBe(pushes[1].frame.id);
    expect(innerScope?.scope?.inner_arg).toBe('INNER_PASSED');
    expect(innerScope?.scope?.outer_arg).toBeUndefined();

    // Pop sequence must mirror push sequence (LIFO).
    const pops = events.filter((e) => e.type === 'frame:pop');
    expect(pops).toHaveLength(2);
    expect(pops[0].frameId).toBe(pushes[1].frame.id);
    expect(pops[1].frameId).toBe(pushes[0].frame.id);
  });

  it('same skill called twice: each invocation has its OWN inputs visible (no leak from prior call)', async () => {
    // Test step 1: [skill: reentrant_skill token="FIRST"]
    // Test step 2: [skill: reentrant_skill token="SECOND"]
    //
    // Each invocation gets a NEW frame id (the expander's
    // instanceId increments), and frameInputs is keyed by frame id.
    // So instance #1's scope shows token="FIRST", instance #2's
    // shows token="SECOND". Catches: a regression where the
    // expander shared a single inputs map across invocations of
    // the same skill, or where frameInputs was keyed by skill name
    // instead of frame id.
    const sessionId = 'reentrant-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: [
        '[skill: reentrant_skill token="FIRST"]',
        '[skill: reentrant_skill token="SECOND"]',
      ],
      sourceLines: [1, 2],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    // Two distinct frame ids — same skill, different invocations.
    const pushes = events.filter((e) => e.type === 'frame:push');
    expect(pushes).toHaveLength(2);
    expect(pushes[0].frame.skillName).toBe('reentrant_skill');
    expect(pushes[1].frame.skillName).toBe('reentrant_skill');
    expect(pushes[0].frame.id).not.toBe(pushes[1].frame.id);

    // First instance's entry scope.
    const firstScope = events[events.indexOf(pushes[0]) + 1];
    expect(firstScope?.scope?.token).toBe('FIRST');

    // Second instance's entry scope MUST show its own token,
    // not leak the first's.
    const secondScope = events[events.indexOf(pushes[1]) + 1];
    expect(secondScope?.scope?.token).toBe('SECOND');
    // And the second invocation's frame:scope events emitted
    // AFTER the first instance's frame:pop must not retain "FIRST"
    // — frameInputs lookup is per frame id, not per skill name.
    const secondInstanceScopes = events.filter(
      (e) => e.type === 'frame:scope' && e.frameId === pushes[1].frame.id,
    );
    expect(secondInstanceScopes.length).toBeGreaterThanOrEqual(1);
    for (const s of secondInstanceScopes) {
      expect(s.scope.token).toBe('SECOND');
    }
  });

  it('[store as: X] captures survive a batch boundary — {{X}} resolves in the next request', async () => {
    // Regression: [store as: X] writes directly to resolvedParameters
    // via the step executor but the session manager only synced
    // [output: X] prefix variables to session.outputs. When a test-file
    // breakpoint split the run into two HTTP batch requests, the second
    // batch seeded resolvedParameters from session.outputs (which never
    // received the captured value), so {{X}} stayed literal and Playwright
    // threw "Cannot navigate to invalid URL".
    const { executeStep } = await import('../src/runner/step-executor.js');
    const exec = vi.mocked(executeStep);
    const defaultImpl = exec.getMockImplementation();

    let secondBatchInstruction: string | undefined;

    // First batch: simulate [store as: target_url] writing to the
    // opts.resolvedParameters reference the session-manager passes in.
    exec.mockImplementationOnce(async (_idx, _total, _instr, opts: any) => {
      if (opts?.resolvedParameters) {
        opts.resolvedParameters['target_url'] = 'https://example.com';
      }
      return {
        index: 1, instruction: 'capture step', status: 'passed',
        turns: [], durationMs: 5, retried: false, aiExplanation: 'ok',
      };
    });

    // Second batch: record the interpolated instruction to verify resolution.
    exec.mockImplementationOnce(async (_idx, _total, instr: string) => {
      secondBatchInstruction = instr;
      return {
        index: 1, instruction: instr, status: 'passed',
        turns: [], durationMs: 5, retried: false, aiExplanation: 'ok',
      };
    });

    const sessionId = 'store-as-survives-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;

    // Batch 1: step that captures target_url (mock writes it to resolvedParameters).
    for await (const ev of sseEvents(url, {
      steps: ['Capture the URL [store as: target_url]'],
      sourceLines: [1],
    })) {
      if (ev.type === 'done') break;
    }

    // Batch 2: step that uses {{target_url}} — simulates resume after breakpoint.
    for await (const ev of sseEvents(url, {
      steps: ['Navigate to {{target_url}}'],
      sourceLines: [1],
    })) {
      if (ev.type === 'done') break;
    }

    // {{target_url}} must have been interpolated before reaching executeStep.
    expect(secondBatchInstruction).toBe('Navigate to https://example.com');

    exec.mockReset();
    if (defaultImpl) exec.mockImplementation(defaultImpl);
  });

  it('breakpointsByUri entries keyed at testFilePath are ignored (client trims those)', async () => {
    // The fix's contract: the server skips testFilePath entries from
    // the map because the client's client-side trimAtBreakpoint
    // already prevents the server from reaching those lines. If the
    // server ALSO honored them, we'd double-trigger on resume.
    const sessionId = 'skill-bp-testfile-skipped-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
    const events: any[] = [];

    for await (const ev of sseEvents(url, {
      steps: ['Open the page', 'Verify result'],
      sourceLines: [1, 2],
      testFilePath,
      // Try to trigger a server-side pause on line 1 of the TEST file.
      // The server must ignore this (testFilePath entries are filtered).
      breakpointsByUri: { [testFilePath]: [1] },
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    const awaiting = events.filter((e) => e.type === 'step:awaiting');
    expect(awaiting).toHaveLength(0);
  });

  it('aborts cleanly when a [skill:] invocation has a syntax error', async () => {
    // A malformed skill call (unterminated quoted argument) must not crash
    // the SSE stream or run any steps. The server should surface the parser
    // error via an `output kind:error` event AND a `done status:error`, so
    // the client can show the message without the run silently hanging.
    const { executeStep } = await import('../src/runner/step-executor.js');
    const executeStepMock = vi.mocked(executeStep);
    executeStepMock.mockClear();

    const sessionId = 'skill-syntax-' + Date.now();
    const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;

    const events: any[] = [];
    for await (const ev of sseEvents(url, {
      // Unterminated string after `query="` — parseSkillCall throws
      // SkillCallSyntaxError, which expandSkills propagates verbatim.
      steps: ['[skill: parameterized_skill query="oops]'],
      sourceLines: [1],
      skillsDir,
      testFilePath,
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    // Stream must terminate with a `done` carrying error status.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.status).toBe('error');

    // The parser's diagnostic must reach the client via an `output` event.
    const errorOutputs = events.filter(
      (e) => e.type === 'output' && e.kind === 'error',
    );
    expect(errorOutputs.length).toBeGreaterThan(0);
    const combined = errorOutputs.map((e) => e.msg).join('\n');
    expect(combined).toMatch(/Skill expansion failed/);
    expect(combined).toMatch(/unterminated string for argument 'query'/);

    // No step should have been executed — expansion fails before the browser
    // does any work.
    expect(executeStepMock).not.toHaveBeenCalled();

    // And no frame:push event should have fired (expansion never produced
    // frames).
    expect(events.find((e) => e.type === 'frame:push')).toBeUndefined();
  });

  describe('secrets stay out of what the server writes (stories/secret-redaction.md)', () => {
    let root: string;
    let mdFile: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'stepmode-secrets-'));
      await fs.writeFile(path.join(root, 'aiui.config.json'), '{}\n');
      await fs.writeFile(
        path.join(root, '.env.uat'),
        ['GITHUB_USERNAME=octocat', 'GITHUB_PASSWORD=hunter2-uat-secret', ''].join('\n'),
      );
      mdFile = path.join(root, 'login.md');
      await fs.writeFile(mdFile, '# login\n');
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    });

    /** A turn the way the executor records one: the prompt, the reply and
     *  the action all carry the typed value. */
    function turnTyping(value: string) {
      return {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: 't',
        aiInteractions: [
          {
            purpose: 'step',
            requestMessages: [{ role: 'user', content: `## Current Step\nEnter the password ${value}` }],
            response: `{"actions":[{"type":"type","selector":"#p","value":"${value}"}]}`,
          },
        ],
        subActions: [
          { index: 0, action: { type: 'type', selector: '#p', value } as never, durationMs: 1 },
          { index: 1, action: { type: 'press', key: 'Enter' } as never, durationMs: 1 },
        ],
      };
    }

    it('masks a secret-named parameter on the console step line and in the report, and nowhere the run needs it', async () => {
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();
      const { logger } = await import('../src/utils/logger.js');
      const stepLine = vi.mocked(logger.step);
      stepLine.mockClear();
      const { generateReport } = await import('../src/report/generator.js');
      const reportMock = vi.mocked(generateReport);
      reportMock.mockClear();

      const seen: string[] = [];
      exec.mockImplementation(async (idx, _total, instr) => {
        seen.push(instr);
        return {
          index: idx, instruction: instr, status: 'passed', durationMs: 1, retried: false,
          turns: [turnTyping('hunter2!x')],
          screenshotBase64: 'AAAAhunter2!xAAAA',
          aiExplanation: 'Typed hunter2!x into the password field',
        };
      });

      try {
        const sessionId = 'secrets-param-' + Date.now();
        const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
        const events: Array<{ type: string; [k: string]: any }> = [];
        for await (const ev of sseEvents(url, {
          steps: ['Enter the username {{username}}', 'Enter the password {{password}}'],
          sourceLines: [1, 2],
          testFilePath: mdFile,
          parameters: { username: 'octocat', password: 'hunter2!x' },
        })) {
          events.push(ev);
          if (ev.type === 'done') break;
        }

        // The step ran with the real value…
        expect(seen).toEqual(['Enter the username octocat', 'Enter the password hunter2!x']);
        // …the console line did not print it (the username is not a secret
        // by name, and resolved values are what the line is for)…
        expect(stepLine.mock.calls.map((c) => c[2])).toEqual([
          'Enter the username octocat',
          'Enter the password ***',
        ]);
        // …and the report the generator got carries it nowhere: not in the
        // parameters, not in the prompt, the reply, the action or the
        // explanation. The screenshot is untouched; so is the press key.
        expect(reportMock).toHaveBeenCalledTimes(1);
        const report = reportMock.mock.calls[0]![0];
        expect(report.parameters).toEqual({ username: 'octocat', password: '***' });
        const turn = report.steps[1]!.turns[0]!;
        expect(turn.aiInteractions[0]!.requestMessages![0]!.content).toBe('## Current Step\nEnter the password ***');
        expect(turn.aiInteractions[0]!.response).toBe('{"actions":[{"type":"type","selector":"#p","value":"***"}]}');
        expect(turn.subActions[0]!.action).toEqual({ type: 'type', selector: '#p', value: '***' });
        expect(turn.subActions[1]!.action).toEqual({ type: 'press', key: 'Enter' });
        expect(report.steps[1]!.aiExplanation).toBe('Typed *** into the password field');
        expect(report.steps[1]!.screenshotBase64).toBe('AAAAhunter2!xAAAA');
        expect(JSON.stringify({ ...report, steps: report.steps.map((s) => ({ ...s, screenshotBase64: '' })) })).not.toContain('hunter2!x');
        // The wire is not the framework's output: the client that sent the
        // value gets the run's events as they happened.
        expect(events.some((e) => e.type === 'done' && e.status === 'passed')).toBe(true);
      } finally {
        exec.mockReset();
        if (defaultImpl) exec.mockImplementation(defaultImpl);
      }
    });

    it('masks an env secret referenced inline, and a value captured under a secret name mid-run', async () => {
      const { executeStep } = await import('../src/runner/step-executor.js');
      const exec = vi.mocked(executeStep);
      const defaultImpl = exec.getMockImplementation();
      const { logger } = await import('../src/utils/logger.js');
      const stepLine = vi.mocked(logger.step);
      stepLine.mockClear();
      const { generateReport } = await import('../src/report/generator.js');
      const reportMock = vi.mocked(generateReport);
      reportMock.mockClear();

      exec.mockImplementation(async (idx, _total, instr, opts: any) => {
        // Step 2 captures an API token the way `[as: api_token]` does —
        // written straight into the run's parameter map.
        if (idx === 2 && opts?.resolvedParameters) opts.resolvedParameters['api_token'] = 'tok-from-page';
        return {
          index: idx, instruction: instr, status: 'passed', durationMs: 1, retried: false,
          turns: [],
          ...(idx === 2 && { aiExplanation: 'Read tok-from-page off the page' }),
        };
      });

      try {
        const sessionId = 'secrets-env-' + Date.now();
        const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`;
        for await (const ev of sseEvents(url, {
          steps: ['Enter ${env.GITHUB_PASSWORD} for ${env.GITHUB_USERNAME}', 'Read the API token', 'Send {{api_token}}'],
          sourceLines: [1, 2, 3],
          testFilePath: mdFile,
          envName: 'uat',
        })) {
          if (ev.type === 'done') break;
        }

        expect(stepLine.mock.calls.map((c) => c[2])).toEqual([
          'Enter *** for octocat',
          'Read the API token',
          // Captured under a secret name one step earlier: masked from then on.
          'Send ***',
        ]);
        const report = reportMock.mock.calls[0]![0];
        expect(report.steps[1]!.aiExplanation).toBe('Read *** off the page');
        expect(report.parameters!['api_token']).toBe('***');
      } finally {
        exec.mockReset();
        if (defaultImpl) exec.mockImplementation(defaultImpl);
      }
    });
  });
});
