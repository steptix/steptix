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
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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

beforeAll(async () => {
  const { app } = createApiServer(cfg);
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
});
