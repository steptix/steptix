import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { executeAction, waitForStableCount } from '../src/browser/actions.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { storeCapture } from '../src/runner/store-capture.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { logger } from '../src/utils/logger.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import type { RecordedAction } from '../src/codebehind/recording.js';
import type { Candidate } from '../src/codebehind/candidate.js';
import type { StepCodeEntry } from '../src/codebehind/types.js';
import { entryFromRecording, recordedReadMismatch } from '../src/codebehind/generate.js';
import { runCodeBehindEntry } from '../src/codebehind/execute.js';
import { buildFileReviewPrompt, reviewCandidate } from '../src/codebehind/review.js';
import { LiveCompiler, type LiveCompileEvent } from '../src/codebehind/live-compile.js';
import { compileTest, outcomeRows, type CompileRunOutcome, type CompileRunner } from '../src/codebehind/compile.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * Steps that only read are compiled from the recording
 * (docs/specs/SPEC-codebehind-robustness.md §6.6).
 *
 * When the AI performed failure B's step it wrote no code: it chose a `read`
 * action and Steptix carried it out. So the entry for a step that only reads is
 * that action's fields handed to `step.read` / `step.count`, which run the same
 * path — and on the same page store exactly what the run stored. No model is
 * asked, so the selector cannot lose its `:first-child` on the way.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Failure B, as recorded ───────────────────────────────────────────────────

const B_STEP = 'Read the name of every account in the Your accounts panel [store as: accounts]';
const B_SELECTOR = '#account-list [data-testid="account-row"] > span > span:first-child';
const B_NAMES = '["Everyday","Savings","Travel"]';
const B_READ: RecordedAction = {
  action: 'read',
  multiple: true,
  as: 'accounts',
  selector: B_SELECTOR,
  targeting: { matchCount: 3, kinds: ['span.account-name'] },
};
/** What the model looked at before it read: shown the page, left out. */
const B_FIND: RecordedAction = { action: 'find', value: 'Your accounts' };

/** The entry §6.6 writes for B, field for field. */
const B_ENTRY = [
  '{',
  "  source: 'Read the name of every account in the Your accounts panel [store as: accounts]',",
  '  fromRecording: true,',
  '  async run({ step }) {',
  '    await step.read({',
  `      selector: '#account-list [data-testid="account-row"] > span > span:first-child',`,
  '      multiple: true,',
  "      as: 'accounts',",
  "      kinds: ['span.account-name'],",
  '    });',
  '  },',
  '}',
].join('\n');

