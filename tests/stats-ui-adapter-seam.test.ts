/**
 * The scoreboard at the Runner UI's seam (docs/specs/SPEC-scoreboard.md §5.7,
 * §15 "At the seam"; finding 1): a looped section's `password` column.
 *
 * The expander writes a section row's values into the step TEXT, where no
 * variable map holds them, so the only way they are masked is a mask set built
 * with the run's frame inputs (`runSecretsWithInputs`). The Runner UI built its
 * set without them, and a probe wrote `"stepText":"Type ui-SECRET-row1 into the
 * password field"` and the selector the model wrote around the same value to
 * the month file — and its own report carried the same gap.
 *
 * Real `UIRunnerAdapter`, real parser and expander, the REAL step executor and
 * AI client, and the REAL report generator. Stubbed: the browser and its page,
 * the DOM reader, the config loader (to a temp project), and the gateway
 * library under the client.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AIAction } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

// ─── The model: a scripted gateway under the real AiClient ───────────────────

const gw = vi.hoisted(() => ({
  respond: (_text: string): { text: string; usage?: { input_tokens: number; output_tokens: number } } => {
    throw new Error('no responder set');
  },
}));

vi.mock('@pkent/aigateway', () => {
  const textOf = (messages: Array<{ content: unknown }>): string =>
    messages
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'),
      )
      .join('\n');
  class FakeGateway {
    static providers(): unknown[] {
      return [];
    }
    async chat(messages: Array<{ content: unknown }>) {
      const reply = gw.respond(textOf(messages));
      return {
        model: 'aibroker/test/model',
        content: [{ type: 'text', text: reply.text }],
        ...(reply.usage && { usage: reply.usage }),
      };
    }
    stream(): never {
      throw new Error('this suite does not stream');
    }
  }
  return { AIGateway: FakeGateway, default: FakeGateway };
});

// ─── The browser: a page with no DOM ─────────────────────────────────────────

const mockPage = {
  url: () => 'https://secure.bank.test/login',
  title: async () => 'Login',
  goto: async () => null,
  on: () => {},
  off: () => {},
  context: () => ({ browser: () => ({}) }),
  evaluate: async () => {
    throw new Error('no DOM in this test');
  },
  screenshot: async () => {
    throw new Error('no screenshot in this test');
  },
  waitForLoadState: async () => {},
};

vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: async () => ({
    browser: { isConnected: () => true },
    context: {},
    page: mockPage,
    pageTracker: { getActive: () => mockPage, count: 1 },
  }),
  closeBrowser: async () => {},
}));

vi.mock('../src/browser/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser/actions.js')>()),
  executeAction: vi.fn(async (_page: unknown, _action: AIAction) => ({
    success: true,
    targeting: { matchCount: 1, visibleMatchCount: 1 },
  })),
}));

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser/dom-cleaner.js')>()),
  captureDomSnapshot: async () => '<html><body><input placeholder="password"></body></html>',
}));

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false,
    loadingIndicators: [],
    hasErrorOverlay: false,
    errorMessages: [],
    hasModal: false,
    documentLoading: false,
  }),
  waitForPageStability: async () => {},
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://secure.bank.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean {
      return true;
    }
    dispose(): void {}
  },
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: async () => null,
  toDataUri: (b: string) => `data:image/png;base64,${b}`,
}));
vi.mock('../src/context/loader.js', () => ({ loadContextFiles: async () => ({ files: [], combined: '' }) }));

const loaded = vi.hoisted(() => ({ config: undefined as unknown }));
vi.mock('../src/config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/loader.js')>()),
  loadConfig: async () => structuredClone(loaded.config),
}));

import { UIRunnerAdapter } from '../src/ui/main/runner-adapter.js';
import { flushStatsWrites, readStatsLines } from '../src/stats/store.js';
import type { StatsActionLine, StatsRunLine, StatsStepLine } from '../src/stats/types.js';
import type { UserRootDeps } from '../src/env/user-root.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SECRET = 'ui-SECRET-row1';
const originalCwd = process.cwd();
let tmp: string;
let userRoot: string;
let deps: UserRootDeps;
let root: string;
const savedEnv: Record<string, string | undefined> = {};

function testConfig(reports: string): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: {
      ...DEFAULT_CONFIG.ai,
      apiKey: 'test-key',
      model: 'aibroker/test/model',
      streamResponses: false,
      sendScreenshots: false,
      diagnoseFailures: false,
    },
    browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false },
    execution: { ...DEFAULT_CONFIG.execution, retries: 0, screenshotOnFailure: false, promptOnAmbiguity: false },
    reports: { ...DEFAULT_CONFIG.reports, outputDir: reports, openInBrowserAfterRun: false, appendRunHistoryToTestFile: false },
    logging: { ...DEFAULT_CONFIG.logging, consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  };
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-stats-ui-seam-')));
  userRoot = path.join(tmp, 'user-root');
  fs.mkdirSync(userRoot, { recursive: true });
  for (const key of ['AIUI_STATS', 'AIUI_STATS_SUITE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
  delete process.env['AIUI_STATS'];
  delete process.env['AIUI_STATS_SUITE'];
  process.env['LOCALAPPDATA'] = userRoot;
  process.env['XDG_CONFIG_HOME'] = userRoot;
  deps = { env: { LOCALAPPDATA: userRoot, XDG_CONFIG_HOME: userRoot }, platform: process.platform };
});

afterAll(async () => {
  await flushStatsWrites();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await flushStatsWrites();
  fs.rmSync(path.join(userRoot, 'aiui', 'stats'), { recursive: true, force: true });
  root = path.join(tmp, `proj-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'aiui.config.json'), '{}');
  loaded.config = testConfig(path.join(root, 'reports'));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe('the Runner UI masks a looped section row\'s secret everywhere it records it (finding 1)', () => {
  it('the step text, the selector the model wrote around it, and the report', async () => {
    const file = path.join(root, 'tests', 'section-secret.md');
    fs.writeFileSync(
      file,
      [
        '# Section secret',
        '',
        '## Steps',
        '1. Sign in each user',
        '',
        '### Sign in each user',
        '| username | password |',
        '|----------|----------|',
        `| alice | ${SECRET} |`,
        '',
        '1. Type {{password}} into the password field',
        '',
      ].join('\n'),
    );
    // The model names the field by the value it was handed — page-derived
    // text in a selector, the case §5.7 masks selectors for.
    gw.respond = () => ({
      text: JSON.stringify({
        actions: [{ action: 'type', selector: `input[placeholder="${SECRET}"]`, value: SECRET, description: 'type it' }],
        reasoning: 'typing',
        needs_reeval: false,
      }),
      usage: { input_tokens: 100, output_tokens: 5 },
    });

    const events: Array<{ channel: string; data: unknown }> = [];
    const adapter = new UIRunnerAdapter((channel, data) => events.push({ channel, data }));
    await adapter.start(file, []);
    expect(events.filter((e) => e.channel === 'runner:error')).toEqual([]);
    await flushStatsWrites();

    // The month file: the value nowhere, the placeholder of it where it was.
    const dir = path.join(userRoot, 'aiui', 'stats');
    const onDisk = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf-8')).join('');
    expect(onDisk).not.toContain(SECRET);
    const { lines } = await readStatsLines({ deps });
    const step = lines.find((l): l is StatsStepLine => l.kind === 'step')!;
    const action = lines.find((l): l is StatsActionLine => l.kind === 'action')!;
    expect(step.stepText).toBe('Type *** into the password field');
    expect(action.selector).toBe('input[placeholder="***"]');
    expect(action.form).toBe('css-other');

    // The report it links: the adapter's own redaction had the same gap.
    const runLine = lines.find((l): l is StatsRunLine => l.kind === 'run')!;
    expect(runLine.report).toBeTruthy();
    const html = fs.readFileSync(runLine.report!, 'utf-8');
    expect(html).toContain('Type *** into the password field');
    expect(html).not.toContain(SECRET);

    // And what the panel was told as the step started.
    const started = events.filter((e) => e.channel === 'runner:step-start').map((e) => JSON.stringify(e.data));
    expect(started.join('')).not.toContain(SECRET);
  });
});
