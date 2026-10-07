import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { logger } from '../src/utils/logger.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import type { RecordedAction } from '../src/codebehind/recording.js';
import type { Candidate } from '../src/codebehind/candidate.js';
import {
  askCheckedRepair,
  generateStepEntry,
  recordedReadMismatch,
  READ_SELECTOR_WITHHELD,
  stepSubstitution,
} from '../src/codebehind/generate.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { buildFileReviewPrompt, evidenceKey, reviewCandidate, type EntryEvidence } from '../src/codebehind/review.js';
import { LiveCompiler, type LiveCompileEvent } from '../src/codebehind/live-compile.js';
import { compileTest, outcomeRows, type CompileRunOutcome, type CompileRunner } from '../src/codebehind/compile.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * A compiled read keeps the selector the AI run read with
 * (docs/specs/SPEC-codebehind-robustness.md §6.2).
 *
 * Failure B: the AI read `… > span > span:first-child` and stored three account
 * names; a rewrite dropped `:first-child`, the compiled entry matched the name
 * AND the masked number of every row, and stored six. A read that matches more
 * or fewer elements does not throw — it returns different data — so the check
 * compares the entry with the recording, and an entry that still reads with
 * something else after its one re-ask is WITHHELD: the step gets no entry, runs
 * on AI, and the next compile tries again.
 */

// ── Failure B, as recorded and as compiled ────────────────────────────────────

const B_STEP = 'Read the name of every account in the Your accounts panel [store as: accounts]';
const B_SELECTOR = '#account-list [data-testid="account-row"] > span > span:first-child';
const B_RECORDED = '["Everyday","Savings","Travel"]';
const B_ACTION: RecordedAction = {
  action: 'read',
  multiple: true,
  as: 'accounts',
  selector: B_SELECTOR,
  targeting: { matchCount: 3 },
};

/** The compiled entry of §3.2, verbatim: the `:first-child` is gone. */
const B_WRONG_ENTRY = `{
  source: ${JSON.stringify(B_STEP)},
  async run({ page, step, log }) {
    const accountRows = page.locator('#account-list [data-testid="account-row"]');
    const accountNames = page
      .locator('#account-list [data-testid="account-row"] > span > span')
      .filter({ hasNotText: '$' });
    const accounts = (await accountNames.allTextContents()).map((name) => name.trim());
    const rowCount = await accountRows.count();
    step.setVar('accounts', JSON.stringify(accounts));
    step.expect(
      accounts.length === rowCount && accounts.every((name) => name.length > 0),
      'Read all populated account names from the Your accounts panel',
    );
  },
}`;

/** The entry the baseline live run compiled: the recorded selector, kept. */
const B_RIGHT_ENTRY = `{
  source: ${JSON.stringify(B_STEP)},
  async run({ page, step, log }) {
    const selector = '#account-list [data-testid="account-row"] > span > span:first-child';
    const names = (await page.locator(selector).allTextContents()).map((name) => name.trim());
    step.setVar('accounts', JSON.stringify(names));
    step.expect(names.length > 0, 'Your accounts panel contains populated account names');
  },
}`;

const check = (code: string, actions: RecordedAction[] = [B_ACTION], extra: Partial<Parameters<typeof recordedReadMismatch>[2]> = {}) =>
  recordedReadMismatch(code, actions, { source: B_STEP, recordedCaptures: { accounts: B_RECORDED }, ...extra });