function bindingFor(source: string, over: Partial<CodeBehindBinding> = {}): CodeBehindBinding {
  return {
    file: path.resolve(path.sep, 'nowhere', 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...over,
  };
}

const fromRecording = (
  source: string,
  actions: RecordedAction[],
  over: { resolvedParameters?: Record<string, string>; binding?: Partial<CodeBehindBinding>; surface?: 'browser' | 'computer' } = {},
) =>
  entryFromRecording({
    binding: bindingFor(source, over.binding),
    actions,
    resolvedParameters: over.resolvedParameters ?? {},
    ...(over.surface !== undefined && { surface: over.surface }),
  });

/** An entry's text, as the loader would hand it to the runner. */
function entryOf(text: string): StepCodeEntry {
  return new Function(`return (${text});`)() as StepCodeEntry;
}

// ── Which steps qualify ──────────────────────────────────────────────────────

describe('entryFromRecording — which steps are written from the recording', () => {
  it("writes failure B's entry field for field, leaving out what only showed the model the page", () => {
    expect(fromRecording(B_STEP, [B_FIND, B_READ])).toBe(B_ENTRY);
  });

  it('writes a single read with a pattern, and a count, in the same shape', () => {
    const balance = fromRecording('Read the balance [store as: balance]', [
      { action: 'read', selector: '#balance', pattern: '\\$([\\d,.]+)', as: 'balance', targeting: { kinds: ['span.balance'] } },
    ]);
    expect(balance).toContain(
      "    await step.read({\n      selector: '#balance',\n      pattern: '\\\\$([\\\\d,.]+)',\n      as: 'balance',\n      kinds: ['span.balance'],\n    });",
    );
    const count = fromRecording('Count the documents [store as: document_count]', [
      { action: 'count', selector: '#documents-body > tr.doc-row', as: 'document_count', targeting: { matchCount: 3, kinds: ['tr.doc-row'] } },
    ]);
    expect(count).toContain(
      "    await step.count({\n      selector: '#documents-body > tr.doc-row',\n      as: 'document_count',\n      kinds: ['tr.doc-row'],\n    });",
    );
  });

  it('writes an entry that reads the same values the TypeScript would: quotes and backslashes survive', () => {
    const text = fromRecording("Read the owner's name [store as: owner]", [
      { action: 'read', selector: "#owner[title='a\\b']", as: 'owner' },
    ])!;
    const run = String(entryOf(text).run);
    expect(entryOf(text).source).toBe("Read the owner's name [store as: owner]");
    expect(run).toContain(`selector: '#owner[title=\\'a\\\\b\\']'`);
  });

  it('sends a step that also acts to the model', () => {
    expect(fromRecording(B_STEP, [{ action: 'click', selector: '#show-accounts' }, B_READ])).toBeUndefined();
  });

  it('sends a step that states an expectation to the model', () => {
    expect(
      fromRecording(B_STEP, [B_READ, { action: 'assert', description: 'three accounts', expected: '3 accounts' }]),
    ).toBeUndefined();
  });

  it('sends a read whose selector holds a resolved parameter value to the model', () => {
    expect(
      fromRecording(
        'Read the balance of {{account}} [store as: balance]',
        [{ action: 'read', selector: '#account-list [data-account="Everyday"] .account-balance', as: 'balance' }],
        { resolvedParameters: { account: 'Everyday' } },
      ),
    ).toBeUndefined();
  });

  it('keeps a {{placeholder}} selector as written', () => {
    const text = fromRecording(
      'Read the balance of {{account}} [store as: balance]',
      [{ action: 'read', selector: '#account-list [data-account="{{account}}"] .account-balance', as: 'balance' }],
      { resolvedParameters: { account: 'Everyday' } },
    );
    expect(text).toContain(`selector: '#account-list [data-account="{{account}}"] .account-balance',`);
  });

  it('sends a positional read the step tells apart by name to the model', () => {
    expect(
      fromRecording('Read the balance of "Savings" [store as: balance]', [
        {
          action: 'read',
          selector: '#account-list > li:nth-child(2) .account-balance',
          as: 'balance',
          targeting: { matchCount: 1, resolvedBy: 'positional' },
        },
      ]),
    ).toBeUndefined();
  });

  it('sends a step whose captures the reads do not account for to the model', () => {
    // Stored under a name the line does not declare.
    expect(fromRecording(B_STEP, [{ ...B_READ, as: 'names' }])).toBeUndefined();
    // Declares two, reads one.
    expect(fromRecording('Read the names [store as: accounts] and the total [store as: total]', [B_READ])).toBeUndefined();
    // Declares nothing.
    expect(fromRecording('Read the account names', [B_READ])).toBeUndefined();
  });

  it('sends a step that ran on the computer surface to the model', () => {
    expect(fromRecording(B_STEP, [B_READ], { surface: 'computer' })).toBeUndefined();
  });

  it('sends a step with nothing but exploration, or nothing at all, to the model', () => {
    expect(fromRecording(B_STEP, [B_FIND])).toBeUndefined();
    expect(fromRecording(B_STEP, [])).toBeUndefined();
  });

  it('writes a read inside a skill body under the authored names, placeholders included', () => {
    const text = fromRecording(
      'Read the balance of {{account}} [store as: balance]',
      [{ action: 'read', selector: '#account-list [data-account="{{__skill1_account}}"] .account-balance', as: '__skill1_balance' }],
      { binding: { scope: { renames: { account: '__skill1_account', balance: '__skill1_balance' }, inputs: {} } } },
    );
    expect(text).toContain(`selector: '#account-list [data-account="{{account}}"] .account-balance',`);
    expect(text).toContain("as: 'balance',");
    expect(text).not.toContain('__skill1');
  });
});

describe('a model entry that does its read with step.read', () => {
  it('passes the read check: the recorded selector is there, as a selector', () => {
    const source = 'Open the accounts panel and read every name [store as: accounts]';
    const code =
      `{ source: '${source}', async run({ page, step }) { await page.click('#show-accounts'); await step.settle(); ` +
      `await step.read({ selector: '${B_SELECTOR}', multiple: true, as: 'accounts', kinds: ['span.account-name'] }); } }`;
    expect(
      recordedReadMismatch(code, [{ action: 'click', selector: '#show-accounts' }, B_READ], {
        source,
        recordedCaptures: { accounts: B_NAMES },
      }),
    ).toBeUndefined();
    // …and one that dropped the :first-child is still caught.
    expect(
      recordedReadMismatch(code.replace(':first-child', ''), [{ action: 'click', selector: '#show-accounts' }, B_READ], {
        source,
        recordedCaptures: { accounts: B_NAMES },
      }),
    ).toBeDefined();
  });
});

describe('the generation prompt for a step that also acts', () => {
  it('tells the model to do the read with step.read and the recorded fields', () => {
    const text = buildStepCodePrompt({
      rawStepText: B_STEP,
      parameters: [],
      actions: [{ action: 'click', selector: '#show-accounts' }, B_READ],
    }).content as string;
    expect(text).toContain('`await step.read({ selector, multiple, attribute, pattern, frame, as, kinds })`');
    expect(text).toContain("**Do this step's read with it**");
    expect(text).toContain('- `kinds` — on a `read` or `count`: the kinds of element it matched');
  });

  it('offers step.read without the instruction to a step that only reads, and not at all to one that does not read', () => {
    const readOnly = buildStepCodePrompt({ rawStepText: B_STEP, parameters: [], actions: [B_READ] }).content as string;
    expect(readOnly).toContain('`await step.read({');
    expect(readOnly).not.toContain("Do this step's read with it");
    const click = buildStepCodePrompt({
      rawStepText: 'Click Go',
      parameters: [],
      actions: [{ action: 'click', selector: '#go' }],
    }).content as string;
    expect(click).not.toContain('step.read(');
  });
});

// ── step.read and step.count against B's markup ──────────────────────────────

/** The `Your accounts` list exactly as the fixture app serves it. */
async function accountListMarkup(): Promise<string> {
  const html = await fs.readFile(path.join(repoRoot, 'fixtures', 'test-app', 'control-flow.html'), 'utf-8');
  const list = /<ul class="plain" id="account-list">[\s\S]*?<\/ul>/.exec(html)?.[0];
  if (!list) throw new Error('control-flow.html no longer has the #account-list markup this suite reads');
  return list;
}

describe('step.read and step.count — the AI action, run again', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let markup: string;

  beforeAll(async () => {
    markup = await accountListMarkup();
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await context?.close();
    context = await browser.newContext();
    page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>${markup}</body></html>`);
  });

  /** The AI path: the action as the model emitted it, then the shared store. */
  async function aiRead(action: AIAction): Promise<{ stored: Record<string, string>; recorded: RecordedAction }> {
    const result = await executeAction(page, action, undefined, undefined, { measure: true });
    expect(result.success).toBe(true);
    const stored: Record<string, string> = {};
    storeCapture(stored, action.as!, result, () => []);
    return { stored, recorded: { ...action, ...(result.targeting && { targeting: result.targeting }) } };
  }

  async function run(entry: StepCodeEntry, binding: Partial<CodeBehindBinding> = {}, parameters: Record<string, string> = {}) {
    const resolvedParameters = { ...parameters };
    const outcome = await runCodeBehindEntry({
      binding: { ...bindingFor(entry.source, binding), entry },
      page,
      context,
      browser,
      resolvedParameters,
      label: 'codebehind:1',
    });
    return { outcome, resolvedParameters };
  }

  it("stores what the AI's read stored, from the entry compile writes for it", async () => {
    const ai = await aiRead({ action: 'read', multiple: true, as: 'accounts', selector: B_SELECTOR, description: 'read the names' });
    expect(ai.stored.accounts).toBe(B_NAMES);
    expect(ai.recorded.targeting?.kinds).toEqual(['span.account-name']);

    const text = fromRecording(B_STEP, [ai.recorded])!;
    expect(text).toBe(B_ENTRY);
    const { outcome, resolvedParameters } = await run(entryOf(text));
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters.accounts).toBe(ai.stored.accounts);
    expect(outcome.outputs).toEqual({ accounts: B_NAMES });
  });

  it('returns the list, and a single read with a pattern and a count store what the AI path stores', async () => {
    const balance = await aiRead({
      action: 'read',
      selector: '#account-list .account-balance',
      pattern: '\\$([\\d,.]+)',
      as: 'balance',
      description: 'read the first balance',
    });
    const count = await aiRead({ action: 'count', selector: '#account-list > li', as: 'account_count', description: 'count' });
    expect(count.recorded.targeting?.kinds).toEqual(['li.account-row']);

    let returned: { list?: unknown; value?: unknown; count?: unknown } = {};
    const entry: StepCodeEntry = {
      source: 'Read them [store as: names] [store as: balance] [store as: account_count]',
      async run({ step }) {
        returned = {
          list: await step.read({ selector: B_SELECTOR, multiple: true, as: 'names', kinds: ['span.account-name'] }),
          value: await step.read({ selector: '#account-list .account-balance', pattern: '\\$([\\d,.]+)', as: 'balance' }),
          count: await step.count({ selector: '#account-list > li', as: 'account_count', kinds: ['li.account-row'] }),
        };
      },
    };
    const { outcome, resolvedParameters } = await run(entry);
    expect(outcome.status).toBe('passed');
    expect(returned).toEqual({ list: ['Everyday', 'Savings', 'Travel'], value: '1,234.56', count: 3 });
    expect(resolvedParameters.balance).toBe(balance.stored.balance);
    expect(resolvedParameters.account_count).toBe(count.stored.account_count);
    expect(resolvedParameters.account_count).toBe('3');
  });

  it('reads an iframe written into the selector the same as the AI path', async () => {
    const srcdoc = `<!doctype html><html><body>${markup}</body></html>`.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    await page.setContent(`<!doctype html><html><body><iframe id="accounts-frame" srcdoc="${srcdoc}"></iframe></body></html>`);
    await page.frameLocator('#accounts-frame').locator('#account-list').waitFor();
    // The model wrote the frame into the selector; executeAction moves it to
    // the frame field before it reads, on both paths.
    const selector = `#accounts-frame ${B_SELECTOR}`;

    const ai = await aiRead({ action: 'read', multiple: true, as: 'accounts', selector, description: 'read the names' });
    expect(ai.stored.accounts).toBe(B_NAMES);

    const { outcome, resolvedParameters } = await run(entryOf(fromRecording(B_STEP, [ai.recorded])!));
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters.accounts).toBe(B_NAMES);
  });

  it('fails the kinds self-check when the selector lost its :first-child, and stores nothing', async () => {
    const entry = entryOf(
      fromRecording(B_STEP, [{ ...B_READ, selector: '#account-list [data-testid="account-row"] > span > span' }])!,
    );
    const { outcome, resolvedParameters } = await run(entry);
    expect(outcome.status).toBe('failed');
    // The entry takes no action, so the step falls back to AI and is regenerated.
    expect(outcome.expectationFailed).toBe(false);
    expect(outcome.error).toBe(
      'Self-check failed: the read matched `span.account-number` where the run read `span.account-name`',
    );
    expect(resolvedParameters).not.toHaveProperty('accounts');
    expect(outcome.outputs).toEqual({});
  });

  it('passes an empty result, as the AI path does', async () => {
    const ai = await aiRead({ action: 'read', multiple: true, as: 'closed', selector: '#account-list li.closed-account', description: 'closed' });
    expect(ai.stored.closed).toBe('[]');
    const { outcome, resolvedParameters } = await run(
      entryOf(fromRecording('Read every closed account [store as: closed]', [{ ...ai.recorded, targeting: { matchCount: 0, kinds: ['li.closed-account'] } }])!),
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters.closed).toBe('[]');
  });

  it('stores under the frame name and fills placeholders through the frame inside a skill body', async () => {
    const text = fromRecording(
      'Read the balance of {{account}} [store as: balance]',
      [{ action: 'read', selector: '#account-list [data-account="{{__skill1_account}}"] .account-balance', as: '__skill1_balance' }],
      { binding: { scope: { renames: { account: '__skill1_account', balance: '__skill1_balance' }, inputs: {} } } },
    )!;
    const { outcome, resolvedParameters } = await run(
      entryOf(text),
      { scope: { renames: { account: '__skill1_account', balance: '__skill1_balance' }, inputs: {} } },
      { __skill1_account: 'Savings' },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters.__skill1_balance).toBe('$8,410.00');
    expect(resolvedParameters).not.toHaveProperty('balance');
    expect(outcome.outputs).toEqual({ __skill1_balance: '$8,410.00' });
  });

  it('fails, naming the placeholder, when this run has no value for it', async () => {
    const entry = entryOf(
      fromRecording('Read the balance of {{account}} [store as: balance]', [
        { action: 'read', selector: '#account-list [data-account="{{account}}"] .account-balance', as: 'balance' },
      ])!,
    );
    const { outcome } = await run(entry);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('step.read: {{account}} has no value on this run');
  });

  it('waits for a list that is still filling before it reads it', async () => {
    await page.setContent('<!doctype html><html><body><ul id="names"></ul></body></html>');
    // Three items, the last added 200 ms after the read starts: a read that
    // took what matched at the instant it started would store fewer.
    await page.evaluate(() => {
      const list = document.getElementById('names')!;
      ['a', 'b', 'c'].forEach((name, i) =>
        setTimeout(() => {
          const li = document.createElement('li');
          li.className = 'name';
          li.textContent = name;
          list.appendChild(li);
        }, 100 * i),
      );
    });
    const entry: StepCodeEntry = {
      source: 'Read the names [store as: names]',
      async run({ step }) {
        await step.read({ selector: '#names > li', multiple: true, as: 'names', kinds: ['li.name'] });
      },
    };
    const { outcome, resolvedParameters } = await run(entry);
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters.names).toBe('["a","b","c"]');
  });
});

