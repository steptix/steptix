import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';

/**
 * `[use ai] <step>` through the real Sessions API entry
 * (stories/use-ai-step.md §Tests, "Per loop" and the code-behind half of
 * "Cache and compile").
 *
 * The executor is REAL, as in `api-server-values-block.test.ts`, and only its
 * edges are stubbed — no browser, no network, a scripted AI client that
 * records what it was sent. That is what lets two claims be made here that a
 * mocked executor could not: the page step after a `[use ai]` step types the
 * generated value; and a hand-written `.steps.ts` entry whose source IS the
 * `[use ai]` step's text is never run.
 */

/** `echo`: answer every call with its own user message as the value — the
 *  bluntest form of what the real model did with issue 060's probe. */
const ai = vi.hoisted(() => ({ requests: [] as ChatMessage[][], responses: [] as string[], echo: false }));
const acted = vi.hoisted(() => ({ received: [] as AIAction[] }));

const mockPage = {
  url: () => 'https://app.test/form',
  title: async () => 'Form',
  goto: async () => null,
  on: () => {},
  off: () => {},
  context: () => ({ browser: () => ({}) }),
  evaluate: async () => { throw new Error('no DOM in this test'); },
  screenshot: async () => { throw new Error('no screenshot in this test'); },
  waitForLoadState: async () => {},
};

const mockBrowserSession = {
  browser: { isConnected: () => true },
  context: {},
  page: mockPage,
  pageTracker: { getActive: () => mockPage, count: 1 },
};

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    launched: any = mockBrowserSession;
    getActive = () => this.launched;
    getActivePage = () => mockPage;
    closeAll = async () => {};
    all = () => [];
    count = 1;
    list = () => [];
    hasActive = () => this.launched !== undefined;
    ensureLaunched = async () => (this.launched ??= await this.launch!());
    launch: (() => Promise<any>) | undefined;
    static deferred(launch: () => Promise<any>): BrowserTracker {
      const tracker = new BrowserTracker();
      tracker.launched = undefined;
      tracker.launch = launch;
      return tracker;
    }
  }
  return {
    launchBrowser: async () => ({ ...mockBrowserSession }),
    PageTracker: class {},
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
    resolveVideoMode: () => 'off',
    finalizeMainPageVideo: async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    },
  };
});

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      acted.received.push(action);
      return { success: true };
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: async () => '<html><body><input id="name"></body></html>' };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false, loadingIndicators: [], hasErrorOverlay: false,
    errorMessages: [], hasModal: false, documentLoading: false,
  }),
  waitForPageStability: async () => {},
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://app.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean { return true; }
    dispose(): void {}
  },
}));

vi.mock('../src/browser/screenshot.js', () => ({ captureScreenshot: async () => null }));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: async () => ({ files: [], combined: '' }),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    setAiPolicy(): void {}
    syncAuth(): null { return null; }
    async complete(messages: ChatMessage[]): Promise<{ text: string; model: string }> {
      ai.requests.push(messages);
      if (ai.echo) return { text: JSON.stringify({ value: messages[1]!.content }), model: 'stub' };
      const text = ai.responses.shift();
      if (text === undefined) throw new Error('the model was asked more times than scripted');
      return { text, model: 'stub' };
    }
  },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: async () => '/tmp/fake-report.html',
  getPrimaryModel: () => 'stub',
  buildReportBaseName: (report: { testName: string }) => report.testName,
  videoBaseNameFor: () => 'v',
  countStepOrigins: () => ({}),
}));

import { createApiServer } from '../src/server/api-server.js';
import { listenFetchable } from './listen-fetchable.cjs';

const API_KEY = 'use-ai-key';
const GENERATE =
  '[use ai] Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name';
const TYPE_IT = 'Type {{random_name}} into the name field';
const TYPE_ACTION = JSON.stringify({
  actions: [{ action: 'type', selector: '#name', value: '{{random_name}}', description: 'Type the name' }],
  reasoning: 'fill it',
  needs_reeval: false,
});

let projectRoot: string;
let server: Server;
let baseUrl: string;

