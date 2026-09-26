import { describe, it, expect, vi } from 'vitest';
import type { AiClient } from '../src/ai/client.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { parseEntryLiteral, parseStepCodeOrDecline } from '../src/ai/action-parser.js';
import { buildConditionCodePrompt, type ConditionCodePromptInput } from '../src/ai/prompts.js';
import {
  compilableCondition,
  CONDITION_WITHOUT_DOM,
  conditionEntryComplaint,
  generateConditionEntry,
  loopContextFor,
  pickConditionObservations,
  undeclaredContextComplaint,
} from '../src/codebehind/generate.js';
import { isLiteralCondition } from '../src/runner/literal-decision.js';
import { buildFileReviewPrompt } from '../src/codebehind/review.js';

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
    "import { defineSteps } from 'ai-ui-automation/codebehind';",
    'export default defineSteps([',
    "  { source: 'While the Next button is enabled, Go to the next page', async condition({ page }) { return (await page.locator('#next').count()) > 0; } },",
    "  { source: 'Click Next', async run({ page }) { await page.click('#next'); } },",
    ']);',
  ].join('\n');
  const stepsOnly = [
    "import { defineSteps } from 'ai-ui-automation/codebehind';",
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
