import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { parseEntryLiteral, parseStepCodeOrDecline } from '../src/ai/action-parser.js';
import { buildConditionCodePrompt, type ConditionCodePromptInput } from '../src/ai/prompts.js';
import {
  accountPlaceholders,
  compilableCondition,
  CONDITION_WITHOUT_DOM,
  conditionEntryComplaint,
  generateConditionEntry,
  loopContextFor,
  pickConditionObservations,
  stepParameters,
  undeclaredContextComplaint,
} from '../src/codebehind/generate.js';
import { isLiteralCondition } from '../src/runner/literal-decision.js';
import { buildFileReviewPrompt, reviewCandidate } from '../src/codebehind/review.js';
import type { Candidate } from '../src/codebehind/candidate.js';

/**
 * Generating a condition line's `condition` entry
 * (stories/codebehind-loops-and-conditions.md, "Generation") — the pieces a
 * seam test cannot pin cheaply: the static backstop's regex list, the static
 * literal rule, the parse, and what the prompt tells the model.
 */

// ── conditionEntryComplaint ──────────────────────────────────────────────────

describe('conditionEntryComplaint', () => {
  const entry = (body: string, params = '{ page, step }') =>
    `{\n  source: 'While the Next button is enabled, Go to the next page',\n  async condition(${params}) {\n${body}\n  },\n}`;

  it.each([
    [
      'the spec\'s While',
      `    const next = page.getByRole('button', { name: 'Next' });\n    return (await next.count()) > 0 && (await next.isEnabled());`,
    ],
    ['a checkbox read', `    return await page.getByLabel('Cash').isChecked();`],
    ['a count', `    return (await page.getByRole('button', { name: 'Load more' }).count()) === 0;`],
    [
      'a value read through getVar',
      `    const row = page.locator('tr', { hasText: step.getVar('order.id') ?? '' });\n    if ((await row.count()) === 0) return false;\n    return ((await row.first().textContent()) ?? '').includes('Paid');`,
    ],
    // Strings and comments are blanked before the calls are looked for.
    ['a button NAMED Click', `    // never .click( in a condition\n    return (await page.getByRole('button', { name: 'Click .fill( here' }).count()) > 0;`],
    ['an isChecked, which is not check(', `    return page.locator('#t').isChecked();`],
    ['an arrow-form condition', `    return true;`],
  ])('accepts %s', (_what, body) => {
    expect(conditionEntryComplaint(entry(body))).toBeUndefined();
  });

  it('accepts the property form `condition: async () =>`', () => {
    expect(
      conditionEntryComplaint(`{ source: 'If x, then y', condition: async ({ page }) => (await page.locator('#x').count()) > 0 }`),
    ).toBeUndefined();
  });

  it.each([
    ['click', `    await page.getByRole('button', { name: 'Next' }).click();\n    return true;`, '.click('],
    ['dblclick', `    await page.locator('#x').dblclick();\n    return true;`, '.dblclick('],
    ['fill', `    await page.locator('#q').fill('x');\n    return true;`, '.fill('],
    ['press', `    await page.locator('#q').press('Enter');\n    return true;`, '.press('],
    ['check', `    await page.getByLabel('Cash').check();\n    return true;`, '.check('],
    ['selectOption', `    await page.locator('select').selectOption('a');\n    return true;`, '.selectOption('],
    ['setInputFiles', `    await page.locator('input').setInputFiles([]);\n    return true;`, '.setInputFiles('],
    ['hover', `    await page.locator('#m').hover();\n    return true;`, '.hover('],
    ['goto', `    await page.goto('https://x.test');\n    return true;`, '.goto('],
    ['reload', `    await page.reload();\n    return true;`, '.reload('],
    ['goBack', `    await page.goBack();\n    return true;`, '.goBack('],
    ['keyboard', `    await page.keyboard.press('Escape');\n    return true;`, '.keyboard.'],
    ['mouse', `    await page.mouse.click(1, 2);\n    return true;`, '.mouse.'],
    ['waitFor', `    await page.locator('#next').waitFor();\n    return true;`, '.waitFor('],
    ['waitForTimeout', `    await page.waitForTimeout(500);\n    return true;`, '.waitForTimeout('],
    ['waitForSelector', `    await page.waitForSelector('#next');\n    return true;`, '.waitForSelector('],
    ['waitForLoadState', `    await page.waitForLoadState('networkidle');\n    return true;`, '.waitForLoadState('],
    ['setTimeout', `    await new Promise((r) => setTimeout(r, 100));\n    return true;`, 'setTimeout('],
    ['setVar', `    step.setVar('seen', 'yes');\n    return true;`, 'step.setVar('],
  ])('refuses %s, naming the call', (_what, body, call) => {
    const complaint = conditionEntryComplaint(entry(body));
    expect(complaint).toBeDefined();
    expect(complaint).toContain(`\`${call}`);
  });

  it('refuses a tab switch', () => {
    const complaint = conditionEntryComplaint(entry(`    await tabs.switchTo('page:2');\n    return true;`, '{ page, tabs }'));
    expect(complaint).toMatch(/calls `tabs\.switchTo\(`/);
  });

  it('refuses a `run` — on its own or beside a condition', () => {
    expect(
      conditionEntryComplaint(`{ source: 'If x, then y', async run({ page }) { await page.click('#a'); } }`),
    ).toMatch(/defines `run`/);
    expect(
      conditionEntryComplaint(
        `{ source: 'If x, then y', async condition() { return true; }, async run() {} }`,
      ),
    ).toMatch(/defines `run`/);
  });

  it('refuses an entry with no condition at all', () => {
    expect(conditionEntryComplaint(`{ source: 'If x, then y', ai: true }`)).toMatch(/no `condition` function/);
  });
});

describe('undeclaredContextComplaint reads a condition\'s destructure', () => {
  it('names `condition`, not `run`, when a context property is used undeclared', () => {
    const complaint = undeclaredContextComplaint(
      `{ source: 'If x, then y', async condition({ page }) { return step.getVar('a') === 'b'; } }`,
    );
    expect(complaint).toMatch(/uses `step` but `condition` does not destructure it/);
  });

  it('is satisfied by a condition that destructures what it uses', () => {
    expect(
      undeclaredContextComplaint(
        `{ source: 'If x, then y', async condition({ page, step }) { return step.getVar('a') === (await page.title()); } }`,
      ),
    ).toBeUndefined();
  });
});

