/**
 * Inline sections over HTTP.
 *
 * **Every test here POSTs through the real `node:http` entry.** That is a hard
 * rule from the contract (§3.2, §7), not a stylistic preference: `api-server.ts`
 * builds `StepRequest` from an explicit per-field allow-list, so adding
 * `sections` to the TYPE compiles cleanly and drops the field at runtime. A
 * test that constructs a `StepRequest` directly and hands it to the session
 * manager passes against exactly that bug. This seam has already lost one
 * field this way (`envName`).
 *
 * The browser / AI / step-executor are mocked as in `api-server-stepmode.test.ts`;
 * the expander, the request validation and the session manager run for real.
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

/** Records the instruction text of every step the runner actually executes. */
const executedSteps: string[] = [];
/** Records `[instruction, cacheEnabled]` per step, at the seam where the
 *  per-step cache is actually consulted. */
const cacheFlags: [string, boolean][] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  // Signature: (stepIndex, totalSteps, instruction, opts) — `instruction` is
  // the third POSITIONAL argument, not a property of the options object.
  executeStep: vi.fn(async (
    _stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts?: { cacheEnabled?: boolean },
  ): Promise<StepResult> => {
    executedSteps.push(instruction);
    cacheFlags.push([instruction, opts?.cacheEnabled === true]);
    return {
      index: 1,
      instruction: 'mock step',
      status: 'passed',
      turns: [],
      durationMs: 5,
      retried: false,
      aiExplanation: 'ok',
    };
  }),
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

/** Captures the report the run produced, so `sourceSection` can be asserted. */
const generatedReports: any[] = [];

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async (report: unknown) => {
    generatedReports.push(report);
    return '/tmp/fake-report.html';
  }),
  getPrimaryModel: vi.fn(() => 'mock-model'),
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fakeBase64' })),
}));

/** Captures logger.warn so the dead-section warning can be counted. */
const warnings: string[] = [];

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(), error: vi.fn(),
    warn: vi.fn((msg: string) => { warnings.push(String(msg)); }),
    success: vi.fn(), step: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

import { createApiServer } from '../src/server/api-server.js';

const API_KEY = 'sk-sections-test';
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
let tmpDir: string;
let testFilePath: string;
let skillsDir: string;

beforeAll(async () => {
  const { app } = createApiServer(cfg);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sections-http-'));
  testFilePath = path.join(tmpDir, 'checkout.md');
  await fs.writeFile(testFilePath, '# placeholder — the server never reads this\n');

  skillsDir = path.join(tmpDir, 'skills');
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, 'wave.md'),
    ['---', 'type: skill', '---', '# wave', '', '## Steps', '1. Wave hello', ''].join('\n'),
  );
  // A skill that calls another skill from its OWN line 8, so that frame's
  // invocation line collides with a test-file section body line.
  await fs.writeFile(
    path.join(skillsDir, 'nested.md'),
    ['---', 'type: skill', '---', '# nested', '', '## Steps', '1. Nested start', '2. [skill: wave]', ''].join('\n'),
  );
  // A skill whose steps sit on SKILL-FILE lines 7-9, so they collide with a
  // test file's section-body line numbers.
  await fs.writeFile(
    path.join(skillsDir, 'liner.md'),
    ['---', 'type: skill', '---', '# liner', '', '## Steps', '1. Liner one', '2. Liner two', '3. Liner three', ''].join('\n'),
  );
  // A skill with no steps at all: it expands to nothing, so its call line
  // never appears in the expansion origins.
  await fs.writeFile(
    path.join(skillsDir, 'emptyskill.md'),
    ['---', 'type: skill', '---', '# emptyskill', '', '## Steps', ''].join('\n'),
  );
  // A skill that defines a section nothing invokes — the skills-only path's
  // dead-section diagnostic, which needs no `sections` in the request.
  await fs.writeFile(
    path.join(skillsDir, 'deadskill.md'),
    [
      '---', 'type: skill', '---', '# deadskill', '',
      '## Steps',
      '1. Skill start',
      '',
      '### Orphan',
      '1. Never runs',
      '',
    ].join('\n'),
  );
  // A skill that defines AND calls a section named `__proto__` — a legal
  // name that an object literal silently swallows.
  await fs.writeFile(
    path.join(skillsDir, 'protoskill.md'),
    [
      '---', 'type: skill', '---', '# protoskill', '',
      '## Steps',
      '1. Skill start',
      '2. __proto__',
      '',
      '### __proto__',
      '1. Skill body ran',
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────

let sessionSeq = 0;
const nextSession = (): string => `sections-${++sessionSeq}`;

async function postSteps(body: unknown, sessionId = nextSession()): Promise<Response> {
  return postRaw(JSON.stringify(body), sessionId);
}

/** POST an already-serialized body — needed for keys JS literals can't express. */
async function postRaw(body: string, sessionId = nextSession()): Promise<Response> {
  return fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body,
  });
}

async function* sseEvents(body: unknown, sessionId = nextSession()) {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error('no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        yield JSON.parse(dataLine.slice(6)) as { type: string; [k: string]: any };
      } catch {
        /* keep-alives */
      }
    }
  }
}

/**
 * A two-section document, as the client would send it. Main flow calls
 * `Sign in`; `Sign in` calls `Type creds`; `Cleanup` is never called.
 *
 *     3. Open the shop        <- main
 *     4. Sign in              <- main, calls the section
 *     5. Check out            <- main
 *     ### Sign in
 *     8. Type creds           <- body, calls the nested section
 *     9. Press submit
 *     ### Type creds
 *     12. Type the username
 *     ### Cleanup
 *     15. Sign out            <- never invoked
 */
const twoSectionBody = (extra: Record<string, unknown> = {}) => ({
  steps: ['Open the shop', 'Sign in', 'Check out'],
  sourceLines: [3, 4, 5],
  testFilePath,
  sections: {
    'sign in': {
      name: 'Sign in',
      headingLine: 7,
      steps: ['Type creds', 'Press submit'],
      stepLines: [8, 9],
    },
    'type creds': {
      name: 'Type creds',
      headingLine: 11,
      steps: ['Type the username'],
      stepLines: [12],
    },
    cleanup: {
      name: 'Cleanup',
      headingLine: 14,
      steps: ['Sign out'],
      stepLines: [15],
    },
  },
  ...extra,
});

// ── Forwarding ───────────────────────────────────────────────────────