// ── The match-count wait ─────────────────────────────────────────────────────

describe('waitForStableCount — the wait before a count or a read of every match', () => {
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t };
  }

  it('returns once the count has held still for the quiet period', async () => {
    const clock = fakeClock();
    const counts = [0, 1, 2, 3];
    let calls = 0;
    await waitForStableCount(async () => counts[Math.min(calls++, counts.length - 1)]!, {
      quietMs: 300,
      timeoutMs: 10_000,
      pollMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });
    // The last change was at 150 ms; it held still from there for 300 ms.
    expect(clock.at()).toBe(450);
  });

  it('returns after the quiet period when nothing ever matches', async () => {
    const clock = fakeClock();
    await waitForStableCount(async () => 0, { quietMs: 300, timeoutMs: 10_000, pollMs: 50, now: clock.now, sleep: clock.sleep });
    expect(clock.at()).toBe(300);
  });

  it('gives up at the timeout when the count never holds still, without throwing', async () => {
    const clock = fakeClock();
    let n = 0;
    await waitForStableCount(async () => n++, { quietMs: 300, timeoutMs: 2_000, pollMs: 50, now: clock.now, sleep: clock.sleep });
    expect(clock.at()).toBe(2_000);
  });

  it('returns at once on a Stop', async () => {
    const clock = fakeClock();
    const stop = new AbortController();
    stop.abort();
    let calls = 0;
    await waitForStableCount(
      async () => {
        calls++;
        return 1;
      },
      { quietMs: 300, timeoutMs: 10_000, now: clock.now, sleep: clock.sleep },
      stop.signal,
    );
    expect(calls).toBe(0);
    expect(clock.at()).toBe(0);
  });
});

