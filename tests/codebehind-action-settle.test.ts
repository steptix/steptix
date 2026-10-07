import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { buildCodeBehindRegistry, type CodeBehindBinding } from '../src/codebehind/loader.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * The wait after a compiled action, in the executor
 * (docs/specs/SPEC-codebehind-robustness.md §6.4): armed before the entry
 * runs, waited on after an entry that ACTS — passed or thrown — before the
 * step's screenshot and before a heal; never after a read-only entry; and
 * what `step.settle()` waits on inside the entry.
 *
 * The watcher itself is unit-tested in tests/action-watcher.test.ts; here it
 * is replaced by one that records when it is asked, in one timeline with what
 * the entry, the screenshot and the model do.
 */

const timeline = vi.hoisted(() => ({
  events: [] as string[],
  /** What the fake page's `url()` answers, and where a call moves it. */
  url: 'http://localhost:8787/index.html',
  urlOnTitle: undefined as string | undefined,
  urlOnSettle: undefined as string | undefined,
}));

vi.mock('../src/browser/page-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/page-state.js')>();
  return {
    ...actual,
    armActionWatcher: () => {
      timeline.events.push('arm');
      return {
        ready: Promise.resolve(),
        settle: async () => {
          timeline.events.push('settle');
          if (timeline.urlOnSettle !== undefined) timeline.url = timeline.urlOnSettle;
          return { waitedMs: 0, tracked: 0, stillPending: [] };
        },
        dispose: () => timeline.events.push('dispose'),
      };
    },
    waitForPageStability: async () => actual.diagnosePageState({} as Page).catch(() => ({})),
    waitForPostActionSettle: async () => {},
    diagnosePageState: async () => ({
      isLoading: false, loadingIndicators: [], hasErrorOverlay: false,
      errorMessages: [], hasModal: false, documentLoading: false,
    }),
  };
});

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: async () => {
    timeline.events.push('screenshot');
    return null;
  },
}));

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<html><body>dom</body></html>') };
});

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      timeline.events.push(`ai-action:${action.action}`);
      return { success: true };
    }),
  };
});

import { executeStep } from '../src/runner/step-executor.js';

let tmpBase: string;
let counter = 0;
let dir: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('action-settle');
});
beforeEach(async () => {
  clearSkillCache();
  timeline.events = [];
  timeline.url = 'http://localhost:8787/index.html';
  timeline.urlOnTitle = undefined;
  timeline.urlOnSettle = undefined;
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await removeScratchBase(tmpBase);
});

const STEP = 'Sign in';

/** A page that records what the entry does to it. */
function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => timeline.url,
    title: async () => {
      timeline.events.push('entry:title');
      if (timeline.urlOnTitle !== undefined) timeline.url = timeline.urlOnTitle;
      return 'SecureBank';
    },
    goto: async (to: string) => {
      timeline.events.push('entry:goto');
      timeline.url = `http://localhost:8787${to}`;
    },
    click: async () => {
      timeline.events.push('entry:click');
    },
    context: () => ({ browser: () => ({}) }),
    evaluate: async () => ({ pass: true }),
    screenshot: async () => Buffer.alloc(24),
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  // Per-action captures on, so a passing entry takes its screenshot — the
  // moment the wait has to come before.
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: true, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

async function bindingFor(body: string): Promise<{ binding: CodeBehindBinding; step: string }> {
  const md = path.join(dir, 'signin.md');
  await fs.writeFile(md, ['# Sign in', '', '## Steps', `1. ${STEP}`, ''].join('\n'), 'utf-8');
  await fs.writeFile(
    path.join(dir, 'signin.steps.ts'),
    `import { defineSteps } from 'steptix/codebehind';\nexport default defineSteps([\n  { source: ${JSON.stringify(STEP)}, async run({ page, step }) { ${body} } },\n]);\n`,
    'utf-8',
  );
  const parsed = await parseTestFile(md);
  const registry = await buildCodeBehindRegistry(
    { steps: parsed.steps, rawSteps: parsed.expansion!.rawSteps, origins: parsed.expansion!.origins, frames: parsed.expansion!.frames },
    { testFilePath: parsed.filePath, onWarn: () => {} },
  );
  return { binding: registry.bindingFor(0)!, step: parsed.steps[0]! };
}