describe('sections reach the expander through the HTTP layer', () => {
  it('expands nested sections in document order', async () => {
    executedSteps.length = 0;
    const res = await postSteps(twoSectionBody());
    expect(res.status).toBe(200);

    // `Sign in` inlines its body, and `Type creds` inlines inside it. The
    // call lines themselves disappear — they are not instructions.
    expect(executedSteps).toEqual([
      'Open the shop',
      'Type the username',
      'Press submit',
      'Check out',
    ]);
  });

  it('a sections-only project needs no skillsDir', async () => {
    // `skillsDir` was a required parameter before sections; a project can
    // define inline sections and own no skills directory at all. The gate
    // and the expander call both have to tolerate its absence.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Greet'],
      sourceLines: [3],
      testFilePath,
      sections: { greet: { name: 'Greet', headingLine: 5, steps: ['Say hi'], stepLines: [6] } },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Say hi']);
  });

  it('sections and skills compose', async () => {
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Do the thing'],
      sourceLines: [3],
      testFilePath,
      skillsDir,
      sections: {
        'do the thing': {
          name: 'Do the thing',
          headingLine: 5,
          steps: ['[skill: wave]', 'And finish'],
          stepLines: [6, 7],
        },
      },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Wave hello', 'And finish']);
  });

  it('strips a [no-hooks] marker from an inlined body step', async () => {
    // The CLI strips markers at parse time, so no CLI test can catch this:
    // on the server path the body text arrives with the marker intact and
    // the expander must strip it, or the literal `[no-hooks]` reaches the AI.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Greet'],
      sourceLines: [3],
      testFilePath,
      sections: {
        greet: { name: 'Greet', headingLine: 5, steps: ['[no-hooks] Say hi'], stepLines: [6] },
      },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Say hi']);
  });

  it('an empty sections map behaves exactly as absent', async () => {
    // `{}` is truthy in JS. If any gate checked `request.sections` directly,
    // this run would take the expansion path instead of the legacy one —
    // a behaviour change for every existing sectionless client.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Just this'],
      sourceLines: [3],
      testFilePath,
      sections: {},
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Just this']);
  });

  it('omitting sections entirely still works', async () => {
    executedSteps.length = 0;
    const res = await postSteps({ steps: ['Just this'], sourceLines: [3], testFilePath });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Just this']);
  });
});

// ── Validation ───────────────────────────────────────────────────────