describe('recordedReadMismatch — the check', () => {
  it("complains about failure B's compiled entry, in the spec's words", () => {
    const found = check(B_WRONG_ENTRY);
    expect(found?.selector).toBe(B_SELECTOR);
    expect(found?.complaint).toBe(
      `The recorded run read with \`${B_SELECTOR}\`, which matched 3 elements and captured 3 values. ` +
        'Your entry reads with a different selector. A read that matches more or fewer elements does not ' +
        'throw; it returns different data. Use the recorded selector as written — every part of it, ' +
        '`:first-child` and `:nth-of-type` included. Narrow or wait around it if you need to, but read with it.',
    );
  });

  it('accepts the recorded selector kept as written', () => {
    expect(check(B_RIGHT_ENTRY)).toBeUndefined();
  });

  it('compares after normalising quote style and whitespace', () => {
    expect(
      check(`page.locator("#account-list [data-testid='account-row']>span >  span:first-child").allTextContents()`),
    ).toBeUndefined();
    expect(check('page.locator(`' + B_SELECTOR + '`).allTextContents()')).toBeUndefined();
  });

  it('accepts the selector split across a chain — locator(a).locator(b), or a frame and its locator', () => {
    expect(
      check(`page.locator('#account-list').locator('[data-testid="account-row"] > span > span:first-child')`),
    ).toBeUndefined();
    expect(
      check('x', [{ action: 'read', selector: 'iframe#pay #amount', as: 'amount' }], { recordedCaptures: {} }),
    ).toBeDefined();
    expect(
      check(`page.frameLocator('iframe#pay').locator('#amount').innerText()`, [
        { action: 'read', selector: 'iframe#pay #amount', as: 'amount' },
      ]),
    ).toBeUndefined();
  });

  it("accepts the action's verified resolvedSelector", () => {
    const action: RecordedAction = {
      action: 'read',
      selector: 'text=Balance',
      as: 'balance',
      targeting: { matchCount: 1, resolvedSelector: '#balance-panel .amount', resolvedBy: 'scoped' },
    };
    expect(check(`page.locator('#balance-panel .amount').innerText()`, [action])).toBeUndefined();
    expect(check(`page.locator('.amount').innerText()`, [action])?.complaint).toContain(
      'or its verified resolvedSelector `#balance-panel .amount`',
    );
  });

  it('accepts a selector built from step.getVar that matches the substituted recording', () => {
    // A recording that holds the VALUE (the model wrote it, not the placeholder):
    // the entry builds the same selector from the parameter.
    const source = 'Read the balance of the {{account}} account [store as: balance]';
    const action: RecordedAction = { action: 'read', selector: 'tr:has-text("Everyday") .balance', as: 'balance' };
    const binding = bindingFor(source);
    const substitute = stepSubstitution(binding, { account: 'Everyday' });
    const code = "await page.locator(`tr:has-text(\"${step.getVar('account')}\") .balance`).innerText();";
    expect(recordedReadMismatch(code, [action], { source, substitute })).toBeUndefined();
    // …and with the substitution unknown, the same code cannot be matched.
    expect(recordedReadMismatch(code, [action], { source })).toBeDefined();
  });

  it('exempts a selector that carries a placeholder: the entry builds it from step.getVar', () => {
    const action: RecordedAction = { action: 'read', selector: 'tr:has-text("{{account}}") .balance', as: 'balance' };
    expect(check(`page.locator('tr').filter({ hasText: x }).locator('.balance')`, [action])).toBeUndefined();
  });

  it("yields to the selector story's positional carve-out — only when the step names what distinguishes the row", () => {
    const action: RecordedAction = {
      action: 'read',
      selector: '#payments tr .amount',
      as: 'amount',
      targeting: { matchCount: 1, resolvedSelector: '#payments > tr:nth-of-type(2) .amount', resolvedBy: 'positional' },
    };
    const dataDriven = "page.locator('#payments > tr').filter({ hasText: step.getVar('payee') }).locator('td.amount')";
    expect(
      recordedReadMismatch(dataDriven, [action], { source: 'Read the amount for {{payee}} [store as: amount]' }),
    ).toBeUndefined();
    expect(
      recordedReadMismatch(dataDriven, [action], { source: 'Read the amount for "Acme" [store as: amount]' }),
    ).toBeUndefined();
    // Nothing in the step distinguishes the row: the positional chain is the answer.
    expect(
      recordedReadMismatch(dataDriven, [action], { source: 'Read the second amount [store as: amount]' }),
    ).toBeDefined();
  });

  it('holds a count to its selector too, in its own words', () => {
    const action: RecordedAction = {
      action: 'count',
      selector: '#documents-body > tr.doc-row',
      as: 'document_count',
      targeting: { matchCount: 4 },
    };
    expect(check(`await page.locator('#documents-body > tr.doc-row').count()`, [action])).toBeUndefined();
    expect(check(`await page.locator('#documents-body tr').count()`, [action])?.complaint).toMatch(
      /^The recorded run counted with `#documents-body > tr\.doc-row`, which matched 4 elements\. Your entry counts with a different selector\./,
    );
  });

  it('does not look at actions that are not reads, or reads with no selector', () => {
    expect(check('await page.click("#other")', [{ action: 'click', selector: '#go' }])).toBeUndefined();
    expect(check('x', [{ action: 'read', as: 'title' } as RecordedAction])).toBeUndefined();
  });

  it('masks a secret in what it quotes', () => {
    const found = check('x', [{ action: 'read', selector: '[data-token="tok_live_12345"]', as: 't' }], {
      secrets: ['tok_live_12345'],
    });
    expect(found?.selector).not.toContain('tok_live_12345');
    expect(found?.complaint).not.toContain('tok_live_12345');
  });
});