// ── Review leaves these entries alone ────────────────────────────────────────

let tmpBase: string;
let counter = 0;
let dir: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('from-recording');
});
beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await removeScratchBase(tmpBase);
});

const CLICK_STEP = 'Open the accounts page';
const CLICK_ENTRY = `{
  source: '${CLICK_STEP}',
  async run({ page }) {
    await page.click('#accounts-link');
  },
}`;

describe('reviewCandidate leaves an entry written from the recording alone', () => {
  const fileWith = (...entries: string[]) =>
    ['const defineSteps = (x: unknown) => x;', 'export default defineSteps([', ...entries.map((e) => `  ${e},`), ']);', ''].join(
      '\n',
    );

  async function review(before: string, revision: string): Promise<{ events: string[]; replaced: string | undefined }> {
    const target = path.join(dir, 'accounts.steps.ts');
    let replaced: string | undefined;
    const candidate = {
      contentOf: () => before,
      touchedFiles: () => [target],
      replaceFile: async (_f: string, text: string) => {
        replaced = text;
      },
    } as unknown as Candidate;
    const events: string[] = [];
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await reviewCandidate(
        candidate,
        {
          markdownName: 'accounts.md',
          steps: [CLICK_STEP, B_STEP],
          guarded: [],
          aiClient: { complete: async () => ({ text: JSON.stringify({ file: revision }) }) } as unknown as AiClient,
        },
        (m) => events.push(m),
      );
      return { events, replaced };
    } finally {
      info.mockRestore();
    }
  }

  const REJECTED =
    `rejected: the revision changes the entry for ${JSON.stringify(B_STEP)}, which was written from the recording ` +
    '— the generated file stands';

  it('rejects a revision that edits one', async () => {
    const edited = B_ENTRY.replace(':first-child', '');
    const { events, replaced } = await review(fileWith(CLICK_ENTRY, B_ENTRY), fileWith(CLICK_ENTRY, edited));
    expect(events.at(-1)).toBe(REJECTED);
    expect(replaced).toBeUndefined();
  });

  it('rejects a revision that only deletes its flag', async () => {
    const unflagged = B_ENTRY.replace('  fromRecording: true,\n', '');
    const { events, replaced } = await review(fileWith(CLICK_ENTRY, B_ENTRY), fileWith(CLICK_ENTRY, unflagged));
    expect(events.at(-1)).toBe(REJECTED);
    expect(replaced).toBeUndefined();
  });

  it('accepts a revision that leaves it alone and tidies another entry', async () => {
    const tidied = CLICK_ENTRY.replace("page.click('#accounts-link')", "page.getByRole('link', { name: 'Accounts' }).click()");
    const { events, replaced } = await review(fileWith(CLICK_ENTRY, B_ENTRY), fileWith(tidied, B_ENTRY));
    expect(events.at(-1)).toBe('revised accounts.steps.ts');
    expect(replaced).toBe(fileWith(tidied, B_ENTRY));
  });

  it("tells the reviewer to leave it exactly as it is, and only when the file has one", () => {
    const rule = 'An entry marked `fromRecording: true` was written from the run\'s recording';
    const withOne = buildFileReviewPrompt({ markdownName: 'a.md', file: fileWith(B_ENTRY), steps: [B_STEP] }).content as string;
    expect(withOne).toContain(rule);
    expect(withOne).toContain('leave it exactly as it is, flag included.');
    const without = buildFileReviewPrompt({ markdownName: 'a.md', file: fileWith(CLICK_ENTRY), steps: [CLICK_STEP] })
      .content as string;
    expect(without).not.toContain(rule);
  });
});