// ── The static literal rule ──────────────────────────────────────────────────

describe('isLiteralCondition', () => {
  it.each([
    '{{plan}} is "pro"',
    '"{{line.debit}}" is empty',
    '{{count}} is at least 3',
    '{{payment.status}} is not "Paused"',
    '${env.MODE} is "prod"',
    '{{a}} contains {{b}}',
  ])('says %s is decided from its values', (condition) => {
    expect(isLiteralCondition(condition)).toBe(true);
  });

  it.each([
    'the Cash checkbox is ticked',
    // Parses as a literal, but makes no reference: a sentence about the page.
    '"Welcome back" is empty',
    'the {{plan}} badge is shown',
    'the row for {{order.id}} says Paid',
  ])('says %s needs the page', (condition) => {
    expect(isLiteralCondition(condition)).toBe(false);
  });
});

describe('compilableCondition', () => {
  it.each([
    ['If the Cash checkbox is ticked, then Pay with cash', 'if', 'the Cash checkbox is ticked'],
    ['Else if the Card checkbox is ticked, then Pay by card', 'elseif', 'the Card checkbox is ticked'],
    ['While the Next button is enabled, Go to the next page', 'while', 'the Next button is enabled'],
    [
      'Repeat Click Load more until the Load more button is gone, up to 10 times',
      'repeat',
      'the Load more button is gone',
    ],
  ])('compiles %s', (line, kind, condition) => {
    expect(compilableCondition(line)).toMatchObject({ kind, condition });
  });

  it.each([
    'Otherwise, Pay by card',
    'For each {{account}} in {{accounts}}, Check the account',
    // A condition its values decide — free already.
    'If {{plan}} is "pro", then Show the pro page',
    // Flow control is a STEP, never a guard.
    'If the dashboard is shown, then return',
    // An ordinary step.
    'Click Next',
  ])('does not compile %s', (line) => {
    expect(compilableCondition(line)).toBeUndefined();
  });
});

describe('pickConditionObservations', () => {
  it('takes the first held and the first not-held, in visit order', () => {
    const all = [
      { holds: true, n: 1 },
      { holds: true, n: 2 },
      { holds: false, n: 3 },
      { holds: undefined, n: 4 },
      { holds: false, n: 5 },
    ];
    expect(pickConditionObservations(all).map((o) => o.n)).toEqual([1, 3]);
  });

  it('falls back to the first not-asked one when there is nothing else', () => {
    expect(pickConditionObservations([{ holds: undefined, n: 1 }, { holds: undefined, n: 2 }]).map((o) => o.n)).toEqual([1]);
    expect(pickConditionObservations([])).toEqual([]);
  });
});

describe('loopContextFor', () => {
  it('names a For each item and its dotted bindings under the AUTHORED item', () => {
    expect(
      loopContextFor('For each {{order}} in {{orders}}, Review the order', {
        __skill1_order: 'x',
        '__skill1_order.id': 'ORD-1',
        'order.status': 'Paid',
        unrelated: 'y',
      }, '__skill1_order'),
    ).toEqual({
      line: 'For each {{order}} in {{orders}}, Review the order',
      kind: 'foreach',
      perPass: ['order', 'order.id', 'order.status'],
    });
  });

  it('binds nothing per pass for a While, and is nothing for a line that is not a loop', () => {
    expect(loopContextFor('While the Next button is enabled, Go to the next page')).toMatchObject({
      kind: 'while',
      perPass: [],
    });
    expect(loopContextFor('If x, then y')).toBeUndefined();
  });
});

// ── The parse ────────────────────────────────────────────────────────────────

describe('parseEntryLiteral with a condition entry', () => {
  const CONDITION = `{ source: 'If x, then y', async condition({ page }) { return (await page.locator('#x').count()) > 0; } }`;
  const RUN = `{ source: 'Click Next', async run({ page }) { await page.click('#next'); } }`;

  it('accepts `condition` in place of `run` when asked for a condition', () => {
    expect(parseEntryLiteral(CONDITION, 'condition')).toBe(CONDITION);
    expect(parseEntryLiteral(`{ source: 'x', condition: async () => true }`, 'condition')).toContain('condition:');
  });

  it('still requires `run` for a step, and `condition` for a condition', () => {
    expect(() => parseEntryLiteral(CONDITION)).toThrow(/missing a `run` function/);
    expect(() => parseEntryLiteral(RUN, 'condition')).toThrow(/missing a `condition` function/);
    expect(parseEntryLiteral(RUN)).toBe(RUN);
  });

  it('reads the JSON envelope the prompt asks for', () => {
    const answer = parseStepCodeOrDecline(JSON.stringify({ entry: CONDITION }), 'condition');
    expect(answer).toEqual({ kind: 'entry', entry: CONDITION });
    expect(parseStepCodeOrDecline(JSON.stringify({ entry: null, reason: 'a judgement' }), 'condition')).toEqual({
      kind: 'declined',
      reason: 'a judgement',
    });
  });
});

// ── The prompt ───────────────────────────────────────────────────────────────