describe('malformed sections are refused, not silently dropped', () => {
  const bad = (sections: unknown, extra: Record<string, unknown> = {}) => ({
    steps: ['Anything'],
    testFilePath,
    sections,
    ...extra,
  });

  it('400 when sections is an array', async () => {
    const res = await postSteps(bad([{ name: 'X' }]));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must be an object/i);
  });

  it('400 when an entry is not an object', async () => {
    const res = await postSteps(bad({ x: 'nope' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sections\["x"\] must be an object/i);
  });

  it('400 when name is not a string', async () => {
    const res = await postSteps(bad({ x: { name: 5, headingLine: 1, steps: [], stepLines: [] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.name must be a string/i);
  });

  it('400 when headingLine is not a number', async () => {
    const res = await postSteps(bad({ x: { name: 'X', headingLine: 'one', steps: [], stepLines: [] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.headingLine must be a number/i);
  });

  it('400 when steps is not an array of strings', async () => {
    const res = await postSteps(bad({ x: { name: 'X', headingLine: 1, steps: [5], stepLines: [1] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.steps must be an array of strings/i);
  });

  it('400 when stepLines is not an array of numbers', async () => {
    const res = await postSteps(bad({ x: { name: 'X', headingLine: 1, steps: ['a'], stepLines: ['1'] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.stepLines must be an array of numbers/i);
  });

  it('400 on steps/stepLines arity skew — they are parallel arrays', async () => {
    // A skew would attribute a body step to the wrong source line: wrong
    // gutter, wrong breakpoint, wrong re-run anchor.
    const res = await postSteps(bad({ x: { name: 'X', headingLine: 1, steps: ['a', 'b'], stepLines: [1] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/same length.*parallel arrays/is);
  });

  it('400 when non-empty sections arrive without testFilePath', async () => {
    const res = await postSteps({
      steps: ['Anything'],
      sections: { x: { name: 'X', headingLine: 1, steps: ['a'], stepLines: [1] } },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/requires "testFilePath"/i);
  });

  it('an EMPTY sections map without testFilePath is NOT a 400', async () => {
    // Treated as absent, so the legacy no-testFilePath path stays open.
    const res = await postSteps({ steps: ['Anything'], sections: {} });
    expect(res.status).toBe(200);
  });

  it('an invoked section with an empty body is an expander error, not a 400', async () => {
    const res = await postSteps({
      steps: ['Empty'],
      sourceLines: [3],
      testFilePath,
      sections: { empty: { name: 'Empty', headingLine: 5, steps: [], stepLines: [] } },
    });
    // The request is well-formed; the DOCUMENT is not. That distinction is
    // the point — a 400 would tell the client it sent bad JSON. Assert the
    // actual outcome, not just `not 400`, which a 500 would also satisfy.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error?.message).toMatch(/"Empty".*no steps/is);
  });

  it('400 when the key is not matchText(name)', async () => {
    // A mismatched key is uncallable: every lookup derives its key from the
    // step text, so it misses and the bare name ships to the AI.
    const res = await postSteps({
      steps: ['Greet'],
      sourceLines: [3],
      testFilePath,
      sections: { Greet: { name: 'Greet', headingLine: 5, steps: ['Say hi'], stepLines: [6] } },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/keyed "Greet".*normalizes to "greet"/is);
  });

  it('400 on an empty section name', async () => {
    const res = await postSteps({
      steps: ['x'],
      testFilePath,
      sections: { '': { name: '', headingLine: 5, steps: ['a'], stepLines: [6] } },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/empty name/i);
  });

  it('a section named __proto__ resolves instead of vanishing', async () => {
    // `sections['__proto__'] = entry` on a normal object literal invokes the
    // prototype setter rather than creating an own key, so the definition
    // disappears and the bare name reaches the AI. `### __proto__` breaks no
    // naming rule, so it has to work.
    executedSteps.length = 0;
    // Hand-written JSON, not an object literal: `{ __proto__: x }` in JS
    // source invokes the prototype setter, so `JSON.stringify` of it yields
    // `{}` and the case cannot be expressed. `JSON.parse` DOES create it as
    // an own property, which is how a real client's payload arrives.
    const res = await postRaw(
      JSON.stringify({ steps: ['__proto__'], sourceLines: [3], testFilePath }).replace(
        /}$/,
        `,"sections":{"__proto__":{"name":"__proto__","headingLine":5,"steps":["Body ran"],"stepLines":[6]}}}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Body ran']);
  });

  it('a section named __proto__ inside a SKILL also resolves', async () => {
    // Three maps are built from untrusted section names: the parser's, the
    // api-server forwarding copy, and the per-invocation rebuild in
    // `applySkillScope`. Missing the third meant `### __proto__` worked in a
    // test file and silently degraded inside a skill — one document, two
    // behaviours — with the dead-section warning staying quiet because it
    // scans the untransformed map where the entry is still present.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['[skill: protoskill]'],
      sourceLines: [3],
      testFilePath,
      skillsDir,
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Skill start', 'Skill body ran']);
  });

  it('a step named after an Object.prototype member does not crash the run', async () => {
    // `1. constructor` used to resolve against `Object.prototype.constructor`
    // and abort the whole run with "Cannot read properties of undefined".
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['constructor', 'toString'],
      sourceLines: [3, 4],
      testFilePath,
      sections: { greet: { name: 'Greet', headingLine: 6, steps: ['Say hi'], stepLines: [7] } },
    });
    expect(res.status).toBe(200);
    // Neither names a section, so both run as ordinary instructions.
    expect(executedSteps).toEqual(['constructor', 'toString']);
  });
});

// ── Debugging: breakpoints on section body lines ─────────────────────

describe('breakpoints inside a section body', () => {
  it('pauses on a body line even though it lives in the test file', async () => {
    // The client trims the batch at test-file breakpoints before sending,
    // so the server used to skip that file's entry wholesale. A section body
    // line IS in the test file but is invisible to that trim — it only
    // exists after expansion — so it must pause here or never at all.
    const events: { type: string; line?: number; frame?: any }[] = [];
    const sessionId = nextSession();
    for await (const ev of sseEvents(
      twoSectionBody({ breakpointsByUri: { [testFilePath]: [9] } }),
      sessionId,
    )) {
      events.push(ev);
      if (ev.type === 'step:awaiting') {
        // Release the pause so the stream can finish.
        void fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/run-control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ mode: 'continue' }),
        });
      }
      if (ev.type === 'done') break;
    }

    const awaiting = events.filter((e) => e.type === 'step:awaiting');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.line).toBe(9);
    expect(awaiting[0]!.frame?.kind).toBe('section');
    expect(awaiting[0]!.frame?.skillName).toBe('Sign in');
  });

  it('does NOT pause on a main-flow line — the client already trimmed there', async () => {
    // Pausing here as well would stop twice on one line.
    const events: { type: string; line?: number }[] = [];
    for await (const ev of sseEvents(twoSectionBody({ breakpointsByUri: { [testFilePath]: [5] } }))) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    expect(events.filter((e) => e.type === 'step:awaiting')).toEqual([]);
  });
});

// ── Skipped steps inside a body ──────────────────────────────────────

describe('an [input:] step inside a section body', () => {
  it('is skipped loudly rather than silently', async () => {
    // The client splits a batch before a main-flow `[input:]` and prompts, so
    // this branch is unreachable there. A body step is invisible to that
    // split, lands here, and the run finishes green having quietly not done
    // it — reporting green for skipped work is the direction worth shouting
    // about.
    const events: { type: string; kind?: string; msg?: string }[] = [];
    for await (const ev of sseEvents({
      steps: ['Sign in'],
      sourceLines: [3],
      testFilePath,
      sections: {
        'sign in': {
          name: 'Sign in',
          headingLine: 5,
          steps: ['[input: password] Your password', 'Press submit'],
          stepLines: [6, 7],
        },
      },
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }

    const warned = events.filter((e) => e.type === 'output' && e.kind === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]!.msg).toMatch(/SKIPPED/);
    expect(warned[0]!.msg).toMatch(/section body/i);
  });

  it('stays silent for a main-flow [input:], which the client handles', async () => {
    const events: { type: string; kind?: string }[] = [];
    for await (const ev of sseEvents({
      steps: ['[input: password] Your password', 'Sign in'],
      sourceLines: [3, 4],
      testFilePath,
      sections: {
        'sign in': { name: 'Sign in', headingLine: 6, steps: ['Press submit'], stepLines: [7] },
      },
    })) {
      events.push(ev);
      if (ev.type === 'done') break;
    }
    expect(events.filter((e) => e.type === 'output' && e.kind === 'warn')).toEqual([]);
  });
});

// ── Frames ───────────────────────────────────────────────────────────

describe('section frames', () => {
  it('pushes a section frame whose uri is the test file and skillName the section', async () => {
    const frames: any[] = [];
    for await (const ev of sseEvents(twoSectionBody())) {
      if (ev.type === 'frame:push') frames.push(ev.frame);
      if (ev.type === 'done') break;
    }

    const names = frames.map((f) => `${f.kind}:${f.skillName}`);
    expect(names).toContain('section:Sign in');
    expect(names).toContain('section:Type creds');
    for (const frame of frames.filter((f) => f.kind === 'section')) {
      expect(frame.uri).toBe(testFilePath);
    }
  });

  it('frame ids are unique across the whole expansion', async () => {
    const ids: string[] = [];
    for await (const ev of sseEvents(twoSectionBody())) {
      if (ev.type === 'frame:push') ids.push(ev.frame.id);
      if (ev.type === 'done') break;
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Narrowed section loops ───────────────────────────────────────────

/**
 * A client may ship only SOME of a section table's rows, and then says where
 * each one sits in the authored table (`rowNumbers`) and how many rows that
 * table has (`rowCount`) — stories/data-row-progress-and-selection.md,
 * decision 1. The iteration keeps its TABLE number, so a one-row run's badge
 * still reads `(2/3)` and names the row the reader picked.
 */
describe('a narrowed section loop keeps the table row numbers', () => {
  /** Two of a three-row table, as a narrowed client would send them. */
  const narrowed = (over: Record<string, unknown>) => ({
    steps: ['Upload each statement'],
    sourceLines: [3],
    testFilePath,
    sections: {
      'upload each statement': {
        name: 'Upload each statement',
        headingLine: 5,
        steps: ['Upload file {{file}}'],
        stepLines: [9],
        rows: [{ file: 'b.png' }, { file: 'c.png' }],
        ...over,
      },
    },
  });

  it('stamps iteration from rowNumbers and iterationCount from rowCount', async () => {
    executedSteps.length = 0;
    const frames: any[] = [];
    for await (const ev of sseEvents(narrowed({ rowNumbers: [2, 3], rowCount: 3 }))) {
      if (ev.type === 'frame:push' && ev.frame.kind === 'section') frames.push(ev.frame);
      if (ev.type === 'done') break;
    }

    // 2 of 3 and 3 of 3 — not 1 of 2 and 2 of 2, which is what numbering by
    // arrival position would give. Every downstream label (the report band,
    // the section chip's `(2/3)`, the Variables frame) reads these two.
    expect(frames.map((f) => [f.iteration, f.iterationCount])).toEqual([
      [2, 3],
      [3, 3],
    ]);
    expect(frames.map((f) => f.skillName)).toEqual([
      'Upload each statement',
      'Upload each statement',
    ]);
    // The rows still bind, in the order they arrived.
    expect(executedSteps).toEqual(['Upload file b.png', 'Upload file c.png']);
  });

  it('numbers by arrival position when neither field is sent', async () => {
    // The CLI path and every un-narrowed client: unchanged behaviour, which
    // is the same answer because the whole table was shipped.
    executedSteps.length = 0;
    const frames: any[] = [];
    for await (const ev of sseEvents(narrowed({}))) {
      if (ev.type === 'frame:push' && ev.frame.kind === 'section') frames.push(ev.frame);
      if (ev.type === 'done') break;
    }

    expect(frames.map((f) => [f.iteration, f.iterationCount])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(executedSteps).toEqual(['Upload file b.png', 'Upload file c.png']);
  });

  it.each([
    [
      'rowNumbers shorter than rows',
      { rowNumbers: [2], rowCount: 3 },
      /rowNumbers and .*\.rows must be the same length.*parallel arrays/is,
    ],
    [
      'rowNumbers that descend',
      { rowNumbers: [3, 2], rowCount: 3 },
      /rowNumbers must be strictly ascending/i,
    ],
    [
      'a duplicated row number',
      { rowNumbers: [2, 2], rowCount: 3 },
      /rowNumbers must be strictly ascending/i,
    ],
    [
      'a row number past rowCount',
      { rowNumbers: [2, 4], rowCount: 3 },
      /rowNumbers must all be <=/i,
    ],
    [
      'rowNumbers without rowCount',
      { rowNumbers: [2, 3] },
      /must be sent together or not at all \(got rowNumbers alone\)/i,
    ],
    [
      'rowCount without rowNumbers',
      { rowCount: 3 },
      /must be sent together or not at all \(got rowCount alone\)/i,
    ],
    [
      'a rowCount smaller than the shipped rows',
      { rowNumbers: [1, 2], rowCount: 1 },
      /rowCount is 1 but .*\.rows holds 2 rows/is,
    ],
    [
      'a non-integer row number',
      { rowNumbers: [1, 2.5], rowCount: 3 },
      /rowNumbers must be an array of positive integers/i,
    ],
    [
      'a zero row number',
      { rowNumbers: [0, 2], rowCount: 3 },
      /rowNumbers must be an array of positive integers/i,
    ],
    [
      'a non-integer rowCount',
      { rowNumbers: [1, 2], rowCount: 2.5 },
      /rowCount must be a positive integer/i,
    ],
  ])('400 on %s', async (_label, over, pattern) => {
    // Refused, not repaired: every one of these numbers an iteration wrong,
    // and a wrong number only shows up as an off-by-one in a badge later.
    const res = await postSteps(narrowed(over as Record<string, unknown>));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(pattern as RegExp);
  });

  it('400 on rowNumbers for a section with no rows at all', async () => {
    const res = await postSteps({
      steps: ['Anything'],
      testFilePath,
      sections: {
        x: { name: 'X', headingLine: 1, steps: ['a'], stepLines: [1], rowNumbers: [1], rowCount: 1 },
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rowNumbers requires .*\.rows/is);
  });
});

// ── Reporting ────────────────────────────────────────────────────────

describe('sourceSection attribution', () => {
  it('tags body steps with the outermost section, and skips skill-private ones', async () => {
    generatedReports.length = 0;
    const res = await postSteps({
      steps: ['Open the shop', 'Do the thing'],
      sourceLines: [3, 4],
      testFilePath,
      skillsDir,
      sections: {
        'do the thing': {
          name: 'Do the thing',
          headingLine: 6,
          steps: ['[skill: wave]'],
          stepLines: [7],
        },
      },
    });
    expect(res.status).toBe(200);

    const report = generatedReports.at(-1);
    expect(report).toBeDefined();
    const byInstruction = new Map<string, any>(
      (report.steps ?? []).map((s: any) => [s.instruction, s]),
    );

    // A main-flow step carries neither badge.
    expect(byInstruction.get('Open the shop')?.sourceSection).toBeUndefined();
    expect(byInstruction.get('Open the shop')?.sourceSkill).toBeUndefined();

    // A step inside `section → skill` carries BOTH: the section is what the
    // test author wrote, the skill is where the step lives.
    const inner = byInstruction.get('Wave hello');
    expect(inner?.sourceSection).toBe('Do the thing');
    expect(inner?.sourceSkill).toBe('wave');
  });
});

// ── Dead-section warning ─────────────────────────────────────────────

describe('the dead-section warning is emitted exactly once', () => {
  it('once for a full run, naming only the uninvoked section', async () => {
    warnings.length = 0;
    await postSteps(twoSectionBody());
    const dead = warnings.filter((w) => /never invoked/i.test(w));
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatch(/Cleanup/);
  });

  it('a breakpoint run warns exactly once across its batches', async () => {
    // Scoping to full-document batches suppressed the warning on BOTH
    // batches, so a user who set any breakpoint never saw it — and debugging
    // is exactly when a section that quietly stopped resolving is hardest to
    // spot.
    //
    // Note both batches go to the SAME session, which is what a real resume
    // does: the session is what keeps the browser alive across the pause.
    // Dedup is session-scoped, so a test that opened a fresh session per
    // batch would not be modelling a resumed run at all.
    warnings.length = 0;
    const full = ['Open the shop', 'Sign in', 'Check out'];
    const sessionId = nextSession();

    await postSteps(
      twoSectionBody({ steps: full.slice(0, 2), sourceLines: [3, 4], fullSteps: full }),
      sessionId,
    );
    expect(warnings.filter((w) => /never invoked/i.test(w))).toHaveLength(1);

    await postSteps(
      twoSectionBody({ steps: full.slice(2), sourceLines: [5], fullSteps: full }),
      sessionId,
    );
    expect(warnings.filter((w) => /never invoked/i.test(w))).toHaveLength(1);
  });

  it('liveness is scanned over the whole document, not the batch', async () => {
    // `Sign in` is invoked at line 4, which is NOT in this batch. Scanning
    // only the batch would report it dead — a false alarm on precisely the
    // runs a user is already debugging.
    warnings.length = 0;
    const full = ['Open the shop', 'Sign in', 'Check out'];
    await postSteps(twoSectionBody({ steps: [full[0]!], sourceLines: [3], fullSteps: full }));
    const dead = warnings.filter((w) => /never invoked/i.test(w));
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatch(/Cleanup/);
    expect(dead.join('\n')).not.toMatch(/Sign in/);
  });

  it('a targeted re-run never warns', async () => {
    warnings.length = 0;
    await postSteps(twoSectionBody({ startAt: { uri: testFilePath, line: 5 } }));
    expect(warnings.filter((w) => /never invoked/i.test(w))).toEqual([]);
  });

  it('warns once per run even when the first batch does not start at step 0', async () => {
    // The client splits a document into batches at `[input:]` /
    // `[interactive]` boundaries, so a test OPENING with an `[input:]` step
    // has a first batch beginning at document step 2. Inferring "first batch
    // of a run" from `steps[0] === fullSteps[0]` lost the diagnostic for the
    // whole run; deduping on the document's shape does not.
    warnings.length = 0;
    const full = ['[input: username] Who?', 'Open the shop', 'Sign in', 'Check out'];
    const sessionId = nextSession();

    await postSteps(twoSectionBody({ steps: full.slice(1), sourceLines: [4, 5, 6], fullSteps: full }), sessionId);
    expect(warnings.filter((w) => /never invoked/i.test(w))).toHaveLength(1);

    // A later batch of the same run, same session, same document: silent.
    await postSteps(twoSectionBody({ steps: full.slice(3), sourceLines: [6], fullSteps: full }), sessionId);
    expect(warnings.filter((w) => /never invoked/i.test(w))).toHaveLength(1);
  });

  it('a skills-only run still reports a dead section in the SKILL', async () => {
    // A skill file can define sections too, and the expander warns about
    // those from a request carrying no sections map at all. Gating the
    // warning on `hasSections(request)` removed the diagnostic from every
    // skills-only run — which, until a client ships the field, is every run.
    warnings.length = 0;
    const res = await postSteps({
      steps: ['[skill: deadskill]'],
      sourceLines: [3],
      testFilePath,
      skillsDir,
    });
    expect(res.status).toBe(200);
    const dead = warnings.filter((w) => /never invoked/i.test(w));
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatch(/Orphan/);
  });

  it('reports a section a SKILL EDIT just orphaned, in the same session', async () => {
    // The request bytes are identical across both runs — only the skill file
    // on disk changed. A dedup key built from the request could not see that,
    // so the newly-dead section went unreported for the life of the session,
    // which is exactly when the warning becomes relevant. Deduping on the
    // message has no such blind spot.
    warnings.length = 0;
    const sessionId = nextSession();
    const skillFile = path.join(skillsDir, 'editable.md');
    const body = {
      steps: ['[skill: editable]'],
      sourceLines: [3],
      testFilePath,
      skillsDir,
    };
    const dead = () => warnings.filter((w) => /never invoked/i.test(w));

    // v1: the skill body calls its own `### Alpha`, so nothing is dead.
    await fs.writeFile(
      skillFile,
      ['---', 'type: skill', '---', '# editable', '', '## Steps', '1. Start', '2. Alpha', '', '### Alpha', '1. Alpha body', ''].join('\n'),
    );
    await postSteps(body, sessionId);
    expect(dead()).toEqual([]);

    // v2: the author deletes the call. Same request, different file.
    await fs.writeFile(
      skillFile,
      ['---', 'type: skill', '---', '# editable', '', '## Steps', '1. Start', '', '### Alpha', '1. Alpha body', ''].join('\n'),
    );
    await postSteps(body, sessionId);
    expect(dead()).toHaveLength(1);
    expect(dead()[0]).toMatch(/Alpha/);
  });

  it('reports again after a section BODY changes, not just its names', async () => {
    // A body may hold the only call site for a sibling section, so deleting a
    // line inside one kills a section while every name stays put. Keying the
    // dedup on names alone suppressed exactly that edit.
    warnings.length = 0;
    const sessionId = nextSession();
    const doc = (signInBody: string[]) => ({
      steps: ['Open the shop'],
      sourceLines: [3],
      testFilePath,
      sections: {
        'sign in': { name: 'Sign in', headingLine: 7, steps: signInBody, stepLines: [8, 9].slice(0, signInBody.length) },
        cleanup: { name: 'Cleanup', headingLine: 11, steps: ['Sign out'], stepLines: [12] },
      },
    });

    // v1: the Sign in body calls Cleanup, so only Sign in is dead.
    await postSteps(doc(['Type creds', 'Cleanup']), sessionId);
    const v1 = warnings.filter((w) => /never invoked/i.test(w));
    expect(v1).toHaveLength(1);
    expect(v1[0]).toMatch(/Sign in/);

    // v2: same names, same main flow — the call site is deleted from the
    // body, so Cleanup is now dead too.
    await postSteps(doc(['Type creds']), sessionId);
    const v2 = warnings.filter((w) => /never invoked/i.test(w));
    expect(v2.length).toBeGreaterThan(1);
    expect(v2.join('\n')).toMatch(/Cleanup/);
  });

  it('a first run that fails before expanding does not silence the warning', async () => {
    // Several throwing steps sit between the dedup check and the expansion.
    // Consuming the key up front meant a first run that failed on a malformed
    // config silenced the diagnostic for the rest of the session — and the
    // first run of a document is when a config error is most likely.
    warnings.length = 0;
    const sessionId = nextSession();

    // A test file under a directory with a corrupt aiui.config.json.
    const badDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sections-badcfg-'));
    await fs.writeFile(path.join(badDir, 'aiui.config.json'), '{ not json');
    const badTestFile = path.join(badDir, 'checkout.md');
    await fs.writeFile(badTestFile, '# placeholder\n');

    const body = (file: string) => ({
      steps: ['Open the shop'],
      sourceLines: [3],
      testFilePath: file,
      sections: { cleanup: { name: 'Cleanup', headingLine: 7, steps: ['Sign out'], stepLines: [8] } },
    });

    const first = await postSteps(body(badTestFile), sessionId);
    expect(first.status).toBe(500);
    expect(warnings.filter((w) => /never invoked/i.test(w))).toEqual([]);

    // The author fixes the config and re-runs the same document.
    await fs.writeFile(path.join(badDir, 'aiui.config.json'), '{}');
    const second = await postSteps(body(badTestFile), sessionId);
    expect(second.status).toBe(200);
    expect(warnings.filter((w) => /never invoked/i.test(w))).toHaveLength(1);

    await fs.rm(badDir, { recursive: true, force: true });
  });

  it('reports each distinct dead section once, and repeats none of them', async () => {
    // Dedup is on the MESSAGE, which names the file, the section and the
    // line. So the rule is "every distinct problem is reported once per
    // session" rather than "once per run": an unrelated edit that leaves
    // Cleanup dead in the same place says nothing new, while a SECOND
    // section going dead is a new message and is reported.
    warnings.length = 0;
    const sessionId = nextSession();
    const dead = () => warnings.filter((w) => /never invoked/i.test(w));

    await postSteps(twoSectionBody(), sessionId);
    expect(dead()).toHaveLength(1);
    expect(dead()[0]).toMatch(/Cleanup/);

    // Same session, edited main flow — Cleanup is still dead at line 14, so
    // there is nothing new to say.
    await postSteps(
      twoSectionBody({
        steps: ['Open the shop', 'Sign in', 'Check out', 'And again'],
        sourceLines: [3, 4, 5, 6],
      }),
      sessionId,
    );
    expect(dead()).toHaveLength(1);

    // Now the call to `Sign in` is gone too — a genuinely new problem.
    await postSteps(twoSectionBody({ steps: ['Open the shop'], sourceLines: [3] }), sessionId);
    expect(dead()).toHaveLength(2);
    expect(dead().join('\n')).toMatch(/Sign in/);
  });
});

// ── Re-run anchors ───────────────────────────────────────────────────

describe('startAt on a sectioned document', () => {
  it('anchors on the exact main-flow line, not the first body line at or after it', async () => {
    // A section is DEFINED below the main flow but EXECUTES where it is
    // called, so document order and execution order interleave within one
    // file. `startAt` line 5 means "re-run Check out"; the nearest-line
    // fallback would land on body line 8, silently running the wrong steps.
    executedSteps.length = 0;
    const res = await postSteps(twoSectionBody({ startAt: { uri: testFilePath, line: 5 } }));
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Check out']);
  });

  it('anchors on a body line when that is what was asked for', async () => {
    executedSteps.length = 0;
    const res = await postSteps(twoSectionBody({ startAt: { uri: testFilePath, line: 9 } }));
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Press submit', 'Check out']);
  });

  it('anchors on the section CALL line, resolving to the body it expands to', async () => {
    // Line 4 is `Sign in`, the call. It is the step the user sees fail and
    // the most natural thing to click "re-run from here" on — and it
    // DISAPPEARS from the expansion, so matching only the defining line
    // refuses it outright, blaming a stale file when nothing changed.
    executedSteps.length = 0;
    const res = await postSteps(twoSectionBody({ startAt: { uri: testFilePath, line: 4 } }));
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Type the username', 'Press submit', 'Check out']);
  });

  it('anchors on a call line whose body starts with a skill invocation', async () => {
    // `stepAtAnchor`'s input-line match must NOT require the expanded step to
    // live in the test file: a section whose first body step is `[skill: …]`
    // — the shape of this repo's showcase fixture — expands to a step in the
    // SKILL file, and gating on the uri refused the anchor outright.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Open', 'Do the thing', 'Close'],
      sourceLines: [3, 4, 5],
      testFilePath,
      skillsDir,
      sections: {
        'do the thing': {
          name: 'Do the thing',
          headingLine: 7,
          steps: ['[skill: wave]', 'And finish'],
          stepLines: [8, 9],
        },
      },
      startAt: { uri: testFilePath, line: 4 },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Wave hello', 'And finish', 'Close']);
  });

  it('an end anchor on a call line runs the WHOLE body, not its first step', async () => {
    // "Run to here" on a section call must not log in and never submit, then
    // report the run green. Every step of an invocation shares the call's
    // input line, so keeping the LAST match lands on the body's final step.
    executedSteps.length = 0;
    const res = await postSteps(
      twoSectionBody({
        startAt: { uri: testFilePath, line: 3 },
        endAt: { uri: testFilePath, line: 4 },
      }),
    );
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Open the shop', 'Type the username', 'Press submit']);
  });

  /** Two invocations of one section, so body lines repeat in the expansion. */
  const twiceCalled = (extra: Record<string, unknown> = {}) => ({
    steps: ['Open', 'Sign in', 'Add to cart', 'Sign in', 'Verify'],
    sourceLines: [3, 4, 5, 6, 7],
    testFilePath,
    sections: {
      'sign in': {
        name: 'Sign in',
        headingLine: 9,
        steps: ['Fill the form', 'Verify greeting'],
        stepLines: [10, 11],
      },
    },
    ...extra,
  });

  it('an end anchor on the last MAIN-FLOW line runs the whole document', async () => {
    // The "run everything" case, and the one a client actually produces:
    // runner-core's `extractSteps` is main-flow-only, so a selection reaching
    // the bottom of the file yields the last main-flow line, not a body line.
    executedSteps.length = 0;
    const res = await postSteps(
      twiceCalled({
        startAt: { uri: testFilePath, line: 3 },
        endAt: { uri: testFilePath, line: 7 },
      }),
    );
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual([
      'Open',
      'Fill the form',
      'Verify greeting',
      'Add to cart',
      'Fill the form',
      'Verify greeting',
      'Verify',
    ]);
  });

  it('an end anchor on a repeated body line stops after its LAST occurrence', async () => {
    // Keep-the-last, matching `endAt`'s documented contract and the
    // sectionless path. An earlier attempt at keep-first — meant to stop a
    // one-line range spanning both invocations — silently truncated this to
    // three steps, which is the failure mode worth avoiding: a range that is
    // too wide is visible, one that is too narrow reports green having
    // skipped the work.
    executedSteps.length = 0;
    const res = await postSteps(
      twiceCalled({
        startAt: { uri: testFilePath, line: 3 },
        endAt: { uri: testFilePath, line: 11 },
      }),
    );
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual([
      'Open',
      'Fill the form',
      'Verify greeting',
      'Add to cart',
      'Fill the form',
      'Verify greeting',
    ]);
  });

  it('refuses a START line that is no step at all, rather than snapping to one', async () => {
    // Line 6 is blank in this document — neither a step nor a call. On a
    // skill file the `>=` fallback would snap forward; here that would mean
    // running a section body the user never pointed at.
    const res = await postSteps(twoSectionBody({ startAt: { uri: testFilePath, line: 6 } }));
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error?.message).toMatch(/anchor not found/i);
  });

  it('an END line that is no step degrades instead of failing the run', async () => {
    // Exact matching exists to disambiguate an anchor naming a REAL step when
    // document and execution order interleave. An anchor naming no step has
    // no ambiguity to resolve, so refusing it made a sectioned document
    // hard-fail where a sectionless one degrades — zero steps run, and the
    // message blames a stale file.
    executedSteps.length = 0;
    const res = await postSteps(
      twoSectionBody({
        startAt: { uri: testFilePath, line: 3 },
        endAt: { uri: testFilePath, line: 6 },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).not.toBe('error');
    // The whole expected set, not just "more than zero". Asserting a bound
    // let an inverted fallback — first-preceding instead of LAST-preceding,
    // which silently truncates the run to its first step — pass unnoticed,
    // which is the regression the fallback's own comment warns about.
    //
    // Line 6 sits after the last main-flow line (5), so "run through the last
    // main-flow step at or before this line" is the whole document.
    expect(executedSteps).toEqual([
      'Open the shop',
      'Type the username',
      'Press submit',
      'Check out',
    ]);
  });

  it('a START anchor on a body line that CALLS a skill runs that skill', async () => {
    // The anchored step expands into another frame, so it contributes no
    // step under its own line. Resolving by line alone stepped over the whole
    // skill and started after it — silently, reporting green. The frame
    // ancestry is what makes this exact: the skill frame records line 8 as
    // its invocation line.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Open', 'Do the thing', 'Close'],
      sourceLines: [3, 4, 5],
      testFilePath,
      skillsDir,
      sections: {
        'do the thing': {
          name: 'Do the thing',
          headingLine: 7,
          steps: ['[skill: wave]', 'And finish'],
          stepLines: [8, 9],
        },
      },
      startAt: { uri: testFilePath, line: 8 },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Wave hello', 'And finish', 'Close']);
  });

  it('a START anchor on a body line that calls a NESTED SECTION runs it', async () => {
    // Same shape one level in: line 8 is `Type creds`, itself a call to
    // `### Type creds`. Matching only the top-level input index cannot see
    // this; the ancestry can.
    executedSteps.length = 0;
    const res = await postSteps(twoSectionBody({ startAt: { uri: testFilePath, line: 8 } }));
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Type the username', 'Press submit', 'Check out']);
  });

  it('an anchor does not match a call made at the same line of ANOTHER file', async () => {
    // The ancestry match must compare against the INVOKING file. `nested.md`
    // calls `wave` from its own line 8; the test file's section body also
    // sits at line 8. Without the guard, an anchor of (test file, 8) matches
    // the wave frame — which executes earlier — and the run starts inside a
    // skill the anchor had nothing to do with.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Open', '[skill: nested]', 'Do setup', 'Close'],
      sourceLines: [3, 4, 5, 6],
      testFilePath,
      skillsDir,
      sections: {
        'do setup': { name: 'Do setup', headingLine: 7, steps: ['Body step'], stepLines: [8] },
      },
      startAt: { uri: testFilePath, line: 8 },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Body step', 'Close']);
  });

  it('a body-line anchor does not match a SKILL-file line of the same number', async () => {
    // The match must compare against the INVOKING file. A skill's steps
    // routinely sit on the same small line numbers as a test file's section
    // bodies, and an unguarded comparison started the run inside the skill,
    // re-running work that precedes the section — green.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Open', '[skill: liner]', 'Do setup', 'Close'],
      sourceLines: [3, 4, 5, 6],
      testFilePath,
      skillsDir,
      sections: {
        'do setup': {
          name: 'Do setup',
          headingLine: 8,
          steps: ['First body step', 'Second body step'],
          stepLines: [9, 10],
        },
      },
      // Line 9 specifically: `liner.md`'s third step also sits on line 9 of
      // ITS file, so this is the anchor where the two collide. An earlier
      // version of this test anchored at 10, where nothing collides — it
      // passed with the uri guard removed, which is to say it tested nothing.
      startAt: { uri: testFilePath, line: 9 },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['First body step', 'Second body step', 'Close']);
  });

  it('a MAIN-FLOW start anchor on a step that expanded to nothing walks forward', async () => {
    // A skill with an empty `## Steps` expands to nothing — sections refuse
    // an empty body, skills do not — so no frame carries its invocation line
    // and the ancestry match cannot see it. The walk-forward covers it.
    //
    // This branch shipped broken through two rounds because nothing
    // exercised it; a reviewer showed it could be deleted outright with the
    // whole suite still green.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Open', '[skill: emptyskill]', 'Close'],
      sourceLines: [3, 4, 5],
      testFilePath,
      skillsDir,
      sections: { unused: { name: 'Unused', headingLine: 8, steps: ['Never'], stepLines: [9] } },
      startAt: { uri: testFilePath, line: 4 },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['Close']);
  });

  it('a BODY start anchor on a step that expanded to nothing refuses', async () => {
    // The deliberate counterpart. Walking forward from inside a body would
    // have to guess which enclosing scope to continue in — the rest of this
    // body, or out into the main flow — and `startAt`'s posture is to refuse
    // rather than guess, because a wrong start runs a different set of steps
    // and reports on them as though they were the ones asked for.
    const res = await postSteps({
      steps: ['Open', 'Do setup', 'Close'],
      sourceLines: [3, 4, 5],
      testFilePath,
      skillsDir,
      sections: {
        'do setup': {
          name: 'Do setup',
          headingLine: 7,
          steps: ['[skill: emptyskill]', 'Second body step'],
          stepLines: [8, 9],
        },
      },
      startAt: { uri: testFilePath, line: 8 },
    });
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error?.message).toMatch(/anchor not found/i);
  });

  it('refuses a range that is inverted in EXECUTION order', async () => {
    // Line 5 (`Check out`) is the last main-flow step but executes LAST;
    // line 8 (`Type creds`) is a body line that executes SECOND. So this
    // range runs backwards, and there is no set of steps that honours both
    // anchors.
    //
    // A document-order reading — "everything from line 5 down through the
    // section definitions" — is tempting, and an earlier version did that by
    // falling back and quietly running only `Check out`. But that ignores
    // the end anchor entirely while reporting the run green, which is the
    // failure mode this feature keeps re-introducing. Refuse instead: the
    // user can see the error and pick anchors that mean something.
    //
    // Line 9 (`Press submit`), not line 8: line 8 is itself a call that
    // expands away, so it is not in the expansion at all and takes the
    // no-exact-match-anywhere path rather than this one.
    const res = await postSteps(
      twoSectionBody({
        startAt: { uri: testFilePath, line: 5 },
        endAt: { uri: testFilePath, line: 9 },
      }),
    );
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error?.message).toMatch(/end anchor not found/i);
  });

  it('an end anchor on a step that expanded to nothing falls back, not fails', async () => {
    // Sections refuse an empty body; SKILLS do not, so a skill with an empty
    // `## Steps` contributes no expanded step and its call line has no
    // `inputIndex` at all. Resolving the fallback to it and stopping there
    // refused the run on a real main-flow step, blaming a stale skill file.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Open', '[skill: emptyskill]', 'Close'],
      sourceLines: [3, 4, 5],
      testFilePath,
      skillsDir,
      // Present only to turn exact mode on — this is a section-free flow.
      sections: { unused: { name: 'Unused', headingLine: 8, steps: ['Never'], stepLines: [9] } },
      startAt: { uri: testFilePath, line: 3 },
      endAt: { uri: testFilePath, line: 4 },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).not.toBe('error');
    // Falls back past the zero-expansion call to the step before it.
    expect(executedSteps).toEqual(['Open']);
  });

  it('KNOWN WIDENING: a one-line range on a twice-called body line spans both', async () => {
    // Pinned as a known limitation rather than fixed. `startAt` takes the
    // first match and `endAt` the last, so naming one body line of a section
    // invoked twice covers both invocations and the steps between them.
    //
    // Unchanged from before sections, and matching `endAt`'s documented
    // meaning. It was "fixed" once by making `endAt` keep-first, which
    // truncated two much more common cases instead: an end anchor on a
    // section call ran a fraction of the body, and one on the last body line
    // cut a whole-file run short. Widening a range is visible; narrowing one
    // reports green having skipped the work.
    executedSteps.length = 0;
    const res = await postSteps({
      steps: ['Alpha', 'Middle', 'Alpha'],
      sourceLines: [3, 4, 5],
      testFilePath,
      sections: {
        alpha: { name: 'Alpha', headingLine: 7, steps: ['A one', 'A two'], stepLines: [8, 9] },
      },
      startAt: { uri: testFilePath, line: 8 },
      endAt: { uri: testFilePath, line: 8 },
    });
    expect(res.status).toBe(200);
    expect(executedSteps).toEqual(['A one', 'A two', 'Middle', 'A one']);
  });
});

// ── Cache ────────────────────────────────────────────────────────────

describe('cache hashing on a sectioned document', () => {
  it('a subset batch hashes the full expansion, matching a full run', async () => {
    // Sections bake into step text exactly as skill bodies do. Without the
    // widened `hasSkillsOrSections` argument a subset batch chooses
    // `raw-full` and hashes the UNEXPANDED document, so its bundle hash never
    // matches the one a full run wrote — `StepCache.initialize` sees a stale
    // bundle, wipes it, and a breakpoint resume can never hit the cache.
    //
    // Asserted end to end, over HTTP, by reading the hash the run actually
    // wrote. An earlier version of this test imported `chooseCacheHashSource`
    // and asserted the two-line pure function against itself — which passes
    // even with the CALL SITE reverted to skills-only, i.e. with the entire
    // change undone. It was also the only test in this file not POSTing
    // through the HTTP entry, which the file header calls a hard rule.
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sections-cache-'));
    const projectFile = path.join(cacheRoot, 'checkout.md');
    await fs.writeFile(path.join(cacheRoot, 'aiui.config.json'), JSON.stringify({}));
    await fs.writeFile(projectFile, '# placeholder\n');

    const full = ['Open the shop', 'Sign in', 'Check out'];
    // A sections-only project: no skillsDir at all, which is the case the
    // widened argument exists for.
    const body = (steps: string[], extra: Record<string, unknown> = {}) => ({
      steps,
      sourceLines: steps.length === full.length ? [3, 4, 5] : [5],
      testFilePath: projectFile,
      cacheEnabled: true,
      sections: {
        'sign in': { name: 'Sign in', headingLine: 7, steps: ['Type creds'], stepLines: [8] },
      },
      ...extra,
    });

    const readHash = async (): Promise<string | null> => {
      const found: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full_ = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full_);
          else if (entry.name === 'meta.json') found.push(full_);
        }
      };
      try {
        await walk(cacheRoot);
      } catch {
        return null;
      }
      if (found.length === 0) return null;
      const meta = JSON.parse(await fs.readFile(found[0]!, 'utf-8'));
      return meta.stepsHash ?? null;
    };

    await postSteps(body(full, { fullSteps: full }));
    const fullHash = await readHash();
    expect(fullHash).toBeTruthy();

    // A subset batch — the resume after a breakpoint.
    await postSteps(body(['Check out'], { fullSteps: full }));
    const subsetHash = await readHash();

    expect(subsetHash).toBe(fullHash);

    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  it('a subset batch does not read a per-step cache entry for a non-root frame', async () => {
    // Per-step keys are `${frameId}-${line}` and frame ids are minted per
    // BATCH, so a subset batch's `f1` names a different invocation than the
    // full run's `f1`. With a section body and a skill body both on line 7 of
    // their own files, the resumed batch read the entry the full run wrote
    // for the SKILL step and replayed its action plan — silently, green.
    //
    // The rule (runtime spec §4.3) is to skip per-step cache for non-root
    // frames on a subset batch. Asserted at the `executeStep` seam, which is
    // where the cache is actually consulted.
    cacheFlags.length = 0;
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sections-key-'));
    const projectFile = path.join(cacheRoot, 'checkout.md');
    await fs.writeFile(path.join(cacheRoot, 'aiui.config.json'), JSON.stringify({}));
    await fs.writeFile(projectFile, '# placeholder\n');

    const full = ['Open the shop', 'Sign in', 'Check out'];
    const lineOf: Record<string, number> = { 'Open the shop': 3, 'Sign in': 4, 'Check out': 5 };
    const body = (steps: string[]) => ({
      steps,
      sourceLines: steps.map((s) => lineOf[s]!),
      testFilePath: projectFile,
      cacheEnabled: true,
      fullSteps: full,
      sections: {
        'sign in': { name: 'Sign in', headingLine: 7, steps: ['Type creds'], stepLines: [8] },
      },
    });

    // Full run: every step may use the cache, body steps included.
    await postSteps(body(full));
    expect(cacheFlags.find(([i]) => i === 'Type creds')?.[1]).toBe(true);
    expect(cacheFlags.find(([i]) => i === 'Check out')?.[1]).toBe(true);

    // Subset batch that CONTAINS the section call — otherwise no non-root
    // step executes and the assertion is vacuous. (My first version of this
    // test resumed from 'Check out' alone and passed with the rule removed.)
    cacheFlags.length = 0;
    await postSteps(body(['Sign in', 'Check out']));
    expect(cacheFlags.map(([i]) => i)).toEqual(['Type creds', 'Check out']);
    // The section-body step is in a non-root frame: no read, no write.
    expect(cacheFlags.find(([i]) => i === 'Type creds')?.[1]).toBe(false);
    // The root-frame step keeps its stable key and stays cached.
    expect(cacheFlags.find(([i]) => i === 'Check out')?.[1]).toBe(true);

    await fs.rm(cacheRoot, { recursive: true, force: true });
  });
});
