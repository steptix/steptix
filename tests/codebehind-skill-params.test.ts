/**
 * Skill parameters through the compile: does generated code for a skill body
 * step retrieve the value the CALLER passed in?
 *
 * The chain under test (stories/step-codebehind.md "Skill variables",
 * stories/compile-as-you-go.md): the expander inlines a declared parameter's
 * value into the body step TEXT but keeps the authored `{{username}}` on
 * `rawSteps`, which is what the binding and the generation prompt see; the
 * caller's argument survives on the frame's `inputs`. Generation must
 * therefore (1) show the model the AUTHORED text, (2) map `username` to the
 * passed value so the model writes `step.getVar('username')`, and (3) hold
 * that value in the leak guard so an inlined literal is discarded. Runtime
 * retrieval of the passed value by authored name is covered in
 * codebehind-vars.test.ts; this file proves the GENERATION half at the seam
 * (real api-server + session manager + expander + live compiler; browser,
 * executor and model mocked).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks — mirrors api-server-compile-mode.test.ts
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com/form'),
  title: vi.fn(async () => 'Form'),
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

/** Every instruction the (mocked) executor was asked to run, in order. */
const stepCalls: string[] = [];

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (
    stepIndex: number,
    _totalSteps: number,
    instruction: string,
    opts: Record<string, unknown>,
  ): Promise<StepResult> => {
    stepCalls.push(instruction);
    return {
      index: stepIndex,
      instruction,
      status: 'passed',
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [
            // The recorded run typed the RESOLVED value — the transcript
            // always carries literals; the mapping back to a name is the
            // generation prompt's job.
            { index: 1, action: { action: 'type', selector: '#user', text: 'Alice' }, durationMs: 3 },
          ],
        },
      ],
      durationMs: 5,
      retried: false,
      aiExplanation: 'ok',
      pageUrl: 'https://example.com/form',
      ...(opts['captureStepContext'] === true && {
        stepContext: {
          domBefore: '<html><body><input id="user"/></body></html>',
          urlBefore: 'https://example.com/',
          domAfter: '<html><body><h1>Hello</h1></body></html>',
          urlAfter: 'https://example.com/form',
        },
      }),
    } as StepResult;
  }),
  executeBranchedStep: vi.fn(async () => []),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: 'PROJECT CONTEXT' })),
}));

const aiPrompts: string[] = [];
/** When set, the next generation answers use this entry body verbatim. */
let forcedEntryBody: string | null = null;

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    chat = vi.fn(async () => '{}');
    setAiPolicy = vi.fn();
    syncAuth = vi.fn(() => null);
    complete = vi.fn(async (messages: { role: string; content: string }[]) => {
      const last = messages[messages.length - 1]?.content ?? '';
      aiPrompts.push(last);
      if (/Review a generated Playwright code-behind file/.test(last)) {
        const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(last);
        return { text: JSON.stringify({ file: fenced?.[1] ?? 'export default defineSteps([]);\n' }) };
      }
      const quoted = /\n\s*source:\s*("(?:[^"\\]|\\.)*")/.exec(last);
      const source = quoted?.[1] ? (JSON.parse(quoted[1]) as string) : 'step';
      const body =
        forcedEntryBody ??
        `await ctx.page.locator('#user').fill(ctx.step.getVar('username') ?? '');`;
      return {
        text: JSON.stringify({
          entry: `{ source: ${JSON.stringify(source)}, async run(ctx) { ${body} } }`,
        }),
      };
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

const API_KEY = 'skill-params-key';
const AUTHORED = 'Type {{username}} into the user box';

const testConfig: Config = {
  ...DEFAULT_CONFIG,
  browser: { ...DEFAULT_CONFIG.browser, headed: false },
  server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0, apiKey: API_KEY },
  logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
};

let server: Server;
let baseUrl: string;
let tmpDir: string;
let testFilePath: string;
let skillsDir: string;
let skillStepsPath: string;
let dataRefTestPath: string;
let compositeTestPath: string;
let chainTestPath: string;
let sessionSeq = 0;

