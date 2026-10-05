/**
 * stories/codebehind-selector-ambiguity.md — "Where the measurement goes".
 *
 * One field, threaded down a pipe that already exists: `ActionExecutionResult`
 * gains `targeting`, the sub-action record carries it onto `SubActionResult`,
 * `actionsOf` merges it into the transcript generation reads, and the
 * recording writes it to disk.
 *
 * The ordering in that sentence is the security property. `recording.ts`
 * writes actions as `actionsOf(result).map((a) => redactDeep(a, secrets))`, so
 * a `targeting` merged in after that map would skip redaction entirely — and a
 * `resolvedSelector` can be built from an `aria-label` or an `href` carrying a
 * secret. The last test here is that leak, asserted against the bytes on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Config } from '../src/config/types.js';
import type { AiClient } from '../src/ai/client.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_BROWSER_DIMENSIONS } from '../src/config/browser-dimensions.js';
import { executeStep } from '../src/runner/step-executor.js';
import { actionsOf as actionsOfFromCandidate } from '../src/codebehind/candidate.js';
import { actionsOf, recordingDirFor, writeRecording } from '../src/codebehind/recording.js';

// ─── A mock page that can be measured ────────────────────────────────────────

interface MeasuredPage {
  page: Page;
  /** Every locator selector the action path asked for, in order. */
  selectors: string[];
  visibleCount: () => number;
  clicks: number;
}

/**
 * A Page whose locator chain answers the two counts separately, the way a real
 * one does: `locator(sel)` counts every match and `locator(sel)
 * .locator('visible=true')` counts the visible ones.
 */
function makeMeasuredPage(opts: {
  matchCount: number;
  visibleMatchCount: number;
  /** What the browser-side builder returns: a verified selector and how it was
   *  arrived at, or null when nothing verified. */
  resolved?: { selector: string; by: 'attribute' | 'scoped' | 'positional' } | null;
}): MeasuredPage {
  const selectors: string[] = [];
  let clicks = 0;

  const visible: Record<string, unknown> = {};
  visible['first'] = vi.fn().mockReturnValue(visible);
  visible['count'] = vi.fn().mockImplementation(() => Promise.resolve(opts.visibleMatchCount));
  visible['waitFor'] = vi.fn().mockResolvedValue(undefined);
  visible['evaluate'] = vi.fn().mockImplementation(() =>
    Promise.resolve(opts.resolved ?? null),
  );
  visible['click'] = vi.fn().mockImplementation(() => { clicks++; return Promise.resolve(); });
  visible['hover'] = vi.fn().mockResolvedValue(undefined);
  visible['clear'] = vi.fn().mockResolvedValue(undefined);
  visible['fill'] = vi.fn().mockResolvedValue(undefined);

  const base: Record<string, unknown> = {};
  base['locator'] = vi.fn().mockReturnValue(visible);
  base['first'] = vi.fn().mockReturnValue(base);
  base['count'] = vi.fn().mockImplementation(() => Promise.resolve(opts.matchCount));
  base['waitFor'] = vi.fn().mockResolvedValue(undefined);
  base['evaluate'] = vi.fn().mockImplementation(() =>
    Promise.resolve(opts.resolved ?? null),
  );

  const page = {
    url: vi.fn().mockReturnValue('https://app.example.com/'),
    content: vi.fn().mockResolvedValue('<html><body></body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fakepng')),
    viewportSize: vi.fn().mockReturnValue({ ...DEFAULT_BROWSER_DIMENSIONS }),
    locator: vi.fn().mockImplementation((sel: string) => { selectors.push(sel); return base; }),
    $eval: vi.fn().mockResolvedValue(''),
    evaluate: vi.fn().mockResolvedValue(null),
    waitForSelector: vi.fn().mockResolvedValue(null),
    waitForURL: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(null),
    waitForFunction: vi.fn().mockResolvedValue(null),
    waitForTimeout: vi.fn().mockResolvedValue(null),
    goto: vi.fn().mockResolvedValue(null),
    mouse: { wheel: vi.fn().mockResolvedValue(null) },
    keyboard: { press: vi.fn().mockResolvedValue(null) },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Page;

  return {
    page,
    selectors,
    visibleCount: () => opts.visibleMatchCount,
    get clicks() { return clicks; },
  } as MeasuredPage;
}

