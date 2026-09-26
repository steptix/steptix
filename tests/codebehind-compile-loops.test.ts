import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import type { StepResult, LoopMarker } from '../src/report/types.js';
import {
  compileTest,
  outcomeRows,
  type CompileEvent,
  type CompileRunOutcome,
  type CompileRunRequest,
  type CompileRunner,
} from '../src/codebehind/compile.js';

/**
 * The boxed compile — `aiui compile` — over a file that loops and decides
 * (stories/codebehind-loops-and-conditions.md, "Boxed compile").
 *
 * No browser: the runner is scripted with the rows a real run hands back — one
 * per pass for a loop body, one per visit for a guard, built through the same
 * `outcomeRows` both producers use — and the AI client answers from the prompt
 * it is shown. What is under test is what the pipeline does with those rows:
 * which pass it generates from and with which values, what a condition entry is
 * generated from, what a replay proves and blames, and what the summary counts.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-compile-loops');

let counter = 0;
let dir: string;

beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

const CONFIG: Config = { ...DEFAULT_CONFIG };

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

// ── The AI ───────────────────────────────────────────────────────────────────

/** The source an answer must carry, read off whichever prompt it is. */
function sourceOf(prompt: string): string {
  const repair = /## The step, exactly as authored\n(.*)\n/.exec(prompt)?.[1];
  if (repair !== undefined) return repair;
  const line = /## The line, exactly as authored\n(.*)\n/.exec(prompt)?.[1];
  if (line !== undefined) return line;
  const quoted = [...prompt.matchAll(/\n\s*source:\s*("(?:[^"\\]|\\.)*")/g)].at(-1)?.[1];
  return quoted ? (JSON.parse(quoted) as string) : 'step';
}

const isReview = (p: string): boolean => /Review a generated Playwright code-behind file/.test(p);
const isCondition = (p: string): boolean => /async condition\(\{ page, step \}\)/.test(p);
const isStepRepair = (p: string): boolean => p.startsWith('A generated code-behind entry was replayed');
const isConditionRepair = (p: string): boolean => isCondition(p) && p.includes('## The entry as it stands — it broke');

/**
 * An AI client that answers from the prompt: a review with the file unchanged,
 * a condition prompt with a `condition` entry, anything else with a `run`
 * entry — each for the source the prompt asks about. Records every prompt.
 */
function fakeAi(): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1];
      const prompt = typeof last?.content === 'string'
        ? last.content
        : (last?.content ?? []).map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
      prompts.push(prompt);
      if (isReview(prompt)) {
        const fenced = /## The file, as generated\s*```ts\n([\s\S]*?)```/.exec(prompt)?.[1];
        return { text: JSON.stringify({ file: fenced }), model: 'stub-model' };
      }
      const source = JSON.stringify(sourceOf(prompt));
      const entry = isCondition(prompt)
        ? `{ source: ${source}, async condition({ page }) { return (await page.locator('#next:enabled').count()) > 0; } }`
        : `{ source: ${source}, async run({ page }) { await page.click('#go'); } }`;
      return { text: JSON.stringify({ entry }), model: 'stub-model' };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

/** The first generation (not repair) prompt for `source`. */
const generationFor = (prompts: string[], source: string): string | undefined =>
  prompts.find(
    (p) => !isReview(p) && !isStepRepair(p) && !isConditionRepair(p) && sourceOf(p) === source,
  );

// ── Rows ─────────────────────────────────────────────────────────────────────

/** One pass of an ordinary step under AI: a click, and the page either side. */
function stepRow(index: number, page: string, over: Partial<StepResult> = {}): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: new Date().toISOString(),
        aiInteractions: [],
        subActions: [{ index: 1, action: { action: 'click', selector: '#go' }, durationMs: 1 }],
      },
    ],
    durationMs: 1,
    retried: false,
    stepContext: {
      domBefore: `<main><p>${page}</p><button id="go">Go</button></main>`,
      urlBefore: `https://bank.test/${encodeURIComponent(page)}`,
      domAfter: `<main><p>after ${page}</p></main>`,
      urlAfter: `https://bank.test/${encodeURIComponent(page)}/after`,
    },
    ...over,
  };
}

/** One pass of a step replayed as code. */
function codeRow(index: number, over: Partial<StepResult> = {}): StepResult {
  return { index, instruction: `step ${index}`, status: 'passed', turns: [], durationMs: 1, retried: false, fromCodeBehind: true, ...over };
}

/** One visit to a guard. */
function guardRow(index: number, guard: StepResult['guard'], over: Partial<StepResult> = {}): StepResult {
  return {
    index,
    instruction: `guard ${index}`,
    status: 'passed',
    turns: [],
    durationMs: 1,
    retried: false,
    ...(guard && { guard }),
    ...(guard?.decidedBy === 'code' && { fromCodeBehind: true }),
    ...over,
  };
}

/** A loop's `While` visit decided by the model, with the page it was shown. */
function judged(index: number, holds: boolean, visit: number): StepResult {
  return guardRow(index, {
    decidedBy: 'model',
    holds,
    evidence: {
      dom: `<main><button id="next"${holds ? '' : ' disabled'}>Next</button><!-- judged visit ${visit} --></main>`,
      url: `https://bank.test/statements?page=${visit}`,
      members: [{ index: index - 1, holds }],
    },
  });
}

/** The same visit decided by code. */
const coded = (index: number, holds: boolean, over: Partial<StepResult> = {}): StepResult =>
  guardRow(index, { decidedBy: 'code', holds }, over);

function marker(index: number, values: Record<string, string> = {}): LoopMarker {
  return { kind: 'iteration', label: 'loop', index, values };
}

function outcome(
  rows: StepResult[],
  total: number,
  over: Partial<CompileRunOutcome> = {},
): CompileRunOutcome {
  const failed = rows.some((r) => r.status === 'failed' && !r.tolerated);
  return {
    status: failed ? 'failed' : 'passed',
    ...outcomeRows(rows, total),
    resolvedParameters: {},
    tokensUsed: 0,
    ...over,
  };
}

/** A runner that hands back the Record, then one scripted outcome per replay. */
function scriptedRunner(
  record: CompileRunOutcome,
  replays: CompileRunOutcome[],
): { runner: CompileRunner; requests: CompileRunRequest[] } {
  const requests: CompileRunRequest[] = [];
  const queue = [...replays];
  const runner: CompileRunner = async (request) => {
    requests.push(request);
    if (request.purpose === 'record') return record;
    const next = queue.shift();
    if (!next) throw new Error('replayed more times than the test scripted');
    return next;
  };
  return { runner, requests };
}