// ── Generation: which answer wins ─────────────────────────────────────────────

function bindingFor(source: string, over: Partial<CodeBehindBinding> = {}): CodeBehindBinding {
  return {
    file: path.resolve(path.sep, 'nowhere', 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...over,
  };
}

/** A client answering each entry in turn (the last repeats), recording prompts. */
function scripted(...answers: Array<string | { entry: null; reason: string }>): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1]!;
      prompts.push(typeof last.content === 'string' ? last.content : contentBlocksToText(last.content));
      const answer = answers[Math.min(prompts.length - 1, answers.length - 1)]!;
      return { text: JSON.stringify(typeof answer === 'string' ? { entry: answer } : answer), model: 'stub' };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

const LIST_STEP = 'Refresh the list and read every item [store as: items]';
const LIST_ACTIONS: RecordedAction[] = [
  { action: 'click', selector: '#refresh' },
  { action: 'read', multiple: true, selector: '#list li', as: 'items' },
];
/** An entry for LIST_STEP. `read` is the selector it reads with; `log` uses
 *  the log without destructuring it — the undeclared-context fault. */
const listEntry = (read: string, opts: { undeclaredLog?: boolean } = {}): string =>
  `{ source: ${JSON.stringify(LIST_STEP)}, async run({ page, step }) { ` +
  "await page.locator('#refresh').click(); " +
  `await page.locator('${read}').first().waitFor(); ` +
  `${opts.undeclaredLog ? "log.info('reading'); " : ''}` +
  `step.setVar('items', JSON.stringify(await page.locator('${read}').allTextContents())); } }`;
const GOOD = listEntry('#list li');
const WRONG_READ = listEntry('#list li.item');
const OTHER_FAULT = listEntry('#list li', { undeclaredLog: true });
const BOTH = listEntry('#list li.item', { undeclaredLog: true });

const generate = (client: AiClient) =>
  generateStepEntry({
    binding: bindingFor(LIST_STEP),
    actions: LIST_ACTIONS,
    resolvedParameters: {},
    aiClient: client,
    contextContent: '',
    testName: 'list',
  });