function makeConfig(ambiguousTarget?: 'first' | 'fail'): Config {
  return {
    ai: { gatewayUrl: '', model: 'test', maxInputTokens: 1000, streamResponses: false },
    browser: {
      headed: false,
      viewport: { ...DEFAULT_BROWSER_DIMENSIONS },
      windowSize: { ...DEFAULT_BROWSER_DIMENSIONS },
      slowMo: 0,
      browser: 'chromium',
      fullPageScreenshots: true,
      captureScreenshotsPerAction: false,
      ...(ambiguousTarget !== undefined && { ambiguousTarget }),
    },
    tests: { dir: '.', contextDir: '.', pattern: '**/*.md' },
    execution: {
      timeout: 30_000,
      retries: 0,
      screenshotOnFailure: false,
      promptOnAmbiguity: false,
      maxTurns: 3,
    },
    reports: {
      outputDir: '.',
      includeScreenshots: false,
      includeDomSnapshots: false,
      includeAiReasoning: false,
      embedScreenshots: true,
    },
    api: { specsDir: '.', requestTimeout: 5_000, redactSensitive: false },
  } as Config;
}

function makeAiClient(response: string): AiClient {
  return {
    complete: vi.fn().mockImplementation(() =>
      Promise.resolve({ text: response, model: 'test-model' }),
    ),
  } as unknown as AiClient;
}

const CLICK_TURN = JSON.stringify({
  actions: [{ action: 'click', selector: '#login', description: 'Click sign in' }],
  reasoning: 'Sign in.',
  needs_reeval: false,
});

describe('the measurement rides the sub-action record', () => {
  it('carries what the runtime found onto SubActionResult in a compile mode', async () => {
    const mock = makeMeasuredPage({
      matchCount: 2,
      visibleMatchCount: 1,
      resolved: { selector: '#site-header a[href="/login"]', by: 'scoped' },
    });

    const result = await executeStep(1, 1, 'sign in', {
      page: mock.page,
      config: makeConfig(),
      aiClient: makeAiClient(CLICK_TURN),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      captureStepContext: true,
    });

    expect(result.status).toBe('passed');
    const sub = result.turns[0]!.subActions[0]!;
    expect(sub.targeting).toEqual({
      matchCount: 2,
      visibleMatchCount: 1,
      resolvedSelector: '#site-header a[href="/login"]',
      resolvedBy: 'scoped',
    });
  });

  it('measures nothing on an ordinary run — the same gate captureStepContext uses', async () => {
    const mock = makeMeasuredPage({ matchCount: 2, visibleMatchCount: 1, resolved: { selector: '#x', by: 'attribute' } });

    const result = await executeStep(1, 1, 'sign in', {
      page: mock.page,
      config: makeConfig(),
      aiClient: makeAiClient(CLICK_TURN),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
    });

    expect(result.status).toBe('passed');
    expect(result.turns[0]!.subActions[0]!.targeting).toBeUndefined();
  });

  // The `ambiguousTarget: 'fail'` exception: it decides by reading the visible
  // count, so it works whatever the mode — including an ordinary run with no
  // `captureStepContext`.
  it("honours ambiguousTarget: 'fail' on an ordinary run, and the failure names the count", async () => {
    const mock = makeMeasuredPage({ matchCount: 3, visibleMatchCount: 3 });

    const result = await executeStep(1, 1, 'sign in', {
      page: mock.page,
      config: makeConfig('fail'),
      aiClient: makeAiClient(CLICK_TURN),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
      nonInteractive: true,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('3 visible elements matched');
    expect(mock.clicks).toBe(0);
  });

  it("proceeds under ambiguousTarget: 'first'", async () => {
    const mock = makeMeasuredPage({ matchCount: 3, visibleMatchCount: 3 });

    const result = await executeStep(1, 1, 'sign in', {
      page: mock.page,
      config: makeConfig('first'),
      aiClient: makeAiClient(CLICK_TURN),
      contextContent: '',
      testName: 'test',
      conversationHistory: [],
      csrfTokens: {},
    });

    expect(result.status).toBe('passed');
    expect(mock.clicks).toBe(1);
  });
});

// ─── actionsOf: the merge seam ───────────────────────────────────────────────

function stepWith(subActions: StepResult['turns'][number]['subActions']): StepResult {
  return {
    index: 1,
    instruction: 'sign in',
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: '2026-08-27T00:00:00.000Z',
        aiInteractions: [],
        subActions,
      },
    ],
    durationMs: 10,
    retried: false,
  };
}

