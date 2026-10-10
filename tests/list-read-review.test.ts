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
 *    and passes; and a turn added only to show a read never fails the step,
 *    whatever the model answers or however its call goes;
 *  - the compile: `actionsOf` keeps only the step's own read, across attempts;
 *    a step that ended on an empty read, or on one the model never saw, is no
 *    evidence, and both compilers write no entry for it — while a loop pass
 *    that read items still compiles;
 *  - the report says what happened to a read, and flags one the model never saw.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult, SubActionResult, TestReport } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { executeAction } from '../src/browser/actions.js';
import { formatListReadsSection } from '../src/ai/prompts.js';
import { executeStep } from '../src/runner/step-executor.js';
import { leavesPageAsRead, listReadConcern, storedName, uncheckedListRead, unprovenListRead } from '../src/runner/list-read-review.js';
import { parseFlowControlStep } from '../src/parser/flow-control-step.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { actionsOf, evidenceRows, isEvidencePass } from '../src/codebehind/recording.js';
import { entryFromRecording } from '../src/codebehind/generate.js';
import { compileTest, outcomeRows, type CompileEvent, type CompileRunner, type CompileRunOutcome, type CompileSelect } from '../src/codebehind/compile.js';
import { entryTextIn } from '../src/codebehind/writer.js';
import { printSummary } from '../src/cli/commands/compile.js';
import { generationRefusal, LiveCompiler, type LiveCompileEvent } from '../src/codebehind/live-compile.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { renderReport } from '../src/report/generator.js';
import { PageTracker } from '../src/browser/manager.js';
import { addLogCallback } from '../src/utils/logger.js';
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

  it('leaves class names with a digit out of a kind, and sorts the rest, in both copies of the rule', async () => {
    // Build tools generate class names (`css-1x2y3z`, `row-3`): they change
    // between deployments without the element changing what it is. Sorted, so
    // `class="selected row"` and `class="row selected"` are one kind.
    const page = await pageWith('<!doctype html><html><body><ul id="rows">'
      + '<li class="row row-1 css-1x2y3z">Ada</li>'
      + '<li class="row row-2 css-9q8w7e">Ben</li>'
      + '<li class="selected row row-3">Cy</li>'
      + '<li class="row selected">Di</li>'
      + '</ul><ol id="plain"><li class="item css-a1">Ed</li><li class="item css-b2">Flo</li></ol></body></html>');
    try {
      const rows = readOf('#rows li', { as: 'rows' });
      const read = await executeAction(page, rows, undefined, undefined, { kinds: true });
      const count = await executeAction(
        page,
        { action: 'count', selector: '#rows li', as: 'n', description: 'count' },
        undefined,
        undefined,
        { kinds: true },
      );
      expect(read.kinds).toEqual(['li.row', 'li.row.selected']);
      expect(count.kinds).toEqual(read.kinds);
      expect(read.listMatches?.groups).toEqual([
        { kind: 'li.row', count: 2, samples: ['Ada', 'Ben'] },
        { kind: 'li.row.selected', count: 2, samples: ['Cy', 'Di'] },
      ]);
      expect(count.listMatches?.groups.map((g) => [g.kind, g.count])).toEqual([
        ['li.row', 2],
        ['li.row.selected', 2],
      ]);
      // Elements that differ only in generated class names are one kind, and
      // a read of them is not shown to the model as mixed.
      const plain = readOf('#plain li', { as: 'items' });
      const items = await executeAction(page, plain);
      expect(items.listMatches?.groups).toEqual([{ kind: 'li.item', count: 2, samples: ['Ed', 'Flo'] }]);
      expect(listReadConcern(plain, items)).toBeUndefined();
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
        // Nothing to quote, so the log's line is the same.
        summary: `accounts is empty: \`${NOTHING}\` matched nothing on this page.`,
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
      // Kinds and counts, and none of the values: the pattern stored none.
      expect(concern?.text).toContain('matched 3 elements — span.account-balance ×3 — and the pattern');
      expect(concern?.text).not.toContain('$1,234.56');
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

  it('calls a read mixed only when its values come from more than one kind', async () => {
    // A selector that also matches the labels beside the amounts a pattern
    // picks out stores the amounts alone: the list is right, and asking about
    // it cost a turn. A count counts every element it matched, so for it the
    // labels do count.
    const page = await pageWith('<!doctype html><html><body><ul id="money">'
      + '<li class="label">Balance</li><li class="amount">$12</li><li class="label">Fees</li><li class="amount">$3</li>'
      + '</ul></body></html>');
    try {
      const amounts = readOf('#money li', { as: 'amounts', pattern: '\\$(\\d+)' });
      const kept = await executeAction(page, amounts);
      expect(kept.capturedValues).toEqual(['12', '3']);
      expect(listReadConcern(amounts, kept)).toBeUndefined();

      const everything = readOf('#money li', { as: 'amounts' });
      expect(listReadConcern(everything, await executeAction(page, everything))?.text)
        .toContain('amounts holds 4 values from 2 kinds of element');

      const count: AIAction = { action: 'count', selector: '#money li', as: 'n', description: 'count' };
      expect(listReadConcern(count, await executeAction(page, count))?.text).toContain('n is 4, counting 2 kinds of element');
    } finally {
      await page.close();
    }
  });

  it('names the kinds that hold a pattern\'s values first, ahead of the ones it kept nothing of', async () => {
    // The line names five kinds; the ones holding the values came last on
    // the page, and were summed up as "2 more kinds", values and all.
    const page = await pageWith('<!doctype html><html><body><table><tr id="r">'
      + '<td class="a">A</td><td class="b">B</td><td class="c">C</td><td class="d">D</td><td class="e">E</td>'
      + '<td class="f">$12</td><td class="g">$3</td></tr></table></body></html>');
    try {
      const amounts = readOf('#r td', { as: 'amounts', pattern: '\\$(\\d+)' });
      const text = listReadConcern(amounts, await executeAction(page, amounts))!.text;
      expect(text).toContain('amounts holds 2 values from 2 kinds of element: `#r td` matched 7 elements — '
        + 'td.f ×1 ("12"); td.g ×1 ("3"); td.a ×1; td.b ×1; td.c ×1; and 2 more kinds.');
    } finally {
      await page.close();
    }
  });

  it('leaves a list read shown after an action that only takes something off the page', () => {
    const one = (action: Record<string, unknown>): boolean => leavesPageAsRead({ description: 'x', ...action } as AIAction);
    expect(one({ action: 'extract_csrf', selector: 'input[name=token]' })).toBe(true);
    expect(one({ action: 'extract_value', selector: '#total', as: 'total' })).toBe(true);
    expect(one({ action: 'api_call', url: '/api/items' })).toBe(true);
    expect(one({ action: 'api_call', url: '/api/items', method: 'head' })).toBe(true);
    // A return ends the flow, not the page: the step ends on the read for that.
    expect(one({ action: 'return' })).toBe(true);
    // A request that writes, and a dialog answered — accepting a "Delete?"
    // deletes — may change what a read again would read.
    expect(one({ action: 'api_call', url: '/api/items', method: 'POST' })).toBe(false);
    expect(one({ action: 'dialog', value: 'accept' })).toBe(false);
  });

  it('asks the page what a count counted only when it found something', async () => {
    // A count of 0 is empty whatever the elements are. And when the count
    // counted every match, a compile's kinds are the look it just took.
    const page = await pageWith('<!doctype html><html><body><ul><li class="a">x</li><li class="b">y</li></ul></body></html>');
    const spy = vi.spyOn(Object.getPrototypeOf(page.locator('li')), 'evaluateAll');
    try {
      const none = await executeAction(page, { action: 'count', selector: '#nothing li', as: 'n', description: 'count' });
      expect(none.capturedValue).toBe('0');
      expect(none.listMatches?.groups).toEqual([]);
      expect(spy).not.toHaveBeenCalled();

      const both = await executeAction(
        page,
        { action: 'count', selector: 'li', as: 'n', description: 'count' },
        undefined,
        undefined,
        { kinds: true },
      );
      expect(both.capturedValue).toBe('2');
      expect(both.kinds).toEqual(['li.a', 'li.b']);
      expect(both.listMatches?.groups.map((g) => g.kind)).toEqual(['li.a', 'li.b']);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
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

  it('keeps a list with a noop only in a turn added to ask, and by going on in one the model asked for', () => {
    // In a turn the model asked for, the step still has work: a noop with
    // needs_reeval false there would end it with that work undone.
    const line = ['accounts is empty: `#x` matched nothing on this page.'];
    const ordinary = formatListReadsSection(line);
    expect(ordinary).toContain('go on with the step: that keeps it');
    expect(ordinary).toContain('Reading one list again answers that list alone: the others are still to answer.');
    expect(ordinary).not.toContain('noop');
    const review = formatListReadsSection(line, true);
    expect(review).toContain('answer noop with needs_reeval false');
    expect(review).not.toContain('go on with the step');
  });
});

// ── The step loop, with a scripted model ─────────────────────────────────────

/**
 * One scripted model reply: the reply's text, or a function of the page that
 * returns it — and may change the page first, as a slow request would, or
 * throw, as a failed call does.
 */
type Reply = string | ((page: Page) => string | Promise<string>);

/** Replays `responses` in order, repeating the last, and keeps every request. */
function scriptedClient(responses: Reply[], page: Page): { client: AiClient; requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const reply = responses[Math.min(requests.length, responses.length - 1)]!;
      requests.push(messages);
      const text = typeof reply === 'function' ? await reply(page) : reply;
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

function configWith(retries: number, maxTurns = 5, execution: Partial<Config['execution']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
    browser: { ...DEFAULT_CONFIG.browser, headed: false, captureScreenshotsPerAction: false },
    execution: { ...DEFAULT_CONFIG.execution, retries, maxTurns, promptOnAmbiguity: false, ...execution },
  };
}

/** The real `executeStep` on the fixture page (or `body`), as a compile run calls it. */
async function runStep(
  responses: Reply[],
  opts: {
    retries?: number;
    maxTurns?: number;
    instruction?: string;
    body?: string;
    params?: Record<string, string>;
    execution?: Partial<Config['execution']>;
    signal?: AbortSignal;
    /** A page of the caller's, left open, in place of the fixture page. */
    page?: Page;
    pageTracker?: PageTracker;
  } = {},
): Promise<{ result: StepResult; requests: ChatMessage[][]; params: Record<string, string> }> {
  const page = opts.page ?? await pageWith(opts.body);
  try {
    const { client, requests } = scriptedClient(responses, page);
    const params: Record<string, string> = { ...opts.params };
    const instruction = opts.instruction ?? STEP;
    const claim = parseFlowControlStep(instruction);
    const result = await executeStep(1, 1, instruction, {
      page,
      config: configWith(opts.retries ?? 0, opts.maxTurns, opts.execution),
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
      ...(opts.signal !== undefined && { signal: opts.signal }),
      ...(opts.pageTracker !== undefined && { pageTracker: opts.pageTracker }),
    });
    return { result, requests, params };
  } finally {
    if (opts.page === undefined) await page.close();
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

/** A click whose selector does not parse: it fails at once, and fails the
 *  ordinary turn it is in. */
const CLICK_NOTHING = { action: 'click', selector: '#account-list ]]', description: 'Open the list' };

/** A count of 0 on the fixture page: its account rows carry no such class. */
const CARD_COUNT = { action: 'count', selector: '#account-list > li.account-card', as: 'account_count', description: 'Count the cards' };

/** A read of one value that leaves the page as it is: the step going on. */
const HEADING = { action: 'read', selector: 'h1', as: 'heading', description: 'Read the page heading' };
const HEADING_STEP = 'Read the page heading [store as: heading]';

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
      // Turn 2's prompt showed it.
      shown: true,
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

  it('compiles a mixed read the model kept, with every kind it matched as its self-check', async () => {
    // The noop that kept it is left out of the entry, as a find or an expand
    // is (docs/specs/SPEC-codebehind-robustness.md §6.6): it did nothing.
    const { result, params } = await runStep([plan(readOf(OVER_BROAD)), NOOP]);
    expect(result.status).toBe('passed');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('kept');
    expect(actionsOf(result).map((a) => a.action)).toEqual(['read', 'noop']);
    expect(unprovenListRead(result)).toBeUndefined();
    expect(isEvidencePass(result)).toBe(true);
    const { entry } = compiled(result, params);
    expect(entry).toContain('fromRecording: true');
    expect(entry).toContain(`selector: '${OVER_BROAD}'`);
    expect(entry).toContain("kinds: ['span.account-name', 'span.account-number']");
    expect(entry).not.toContain('noop');
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
      reason: 'the step ended on its read of {{accounts}} on the recording run without the model checking what it matched',
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
    // Attempt 1 reads nothing, and the same turn fails on something else
    // before the model is shown the read. The retry reads the names, which
    // stores over the first attempt's read: that read was never the step's.
    const { result, requests, params } = await runStep(
      [plan([readOf(NOTHING), CLICK_NOTHING]), plan(readOf(RIGHT))],
      { retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(true);
    expect(requests).toHaveLength(2);
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
      [plan([readOf(NOTHING), CLICK_NOTHING]), NOOP],
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

// ── The turn added only to show the model its lists ─────────────────────────

describe('a turn added only to show the model its lists never fails the step', () => {
  const answers: Array<[string, Record<string, unknown>]> = [
    ['a click', { action: 'click', selector: '#show-every-account', description: 'Show every account first' }],
    ['a wait', { action: 'wait', waitType: 'selector', condition: '#account-list .account-title', timeout: 1000, description: 'Wait for the accounts' }],
    ['a single read', { action: 'read', selector: '#account-list .account-title', as: 'accounts', description: 'Read the account name' }],
    ['a concession', { action: 'assert', holds: false, evidence: 'The panel shows no accounts to read', description: 'No accounts' }],
    ['a question', { action: 'prompt', question: 'The list is empty; is that expected?', description: 'Ask' }],
  ];

  it.each(answers)('ends the step where it stood when the model answers with %s, and runs none of it', async (_what, answer) => {
    // The step had passed on turn 1: the model said it was done. Before, the
    // added turn ran like any other — the click timed out, the question failed
    // a run with nobody to answer it — and failed the step, whose retry then
    // did its work again.
    const { result, requests, params } = await runStep(
      [plan(readOf(NOTHING)), plan(answer)],
      { retries: 1, execution: { promptOnAmbiguity: true } },
    );
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(false);
    expect(requests).toHaveLength(2);
    expect(params.accounts).toBe('[]');
    expect(result.turns.map((t) => t.subActions.map((s) => s.action.action))).toEqual([['read'], []]);
    // Asked, and not answered: flagged, and not compiled.
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('pending');
    expect(uncheckedListRead(result)).toBe('accounts');
    expect(unprovenListRead(result)?.kind).toBe('empty');
  });

  it('ends the step where it stood when the read again fails', async () => {
    const { result, requests } = await runStep(
      [plan(readOf(NOTHING)), plan(readOf('#account-list ]]'))],
      { retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(false);
    expect(requests).toHaveLength(2);
    expect(readsOf(result).map((s) => [s.listReview?.outcome, s.error !== undefined])).toEqual([
      ['pending', false],
      [undefined, true],
    ]);
    expect(uncheckedListRead(result)).toBe('accounts');
  });

  it('ends the step where it stood when its model call fails, and still stops on Stop', async () => {
    const failed = await runStep(
      [plan(readOf(NOTHING)), () => { throw new Error('429 rate limited'); }],
      { retries: 1 },
    );
    expect(failed.result.status).toBe('passed');
    expect(failed.result.retried).toBe(false);
    expect(readsOf(failed.result)[0]!.listReview?.outcome).toBe('pending');

    const stop = new AbortController();
    const stopped = await runStep(
      [
        plan(readOf(NOTHING)),
        () => {
          stop.abort();
          throw new DOMException('Run aborted by client', 'AbortError');
        },
      ],
      { signal: stop.signal },
    );
    expect(stopped.result.status).toBe('failed');
    expect(stopped.result.interrupted).toBe(true);
  });

  it('does not hold the model to the turn cap when it asks to look again on the last turn', async () => {
    const { result } = await runStep(
      [plan(readOf(NOTHING)), plan(readOf(NOTHING_EITHER), true)],
      { maxTurns: 2 },
    );
    expect(result.status).toBe('passed');
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'unseen']);
  });

  it('keeps a read the model answers with a noop carrying the list\'s name', async () => {
    // The prompt says "the same as" and "answer noop": a noop that carries
    // both stores nothing, so it keeps the read rather than replacing it.
    const { result } = await runStep([
      plan(readOf(NOTHING)),
      plan({ action: 'noop', as: 'accounts', description: 'Keep the list: the panel has none' }),
    ]);
    expect(result.status).toBe('passed');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('kept');
    expect(actionsOf(result).map((a) => a.action)).toEqual(['read', 'noop']);
    expect(unprovenListRead(result)?.kind).toBe('empty');
    expect(isEvidencePass(result)).toBe(false);
  });

  it('counts only a read, a count or a table read as storing into its name', () => {
    const named = (action: string): AIAction => ({ action, as: 'accounts', description: 'x' }) as AIAction;
    for (const action of ['read', 'count', 'readTable']) expect(storedName(named(action))).toBe('accounts');
    for (const action of ['noop', 'wait', 'openPage', 'openBrowser', 'extract_value']) {
      expect(storedName(named(action))).toBeUndefined();
    }
  });

  it('shows a repeated read again when its result changed, before keeping it', async () => {
    // A list that had not loaded: the first read finds nothing, and by the
    // time the model reads the same way again it holds three names of two
    // kinds. The model never saw those, so they are shown before the step ends.
    const body = '<!doctype html><html><body><h1>Items</h1><ul id="items"></ul></body></html>';
    const items = readOf('#items li', { as: 'names', description: 'Read every item' });
    const { result, requests, params } = await runStep(
      [
        plan(items),
        async (page) => {
          await page.evaluate(
            "document.getElementById('items').innerHTML = "
              + "'<li class=\"item\">Ada</li><li class=\"item\">Ben</li><li class=\"item selected\">Cy</li>'",
          );
          return plan(items);
        },
        NOOP,
      ],
      { body, instruction: 'Read every item name [store as: names]' },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(textOf(requests[2]!)).toContain('names holds 3 values from 2 kinds of element');
    expect(params.names).toBe('["Ada","Ben","Cy"]');
    expect(readsOf(result).map((s) => [s.listReview?.kind, s.listReview?.outcome])).toEqual([
      ['empty', 'replaced'],
      ['mixed', 'kept'],
    ]);
  });

  it('describes a list stored under a secret-looking name without its values', async () => {
    const body = '<!doctype html><html><body><ul id="keys">'
      + '<li class="key live">tok_live_one</li><li class="key test">tok_test_two</li></ul></body></html>';
    const { result, requests } = await runStep(
      [plan(readOf('#keys li', { as: 'api_tokens', description: 'Read every API token' })), NOOP],
      { body, instruction: 'Read every API token on the page [store as: api_tokens]' },
    );
    expect(readsOf(result)[0]!.listReview!.text).toBe(
      'api_tokens holds 2 values from 2 kinds of element: `#keys li` matched 2 elements — li.key.live ×1; li.key.test ×1.',
    );
    const second = textOf(requests[1]!);
    const lists = second.slice(second.indexOf('## Lists to check'), second.indexOf('## DOM Snapshot'));
    expect(lists).toContain('li.key.live ×1');
    expect(lists).not.toContain('tok_live_one');
  });

  it('masks a secret value the line quotes, in the line and in the prompt', async () => {
    // A secret-named parameter whose value is also page text the read quotes.
    const { result, requests } = await runStep(
      [plan(readOf(OVER_BROAD)), NOOP],
      { params: { savings_password: 'Savings' } },
    );
    const text = readsOf(result)[0]!.listReview!.text;
    expect(text).toContain('("Everyday", "***", "Travel")');
    expect(text).not.toContain('Savings');
    const second = textOf(requests[1]!);
    const lists = second.slice(second.indexOf('## Lists to check'), second.indexOf('## DOM Snapshot'));
    expect(lists).toContain('"***"');
    expect(lists).not.toContain('Savings');
  });

  it('ends the step where it stood when a read again throws', async () => {
    // A frame that does not parse throws, where a bad selector fails the read.
    const { result, requests } = await runStep(
      [plan(readOf(NOTHING)), plan(readOf(NOTHING_EITHER, { frame: 'iframe[name=x' }))],
      { retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(false);
    expect(requests).toHaveLength(2);
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('pending');
    expect(uncheckedListRead(result)).toBe('accounts');
  });

  it('runs only a read again of a list it showed, read the same kind of way', async () => {
    // Shown the over-broad `accounts`, the model reads into another name, or
    // counts into the list's: neither answers the read it was shown.
    const other = await runStep([plan(readOf(OVER_BROAD)), plan(readOf(RIGHT, { as: 'names' }))]);
    expect(other.result.status).toBe('passed');
    expect(other.params.names).toBeUndefined();
    expect(readsOf(other.result).map((s) => s.listReview?.outcome)).toEqual(['pending']);
    expect(unprovenListRead(other.result)?.kind).toBe('unchecked');

    const count = { action: 'count', selector: '#account-list > li', as: 'accounts', description: 'Count the accounts' };
    const counted = await runStep([plan(readOf(OVER_BROAD)), plan(count)]);
    expect(counted.result.status).toBe('passed');
    expect(JSON.parse(counted.params.accounts!)).toHaveLength(6);
    expect(readsOf(counted.result).map((s) => s.action.action)).toEqual(['read']);
    expect(readsOf(counted.result)[0]!.listReview?.outcome).toBe('pending');
  });

  it('shows again a list the review answer left alone, and keeps it on a noop', async () => {
    // Two lists at once: the model reads one again and says nothing of the
    // other, which is shown again rather than taken as kept.
    const instruction = 'Read the name of every account [store as: accounts] and count the cards [store as: account_count]';
    const { result, requests, params } = await runStep(
      [plan([readOf(OVER_BROAD), CARD_COUNT]), plan(readOf(RIGHT)), NOOP],
      { instruction },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(textOf(requests[2]!)).toContain('account_count is 0');
    expect(textOf(requests[2]!)).not.toContain('accounts holds 6 values');
    expect(params.accounts).toBe(NAMES);
    expect(readsOf(result).map((s) => [s.action.as, s.listReview?.outcome])).toEqual([
      ['accounts', 'replaced'],
      ['account_count', 'kept'],
      ['accounts', undefined],
    ]);
  });

  it('shows again, in a turn the model asked for, a list it left alone while reading another again', async () => {
    // "Return ONE action": a model answering two lists one at a time reads the
    // first again and asks for another turn. Taking that as keeping the second
    // kept a count of 0 nobody had answered.
    const instruction = 'Read the name of every account [store as: accounts] and count the cards [store as: account_count], '
      + 'then read the page heading [store as: heading]';
    const { result, requests, params } = await runStep(
      [plan([readOf(OVER_BROAD), CARD_COUNT], true), plan(readOf(RIGHT), true), plan(HEADING)],
      { instruction },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    const third = textOf(requests[2]!);
    expect(third).toContain('account_count is 0');
    expect(third).not.toContain('accounts holds 6 values');
    expect(params.accounts).toBe(NAMES);
    expect(params.heading).toBe('Payments');
    // Going on with the step in the turn after keeps it, as the prompt says.
    expect(readsOf(result).map((s) => [s.action.as, s.listReview?.outcome])).toEqual([
      ['accounts', 'replaced'],
      ['account_count', 'kept'],
      ['accounts', undefined],
      ['heading', undefined],
    ]);
  });

  it('leaves a list the answer did not reach unanswered when the same turn changed the page', async () => {
    // The model read one list again and then clicked: the other was read on a
    // page that is gone, so it cannot be shown again, and nothing answered it.
    const instruction = 'Read the name of every account [store as: accounts] and count the cards [store as: account_count], '
      + 'then show the next statements';
    const next = { action: 'click', selector: '#next-page', description: 'Show the next statements' };
    const { result, requests, params } = await runStep(
      [plan([readOf(OVER_BROAD), CARD_COUNT], true), plan([readOf(RIGHT), next], true), plan(HEADING)],
      { instruction },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(textOf(requests[2]!)).not.toContain('## Lists to check');
    expect(params.accounts).toBe(NAMES);
    expect(readsOf(result).map((s) => [s.action.as, s.listReview?.outcome])).toEqual([
      ['accounts', 'replaced'],
      ['account_count', 'pending'],
      ['accounts', undefined],
      ['heading', undefined],
    ]);
    expect(uncheckedListRead(result)).toBe('account_count');
    expect(unprovenListRead(result)?.name).toBe('account_count');
  });

  it('asks a turn added to ask about the lists alone, and one the model asked for for the next action', async () => {
    const review = await runStep([plan(readOf(NOTHING)), NOOP]);
    const asked = textOf(review.requests[1]!);
    expect(asked).toContain('This turn is only about the lists above.');
    expect(asked).toContain('answer noop with needs_reeval false');
    expect(asked).not.toContain('What is the next action needed');
    expect(asked).not.toContain('go on with the step');

    const ordinary = await runStep([plan(readOf(NOTHING), true), NOOP]);
    const next = textOf(ordinary.requests[1]!);
    expect(next).toContain('What is the next action needed');
    expect(next).toContain('go on with the step: that keeps it');
    expect(next).not.toContain('This turn is only about the lists above.');
  });

  it('explains the step with its own reasoning, not a turn added to ask about its lists', async () => {
    const first = JSON.stringify({ actions: [readOf(NOTHING)], reasoning: 'The panel lists the accounts: read every name', needs_reeval: false });
    const answers: Array<[string, Record<string, unknown>]> = [
      ['kept', { action: 'noop', description: 'Keep the list' }],
      ['refused', { action: 'click', selector: '#next-page', description: 'Look further' }],
    ];
    for (const [what, answer] of answers) {
      const { result, requests } = await runStep([
        first,
        JSON.stringify({ actions: [answer], reasoning: 'The panel is empty, so the list is right', needs_reeval: false }),
      ]);
      expect(requests, what).toHaveLength(2);
      expect(result.aiExplanation, what).toBe('The panel lists the accounts: read every name');
    }
  });

  it('shows the selector as the model wrote it, placeholders and all', async () => {
    // What a read again "the same way" has to repeat — and a value the run
    // filled in is not shown where the model wrote a name.
    const instruction = 'Read the name of every {{panel}} account [store as: accounts]';
    const { requests } = await runStep(
      [plan(readOf('#account-list [data-account="{{panel}}"] .nickname')), NOOP],
      { instruction, params: { panel: 'Savings' } },
    );
    const lists = textOf(requests[1]!).split('## Lists to check')[1]!.split('## DOM Snapshot')[0]!;
    expect(lists).toContain('accounts is empty: `#account-list [data-account="{{panel}}"] .nickname` matched nothing');
    expect(lists).not.toContain('data-account="Savings"');
  });

  it('ends the step where it stood when a turn added to ask is answered with no actions', async () => {
    // No answer: asking again would only spend the step's turns.
    const silent = JSON.stringify({ actions: [], reasoning: 'scripted', needs_reeval: false });
    const { result, requests } = await runStep([plan(readOf(NOTHING)), silent, NOOP], { retries: 1 });
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(false);
    expect(requests).toHaveLength(2);
    expect(readsOf(result)[0]!.listReview).toMatchObject({ outcome: 'pending', shown: true });
    expect(uncheckedListRead(result)).toBe('accounts');
  });

  it('shows a list that changed when read again the same way once more, and ends on it if it changes again', async () => {
    // Still loading, the second read is a result the model has not seen; a
    // list that changes every time is live, and the step ends on it as read.
    const body = '<!doctype html><html><body><h1>Feed</h1><ul id="feed"></ul></body></html>';
    const feed = readOf('#feed li', { as: 'events', description: 'Read every event' });
    const fill = (items: string) => async (page: Page) => {
      await page.evaluate(`document.getElementById('feed').innerHTML = ${JSON.stringify(items)}`);
      return plan(feed);
    };
    const { result, requests } = await runStep(
      [
        plan(feed),
        fill('<li class="event">Ada joined</li><li class="event new">Ben joined</li>'),
        fill('<li class="event">Cy left</li><li class="event new">Di joined</li>'),
        NOOP,
      ],
      { body, instruction: 'Read every event in the feed [store as: events]' },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(readsOf(result).map((s) => [s.listReview?.kind, s.listReview?.outcome])).toEqual([
      ['empty', 'replaced'],
      ['mixed', 'replaced'],
      ['mixed', 'unseen'],
    ]);
    expect(readsOf(result)[2]!.listReview?.unseenBecause).toBe('kept-changing');
    expect(renderReport(reportOf(result)))
      .toContain('list read never shown to the model: it changed each time the model read it again the same way');
    expect(uncheckedListRead(result)).toBe('events');
  });

  it('shows again a list the model\'s own click changed, rather than ending on it as one that keeps changing', async () => {
    // "Load more", then read the rows again: the list changed because of the
    // model's click, not by itself, so it is shown again each time.
    const body = '<!doctype html><html><body><table id="orders"><tbody>'
      + '<tr class="odd"><td>1</td></tr><tr class="even"><td>2</td></tr></tbody></table>'
      + '<button id="more" onclick="more()">Load more</button><script>'
      + 'function more(){const t=document.querySelector("#orders tbody");const n=t.rows.length;'
      + 'for(let i=0;i<2;i++){const r=t.insertRow();r.className=(n+i)%2?"even":"odd";r.insertCell().textContent=String(n+i+1);}}'
      + '</script></body></html>';
    const rows = readOf('#orders tr', { as: 'orders', description: 'Read every order row' });
    const loadMore = { action: 'click', selector: '#more', description: 'Load more' };
    const { result, requests, params } = await runStep(
      [plan(rows, true), plan([loadMore, rows], true), plan([loadMore, rows], true), NOOP],
      { body, instruction: 'Load every order and read every order row [store as: orders]' },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(4);
    expect(textOf(requests[3]!)).toContain('orders holds 6 values from 2 kinds of element');
    expect(JSON.parse(params.orders!)).toHaveLength(6);
    expect(readsOf(result).map((s) => s.listReview?.outcome)).toEqual(['replaced', 'replaced', 'kept']);
    expect(readsOf(result).some((s) => s.listReview?.unseenBecause !== undefined)).toBe(false);
  });

  it('shows the lists again beside what the model found when it only looked around', async () => {
    // `expand` and `find` look; they do not go on with the step.
    const { result, requests } = await runStep([
      plan(readOf(OVER_BROAD), true),
      plan({ action: 'expand', selector: '#account-list', description: 'Look at the account list' }, true),
      NOOP,
    ]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(textOf(requests[2]!)).toContain('accounts holds 6 values from 2 kinds of element');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('kept');
  });

  it('counts a list read as shown only once a prompt carries it', async () => {
    // A Stop after the step queued the read for its next turn, before that
    // turn's prompt was built: the model never saw it.
    const stop = new AbortController();
    const unhook = addLogCallback((_level, message) => {
      if (message.includes('showing the model the list read')) stop.abort();
    });
    try {
      const { result, requests } = await runStep([plan(readOf(NOTHING)), NOOP], { signal: stop.signal });
      expect(result.interrupted).toBe(true);
      expect(requests).toHaveLength(1);
      expect(readsOf(result)[0]!.listReview).toMatchObject({ outcome: 'pending' });
      expect(readsOf(result)[0]!.listReview!.shown).toBeUndefined();
      expect(renderReport(reportOf(result))).toContain('list read never shown to the model: its attempt ended before it could be');
    } finally {
      unhook();
    }
  });

  it('discards an answer whose second read again fails, and compiles nothing from its first', async () => {
    // The answer reads the list again with a narrower selector, which works,
    // and again with one that does not parse. The values go back to the read
    // the model was shown — and the narrower read, which the model's own
    // answer abandoned, must not stand in for it at the compile.
    const { result, params } = await runStep(
      [plan(readOf(OVER_BROAD)), plan([readOf(RIGHT), readOf('#account-list ]]')])],
      { retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(JSON.parse(params.accounts!)).toHaveLength(6);
    const [shown, narrowed] = readsOf(result);
    expect(shown!.listReview).toMatchObject({ outcome: 'pending', shown: true });
    expect(narrowed!.discarded).toBe(true);
    expect(unprovenListRead(result)).toMatchObject({ kind: 'unchecked', name: 'accounts' });
    expect(actionsOf(result).map((a) => a.selector)).not.toContain(RIGHT);
    expect(renderReport(reportOf(result))).toContain(
      'list read discarded: a read again later in the same answer failed, so the step ended where it stood',
    );
  });

  it('puts back what a turn added to ask stored when a read again in it fails', async () => {
    // The answer reads one list again, which works, and counts the other with
    // a selector that does not parse. The step ends where it stood: on the
    // read the model was shown, not on one it never saw.
    const instruction = 'Read the name of every account [store as: accounts] and count the cards [store as: account_count]';
    const { result, requests, params } = await runStep(
      [
        plan([readOf(OVER_BROAD), CARD_COUNT]),
        plan([
          readOf('#accounts-card span', { description: 'Read every span' }),
          { action: 'count', selector: '#account-list ]]', as: 'account_count', description: 'Count the cards' },
        ]),
      ],
      { instruction, retries: 1 },
    );
    expect(result.status).toBe('passed');
    expect(result.retried).toBe(false);
    expect(requests).toHaveLength(2);
    const shown = JSON.parse(params.accounts!);
    expect(shown).toHaveLength(6);
    expect(shown).toContain('•••• 4417');
    expect(params.account_count).toBe('0');
    const [first, , again] = readsOf(result);
    expect(first!.listReview).toMatchObject({ outcome: 'pending', shown: true });
    expect(again!.action.selector).toBe('#accounts-card span');
    expect(again!.listReview?.shown).toBeUndefined();
  });

  it('ends on a read the same turn changed the page after, without showing it', async () => {
    // "…then empty the cart": a read again in the next turn would read the
    // emptied cart and store `[]` over the three items the step read.
    const body = '<!doctype html><html><body><h1>Cart</h1><ul id="cart">'
      + '<li class="item">Widget</li><li class="item discounted">Gadget</li><li class="item">Gizmo</li></ul>'
      + '<button id="empty" onclick="document.getElementById(\'cart\').innerHTML=\'\'">Empty the cart</button></body></html>';
    const { result, requests, params } = await runStep(
      [plan([
        readOf('#cart li', { as: 'items', description: 'Read every cart item' }),
        { action: 'click', selector: '#empty', description: 'Empty the cart' },
      ])],
      { body, instruction: 'Read every item in the cart [store as: items], then empty the cart' },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(1);
    expect(params.items).toBe('["Widget","Gadget","Gizmo"]');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('unseen');
    expect(uncheckedListRead(result)).toBe('items');
  });

  it('masks a long secret in a value whole, quotes no count, and logs no values at all', async () => {
    // A secret longer than a quoted value may be, and one with line breaks in
    // it, on a list's page text. Cut or collapsed first, neither matched the
    // whole value the mask knows, and the line kept its head. Fakes named for
    // this test, as CLAUDE.md asks of anything shaped like a credential.
    const longSecret = `list-read-review-long-secret-${'x'.repeat(60)}`;
    const multiLine = 'list-read-review fake secret\nits second line\nits third line';
    const body = '<!doctype html><html><body><table id="tokens">'
      + `<tr><td class="label">Deploy key</td><td class="value">${longSecret}</td></tr>`
      + `<tr><td class="label">Signing key</td><td class="value"><pre>${multiLine}</pre></td></tr></table></body></html>`;
    const params = { api_token: longSecret, signing_key: multiLine };
    const lines: string[] = [];
    const unhook = addLogCallback((_level, message) => lines.push(message));
    try {
      const read = await runStep(
        [plan(readOf('#tokens td', { as: 'labels', description: 'Read every label' })), NOOP],
        { body, instruction: 'Read the label of every deploy token [store as: labels]', params },
      );
      const counted = await runStep(
        [plan({ action: 'count', selector: '#tokens td', as: 'cells', description: 'Count the cells' }), NOOP],
        { body, instruction: 'Count the cells [store as: cells]', params },
      );
      expect(readsOf(read.result)[0]!.listReview!.text).toContain('td.value ×2 ("***", "***")');
      // A count stores a number: it quotes none of the text it counted.
      expect(readsOf(counted.result)[0]!.listReview!.text).toContain('— td.label ×2; td.value ×2.');
      for (const { requests } of [read, counted]) {
        const second = textOf(requests[1]!);
        const lists = second.slice(second.indexOf('## Lists to check'), second.indexOf('## DOM Snapshot'));
        expect(lists).not.toContain('list-read-review-long-secret');
        expect(lists).not.toContain('list-read-review fake secret');
      }
      const logged = lines.join('\n');
      expect(logged).toContain('td.label ×2; td.value ×2');
      expect(logged).not.toContain('list-read-review-long-secret');
      expect(logged).not.toContain('Deploy key');
    } finally {
      unhook();
    }
  });

  it('quotes a value too long to show whole as its length, so a later mask still finds it whole', async () => {
    // A long value the run does not yet know is a secret — a later step will
    // store it under a secret-looking name, and the report is masked with it
    // at the end of the run, by whole value. Its head must not be in the line.
    const later = `list-read-review-later-secret-${'y'.repeat(60)}`;
    const body = '<!doctype html><html><body><ul id="keys">'
      + `<li class="key primary">${later}</li><li class="key">Short</li></ul></body></html>`;
    const { result } = await runStep(
      // `entries`, not `keys`: a name with "key" in it is secret-looking, and
      // such a list is described with no values at all.
      [plan(readOf('#keys li', { as: 'entries', description: 'Read every entry' })), NOOP],
      { body, instruction: 'Read every entry [store as: entries]' },
    );
    const text = readsOf(result)[0]!.listReview!.text;
    expect(text).toContain(`li.key.primary ×1 (a value of ${later.length} characters)`);
    expect(text).toContain('li.key ×1 ("Short")');
    expect(text).not.toContain('list-read-review-later-secret');
  });

  it('quotes no text the read did not store: what its pattern dropped, or a count\'s', async () => {
    // A form's inputs read with a pattern that keeps none: the line must not
    // quote the password field's value, which the page snapshot shows as ***
    // and the step never stored.
    const signup = '<!doctype html><html><body><form id="signup">'
      + '<input class="field" name="name" value="Ada">'
      + '<input class="field" name="email" value="ada-at-example">'
      + '<input class="field" type="password" name="password" value="list-read-review-fake-password">'
      + '</form></body></html>';
    const pattern = await runStep(
      [plan(readOf('#signup input', { as: 'emails', pattern: '[^@\\s]+@[^@\\s]+\\.\\w+', description: 'Read every email' })), NOOP],
      { body: signup, instruction: 'Read every email address in the form [store as: emails]' },
    );
    const patternText = readsOf(pattern.result)[0]!.listReview!.text;
    expect(patternText).toContain('matched 3 elements — input.field ×3 — and the pattern');
    expect(patternText).not.toContain('list-read-review-fake-password');

    // A count over rows whose hidden cell holds a whole key, beside an inline script.
    const keys = '<!doctype html><html><body><table id="keys">'
      + '<tr class="row"><td>Deploy</td><td hidden>list-read-review-hidden-key</td></tr>'
      + '<tr class="row current"><td>CI</td><td><script>window.cfg = "list-read-review-script-text"</script></td></tr>'
      + '</table></body></html>';
    const count = await runStep(
      [plan({ action: 'count', selector: '#keys tr', as: 'n', description: 'Count the keys' }), NOOP],
      { body: keys, instruction: 'Count the keys [store as: n]' },
    );
    const countText = readsOf(count.result)[0]!.listReview!.text;
    expect(countText).toContain('tr.row ×1; tr.current.row ×1');
    expect(countText).not.toContain('list-read-review-hidden-key');
    expect(countText).not.toContain('list-read-review-script-text');
  });

  it('ends on a read the same turn then waited after, without showing it', async () => {
    // "…then wait for them to close": a wait is for the page to become
    // something else, and a read again on it would store `[]` over the two
    // toasts the step read. The rule is about the action, so the wait here
    // succeeds at once on a page that does not change — nothing is timed.
    const body = '<!doctype html><html><body><div id="toasts">'
      + '<p class="toast success">Saved</p><p class="toast info">Synced</p></div></body></html>';
    const { result, requests, params } = await runStep(
      [plan([
        readOf('#toasts .toast', { as: 'toasts', description: 'Read every toast' }),
        { action: 'wait', waitType: 'selector', condition: '#toasts', timeout: 5000, description: 'Wait for the toast area' },
      ])],
      { body, instruction: 'Read the toasts shown [store as: toasts], then wait for them to close' },
    );
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(1);
    expect(params.toasts).toBe('["Saved","Synced"]');
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('unseen');
  });

  it('ends on a read the same turn then moved to another tab after, without showing it', async () => {
    // A tab move and a new tab are handled before the end of an action, where
    // the rule used to be asked; the read was shown against the other tab and
    // a read again there stored its list over the step's.
    const shop = '<!doctype html><html><head><title>Shop</title></head><body><ul id="orders">'
      + '<li class="order">Order 12</li><li class="order">Order 13</li><li class="order total">Total: 2</li></ul></body></html>';
    const admin = '<!doctype html><html><head><title>Admin</title></head><body><ul id="orders">'
      + '<li class="order">Order 99</li></ul></body></html>';
    const moves: Array<[string, Record<string, unknown>]> = [
      ['switchPage', { action: 'switchPage', page: 'admin', description: 'Switch to the Admin tab' }],
      ['openPage', { action: 'openPage', url: `${ORIGIN}/admin.html`, description: 'Open the Admin page' }],
    ];
    for (const [what, move] of moves) {
      const context: BrowserContext = await browser.newContext();
      try {
        await context.route('**/*', (route) => {
          const pathname = new URL(route.request().url()).pathname;
          const body = pathname === '/shop.html' ? shop : pathname === '/admin.html' ? admin : undefined;
          return body !== undefined
            ? route.fulfill({ status: 200, contentType: 'text/html', body })
            : route.fulfill({ status: 404, body: '' });
        });
        const page = await context.newPage();
        await page.goto(`${ORIGIN}/shop.html`);
        const pageTracker = new PageTracker(page);
        context.on('page', (opened) => pageTracker.addPage(opened));
        if (what === 'switchPage') await (await context.newPage()).goto(`${ORIGIN}/admin.html`);
        const { result, requests, params } = await runStep(
          [plan([readOf('#orders li', { as: 'orders', description: 'Read every order' }), move])],
          { page, pageTracker, instruction: 'Read every order on the Shop tab [store as: orders], then switch to the Admin tab' },
        );
        expect(result.status, what).toBe('passed');
        expect(requests, what).toHaveLength(1);
        expect(params.orders, what).toBe('["Order 12","Order 13","Total: 2"]');
        expect(readsOf(result)[0]!.listReview?.outcome, what).toBe('unseen');
      } finally {
        await context.close();
      }
    }
  });

  it('ends on a read a check that polls came after, without showing it', async () => {
    // An assertion that polls waits for the page to become something; it is
    // handled before the end of an action too. Its check passes at once here.
    const poll = {
      action: 'assert', against: 'predicate', condition: 'the accounts are listed', description: 'The accounts are listed',
      poll: { timeoutMs: 5000, intervalMs: 100 },
    };
    const code = JSON.stringify({ code: "(() => ({ pass: true, actual: 'listed' }))()" });
    const { result, requests, params } = await runStep([plan([readOf(OVER_BROAD), poll]), code]);
    expect(result.status).toBe('passed');
    expect(requests).toHaveLength(2);
    expect(JSON.parse(params.accounts!)).toHaveLength(6);
    expect(readsOf(result)[0]!.listReview?.outcome).toBe('unseen');
  });

  it('masks a secret stored after the line was written, when the line is sent', async () => {
    // The list is read first, quoting "Savings"; a later action in the same
    // turn stores that text under a secret-looking name. The line was masked
    // with what was secret when it was written, so it is masked again when it
    // goes into the next prompt.
    const secret = {
      action: 'read', selector: '#account-list li[data-account="Savings"] .account-name',
      as: 'savings_password', description: 'Read the savings name',
    };
    const { requests, params } = await runStep([plan([readOf(OVER_BROAD), secret]), NOOP]);
    expect(params.savings_password).toBe('Savings');
    const second = textOf(requests[1]!);
    const lists = second.slice(second.indexOf('## Lists to check'), second.indexOf('## DOM Snapshot'));
    expect(lists).toContain('accounts holds 6 values');
    expect(lists).not.toContain('Savings');
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

  it('says why a list read was never shown, and whether a replaced one was', async () => {
    const html = (result: StepResult) => renderReport(reportOf(result));

    // Read again in the same turn, before any prompt showed it.
    const sameTurn = (await runStep([plan([readOf(OVER_BROAD), readOf(RIGHT)])])).result;
    expect(readsOf(sameTurn)[0]!.listReview).toMatchObject({ outcome: 'replaced' });
    expect(readsOf(sameTurn)[0]!.listReview!.shown).toBeUndefined();
    expect(html(sameTurn)).toContain('list read replaced by a later read before the model was shown it');

    // A click after it, in the same turn.
    const cart = '<!doctype html><html><body><ul id="cart"><li class="item">Widget</li><li class="item new">Gadget</li></ul>'
      + '<button id="empty" onclick="document.getElementById(\'cart\').innerHTML=\'\'">Empty</button></body></html>';
    const clicked = (await runStep(
      [plan([readOf('#cart li', { as: 'items' }), { action: 'click', selector: '#empty', description: 'Empty the cart' }])],
      { body: cart, instruction: 'Read every item in the cart [store as: items], then empty the cart' },
    )).result;
    expect(readsOf(clicked)[0]!.listReview?.unseenBecause).toBe('page-changed');
    expect(html(clicked))
      .toContain('list read never shown to the model: an action after it in the same turn may have changed the page it read');

    // A return in the same turn.
    const returned = (await runStep(
      [plan([readOf(NOTHING), { action: 'return', description: 'The panel lists no accounts' }])],
      { instruction: 'If the Your accounts panel lists no accounts then return' },
    )).result;
    expect(readsOf(returned)[0]!.listReview?.unseenBecause).toBe('returned');
    expect(html(returned)).toContain('list read never shown to the model: the step returned in the same turn');

    // No turn left.
    const last = (await runStep([plan(readOf(OVER_BROAD))], { maxTurns: 1 })).result;
    expect(readsOf(last)[0]!.listReview?.unseenBecause).toBe('no-turn-left');

    // The turn that read it failed, and the retry read it again.
    const failed = (await runStep([plan([readOf(NOTHING), CLICK_NOTHING]), plan(readOf(RIGHT))], { retries: 1 })).result;
    expect(readsOf(failed)[0]!.listReview).toMatchObject({ outcome: 'pending' });
    expect(readsOf(failed)[0]!.listReview!.shown).toBeUndefined();
    expect(html(failed)).toContain('list read never shown to the model: its attempt ended before it could be');

    // Shown, and not answered.
    const unanswered = (await runStep([plan(readOf(NOTHING)), plan({ action: 'click', selector: '#x', description: 'x' })])).result;
    expect(html(unanswered)).toContain('list read shown to the model, which did not answer it');
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

/** A test's `.steps.ts` holding `entries`, as an author's would. */
function stepsFileWith(entries: string[]): string {
  return [
    "import { defineSteps } from 'steptix/codebehind';",
    'export default defineSteps([',
    ...entries.map((e) => `  ${e},`),
    ']);',
    '',
  ].join('\n');
}

/** A row of a run the test scripts: passed under AI unless `over` says otherwise. */
function ranRow(index: number, over: Partial<StepResult> = {}): StepResult {
  return { index, instruction: `step ${index}`, status: 'passed', turns: [], durationMs: 1, retried: false, ...over };
}

/** A replay outcome of `rows`, failed when one failed and was not deliberate. */
function replayOf(rows: StepResult[]): CompileRunOutcome {
  const failed = rows.some((r) => r.status === 'failed' && r.deliberate !== true);
  return { status: failed ? 'failed' : 'passed', ...outcomeRows(rows, rows.length), resolvedParameters: {}, tokensUsed: 0 };
}

/** A boxed compile of a test of `lines` over a scripted Record and replay. */
async function compileOver(
  lines: string[],
  recorded: StepResult[],
  replayed: StepResult[],
  entries: string[] = [],
  opts: { select?: CompileSelect; dryRun?: boolean; markdown?: string; stepsFile?: string; client?: AiClient } = {},
): Promise<{ compile: Awaited<ReturnType<typeof compileTest>>; done: string; events: CompileEvent[]; dir: string }> {
  const dir = await fs.mkdtemp(path.join(scratch, 'causes-'));
  const md = path.join(dir, 'accounts.md');
  await fs.writeFile(
    md,
    opts.markdown ?? ['# Accounts', '', '## Steps', ...lines.map((l, i) => `${i + 1}. ${l}`), ''].join('\n'),
    'utf-8',
  );
  if (opts.stepsFile !== undefined) await fs.writeFile(path.join(dir, 'accounts.steps.ts'), opts.stepsFile, 'utf-8');
  else if (entries.length > 0) await fs.writeFile(path.join(dir, 'accounts.steps.ts'), stepsFileWith(entries), 'utf-8');
  const events: CompileEvent[] = [];
  // Sized by the test as parsed — a section or a data table expands it — and
  // never by \`lines\`, which a test with markdown of its own leaves empty: rows
  // past the count are dropped, and a compile with none stops at step 1.
  const test = await parseTestFile(md);
  const total = test.steps.length;
  const runner: CompileRunner = async (request) => {
    if (request.purpose === 'record') {
      const failed = recorded.some((r) => r.status === 'failed' && r.deliberate !== true);
      return { status: failed ? 'failed' : 'passed', ...outcomeRows(recorded, total), resolvedParameters: {}, tokensUsed: 0 };
    }
    const rows = replayed.map((r) => ({ ...r }));
    const failed = rows.some((r) => r.status === 'failed' && r.deliberate !== true);
    return { status: failed ? 'failed' : 'passed', ...outcomeRows(rows, total), resolvedParameters: {}, tokensUsed: 0 };
  };
  const compile = await compileTest({
    test,
    config: configWith(0),
    contextContent: '',
    aiClient: opts.client ?? reviewOnlyClient().client,
    runner,
    onEvent: (e) => events.push(e),
    ...(opts.select !== undefined && { select: opts.select }),
    ...(opts.dryRun === true && { dryRun: true }),
  });
  const done = (events.find((e) => e.kind === 'done') as { message: string } | undefined)?.message ?? '';
  return { compile, done, events, dir };
}

/** A turn of `actions`, each a sub-action with `extra` merged in where given. */
function turnOf(subs: Array<{ action: Record<string, unknown>; extra?: Partial<SubActionResult> }>): StepResult['turns'][number] {
  return {
    turnNumber: 1,
    attemptNumber: 1,
    timestamp: new Date(0).toISOString(),
    aiInteractions: [],
    subActions: subs.map(({ action, extra }, i) => ({ index: i + 1, action: action as unknown as AIAction, durationMs: 1, ...extra })),
  };
}

/**
 * A model that writes an entry for a generation or a repair — a click, and a
 * read of every result for a repair — and answers Review with the file as it
 * stands, keeping every prompt.
 */
function generatingClient(selector = '#results li', as = 'titles'): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = textOf(messages.slice(-1));
      prompts.push(last);
      const file = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(last)?.[1];
      if (/Review a generated Playwright code-behind file/.test(last) && file !== undefined) {
        return { text: JSON.stringify({ file }), model: 'scripted' };
      }
      const source = JSON.stringify(/## The (?:step|line), exactly as authored\n(.*)\n/.exec(last)?.[1] ?? 'step');
      // Reads with the recorded selector, as a generation must (§6.2).
      const body = `await page.click('#open'); await step.read({ selector: ${JSON.stringify(selector)}, multiple: true, as: ${JSON.stringify(as)} });`;
      return { text: JSON.stringify({ entry: `{ source: ${source}, async run({ page, step }) { ${body} } }` }), model: 'scripted' };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

/** What `print` writes to the console, line by line, colour codes removed. */
function printed(print: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' ').replace(/\u001b\[[0-9;]*m/g, '').trim());
  });
  try {
    print();
  } finally {
    spy.mockRestore();
  }
  return lines;
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

  it('leaves a working entry alone when the pass that healed it read an empty list', async () => {
    // The entry ran as code on one pass, then threw on another, where the step
    // healed under AI and read an empty list the model kept. Before, the
    // healed pass ranked with the clean one and lost: the compile generated
    // from a transcript with nothing in it and wrote `ai: true` over the entry.
    const { result: kept } = await runStep([plan(readOf(NOTHING)), NOOP]);
    // Step 2 has no entry, so the default compile selects it and records with
    // code-behind on; step 1's entry throws during that Record and the step
    // joins the selection. Step 2 counted 0, so it compiles nothing either.
    const COUNT = 'Count the accounts in the Your accounts panel [store as: account_count]';
    const { result: counted } = await runStep(
      [plan({ action: 'count', selector: '#account-list > li.account-card', as: 'account_count', description: 'Count' }), NOOP],
      { instruction: COUNT },
    );
    const dir = await fs.mkdtemp(path.join(scratch, 'healed-'));
    const md = path.join(dir, 'accounts.md');
    const stepsFile = path.join(dir, 'accounts.steps.ts');
    await fs.writeFile(md, `# Accounts\n\n## Steps\n1. ${STEP}\n2. ${COUNT}\n`, 'utf-8');
    const entries = [
      "import { defineSteps } from 'steptix/codebehind';",
      'export default defineSteps([',
      `  { source: ${JSON.stringify(STEP)}, async run({ page, step }) { step.setVar('accounts', JSON.stringify(await page.locator('#account-list li').allTextContents())); } },`,
      ']);',
      '',
    ].join('\n');
    await fs.writeFile(stepsFile, entries, 'utf-8');
    const asCode: StepResult = {
      index: 1, instruction: STEP, status: 'passed', turns: [], durationMs: 1, retried: false, fromCodeBehind: true,
    };
    const healed: StepResult = {
      ...kept,
      fromCodeBehind: true,
      codeBehindStale: { file: stepsFile, source: STEP, error: 'locator.click: Timeout 10000ms exceeded' },
    };
    expect(evidenceRows([asCode, healed])[0]).toBe(healed);

    const { client, prompts } = reviewOnlyClient();
    const events: CompileEvent[] = [];
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') {
        const rows = [asCode, healed, { ...counted, index: 2 }];
        return { status: 'passed', ...outcomeRows(rows, 2), resolvedParameters: {}, tokensUsed: 0 };
      }
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

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'step', step: 1, message: 'joined the selection: its entry failed during Record',
    }));
    expect(prompts).toEqual([]);
    expect(compile.status).toBe('partial');
    expect(compile.summary.notAttempted).toEqual([1, 2]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'step', step: 1, message: EMPTY_REASON }));
    // The entry stays as it is — not regenerated, and not written off.
    expect(await fs.readFile(stepsFile, 'utf-8')).toBe(entries);
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
    expect(onceOut.summary.unprovenReads).toEqual([{ step: 1, reason: EMPTY_REASON }]);
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
    expect(twiceOut.summary.unprovenReads).toBeUndefined();
    const file = twiceOut.files[stepsFile] ?? '';
    expect(file).toContain('fromRecording: true');
    expect(file).toContain('span:first-of-type');
    expect(file).not.toContain(NOTHING);
  });

  it('runs an entry it leaves broken under AI in the replay, and proves the steps after it', async () => {
    // Step 1's entry threw during the Record, and the step healed under AI on
    // a list that came back empty: no new entry, and the broken one stays in
    // the file. A strict replay used to run it, fail on it and stop — proving
    // nothing after it, and sending the author to recompile a step that reads
    // the same empty list again.
    const { result: kept } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: heading } = await runStep([plan(HEADING)], { instruction: HEADING_STEP });
    const dir = await fs.mkdtemp(path.join(scratch, 'stale-'));
    const md = path.join(dir, 'accounts.md');
    const stepsFile = path.join(dir, 'accounts.steps.ts');
    await fs.writeFile(md, `# Accounts\n\n## Steps\n1. ${STEP}\n2. ${HEADING_STEP}\n`, 'utf-8');
    await fs.writeFile(stepsFile, stepsFileWith([`{ source: ${JSON.stringify(STEP)}, async run({ page }) { await page.click('#accounts-tab'); } }`]), 'utf-8');
    const healed: StepResult = {
      ...kept,
      fromCodeBehind: true,
      codeBehindStale: { file: stepsFile, source: STEP, error: 'locator.click: Timeout 10000ms exceeded' },
    };
    const record = { status: 'passed' as const, ...outcomeRows([healed, { ...heading, index: 2 }], 2), resolvedParameters: {}, tokensUsed: 0 };

    const compileWith = async (stepOne: StepResult) => {
      const replayed: string[] = [];
      const events: CompileEvent[] = [];
      const runner: CompileRunner = async (request) => {
        if (request.purpose === 'record') return record;
        replayed.push(await fs.readFile(request.candidateFiles![stepsFile]!, 'utf-8'));
        return replayOf([stepOne, ranRow(2, { fromCodeBehind: true })]);
      };
      const compile = await compileTest({
        test: await parseTestFile(md),
        config: configWith(0),
        contextContent: '',
        aiClient: reviewOnlyClient().client,
        runner,
        onEvent: (e) => events.push(e),
        dryRun: true,
      });
      return { compile, replayed, events };
    };

    const { compile, replayed, events } = await compileWith(ranRow(1));
    // The replay's copy ran step 1 under AI, and step 2's new entry as code…
    expect(replayed.length).toBeGreaterThan(0);
    for (const copy of replayed) {
      expect(entryTextIn(copy, STEP, undefined)).toContain('ai: true');
      expect(entryTextIn(copy, HEADING_STEP, undefined)).toContain('fromRecording: true');
    }
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'step', phase: 'replay', step: 1,
      message: 'runs under AI: its entry broke on the recording run, and this compile wrote no new one',
    }));
    // …which proved it. Step 1 is named for what it is, and the proposal keeps
    // its entry as it was: only the replay's copy ran it under AI.
    expect(compile.status).toBe('partial');
    expect(compile.summary.compiled).toBe(1);
    expect(compile.summary.unproven).toEqual([]);
    expect(compile.summary.notAttempted).toEqual([1]);
    expect(compile.summary.kept).toBe(0);
    // Its entry, which broke, is left as it was — and still owed, above.
    expect(compile.summary.unprovenReads).toEqual([{ step: 1, reason: EMPTY_REASON, keptEntry: true }]);
    expect(compile.summary.error).toBeUndefined();
    const proposed = compile.files[stepsFile] ?? '';
    expect(entryTextIn(proposed, STEP, undefined)).toContain('#accounts-tab');
    expect(proposed).not.toContain('ai: true');

    // A step 1 that fails even under AI is said as that, with the reason it
    // has no new entry — not "recompile it".
    const failed = await compileWith(ranRow(1, { status: 'failed', error: 'the panel did not load' }));
    expect(failed.compile.summary.error).toBe(
      'step 1 failed on the replay under AI — the panel did not load '
        + `(its entry broke on the recording run, and this compile wrote no new one: ${EMPTY_REASON})`,
    );
  });

  it('runs an entry under AI in the replay only when the writer can find it', async () => {
    // An entry whose `source` is a template literal binds, but the writer
    // cannot find it, and splicing `ai: true` in added a second entry beside
    // it — which the replay still bound — while the compile said the step ran
    // under AI.
    const { result: kept } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: heading } = await runStep([plan(HEADING)], { instruction: HEADING_STEP });
    const dir = await fs.mkdtemp(path.join(scratch, 'unfound-'));
    const md = path.join(dir, 'accounts.md');
    const stepsFile = path.join(dir, 'accounts.steps.ts');
    await fs.writeFile(md, `# Accounts\n\n## Steps\n1. ${STEP}\n2. ${HEADING_STEP}\n`, 'utf-8');
    await fs.writeFile(stepsFile, stepsFileWith([`{ source: \`${STEP}\`, async run({ page }) { await page.click('#accounts-tab'); } }`]), 'utf-8');
    const healed: StepResult = { ...kept, fromCodeBehind: true, codeBehindStale: { file: stepsFile, source: STEP, error: 'locator.click: Timeout' } };
    const replayed: string[] = [];
    const events: CompileEvent[] = [];
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return { status: 'passed', ...outcomeRows([healed, { ...heading, index: 2 }], 2), resolvedParameters: {}, tokensUsed: 0 };
      replayed.push(await fs.readFile(request.candidateFiles![stepsFile]!, 'utf-8'));
      return replayOf([ranRow(1), ranRow(2, { fromCodeBehind: true })]);
    };
    await compileTest({ test: await parseTestFile(md), config: configWith(0), contextContent: '', aiClient: reviewOnlyClient().client, runner, onEvent: (e) => events.push(e), dryRun: true });
    expect(replayed.length).toBeGreaterThan(0);
    for (const copy of replayed) expect(copy).not.toContain('ai: true');
    expect(events.some((e) => e.kind === 'step' && e.message.startsWith('runs under AI'))).toBe(false);
  });

  it('compiles an entry several steps share from the step whose run proves it', async () => {
    // A `### Section` table's rows bind one entry. The compile stood the first
    // row in for all of them: one that read an empty list left the entry
    // uncompiled for good — the first row always comes first — and one that
    // ran clean as code, with no transcript, had `ai: true` written over it.
    const { result: empty } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: right } = await runStep([plan(readOf(RIGHT))]);
    const { result: heading } = await runStep([plan(HEADING)], { instruction: HEADING_STEP });
    const section = 'Read each panel';
    const markdown = [
      '# Accounts', '', '## Steps', `1. ${section}`, `2. ${HEADING_STEP}`, '',
      `### ${section}`, '| panel |', '|-------|', '| first |', '| second |', '', `1. ${STEP}`, '',
    ].join('\n');
    const scenarios: Array<[string, StepResult, string | undefined]> = [
      ['row 1 read an empty list', empty, undefined],
      ['row 1 ran clean as code', ranRow(1, { fromCodeBehind: true }), `{ source: ${JSON.stringify(STEP)}, section: ${JSON.stringify(section)}, async run({ page }) { await page.click('#accounts-tab'); } }`],
    ];
    for (const [what, rowOne, entry] of scenarios) {
      const dir = await fs.mkdtemp(path.join(scratch, 'rows-'));
      const md = path.join(dir, 'accounts.md');
      const stepsFile = path.join(dir, 'accounts.steps.ts');
      await fs.writeFile(md, markdown, 'utf-8');
      if (entry !== undefined) await fs.writeFile(stepsFile, stepsFileWith([entry]), 'utf-8');
      // Row 2 read the names: healed under AI when the entry was there.
      const rowTwo: StepResult = {
        ...right,
        index: 2,
        ...(entry !== undefined && {
          fromCodeBehind: true,
          codeBehindStale: { file: stepsFile, source: STEP, error: 'locator.click: Timeout 10000ms exceeded' },
        }),
      };
      const events: CompileEvent[] = [];
      const runner: CompileRunner = async (request) => {
        if (request.purpose === 'record') {
          return { status: 'passed', ...outcomeRows([{ ...rowOne, index: 1 }, rowTwo, { ...heading, index: 3 }], 3), resolvedParameters: {}, tokensUsed: 0 };
        }
        return replayOf([1, 2, 3].map((index) => ranRow(index, { fromCodeBehind: true })));
      };
      const compile = await compileTest({
        test: await parseTestFile(md),
        config: configWith(0),
        contextContent: '',
        aiClient: reviewOnlyClient().client,
        runner,
        onEvent: (e) => events.push(e),
        dryRun: true,
      });
      expect(compile.status, what).toBe('green');
      expect(compile.summary.notAttempted, what).toEqual([]);
      expect(events, what).toContainEqual(expect.objectContaining({
        kind: 'step', phase: 'select', step: 2,
        message: "its entry, shared with step 1, takes its evidence from this step's run, which is better evidence",
      }));
      const written = entryTextIn(compile.files[stepsFile] ?? '', STEP, section) ?? '';
      expect(written, what).toContain('fromRecording: true');
      expect(written, what).toContain(`selector: '${RIGHT}'`);
      expect(written, what).not.toContain('ai: true');
    }
  });

  it('names a step that read a list proving nothing apart from steps a stop or an end kept from running', async () => {
    // Step 1 ran and passed, on an empty list; steps 3–4 never ran. Said in one
    // list, "steps 1, 3–4 not attempted (the run ended at step 3…)" is wrong
    // about step 1.
    const { result: kept } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: heading } = await runStep([plan(HEADING)], { instruction: HEADING_STEP });
    const LAST = 'Open the first account';

    // The recording stopped: step 3 failed.
    const stopped = await compileOver(
      [STEP, HEADING_STEP, 'Open the Payments tab', LAST],
      [kept, { ...heading, index: 2 }, ranRow(3, { status: 'failed', error: 'the tab did not open' })],
      [ranRow(1), ranRow(2, { fromCodeBehind: true })],
    );
    expect(stopped.compile.summary.stoppedAt?.step).toBe(3);
    expect(stopped.compile.summary.notAttempted).toEqual([1, 3, 4]);
    expect(stopped.compile.summary.unprovenReads).toEqual([{ step: 1, reason: EMPTY_REASON }]);
    expect(stopped.done).toContain('step 1 not attempted (an empty list read on the recording run proves nothing about the selector)');
    expect(stopped.done).toContain('stopped at step 3');
    expect(stopped.done).not.toMatch(/steps 1, 3/);
    // A dry run says the same. It used to say only that it wrote nothing
    // whenever its replay passed, leaving steps 1 and 3–4 unexplained.
    const dry = await compileOver(
      [STEP, HEADING_STEP, 'Open the Payments tab', LAST],
      [kept, { ...heading, index: 2 }, ranRow(3, { status: 'failed', error: 'the tab did not open' })],
      [ranRow(1), ranRow(2, { fromCodeBehind: true })],
      [],
      { dryRun: true },
    );
    expect(dry.done).toContain('step 1 not attempted (an empty list read on the recording run proves nothing about the selector)');
    expect(dry.done).toContain('stopped at step 3');
    expect(dry.done).toContain('Dry run — nothing written.');
    const lines = printed(() => printSummary(stopped.compile, true));
    expect(lines).toContain('Step 3 failed under AI — the tab did not open Not attempted: steps 3–4.');
    expect(lines).toContain(`Not compiled: step 1 — ${EMPTY_REASON}. It stays AI; the next compile takes it again.`);

    // The recording ended as step 3 says, and step 4 is past the end.
    const ENDING = 'Fail the test if the page heading says Payments';
    const ended = await compileOver(
      [HEADING_STEP, STEP, ENDING, LAST],
      [heading, { ...kept, index: 2 }, ranRow(3, { status: 'failed', deliberate: true, fromCodeBehind: true, error: 'the heading says Payments' })],
      [ranRow(1, { fromCodeBehind: true }), ranRow(2), ranRow(3, { status: 'failed', deliberate: true, fromCodeBehind: true, error: 'the heading says Payments' })],
      [`{ source: ${JSON.stringify(ENDING)}, async run() {} }`],
    );
    expect(ended.compile.summary.endedAsWritten?.step).toBe(3);
    expect(ended.compile.summary.notAttempted).toEqual([2, 4]);
    expect(ended.compile.summary.error).toBe(
      `the run ended at step 3 as its text says (${ENDING}); not attempted: step 4`,
    );
    expect(ended.done).toContain('step 4 not attempted on the recording run (the run ended at step 3 as its text says)');
    expect(ended.done).toContain('step 2 not attempted (an empty list read on the recording run proves nothing about the selector)');
  });

  it('counts a step that keeps its working entry as kept, and not as one owed an entry', async () => {
    // `--all` recompiles every step. One whose list came back empty keeps the
    // entry it has, and that entry works: it is kept, and the next compile
    // owes it nothing — the summary used to count it both ways.
    const { result: kept } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: heading } = await runStep([plan(HEADING)], { instruction: HEADING_STEP });
    const entry = `{ source: ${JSON.stringify(STEP)}, async run({ step }) { await step.read({ selector: ${JSON.stringify(RIGHT)}, multiple: true, as: 'accounts' }); } }`;
    const { compile, done } = await compileOver(
      [STEP, HEADING_STEP],
      [kept, { ...heading, index: 2 }],
      [ranRow(1, { fromCodeBehind: true }), ranRow(2, { fromCodeBehind: true })],
      [entry],
      { select: { all: true } },
    );
    expect(compile.summary.compiled).toBe(1);
    expect(compile.summary.kept).toBe(1);
    expect(compile.summary.notAttempted).toEqual([]);
    expect(compile.summary.unprovenReads).toEqual([{ step: 1, reason: EMPTY_REASON, keptEntry: true }]);
    expect(done).toContain(
      'step 1 not compiled again, its entry left as it was (an empty list read on the recording run proves nothing about the selector)',
    );
    expect(printed(() => printSummary(compile, false)))
      .toContain(`Not compiled: step 1 — ${EMPTY_REASON}. Its existing entry is left as it was.`);
    // Not all of what `--all` asked for was compiled: partial, not green — and
    // a dry run says why, too.
    expect(compile.status).toBe('partial');
    const dry = await compileOver(
      [STEP, HEADING_STEP],
      [kept, { ...heading, index: 2 }],
      [ranRow(1, { fromCodeBehind: true }), ranRow(2, { fromCodeBehind: true })],
      [entry],
      { select: { all: true }, dryRun: true },
    );
    expect(dry.compile.status).toBe('partial');
    expect(dry.done).toContain('step 1 not compiled again, its entry left as it was');

    // MB8: the same step named alone ends on "Nothing to compile", and is
    // counted kept there too.
    const alone = await compileOver([STEP, HEADING_STEP], [kept, { ...heading, index: 2 }], [], [entry], { select: { steps: [1] } });
    expect(alone.done).toContain('Nothing to compile');
    expect(alone.compile.summary.kept).toBe(1);
    expect(alone.compile.summary.notAttempted).toEqual([]);
  });

  it('writes an entry into a steps file that is empty, and fails a compile it cannot write into without throwing', async () => {
    // An empty file holds no entry list: it is written as new, as no file is.
    const { result: heading } = await runStep([plan(HEADING)], { instruction: HEADING_STEP });
    const fresh = await compileOver([HEADING_STEP], [heading], [ranRow(1, { fromCodeBehind: true })], [], { stepsFile: '' });
    expect(Object.values(fresh.compile.files).join('\n')).toContain('fromRecording: true');

    // A computer-mode step's `ai: true` into a file with no entry list: the
    // compile fails and says why, as any generation it cannot apply.
    const COMPUTER = 'Click the OK button in the print dialog';
    const computer = ranRow(1, { instruction: COMPUTER, surface: 'computer', turns: [turnOf([{ action: { action: 'noop', description: 'x' } }])] });
    const refused = await compileOver([COMPUTER], [computer], [], [], { stepsFile: '// notes about this test\n' });
    expect(refused.compile.status).toBe('failed');
    expect(refused.compile.summary.error).toMatch(/^generation failed for step 1: /);
  });

  it('counts an inlining a return kept from running as no gap when another inlining proved the entry', async () => {
    // A section called twice whose first call returned early: its second line
    // ran only on the second call, which proves the entry they share.
    const markdown = ['# T', '', '## Steps', '1. Dismiss the banner', '2. Dismiss the banner', '',
      '### Dismiss the banner', '1. If no banner is shown then return', '2. Click the banner close button', ''].join('\n');
    const skipped = (index: number): StepResult => ranRow(index, { status: 'skipped', aiExplanation: 'Not run: step 1 returned from "Dismiss the banner"' });
    const returned = ranRow(1, { flowControl: { kind: 'return', verb: 'return' }, turns: [turnOf([{ action: { action: 'return', description: 'no banner' } }])] });
    const shown = ranRow(3, { turns: [turnOf([{ action: { action: 'noop', description: 'a banner is shown' } }])] });
    const closed = ranRow(4, { turns: [turnOf([{ action: { action: 'click', selector: '#close', description: 'Close the banner' } }])] });
    const { compile } = await compileOver(
      [],
      [returned, skipped(2), shown, closed],
      [ranRow(1, { fromCodeBehind: true, flowControl: { kind: 'return', verb: 'return' } }), skipped(2), ranRow(3, { fromCodeBehind: true }), ranRow(4, { fromCodeBehind: true })],
      [],
      { markdown, client: generatingClient().client, dryRun: true },
    );
    expect(compile.summary.unproven).toEqual([]);
    expect(compile.summary.error ?? '').not.toContain('never reached');
  });

  it('repairs an entry several steps share from the run it was compiled from, never a row whose list came back empty', async () => {
    // Row 1's list came back empty; the entry is compiled from row 2's run.
    // When it then fails on row 1, the repair was shown row 1's empty read as
    // the recording to match — and a repair that matched it compiled a
    // selector that finds nothing.
    const section = 'Search each term';
    const line = 'Open the results and read every result title [store as: titles]';
    const markdown = ['# Search', '', '## Steps', `1. ${section}`, '', `### ${section}`, '| term |', '|------|', '| zzzz |', '| shoes |', '', `1. ${line}`, ''].join('\n');
    const click = { action: 'click', selector: '#open', description: 'Open the results' };
    const empty = ranRow(1, {
      instruction: line,
      outputs: { titles: '[]' },
      turns: [turnOf([
        { action: click },
        {
          action: { action: 'read', multiple: true, selector: '#results li.none', as: 'titles', description: 'Read every title' },
          extra: { listReview: { kind: 'empty', text: 'titles is empty', outcome: 'kept', shown: true } },
        },
        { action: { action: 'noop', description: 'No results' } },
      ])],
    });
    const found = ranRow(2, {
      instruction: line,
      outputs: { titles: '["Shoe A","Shoe B"]' },
      turns: [turnOf([{ action: click }, { action: { action: 'read', multiple: true, selector: '#results li', as: 'titles', description: 'Read every title' } }])],
    });
    const { client, prompts } = generatingClient();
    // Scripted per round: row 1 fails as code, then both pass.
    const dir = await fs.mkdtemp(path.join(scratch, 'repair-'));
    const md = path.join(dir, 'search.md');
    await fs.writeFile(md, markdown, 'utf-8');
    let round = 0;
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return { status: 'passed', ...outcomeRows([empty, found], 2), resolvedParameters: {}, tokensUsed: 0 };
      round++;
      return replayOf(round === 1
        ? [ranRow(1, { status: 'failed', fromCodeBehind: true, error: 'Timeout waiting for #results li' }), ranRow(2, { fromCodeBehind: true })]
        : [ranRow(1, { fromCodeBehind: true }), ranRow(2, { fromCodeBehind: true })]);
    };
    await compileTest({ test: await parseTestFile(md), config: configWith(0), contextContent: '', aiClient: client, runner, dryRun: true });
    const repair = prompts.find((q) => q.startsWith('A generated code-behind entry was replayed'));
    expect(repair).toBeDefined();
    expect(repair).toContain('#results li');
    expect(repair).not.toContain('li.none');
    // What it must capture is still what the recording captured on the page it
    // failed on — row 1's search found nothing — not another row's values.
    expect(repair).toContain('the recording captured a list of 0 items');
    expect(repair).not.toContain('Shoe A');
  });

  it('tells a loop pass\'s repair what that pass captured, even when its list came back empty', async () => {
    // For each account: Travel has no transactions, and the model kept the
    // empty list. When the entry then fails on the Travel pass, its repair is
    // told the Travel page captured nothing — not Everyday's two values,
    // which it would then have to produce where there are none.
    const accounts = ['Everyday', 'Savings', 'Travel'];
    const line = 'For each {{account}} in {{accounts}}, Open the account named {{account}} and read every transaction [store as: txns]';
    const markdown = ['# Accounts', '', '## Parameters', `- accounts: ${JSON.stringify(accounts)}`, '', '## Steps', `1. ${line}`, '2. Click the Go button', ''].join('\n');
    const marker = (index: number): NonNullable<StepResult['loop']> => ({ kind: 'iteration', label: 'loop', index, values: { account: accounts[index - 1]! } });
    const open = { action: 'click', selector: '#open', description: 'Open the account' };
    const read = { action: 'read', multiple: true, selector: '#txns li', as: 'txns', description: 'Read every transaction' };
    const pass = (n: number, txns: string, empty: boolean): StepResult => ranRow(2, {
      loop: marker(n),
      outputs: { txns },
      turns: [turnOf([
        { action: open },
        { action: read, ...(empty && { extra: { listReview: { kind: 'empty', text: 'txns is empty', outcome: 'kept', shown: true } } }) },
        ...(empty ? [{ action: { action: 'noop', description: 'No transactions' } }] : []),
      ])],
    });
    const go = ranRow(3, { turns: [turnOf([{ action: { action: 'click', selector: '#go', description: 'Go' } }])] });
    const recorded = [ranRow(1, { loop: marker(1) }), pass(1, '["T1","T2"]', false), pass(2, '["T3"]', false), pass(3, '[]', true), go];
    const dir = await fs.mkdtemp(path.join(scratch, 'loop-repair-'));
    const md = path.join(dir, 'accounts.md');
    await fs.writeFile(md, markdown, 'utf-8');
    let round = 0;
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') {
        return { status: 'passed', ...outcomeRows(recorded, 3), resolvedParameters: { accounts: JSON.stringify(accounts), account: 'Travel' }, tokensUsed: 0 };
      }
      round++;
      const codePass = (n: number, failed: boolean): StepResult => ranRow(2, {
        loop: marker(n),
        fromCodeBehind: true,
        ...(failed && { status: 'failed' as const, error: 'Timeout waiting for #txns li' }),
      });
      return replayOf([ranRow(1, { loop: marker(1) }), codePass(1, false), codePass(2, false), codePass(3, round === 1), ranRow(3, { fromCodeBehind: true })]);
    };
    const { client, prompts } = generatingClient('#txns li', 'txns');
    await compileTest({ test: await parseTestFile(md), config: configWith(0), contextContent: '', aiClient: client, runner, dryRun: true });
    const repair = prompts.find((q) => q.startsWith('A generated code-behind entry was replayed'));
    expect(repair).toBeDefined();
    expect(repair).toContain('the recording captured a list of 0 items');
    expect(repair).not.toContain('"T1"');
  });

  it('still calls a step a return kept from running a gap when the recording ran it', async () => {
    // A section called twice. The recording ran both calls in full; on the
    // replay the first call's return entry returned, so its second line never
    // ran. Another inlining proving the entry does not make that a recording
    // replayed: a return is not a guard, and this was the only sign of it.
    const markdown = ['# T', '', '## Steps', '1. Dismiss the banner', '2. Dismiss the banner', '',
      '### Dismiss the banner', '1. If no banner is shown then return', '2. Click the banner close button', ''].join('\n');
    const noop = (index: number): StepResult => ranRow(index, { turns: [turnOf([{ action: { action: 'noop', description: 'a banner is shown' } }])] });
    const close = (index: number): StepResult => ranRow(index, { turns: [turnOf([{ action: { action: 'click', selector: '#close', description: 'Close the banner' } }])] });
    const skipped = (index: number): StepResult => ranRow(index, { status: 'skipped', aiExplanation: 'Not run: step 1 returned from "Dismiss the banner"' });
    const { compile } = await compileOver(
      [],
      [noop(1), close(2), noop(3), close(4)],
      [ranRow(1, { fromCodeBehind: true, flowControl: { kind: 'return', verb: 'return' } }), skipped(2), ranRow(3, { fromCodeBehind: true }), ranRow(4, { fromCodeBehind: true })],
      [],
      { markdown, client: generatingClient().client, dryRun: true },
    );
    expect(compile.status).toBe('partial');
    expect(compile.summary.error ?? '').toContain('never reached step 2');
  });

  it('takes back an entry from an empty steps file without proposing a file of no entries', async () => {
    // An empty file is no file: taking back the one entry the compile put in
    // it leaves nothing to propose, not a header with no entries.
    const { result: heading } = await runStep([plan(HEADING)], { instruction: HEADING_STEP });
    const { compile } = await compileOver(
      [HEADING_STEP],
      [heading],
      [ranRow(1, { status: 'failed', fromCodeBehind: true, error: 'Self-check failed' })],
      [],
      { stepsFile: '' },
    );
    expect(compile.summary.warnings ?? []).toContainEqual(expect.stringContaining('step 1 was not compiled'));
    expect(compile.files).toEqual({});
  });

  it('drops an entry several steps share by the entry, when it fails on a step it was not compiled from', async () => {
    // The entry is written from row 2's read and fails on row 1. Dropped by
    // step number, nothing was dropped: the compile counted the entry it had
    // taken back, and a later round wrote `ai: true` over the step it had
    // just said would stay AI.
    const { result: empty } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const { result: right } = await runStep([plan(readOf(RIGHT))]);
    const section = 'Read each panel';
    const markdown = ['# Accounts', '', '## Steps', `1. ${section}`, '', `### ${section}`, '| panel |', '|-------|', '| first |', '| second |', '', `1. ${STEP}`, ''].join('\n');
    const dir = await fs.mkdtemp(path.join(scratch, 'drop-'));
    const md = path.join(dir, 'accounts.md');
    await fs.writeFile(md, markdown, 'utf-8');
    let round = 0;
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') {
        return { status: 'passed', ...outcomeRows([{ ...empty, index: 1 }, { ...right, index: 2 }], 2), resolvedParameters: {}, tokensUsed: 0 };
      }
      round++;
      return replayOf(round === 1
        ? [ranRow(1, { status: 'failed', fromCodeBehind: true, error: 'Self-check failed' }), ranRow(2, { fromCodeBehind: true })]
        : [ranRow(1, { status: 'failed', error: 'the panel never loaded' }), ranRow(2)]);
    };
    const compile = await compileTest({ test: await parseTestFile(md), config: configWith(0), contextContent: '', aiClient: reviewOnlyClient().client, runner, dryRun: true });
    expect(compile.summary.compiled).toBe(0);
    expect(compile.summary.warnings).toContain(
      'step 2 was not compiled: its code, written from the recording, failed on the replay (Self-check failed). It stays AI; compile again to retry.',
    );
    expect(Object.values(compile.files).join('\n')).not.toContain('ai: true');
  });

  it('says a data-driven test compiles from its first data row, when that row\'s list came back empty', async () => {
    // Both compilers record row 1 alone, so a list empty there never compiles
    // until a row whose list has items comes first.
    const note = ' — this test compiles from its first data row, so put a row whose list has items first';
    const { result: empty } = await runStep([plan(readOf(NOTHING)), NOOP]);
    const markdown = ['# Accounts', '', '## Steps', '| panel |', '|-------|', '| first |', '| second |', '', `1. ${STEP}`, ''].join('\n');
    const boxed = await compileOver([STEP], [empty], [], [], { markdown });
    expect(boxed.compile.summary.unprovenReads).toEqual([{ step: 1, reason: EMPTY_REASON + note }]);
    expect(boxed.done).toContain('Put a data row whose list has items first, then compile again.');

    const dir = await fs.mkdtemp(path.join(scratch, 'live-rows-'));
    const live = new LiveCompiler({
      mode: 'run',
      testFilePath: path.join(dir, 'accounts.md'),
      aiClient: reviewOnlyClient().client,
      contextContent: '',
      testName: 'accounts.md',
      plan: [{ text: STEP, inScope: true, line: 5 }],
      emit: () => {},
      note: () => {},
      dataDriven: true,
    });
    live.offer({ index: 0, binding: bindingFor(STEP, path.join(dir, 'accounts.steps.ts')), result: empty, resolvedParameters: { accounts: '[]' } });
    const liveOut = await live.finish({ tokensUsed: 0 });
    expect(liveOut.summary.unprovenReads).toEqual([{ step: 1, reason: EMPTY_REASON + note }]);

    // A step whose entry broke and healed under AI: the run took the entry
    // off its binding, and the file still holds it.
    const healedLive = new LiveCompiler({
      mode: 'run',
      testFilePath: path.join(dir, 'accounts.md'),
      aiClient: reviewOnlyClient().client,
      contextContent: '',
      testName: 'accounts.md',
      plan: [{ text: STEP, inScope: true, line: 5 }],
      emit: () => {},
      note: () => {},
    });
    const stepsFile = path.join(dir, 'accounts.steps.ts');
    healedLive.offer({
      index: 0,
      binding: bindingFor(STEP, stepsFile),
      result: { ...empty, codeBehindStale: { file: stepsFile, source: STEP, error: 'locator.click: Timeout' } },
      resolvedParameters: { accounts: '[]' },
    });
    expect((await healedLive.finish({ tokensUsed: 0 })).summary.unprovenReads).toEqual([{ step: 1, reason: EMPTY_REASON, keptEntry: true }]);
  });

  it('tells each step with nothing to compile what it needs, when they need different things', async () => {
    const { result: kept } = await runStep([plan(readOf(NOTHING)), NOOP]);
    // A mixed read with no turn left to show it in: the model never checked it.
    const CARDS = 'Read every card in the Your accounts panel [store as: cards]';
    const { result: unseen } = await runStep(
      [plan(readOf(OVER_BROAD, { as: 'cards', description: 'Read every card' }))],
      { maxTurns: 1, instruction: CARDS },
    );
    expect(unprovenListRead(unseen)?.kind).toBe('unchecked');
    const { compile, done } = await compileOver([STEP, CARDS], [kept, { ...unseen, index: 2 }], []);
    expect(compile.status).toBe('partial');
    expect(compile.summary.unprovenReads?.map((u) => u.step)).toEqual([1, 2]);
    expect(done).toBe(
      'Nothing to compile: step 1 read an empty list on the recording run, which proves nothing about the selector, '
        + 'and step 2 ended on a list read the model never checked. '
        + 'Step 1: run it where the list has items; step 2: run it again; then compile again.',
    );
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