describe('generateStepEntry — which answer is kept (§6.2)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('first answer passes every check: kept, nothing re-asked', async () => {
    const { client, prompts } = scripted(GOOD);
    expect(await generate(client)).toEqual({ kind: 'entry', code: GOOD });
    expect(prompts).toHaveLength(1);
  });

  it('fails the read check, the re-ask fixes it and passes the rest: the re-ask is kept', async () => {
    const { client, prompts } = scripted(WRONG_READ, GOOD);
    expect(await generate(client)).toEqual({ kind: 'entry', code: GOOD });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('## Your previous answer was refused');
    expect(prompts[1]).toContain('The recorded run read with `#list li`');
  });

  it('fails the read check, the re-ask fixes it but fails another: the re-ask is kept, warned about', async () => {
    const { client } = scripted(WRONG_READ, OTHER_FAULT);
    expect(await generate(client)).toEqual({ kind: 'entry', code: OTHER_FAULT });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/still uses a context property it does not destructure/);
  });

  it('fails the read check and the re-ask still does: neither is kept — the step gets no entry', async () => {
    const { client, prompts } = scripted(WRONG_READ, WRONG_READ);
    const result = await generate(client);
    expect(result).toEqual({
      kind: 'error',
      message: `${READ_SELECTOR_WITHHELD} (#list li)`,
      withheld: true,
    });
    expect(prompts).toHaveLength(2);
  });

  it('fails the read check and the re-ask declines: still no entry — never an ai: true write-off', async () => {
    const { client } = scripted(WRONG_READ, { entry: null, reason: 'cannot tell which items' });
    expect(await generate(client)).toMatchObject({ kind: 'error', withheld: true });
  });

  it('fails another check only, the re-ask fixes it and keeps the read: the re-ask is kept', async () => {
    const { client, prompts } = scripted(OTHER_FAULT, GOOD);
    expect(await generate(client)).toEqual({ kind: 'entry', code: GOOD });
    expect(prompts[1]).toContain('does not destructure');
  });

  it('fails another check only and the re-ask breaks the read: the first is kept, warned about', async () => {
    const { client } = scripted(OTHER_FAULT, BOTH);
    expect(await generate(client)).toEqual({ kind: 'entry', code: OTHER_FAULT });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /the re-ask changed the selector the run read with, so the first answer is kept/,
    );
  });

  it('re-asks about both faults at once when the first answer has both', async () => {
    const { client, prompts } = scripted(BOTH, GOOD);
    expect(await generate(client)).toEqual({ kind: 'entry', code: GOOD });
    expect(prompts[1]).toContain('The recorded run read with `#list li`');
    expect(prompts[1]).toContain('does not destructure');
  });
});

// ── Repair answers get the same check ────────────────────────────────────────

describe('a repair answer is held to the recorded read', () => {
  const repairPrompt = (retry?: { previousEntry: string; complaint: string }): ChatMessage =>
    buildRepairPrompt({
      rawStepText: LIST_STEP,
      stepIndex: 3,
      entryCode: WRONG_READ,
      error: 'Self-check failed: one item per row',
      parameters: [],
      actions: LIST_ACTIONS,
      ...(retry && { retry }),
    });
  const repair = (client: AiClient) =>
    askCheckedRepair(client, '', repairPrompt, [], { binding: bindingFor(LIST_STEP), actions: LIST_ACTIONS });

  it('lists the selectors the run read with in the repair prompt', () => {
    expect(repairPrompt().content as string).toContain(
      '## What the run read with\nThe run this entry is repaired from read the page with these selectors.',
    );
    expect(repairPrompt().content as string).toContain('- read (every match) `#list li` → items');
  });

  it('leaves a repair prompt with no read as it was', () => {
    const plain = buildRepairPrompt({ rawStepText: 'Click Go', stepIndex: 1, entryCode: '{}', error: 'x', parameters: [] });
    const withClick = buildRepairPrompt({
      rawStepText: 'Click Go', stepIndex: 1, entryCode: '{}', error: 'x', parameters: [],
      actions: [{ action: 'click', selector: '#go' }],
    });
    expect(withClick.content).toBe(plain.content);
  });

  it('re-asks a repair that reads with a different selector, and keeps a fixed one', async () => {
    const { client, prompts } = scripted(WRONG_READ, GOOD);
    expect(await repair(client)).toEqual({ kind: 'entry', code: GOOD });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('## Your previous answer was refused');
    expect(prompts[1]).toContain('The recorded run read with `#list li`');
  });

  it('withholds a repair that still differs after its re-ask', async () => {
    const { client } = scripted(WRONG_READ, WRONG_READ);
    expect(await repair(client)).toMatchObject({ kind: 'error', withheld: true });
  });
});

// ── No entry: Run & Compile ──────────────────────────────────────────────────

let tmpBase: string;
let counter = 0;
let dir: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('read-selector');
});
beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await removeScratchBase(tmpBase);
});