describe('buildConditionCodePrompt', () => {
  const base: ConditionCodePromptInput = {
    rawLine: 'If the row for {{order}} shows {{password}}, then Pay it',
    kind: 'if',
    condition: 'the row for {{order}} shows {{password}}',
    tail: 'Pay it',
    observations: [
      { holds: true, dom: '<tr>ORD-1</tr>', url: 'https://app.test/1' },
      { holds: false, dom: '<tr>ORD-2</tr>', url: 'https://app.test/2' },
      { holds: undefined, dom: '<tr>ORD-3</tr>' },
    ],
    parameters: [
      { name: 'order', value: 'ORD-1' },
      { name: 'password', value: 'hunter2-secret' },
    ],
  };
  const text = (input: ConditionCodePromptInput): string => buildConditionCodePrompt(input).content as string;

  it('carries the line, the condition, what the answer does and the entry shape', () => {
    const prompt = text(base);
    expect(prompt).toContain('## The line, exactly as authored\nIf the row for {{order}} shows {{password}}, then Pay it');
    expect(prompt).toContain('## The condition\nthe row for {{order}} shows {{password}}');
    expect(prompt).toContain('This is an `If` line. When the condition holds, the run takes this branch (`Pay it`)');
    expect(prompt).toContain(`  source: ${JSON.stringify(base.rawLine)},`);
    expect(prompt).toContain('async condition({ page, step }) {');
  });

  it('labels each observation with its verdict', () => {
    const prompt = text(base);
    expect(prompt).toContain('### Observation 1 — the condition HELD\nURL: https://app.test/1');
    expect(prompt).toContain('### Observation 2 — the condition did NOT hold');
    expect(prompt).toContain('### Observation 3 — not asked — an earlier condition in the chain held');
    expect(prompt).toContain('<tr>ORD-2</tr>');
  });

  it('states every rule', () => {
    const prompt = text(base);
    expect(prompt).toContain('return a boolean');
    expect(prompt).toContain('Never a `run` function, never both');
    expect(prompt).toContain('**Read only.**');
    expect(prompt).toContain('**Answer about the page NOW.**');
    expect(prompt).toContain('**An absent element is an answer.**');
    expect(prompt).toContain('check `await locator.count()` first');
    expect(prompt).toContain('**Resolve to one element.**');
    expect(prompt).toContain('**Read values with `step.getVar`, never inline them.**');
    expect(prompt).toContain('**No imports.**');
  });

  it('never shows a secret value, and shows the others as getVar names', () => {
    const prompt = text(base);
    expect(prompt).not.toContain('hunter2-secret');
    expect(prompt).toContain('- {{password}} resolved to "***" on this run');
    expect(prompt).toContain('- {{order}} resolved to "ORD-1" on this run');
  });

  it('says what a Repeat … until answers — whether it holds, which ends the loop', () => {
    const prompt = text({ ...base, kind: 'repeat', tail: 'Click Load more' });
    expect(prompt).toContain('the loop STOPS the first time it holds');
    expect(prompt).toContain('`true` ends the loop');
  });

  it('shows the broken entry and what it threw, on a repair', () => {
    const prompt = text({ ...base, repair: { entryCode: '{ source: "x", async condition() { throw 1; } }', error: 'boom' } });
    expect(prompt).toContain('## The entry as it stands — it broke');
    expect(prompt).toContain('async condition() { throw 1; }');
    expect(prompt).toContain('## What went wrong\nboom');
    expect(text(base)).not.toContain('it broke');
  });

  it('says so when the line itself sits in a loop', () => {
    const prompt = text({
      ...base,
      loop: { line: 'For each {{order}} in {{orders}}, Check it', kind: 'foreach', perPass: ['order'] },
    });
    expect(prompt).toContain('## This condition line runs inside a loop');
    expect(prompt).toContain("- `{{order}}` — `step.getVar('order')`");
    expect(text(base)).not.toContain('runs inside a loop');
  });
});

// ── The review pass ──────────────────────────────────────────────────────────

describe('the review prompt, over a file with a condition entry', () => {
  const withCondition = [
    "import { defineSteps } from 'steptix/codebehind';",
    'export default defineSteps([',
    "  { source: 'While the Next button is enabled, Go to the next page', async condition({ page }) { return (await page.locator('#next').count()) > 0; } },",
    "  { source: 'Click Next', async run({ page }) { await page.click('#next'); } },",
    ']);',
  ].join('\n');
  const stepsOnly = [
    "import { defineSteps } from 'steptix/codebehind';",
    "export default defineSteps([{ source: 'Click Next', async run({ page }) { await page.click('#next'); } }]);",
  ].join('\n');
  const review = (file: string): string =>
    buildFileReviewPrompt({ markdownName: 'x.md', file, steps: ['Click Next'] }).content as string;

  it('says condition entries exist: keep them conditions, read-only, boolean — never a run, never a new one', () => {
    const prompt = review(withCondition);
    expect(prompt).toContain('**A `condition` entry answers a condition line**');
    expect(prompt).toContain('returning `true` or `false`');
    expect(prompt).toContain('Keep it read-only');
    expect(prompt).toContain('Never\n   turn one into a `run` entry');
    expect(prompt).toContain('never add a `condition` entry');
    // …and excepts it from the post-condition rule.
    expect(prompt).toContain('A `condition` entry takes no post-condition');
  });

  it('says nothing of them over a file that has none', () => {
    const prompt = review(stepsOnly);
    expect(prompt).not.toContain('condition` entry');
  });
});

// ── generateConditionEntry ───────────────────────────────────────────────────

describe('generateConditionEntry', () => {
  const LINE = 'While the {{label}} button is enabled, Go to the next page';
  const binding: CodeBehindBinding = {
    file: '/tmp/x.steps.ts',
    source: LINE,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
  };
  const good = `{ source: ${JSON.stringify(LINE)}, async condition({ page, step }) { const b = page.getByRole('button', { name: step.getVar('label') }); return (await b.count()) > 0 && (await b.isEnabled()); } }`;

  function client(answers: string[]): { client: AiClient; prompts: string[] } {
    const prompts: string[] = [];
    return {
      prompts,
      client: {
        complete: vi.fn(async (messages: Array<{ content: string }>) => {
          prompts.push(messages[messages.length - 1]!.content);
          return { text: answers.shift() ?? JSON.stringify({ entry: good }) };
        }),
      } as unknown as AiClient,
    };
  }
  const options = (c: AiClient, over: Partial<Parameters<typeof generateConditionEntry>[0]> = {}) => ({
    binding,
    observations: [{ holds: true, dom: '<button>Next</button>' }, { holds: false, dom: '<button disabled>Next</button>' }],
    resolvedParameters: { label: 'Next', unrelated: 'Zebra-7731' },
    aiClient: c,
    contextContent: '',
    testName: 'statements',
    ...over,
  });

  it('generates, shown the condition\'s own parameters only', async () => {
    const { client: c, prompts } = client([]);
    const result = await generateConditionEntry(options(c));
    expect(result).toEqual({ kind: 'entry', code: good });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('- {{label}} resolved to "Next" on this run');
    expect(prompts[0]).not.toContain('Zebra-7731');
  });

  it('declines a condition judged with no DOM, without asking', async () => {
    const { client: c, prompts } = client([]);
    const result = await generateConditionEntry(options(c, { observations: [{ holds: true }] }));
    expect(result).toEqual({ kind: 'declined', reason: CONDITION_WITHOUT_DOM });
    expect(prompts).toEqual([]);
  });

  it('declines an environment reference the run cannot answer, without asking', async () => {
    const { client: c, prompts } = client([]);
    const result = await generateConditionEntry(
      options(c, { binding: { ...binding, source: 'If ${env.MISSING} banner shows, then Close it' } }),
    );
    expect(result.kind).toBe('declined');
    expect(prompts).toEqual([]);
  });

  it('re-asks ONCE when the entry acts on the page, and takes the second answer', async () => {
    const acting = `{ source: ${JSON.stringify(LINE)}, async condition({ page }) { await page.click('#next'); return true; } }`;
    const { client: c, prompts } = client([JSON.stringify({ entry: acting }), JSON.stringify({ entry: good })]);
    const result = await generateConditionEntry(options(c));
    expect(result).toEqual({ kind: 'entry', code: good });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('## Your previous answer was refused');
    expect(prompts[1]).toContain('`.click(`');
  });

  it('discards an entry that inlines a resolved value', async () => {
    const leaking = `{ source: ${JSON.stringify(LINE)}, async condition({ page }) { return (await page.getByText('Next').count()) > 0; } }`;
    const { client: c } = client([JSON.stringify({ entry: leaking })]);
    const result = await generateConditionEntry(options(c, { resolvedParameters: { label: 'Nextpage' } }));
    // 'Nextpage' is not in the code — nothing to discard.
    expect(result.kind).toBe('entry');
    const { client: c2 } = client([JSON.stringify({ entry: leaking })]);
    const leaked = await generateConditionEntry(options(c2, { resolvedParameters: { label: 'Next' } }));
    expect(leaked).toMatchObject({ kind: 'error', message: expect.stringContaining('{{label}}') });
  });

  it('refuses a line with no compilable condition, as an error rather than an ai: true write-off', async () => {
    const { client: c, prompts } = client([]);
    const result = await generateConditionEntry(
      options(c, { binding: { ...binding, source: 'Otherwise, Pay by card' } }),
    );
    expect(result.kind).toBe('error');
    expect(prompts).toEqual([]);
  });
});