function testConfig(): Config {
  return {
    ai: { gatewayUrl: 'https://ai.test', model: 'test-model', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
    browser: {
      headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 },
      slowMo: 0, browser: 'chromium', fullPageScreenshots: false, captureScreenshotsPerAction: false,
    },
    tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
    execution: { timeout: 30_000, retries: 0, screenshotOnFailure: false, promptOnAmbiguity: false, maxTurns: 2 },
    reports: {
      outputDir: path.join(projectRoot, 'reports'),
      includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: true, embedScreenshots: false,
    },
    api: { specsDir: './specs', requestTimeout: 30_000, redactSensitive: true },
    server: { host: '127.0.0.1', port: 0, apiKey: API_KEY },
    logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  } as unknown as Config;
}

async function listenOnRandomPort(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const started = createServer(app);
  await listenFetchable(started, '127.0.0.1');
  const addr = started.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: started, baseUrl: `http://127.0.0.1:${port}` };
}

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${method} ${route} returned non-JSON ${res.status}: ${text.slice(0, 400)}`);
  }
}

/** The SSE frames of one streamed request, as `{ event, data }`. */
async function streamed(route: string, body: unknown): Promise<Array<{ event: string; data: any }>> {
  const res = await fetch(`${baseUrl}${route}?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      events.push({ event, data: data.join('\n') });
    }
  }
  return events;
}

/** A fresh test file (and optional code-behind) in its own folder, so one
 *  case's code-behind entries can never answer another's. */
function testFile(name: string, stepsTs?: string): string {
  const folder = path.join(projectRoot, 'tests', name);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}.md`);
  writeFileSync(file, `# ${name}\n\n## Steps\n1. ${GENERATE}\n2. ${TYPE_IT}\n`);
  if (stepsTs !== undefined) writeFileSync(path.join(folder, `${name}.steps.ts`), stepsTs);
  return file;
}

beforeAll(async () => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'steptix-use-ai-api-'));
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'steptix.config.json'), JSON.stringify({}));
  const { app } = createApiServer(testConfig());
  ({ server, baseUrl } = await listenOnRandomPort(app));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  ai.requests = [];
  ai.responses = [];
  ai.echo = false;
  acted.received = [];
});