/** A passed step whose transcript is `actions`, with what it captured. */
function readResult(index: number, instruction: string, actions: RecordedAction[], outputs?: Record<string, string>): StepResult {
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
    stepContext: { domBefore: '<ul id="list"></ul>', domAfter: '<ul id="list"><li>a</li></ul>' },
    ...(outputs && { outputs }),
  };
}

/** Answers every generation prompt with `answer(source)`, and review with the
 *  file unchanged. */
function fakeAi(answer: (source: string) => string): { client: AiClient; prompts: string[] } {
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
      return { text: JSON.stringify({ entry: answer(source) }), model: 'stub' };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

describe('Run & Compile: a withheld step gets no entry', () => {
  it('is counted as not generated, its note names the reason, and the file has no entry for it', async () => {
    const testFile = path.join(dir, 'list.md');
    const stepsFile = path.join(dir, 'list.steps.ts');
    const events: LiveCompileEvent[] = [];
    const notes: string[] = [];
    const { client } = fakeAi((source) =>
      source === LIST_STEP
        ? WRONG_READ
        : `{ source: ${JSON.stringify(source)}, async run({ page }) { await page.click('#go'); } }`,
    );
    const compiler = new LiveCompiler({
      mode: 'run',
      testFilePath: testFile,
      aiClient: client,
      contextContent: '',
      testName: 'list.md',
      plan: [
        { text: 'Open the list', inScope: true, line: 5 },
        { text: LIST_STEP, inScope: true, line: 6 },
      ],
      emit: (event) => events.push(event),
      note: (message) => notes.push(message),
    });
    const bindingOf = (source: string): CodeBehindBinding => ({ ...bindingFor(source), file: stepsFile });
    compiler.offer({
      index: 0,
      binding: bindingOf('Open the list'),
      result: readResult(1, 'Open the list', [{ action: 'click', selector: '#go' }]),
      resolvedParameters: {},
    });
    compiler.offer({
      index: 1,
      binding: bindingOf(LIST_STEP),
      result: readResult(2, LIST_STEP, LIST_ACTIONS, { items: '["a"]' }),
      resolvedParameters: {},
    });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    expect(outcome.summary.error).toBe('1 step(s) could not be generated; they stay AI');
    expect(notes.join('\n')).toContain(
      `Code-behind generation failed for step 2: ${READ_SELECTOR_WITHHELD} (#list li). The step stays AI`,
    );
    const file = outcome.files[stepsFile] ?? '';
    expect(file).toContain("source: 'Open the list'");
    expect(file).not.toContain(LIST_STEP);
    expect(file).not.toContain('ai: true');
  });
});

// ── No entry: the CLI compile ────────────────────────────────────────────────

const CONFIG: Config = { ...DEFAULT_CONFIG };

describe('steptix compile: a withheld step leaves the replay selection and is listed', () => {
  it('compiles the rest, replays without it, names it, and does not fail', async () => {
    const md = path.join(dir, 'list.md');
    await fs.writeFile(md, ['# List', '', '## Steps', '1. Open the list', `2. ${LIST_STEP}`, ''].join('\n'), 'utf-8');
    const test = await parseTestFile(md);
    const { client } = fakeAi((source) =>
      source === LIST_STEP
        ? WRONG_READ
        : `{ source: ${JSON.stringify(source)}, async run({ page }) { await page.click('#go'); } }`,
    );
    const record: CompileRunOutcome = {
      status: 'passed',
      ...outcomeRows(
        [
          readResult(1, 'Open the list', [{ action: 'click', selector: '#go' }]),
          readResult(2, LIST_STEP, LIST_ACTIONS, { items: '["a"]' }),
        ],
        2,
      ),
      resolvedParameters: {},
      tokensUsed: 0,
    };
    const replayed: string[] = [];
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return record;
      // What the replay round actually ran against.
      for (const file of Object.values(request.candidateFiles ?? {})) replayed.push(await fs.readFile(file, 'utf-8'));
      return {
        status: 'passed',
        ...outcomeRows(
          [
            { ...readResult(1, 'Open the list', []), fromCodeBehind: true, turns: [] },
            readResult(2, LIST_STEP, LIST_ACTIONS, { items: '["a"]' }),
          ],
          2,
        ),
        resolvedParameters: {},
        tokensUsed: 0,
      };
    };

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    expect(result.status).toBe('partial');
    expect(result.summary.compiled).toBe(1);
    expect(result.summary.warnings).toContain(
      `step 2 was not compiled: ${READ_SELECTOR_WITHHELD} (#list li). It stays AI; compile again to retry.`,
    );
    expect(result.summary.error).toBeUndefined();
    expect(replayed.join('\n')).not.toContain(LIST_STEP);
    const proposal = Object.values(result.files).join('\n');
    expect(proposal).toContain("source: 'Open the list'");
    expect(proposal).not.toContain(LIST_STEP);
  });
});

