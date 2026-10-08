/**
 * A step that reads a list cannot end on one that came back empty or mixed
 * before the model has seen it, and a read the model replaced is never
 * compiled (issue #28; src/runner/list-read-review.ts).
 *
 * Found on `templates/init/tests/control-flow.md` step 11, "Read the name of
 * every account in the Your accounts panel [store as: accounts]": the model's
 * selector matched the names (right), the names and the card numbers beside
 * them (6 values), or nothing (0) — and all three runs passed.
 *
 * Layers, each against the real code, on the fixture page the issue was
 * found on:
 *
 *  - the action layer: the issue's three selectors read 3, 6 and 0 values and
 *    say what they matched, kind by kind — with no model, every time;
 *  - the line the model is shown, for an empty read, a mixed read, a pattern
 *    that kept nothing and a count of hidden elements;
 *  - the real step loop (`executeStep`, real Chromium, a scripted model): an
 *    empty or mixed read gets exactly one extra turn carrying that line; a
 *    read of one kind gets none; the model can correct the read or keep it;
 *    a step that would end on a changed read still empty fails, and the retry
 *    is told why;
 *  - the compile: `actionsOf` and `entryFromRecording` over the step's result
 *    write only the read the model stood by;
 *  - the report says what happened to a read that was shown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult, SubActionResult, TestReport } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { executeAction } from '../src/browser/actions.js';
import { formatListReadsSection } from '../src/ai/prompts.js';
import { executeStep } from '../src/runner/step-executor.js';
import { listReadConcern } from '../src/runner/list-read-review.js';
import { actionsOf } from '../src/codebehind/recording.js';
import { entryFromRecording } from '../src/codebehind/generate.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { renderReport } from '../src/report/generator.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://list-read-review.test';

// ── The issue's three selectors ──────────────────────────────────────────────

const STEP = 'Read the name of every account in the Your accounts panel [store as: accounts]';
/** The names, and only the names. */
const RIGHT = '#account-list [data-testid="account-row"] > span > span:first-of-type';
/** The names and the masked card numbers beside them. */
const OVER_BROAD = '#accounts-card [data-testid="account-row"] > span > span';
/** One level too deep: there is no span inside the name span. */
const NOTHING = '#account-list [data-testid="account-row"] > span > span > span:first-child';
/** Another guess that matches nothing. */
const NOTHING_EITHER = '#account-list .account-title';

const NAMES = '["Everyday","Savings","Travel"]';

let browser: Browser;
let fixture: string;