// ── conditionEntryComplaint: the receiver-aware corpus (review finding R8) ───

describe('conditionEntryComplaint over a corpus of good and bad entries', () => {
  const wrap = (body: string, params = '{ page, step }') =>
    `{ source: 'If x, then y', async condition(${params}) { ${body} } }`;

  // Every one of these is a realistic read-only condition. Since a condition
  // that still breaks a rule after its re-ask is refused outright (R6), a
  // false positive here costs a compiled condition.
  it.each([
    ['isChecked', wrap(`return await page.getByLabel('Cash').isChecked();`)],
    ['count', wrap(`return (await page.getByRole('button', { name: 'Load more' }).count()) === 0;`)],
    ['getAttribute after count', wrap(`const l = page.locator('#x'); if ((await l.count()) === 0) return false; return (await l.getAttribute('aria-disabled')) !== 'true';`)],
    ['an evaluate that reads', wrap(`return await page.evaluate(() => document.querySelectorAll('tr').length > 3);`)],
    ['an evaluate comparing, not assigning', wrap(`return await page.locator('#a').evaluate((el) => el === document.activeElement && el.value !== '' && el.childElementCount >= 1);`)],
    ['an evaluate whose ARG is a selector-looking string', wrap(`return await page.evaluate((sel) => document.querySelector(sel) !== null, 'a[href=x]');`)],
    ['textContent with getVar', wrap(`return ((await page.locator('#s').textContent()) ?? '').includes(step.getVar('plan') ?? '');`)],
    ['inputValue', wrap(`return (await page.locator('#q').inputValue()) === '';`)],
    ['new Array(3).fill(0)', wrap(`const a = new Array(3).fill(0); return a.length === 3;`)],
    ['an array declared then filled', wrap(`const seen = new Array(2); seen.fill(false); return (await page.locator('li').count()) > seen.length;`)],
    ['map.clear()', wrap(`const m = new Map(); m.clear(); return (await page.locator('#x').count()) > 0;`)],
    ['a helper called run', wrap(`return (await helpers.run(page)) === true;`)],
    ['a variable called run in a ternary', wrap(`const run = 1; const x = true ? run : 2; return x > 0;`)],
    ['the arrow form', `{ source: 'x', condition: async ({ page }) => (await page.locator('#a').count()) > 0 }`],
    ['page.url()', wrap(`return page.url().includes('/done');`)],
    ['a local named tabs', wrap(`const tabs = page.getByRole('tab'); return (await tabs.count()) > 2;`)],
    ['a regex mentioning click(', wrap(`return /click\\(/.test(page.url());`)],
    // Review round 2 (F3): a page function's OWN locals are not the page. Each
    // of these was refused as `]=` / `.count=` before, and since R6 a refusal
    // after the re-ask is a failed compile.
    ['an evaluate destructuring its first match', wrap(`return await page.evaluate(() => { const [next] = document.querySelectorAll('#next'); return !!next && !(next as HTMLButtonElement).disabled; });`)],
    ['an evaluate filling an accumulator by key', wrap(`return await page.evaluate(() => { const seen: Record<string, boolean> = {}; for (const e of document.querySelectorAll('li')) seen[e.textContent ?? ''] = true; return Object.keys(seen).length > 1; });`)],
    ['an evaluate writing a local object property', wrap(`return await page.evaluate(() => { const r = { count: 0 }; r.count = document.querySelectorAll('li').length; return r.count > 0; });`)],
    ['an evaluate writing a local array slot', wrap(`return await page.evaluate(() => { const out = []; out[0] = document.title; return out[0] === 'x'; });`)],
    ['a reduce into acc[k]', wrap(`return await page.locator('li').evaluateAll((els) => Object.keys(els.reduce((acc, e) => { acc[e.id] = 1; return acc; }, {} as Record<string, number>)).length > 1);`)],
    ['a local object titled in a page function', wrap(`return await page.evaluate(() => { const o = {}; o.title = document.title; return o.title === 'x'; });`)],
    // …(F7): the read-only tab and browser calls answer a question about the run.
    ['tabs.list()', wrap(`return tabs.list().length > 1;`, '{ page, tabs }')],
    ['tabs.active()', wrap(`return tabs.active().url().includes('/docs');`, '{ tabs }')],
    ['ctx.browsers.list() and activeLabel()', wrap(`return ctx.browsers.list().length > 1 && ctx.browsers.activeLabel() !== 'default';`, 'ctx')],
    // …and a name bound from an awaited READ is a value, not a receiver.
    ['Array(n).fill() with n from count()', wrap(`const n = await page.locator('li').count(); const flags = Array(n).fill(false); return flags.length > 2;`)],
    ['a parenthesised count', wrap(`const n = (await page.locator('li').count()); return Array(n).fill(0).length > 2;`)],
    ['fill() on texts read off the page', wrap(`const texts = await page.locator('li').allTextContents(); const copy = texts.slice(); copy.fill(''); return texts.length > 0;`)],
    ['fill() on a split title', wrap(`const t = await page.title(); const parts = t.split(' '); parts.fill(''); return parts.length > 1;`)],
    ['a comparison bound to a name', wrap(`const many = (await page.locator('li').count()) > 2; return Array(3).fill(many).every(Boolean);`)],
  ])('accepts %s', (_what, code) => {
    expect(conditionEntryComplaint(code)).toBeUndefined();
  });

  it.each([
    ['page.close()', wrap(`await page.close(); return true;`), '.close('],
    ['a locator .check() through a variable', wrap(`const cash = page.getByLabel('Cash'); await cash.check(); return true;`), '.check('],
    ['a .fill() on an item from .all()', wrap(`const inputs = await page.locator('input').all(); await inputs[0].fill('x'); return true;`), '.fill('],
    ['a .clear() on a locator', wrap(`await page.locator('#q').clear(); return true;`), '.clear('],
    ['a click on a $() handle', wrap(`await (await page.$('#a')).click(); return true;`), '.click('],
    ['a click through a page alias', wrap(`await p.locator('#a').click(); return true;`, '{ page: p }'), '.click('],
    ['ctx.page', wrap(`await ctx.page.getByRole('button').click(); return true;`, 'ctx'), '.click('],
    ['ctx.tabs.open', wrap(`await ctx.tabs.open('https://x.test'); return true;`, 'ctx'), 'tabs.open('],
    ['a bare tabs.switchTo', wrap(`await tabs.switchTo('page:2'); return true;`, '{ page, tabs }'), 'tabs.switchTo('],
    ['ctx.browsers.open', wrap(`await ctx.browsers.open('b'); return true;`, 'ctx'), 'browsers.open('],
    ['ctx.step.setVar', wrap(`ctx.step.setVar('a', 'b'); return true;`, 'ctx'), 'step.setVar('],
    ['a destructured setVar', wrap(`const { setVar } = step; setVar('a', 'b'); return true;`), 'setVar('],
    ['an evaluate that clicks', wrap(`await page.evaluate(() => (document.querySelector('button') as HTMLElement).click()); return true;`), '.click('],
    ['an evaluate STRING that clicks', wrap(`await page.evaluate("document.querySelector('button').click()"); return true;`), '.click('],
    ['an evaluate that submits', wrap(`await page.evaluate(() => document.forms[0].requestSubmit()); return true;`), '.requestSubmit('],
    ['an evaluate that dispatches', wrap(`await page.locator('#a').evaluate((el) => el.dispatchEvent(new Event('change'))); return true;`), '.dispatchEvent('],
    ['an evaluate that focuses', wrap(`await page.locator('#a').evaluate((el) => (el as HTMLElement).focus()); return true;`), '.focus('],
    ['an evaluate that assigns a DOM property', wrap(`await page.locator('#c').evaluate((el) => { (el as HTMLInputElement).checked = true; }); return true;`), '.checked='],
    ['an $eval that assigns', wrap(`await page.$eval('#c', (el) => { el.value = 'x'; }); return true;`), '.value='],
    ['a locator dispatchEvent', wrap(`await page.locator('#a').dispatchEvent('click'); return true;`), '.dispatchEvent('],
    // Review round 2 (F6): real actions the receiver reading let through.
    ['a ?.check() on a $() handle', wrap(`const el = await page.$('#cash'); await el?.check(); return true;`), '.check('],
    ['a ?.click() straight off a locator', wrap(`await page.getByRole('button', { name: 'Next' })?.click(); return true;`), '.click('],
    ['a click through an array literal of locators', wrap(`const locs = [page.locator('a')]; await locs[0].click(); return true;`), '.click('],
    ['a click through a name assigned after its declaration', wrap(`let b; b = page.locator('#a'); await b.click(); return true;`), '.click('],
    ['a click through a TYPED declaration', wrap(`const btn: Locator = page.locator('#a'); await btn.click(); return true;`), '.click('],
    ['an evaluate of an arrow the entry defines', wrap(`const act = () => document.querySelector('#x').click(); await page.evaluate(act); return true;`), '.click('],
    ['an evaluate of a function the entry declares', wrap(`function act() { (document.querySelector('#x') as HTMLElement).click(); } await page.evaluate(act); return true;`), '.click('],
    ['an evaluate of a name bound to another name', wrap(`const act = () => { document.forms[0].submit(); }; const go = act; await page.evaluate(go); return true;`), '.submit('],
    // …(F3): what a page function writes that IS the page.
    ['an evaluate writing a style', wrap(`await page.evaluate(() => { (document.querySelector('#b') as HTMLElement).style.display = 'none'; }); return true;`), '.style.display='],
    ['an evaluate writing a property by bracket', wrap(`await page.$eval('#c', (el) => { el['value'] = 'x'; }); return true;`), "['value']="],
    ['an evaluate moving the location', wrap(`await page.evaluate(() => { window.location.href = '/next'; }); return true;`), '.href='],
    ['an evaluate writing a cookie', wrap(`await page.evaluate(() => { document.cookie = 'a=b'; }); return true;`), '.cookie='],
    ['an evaluate writing storage', wrap(`await page.evaluate(() => localStorage.setItem('a', 'b')); return true;`), 'localStorage.setItem('],
    // …(F7): the tab and browser calls that change which page the run is on.
    ['tabs.close', wrap(`await tabs.close('page:2'); return tabs.list().length === 1;`, '{ page, tabs }'), 'tabs.close('],
    ['tabs.openedBy', wrap(`await tabs.openedBy(() => undefined); return true;`, '{ tabs }'), 'tabs.openedBy('],
    ['browsers.switchTo', wrap(`await ctx.browsers.switchTo('b'); return true;`, 'ctx'), 'browsers.switchTo('],
    ['a local alias of the run\'s tabs', wrap(`const tabs = ctx.tabs; await tabs.switchTo('page:2'); return true;`, 'ctx'), 'tabs.switchTo('],
    ['close() on the active page', wrap(`await tabs.active().close(); return true;`, '{ tabs }'), '.close('],
    // …and the page's own state-changing calls, on a Playwright receiver.
    ['page.setContent', wrap(`await page.setContent('<p/>'); return true;`), '.setContent('],
    ['context.clearCookies', wrap(`await context.clearCookies(); return true;`, '{ page, context }'), '.clearCookies('],
  ])('refuses %s', (_what, code, named) => {
    const complaint = conditionEntryComplaint(code);
    expect(complaint).toBeDefined();
    expect(complaint).toContain(named);
  });

  it('reads run and condition off the object\'s own keys, not the words in its body', () => {
    expect(conditionEntryComplaint(`{ source: 'x', 'run': async () => {}, async condition() { return true; } }`)).toMatch(/defines `run`/);
    expect(conditionEntryComplaint(`{ source: 'x', async check() { return condition(); } }`)).toMatch(/no `condition` function/);
  });
});