/** A model that records being asked, and answers the healed step with a click. */
function modelThatRecords(): AiClient {
  return {
    complete: async () => {
      timeline.events.push('ai:asked');
      return {
        text: JSON.stringify({
          actions: [{ action: 'click', selector: '#sign-in-btn', description: 'Sign in' }],
          reasoning: 'sign in',
          needs_reeval: false,
        }),
        model: 'stub',
      };
    },
  } as unknown as AiClient;
}

async function run(
  body: string,
  client: AiClient = modelThatRecords(),
  extra: { codeBehindStrict?: boolean } = {},
) {
  const { binding, step } = await bindingFor(body);
  timeline.events = [];
  const result = await executeStep(1, 1, step, {
    ...extra,
    page: fakePage(),
    config: CONFIG,
    aiClient: client,
    contextContent: '',
    testName: 'signin',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    codeBehind: binding,
  });
  return { result, events: [...timeline.events] };
}

describe('the wait after a compiled action (§6.4)', () => {
  it('waits after a passing entry that acts — before the step\'s screenshot', async () => {
    const { result, events } = await run("await page.click('#sign-in-btn');");
    expect(result.status).toBe('passed');
    expect(result.fromCodeBehind).toBe(true);
    expect(events).toEqual(['arm', 'entry:click', 'settle', 'screenshot', 'dispose']);
  });

  it('waits after an acting entry that threw — before the heal asks the model anything', async () => {
    const { result, events } = await run("await page.click('#sign-in-btn'); throw new Error('#dashboard never appeared');");
    expect(result.codeBehindStale?.error).toContain('#dashboard never appeared');
    const settle = events.indexOf('settle');
    expect(settle).toBeGreaterThan(events.indexOf('entry:click'));
    expect(settle).toBeLessThan(events.indexOf('ai:asked'));
  });

  it('does not wait after a read-only entry', async () => {
    const { result, events } = await run("step.setVar('title', await page.title());");
    expect(result.status).toBe('passed');
    expect(events).toEqual(['arm', 'entry:title', 'screenshot', 'dispose']);
  });

  it('step.settle() inside the entry waits on the watcher armed for it', async () => {
    const { result, events } = await run(
      "await page.click('#sign-in-btn'); await step.settle(); step.expect((await page.title()) !== '', 'a title');",
    );
    expect(result.status).toBe('passed');
    expect(events).toEqual(['arm', 'entry:click', 'settle', 'entry:title', 'settle', 'screenshot', 'dispose']);
  });
});

describe('a failed entry names a navigation it ran into (§6.8)', () => {
  const SIGN_IN_PAGE = 'http://localhost:8787/index.html';
  const DASHBOARD = 'http://localhost:8787/dashboard.html';
  const NOTE =
    `The page navigated from ${SIGN_IN_PAGE} to ${DASHBOARD} while this entry ran. ` +
    'The previous step may not wait for its navigation.';

  it('says so in the stale error when the URL changed while the entry ran', async () => {
    timeline.urlOnTitle = DASHBOARD;
    const { result } = await run("await page.title(); throw new Error('#cookie-reject never appeared');");
    expect(result.codeBehindStale?.error).toBe(`#cookie-reject never appeared. ${NOTE}`);
  });

  it('leaves the error as thrown when the page stayed put', async () => {
    const { result } = await run("await page.title(); throw new Error('#cookie-reject never appeared');");
    expect(result.codeBehindStale?.error).toBe('#cookie-reject never appeared');
  });

  it('says nothing of a navigation the entry asked for itself', async () => {
    const { result } = await run("await page.goto('/dashboard.html'); throw new Error('no #welcome');");
    expect(result.codeBehindStale?.error).toBe('no #welcome');
  });

  it('says nothing of a navigation that lands during the wait after the entry', async () => {
    timeline.urlOnSettle = DASHBOARD;
    const { result } = await run("await page.click('#cookie-reject'); throw new Error('no banner');");
    expect(result.codeBehindStale?.error).toBe('no banner');
  });

  it('says so on a strict replay too, where the error is the step\'s', async () => {
    timeline.urlOnTitle = DASHBOARD;
    const { result } = await run(
      "await page.title(); throw new Error('#cookie-reject never appeared');",
      modelThatRecords(),
      { codeBehindStrict: true },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe(`#cookie-reject never appeared. ${NOTE}`);
  });
});