// ── Review's output gets the same check ──────────────────────────────────────

describe('reviewCandidate holds a revision to the recorded read', () => {
  const fileWith = (entry: string) =>
    ['const defineSteps = (x: unknown) => x;', 'export default defineSteps([', `  ${entry},`, ']);', ''].join('\n');

  async function review(
    before: string,
    revision: string,
    evidence: EntryEvidence | undefined,
  ): Promise<{ events: string[]; replaced: string | undefined; logged: string[] }> {
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
          steps: [B_STEP],
          guarded: [],
          evidence: (file, entry) =>
            evidence && file === target && entry.source === B_STEP && entry.occurrence === 0 ? evidence : undefined,
          aiClient: { complete: async () => ({ text: JSON.stringify({ file: revision }) }) } as unknown as AiClient,
        },
        (m) => events.push(m),
      );
      return { events, replaced, logged: info.mock.calls.map((c) => String(c[0])) };
    } finally {
      info.mockRestore();
    }
  }

  const evidence: EntryEvidence = { step: 50, actions: [B_ACTION], recordedCaptures: { accounts: B_RECORDED } };

  it('rejects a revision that drops :first-child, and leaves the candidate unchanged', async () => {
    const { events, replaced, logged } = await review(fileWith(B_RIGHT_ENTRY), fileWith(B_WRONG_ENTRY), evidence);
    expect(replaced).toBeUndefined();
    expect(events.at(-1)).toBe(
      `rejected: the revision changes the selector step 50 read with (${B_SELECTOR}) — the generated file stands`,
    );
    // …and the log says which rewrite changed it (§3.2 could not tell).
    expect(logged.join('\n')).toContain(
      `Review of accounts.steps.ts changed a selector in the entry for ${JSON.stringify(B_STEP)}: removed ` +
        `${JSON.stringify(B_SELECTOR)}`,
    );
  });

  it('accepts a revision that keeps the recorded selector', async () => {
    const tidied = B_RIGHT_ENTRY.replace("step.expect(names.length > 0, 'Your accounts panel contains populated account names');",
      "step.expect(names.length === 3 || names.length > 0, 'Your accounts panel lists its account names');");
    const { events, replaced } = await review(fileWith(B_RIGHT_ENTRY), fileWith(tidied), evidence);
    expect(events.at(-1)).toBe('revised accounts.steps.ts');
    expect(replaced).toBeDefined();
  });

  it('judges only what the revision brought in: a fault the generated entry already had does not reject', async () => {
    const touched = B_WRONG_ENTRY.replace("'Read all populated account names from the Your accounts panel'", "'Account names were read'");
    const { events } = await review(fileWith(B_WRONG_ENTRY), fileWith(touched), evidence);
    expect(events.at(-1)).toBe('revised accounts.steps.ts');
  });

  it('says what the review prompt asks: a selector an entry reads with is kept as written', () => {
    const text = buildFileReviewPrompt({ markdownName: 'a.md', file: 'defineSteps([])', steps: [B_STEP] }).content as string;
    expect(text).toContain('A selector an entry\n   READS with');
    expect(text).toContain('keep it exactly as\n   written, `:first-child` and `:nth-of-type` included');
  });
});