// ── Review round 3 (G5–G8): what the round-2 rules still got wrong ──────────

describe('conditionEntryComplaint — review round 3', () => {
  const wrap = (body: string, params = '{ page, step }') =>
    `{ source: 'If x, then y', async condition(${params}) {\n${body}\n} }`;

  // The six realistic read-only conditions the last review measured, kept
  // passing verbatim, and the reads round 3's rules must not start refusing.
  it.each([
    ['a count compared', wrap(`const rows = page.locator('tr');\nconst n = await rows.count();\nreturn n > 0;`)],
    ['a checkbox read through a name', wrap(`const el = page.getByRole('checkbox', { name: 'Cash' });\nreturn await el.isChecked();`)],
    ['a destructured text read', wrap(`const [a] = await page.locator('x').allTextContents();\nreturn a === 'y';`)],
    ['a bounding box', wrap(`const box = await page.locator('#x').boundingBox();\nreturn box !== null;`)],
    ['sorting an array of nodes in a page function', wrap(`return await page.evaluate(() => { const rows = [...document.querySelectorAll('tr')]; rows.sort(); return rows.length > 1; });`)],
    ['a for…of over texts', wrap(`let found = false;\nfor (const t of await page.locator('li').allTextContents()) { if (t.includes('x')) found = true; }\nreturn found;`)],
    // G5: a conditional or logical expression over DATA stays data.
    ['a conditional choosing between strings', wrap(`const n = await page.locator('tr').count();\nconst label = n > 1 ? 'many' : 'one';\nreturn label === 'many';`)],
    ['an && over two reads', wrap(`const b = page.getByRole('button');\nconst ok = (await b.count()) > 0 && (await b.isEnabled());\nreturn ok;`)],
    ['a comparison with a generic call on its right', wrap(`const n = await page.locator('li').count();\nconst big = n > (await page.evaluate<number>(() => 3));\nreturn big;`)],
    // G6: a page function's local built from literals is still its own.
    ['a local list of numbers written in a page function', wrap(`return await page.evaluate(() => { const out = [0]; out[0] = document.querySelectorAll('li').length; return out[0] > 1; });`)],
    // G7: a page function's local named `location`.
    ['a local named location, compared', wrap(`return await page.evaluate(() => { const location = document.querySelector('.loc').textContent; return location === 'Sydney'; });`)],
    ['a local named location, whose string replace is not a navigation', wrap(`return await page.evaluate(() => { const location = document.querySelector('.loc').textContent ?? ''; return location.replace(/\\s/g, '') === 'Sydney'; });`)],
    // G8: what is not an alias of the run's tabs.
    ['a list read off the run\'s tabs into a local', wrap(`const open = await tabs.list();\nreturn open.length > 1;`, '{ page, tabs }')],
    ['a Map the entry names tabs, closed through ?.', wrap(`const tabs = new Map();\ntabs.close?.();\nreturn true;`)],
  ])('accepts %s', (_what, code) => {
    expect(conditionEntryComplaint(code)).toBeUndefined();
  });

  // Each was passed before round 3's rules — measured through the reviewer's
  // repro scripts against the round-2 build.
  it.each([
    // G5: the value of a conditional / logical expression is a locator.
    ['a conditional whose branches are locators', wrap(`const n = await page.locator('tr').count();\nconst target = n > 1 ? page.getByRole('row').nth(1) : page.getByRole('row').first();\nawait target.click();\nreturn true;`), '.click('],
    ['a conditional with null on one side', wrap(`const n = await page.locator('tr').count();\nconst row = n === 0 ? null : page.locator('tr').first();\nif (row) await row.check();\nreturn true;`), '.check('],
    ['an && whose last operand is a locator', wrap(`const n = await page.locator('tr').count();\nconst row = n > 0 && page.locator('tr').first();\nif (row) await row.click();\nreturn true;`), '.click('],
    ['an || falling back to a locator', wrap(`const n = await page.locator('tr').count();\nconst row = n < 1 || page.locator('tr').first();\nawait (row as Locator).click();\nreturn true;`), '.click('],
    // G5: a type argument is not a comparison.
    ['a handle from evaluateHandle<T>()', wrap(`const h = await page.evaluateHandle<HTMLElement>(() => document.querySelector('a'));\nawait h.click();\nreturn true;`), '.click('],
    ['a handle from $<T>()', wrap(`const el = await page.$<HTMLInputElement>('#x');\nawait el!.check();\nreturn true;`), '.check('],
    // G6: a local built from the page's nodes IS the page.
    ['a spread of nodes, ticked by index', wrap(`return await page.evaluate(() => { const boxes = [...document.querySelectorAll('input[type=checkbox]')]; boxes[0].checked = true; return boxes.length > 0; });`), '.checked='],
    ['a spread of nodes, restyled by index', wrap(`return await page.evaluate(() => { const rows = [...document.querySelectorAll('tr')]; rows[0].style.display = 'none'; return rows.length > 0; });`), '.style.display='],
    ['an array literal of one node, hidden', wrap(`return await page.evaluate(() => { const els = [document.getElementById('a')]; els[0].hidden = true; return true; });`), '.hidden='],
    ['an object holding a node, written through', wrap(`return await page.evaluate(() => { const o = { el: document.body }; o.el.title = 'x'; return true; });`), '.title='],
    // G7: the global location is still the page's, however it is reached.
    ['a bare location assignment', wrap(`await page.evaluate(() => { location = '/next'; }); return true;`), 'location='],
    ['a bare location.assign()', wrap(`await page.evaluate(() => location.assign('/next')); return true;`), 'location.assign('],
    ['window.location.replace()', wrap(`await page.evaluate(() => window.location.replace('/next')); return true;`), 'location.replace('],
    ['document.location = …', wrap(`await page.evaluate(() => { document.location = '/next'; }); return true;`), 'location='],
    ['window.location written though a local location exists', wrap(`await page.evaluate(() => { const location = 'x'; window.location.href = location; }); return true;`), '.href='],
    // G8: the run's tabs and browsers through an alias.
    ['a local alias of the destructured tabs', wrap(`const t = tabs;\nawait t.switchTo('Docs');\nreturn true;`, '{ page, tabs }'), 't.switchTo('],
    ['tabs renamed in the destructure', wrap(`await tb.close();\nreturn true;`, '{ page, tabs: tb }'), 'tb.close('],
    ['tabs renamed in a destructure of ctx', wrap(`const { tabs: tb } = ctx;\nawait tb.open('https://x.test');\nreturn true;`, 'ctx'), 'tb.open('],
    ['browsers assigned to a local after its declaration', wrap(`let b;\nb = ctx.browsers;\nawait b.switchTo('other');\nreturn true;`, 'ctx'), 'b.switchTo('],
    ['an alias of an alias', wrap(`const t = ctx.tabs;\nconst u = t;\nawait u.openedBy(() => undefined);\nreturn true;`, 'ctx'), 'u.openedBy('],
  ])('refuses %s', (_what, code, named) => {
    const complaint = conditionEntryComplaint(code);
    expect(complaint).toBeDefined();
    expect(complaint).toContain(named);
  });
});