// ── Each compile path ────────────────────────────────────────────────────────

/** A passed step whose transcript is `actions`, with what it captured. */
function readResult(
  index: number,
  instruction: string,
  actions: RecordedAction[],
  outputs?: Record<string, string>,
  over: Partial<StepResult> = {},
): StepResult {
  return {
    index,
    instruction,
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: '2026-10-07T00:00:00.000Z',
        aiInteractions: [],
        subActions: actions.map((action, i) => ({ index: i + 1, action, durationMs: 1 })),
      },
    ],
    durationMs: 4,
    retried: false,
    stepContext: { domBefore: '<ul id="account-list"></ul>', domAfter: '<ul id="account-list"><li>a</li></ul>' },
    ...(outputs && { outputs }),
    ...over,
  };
}

/** Answers generation with a click entry and review with the file unchanged,
 *  recording every prompt. */
function fakeAi(): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1]!;
      const prompt = typeof last.content === 'string' ? last.content : contentBlocksToText(last.content);
      prompts.push(prompt);
      if (/Review a generated Playwright code-behind file/.test(prompt)) {
        const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(prompt)?.[1];
        return { text: JSON.stringify({ file: fenced }), model: 'stub' };
      }
      const source = /## The step, exactly as authored\n(.*)\n/.exec(prompt)?.[1] ?? '';
      return {
        text: JSON.stringify({ entry: `{ source: ${JSON.stringify(source)}, async run({ page }) { await page.click('#accounts-link'); } }` }),
        model: 'stub',
      };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