describe('Run & Compile reviews an entry used twice against its FIRST pass', () => {
  it('rejects a revision that reads with the second pass\'s selector', async () => {
    const testFile = path.join(dir, 'twice.md');
    const stepsFile = path.join(dir, 'twice.steps.ts');
    const STEP = 'Read the heading [store as: heading]';
    const first: RecordedAction[] = [{ action: 'read', selector: '#first-pass h1', as: 'heading' }];
    const second: RecordedAction[] = [{ action: 'read', selector: '#second-pass h1', as: 'heading' }];
    const entryReading = (selector: string): string =>
      `{ source: ${JSON.stringify(STEP)}, async run({ page, step }) { step.setVar('heading', await page.locator('${selector}').innerText()); } }`;
    const events: LiveCompileEvent[] = [];
    const client = {
      complete: async (messages: ChatMessage[]) => {
        const last = messages[messages.length - 1]!;
        const prompt = typeof last.content === 'string' ? last.content : contentBlocksToText(last.content);
        if (/Review a generated Playwright code-behind file/.test(prompt)) {
          const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(prompt)?.[1] ?? '';
          return { text: JSON.stringify({ file: fenced.replace('#first-pass h1', '#second-pass h1') }) };
        }
        return { text: JSON.stringify({ entry: entryReading('#first-pass h1') }) };
      },
    } as unknown as AiClient;
    const compiler = new LiveCompiler({
      mode: 'run',
      testFilePath: testFile,
      aiClient: client,
      contextContent: '',
      testName: 'twice.md',
      plan: [
        { text: STEP, inScope: true, line: 9 },
        { text: STEP, inScope: true, line: 9 },
      ],
      emit: (event) => events.push(event),
    });
    const binding: CodeBehindBinding = { ...bindingFor(STEP), file: stepsFile, section: 'Read it' };
    compiler.offer({ index: 0, binding, result: readResult(1, STEP, first, { heading: 'One' }), resolvedParameters: {} });
    compiler.offer({ index: 1, binding, result: readResult(2, STEP, second, { heading: 'Two' }), resolvedParameters: {} });
    const outcome = await compiler.finish({ tokensUsed: 0 });

    const review = events
      .filter((e): e is Extract<LiveCompileEvent, { type: 'compile:step' }> => e.type === 'compile:step' && e.phase === 'review')
      .map((e) => e.message);
    expect(review.at(-1)).toBe(
      'rejected: the revision changes the selector step 1 read with (#first-pass h1) — the generated file stands',
    );
    expect(outcome.files[stepsFile]).toContain('#first-pass h1');
  });
});

describe('the evidence key', () => {
  it('finds a binding by the identity a file gives its entry', () => {
    expect(
      evidenceKey('f.steps.ts', { source: 'Read it', section: 'sign in', occurrence: 1 }),
    ).toBe(['f.steps.ts', 'sign in', 'Read it', 1].join(String.fromCharCode(0)));
  });
});

// ── The generator prompt's wording ───────────────────────────────────────────

describe("the generator prompt's selector rules", () => {
  it('tell a step that reads to keep the recorded selector, in rule 7 and rule 8', () => {
    const text = buildStepCodePrompt({ rawStepText: B_STEP, parameters: [], actions: [B_ACTION] }).content as string;
    expect(text).toContain('That preference is for a selector you write new. A selector a `read` or `count` above used is part of what was read');
    // B's action was measured (`matchCount`), so rule 8 is the measured one.
    const inferred = buildStepCodePrompt({
      rawStepText: B_STEP,
      parameters: [],
      actions: [{ ...B_ACTION, targeting: undefined }],
    }).content as string;
    expect(inferred).toContain('A selector a `read` or `count` above used is the exception: it is part of what was read');
  });

  it('say nothing about it for a step that reads nothing', () => {
    const text = buildStepCodePrompt({
      rawStepText: 'Click Go',
      parameters: [],
      actions: [{ action: 'click', selector: '#go' }],
    }).content as string;
    expect(text).not.toContain('part of what was read');
  });
});