// ── generateConditionEntry never returns a hard-rule violation (R6) ─────────

describe('generateConditionEntry and a hard-rule violation', () => {
  const LINE = 'If the Cash checkbox is ticked, then Pay with cash';
  const binding: CodeBehindBinding = { file: '/tmp/x.steps.ts', source: LINE, occurrence: 0, scope: { renames: {}, inputs: {} } };
  const entry = (body: string) => JSON.stringify({ entry: `{ source: ${JSON.stringify(LINE)}, ${body} }` });
  const clicking = entry(`async condition({ page }) { await page.getByLabel('Cash').check(); return true; }`);
  const both = entry(`async run({ page }) { await page.getByLabel('Cash').check(); }, async condition({ page }) { return true; }`);
  const clean = entry(`async condition({ page }) { return await page.getByLabel('Cash').isChecked(); }`);
  const softOnly = entry(`async condition({ page }) { log.info('x'); return await page.getByLabel('Cash').isChecked(); }`);

  function client(answers: Array<string | Error>): AiClient {
    return {
      complete: vi.fn(async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return { text: next ?? JSON.stringify({ entry: null, reason: 'out of answers' }) };
      }),
    } as unknown as AiClient;
  }
  const generate = (answers: Array<string | Error>) =>
    generateConditionEntry({
      binding,
      observations: [{ holds: true, dom: '<input aria-label="Cash" type="checkbox" checked>', url: 'https://x.test' }],
      resolvedParameters: {},
      aiClient: client(answers),
      contextContent: '',
      testName: 't',
    });

  // Measured before the fix: every one of these came back `kind: 'entry'`
  // with the clicking (or `run`-carrying) code.
  it.each([
    ['the re-ask throws', [clicking, new Error('network')]],
    ['the re-ask declines', [clicking, JSON.stringify({ entry: null, reason: 'nope' })]],
    ['the re-ask still clicks', [clicking, clicking]],
    ['run + condition, and the re-ask throws', [both, new Error('network')]],
  ] as const)('refuses the entry when %s, naming the rule', async (_what, answers) => {
    const result = await generate([...answers]);
    expect(result.kind).toBe('error');
    const message = result.kind === 'error' ? result.message : '';
    expect(message).toContain('broke a rule a condition must keep');
    expect(message).toMatch(/`\.check\(`|defines `run`/);
  });

  it('takes a clean re-ask', async () => {
    const result = await generate([clicking, clean]);
    expect(result.kind).toBe('entry');
    expect(result.kind === 'entry' && result.code).toContain('isChecked()');
  });

  it('keeps the step path\'s fallback for a soft complaint alone', async () => {
    // Undeclared `log`: re-asked; the re-ask errors; the first answer stands.
    const kept = await generate([softOnly, new Error('network')]);
    expect(kept.kind).toBe('entry');
    // …and a re-ask that then breaks a HARD rule does not replace it.
    const notReplaced = await generate([softOnly, clicking]);
    expect(notReplaced.kind).toBe('entry');
    expect(notReplaced.kind === 'entry' && notReplaced.code).toContain('isChecked()');
  });
});