beforeAll(async () => {
  const { app } = createApiServer(testConfig);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (typeof addr === 'object' && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-params-'));
  skillsDir = path.join(tmpDir, 'skills');
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, 'greet.md'),
    [
      '---', 'type: skill', '---', '# greet', '',
      '## Parameters', '- username: who to greet', '',
      '## Steps',
      `1. ${AUTHORED}`,
      '',
    ].join('\n'),
  );
  skillStepsPath = path.join(skillsDir, 'greet.steps.ts');
  testFilePath = path.join(tmpDir, 't.md');
  await fs.writeFile(
    testFilePath,
    ['# T', '', '## Steps', '1. [skill: greet username="Alice"]', ''].join('\n'),
  );

  // The ${data.username} variant: a project root (marker + env + data file)
  // and a test whose skill ARGUMENT is an env-data reference.
  await fs.writeFile(path.join(tmpDir, 'aiui.config.json'), '{}\n');
  await fs.writeFile(path.join(tmpDir, '.env.dev'), '# empty\n');
  await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'data', 'dev.json'),
    JSON.stringify({ username: 'Alice', city: 'Paris' }),
  );
  dataRefTestPath = path.join(tmpDir, 'tdata.md');
  await fs.writeFile(
    dataRefTestPath,
    ['# TData', '', '## Steps', '1. [skill: greet username="${data.username}"]', ''].join('\n'),
  );

  // Composite argument: {{param}} and ${data.*} mixed in one value.
  compositeTestPath = path.join(tmpDir, 'tcomposite.md');
  await fs.writeFile(
    compositeTestPath,
    [
      '# TComposite', '',
      '## Parameters', '- name: Bob', '',
      '## Steps', '1. [skill: greet username="Hello {{name}} from ${data.city}"]', '',
    ].join('\n'),
  );

  // Chained skills: outer's declared param is inlined as raw TEXT into its
  // body, so whatever the test passed travels verbatim into greet's inputs.
  await fs.writeFile(
    path.join(skillsDir, 'outer.md'),
    [
      '---', 'type: skill', '---', '# outer', '',
      '## Parameters', '- who: who to hand to greet', '',
      '## Steps', '1. [skill: greet username="{{who}}"]', '',
    ].join('\n'),
  );
  chainTestPath = path.join(tmpDir, 'tchain.md');
  await fs.writeFile(
    chainTestPath,
    ['# TChain', '', '## Steps', '1. [skill: outer who="${data.username}"]', ''].join('\n'),
  );
});

afterAll(async () => {
  await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  stepCalls.length = 0;
  aiPrompts.length = 0;
  forcedEntryBody = null;
  await fs.rm(skillStepsPath, { force: true });
  await fs.rm(path.join(skillsDir, '.aiui-codebehind-cache'), { recursive: true, force: true });
  await fs.rm(path.join(tmpDir, '.aiui-codebehind-cache'), { recursive: true, force: true });
});

