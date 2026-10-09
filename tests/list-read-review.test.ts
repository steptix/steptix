/**
 * A step that reads a list does not end on one that came back empty or mixed
 * before the model has seen it, while it has a turn to show it in, and never
 * fails for it; the compile uses only a read that proves its selector
 * (steptix/steptix#48, which #28 was merged into;
 * src/runner/list-read-review.ts).
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
 *    empty or mixed read is shown to the model in the next turn, and a changed
 *    read again, for as long as the step has turns; a read of one kind is not
 *    shown; the model can correct the read or keep it; with no turn left —
 *    the last one, or a `return` — the step ends on the read as it came back,
 *    and passes;
 *  - the compile: `actionsOf` keeps only the step's own read, across attempts;
 *    a step that ended on an empty read, or on one the model never saw, is no
 *    evidence, and both compilers write no entry for it — while a loop pass
 *    that read items still compiles;
 *  - the report says what happened to a read, and flags one the model never saw.
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
import { listReadConcern, uncheckedListRead, unprovenListRead } from '../src/runner/list-read-review.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { actionsOf, evidenceRows, isEvidencePass } from '../src/codebehind/recording.js';
import { entryFromRecording } from '../src/codebehind/generate.js';
import { compileTest, type CompileEvent, type CompileRunner } from '../src/codebehind/compile.js';
import { generationRefusal, LiveCompiler, type LiveCompileEvent } from '../src/codebehind/live-compile.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { renderReport } from '../src/report/generator.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

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

function plan(action: Record<string, unknown> | Record<string, unknown>[], needsReeval = false): string {
  const actions = Array.isArray(action) ? action : [action];
  return JSON.stringify({ actions, reasoning: 'scripted', needs_reeval: needsReeval });
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

function configWith(retries: number, maxTurns = 5): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
    browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false },
    execution: { ...DEFAULT_CONFIG.execution, retries, maxTurns, promptOnAmbiguity: false },
  };
}

/** The real `executeStep` on the fixture page, as a compile run calls it. */
async function runStep(
  responses: string[],
  opts: { retries?: number; maxTurns?: number; instruction?: string } = {},
): Promise<{ result: StepResult; requests: ChatMessage[][]; params: Record<string, string> }> {
  const page = await pageWith();
  try {
    const { client, requests } = scriptedClient(responses);
    const params: Record<string, string> = {};
    const instruction = opts.instruction ?? STEP;
    const claim = parseFlowControlStep(instruction);
    const result = await executeStep(1, 1, instruction, {
      page,
      config: configWith(opts.retries ?? 0, opts.maxTurns),
      aiClient: client,
      contextContent: '',
      testName: 'list-read-review',
      conversationHistory: [],
      csrfTokens: {},
      nonInteractive: true,
      resolvedParameters: params,
      // A compile run: measured, so the recording carries what §6.6 compiles.
      captureStepContext: true,
      // What every runner computes off the authored line first.
      ...(claim !== undefined && { flowControlClaim: claim }),
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

function bindingFor(source: string, file = path.resolve(path.sep, 'nowhere', 'x.steps.ts')): CodeBehindBinding {
  return { file, source, occurrence: 0, scope: { renames: {}, inputs: {} } };
}

/** What §6.6 compiles from the step's result: the entry, and the reads it is written from. */
function compiled(result: StepResult, params: Record<string, string>, source = STEP) {
  const actions = actionsOf(result);
  const entry = entryFromRecording({ binding: bindingFor(source), actions, resolvedParameters: params });
  const reads = actions.filter((a) => a.action === 'read' || a.action === 'count');
  return { selectors: reads.map((a) => a.selector), entry };
}

const EMPTY_REASON =
  '{{accounts}} came back empty on the recording run, and a read that finds nothing proves nothing about its selector';

describe('the step loop shows the model an empty or mixed list read before the step ends', () => {
  it('gives a read that matched nothing one more turn, which corrects it — and compiles only the correction', async () => {
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
      kind: 'empty',
      text: `accounts is empty: \`${NOTHING}\` matched nothing on this page.`,
      outcome: 'replaced',
    });
    expect(right!.listReview).toBeUndefined();

    expect(unprovenListRead(result)).toBeUndefined();
    expect(isEvidencePass(result)).toBe(true);
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

  it('passes with [] when the model keeps an empty list, and gives the compile nothing to stand on', async () => {
    const { result, requests, params } = await runStep([plan(readOf(NOTHING)), NOOP]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(params.accounts).toBe('[]');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('kept');
    // The recording keeps what happened: the read, and the noop that kept it.
    expect(actionsOf(result).map((a) => a.action)).toEqual(['read', 'noop']);
    // The compile does not use it. On a page with no accounts the right
    // selector matches nothing too, so this read proves nothing about its own.
    expect(unprovenListRead(result)).toEqual({ kind: 'empty', name: 'accounts', reason: EMPTY_REASON });
    expect(isEvidencePass(result)).toBe(false);
  });

  it('keeps a read the model reads the same way again, without a third turn', async () => {
    const { result, requests, params } = await runStep([plan(readOf(NOTHING)), plan(readOf(NOTHING))]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(params.accounts).toBe('[]');
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'kept']);
    expect(compiled(result, params).selectors).toEqual([NOTHING]);
    expect(unprovenListRead(result)?.kind).toBe('empty');
  });

  it('shows the list in a turn the model asked for anyway', async () => {
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

  it('shows a changed read that is still empty again, for as long as the step has turns', async () => {
    // Before steptix/steptix#48's decision one added turn was all a step got,
    // and this failed the step on its second empty read.
    const { result, requests, params } = await runStep([
      plan(readOf(NOTHING)),
      plan(readOf(NOTHING_EITHER)),
      plan(readOf(RIGHT)),
    ]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(textOf(requests[1]!)).toContain(`\`${NOTHING}\` matched nothing`);
    expect(textOf(requests[2]!)).toContain(`\`${NOTHING_EITHER}\` matched nothing`);
    expect(params.accounts).toBe(NAMES);
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'replaced', undefined]);
    expect(unprovenListRead(result)).toBeUndefined();
    expect(compiled(result, params).selectors).toEqual([RIGHT]);
  });

  it('never fails a step for its list: with no turn left it ends on the read as it came back', async () => {
    // Two turns: the read in turn 1 is shown in turn 2, and the read the
    // model changes it to in turn 2 has no turn to be shown in.
    const { result, requests, params } = await runStep(
      [plan(readOf(NOTHING)), plan(readOf(NOTHING_EITHER))],
      { maxTurns: 2 },
    );
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(false);
    expect(requests).toHaveLength(2);
    expect(params.accounts).toBe('[]');
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'unseen']);
    expect(unprovenListRead(result)?.kind).toBe('empty');
  });

  it('ends on a mixed read the model never saw as read, and the compile will not use it', async () => {
    const { result, requests, params } = await runStep([plan(readOf(OVER_BROAD))], { maxTurns: 1 });
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(1);
    expect(JSON.parse(params.accounts!)).toHaveLength(6);
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('unseen');
    expect(unprovenListRead(result)).toEqual({
      kind: 'unchecked',
      name: 'accounts',
      reason: 'the step ended on its read of {{accounts}} on the recording run before the model could check what it matched',
    });
    expect(isEvidencePass(result)).toBe(false);
  });

  it('ends on a list read the step returned after as read, unseen', async () => {
    const instruction = 'If the Your accounts panel lists no accounts then return';
    const { result, requests, params } = await runStep(
      [plan([readOf(NOTHING), { action: 'return', description: 'The panel lists no accounts' }])],
      { instruction },
    );
    expect(result.status).toBe('passed');
    expect(result.flowControl?.kind).toBe('return');
    expect(requests).toHaveLength(1);
    expect(params.accounts).toBe('[]');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('unseen');
    expect(unprovenListRead(result)?.kind).toBe('empty');
  });

  it('compiles only the retry\'s read when an attempt failed before the model answered', async () => {
    // Attempt 1 reads nothing and is shown it, and its next turn fails on
    // something else. The retry reads the names, which stores over the first
    // attempt's read: that read was never the step's.
    const { result, requests, params } = await runStep(
      [plan(readOf(NOTHING)), plan({ action: 'click', selector: '#account-list ]]', description: 'Open the list' }), plan(readOf(RIGHT))],
      { retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(true);
    expect(requests).toHaveLength(3);
    expect(params.accounts).toBe(NAMES);
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['pending', undefined]);
    expect(unprovenListRead(result)).toBeUndefined();
    const { selectors, entry } = compiled(result, params);
    expect(selectors).toEqual([RIGHT]);
    expect(entry).not.toContain(NOTHING);
  });

  it('gives the compile nothing when the step kept a value an attempt that failed never resolved', async () => {
    // The retry does not read again: the step ends on attempt 1's empty read,
    // which the model never answered. Before this, the transcript dropped
    // that read and kept the noop, so a compile would have written a step
    // that stores nothing at all.
    const { result, params } = await runStep(
      [plan(readOf(NOTHING)), plan({ action: 'click', selector: '#account-list ]]', description: 'Open the list' }), NOOP],
      { retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(params.accounts).toBe('[]');
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['pending']);
    expect(actionsOf(result).map((a) => a.action)).toEqual(['read', 'noop']);
    expect(unprovenListRead(result)).toEqual({ kind: 'empty', name: 'accounts', reason: EMPTY_REASON });
    // …and the report flags it: the model never answered the read the step kept.
    expect(uncheckedListRead(result)).toBe('accounts');
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
    expect(unprovenListRead(result)).toBeUndefined();
  });

  it('gives the compile nothing for a count of 0 the model kept', async () => {
    const instruction = 'Count the accounts in the Your accounts panel [store as: account_count]';
    const { result, params } = await runStep(
      [plan({ action: 'count', selector: '#account-list > li.account-card', as: 'account_count', description: 'Count the accounts' }), NOOP],
      { instruction },
    );
    expect(result.status).toBe('passed');
    expect(params.account_count).toBe('0');
    expect(unprovenListRead(result)).toEqual({
      kind: 'empty',
      name: 'account_count',
      reason: '{{account_count}} counted 0 on the recording run, and a read that finds nothing proves nothing about its selector',
    });
  });
});

// ── The report ───────────────────────────────────────────────────────────────

function reportOf(result: StepResult): TestReport {
  return {
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
}

describe('the report', () => {
  it('says what happened to a read the model was shown', async () => {
    const { result } = await runStep([plan(readOf(OVER_BROAD)), plan(readOf(RIGHT))]);
    const html = renderReport(reportOf(result));
    expect(html).toContain('list read shown to the model, which replaced it with a later read — accounts holds 6 values');
    expect(html).not.toContain('list not checked');
  });

  it('flags a step that ended on a list the model never saw, empty or mixed, and not one it kept', async () => {
    const mixed = (await runStep([plan(readOf(OVER_BROAD))], { maxTurns: 1 })).result;
    expect(uncheckedListRead(mixed)).toBe('accounts');
    const mixedHtml = renderReport(reportOf(mixed));
    expect(mixedHtml).toContain('⚠ list not checked');
    expect(mixedHtml).toContain(
      'list read never shown to the model: the step ended on it with no turn left — accounts holds 6 values',
    );

    // Empty and unseen: the compile's reason is that it came back empty, but
    // the step is still flagged, since nobody looked at it.
    const empty = (await runStep([plan(readOf(NOTHING))], { maxTurns: 1 })).result;
    expect(unprovenListRead(empty)?.kind).toBe('empty');
    expect(uncheckedListRead(empty)).toBe('accounts');
    const emptyHtml = renderReport(reportOf(empty));
    expect(emptyHtml).toContain('⚠ list not checked');
    expect(emptyHtml).toContain('list read never shown to the model: the step ended on it with no turn left — accounts is empty');

    const kept = (await runStep([plan(readOf(NOTHING)), NOOP])).result;
    expect(uncheckedListRead(kept)).toBeUndefined();
    const keptHtml = renderReport(reportOf(kept));
    expect(keptHtml).toContain('list read shown to the model, which kept it — accounts is empty');
    expect(keptHtml).not.toContain('list not checked');
  });
});

// ── The compile ──────────────────────────────────────────────────────────────

let scratch: string;
beforeAll(async () => {
  scratch = await makeScratchBase('list-read-review');
});
afterAll(async () => {
  await removeScratchBase(scratch);
});

/** A model the compilers may ask only to review: anything else fails the test. */
function reviewOnlyClient(): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = textOf(messages.slice(-1));
      prompts.push(last);
      const file = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(last)?.[1];
      if (/Review a generated Playwright code-behind file/.test(last) && file !== undefined) {
        return { text: JSON.stringify({ file }), model: 'scripted' };
      }
      throw new Error(`the compile asked the model something this test did not script: ${last.slice(0, 120)}`);
    },
  } as unknown as AiClient;
  return { client, prompts };
}

describe('the compile writes no entry for a step that ended on a list read proving nothing', () => {
  it('Run & Compile names the step not attempted, asks the model nothing and writes nothing', async () => {
    const { result: kept } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const dir = await fs.mkdtemp(path.join(scratch, 'boxed-'));
    const md = path.join(dir, 'accounts.md');
    await fs.writeFile(md, `# Accounts\n\n## Steps\n1. ${STEP}\n`, 'utf-8');
    const { client, prompts } = reviewOnlyClient();
    const events: CompileEvent[] = [];
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return { status: 'passed', steps: [kept], resolvedParameters: {}, tokensUsed: 0 };
      throw new Error('nothing was compiled, so nothing should be replayed');
    };

    const compile = await compileTest({
      test: await parseTestFile(md),
      config: configWith(0),
      contextContent: '',
      aiClient: client,
      runner,
      onEvent: (e) => events.push(e),
    });

    expect(prompts).toEqual([]);
    expect(compile.status).toBe('partial');
    expect(compile.summary.compiled).toBe(0);
    expect(compile.summary.notAttempted).toEqual([1]);
    expect(compile.files).toEqual({});
    // No `ai: true` entry either: nothing tested whether the step can be code.
    await expect(fs.access(path.join(dir, 'accounts.steps.ts'))).rejects.toThrow();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'step', step: 1, message: EMPTY_REASON }));
    const done = events.find((e) => e.kind === 'done') as { message: string } | undefined;
    expect(done?.message).toContain('step 1 read an empty list on the recording run, which proves nothing about the selector');
    expect(done?.message).toContain('Compile again after a run where the list has items.');
  });

  it('takes a loop body\'s evidence from the pass that read items, not the first pass', async () => {
    const { result: empty } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: right } = await runStep([plan(readOf(RIGHT))]);
    // Both are rows of step 1, as a `For each` body's passes are.
    expect(evidenceRows([empty, right])).toEqual([right]);
    expect(evidenceRows([empty, right])[0]).toBe(right);
    // No pass proved anything: the first passing row stays, for the recording,
    // and the compile refuses it.
    expect(evidenceRows([empty, { ...empty }])[0]).toBe(empty);
  });

  it('compile-as-you-go writes no entry for the empty pass, and the entry from a pass that read items', async () => {
    const { result: empty } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: right, params } = await runStep([plan(readOf(RIGHT))]);
    const dir = await fs.mkdtemp(path.join(scratch, 'live-'));
    const stepsFile = path.join(dir, 'accounts.steps.ts');
    const binding = bindingFor(STEP, stepsFile);
    const compilerFor = (events: LiveCompileEvent[], client: AiClient): LiveCompiler =>
      new LiveCompiler({
        mode: 'run',
        testFilePath: path.join(dir, 'accounts.md'),
        aiClient: client,
        contextContent: '',
        testName: 'accounts.md',
        plan: [{ text: STEP, inScope: true, line: 5 }],
        emit: (e) => events.push(e),
        note: () => {},
      });

    // One pass, empty: not attempted, nothing generated, nothing written.
    const alone: LiveCompileEvent[] = [];
    const first = reviewOnlyClient();
    const once = compilerFor(alone, first.client);
    once.offer({ index: 0, binding, result: empty, resolvedParameters: { accounts: '[]' } });
    const onceOut = await once.finish({ tokensUsed: 0 });
    expect(first.prompts).toEqual([]);
    expect(onceOut.summary.notAttempted).toEqual([1]);
    expect(onceOut.files[stepsFile] ?? '').not.toContain('account');
    expect(alone).toContainEqual(expect.objectContaining({ type: 'compile:step', step: 1, message: EMPTY_REASON }));

    // Two passes of one loop body: the second read the names, so the entry is
    // written from it and the first pass owes nothing.
    const second = reviewOnlyClient();
    const twice = compilerFor([], second.client);
    twice.offer({ index: 0, binding, result: empty, resolvedParameters: { accounts: '[]' } });
    twice.offer({ index: 0, binding, result: right, resolvedParameters: params });
    const twiceOut = await twice.finish({ tokensUsed: 0 });
    expect(twiceOut.summary.notAttempted ?? []).toEqual([]);
    const file = twiceOut.files[stepsFile] ?? '';
    expect(file).toContain('fromRecording: true');
    expect(file).toContain('span:first-of-type');
    expect(file).not.toContain(NOTHING);
  });

  it('is the live compiler\'s last reason, after every fact about the step itself', () => {
    const unproven = { kind: 'empty' as const, name: 'accounts', reason: EMPTY_REASON };
    const binding = bindingFor(STEP);
    expect(generationRefusal({ binding, text: STEP, status: 'passed', unprovenListRead: unproven })).toBe(EMPTY_REASON);
    expect(generationRefusal({ binding, text: STEP, status: 'failed', unprovenListRead: unproven }))
      .toBe('the step did not pass');
    expect(generationRefusal({ binding, text: STEP, status: 'passed', fromCodeBehind: true, unprovenListRead: unproven }))
      .toBe('the step ran as code');
    expect(generationRefusal({ binding, text: STEP, status: 'passed' })).toBeUndefined();
  });
});