// ── A dotted reference inside a skill body (R3b) ─────────────────────────────

describe('stepParameters on a dotted name whose root the frame renames', () => {
  const binding: CodeBehindBinding = {
    file: '/tmp/review_orders.steps.ts',
    source: 'Open order {{order.id}}',
    occurrence: 0,
    scope: { renames: { order: '__skill1_order' }, inputs: { orders: '{{all}}' } },
  };
  const live = {
    all: '[{"id":"ORD-1001"},{"id":"ORD-1002"}]',
    // an outer loop's leftovers under the bare names
    order: '{"id":"OUTER-9"}',
    'order.id': 'OUTER-9',
    __skill1_order: '{"id":"ORD-1001"}',
    '__skill1_order.id': 'ORD-1001',
  };

  it('resolves through the rename, as step.getVar does', () => {
    // Measured before the fix: the name resolved to nothing — the prompt said
    // "this step uses no parameters" and the leak guard held nothing.
    // `bound`: the key the value is held under, which a loop mark is keyed by
    // (review round 3, G2).
    expect(stepParameters(binding, live)).toEqual([
      { name: 'order.id', value: 'ORD-1001', bound: '__skill1_order.id' },
    ]);
  });

  it('is accounted for when the model names the RENAMED dotted token, as a flat rename is (review round 2, F4)', () => {
    // The model is shown `{{__skill1_order.id}}` — the text the skill body ran
    // with — and names it back. Measured before the fix: the accounting looked
    // for the authored `order.id`, declined "{{order.id}} appears in no
    // recorded action", and the step was written `ai: true` before its prompt
    // was built. The flat rename beside it was always accepted.
    const accounted = accountPlaceholders({
      binding,
      actions: [{ action: 'type', selector: '#q', value: '{{__skill1_order.id}}' }],
      resolvedParameters: live,
      recordingCarriesPlaceholders: true,
    });
    expect(accounted).toEqual({ recoveredByValue: [], preChangeFallback: false });
    const flat = accountPlaceholders({
      binding: { ...binding, source: 'Open order {{ref}}', scope: { renames: { ref: '__skill1_ref' }, inputs: {} } },
      actions: [{ action: 'type', selector: '#q', value: '{{__skill1_ref}}' }],
      resolvedParameters: { __skill1_ref: 'R-1' },
      recordingCarriesPlaceholders: true,
    });
    expect(flat).toEqual(accounted);
    // …and still declines a transcript that named neither.
    expect(
      accountPlaceholders({
        binding,
        actions: [{ action: 'type', selector: '#q', value: 'something else' }],
        resolvedParameters: live,
        recordingCarriesPlaceholders: true,
      }).decline,
    ).toBe('{{order.id}} appears in no recorded action');
  });

  it('lets the leak guard catch a condition entry that hard-codes the item', async () => {
    const LINE = 'While the {{order.id}} row is shown, Close it';
    const result = await generateConditionEntry({
      binding: { ...binding, source: LINE },
      observations: [{ holds: true, dom: '<tr><td>ORD-1001</td></tr>' }],
      resolvedParameters: live,
      aiClient: {
        complete: async () => ({
          text: JSON.stringify({
            entry: `{ source: ${JSON.stringify(LINE)}, async condition({ page }) { return (await page.getByRole('row', { name: 'ORD-1001' }).count()) > 0; } }`,
          }),
        }),
      } as unknown as AiClient,
      contextContent: '',
      testName: 't',
    });
    expect(result).toMatchObject({ kind: 'error', message: expect.stringContaining('{{order.id}}') });
  });
});