function collect(): { events: CompileEvent[]; onEvent: (e: CompileEvent) => void } {
  const events: CompileEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const stepMessages = (events: CompileEvent[], phase: string, step: number): string[] =>
  events
    .filter((e) => e.kind === 'step' && e.phase === phase && e.step === step)
    .map((e) => (e as { message: string }).message);

const replayLines = (events: CompileEvent[]): string[] =>
  events
    .filter((e) => e.kind === 'phase' && e.phase === 'replay')
    .map((e) => (e as { message: string }).message);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WHILE_LINE = 'While the Next button is enabled, Click Next';

/** Expanded: 1 Open · 2 While · 3 Click Next · 4 Read. */
const WHILE_MD = [
  '# Statements',
  '',
  '## Steps',
  '1. Open the statements page',
  `2. ${WHILE_LINE}`,
  '3. Read the reference',
  '',
].join('\n');

/** The Record of WHILE_MD: three passes, the page moving on each time. */
function whileRecord(): CompileRunOutcome {
  return outcome(
    [
      stepRow(1, 'start'),
      { ...judged(2, true, 1), loop: marker(1) },
      stepRow(3, 'statements page 1', { loop: marker(1) }),
      { ...judged(2, true, 2), loop: marker(2) },
      stepRow(3, 'statements page 2', { loop: marker(2) }),
      { ...judged(2, true, 3), loop: marker(3) },
      stepRow(3, 'statements page 3', { loop: marker(3) }),
      judged(2, false, 4),
      stepRow(4, 'the last page'),
    ],
    4,
  );
}

/** A replay of WHILE_MD whose condition code answers as the recording did. */
function whileReplay(): CompileRunOutcome {
  return outcome(
    [
      codeRow(1),
      coded(2, true), codeRow(3),
      coded(2, true), codeRow(3),
      coded(2, true), codeRow(3),
      coded(2, false),
      codeRow(4),
    ],
    4,
  );
}

const FOR_EACH_LINE = 'For each {{account}} in {{accounts}}, Open the account named {{account}}';

/** Expanded: 1 For each · 2 Open the account named {{account}} · 3 Read. */
const FOR_EACH_MD = [
  '# Accounts',
  '',
  '## Parameters',
  '- accounts: ["Everyday","Savings","Travel"]',
  '',
  '## Steps',
  `1. ${FOR_EACH_LINE}`,
  '2. Read the reference',
  '',
].join('\n');

const ACCOUNTS = ['Everyday', 'Savings', 'Travel'];

/** A body pass of FOR_EACH_MD under AI: it names its placeholder. */
function accountRow(pass: number): StepResult {
  const account = ACCOUNTS[pass - 1]!;
  return stepRow(2, `${account} account page`, {
    loop: marker(pass, { account }),
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: new Date().toISOString(),
        aiInteractions: [],
        subActions: [
          { index: 1, action: { action: 'type', selector: '#search', value: '{{account}}' }, durationMs: 1 },
        ],
      },
    ],
  });
}

function forEachRecord(): CompileRunOutcome {
  return outcome(
    [
      guardRow(1, undefined, { loop: marker(1, { account: 'Everyday' }) }),
      accountRow(1),
      accountRow(2),
      accountRow(3),
      stepRow(3, 'the summary'),
    ],
    3,
    // The run's FINAL map: the last pass's item.
    { resolvedParameters: { accounts: JSON.stringify(ACCOUNTS), account: 'Travel' } },
  );
}

function forEachReplay(): CompileRunOutcome {
  return outcome(
    [
      guardRow(1, undefined, { loop: marker(1, { account: 'Everyday' }) }),
      codeRow(2, { loop: marker(1, { account: 'Everyday' }) }),
      codeRow(2, { loop: marker(2, { account: 'Savings' }) }),
      codeRow(2, { loop: marker(3, { account: 'Travel' }) }),
      codeRow(3),
    ],
    3,
  );
}

// ── A While ──────────────────────────────────────────────────────────────────