async function compileRun(
  overrides: Record<string, unknown> = {},
): Promise<{ type: string; [k: string]: any }[]> {
  sessionSeq += 1;
  const res = await fetch(`${baseUrl}/sessions/skill-params-${sessionSeq}/steps?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify({
      steps: ['[skill: greet username="Alice"]'],
      sourceLines: [4],
      testFilePath,
      skillsDir,
      compile: 'run',
      ...overrides,
    }),
  });
  expect(res.status).toBe(200);
  return readSse(res);
}

/** The data-ref variant: the skill argument is `${data.username}`. */
const compileDataRefRun = () =>
  compileRun({
    steps: ['[skill: greet username="${data.username}"]'],
    testFilePath: dataRefTestPath,
    envName: 'dev',
  });

async function readSse(res: Response): Promise<{ type: string; [k: string]: any }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: { type: string; [k: string]: any }[] = [];
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (data.length > 0) {
          try { frames.push(JSON.parse(data.join('\n'))); } catch { /* keep-alive */ }
        }
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value2 = (colon < 0 ? '' : line.slice(colon + 1)).replace(/^ /, '');
      if (field === 'data') data.push(value2);
    }
  }
  return frames;
}

describe('a skill invoked with a parameter, compiled', () => {
  it('the run itself typed the resolved value (the expander inlined it into the text)', async () => {
    await compileRun();
    expect(stepCalls.some((s) => s.includes('Alice'))).toBe(true);
    expect(stepCalls.some((s) => s.includes('{{username}}'))).toBe(false);
  });

  it('generation sees the AUTHORED text and the username → Alice mapping', async () => {
    await compileRun();
    const generation = aiPrompts.find((p) => p.includes('user box') && !/Review a generated/.test(p));
    expect(generation).toBeDefined();
    // The source the entry must bind to is the authored skill text…
    expect(generation!).toContain(AUTHORED);
    // …and the prompt maps the authored name to the caller's value, which is
    // what lets the model write step.getVar('username') instead of 'Alice'.
    expect(generation!).toContain('username');
    expect(generation!).toContain('Alice');
  });

  it("proposes the entry in the SKILL's own .steps.ts, reading the value via getVar", async () => {
    const frames = await compileRun();
    const result = frames.find((f) => f.type === 'compile:result');
    expect(result).toBeDefined();
    const files = result!.files as Record<string, string>;
    const skillFile = Object.keys(files).find((f) => path.resolve(f) === path.resolve(skillStepsPath));
    expect(skillFile, `expected a proposal for ${skillStepsPath}, got: ${Object.keys(files).join(', ')}`)
      .toBeDefined();
    // Prettier may re-quote the source string, so match the text itself.
    expect(files[skillFile!]).toContain(AUTHORED);
    expect(files[skillFile!]).toContain("getVar('username')");
    expect(files[skillFile!]).not.toContain('Alice');
  });

  it('discards a generated entry that inlines the passed-in value', async () => {
    forcedEntryBody = `await ctx.page.locator('#user').fill('Alice');`;
    const frames = await compileRun();
    const result = frames.find((f) => f.type === 'compile:result');
    expect(result).toBeDefined();
    // The guard held the caller's value: the inlining answer was discarded,
    // so nothing proposes the literal.
    for (const content of Object.values(result!.files as Record<string, string>)) {
      expect(content).not.toContain('Alice');
    }
    const all = JSON.stringify(frames);
    expect(all).toMatch(/discarded|as a literal/);
  });
});

describe('a skill invoked with a ${data.*} argument, compiled', () => {
  it('the run itself typed the resolved value', async () => {
    await compileDataRefRun();
    expect(stepCalls.some((s) => s.includes('Alice'))).toBe(true);
    expect(stepCalls.some((s) => s.includes('${data.username}'))).toBe(false);
  });

  it('generation maps username to the VALUE, not the placeholder text', async () => {
    await compileDataRefRun();
    const generation = aiPrompts.find((p) => p.includes('user box') && !/Review a generated/.test(p));
    expect(generation).toBeDefined();
    expect(generation!).toContain(AUTHORED);
    // If inputs kept the raw placeholder, the prompt would tell the model
    // username = "${data.username}" while the transcript typed Alice — the
    // model then has no way to connect the literal to the name.
    expect(generation!).not.toContain('${data.username}"');
    expect(generation!).toContain('Alice');
  });

  it('discards a generated entry that inlines the resolved data value', async () => {
    forcedEntryBody = `await ctx.page.locator('#user').fill('Alice');`;
    const frames = await compileDataRefRun();
    const result = frames.find((f) => f.type === 'compile:result');
    expect(result).toBeDefined();
    for (const content of Object.values(result!.files as Record<string, string>)) {
      expect(content).not.toContain('Alice');
    }
    expect(JSON.stringify(frames)).toMatch(/discarded|as a literal/);
  });
});

describe('a composite argument — {{param}} and ${data.*} in one value', () => {
  const compileComposite = () =>
    compileRun({
      steps: ['[skill: greet username="Hello {{name}} from ${data.city}"]'],
      testFilePath: compositeTestPath,
      envName: 'dev',
      parameters: { name: 'Bob' },
    });

  it('generation maps the name to the fully resolved value', async () => {
    await compileComposite();
    const generation = aiPrompts.find((p) => p.includes('user box') && !/Review a generated/.test(p));
    expect(generation).toBeDefined();
    expect(generation!).toContain('Hello Bob from Paris');
    expect(generation!).not.toContain('${data.city}');
    expect(generation!).not.toContain('{{name}}"');
  });

  it('discards a generated entry that inlines the composite value', async () => {
    forcedEntryBody = `await ctx.page.locator('#user').fill('Hello Bob from Paris');`;
    const frames = await compileComposite();
    const result = frames.find((f) => f.type === 'compile:result');
    expect(result).toBeDefined();
    for (const content of Object.values(result!.files as Record<string, string>)) {
      expect(content).not.toContain('Hello Bob from Paris');
    }
    expect(JSON.stringify(frames)).toMatch(/discarded|as a literal/);
  });
});

describe('chained skills — ${data.*} handed through an outer skill', () => {
  // outer's declared param `who` is inlined as raw text into its body, so
  // `[skill: outer who="${data.username}"]` becomes greet's
  // `username="${data.username}"` — two hops, resolved once, at read time.
  const compileChain = () =>
    compileRun({
      steps: ['[skill: outer who="${data.username}"]'],
      testFilePath: chainTestPath,
      envName: 'dev',
    });

  it('generation maps the innermost name to the value, through both hops', async () => {
    await compileChain();
    const generation = aiPrompts.find((p) => p.includes('user box') && !/Review a generated/.test(p));
    expect(generation).toBeDefined();
    expect(generation!).toContain(AUTHORED);
    expect(generation!).toContain('Alice');
    expect(generation!).not.toContain('${data.username}"');
    expect(generation!).not.toContain('{{who}}"');
  });

  it("still proposes the entry in greet's own file, reading via getVar", async () => {
    const frames = await compileChain();
    const result = frames.find((f) => f.type === 'compile:result');
    expect(result).toBeDefined();
    const files = result!.files as Record<string, string>;
    const skillFile = Object.keys(files).find((f) => path.resolve(f) === path.resolve(skillStepsPath));
    expect(skillFile).toBeDefined();
    expect(files[skillFile!]).toContain("getVar('username')");
    expect(files[skillFile!]).not.toContain('Alice');
  });
});