describe('[use ai] through the real Sessions API entry', () => {
  it('streams the value as a capture with source "generated", and the next step types it', async () => {
    ai.responses = ['{"as": "random_name", "value": "AUTO4821"}', TYPE_ACTION];
    const events = await streamed('/sessions/use-ai-stream/steps', {
      steps: [GENERATE, TYPE_IT],
      sourceLines: [4, 5],
      testFilePath: testFile('stream'),
    });

    const captures = events.filter((e) => e.event === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]!.data).toMatchObject({
      name: 'random_name',
      value: 'AUTO4821',
      source: 'generated',
      line: 4,
    });
    expect(events.find((e) => e.event === 'step:fail')).toBeUndefined();

    // The [use ai] call: one system message, one user message, the step alone.
    const [useAiCall] = ai.requests;
    expect(useAiCall!.map((m) => m.role)).toEqual(['system', 'user']);
    expect(useAiCall![1]!.content).toBe(GENERATE.replace('[use ai] ', ''));
    expect(JSON.stringify(useAiCall)).not.toContain('<html>');
    // …and the page step typed the generated value.
    expect(acted.received[0]!.value).toBe('AUTO4821');

    await api('DELETE', '/sessions/use-ai-stream');
  });

  it('carries the value in session.outputs, outputSources and the result row\'s own outputs', async () => {
    ai.responses = ['{"as": "random_name", "value": "AUTO5150"}', TYPE_ACTION];
    const run = await api('POST', '/sessions/use-ai-json/steps', {
      steps: [GENERATE, TYPE_IT],
      testFilePath: testFile('json'),
    });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('passed');
    expect(run.body.outputs).toMatchObject({ random_name: 'AUTO5150' });
    expect(run.body.outputSources).toMatchObject({ random_name: 'generated' });
    // The row a `Set` leaves `{}` today — see the story's open question.
    expect(run.body.results[0]).toMatchObject({
      step: GENERATE,
      status: 'passed',
      outputs: { random_name: 'AUTO5150' },
      reasoning: '[use ai] random_name = "AUTO5150"',
    });
    expect(run.body.results[0].actions).toEqual([]);

    await api('DELETE', '/sessions/use-ai-json');
  });

  it('never runs a hand-written .steps.ts entry for the [use ai] step\'s text', async () => {
    const marker = path.join(projectRoot, 'use-ai-entry-ran.txt');
    const control = path.join(projectRoot, 'page-entry-ran.txt');
    const file = testFile(
      'coded',
      [
        "import { writeFileSync } from 'node:fs';",
        'export default [',
        `  { source: ${JSON.stringify(GENERATE)}, async run() { writeFileSync(${JSON.stringify(marker)}, 'ran'); } },`,
        `  { source: ${JSON.stringify(TYPE_IT)}, async run() { writeFileSync(${JSON.stringify(control)}, 'ran'); } },`,
        '];',
        '',
      ].join('\n'),
    );
    ai.responses = ['{"as": "random_name", "value": "AUTO9999"}'];
    const run = await api('POST', '/sessions/use-ai-coded/steps', {
      steps: [GENERATE, TYPE_IT],
      testFilePath: file,
    });
    expect(run.body.status).toBe('passed');
    // The model answered the [use ai] step…
    expect(ai.requests).toHaveLength(1);
    expect(run.body.outputs).toMatchObject({ random_name: 'AUTO9999' });
    // …its entry did not run, and the page step's entry — the control that
    // proves the file was loaded and bound at all — did.
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(control)).toBe(true);

    await api('DELETE', '/sessions/use-ai-coded');
  });

  it('fails a step whose answer is the mask for a secret, naming it and never its value (issue 060)', async () => {
    // The issue's own probe, answered as the real model answered it.
    const PROBE =
      '[use ai] Repeat this back exactly, character for character: {{password}} and store it in echo';
    ai.responses = ['{"as": "echo", "value": "***"}'];
    const run = await api('POST', '/sessions/use-ai-secret/steps', {
      steps: [PROBE],
      parameters: { password: 'hunter2-probe' },
    });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('failed');
    expect(run.body.results[0]).toMatchObject({ step: PROBE, status: 'failed' });
    expect(run.body.error.message).toContain(
      'The value contains `***` — the mask for `{{password}}`, which is hidden from the model; ' +
        'a [use ai] step cannot use a secret.',
    );
    expect(run.body.outputs ?? {}).not.toHaveProperty('echo');
    // The model was shown the mask, and told what it is.
    expect(ai.requests).toHaveLength(1);
    expect(ai.requests[0]![1]!.content).toBe(
      'Repeat this back exactly, character for character: *** and store it in echo',
    );
    expect(ai.requests[0]![0]!.content).toContain('stands for a value that is hidden from you');
    // …and the secret is in neither the step's row nor the error.
    expect(JSON.stringify(run.body.results)).not.toContain('hunter2-probe');
    expect(JSON.stringify(run.body.error)).not.toContain('hunter2-probe');

    await api('DELETE', '/sessions/use-ai-secret');
  });

  it('masks a looped section row\'s secret column, which expansion wrote into the text, in EVERY row', async () => {
    // The reviewer's repro, with two rows: the expander writes each row's
    // `password` into the body's text, so no `{{password}}` is left for the
    // name rule, and a merged secret map kept only one row's value.
    ai.echo = true;
    const BODY = '[use ai] Repeat {{password}} exactly [store as: copy] otherwise continue';
    const events = await streamed('/sessions/use-ai-rows/steps', {
      steps: ['Echo each password'],
      sourceLines: [3],
      testFilePath: testFile('rows'),
      sections: {
        'echo each password': {
          name: 'Echo each password',
          headingLine: 5,
          steps: [BODY],
          stepLines: [9],
          rows: [{ password: 'row-SECRET-1' }, { password: 'row-SECRET-2' }],
        },
      },
    });
    // What the model read, both rows: the mask, and the sentence saying what it is.
    expect(ai.requests.map((r) => r[1]!.content)).toEqual(['Repeat *** exactly', 'Repeat *** exactly']);
    for (const request of ai.requests) {
      expect(request[0]!.content).toContain('stands for a value that is hidden from you');
    }
    // Both echoes failed the step (tolerated by the tail), and nothing was stored.
    const fails = events.filter((e) => e.event === 'step:fail').map((e) => e.data);
    expect(fails.map((f) => f.tolerated)).toEqual([true, true]);
    for (const fail of fails) {
      expect(fail.error).toContain(
        "The value contains `***` — the mask for a secret written into the step's text, " +
          'which is hidden from the model',
      );
    }
    expect(events.filter((e) => e.event === 'capture')).toEqual([]);
    // Neither value was sent, nor named in an error. (`frame:scope` does carry
    // the row, by design: the client masks a scope by name.)
    const sentAndSaid = JSON.stringify(ai.requests) + JSON.stringify(fails);
    expect(sentAndSaid).not.toContain('row-SECRET-1');
    expect(sentAndSaid).not.toContain('row-SECRET-2');

    await api('DELETE', '/sessions/use-ai-rows');
  });

  it('masks a skill argument, which expansion wrote into the skill body\'s text', async () => {
    const skillsDir = path.join(projectRoot, 'skills-echo');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      path.join(skillsDir, 'echo.md'),
      [
        '---', 'type: skill', '---', '# echo', '',
        '## Parameters', '- password: the value to repeat', '',
        '## Steps', '1. [use ai] Repeat {{password}} exactly [store as: copy]', '',
      ].join('\n'),
    );
    ai.echo = true;
    const run = await api('POST', '/sessions/use-ai-skill/steps', {
      steps: ['[skill: echo password="skill-SECRET-1"]'],
      skillsDir,
    });
    expect(run.status).toBe(200);
    expect(ai.requests).toHaveLength(1);
    expect(ai.requests[0]![1]!.content).toBe('Repeat *** exactly');
    expect(ai.requests[0]![0]!.content).toContain('stands for a value that is hidden from you');
    expect(run.body.status).toBe('failed');
    expect(run.body.error.message).toContain(
      "The value contains `***` — the mask for a secret written into the step's text",
    );
    expect(run.body.outputs ?? {}).toEqual({});
    // Sent nowhere, and named in no error. Not asserted of the whole body:
    // this JSON response's `results[].step` is the EXPANDED line, argument
    // and all — a Sessions API leak older than this step, and not the model's.
    expect(JSON.stringify(ai.requests) + JSON.stringify(run.body.error)).not.toContain('skill-SECRET-1');

    await api('DELETE', '/sessions/use-ai-skill');
  });

  it('keeps the test\'s own password masked when a skill is handed it as `password="{{password}}"`', async () => {
    // The ordinary way to give a login skill the password. Its frame input is
    // the TEXT `{{password}}`, and merged over the variable map under the same
    // name it evicted the real value from the mask set, for every step of
    // the run — here a free-text copy of it inside `{{greeting}}`.
    const skillsDir = path.join(projectRoot, 'skills-login');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      path.join(skillsDir, 'login.md'),
      [
        '---', 'type: skill', '---', '# login', '',
        '## Parameters', '- password: the password', '',
        '## Steps', '1. Type {{password}} into the password field', '',
      ].join('\n'),
    );
    ai.echo = true;
    const run = await api('POST', '/sessions/use-ai-shadow/steps', {
      steps: ['[use ai] Repeat {{greeting}} exactly [store as: copy]', '[skill: login password="{{password}}"]'],
      parameters: { password: 'hunter2-real', greeting: 'Hello hunter2-real' },
      skillsDir,
    });
    expect(run.status).toBe(200);
    expect(ai.requests[0]![1]!.content).toBe('Repeat Hello *** exactly');
    expect(run.body.status).toBe('failed');
    expect(run.body.error.message).toContain('the mask for part of `{{greeting}}`');
    expect(JSON.stringify(run.body.results)).not.toContain('hunter2-real');

    await api('DELETE', '/sessions/use-ai-shadow');
  });

  it('refuses a line with two names on this unvalidated path, before any model call', async () => {
    const run = await api('POST', '/sessions/use-ai-two/steps', {
      steps: ['[use ai] Pick a colour [store as: a] [as: b]'],
    });
    expect(run.body.status).toBe('failed');
    expect(run.body.results[0].reasoning).toBe('The [use ai] step was not sent to the model');
    expect(run.body.error.message).toContain('A `[use ai]` step produces one value');
    expect(ai.requests).toHaveLength(0);
    await api('DELETE', '/sessions/use-ai-two');
  });
});