describe('aiui compile — a While whose body runs three passes', () => {
  it('compiles green: one entry per line from pass 1, a condition from a held and a not-held page', async () => {
    const md = await write('statements.md', WHILE_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = fakeAi();
    const { runner, requests } = scriptedRunner(whileRecord(), [whileReplay()]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    expect(result.status).toBe('green');
    // The refusal is gone: it recorded, and replayed once.
    expect(requests.map((r) => r.purpose)).toEqual(['record', 'replay']);

    // `Click Next` was generated once, from PASS 1's page — not the last.
    const click = generationFor(prompts, 'Click Next')!;
    expect(click).toContain('<p>statements page 1</p>');
    expect(click).not.toContain('<p>statements page 2</p>');
    expect(click).not.toContain('<p>statements page 3</p>');
    expect(prompts.filter((p) => !isReview(p) && sourceOf(p) === 'Click Next')).toHaveLength(1);
    // …and told it repeats (decision 2).
    expect(click).toContain('## This step runs inside a loop');
    expect(click).toContain(`It is in the body of \`${WHILE_LINE}\``);
    expect(generationFor(prompts, 'Open the statements page')).not.toContain('runs inside a loop');

    // The guard got a condition entry, generated from the FIRST held page and
    // the FIRST not-held one (decision 9).
    const condition = generationFor(prompts, WHILE_LINE)!;
    expect(isCondition(condition)).toBe(true);
    expect(condition).toContain('### Observation 1 — the condition HELD');
    expect(condition).toContain('<!-- judged visit 1 -->');
    expect(condition).toContain('### Observation 2 — the condition did NOT hold');
    expect(condition).toContain('<!-- judged visit 4 -->');
    expect(condition).not.toContain('<!-- judged visit 2 -->');
    const written = await fs.readFile(path.join(dir, 'statements.steps.ts'), 'utf-8');
    expect(written).toContain(`source: '${WHILE_LINE}'`);
    expect(written).toContain('async condition({ page })');

    // Counted as expanded steps and entries, never passes (decision 13): four
    // steps, four entries, and a replay line that counts four — not the nine
    // rows the loop made.
    expect(result.summary).toMatchObject({
      totalSteps: 4,
      compiled: 4,
      kept: 0,
      keptAi: 0,
      rounds: 1,
      unproven: [],
      writtenOffAi: [],
      notAttempted: [],
    });
    expect(replayLines(events)).toContain('4/4 passed as code');
  });

  it('writes a body step off ONCE when it fails every round, and counts it once', async () => {
    const md = await write('statements.md', WHILE_MD);
    const test = await parseTestFile(md);
    const { client } = fakeAi();
    // Rounds 1 and 2: the body's entry fails on pass 1. The confirming round
    // runs it under AI, three passes, and the rest as code.
    const failing = (): CompileRunOutcome =>
      outcome(
        [
          codeRow(1),
          coded(2, true),
          codeRow(3, { status: 'failed', error: 'locator.click: Timeout 30000ms exceeded' }),
        ],
        4,
      );
    const confirming = outcome(
      [
        codeRow(1),
        coded(2, true), stepRow(3, 'p1'),
        coded(2, true), stepRow(3, 'p2'),
        coded(2, true), stepRow(3, 'p3'),
        coded(2, false),
        codeRow(4),
      ],
      4,
    );
    const { runner } = scriptedRunner(whileRecord(), [failing(), failing(), confirming]);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent, maxRounds: 2,
    });

    expect(result.status).toBe('green');
    expect(result.summary).toMatchObject({
      totalSteps: 4,
      compiled: 3,
      keptAi: 1,
      writtenOffAi: [3],
      unproven: [],
      notAttempted: [],
      rounds: 3,
    });
    expect(replayLines(events)).toContain('4/4 passed (step 3 under AI)');
  });

  it('names the body not attempted, with the decision, when the While ran no passes', async () => {
    const md = await write('statements.md', WHILE_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = fakeAi();
    const record = outcome(
      [
        stepRow(1, 'start'),
        judged(2, false, 1),
        guardRow(3, undefined, { status: 'skipped', aiExplanation: 'Skipped: the loop ran no passes' }),
        stepRow(4, 'the last page'),
      ],
      4,
    );
    const replay = outcome(
      [
        codeRow(1),
        coded(2, false),
        guardRow(3, undefined, { status: 'skipped', aiExplanation: 'Skipped: the loop ran no passes' }),
        codeRow(4),
      ],
      4,
    );
    const { runner } = scriptedRunner(record, [replay]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    expect(result.status).toBe('partial');
    expect(result.summary.notAttempted).toEqual([3]);
    expect(stepMessages(events, 'select', 3)).toEqual(['not run on the recording run (the loop ran no passes)']);
    expect(generationFor(prompts, 'Click Next')).toBeUndefined();
    // The condition WAS asked — it did not hold — so it compiles, from that page.
    const condition = generationFor(prompts, WHILE_LINE)!;
    expect(condition).toContain('### Observation 1 — the condition did NOT hold');
    expect(condition).not.toContain('### Observation 2');
    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain('step 3 not attempted on the recording run (the run decided against them)');
    expect(result.summary).toMatchObject({ totalSteps: 4, compiled: 3, unproven: [] });
  });
});

// ── A For each ───────────────────────────────────────────────────────────────

describe('aiui compile — a For each over three items', () => {
  it("generates the body from pass 1 with pass 1's values, not the run's final map", async () => {
    const md = await write('accounts.md', FOR_EACH_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = fakeAi();
    const { runner } = scriptedRunner(forEachRecord(), [forEachReplay()]);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });

    expect(result.status).toBe('green');
    const body = generationFor(prompts, 'Open the account named {{account}}')!;
    // Everyday — pass 1's item — and never Travel, which is what the run's
    // final map holds after the last pass.
    expect(body).toContain('{{account}} resolved to "Everyday"');
    expect(body).not.toContain('"Travel"');
    expect(body).toContain('<p>Everyday account page</p>');
    expect(body).not.toContain('Travel account page');
    // The loop line names what changes per pass (decision 2).
    expect(body).toContain('These change on every pass');
    expect(body).toContain("`{{account}}` — `step.getVar('account')`");
    // `For each` reads a list: nothing to compile on its line.
    expect(generationFor(prompts, FOR_EACH_LINE)).toBeUndefined();
    expect(result.summary).toMatchObject({ totalSteps: 3, compiled: 2, unproven: [], notAttempted: [] });
  });

  it("blames the pass that failed in replay — pass 2 — and repairs it with pass 2's values", async () => {
    const md = await write('accounts.md', FOR_EACH_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = fakeAi();
    const round1 = outcome(
      [
        guardRow(1, undefined, { loop: marker(1, { account: 'Everyday' }) }),
        codeRow(2, { loop: marker(1, { account: 'Everyday' }) }),
        codeRow(2, {
          loop: marker(2, { account: 'Savings' }),
          status: 'failed',
          error: 'no account named Savings on the page',
          domSnapshot: '<main><li>Savings, closed</li></main>',
          pageUrl: 'https://bank.test/accounts/savings',
        }),
      ],
      3,
    );
    const { runner } = scriptedRunner(forEachRecord(), [round1, forEachReplay()]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    expect(result.status).toBe('green');
    expect(result.summary.rounds).toBe(2);
    // Pass 1 passed and pass 2 failed: the step is blamed, not proven by pass 1.
    expect(replayLines(events)).toContain('✗ step 2 — no account named Savings on the page');
    expect(stepMessages(events, 'repair', 2)).toContain('repaired');
    const repair = prompts.find(isStepRepair)!;
    expect(repair).toContain('## The step, exactly as authored\nOpen the account named {{account}}');
    // The failing pass's own value, and its page.
    expect(repair).toContain('{{account}} resolved to "Savings"');
    expect(repair).not.toContain('"Travel"');
    expect(repair).not.toContain('"Everyday"');
    expect(repair).toContain('<li>Savings, closed</li>');
    // …told the line repeats, and what changes per pass, as generation was
    // (review round 2, F9) — a repair that forgets it writes Savings in.
    expect(repair).toContain('## This step runs inside a loop');
    expect(repair).toContain(`It is in the body of \`${FOR_EACH_LINE}\``);
    expect(repair).toContain("`{{account}}` — `step.getVar('account')`");
    expect(result.summary.unproven).toEqual([]);
  });
});

// ── The replay checks the conditions (decision 11) ──────────────────────────

describe('aiui compile — a replay whose condition answers differently from the recording', () => {
  it('fails that condition entry, and repairs it from the recorded page with both answers', async () => {
    const md = await write('statements.md', WHILE_MD);
    const test = await parseTestFile(md);
    const { client, prompts } = fakeAi();
    // Round 1: the code says the Next button is still enabled on visit 4,
    // where the recording's model said it was not — and the fourth pass it
    // should never have run then fails. The WRONG ANSWER is blamed, not the
    // pass it caused.
    const round1 = outcome(
      [
        codeRow(1),
        coded(2, true), codeRow(3),
        coded(2, true), codeRow(3),
        coded(2, true), codeRow(3),
        coded(2, true),
        codeRow(3, { status: 'failed', error: 'locator.click: no enabled Next button' }),
      ],
      4,
    );
    const { runner } = scriptedRunner(whileRecord(), [round1, whileReplay()]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    expect(result.status).toBe('green');
    expect(result.summary.rounds).toBe(2);
    const said = 'the code said "the Next button is enabled" held on visit 4; on the recording it did not hold there';
    expect(replayLines(events)).toContain(`✗ step 2 — ${said}`);
    expect(stepMessages(events, 'repair', 2)).toContain('repaired');
    expect(stepMessages(events, 'repair', 3)).toEqual([]);

    const repair = prompts.find(isConditionRepair)!;
    expect(sourceOf(repair)).toBe(WHILE_LINE);
    // Both answers…
    expect(repair).toContain(`## What went wrong\n${said}`);
    // …and the page the recording decided that visit on, shown first.
    expect(repair).toContain(
      '### Observation 1 — the condition did NOT hold\nURL: https://bank.test/statements?page=4',
    );
    expect(repair).toContain('<!-- judged visit 4 -->');
    expect(result.summary.unproven).toEqual([]);
  });

  it('blames the chain member whose code threw — the one the guard row names — and repairs that one', async () => {
    const md = await write(
      'pay.md',
      [
        '# Pay',
        '',
        '## Steps',
        '1. If the Cash checkbox is ticked, then Pay with cash',
        '2. Else if the Card checkbox is ticked, then Pay by card',
        '3. Otherwise, Pay on account',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    // Expanded: 1 If · 2 Pay with cash · 3 Else if · 4 Pay by card · 5 Otherwise · 6 Pay on account.
    const { client, prompts } = fakeAi();
    const skip = (i: number, why = 'Skipped: another branch of this decision was taken'): StepResult =>
      guardRow(i, undefined, { status: 'skipped', aiExplanation: why });
    const record = outcome(
      [
        skip(1),
        skip(2),
        guardRow(3, {
          decidedBy: 'model',
          selected: 2,
          evidence: {
            dom: '<main><input type="checkbox" id="card" checked></main>',
            url: 'https://bank.test/pay',
            members: [{ index: 0, holds: false }, { index: 2, holds: true }],
          },
        }),
        stepRow(4, 'paying by card'),
        skip(5),
        skip(6),
      ],
      6,
    );
    // Round 1: the Else if's code throws on a strict replay; the guard row sits
    // on the head, and names the member.
    const round1 = outcome(
      [
        guardRow(1, { decidedBy: 'code', failedMember: 2 }, {
          status: 'failed',
          error: "the condition's code-behind threw: locator resolved to 2 elements",
        }),
      ],
      6,
    );
    const round2 = outcome(
      [
        skip(1),
        skip(2),
        guardRow(3, { decidedBy: 'code', selected: 2 }),
        codeRow(4),
        skip(5),
        skip(6),
      ],
      6,
    );
    const { runner } = scriptedRunner(record, [round1, round2]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    // Both conditions were generated — the If from the page where it did not
    // hold, the Else if from the one where it did.
    expect(isCondition(generationFor(prompts, 'If the Cash checkbox is ticked, then Pay with cash')!)).toBe(true);
    expect(isCondition(generationFor(prompts, 'Else if the Card checkbox is ticked, then Pay by card')!)).toBe(true);
    expect(generationFor(prompts, 'Otherwise, Pay on account')).toBeUndefined();

    // The Else if — step 3 — is blamed and repaired; the If is left alone.
    expect(replayLines(events)).toContain(
      "✗ step 3 — the condition's code-behind threw: locator resolved to 2 elements",
    );
    expect(stepMessages(events, 'repair', 3)).toContain('repaired');
    expect(stepMessages(events, 'repair', 1)).toEqual([]);
    const repair = prompts.find(isConditionRepair)!;
    expect(sourceOf(repair)).toBe('Else if the Card checkbox is ticked, then Pay by card');
    expect(repair).toContain('locator resolved to 2 elements');

    // The untaken tails never ran: not attempted, so partial.
    expect(result.status).toBe('partial');
    expect(result.summary.notAttempted).toEqual([2, 6]);
    expect(result.summary.rounds).toBe(2);
  });

  it('says what happened when a guard no entry decided fails — never "recompile it"', async () => {
    const md = await write('statements.md', WHILE_MD);
    const test = await parseTestFile(md);
    const { client } = fakeAi();
    const cap =
      'the loop reached its cap of 3 passes (execution.maxLoopIterations) and "the Next button is ' +
      'enabled" was still true; raise the cap on the line with `, up to N times`, or check the exit condition.';
    // The While is left out of the selection, so it has no entry and the
    // replay's MODEL decides it. The body ran as code on every pass, and the
    // loop never ended.
    const replay = outcome(
      [
        codeRow(1),
        guardRow(2, { decidedBy: 'model', holds: true }), codeRow(3),
        guardRow(2, { decidedBy: 'model', holds: true }), codeRow(3),
        guardRow(2, { decidedBy: 'model', holds: true }), codeRow(3),
        guardRow(2, { decidedBy: 'model', holds: true }, { status: 'failed', error: cap }),
      ],
      4,
    );
    const { runner, requests } = scriptedRunner(whileRecord(), [replay]);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, select: { steps: [1, 3, 4] },
    });

    expect(result.status).toBe('partial');
    expect(result.summary.error).toBe(
      `step 2 failed on the replay — ${cap}; its body (step 3) ran as code on every pass and ` +
        'never ended the loop — check that the body moves the page on',
    );
    expect(result.summary.error).not.toContain('recompile');
    // Nothing of this compile's to repair: one round.
    expect(requests.filter((r) => r.purpose === 'replay')).toHaveLength(1);
  });
});

// ── A stale chain member ────────────────────────────────────────────────────

describe('aiui compile — a chain member whose condition entry broke', () => {
  it('regenerates the member the guard row names as stale, not the member that held', async () => {
    const IF = 'If the Cash checkbox is ticked, then Pay with cash';
    const ELSE_IF = 'Else if the Card checkbox is ticked, then Pay by card';
    const md = await write(
      'pay.md',
      ['# Pay', '', '## Steps', `1. ${IF}`, `2. ${ELSE_IF}`, '3. Otherwise, Pay on account', ''].join('\n'),
    );
    // Both conditions and every tail already have entries.
    await write(
      'pay.steps.ts',
      [
        "import { defineSteps } from 'ai-ui-automation/codebehind';",
        'export default defineSteps([',
        `  { source: ${JSON.stringify(IF)}, async condition({ page }) { return (await page.locator('#cash').count()) > 0; } },`,
        `  { source: ${JSON.stringify(ELSE_IF)}, async condition({ page }) { return (await page.locator('#card').count()) > 0; } },`,
        "  { source: 'Pay with cash', async run({ page }) { await page.click('#go'); } },",
        "  { source: 'Pay by card', async run({ page }) { await page.click('#go'); } },",
        "  { source: 'Pay on account', async run({ page }) { await page.click('#go'); } },",
        ']);',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    const { client, prompts } = fakeAi();
    // The run the compile is handed: the If's code THREW, the model decided the
    // chain and took the Else if — so the guard row sits on the Else if (step 3)
    // while its stale flag names the If (member 0).
    const skip = (i: number): StepResult =>
      guardRow(i, undefined, { status: 'skipped', aiExplanation: 'Skipped: another branch of this decision was taken' });
    const recorded = outcome(
      [
        skip(1),
        skip(2),
        guardRow(
          3,
          {
            decidedBy: 'model',
            selected: 2,
            staleMember: 0,
            evidence: {
              dom: '<main><input id="card" checked></main>',
              url: 'https://bank.test/pay',
              members: [{ index: 0, holds: false }, { index: 2, holds: true }],
            },
          },
          { codeBehindStale: { file: path.join(dir, 'pay.steps.ts'), source: IF, error: 'boom' } },
        ),
        stepRow(4, 'paying by card'),
        skip(5),
        skip(6),
      ],
      6,
    );
    const replay = outcome(
      [skip(1), skip(2), guardRow(3, { decidedBy: 'code', selected: 2 }), codeRow(4), skip(5), skip(6)],
      6,
    );
    const { runner } = scriptedRunner(recorded, [replay]);

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, recorded, dryRun: true,
    });

    const generated = prompts.filter((p) => !isReview(p)).map(sourceOf);
    expect(generated).toEqual([IF]);
    expect(result.summary.compiled).toBe(1);
  });
});

// ── A condition nothing asked ───────────────────────────────────────────────

describe('aiui compile — a condition line the recording never asked', () => {
  it('is not generated, and is named not attempted with a reason that says so', async () => {
    const md = await write(
      'nested.md',
      [
        '# Nested',
        '',
        '## Steps',
        '1. If the banner is shown, then Page through',
        '2. Read the reference',
        '',
        '### Page through',
        '1. While the Next button is enabled, Click Next',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    // Expanded: 1 If · 2 While (in the section) · 3 Click Next · 4 Read.
    const { client, prompts } = fakeAi();
    const none = 'Skipped: no condition in this decision held';
    const record = outcome(
      [
        guardRow(1, {
          decidedBy: 'model',
          selected: null,
          evidence: { dom: '<main>no banner</main>', url: 'https://bank.test/', members: [{ index: 0, holds: false }] },
        }, { status: 'skipped', aiExplanation: 'no banner' }),
        guardRow(2, undefined, { status: 'skipped', aiExplanation: none }),
        guardRow(3, undefined, { status: 'skipped', aiExplanation: none }),
        stepRow(4, 'the summary'),
      ],
      4,
    );
    const replay = outcome(
      [
        guardRow(1, { decidedBy: 'code', selected: null }, { status: 'skipped' }),
        guardRow(2, undefined, { status: 'skipped', aiExplanation: none }),
        guardRow(3, undefined, { status: 'skipped', aiExplanation: none }),
        codeRow(4),
      ],
      4,
    );
    const { runner } = scriptedRunner(record, [replay]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    expect(generationFor(prompts, WHILE_LINE)).toBeUndefined();
    expect(stepMessages(events, 'select', 2)).toEqual([
      'the condition was never asked on the recording run (no condition in this decision held)',
    ]);
    expect(stepMessages(events, 'select', 3)).toEqual([
      'not run on the recording run (no condition in this decision held)',
    ]);
    // The If WAS asked — it did not hold — and compiles.
    expect(isCondition(generationFor(prompts, 'If the banner is shown, then Page through')!)).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.summary.notAttempted).toEqual([2, 3]);
    const done = events.find((e) => e.kind === 'done') as { message: string };
    expect(done.message).toContain('steps 2–3 not attempted on the recording run (the run decided against them)');
  });
});

// ── The evidence pass of a stale body step (review finding R4) ──────────────

describe('aiui compile — a body entry that ran as code on pass 1 and healed on pass 2', () => {
  it('regenerates it from the HEALED pass through the repair prompt — never ai: true from pass 1', async () => {
    const md = await write('statements.md', WHILE_MD);
    // Every line compiled but the last, so the compile runs a Record with
    // code-behind ON (the sidecar flagged nothing).
    await write(
      'statements.steps.ts',
      [
        "import { defineSteps } from 'ai-ui-automation/codebehind';",
        'export default defineSteps([',
        "  { source: 'Open the statements page', async run({ page }) { await page.goto('/s'); } },",
        `  { source: ${JSON.stringify(WHILE_LINE)}, async condition({ page }) { return (await page.locator('#next:enabled').count()) > 0; } },`,
        "  { source: 'Click Next', async run({ page }) { await page.click('#next'); } },",
        ']);',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    const stale = {
      file: path.join(dir, 'statements.steps.ts'),
      source: 'Click Next',
      error: 'locator.click: Timeout 30000ms exceeded',
    };
    // Pass 1 ran as code (no transcript); pass 2's entry threw and healed
    // under AI; pass 3 ran under AI (the entry was discarded for the run).
    const record = outcome(
      [
        codeRow(1),
        { ...coded(2, true), loop: marker(1) },
        codeRow(3, { loop: marker(1) }),
        { ...coded(2, true), loop: marker(2) },
        stepRow(3, 'statements page 2', { loop: marker(2), codeBehindStale: stale }),
        { ...coded(2, true), loop: marker(3) },
        stepRow(3, 'statements page 3', { loop: marker(3) }),
        coded(2, false),
        stepRow(4, 'the last page'),
      ],
      4,
    );
    const { client, prompts } = fakeAi();
    const { runner } = scriptedRunner(record, [whileReplay()]);
    const { events, onEvent } = collect();

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent, dryRun: true,
    });

    // Measured before the fix: "3 kept as AI: the recorded run performed no
    // page actions for this step", `ai: true` over the working entry, and a
    // replay that passed under AI — a green compile.
    expect(stepMessages(events, 'select', 3)).toContain('joined the selection: its entry failed during Record');
    expect(stepMessages(events, 'generate', 3)).toEqual(['generated']);
    const repair = prompts.find((p) => isStepRepair(p) && sourceOf(p) === 'Click Next')!;
    expect(repair).toBeDefined();
    // The code that broke, what it threw, and the page it threw on: pass 2's.
    expect(repair).toContain("await page.click('#next')");
    expect(repair).toContain('locator.click: Timeout 30000ms exceeded');
    expect(repair).toContain('<p>statements page 2</p>');
    // …and told the line repeats (review round 2, F9).
    expect(repair).toContain('## This step runs inside a loop');
    expect(repair).toContain(`It is in the body of \`${WHILE_LINE}\``);
    const proposal = Object.values(result.files ?? {}).join('\n');
    expect(proposal).not.toContain('ai: true');
    expect(result.summary.keptAi).toBe(0);
  });
});

// ── A pass's values: captures inside the body, and an enclosing loop (R5) ────

describe('aiui compile — per-pass values folded forward from the start', () => {
  const PAY_MD = [
    '# Pay',
    '',
    '## Steps',
    '1. Open the page',
    '2. While the Next button is enabled, Pay the bill',
    '3. Done',
    '',
    '### Pay the bill',
    '1. Read the amount due [store as: total]',
    '2. Type {{total}} into the Amount field',
    '',
  ].join('\n');
  const TYPE = 'Type {{total}} into the Amount field';

  function payRecord(): CompileRunOutcome {
    const read = (pass: number, total: string): StepResult =>
      stepRow(3, `bill ${pass}`, { loop: marker(pass), outputs: { total } });
    const typed = (pass: number, total: string): StepResult =>
      stepRow(4, `amount ${pass}`, {
        loop: marker(pass),
        turns: [
          {
            turnNumber: 1,
            attemptNumber: 1,
            timestamp: new Date().toISOString(),
            aiInteractions: [],
            subActions: [{ index: 1, action: { action: 'type', selector: '#amount', value: total }, durationMs: 1 }],
          },
        ],
      });
    return outcome(
      [
        stepRow(1, 'start'),
        { ...judged(2, true, 1), loop: marker(1) }, read(1, '$10.00'), typed(1, '$10.00'),
        { ...judged(2, true, 2), loop: marker(2) }, read(2, '$20.00'), typed(2, '$20.00'),
        { ...judged(2, true, 3), loop: marker(3) }, read(3, '$30.00'), typed(3, '$30.00'),
        judged(2, false, 4),
        stepRow(5, 'end'),
      ],
      5,
      // The run's FINAL map: the last pass's capture.
      { resolvedParameters: { total: '$30.00' } },
    );
  }

  it("shows pass 1's capture to pass 1's generation, and its leak guard catches pass 1's value", async () => {
    const md = await write('pay.md', PAY_MD);
    const test = await parseTestFile(md);
    const { prompts, client: base } = fakeAi();
    // The body's entry hard-codes pass 1's total.
    const client = {
      complete: async (messages: ChatMessage[]) => {
        const response = await (base as unknown as { complete: (m: ChatMessage[]) => Promise<{ text: string }> }).complete(messages);
        const prompt = prompts.at(-1)!;
        if (!isReview(prompt) && sourceOf(prompt) === TYPE) {
          return {
            text: JSON.stringify({ entry: `{ source: ${JSON.stringify(TYPE)}, async run({ page }) { await page.fill('#amount', '$10.00'); } }` }),
            model: 'stub-model',
          };
        }
        return response;
      },
    } as unknown as AiClient;
    const { runner } = scriptedRunner(payRecord(), []);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    // Measured before the fix: `{{total}} resolved to "$30.00"` — the final
    // map's — and the entry inlining pass 1's `$10.00` passed the guard, green.
    const typePrompt = generationFor(prompts, TYPE)!;
    expect(typePrompt).toContain('{{total}} resolved to "$10.00"');
    expect(typePrompt).not.toContain('resolved to "$30.00"');
    expect(result.status).toBe('failed');
    expect(result.summary.error).toContain('generation failed for step 4');
    expect(result.summary.error).toContain('resolved value of {{total}}');
  });

  it("repairs a body step inside a While inside a For each with the OUTER pass's item", async () => {
    const md = await write(
      'nested.md',
      [
        '# Accounts',
        '',
        '## Parameters',
        '- accounts: ["Everyday","Savings","Travel"]',
        '',
        '## Steps',
        '1. For each {{account}} in {{accounts}}, Page through the account',
        '2. Read the reference',
        '',
        '### Page through the account',
        '1. Open the account named {{account}}',
        '2. While the Next button is enabled, Click Next for {{account}}',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    // Expanded: 1 For each · 2 Open · 3 While · 4 Click Next for {{account}} · 5 Read.
    expect(test.steps[3]).toBe('Click Next for {{account}}');
    const outer = (pass: number): LoopMarker => marker(pass, { account: ACCOUNTS[pass - 1]! });
    const recordPass = (pass: number): StepResult[] => [
      ...(pass === 1 ? [guardRow(1, undefined, { loop: outer(1) })] : []),
      stepRow(2, `${ACCOUNTS[pass - 1]} account`, { loop: outer(pass) }),
      { ...judged(3, true, pass), loop: marker(1) },
      stepRow(4, `${ACCOUNTS[pass - 1]} page 1`, { loop: marker(1) }),
      judged(3, false, pass + 10),
    ];
    const record = outcome(
      [...recordPass(1), ...recordPass(2), ...recordPass(3), stepRow(5, 'summary')],
      5,
      { resolvedParameters: { accounts: JSON.stringify(ACCOUNTS), account: 'Travel' } },
    );
    const replayPass = (pass: number, failing = false): StepResult[] => [
      ...(pass === 1 ? [guardRow(1, undefined, { loop: outer(1) })] : []),
      codeRow(2, { loop: outer(pass) }),
      { ...coded(3, true), loop: marker(1) },
      failing
        ? codeRow(4, {
            loop: marker(1),
            status: 'failed',
            error: 'no Next button in the Savings account',
            domSnapshot: '<main>Savings, page 1</main>',
          })
        : codeRow(4, { loop: marker(1) }),
      ...(failing ? [] : [coded(3, false)]),
    ];
    const round1 = outcome([...replayPass(1), ...replayPass(2, true)], 5);
    const round2 = outcome([...replayPass(1), ...replayPass(2), ...replayPass(3), codeRow(5)], 5);
    const { client, prompts } = fakeAi();
    const { runner } = scriptedRunner(record, [round1, round2]);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    expect(result.status).toBe('green');
    const repair = prompts.find((p) => isStepRepair(p) && sourceOf(p) === 'Click Next for {{account}}')!;
    expect(repair).toBeDefined();
    // Measured before the fix: the innermost marker (the While's, which binds
    // nothing) over the Record's final map — `{{account}}` resolved to
    // "Travel" for a failure on the Savings pass.
    expect(repair).toContain('{{account}} resolved to "Savings"');
    expect(repair).not.toContain('"Travel"');
    // Generation, from the same fold: pass 1's item.
    expect(generationFor(prompts, 'Click Next for {{account}}')).toContain('{{account}} resolved to "Everyday"');
  });
});

// ── The boxed prompts mask what the run masked (review round 2, F1) ─────────

describe('aiui compile — the prompts mask what the run masked', () => {
  // §7.6's case: a data file's own dotted heading holding a credential, and a
  // value no key names as secret that holds the same credential inside it.
  const KEY = 'uk_live_1234';
  const KEYS_MD = [
    '# Keys',
    '',
    '## Parameters',
    `- user.apikey: ${KEY}`,
    `- auth: Bearer ${KEY}`,
    '',
    '## Steps',
    '1. Type {{user.apikey}} into the API key box',
    '2. Type {{auth}} into the Authorization box',
    '3. While the {{user.apikey}} banner is shown, Close the banner',
    '',
  ].join('\n');
  const WHILE_KEY = 'While the {{user.apikey}} banner is shown, Close the banner';

  function typed(index: number, page: string, value: string, over: Partial<StepResult> = {}): StepResult {
    return stepRow(index, page, {
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{ index: 1, action: { action: 'type', selector: '#k', value }, durationMs: 1 }],
        },
      ],
      ...over,
    });
  }

  // The server hands back the run's map raw; the CLI hands back the report's
  // redacted copy. The fold starts from the RAW start map either way, so the
  // prompts must mask for themselves.
  it.each([
    ['the raw final map (the server)', { 'user.apikey': KEY, auth: `Bearer ${KEY}` }],
    ['the redacted final map (the CLI)', { 'user.apikey': '***', auth: 'Bearer ***' }],
  ])('never shows the key to generation, the condition, or a repair — with %s', async (_what, final) => {
    const md = await write('keys.md', KEYS_MD);
    const test = await parseTestFile(md);
    expect(test.steps[3]).toBe('Close the banner');
    const record = outcome(
      [
        typed(1, 'keys', '{{user.apikey}}'),
        typed(2, 'header', '{{auth}}'),
        { ...judged(3, true, 1), loop: marker(1) },
        stepRow(4, 'banner 1', { loop: marker(1) }),
        judged(3, false, 2),
      ],
      4,
      { resolvedParameters: final },
    );
    const round1 = outcome(
      [codeRow(1), codeRow(2, { status: 'failed', error: 'no Authorization box', domSnapshot: '<main/>' })],
      4,
      { resolvedParameters: final },
    );
    const round2 = outcome(
      [codeRow(1), codeRow(2), coded(3, true), codeRow(4), coded(3, false)],
      4,
      { resolvedParameters: final },
    );
    const { client, prompts } = fakeAi();
    const { runner } = scriptedRunner(record, [round1, round2]);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    expect(result.status).toBe('green');
    // Measured before the fix (the fold's raw start map, no map, no mask set):
    // `{{user.apikey}} resolved to "uk_live_1234"` and `{{auth}} resolved to
    // "Bearer uk_live_1234"`, in generation and in the repair alike.
    for (const prompt of prompts) expect(prompt).not.toContain(KEY);
    expect(generationFor(prompts, 'Type {{user.apikey}} into the API key box')).toContain(
      '{{user.apikey}} resolved to "***" on this run',
    );
    expect(generationFor(prompts, 'Type {{auth}} into the Authorization box')).toContain(
      '{{auth}} resolved to "Bearer ***" on this run',
    );
    expect(generationFor(prompts, WHILE_KEY)).toContain('{{user.apikey}} resolved to "***" on this run');
    const repair = prompts.find((p) => isStepRepair(p) && sourceOf(p) === 'Type {{auth}} into the Authorization box');
    expect(repair).toContain('{{auth}} resolved to "Bearer ***" on this run');
  });

  it('masks the healed-pass repair the same way', async () => {
    const md = await write('keys.md', KEYS_MD);
    await write(
      'keys.steps.ts',
      [
        "import { defineSteps } from 'ai-ui-automation/codebehind';",
        'export default defineSteps([',
        // Step 1 has no entry, so the compile records (with code-behind on).
        "  { source: 'Type {{auth}} into the Authorization box', async run({ page, step }) { await page.fill('#a', step.getVar('auth') ?? ''); } },",
        `  { source: ${JSON.stringify(WHILE_KEY)}, async condition({ page }) { return (await page.locator('#banner').count()) > 0; } },`,
        "  { source: 'Close the banner', async run({ page }) { await page.click('#close'); } },",
        ']);',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    const stale = { file: path.join(dir, 'keys.steps.ts'), source: 'Type {{auth}} into the Authorization box', error: 'no #a' };
    const record = outcome(
      [
        typed(1, 'keys', '{{user.apikey}}'),
        typed(2, 'header', '{{auth}}', { codeBehindStale: stale }),
        { ...coded(3, true), loop: marker(1) },
        codeRow(4, { loop: marker(1) }),
        coded(3, false),
      ],
      4,
      { resolvedParameters: { 'user.apikey': KEY, auth: `Bearer ${KEY}` } },
    );
    const { client, prompts } = fakeAi();
    const { runner } = scriptedRunner(record, [
      outcome([codeRow(1), codeRow(2), coded(3, true), codeRow(4), coded(3, false)], 4),
    ]);

    await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    const repair = prompts.find((p) => isStepRepair(p) && sourceOf(p) === 'Type {{auth}} into the Authorization box')!;
    expect(repair).toContain('no #a');
    expect(repair).toContain('{{auth}} resolved to "Bearer ***" on this run');
    for (const prompt of prompts) expect(prompt).not.toContain(KEY);
  });
});

// ── Writes the fold cannot see from `outputs` (review round 2, F2) ──────────

describe('aiui compile — writes a row carries elsewhere, and writes no row carries', () => {
  it("binds a [tool:] step's outputs, so the leak guard holds the value the step typed", async () => {
    const md = await write(
      'orders.md',
      [
        '# Orders',
        '',
        '## Parameters',
        '- order_id: none',
        '',
        '## Steps',
        '1. [tool: create_order]',
        '2. Type {{order_id}} into the search box',
        '',
      ].join('\n'),
    );
    const test = await parseTestFile(md);
    const TYPE = 'Type {{order_id}} into the search box';
    const toolRow: StepResult = {
      index: 1,
      instruction: '[tool: create_order]',
      status: 'passed',
      durationMs: 1,
      retried: false,
      turns: [],
      toolStep: { name: 'create_order', args: {}, outputs: { order_id: 'ORD-4821' }, logs: [] },
    };
    const typedRow = stepRow(2, 'search', {
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [{ index: 1, action: { action: 'type', selector: '#q', value: 'ORD-4821' }, durationMs: 1 }],
        },
      ],
    });
    const record = outcome([toolRow, typedRow], 2, { resolvedParameters: { order_id: 'ORD-4821' } });
    const { prompts, client: base } = fakeAi();
    // A model that inlines what the transcript typed.
    const client = {
      complete: async (messages: ChatMessage[]) => {
        const response = await (base as unknown as { complete: (m: ChatMessage[]) => Promise<{ text: string }> }).complete(messages);
        const prompt = prompts.at(-1)!;
        if (!isReview(prompt) && sourceOf(prompt) === TYPE) {
          return {
            text: JSON.stringify({ entry: `{ source: ${JSON.stringify(TYPE)}, async run({ page }) { await page.fill('#q', 'ORD-4821'); } }` }),
            model: 'stub-model',
          };
        }
        return response;
      },
    } as unknown as AiClient;
    const { runner } = scriptedRunner(record, []);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    // Measured before the fix: `{{order_id}} resolved to "none"`, and the entry
    // hard-coding ORD-4821 went through, green.
    expect(generationFor(prompts, TYPE)).toContain('{{order_id}} resolved to "ORD-4821" on this run');
    expect(result.status).toBe('failed');
    expect(result.summary.error).toContain('resolved value of {{order_id}}');
  });

  it('takes the FINAL value of a starting name no row wrote — an [input:] answer, a hook — not its start value', async () => {
    const md = await write(
      'ticket.md',
      ['# Ticket', '', '## Parameters', '- ticket: none', '', '## Steps', '1. Type {{ticket}} into the ticket box', ''].join('\n'),
    );
    const test = await parseTestFile(md);
    const record = outcome(
      [
        stepRow(1, 'ticket', {
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [{ index: 1, action: { action: 'type', selector: '#t', value: '{{ticket}}' }, durationMs: 1 }],
            },
          ],
        }),
      ],
      1,
      // Written by something no row reports.
      { resolvedParameters: { ticket: 'T-99' } },
    );
    const { client, prompts } = fakeAi();
    const { runner } = scriptedRunner(record, [outcome([codeRow(1)], 1)]);

    await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    // Measured before the fix: `"none"` — the start value, which the step never typed.
    expect(generationFor(prompts, 'Type {{ticket}} into the ticket box')).toContain(
      '{{ticket}} resolved to "T-99" on this run',
    );
  });
});

// ── The replay checks every loop's passes (review round 2, F10) ─────────────

describe("aiui compile — a replay whose loop runs a different number of passes from the recording's", () => {
  const READ = 'Read the name of every account in the Your accounts panel [store as: accounts]';
  const LOOP = 'For each {{account}} in {{accounts}}, Check the account';
  const RECORDED = '["Everyday","Savings","Travel"]';
  const SIX = '["Everyday","4111 •••• 1111","Savings","5500 •••• 2222","Travel","3400 •••• 3333"]';

  /** A marker the way a real `For each` hands it out: with the list's length. */
  const pass = (index: number, count: number, account: string): LoopMarker => ({
    kind: 'iteration',
    label: 'Check the account',
    index,
    count,
    values: { account },
  });

  /** Expanded: 1 the list's writer · 2 For each · 3 Check the account · 4 Read the reference. */
  const listMd = (writer: string): string =>
    ['# Accounts', '', '## Steps', `1. ${writer}`, `2. ${LOOP}`, '3. Read the reference', ''].join('\n');

  /** The rows a run over `items` makes: the entry row, one body row per pass. */
  function loopRows(items: string[], body: (i: number, marker: LoopMarker) => StepResult): StepResult[] {
    return [
      guardRow(2, undefined, { loop: pass(1, items.length, items[0]!) }),
      ...items.map((item, i) => body(i, pass(i + 1, items.length, item))),
    ];
  }
  const readRow = (value: string): StepResult =>
    stepRow(1, 'the accounts panel', {
      outputs: { accounts: value },
      turns: [
        {
          turnNumber: 1,
          attemptNumber: 1,
          timestamp: new Date().toISOString(),
          aiInteractions: [],
          subActions: [
            { index: 1, action: { action: 'read', selector: '.account', multiple: true, as: 'accounts' }, durationMs: 1 },
          ],
        },
      ],
    });
  const recordOf = (first: StepResult): CompileRunOutcome =>
    outcome(
      [
        first,
        ...loopRows(JSON.parse(RECORDED) as string[], (i, m) => stepRow(3, `account ${i + 1}`, { loop: m })),
        stepRow(4, 'the reference'),
      ],
      4,
    );
  const replayOf = (first: StepResult, list: string): CompileRunOutcome =>
    outcome([first, ...loopRows(JSON.parse(list) as string[], (_i, m) => codeRow(3, { loop: m })), codeRow(4)], 4);

  it('fails the entry that captured the list, says both counts, and repairs it with the recorded value', async () => {
    const md = await write('accounts.md', listMd(READ));
    const test = await parseTestFile(md);
    expect(test.steps).toEqual([READ, LOOP, 'Check the account', 'Read the reference']);
    const { client, prompts } = fakeAi();
    const { runner } = scriptedRunner(recordOf(readRow(RECORDED)), [
      replayOf(codeRow(1, { outputs: { accounts: SIX } }), SIX),
      replayOf(codeRow(1, { outputs: { accounts: RECORDED } }), RECORDED),
    ]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    // Measured before the fix (templates/init/tests/control-flow.md, a real
    // model): six passes where the recording ran three, "22/22 passed", written.
    expect(result.status).toBe('green');
    expect(result.summary.rounds).toBe(2);
    const said =
      `the code stored 6 item(s) in {{accounts}}, so step 2 ("${LOOP}") ran 6 passes; on the recording ` +
      `it ran 3 passes, with {{accounts}} = ${RECORDED}`;
    expect(replayLines(events)).toContain(`✗ step 1 — ${said}`);
    expect(stepMessages(events, 'repair', 1)).toContain('repaired');
    const repair = prompts.find((p) => isStepRepair(p) && sourceOf(p) === READ)!;
    expect(repair).toContain(`## What went wrong\n${said}`);
    expect(repair).toContain('## What the recording captured');
    expect(repair).toContain(RECORDED);
    expect(repair).toContain('ran 3 pass(es)');
    expect(result.summary.warnings).toBeUndefined();
    expect(result.summary.unproven).toEqual([]);
  });

  it('warns, and does not fail, when the list came from a step this compile does not own', async () => {
    const md = await write('accounts.md', listMd('[tool: list_accounts]'));
    const test = await parseTestFile(md);
    const tool = (value: string): StepResult => ({
      index: 1,
      instruction: '[tool: list_accounts]',
      status: 'passed',
      durationMs: 1,
      retried: false,
      turns: [],
      toolStep: { name: 'list_accounts', args: {}, outputs: { accounts: value }, logs: [] },
    });
    const { client } = fakeAi();
    const { runner } = scriptedRunner(recordOf(tool(RECORDED)), [replayOf(tool(SIX), SIX)]);
    const { events, onEvent } = collect();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, onEvent });

    const warning =
      `step 2 ("${LOOP}") ran 6 passes on the replay and 3 passes on the recording: {{accounts}} came from ` +
      'step 1 ("[tool: list_accounts]"), which is not an entry this compile wrote';
    expect(result.summary.rounds).toBe(1);
    expect(result.summary.warnings).toEqual([warning]);
    expect(events).toContainEqual({ kind: 'note', level: 'warn', message: warning });
    expect(result.status).toBe('green');
  });

  it('warns when the counts match but the values do not — a list may differ between runs', async () => {
    const md = await write('accounts.md', listMd(READ));
    const test = await parseTestFile(md);
    const other = '["Everyday","Savings","Holiday"]';
    const { client } = fakeAi();
    const { runner } = scriptedRunner(recordOf(readRow(RECORDED)), [
      replayOf(codeRow(1, { outputs: { accounts: other } }), other),
    ]);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });

    expect(result.status).toBe('green');
    expect(result.summary.rounds).toBe(1);
    expect(result.summary.warnings).toEqual([
      `step 2 ("${LOOP}") ran 3 passes on the replay, as on the recording, over a different {{accounts}}: ` +
        `${other} where the recording's was ${RECORDED}`,
    ]);
  });

  it('warns when a While the model decided on the replay ran a different number of passes', async () => {
    const md = await write('statements.md', WHILE_MD);
    const test = await parseTestFile(md);
    const { client } = fakeAi();
    // The replay's model decided the While — a difference nobody's code made,
    // which the decision check does not blame.
    const replay = outcome(
      [
        codeRow(1),
        { ...judged(2, true, 1), loop: marker(1) },
        codeRow(3, { loop: marker(1) }),
        { ...judged(2, true, 2), loop: marker(2) },
        codeRow(3, { loop: marker(2) }),
        judged(2, false, 3),
        codeRow(4),
      ],
      4,
    );
    const { runner } = scriptedRunner(whileRecord(), [replay]);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });

    expect(result.summary.warnings).toEqual([
      `step 2 ("${WHILE_LINE}") ran 2 passes on the replay and 3 passes on the recording`,
    ]);
  });

  // ── What the recording captured, before any replay can disagree ──────────
  //
  // The pass-count check above catches a wrong list in REPLAY. Run & Compile
  // has no replay, so generation itself is shown what the recording read and
  // may not write it in — measured on a real-model Run & Compile of
  // control-flow.md, which stored nine values where the recording read three.

  const CLEAN_READ =
    `{ source: ${JSON.stringify(READ)}, async run({ page, step }) { ` +
    "const names = page.locator('#account-list > li > span > span:first-child'); " +
    "await names.first().waitFor(); step.setVar('accounts', JSON.stringify(await names.allTextContents())); } }";

  /** `fakeAi`, with READ's prompts of one kind answered from `answers` in turn. */
  function readAnswers(
    answers: string[],
    kind: (prompt: string) => boolean,
  ): { client: AiClient; prompts: string[] } {
    const { prompts, client: base } = fakeAi();
    const client = {
      complete: async (messages: ChatMessage[]) => {
        const response = await (base as unknown as { complete: (m: ChatMessage[]) => Promise<{ text: string }> }).complete(messages);
        const prompt = prompts.at(-1)!;
        if (!isReview(prompt) && kind(prompt) && sourceOf(prompt) === READ && answers.length > 0) {
          return { text: JSON.stringify({ entry: answers.shift() }), model: 'stub-model' };
        }
        return response;
      },
    } as unknown as AiClient;
    return { client, prompts };
  }

  it('shows generation what the recording captured, and refuses an entry that writes it in for the clean re-ask', async () => {
    const md = await write('accounts.md', listMd(READ));
    const test = await parseTestFile(md);
    const { client, prompts } = readAnswers(
      [`{ source: ${JSON.stringify(READ)}, async run({ step }) { step.setVar('accounts', '${RECORDED}'); } }`, CLEAN_READ],
      (p) => !isStepRepair(p),
    );
    const { runner } = scriptedRunner(recordOf(readRow(RECORDED)), [
      replayOf(codeRow(1, { outputs: { accounts: RECORDED } }), RECORDED),
    ]);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    const asked = prompts.filter((p) => !isReview(p) && sourceOf(p) === READ);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(
      `- \`step.setVar('accounts', ...)\` — the recording captured a list of 3 items: ${RECORDED}`,
    );
    expect(asked[0]).toContain('**Match what the recording captured.**');
    expect(asked[1]).toContain('## Your previous answer was refused');
    expect(asked[1]).toContain("step.setVar('accounts', '***')");
    expect(result.status).toBe('green');
    const proposal = Object.values(result.files).join('\n');
    expect(proposal).toContain('allTextContents');
    for (const name of ['Everyday', 'Savings', 'Travel']) expect(proposal).not.toContain(name);
  });

  it("repairs a failed read against the RECORDING's value, never what the broken entry stored, and holds it to the guard", async () => {
    const md = await write('accounts.md', listMd(READ));
    const test = await parseTestFile(md);
    const { client, prompts } = readAnswers(
      [
        // The repair's first answer writes one item in, in a comment.
        `{ source: ${JSON.stringify(READ)}, async run({ page, step }) { /* expect Everyday first */ ` +
          "step.setVar('accounts', JSON.stringify(await page.locator('#x').allTextContents())); } }",
        CLEAN_READ,
      ],
      isStepRepair,
    );
    const { runner } = scriptedRunner(recordOf(readRow(RECORDED)), [
      // The generated read throws on the replay, having stored six values.
      outcome([codeRow(1, { status: 'failed', error: 'strict mode violation: resolved to 9 elements', outputs: { accounts: SIX } })], 4),
      replayOf(codeRow(1, { outputs: { accounts: RECORDED } }), RECORDED),
    ]);

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner, dryRun: true });

    const repairs = prompts.filter((p) => isStepRepair(p) && sourceOf(p) === READ);
    expect(repairs).toHaveLength(2);
    expect(repairs[0]).toContain(
      `## Values this step must capture\n- \`step.setVar('accounts', ...)\` — the recording captured a list of 3 items: ${RECORDED}`,
    );
    expect(repairs[0]).not.toContain('4111');
    expect(repairs[1]).toContain('## Your previous answer was refused');
    expect(repairs[1]).toContain('/* expect *** first */');
    expect(result.status).toBe('green');
    expect(result.summary.rounds).toBe(2);
    expect(Object.values(result.files).join('\n')).not.toContain('Everyday');
  });
});