// ── The review pass keeps a condition a condition (R7) ───────────────────────

describe('reviewCandidate over a file with a condition entry', () => {
  const WHILE = 'While the Next button is enabled, Go to the next page';
  const file = (conditionEntry: string) =>
    [
      'const defineSteps = (x: unknown) => x;',
      'export default defineSteps([',
      `  ${conditionEntry},`,
      "  { source: 'Click Next', async run({ page }) { await page.click('#next'); } },",
      ']);',
      '',
    ].join('\n');
  const original = file(
    `{ source: ${JSON.stringify(WHILE)}, async condition({ page }) { return (await page.locator('#next:enabled').count()) > 0; } }`,
  );

  async function review(
    revision: string,
    before: string = original,
  ): Promise<{ events: string[]; replaced: string | undefined }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-condition-'));
    const target = path.join(dir, 'statements.steps.ts');
    let replaced: string | undefined;
    const candidate = {
      contentOf: () => before,
      touchedFiles: () => [target],
      replaceFile: async (_f: string, text: string) => { replaced = text; },
    } as unknown as Candidate;
    const events: string[] = [];
    try {
      await reviewCandidate(
        candidate,
        {
          markdownName: 'statements.md',
          steps: [WHILE, 'Click Next'],
          guarded: [],
          aiClient: { complete: async () => ({ text: JSON.stringify({ file: revision }) }) } as unknown as AiClient,
        },
        (m) => events.push(m),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    return { events, replaced };
  }

  it('rejects a revision that turns the condition into a run', async () => {
    const { events, replaced } = await review(
      file(`{ source: ${JSON.stringify(WHILE)}, async run({ page }) { await page.click('#next'); } }`),
    );
    expect(replaced).toBeUndefined();
    expect(events.at(-1)).toBe(
      `rejected: the revision turns the condition entry for ${JSON.stringify(WHILE)} into something that is not one — the generated file stands`,
    );
  });

  it('rejects a revision whose condition now acts on the page', async () => {
    const { events, replaced } = await review(
      file(`{ source: ${JSON.stringify(WHILE)}, async condition({ page }) { await page.locator('#next').click(); return true; } }`),
    );
    expect(replaced).toBeUndefined();
    expect(events.at(-1)).toMatch(/^rejected: the revision breaks the condition entry for .*`\.click\(`.* — the generated file stands$/);
  });

  it('accepts a revision that keeps it a clean condition', async () => {
    const { events, replaced } = await review(
      file(`{ source: ${JSON.stringify(WHILE)}, async condition({ page }) { const next = page.locator('#next'); return (await next.count()) > 0 && (await next.isEnabled()); } }`),
    );
    expect(events.at(-1)).toBe('revised statements.steps.ts');
    expect(replaced).toContain('isEnabled()');
  });

  // Review round 2 (F5): the check is for what the REVIEWER did. A hand-written
  // condition the static check dislikes — here it waits — sat in the file
  // before the review and the revision left it alone; measured before the fix,
  // every revision of the file was rejected over it, whatever it changed.
  const handWritten =
    `{ source: ${JSON.stringify(WHILE)}, async condition({ page }) { await page.locator('#next').waitFor({ timeout: 500 }).catch(() => {}); return (await page.locator('#next:enabled').count()) > 0; } }`;

  it('accepts a revision that leaves an existing condition entry as it was, however it reads', async () => {
    const before = file(handWritten);
    const revision = before.replace("await page.click('#next');", "await page.getByRole('button', { name: 'Next' }).click();");
    const { events, replaced } = await review(revision, before);
    expect(events.at(-1)).toBe('revised statements.steps.ts');
    expect(replaced).toContain("getByRole('button', { name: 'Next' })");
    expect(replaced).toContain('waitFor({ timeout: 500 })');
  });

  it('still judges an existing condition entry the revision REWROTE', async () => {
    const before = file(handWritten);
    const revision = before.replace('timeout: 500', 'timeout: 800');
    const { events, replaced } = await review(revision, before);
    expect(replaced).toBeUndefined();
    expect(events.at(-1)).toMatch(/^rejected: the revision breaks the condition entry for .*waitFor.* — the generated file stands$/);
  });

  it('judges an entry the revision turned INTO a condition', async () => {
    const before = file(`{ source: ${JSON.stringify(WHILE)}, async run({ page }) { await page.click('#next'); } }`);
    const revision = file(`{ source: ${JSON.stringify(WHILE)}, async condition({ page }) { await page.locator('#next').click(); return true; } }`);
    const { events, replaced } = await review(revision, before);
    expect(replaced).toBeUndefined();
    expect(events.at(-1)).toMatch(/^rejected: the revision breaks the condition entry for .*`\.click\(`/);
  });
});