beforeAll(async () => {
  fixture = await fs.readFile(path.join(repoRoot, 'fixtures', 'test-app', 'control-flow.html'), 'utf-8');
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** A fresh page on its own origin: the fixture page, or `body` in its place. */
async function pageWith(body?: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    route.request().url().endsWith('/control-flow.html')
      ? route.fulfill({ status: 200, contentType: 'text/html', body: body ?? fixture })
      : route.fulfill({ status: 404, body: '' }),
  );
  await page.goto(`${ORIGIN}/control-flow.html`);
  return page;
}

function readOf(selector: string, extra: Partial<AIAction> = {}): AIAction {
  return { action: 'read', multiple: true, selector, as: 'accounts', description: 'Read every account name', ...extra };
}

// ── The action layer, with no model ──────────────────────────────────────────

describe('a read of every match says what it matched, kind by kind', () => {
  it('reads 3, 6 and 0 values with the issue\'s three selectors, every time', async () => {
    const page = await pageWith();
    try {
      const right = await executeAction(page, readOf(RIGHT));
      expect(right.capturedValues).toEqual(['Everyday', 'Savings', 'Travel']);
      expect(right.listMatches?.groups).toEqual([
        { kind: 'span.account-name', count: 3, samples: ['Everyday', 'Savings', 'Travel'] },
      ]);

      const broad = await executeAction(page, readOf(OVER_BROAD));
      expect(broad.capturedValues).toHaveLength(6);
      expect(broad.listMatches?.groups).toEqual([
        { kind: 'span.account-name', count: 3, samples: ['Everyday', 'Savings', 'Travel'] },
        { kind: 'span.account-number', count: 3, samples: ['•••• 4417', '•••• 9082', '•••• 3355'] },
      ]);

      const none = await executeAction(page, readOf(NOTHING));
      expect(none.success).toBe(true);
      expect(none.capturedValues).toEqual([]);
      expect(none.listMatches?.groups).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('names kinds the same way for a read of every match and for a count', async () => {
    // The read takes its kinds from its own page call and the count from
    // `describeMatches`: two copies of one rule, which a compiled read's
    // self-check compares across runs (SPEC-codebehind-robustness.md §6.6).
    const page = await pageWith();
    try {
      const read = await executeAction(page, readOf(OVER_BROAD), undefined, undefined, { kinds: true });
      const count = await executeAction(
        page,
        { action: 'count', selector: OVER_BROAD, as: 'n', description: 'count' },
        undefined,
        undefined,
        { kinds: true },
      );
      expect(read.kinds).toEqual(['span.account-name', 'span.account-number']);
      expect(count.kinds).toEqual(read.kinds);
      expect(count.listMatches?.groups.map((g) => [g.kind, g.count])).toEqual([
        ['span.account-name', 3],
        ['span.account-number', 3],
      ]);
    } finally {
      await page.close();
    }
  });
});

// ── The line the model is shown ──────────────────────────────────────────────

describe('the line a list read that came back empty or mixed is shown with', () => {
  it('says the selector matched nothing', async () => {
    const page = await pageWith();
    try {
      const action = readOf(NOTHING);
      const concern = listReadConcern(action, await executeAction(page, action));
      expect(concern).toEqual({
        kind: 'empty',
        name: 'accounts',
        text: `accounts is empty: \`${NOTHING}\` matched nothing on this page.`,
      });
    } finally {
      await page.close();
    }
  });

  it('names each kind with how many and the first values, and says nothing of one kind', async () => {
    const page = await pageWith();
    try {
      const broad = readOf(OVER_BROAD);
      expect(listReadConcern(broad, await executeAction(page, broad))?.text).toBe(
        `accounts holds 6 values from 2 kinds of element: \`${OVER_BROAD}\` matched 6 elements — `
          + 'span.account-name ×3 ("Everyday", "Savings", "Travel"); '
          + 'span.account-number ×3 ("•••• 4417", "•••• 9082", "•••• 3355").',
      );
      const right = readOf(RIGHT);
      expect(listReadConcern(right, await executeAction(page, right))).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it('says what matched when the pattern kept none of it', async () => {
    const page = await pageWith();
    try {
      const action = readOf('#account-list .account-balance', { pattern: '€([\\d.]+)', as: 'balances' });
      const concern = listReadConcern(action, await executeAction(page, action));
      expect(concern?.kind).toBe('empty');
      expect(concern?.text).toContain('matched 3 elements — span.account-balance ×3 ("$1,234.56", "$8,410.00", "$372.19")');
      expect(concern?.text).toContain('the pattern /€([\\d.]+)/ kept none of them');
    } finally {
      await page.close();
    }
  });

  it('says a count of 0 left hidden matches out, and is quiet about a count that found some', async () => {
    const page = await pageWith('<!doctype html><ul><li hidden>Ada</li><li hidden>Ben</li></ul><p class="note">x</p>');
    try {
      const hidden: AIAction = { action: 'count', selector: 'li', as: 'n', description: 'count' };
      expect(listReadConcern(hidden, await executeAction(page, hidden))?.text).toBe(
        'n is 0: `li` matched 2 elements, none of them visible, and a count counts only visible ones.',
      );
      const found: AIAction = { action: 'count', selector: '.note', as: 'n', description: 'count' };
      expect(listReadConcern(found, await executeAction(page, found))).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it('masks what the caller hides, and leaves a single read alone', async () => {
    const page = await pageWith();
    try {
      const action = readOf(OVER_BROAD);
      const result = await executeAction(page, action);
      expect(listReadConcern(action, result, (t) => t.replace(/4417/g, '****'))?.text).not.toContain('4417');
      const single: AIAction = { action: 'read', selector: RIGHT, as: 'first', description: 'read one' };
      expect(listReadConcern(single, await executeAction(page, single))).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it('adds no section to a continuation turn that has none', () => {
    expect(formatListReadsSection(undefined)).toBe('');
    expect(formatListReadsSection([])).toBe('');
    expect(formatListReadsSection(['accounts is empty: `#x` matched nothing on this page.'])).toContain(
      '## Lists to check',
    );
  });
});

// ── The step loop, with a scripted model ─────────────────────────────────────

/** Replays `responses` in order, repeating the last, and keeps every request. */
function scriptedClient(responses: string[]): { client: AiClient; requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const text = responses[Math.min(requests.length, responses.length - 1)]!;
      requests.push(messages);
      return { text, model: 'scripted' };
    },
  } as unknown as AiClient;
  return { client, requests };
}

function plan(action: Record<string, unknown>, needsReeval = false): string {
  return JSON.stringify({ actions: [action], reasoning: 'scripted', needs_reeval: needsReeval });
}

const NOOP = plan({ action: 'noop', description: 'The list is what the step asks for' });

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

function configWith(retries: number): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
    browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false },
    execution: { ...DEFAULT_CONFIG.execution, retries, maxTurns: 5, promptOnAmbiguity: false },
  };
}

/** The real `executeStep` on the fixture page, as a compile run calls it. */
async function runStep(
  responses: string[],
  opts: { retries?: number; instruction?: string } = {},
): Promise<{ result: StepResult; requests: ChatMessage[][]; params: Record<string, string> }> {
  const page = await pageWith();
  try {
    const { client, requests } = scriptedClient(responses);
    const params: Record<string, string> = {};
    const result = await executeStep(1, 1, opts.instruction ?? STEP, {
      page,
      config: configWith(opts.retries ?? 0),
      aiClient: client,
      contextContent: '',
      testName: 'list-read-review',
      conversationHistory: [],
      csrfTokens: {},
      nonInteractive: true,
      resolvedParameters: params,
      // A compile run: measured, so the recording carries what §6.6 compiles.
      captureStepContext: true,
    });
    return { result, requests, params };
  } finally {
    await page.close();
  }
}

/** Every read the step ran, in order, across every attempt. */
function readsOf(result: StepResult): SubActionResult[] {
  return result.turns.flatMap((t) => t.subActions).filter((s) => s.action.action === 'read' || s.action.action === 'count');
}

function bindingFor(source: string): CodeBehindBinding {
  return {
    file: path.resolve(path.sep, 'nowhere', 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
  };
}

/** What §6.6 compiles from the step's result: the entry, and the reads it is written from. */
function compiled(result: StepResult, params: Record<string, string>, source = STEP) {
  const actions = actionsOf(result);
  const entry = entryFromRecording({ binding: bindingFor(source), actions, resolvedParameters: params });
  const reads = actions.filter((a) => a.action === 'read' || a.action === 'count');
  return { selectors: reads.map((a) => a.selector), entry };
}

describe('the step loop shows the model an empty or mixed list read before the step ends', () => {
  it('gives a read that matched nothing exactly one more turn, which corrects it — and compiles only the correction', async () => {
    const { result, requests, params } = await runStep([plan(readOf(NOTHING)), plan(readOf(RIGHT))]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(textOf(requests[0]!)).not.toContain('## Lists to check');
    const second = textOf(requests[1]!);
    expect(second).toContain('## Lists to check');
    expect(second).toContain(`accounts is empty: \`${NOTHING}\` matched nothing on this page.`);
    expect(params.accounts).toBe(NAMES);

    const [wrong, right] = readsOf(result);
    expect(wrong!.listReview).toEqual({
      text: `accounts is empty: \`${NOTHING}\` matched nothing on this page.`,
      outcome: 'replaced',
    });
    expect(right!.listReview).toBeUndefined();

    const { selectors, entry } = compiled(result, params);
    expect(selectors).toEqual([RIGHT]);
    expect(entry).toContain(`selector: '${RIGHT}'`);
    expect(entry).not.toContain(NOTHING);
  });

  it('gives a read of one kind no extra turn', async () => {
    const { result, requests, params } = await runStep([plan(readOf(RIGHT))]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(1);
    expect(params.accounts).toBe(NAMES);
    expect(readsOf(result)[0]!.listReview).toBeUndefined();
    expect(compiled(result, params).selectors).toEqual([RIGHT]);
  });

  it('shows an over-broad read kind by kind, and the narrowed read replaces it', async () => {
    const { result, requests, params } = await runStep([plan(readOf(OVER_BROAD)), plan(readOf(RIGHT))]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    const second = textOf(requests[1]!);
    expect(second).toContain('accounts holds 6 values from 2 kinds of element');
    expect(second).toContain('span.account-number ×3 ("•••• 4417", "•••• 9082", "•••• 3355")');
    expect(params.accounts).toBe(NAMES);
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', undefined]);
    expect(compiled(result, params).selectors).toEqual([RIGHT]);
  });

  it('passes with [] when the model keeps an empty list, and compiles the read it kept', async () => {
    const { result, requests, params } = await runStep([plan(readOf(NOTHING)), NOOP]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(params.accounts).toBe('[]');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('kept');
    // The transcript is the read and the noop that kept it: still a step
    // that only reads, so §6.6 writes it from the recording.
    expect(actionsOf(result).map((a) => a.action)).toEqual(['read', 'noop']);
    const { selectors, entry } = compiled(result, params);
    expect(selectors).toEqual([NOTHING]);
    expect(entry).toContain('fromRecording: true');
    expect(entry).toContain(`selector: '${NOTHING}'`);
  });

  it('keeps a read the model reads the same way again, without a third turn', async () => {
    const { result, requests, params } = await runStep([plan(readOf(NOTHING)), plan(readOf(NOTHING))]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(params.accounts).toBe('[]');
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'kept']);
    expect(compiled(result, params).selectors).toEqual([NOTHING]);
  });

  it('shows the list in a turn the model asked for anyway, and keeps the added turn for later', async () => {
    const { result, requests, params } = await runStep([
      plan(readOf(NOTHING), true),
      plan(readOf(NOTHING_EITHER)),
      NOOP,
    ]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(textOf(requests[1]!)).toContain(`\`${NOTHING}\` matched nothing`);
    expect(textOf(requests[2]!)).toContain(`\`${NOTHING_EITHER}\` matched nothing`);
    expect(textOf(requests[2]!)).not.toContain(`\`${NOTHING}\` matched nothing`);
    expect(params.accounts).toBe('[]');
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'kept']);
  });

  it('fails a step that would end on a changed read still empty, and compiles neither read', async () => {
    const { result, requests, params } = await runStep([plan(readOf(NOTHING)), plan(readOf(NOTHING_EITHER))]);
    expect(result.status).toBe('failed');
    expect(requests).toHaveLength(2);
    expect(result.error).toContain('with no turn left to look at it');
    expect(result.error).toContain(`\`${NOTHING_EITHER}\` matched nothing on this page.`);
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'pending']);
    expect(compiled(result, params).selectors).toEqual([]);
  });

  it('tells the retry what the selector matched, and compiles only the retry\'s read', async () => {
    const { result, requests, params } = await runStep(
      [plan(readOf(NOTHING)), plan(readOf(NOTHING_EITHER)), plan(readOf(RIGHT))],
      { retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    const retry = textOf(requests[2]!);
    expect(retry).toContain(NOTHING_EITHER);
    expect(retry).toContain('matched nothing on this page');
    expect(params.accounts).toBe(NAMES);
    const { selectors, entry } = compiled(result, params);
    expect(selectors).toEqual([RIGHT]);
    expect(entry).not.toContain(NOTHING);
    expect(entry).not.toContain(NOTHING_EITHER);
  });

  it('shows a count of 0 too, and the recount replaces it', async () => {
    const count = (selector: string) => ({ action: 'count', selector, as: 'account_count', description: 'Count the accounts' });
    const { result, requests, params } = await runStep(
      [plan(count('#account-list > li.account-card')), plan(count('#account-list > li'))],
      { instruction: 'Count the accounts in the Your accounts panel [store as: account_count]' },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(textOf(requests[1]!)).toContain('account_count is 0: `#account-list > li.account-card` matched nothing on this page.');
    expect(params.account_count).toBe('3');
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', undefined]);
  });

  it('says in the report what happened to a read the model was shown', async () => {
    const { result } = await runStep([plan(readOf(OVER_BROAD)), plan(readOf(RIGHT))]);
    const report: TestReport = {
      testName: 'list-read-review',
      filePath: path.resolve(path.sep, 'p', 'tests', 'accounts.md'),
      tags: [],
      status: 'passed',
      steps: [result],
      totalSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      totalSubActions: 2,
      durationMs: 1,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      date: new Date(0).toISOString(),
    };
    const html = renderReport(report);
    expect(html).toContain('list read shown to the model, which replaced it with a later read — accounts holds 6 values');
  });
});