describe('actionsOf — the transcript generation reads', () => {
  it('is one implementation, whichever module you import it from', () => {
    expect(actionsOfFromCandidate).toBe(actionsOf);
  });

  it('merges targeting onto the action', () => {
    const actions = actionsOf(
      stepWith([
        {
          index: 1,
          action: { action: 'click', selector: 'a[href="/login"]', description: 'Sign in' },
          targeting: { matchCount: 2, visibleMatchCount: 1, resolvedSelector: '#nav a', resolvedBy: 'scoped' },
          durationMs: 1,
        },
      ]),
    );

    expect(actions).toEqual([
      {
        action: 'click',
        selector: 'a[href="/login"]',
        description: 'Sign in',
        targeting: { matchCount: 2, visibleMatchCount: 1, resolvedSelector: '#nav a', resolvedBy: 'scoped' },
      },
    ]);
  });

  // Absence stays first-class: a transcript with no targeting is exactly the
  // transcript generation read before the measurement existed.
  it('leaves an unmeasured action untouched', () => {
    const action = { action: 'click', selector: '#go', description: 'Go' } as const;
    const actions = actionsOf(stepWith([{ index: 1, action, durationMs: 1 }]));
    expect(actions).toEqual([action]);
    expect(actions[0]).not.toHaveProperty('targeting');
  });

  // A wait that timed out is recorded WITH an error, so it never reaches
  // generation — there is nothing to compile from an action that did not
  // happen, measured or not.
  it('drops an errored sub-action, measurement or no measurement', () => {
    const actions = actionsOf(
      stepWith([
        { index: 1, action: { action: 'click', selector: '#ok' }, durationMs: 1 },
        {
          index: 2,
          action: { action: 'click', selector: '#ghost' },
          durationMs: 1,
          error: 'Timeout 10000ms exceeded',
        },
      ]),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.selector).toBe('#ok');
  });

  it('survives a step that never ran', () => {
    expect(actionsOf(undefined)).toEqual([]);
  });
});

// ─── The recording: redaction happens after the merge, never before ──────────

describe('the recording on disk', () => {
  // A directory of its own per test, removed after it: a fixed path would be
  // shared with any other vitest process in this checkout, whose clean-up
  // could delete it mid-test.
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stx-targeting-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('writes the measurement alongside the action', async () => {
    const test = path.join(dir, 'checkout.md');
    await writeRecording(test, {
      steps: [
        stepWith([
          {
            index: 1,
            action: { action: 'click', selector: 'a[href="/login"]', description: 'Sign in' },
            targeting: { matchCount: 2, visibleMatchCount: 1, resolvedSelector: '#nav > a', resolvedBy: 'positional' },
            durationMs: 1,
          },
        ]),
      ],
      status: 'passed',
      startedAt: '2026-08-27T00:00:00.000Z',
      parameters: {},
      source: 'cli',
    });

    const written = JSON.parse(
      await fs.readFile(path.join(recordingDirFor(test), 'step-01.json'), 'utf-8'),
    ) as { actions: Array<{ targeting?: Record<string, unknown> }> };

    expect(written.actions[0]!.targeting).toEqual({
      matchCount: 2,
      visibleMatchCount: 1,
      resolvedSelector: '#nav > a',
      resolvedBy: 'positional',
    });
  });

  // The leak the ordering constraint exists to prevent: a selector built from
  // an aria-label that carries a secret value.
  it('redacts a secret carried inside a resolvedSelector', async () => {
    const test = path.join(dir, 'checkout.md');
    await writeRecording(test, {
      steps: [
        stepWith([
          {
            index: 1,
            action: { action: 'click', selector: 'button', description: 'Confirm' },
            targeting: {
              matchCount: 2,
              visibleMatchCount: 1,
              resolvedSelector: 'button[aria-label="Confirm with hunter2"]',
              resolvedBy: 'scoped',
            },
            durationMs: 1,
          },
        ]),
      ],
      status: 'passed',
      startedAt: '2026-08-27T00:00:00.000Z',
      parameters: { password: 'hunter2' },
      source: 'cli',
    });

    const file = path.join(recordingDirFor(test), 'step-01.json');
    const raw = await fs.readFile(file, 'utf-8');

    // Asserted against the bytes, not the parsed object: a leak is a leak in
    // whatever shape it reaches the disk.
    expect(raw).not.toContain('hunter2');

    const written = JSON.parse(raw) as {
      actions: Array<{ targeting?: { resolvedSelector?: string } }>;
    };
    expect(written.actions[0]!.targeting?.resolvedSelector).toContain('***');
    expect(written.actions[0]!.targeting?.matchCount).toBe(2);
  });
});