/** Prompts that asked a model to write or repair an entry — not review. */
const entryPrompts = (prompts: string[]) => prompts.filter((p) => !/Review a generated Playwright code-behind file/.test(p));

describe('Run & Compile', () => {
  function compilerFor(testFile: string, client: AiClient, events: LiveCompileEvent[]): LiveCompiler {
    return new LiveCompiler({
      mode: 'run',
      testFilePath: testFile,
      aiClient: client,
      contextContent: '',
      testName: 'accounts.md',
      plan: [
        { text: CLICK_STEP, inScope: true, line: 5 },
        { text: B_STEP, inScope: true, line: 6 },
      ],
      emit: (event) => events.push(event),
      note: () => {},
    });
  }

  it('writes a step that only reads from its recording, asking the model only about the step that acts', async () => {
    const testFile = path.join(dir, 'accounts.md');
    const stepsFile = path.join(dir, 'accounts.steps.ts');
    const { client, prompts } = fakeAi();
    const events: LiveCompileEvent[] = [];
    const compiler = compilerFor(testFile, client, events);
    compiler.offer({
      index: 0,
      binding: { ...bindingFor(CLICK_STEP), file: stepsFile },
      result: readResult(1, CLICK_STEP, [{ action: 'click', selector: '#accounts-link' }]),
      resolvedParameters: {},
    });
    compiler.offer({
      index: 1,
      binding: { ...bindingFor(B_STEP), file: stepsFile },
      result: readResult(2, B_STEP, [B_FIND, B_READ], { accounts: B_NAMES }),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    const asked = entryPrompts(prompts);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`## The step, exactly as authored\n${CLICK_STEP}\n`);
    const file = outcome.files[stepsFile] ?? '';
    expect(file).toContain('fromRecording: true');
    expect(file).toContain(`selector: '${B_SELECTOR}'`);
    expect(file).toContain("kinds: ['span.account-name']");
    const messages = events
      .filter((e): e is Extract<LiveCompileEvent, { type: 'compile:step' }> => e.type === 'compile:step')
      .map((e) => e.message);
    expect(messages).toContain('written from the recording, with no model call');
  });

  it('writes a stale one again from the healing pass, with no model call', async () => {
    const testFile = path.join(dir, 'accounts.md');
    const stepsFile = path.join(dir, 'accounts.steps.ts');
    const OLD_SELECTOR = '#accounts .name';
    await fs.writeFile(
      stepsFile,
      [
        "import { defineSteps } from 'steptix/codebehind';",
        'export default defineSteps([',
        `  ${B_ENTRY.replace(B_SELECTOR, OLD_SELECTOR).split('\n').join('\n  ')},`,
        ']);',
        '',
      ].join('\n'),
      'utf-8',
    );
    const { client, prompts } = fakeAi();
    const compiler = compilerFor(testFile, client, []);
    compiler.offer({
      index: 1,
      binding: { ...bindingFor(B_STEP), file: stepsFile, entry: { source: B_STEP, fromRecording: true, run: async () => {} } },
      // The entry failed its self-check; the step healed under AI, which chose
      // its read afresh.
      result: readResult(2, B_STEP, [B_READ], { accounts: B_NAMES }, {
        codeBehindStale: {
          file: stepsFile,
          source: B_STEP,
          error: 'Self-check failed: the read matched `span.account-number` where the run read `span.account-name`',
        },
      }),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(entryPrompts(prompts)).toEqual([]);
    const file = outcome.files[stepsFile] ?? '';
    expect(file).toContain(`selector: '${B_SELECTOR}'`);
    expect(file).not.toContain(OLD_SELECTOR);
    expect(file).toContain('fromRecording: true');
  });
});

const CONFIG: Config = { ...DEFAULT_CONFIG };

describe('steptix compile', () => {
  async function accountsTest() {
    const md = path.join(dir, 'accounts.md');
    await fs.writeFile(md, ['# Accounts', '', '## Steps', `1. ${CLICK_STEP}`, `2. ${B_STEP}`, ''].join('\n'), 'utf-8');
    return parseTestFile(md);
  }
  const record: CompileRunOutcome = {
    status: 'passed',
    ...outcomeRows(
      [
        readResult(1, CLICK_STEP, [{ action: 'click', selector: '#accounts-link' }]),
        readResult(2, B_STEP, [B_FIND, B_READ], { accounts: B_NAMES }),
      ],
      2,
    ),
    resolvedParameters: { accounts: B_NAMES },
    tokensUsed: 0,
  };

  it('writes a step that only reads from the recording and proves it on the replay', async () => {
    const test = await accountsTest();
    const { client, prompts } = fakeAi();
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return record;
      return {
        status: 'passed',
        ...outcomeRows(
          [
            { ...readResult(1, CLICK_STEP, []), fromCodeBehind: true, turns: [] },
            { ...readResult(2, B_STEP, [], { accounts: B_NAMES }), fromCodeBehind: true, turns: [] },
          ],
          2,
        ),
        resolvedParameters: { accounts: B_NAMES },
        tokensUsed: 0,
      };
    };

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    expect(result.status).toBe('green');
    expect(result.summary.compiled).toBe(2);
    expect(entryPrompts(prompts)).toHaveLength(1);
    expect(entryPrompts(prompts)[0]).toContain(`## The step, exactly as authored\n${CLICK_STEP}\n`);
    const proposal = Object.values(result.files).join('\n');
    expect(proposal).toContain('fromRecording: true');
    expect(proposal).toContain(`selector: '${B_SELECTOR}'`);
  });

  it('gives one that fails a strict replay round no entry — not a repair, not ai: true', async () => {
    const test = await accountsTest();
    const { client, prompts } = fakeAi();
    const SELF_CHECK = 'Self-check failed: the read matched `span.account-number` where the run read `span.account-name`';
    let round = 0;
    const replayed: string[] = [];
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return record;
      round++;
      for (const file of Object.values(request.candidateFiles ?? {})) replayed.push(await fs.readFile(file, 'utf-8'));
      return round === 1
        ? {
            status: 'failed',
            ...outcomeRows(
              [
                { ...readResult(1, CLICK_STEP, []), fromCodeBehind: true, turns: [] },
                { ...readResult(2, B_STEP, []), status: 'failed', error: SELF_CHECK, fromCodeBehind: true, turns: [] },
              ],
              2,
            ),
            resolvedParameters: {},
            tokensUsed: 0,
          }
        : {
            status: 'passed',
            ...outcomeRows(
              [
                { ...readResult(1, CLICK_STEP, []), fromCodeBehind: true, turns: [] },
                readResult(2, B_STEP, [B_READ], { accounts: B_NAMES }),
              ],
              2,
            ),
            resolvedParameters: { accounts: B_NAMES },
            tokensUsed: 0,
          };
    };

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    expect(round).toBe(2);
    expect(result.status).toBe('partial');
    expect(result.summary.compiled).toBe(1);
    expect(result.summary.warnings).toContain(
      `step 2 was not compiled: its code, written from the recording, failed on the replay (${SELF_CHECK}). ` +
        'It stays AI; compile again to retry.',
    );
    // No repair was asked for, and the round after replayed without it.
    expect(entryPrompts(prompts).some((p) => p.startsWith('A generated code-behind entry was replayed'))).toBe(false);
    expect(replayed.at(-1)).not.toContain(B_STEP);
    const proposal = Object.values(result.files).join('\n');
    expect(proposal).not.toContain(B_STEP);
    expect(proposal).not.toContain('ai: true');
  });
});
