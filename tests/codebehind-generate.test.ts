import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import {
  findInlinedParameterValue,
  parseStepCode,
  parseStepCodeOrDecline,
} from '../src/ai/action-parser.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { markLoopBindings } from '../src/utils/secrets.js';
import { readFileSync } from 'node:fs';
import {
  aiEntryFor,
  ambiguousSelectorComplaint,
  generateStepEntry,
  refuseReason,
  stepParameters,
  staleHandleComplaint,
  unwaitedReadComplaint,
  undeclaredContextComplaint,
} from '../src/codebehind/generate.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { buildFileReviewPrompt, parseFileRevision } from '../src/codebehind/review.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * Generation, review and repair as the compiler uses them: the prompts' inputs,
 * the envelopes' parses, the secret-literal guard, and the refusals that keep
 * the compiler from asking for code it could not use
 * (stories/codebehind-compile.md, "Generate" / "Review" / "Replay").
 *
 * No real model is involved — the AI client is a stub that returns whatever
 * the case is about. Nothing here writes a `.steps.ts`: generation hands the
 * compiler an entry, and only a green replay reaches the writer.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

let counter = 0;
let dir: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-generate');
});

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

/** An AI client that answers with `text` and records what it was asked. */
function stubClient(text: string): { client: AiClient; calls: ChatMessage[][] } {
  return stubSequence(text);
}

/** The same, answering with each text in turn — the last one repeating, so a
 *  test that expects two calls fails loudly on a third rather than hanging. */
function stubSequence(...texts: string[]): { client: AiClient; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const text = texts[Math.min(calls.length, texts.length - 1)]!;
      calls.push(messages);
      return { text, model: 'stub-model' };
    },
  } as unknown as AiClient;
  return { client, calls };
}

function bindingFor(source: string, overrides: Partial<CodeBehindBinding> = {}): CodeBehindBinding {
  return {
    file: path.join(dir, 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...overrides,
  };
}

const PASSING_ACTIONS = [
  { action: 'type' as const, selector: '#password', value: 'hunter2-correct-horse' },
  { action: 'click' as const, selector: 'button[type=submit]' },
];

describe('parseStepCode', () => {
  it('extracts the entry from a fenced ts block', () => {
    const entry = parseStepCode([
      'Here is the entry:',
      '```ts',
      "{",
      "  source: 'Click Sign in',",
      '  async run({ page }) { await page.click("#signin"); },',
      '}',
      '```',
    ].join('\n'));
    expect(entry.startsWith('{')).toBe(true);
    expect(entry).toContain("source: 'Click Sign in'");
    expect(entry).not.toContain('```');
  });

  it('accepts an unfenced object literal', () => {
    const entry = parseStepCode(`{ source: 'A', async run() {} }`);
    expect(entry).toBe(`{ source: 'A', async run() {} }`);
  });

  it('unwraps the JSON envelope the JSON-mode client produces', () => {
    const literal =
      "{\n  source: 'Click Sign in',\n  async run({ page }) { await page.click('#signin'); },\n}";
    expect(parseStepCode(JSON.stringify({ entry: literal }))).toBe(literal);
    // A fence the model nested inside the envelope string is stripped too.
    expect(parseStepCode(JSON.stringify({ entry: '```ts\n' + literal + '\n```' }))).toBe(literal);
  });

  it('rejects a JSON response that is not the envelope (e.g. an action reply)', () => {
    expect(() => parseStepCode('{"reasoning": "done", "actions": []}')).toThrow(/source/);
  });

  it('decodes a double-escaped single-line envelope entry', () => {
    // The model wrote \\n in the JSON, so after JSON.parse the entry holds
    // literal backslash-n in code position — a guaranteed syntax error unless
    // the parser restores real newlines.
    const doubleEscaped = "{ source: 'X',\\n  async run({ page }) { await page.goto('/'); },\\n}";
    const entry = parseStepCode(JSON.stringify({ entry: doubleEscaped }));
    expect(entry).toContain('\n');
    expect(entry).not.toContain('\\n');
  });

  it('refuses a response with no object literal, no source, or no run', () => {
    expect(() => parseStepCode('I could not write this step.')).toThrow(/no object literal/);
    expect(() => parseStepCode(`{ async run() {} }`)).toThrow(/source/);
    expect(() => parseStepCode(`{ source: 'A' }`)).toThrow(/run/);
  });
});

describe('parseStepCodeOrDecline', () => {
  it('reads the decline envelope and keeps the reason', () => {
    const answer = parseStepCodeOrDecline(
      JSON.stringify({ entry: null, reason: 'needs a human to read the confirmation screen' }),
    );
    expect(answer).toEqual({
      kind: 'declined',
      reason: 'needs a human to read the confirmation screen',
    });
  });

  it('treats an empty entry string as a decline', () => {
    const answer = parseStepCodeOrDecline(JSON.stringify({ entry: '   ', reason: 'no idea' }));
    expect(answer.kind).toBe('declined');
  });

  it('supplies a reason when the model declines without one', () => {
    const answer = parseStepCodeOrDecline(JSON.stringify({ entry: null }));
    expect(answer).toEqual({ kind: 'declined', reason: 'the model declined without giving a reason' });
  });

  it('still returns code for a normal envelope', () => {
    const answer = parseStepCodeOrDecline(
      JSON.stringify({ entry: `{ source: 'A', async run() {} }` }),
    );
    expect(answer).toEqual({ kind: 'entry', entry: `{ source: 'A', async run() {} }` });
  });
});

describe('the inlined-parameter guard', () => {
  const params = [
    { name: 'password', value: 'hunter2-correct-horse' },
    { name: 'username', value: 'octocat' },
  ];

  it('rejects code that inlines a resolved parameter value', () => {
    const leaky = `{ source: 'Sign in', async run({ page }) { await page.fill('#p', 'hunter2-correct-horse'); } }`;
    expect(findInlinedParameterValue(leaky, params)).toBe('password');
  });

  it('accepts code that reads the parameter through step.getVar', () => {
    const clean = `{ source: 'Sign in', async run({ page, step }) { await page.fill('#p', step.getVar('password')!); } }`;
    expect(findInlinedParameterValue(clean, params)).toBeUndefined();
  });

  it('catches a value hidden in a comment or a template literal, not just a string', () => {
    expect(findInlinedParameterValue('// was hunter2-correct-horse', params)).toBe('password');
    expect(findInlinedParameterValue('const s = `${x}octocat`;', params)).toBe('username');
  });

  it('ignores values too short to be worth guarding', () => {
    // Otherwise every generation with a digit or a two-letter code in it
    // would be refused, and nothing would ever be written.
    expect(findInlinedParameterValue('await page.click("#row-1");', [{ name: 'row', value: '1' }]))
      .toBeUndefined();
  });
});

describe('buildStepCodePrompt', () => {
  it('carries the authored step text, the resolved parameters and the transcript', () => {
    const msg = buildStepCodePrompt({
      rawStepText: 'Enter the username {{username}}',
      parameters: [{ name: 'username', value: 'octocat' }],
      actions: PASSING_ACTIONS,
      captures: ['entered'],
    });
    const text = contentBlocksToText(msg.content);
    expect(text).toContain('Enter the username {{username}}');
    expect(text).toContain('{{username}} resolved to "octocat"');
    expect(text).toContain('"selector": "#password"');
    expect(text).toContain("step.setVar('entered', ...)");
    // The model is never asked to choose scope.
    expect(text).not.toContain('section:');
  });

  it('carries the whole test, the candidate file and the DOM either side', () => {
    const msg = buildStepCodePrompt({
      rawStepText: 'Click Sign in',
      parameters: [],
      actions: PASSING_ACTIONS,
      wholeTest: [
        { index: 1, text: 'Open the login page', inScope: false, isThisStep: false },
        { index: 2, text: 'Click Sign in', inScope: true, isThisStep: true },
      ],
      candidateFile: `export default defineSteps([{ source: 'Open the login page' }]);`,
      domBefore: '<form id="login"></form>',
      urlBefore: 'https://app.test/login',
      domAfter: '<h1>Dashboard</h1>',
      urlAfter: 'https://app.test/dashboard',
    });
    const text = contentBlocksToText(msg.content);
    expect(text).toContain('## The whole test');
    expect(text).toContain('1. Open the login page');
    expect(text).toContain('← THIS STEP');
    expect(text).toContain('## The code-behind file as it stands');
    expect(text).toContain("source: 'Open the login page'");
    expect(text).toContain('<form id="login"></form>');
    expect(text).toContain('<h1>Dashboard</h1>');
    expect(text).toContain('https://app.test/dashboard');
  });

  it('warns that a transcript selector proves nothing about uniqueness', () => {
    // The runtime runs every selector through
    // `root.locator(sel).locator('visible=true').first()`
    // (src/browser/actions.ts), so a transcript selector may match several
    // elements — and the same selector in generated code is strict. Caught
    // live: a recorded click on `a[href="/login"]` compiled to a bare
    // locator that threw "resolved to 2 elements" on the next run.
    const text = contentBlocksToText(
      buildStepCodePrompt({ rawStepText: 'x', parameters: [], actions: [] }).content,
    );
    expect(text).toContain('not evidence that it matches one element');
    expect(text).toContain('visible-only filter and took the first match');
    expect(text).toContain("locator('visible=true').first()");
  });
  it('states the post-condition rule and offers the decline envelope', () => {
    const text = contentBlocksToText(
      buildStepCodePrompt({ rawStepText: 'x', parameters: [], actions: [] }).content,
    );
    expect(text).toContain('End with a post-condition');
    expect(text).toContain('"entry": null');
  });
});

/**
 * stories/codebehind-selector-ambiguity.md — "What generation does with it".
 *
 * Rule 8 stops being advice and starts keying off a measured number. The
 * question the model used to be asked — "is this selector unique in a DOM I
 * can only partly see?" — is one its evidence structurally cannot answer,
 * because the snapshot is truncated, attribute-allowlisted and strips hidden
 * elements' attributes. So it is no longer asked: the count is measured in the
 * live page and handed over, and the rule keys off it.
 */
describe('buildStepCodePrompt — the measurement', () => {
  const AMBIGUOUS = {
    action: 'click' as const,
    selector: 'a[href="transactions.html"]',
    targeting: {
      matchCount: 2,
      visibleMatchCount: 1,
      resolvedSelector: '#statements a[href="transactions.html"]',
      resolvedBy: 'scoped' as const,
    },
  };

  it('names the resolved selector and forbids the bare one when the run measured two matches', () => {
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Open the statements list',
        parameters: [],
        actions: [AMBIGUOUS],
      }).content,
    );
    // The transcript carries the measurement, and the legend says what it is
    // and — the whole point — where it came from.
    expect(text).toContain('"matchCount": 2');
    expect(text).toContain(JSON.stringify(AMBIGUOUS.targeting.resolvedSelector));
    expect(text).toContain('MEASURED in the live page');
    // The rule: use the resolved handle or the runtime's own tolerance. No
    // third option, and no judgement about what looks unique in the DOM.
    expect(text).toContain('NOT usable as written');
    expect(text).toContain('`resolvedSelector` verbatim');
    expect(text).toContain("locator('visible=true').first()");
    expect(text).toContain('There is no third option');
  });

  it('does not nag when the run measured exactly one match', () => {
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click Sign in',
        parameters: [],
        actions: [
          {
            action: 'click',
            selector: '#signin',
            targeting: { matchCount: 1, visibleMatchCount: 1, resolvedSelector: '#signin', resolvedBy: 'attribute' },
          },
        ],
      }).content,
    );
    expect(text).toContain('matched exactly one element. Use it as written');
    // A clause the transcript cannot trigger is pure cost in a prompt read on
    // every compile — and reads as a warning about a selector that is fine.
    expect(text).not.toContain('NOT usable as written');
  });

  it('leaves the prompt exactly as it was when nothing was measured', () => {
    // Absence is first-class: measurement is compile-only and swallows its
    // own failures, so a transcript without it is the ordinary case and must
    // never read as an error.
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click Sign in',
        parameters: [],
        actions: [{ action: 'click', selector: '#signin' }],
      }).content,
    );
    expect(text).toContain('not evidence that it matches one element');
    expect(text).not.toContain('MEASURED in the live page');
    expect(text).not.toContain('resolvedBy');
    expect(text).not.toContain('NOT usable as written');
    // Numbering stays put, so the rules read the same as they always did.
    expect(text).toContain('9. **End with a post-condition, and make it wait.**');
  });

  it('reads a plural action’s count as context for the loop, never as ambiguity', () => {
    // `read multiple` and `count` record a `matchCount` as well, and many
    // matches is their whole purpose — a rule that called three matches a
    // problem would be telling the model to break the loop it is writing.
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Read every notice',
        parameters: [],
        actions: [
          { action: 'read', selector: '#notices span', multiple: true, targeting: { matchCount: 3 } },
        ],
      }).content,
    );
    expect(text).toContain('not a problem: many matches is what those actions are for');
    expect(text).not.toContain('NOT usable as written');
  });

  it('falls back to the inferred rule when the measurement says nothing it can key off', () => {
    // `ambiguousTarget: 'fail'` measures the ONE count its gate needs and
    // nothing else, so a `targeting` can arrive with no count of the kind the
    // rule turns on. A rule heading over no clauses would claim a measurement
    // the transcript does not carry.
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click Sign in',
        parameters: [],
        actions: [{ action: 'click', selector: '#signin', targeting: { visibleMatchCount: 1 } }],
      }).content,
    );
    expect(text).toContain('not evidence that it matches one element');
    expect(text).toContain('9. **End with a post-condition, and make it wait.**');
  });

  it('asks for a data-driven locator on a positional handle, and not on a scoped one', () => {
    const positional = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click the row for {{customer}}',
        parameters: [{ name: 'customer', value: 'Smith' }],
        actions: [
          {
            action: 'click',
            selector: 'tbody tr td:nth-of-type(1)',
            targeting: {
              matchCount: 1,
              resolvedSelector: 'tbody tr:nth-of-type(42) td:nth-of-type(1)',
              resolvedBy: 'positional',
            },
          },
        ],
      }).content,
    );
    // Pinning row 42 compiles this run's DATA into a committed file, so the
    // entry must name the customer through the step's variable instead.
    expect(positional).toContain("step.getVar('customer')");
    expect(positional).toContain("instead of pinning this run's index");
    // And the model is told to read `resolvedBy`, never to sniff the string.
    expect(positional).toContain('never work that out from the string');

    const scoped = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click the row for {{customer}}',
        parameters: [{ name: 'customer', value: 'Smith' }],
        actions: [AMBIGUOUS],
      }).content,
    );
    expect(scoped).not.toContain("instead of pinning this run's index");
    // `scoped` is the COMMON answer to a hidden duplicate, not a worse one.
    expect(scoped).toContain('not a second-best one');
  });

  it('carries the refusal and the refused entry on the one re-ask', () => {
    const text = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Open the statements list',
        parameters: [],
        actions: [AMBIGUOUS],
        retry: {
          previousEntry: `{ source: 'Open the statements list', async run() {} }`,
          complaint: 'the entry uses "a[href=..]" bare, but this run measured 2 elements',
        },
      }).content,
    );
    expect(text).toContain('## Your previous answer was refused');
    expect(text).toContain('this run measured 2 elements');
    // Shown its own answer: a model told only "do it again" returns what it
    // returned.
    expect(text).toContain(`{ source: 'Open the statements list', async run() {} }`);
  });
});

/**
 * stories/codebehind-selector-ambiguity.md — "The static backstop".
 *
 * Deterministic, costs nothing, and covers the case the prompt cannot: the
 * model read the measurement and wrote the bare selector anyway.
 */
describe('ambiguousSelectorComplaint', () => {
  const MEASURED = [
    {
      action: 'click' as const,
      selector: 'a[href="/login"]',
      targeting: {
        matchCount: 2,
        visibleMatchCount: 1,
        resolvedSelector: '#nav a[href="/login"]',
        resolvedBy: 'scoped' as const,
      },
    },
  ];
  const entry = (body: string): string =>
    `{ source: 'Click Sign in', async run({ page }) { ${body} } }`;

  it('refuses the bare selector and names what to use instead', () => {
    const complaint = ambiguousSelectorComplaint(
      entry(`await page.locator('a[href="/login"]').click();`),
      MEASURED,
    );
    expect(complaint).toContain('2 elements');
    expect(complaint).toContain('#nav a[href=\\"/login\\"]');
    expect(complaint).toContain("visible=true");
  });

  it('refuses it just as much through a page-level action call', () => {
    expect(ambiguousSelectorComplaint(entry(`await page.click('a[href="/login"]');`), MEASURED))
      .toBeDefined();
  });

  it('accepts the resolved handle, the runtime tolerance, a scoping and a .first()', () => {
    for (const body of [
      `await page.locator('#nav a[href="/login"]').click();`,
      `await page.locator('a[href="/login"]').locator('visible=true').first().click();`,
      `await page.locator('#nav').locator('a[href="/login"]').click();`,
      `await page.locator('a[href="/login"]').first().click();`,
      `const link = page.locator('a[href="/login"]');\nawait link.first().click();`,
    ]) {
      expect(ambiguousSelectorComplaint(entry(body), MEASURED)).toBeUndefined();
    }
  });

  it('does not run at all when no count was recorded', () => {
    // Absence means the check does not run, never that it fails.
    const bare = entry(`await page.locator('a[href="/login"]').click();`);
    expect(ambiguousSelectorComplaint(bare, [{ action: 'click', selector: 'a[href="/login"]' }]))
      .toBeUndefined();
    expect(
      ambiguousSelectorComplaint(bare, [
        { action: 'click', selector: 'a[href="/login"]', targeting: { resolvedSelector: '#nav a' } },
      ]),
    ).toBeUndefined();
  });

  it('passes a selector the run measured as matching once', () => {
    expect(
      ambiguousSelectorComplaint(entry(`await page.locator('#signin').click();`), [
        { action: 'click', selector: '#signin', targeting: { matchCount: 1 } },
      ]),
    ).toBeUndefined();
  });

  it('never refuses a plural action, whose whole purpose is many matches', () => {
    expect(
      ambiguousSelectorComplaint(entry(`const rows = await page.locator('li.row').allTextContents();`), [
        { action: 'read', selector: 'li.row', multiple: true, targeting: { matchCount: 7 } },
      ]),
    ).toBeUndefined();
  });

  it('leaves a tolerant API alone — it takes the first match without throwing', () => {
    expect(
      ambiguousSelectorComplaint(entry(`await page.waitForSelector('a[href="/login"]');`), MEASURED),
    ).toBeUndefined();
  });
});

describe('refuseReason', () => {
  it('refuses a transcript that waits on a person', () => {
    expect(refuseReason('Ask the tester to confirm', [
      { action: 'prompt', question: 'Did it arrive?' },
      { action: 'click', selector: '#x' },
    ])).toMatch(/prompt/);
  });

  // The six actions that used to be refused wholesale. `ctx.tabs` and
  // `ctx.browsers` express all of them now
  // (stories/codebehind-framework-actions.md), so a refusal here would be the
  // regression that silently reinstates the AI floor on every test that
  // touches a second tab.
  it.each([
    ['openPage', { action: 'openPage' as const, url: 'https://example.com/docs' }],
    ['switchPage', { action: 'switchPage' as const, page: 'page:2' }],
    ['closePage', { action: 'closePage' as const, page: 'page:2' }],
    ['openBrowser', { action: 'openBrowser' as const, browserLabel: 'worker' }],
    ['switchBrowser', { action: 'switchBrowser' as const, browserLabel: 'worker' }],
    ['closeBrowser', { action: 'closeBrowser' as const, browserLabel: 'worker' }],
  ])('allows a transcript containing %s', (_name, action) => {
    expect(refuseReason('Open a new tab and switch to it', [action])).toBeUndefined();
  });

  it('refuses a bracket-token step — code-behind for those is a stated non-goal', () => {
    for (const source of ['[output: balance] Read the balance', '[input: pin] Enter your PIN']) {
      expect(refuseReason(source, [{ action: 'read', selector: '#b', as: 'balance' }]))
        .toMatch(/bracket marker/);
    }
  });

  it('refuses a step with no recorded page actions', () => {
    expect(refuseReason('Nothing happened', [])).toMatch(/no page actions/);
  });

  it('allows an ordinary step', () => {
    expect(refuseReason('Click Sign in', PASSING_ACTIONS)).toBeUndefined();
  });
});

describe('undeclaredContextComplaint', () => {
  // The fault this exists for, verbatim from the first live run of
  // compile-browsers.md: three entries generated correctly, all three threw
  // `ReferenceError: browsers is not defined` on replay because the parameter
  // list was still the `{ page, step, log }` the prompt's example shows.
  it('catches a context property used but not destructured', () => {
    const complaint = undeclaredContextComplaint(
      `{\n  source: 'x',\n  async run({ page, step, log }) {\n` +
      `    await browsers.open('worker');\n  },\n}`,
    );
    expect(complaint).toMatch(/browsers/);
    expect(complaint).toMatch(/ReferenceError/);
  });

  it('stays quiet when it is destructured', () => {
    expect(
      undeclaredContextComplaint(
        `{\n  source: 'x',\n  async run({ page, step, log, browsers }) {\n` +
        `    await browsers.open('worker');\n  },\n}`,
      ),
    ).toBeUndefined();
  });

  it('exempts a local binding of the same name', () => {
    expect(
      undeclaredContextComplaint(
        `{\n  source: 'x',\n  async run({ page }) {\n` +
        `    const tabs = await page.locator('.tab').all();\n` +
        `    await tabs.length;\n  },\n}`,
      ),
    ).toBeUndefined();
  });

  // `run(ctx)` puts everything behind `ctx.`, so there is no bare name to be
  // undeclared and nothing this check can say.
  it('says nothing about an entry that takes the whole context', () => {
    expect(
      undeclaredContextComplaint(
        `{\n  source: 'x',\n  async run(ctx) {\n    await ctx.tabs.switchTo('main');\n  },\n}`,
      ),
    ).toBeUndefined();
  });

  it('is not fooled by a property access on something else', () => {
    expect(
      undeclaredContextComplaint(
        `{\n  source: 'x',\n  async run({ page }) {\n` +
        `    await page.locator('#x').click();\n` +
        `    const info = { browsers: 1 };\n` +
        `    step.expect(info.browsers === 1);\n  },\n}`,
      ),
      // `info.browsers` is a property access, not a bare `browsers.` use —
      // but `step` IS used bare and undeclared, so that is what it reports.
    ).toMatch(/`step`/);
  });
});

describe('staleHandleComplaint', () => {
  const entryWith = (body: string) =>
    `{\n  source: 'x',\n  async run({ page, tabs, browsers }) {\n${body}\n  },\n}`;

  it('complains when `page` is used after a tab switch', () => {
    const complaint = staleHandleComplaint(
      entryWith(
        `    await tabs.switchTo('page:2');\n` +
        `    await page.getByRole('heading', { name: 'Docs' }).waitFor();`,
      ),
    );
    expect(complaint).toMatch(/destructures once/);
    expect(complaint).toMatch(/`page`/);
  });

  it('complains when `context` is used after a browser switch', () => {
    expect(
      staleHandleComplaint(
        entryWith(
          `    await browsers.switchTo('worker');\n` +
          `    await context.cookies();`,
        ),
      ),
    ).toMatch(/`context`/);
  });

  it('stays quiet when the returned handle is used instead', () => {
    expect(
      staleHandleComplaint(
        entryWith(
          `    const opened = await tabs.open('https://example.com/docs');\n` +
          `    await opened.getByRole('heading', { name: 'Docs' }).waitFor();`,
        ),
      ),
    ).toBeUndefined();
  });

  // The one shape the naive "mentions page after a switcher" check gets
  // wrong: `openedBy`'s trigger runs BEFORE the tab exists, so its `page` use
  // is correct and is on the switching line itself.
  it('leaves openedBy\'s own trigger alone', () => {
    expect(
      staleHandleComplaint(
        entryWith(
          `    const popup = await tabs.openedBy(() => page.getByRole('button', { name: 'Open' }).click());\n` +
          `    await popup.getByRole('heading').waitFor();`,
        ),
      ),
    ).toBeUndefined();
  });

  it('leaves a `page` use before the switch alone', () => {
    expect(
      staleHandleComplaint(
        entryWith(
          `    await page.getByRole('button', { name: 'Open' }).click();\n` +
          `    const opened = await tabs.switchTo('page:2');\n` +
          `    await opened.getByRole('heading').waitFor();`,
        ),
      ),
    ).toBeUndefined();
  });

  it('says nothing about an entry that never switches', () => {
    expect(
      staleHandleComplaint(entryWith(`    await page.locator('#login').fill('x');`)),
    ).toBeUndefined();
  });

  // `tabs.list()` and `tabs.active()` read; they do not move the active page,
  // so a `page` use after one of them is not stale.
  it('does not treat a read-only tabs call as a switch', () => {
    expect(
      staleHandleComplaint(
        entryWith(
          `    step.expect(tabs.list().length === 2, 'two tabs');\n` +
          `    await page.getByRole('heading').waitFor();`,
        ),
      ),
    ).toBeUndefined();
  });
});

describe('unwaitedReadComplaint', () => {
  const entryWith = (body: string) =>
    `{\n  source: 'x',\n  async run({ page, step }) {\n${body}\n  },\n}`;

  // The measured failure, verbatim from a generated entry: `#upload-status` is
  // one element that keeps the previous step's message, so the read lands
  // while the upload it asserts on is still in flight.
  it('complains about a read fed straight into step.expect', () => {
    const complaint = unwaitedReadComplaint(
      entryWith(
        `    await page.locator('#statement-upload').click();\n` +
        `    const message = (await page.locator('#upload-status').textContent())?.trim();\n` +
        `    step.expect(message === 'Uploaded logo.png', 'status');`,
      ),
    );
    expect(complaint).toMatch(/without ever waiting/);
    expect(complaint).toMatch(/hasText/);
  });

  // The trap that makes this worth a check rather than trusting the replay: a
  // bare `waitFor()` LOOKS like the wait and is not one. Its default state is
  // `visible`, which the status region already is.
  it('is not satisfied by a bare waitFor', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.locator('#statement-upload').click();\n` +
          `    const status = page.locator('#upload-status');\n` +
          `    await status.waitFor();\n` +
          `    step.expect((await status.textContent()) === 'Uploaded logo.png', 'status');`,
        ),
      ),
    ).toBeDefined();
  });

  // Nor by naming the state that is already the default.
  it('is not satisfied by waitFor({ state: "visible" })', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.locator('#statement-upload').click();\n` +
          `    await page.locator('#upload-status').waitFor({ state: 'visible' });\n` +
          `    step.expect((await page.locator('#upload-status').textContent()) === 'ok', 'status');`,
        ),
      ),
    ).toBeDefined();
  });

  // …and its read-only twin: with no action before the read there is nothing
  // the read could race (docs/specs/SPEC-codebehind-robustness.md §6.3).
  it('says nothing about the same read in an entry that takes no action', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.locator('#upload-status').waitFor({ state: 'visible' });\n` +
          `    step.expect((await page.locator('#upload-status').textContent()) === 'ok', 'status');`,
        ),
      ),
    ).toBeUndefined();
  });

  // Failure A of the robustness spec (§3.1), verbatim: the sign-in click's
  // entry read the title and a visibility 57 ms after the click, while the
  // login request was in flight, and passed on the page it was leaving.
  it("complains about failure A's sign-in entry: title() and isVisible() read straight after a click", () => {
    const complaint = unwaitedReadComplaint(
      entryWith(
        `    await page.locator('#sign-in-btn').click();\n` +
        `    const dashboard = (await page.title()).includes('Dashboard');\n` +
        `    const signInFormVisible = await page.locator('#email').isVisible();\n` +
        `    step.expect(\n` +
        `      dashboard || signInFormVisible,\n` +
        `      'Sign-in attempt reached the dashboard or left the sign-in form available',\n` +
        `    );`,
      ),
    );
    expect(complaint).toBeDefined();
    // It names the action, and says how to wait for a page the action leads to
    // without freezing one data row's URL into the code.
    expect(complaint).toContain('`.click(`');
    // §6.4 is in, so the advice is the wait on the entry's own watcher.
    expect(complaint).toContain('`await step.settle()` straight after it');
    expect(complaint).toMatch(/Never wait with a URL taken from one data row/);
  });

  it('accepts step.settle() as the wait after the action (§6.4)', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.locator('#sign-in-btn').click();\n` +
          `    await step.settle();\n` +
          `    step.expect((await page.title()).includes('Dashboard'), 'signed in');`,
        ),
      ),
    ).toBeUndefined();
  });

  // Failure B (§3.2): a capture that only reads. The check fired on it, the
  // re-ask rewrote it, and the selector the recording read with was lost.
  it("says nothing about failure B's read-only capture entry", () => {
    expect(
      unwaitedReadComplaint(
        `{\n  source: 'Read the name of every account in the Your accounts panel [store as: accounts]',\n` +
        `  async run({ page, step, log }) {\n` +
        `    const accountRows = page.locator('#account-list [data-testid="account-row"]');\n` +
        `    const accountNames = page\n` +
        `      .locator('#account-list [data-testid="account-row"] > span > span')\n` +
        `      .filter({ hasNotText: '$' });\n` +
        `    const accounts = (await accountNames.allTextContents()).map((name) => name.trim());\n` +
        `    const rowCount = await accountRows.count();\n` +
        `    step.setVar('accounts', JSON.stringify(accounts));\n` +
        `    step.expect(\n` +
        `      accounts.length === rowCount && accounts.every((name) => name.length > 0),\n` +
        `      'Read all populated account names from the Your accounts panel',\n` +
        `    );\n` +
        `  },\n}`,
      ),
    ).toBeUndefined();
  });

  it('says nothing about a read made BEFORE the action, with nothing read after it', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    const before = (await page.locator('#total').textContent())?.trim();\n` +
          `    await page.locator('#recalculate').click();\n` +
          `    step.expect(before !== '', 'a total was shown before recalculating');`,
        ),
      ),
    ).toBeUndefined();
  });

  it('counts a helper call as the action — it may click', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await signIn(page, step.getVar('username'));\n` +
          `    step.expect((await page.title()).includes('Dashboard'), 'signed in');`,
        ),
      ),
    ).toMatch(/`signIn\(`/);
  });

  it('accepts a text-filtered wait before the read', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.locator('#statement-upload').click();\n` +
          `    const status = page.locator('#upload-status', { hasText: 'Uploaded logo.png' });\n` +
          `    await status.waitFor();\n` +
          `    step.expect((await status.textContent())!.includes('logo.png'), 'status');`,
        ),
      ),
    ).toBeUndefined();
  });

  it('accepts a filter({ hasText }) wait', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.locator('#upload-status').filter({ hasText: 'Uploaded 2 files' }).waitFor();\n` +
          `    step.expect((await page.locator('#upload-status').textContent()) !== '', 'status');`,
        ),
      ),
    ).toBeUndefined();
  });

  it('accepts a waitForFunction, which covers what a text filter cannot', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.waitForFunction(() => document.querySelectorAll('#documents-body > tr').length === 4);\n` +
          `    step.expect((await page.locator('#documents-count').textContent()) === '4 documents', 'count');`,
        ),
      ),
    ).toBeUndefined();
  });

  // A transition state is a real wait — unlike `visible`, the element has to
  // actually change for it to resolve.
  it('accepts a wait for a transition state', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.locator('#spinner').waitFor({ state: 'hidden' });\n` +
          `    step.expect((await page.locator('#total').textContent()) === '$4.00', 'total');`,
        ),
      ),
    ).toBeUndefined();
  });

  // `goto` awaits the load event, so a navigate-then-read entry has settled.
  it('accepts a read after a navigation', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    await page.goto(new URL('documents.html', baseUrl).toString());\n` +
          `    step.expect((await page.locator('h1').textContent())?.includes('Documents'), 'heading');`,
        ),
      ),
    ).toBeUndefined();
  });

  it('says nothing about an entry that asserts on no page read', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    const count = step.getVar('document_count');\n` +
          `    step.expect(count === '4', 'document_count equals 4');`,
        ),
      ),
    ).toBeUndefined();
  });

  it('says nothing about a read with no assertion on it', () => {
    expect(
      unwaitedReadComplaint(
        entryWith(
          `    const name = (await page.locator('#account-name').textContent())?.trim();\n` +
          `    step.setVar('account_name', name ?? '');`,
        ),
      ),
    ).toBeUndefined();
  });

  // Ordering: the faults that throw or corrupt come first, and the caller
  // shares one re-ask between all of them.
  it('is reported after the faults that throw on replay', () => {
    const bothFaults =
      `{\n  source: 'x',\n  async run({ step }) {\n` +
      `    await page.locator('#statement-upload').click();\n` +
      `    const message = (await page.locator('#upload-status').textContent());\n` +
      `    step.expect(message === 'ok', 'status');\n  },\n}`;
    expect(undeclaredContextComplaint(bothFaults)).toMatch(/`page`/);
    expect(unwaitedReadComplaint(bothFaults)).toBeDefined();
  });

  it('leaves the read-only twin to the fault that throws', () => {
    const readOnly =
      `{\n  source: 'x',\n  async run({ step }) {\n` +
      `    const message = (await page.locator('#upload-status').textContent());\n` +
      `    step.expect(message === 'ok', 'status');\n  },\n}`;
    expect(undeclaredContextComplaint(readOnly)).toMatch(/`page`/);
    expect(unwaitedReadComplaint(readOnly)).toBeUndefined();
  });
});

describe('generateStepEntry', () => {
  it('takes a clean entry on the first answer — no re-ask, and no leak where the value is read by name', async () => {
    // What is under test is that nothing refuses it: the leak guard sees
    // `octocat` resolved and the code reading `username` instead, and no
    // complaint sends it back. The code itself is the stub's, so it is not
    // read back here.
    const { client, calls } = stubClient(JSON.stringify({
      entry: [
        `{`,
        `  source: 'Enter the username {{username}}',`,
        `  async run({ page, step }) {`,
        `    await page.locator('#login_field').fill(step.getVar('username'));`,
        `    await page.locator('#login_field').waitFor();`,
        `  },`,
        `}`,
      ].join('\n'),
    }));

    const result = await generateStepEntry({
      binding: bindingFor('Enter the username {{username}}'),
      actions: PASSING_ACTIONS,
      resolvedParameters: { username: 'octocat' },
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });

    expect(result.kind).toBe('entry');
    expect(calls).toHaveLength(1);
  });

  it('turns a model decline into a declined result carrying the reason', async () => {
    const { client } = stubClient(JSON.stringify({
      entry: null,
      reason: 'needs the operator to choose from a list',
    }));
    const result = await generateStepEntry({
      binding: bindingFor('Pick the right account'),
      actions: PASSING_ACTIONS,
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result).toEqual({ kind: 'declined', reason: 'needs the operator to choose from a list' });
  });

  it('refuses code that inlines a parameter value, and never calls it an entry', async () => {
    const { client } = stubClient(JSON.stringify({
      entry: `{ source: 'Enter the password {{password}}', async run({ page }) { await page.fill('#password', 'hunter2-correct-horse'); } }`,
    }));
    const result = await generateStepEntry({
      binding: bindingFor('Enter the password {{password}}'),
      actions: PASSING_ACTIONS,
      resolvedParameters: { password: 'hunter2-correct-horse' },
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/{{password}}/);
  });

  it('declines before the model call when the step can never be code', async () => {
    const { client, calls } = stubClient('should never be asked');
    const result = await generateStepEntry({
      binding: bindingFor('Ask the tester whether the letter arrived'),
      actions: [{ action: 'prompt', question: 'Did the letter arrive?' }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('declined');
    expect(calls).toHaveLength(0);
  });

  it('reports an unparseable response as an error rather than throwing', async () => {
    const { client } = stubClient('I am afraid I cannot do that.');
    const result = await generateStepEntry({
      binding: bindingFor('Click Sign in'),
      actions: PASSING_ACTIONS,
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('error');
  });

  it('resolves a skill-frame parameter through the frame scope before guarding it', async () => {
    const { client, calls } = stubClient(JSON.stringify({
      entry: `{ source: 'Sign in as {{username}}', async run({ page, step }) { await page.fill('#u', step.getVar('username')); } }`,
    }));
    const result = await generateStepEntry({
      binding: bindingFor('Sign in as {{username}}', {
        scope: { renames: {}, inputs: { username: 'alice-from-the-caller' } },
      }),
      actions: [{ action: 'type', selector: '#u', value: 'alice-from-the-caller' }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('entry');
    // The prompt was told the frame's value, so the guard covers it.
    expect(contentBlocksToText(calls[0]![1]!.content)).toContain('alice-from-the-caller');
  });
});

/**
 * A flow-control step whose CONDITION names a placeholder
 * (stories/step-flow-control.md, decisions 2 and 11, against
 * stories/placeholder-preserving-actions.md decision 5).
 *
 * The placeholder accounting asks "did the model NAME this reference in a
 * value-bearing field of a recorded action" — `value`, `filePath`, `url`,
 * `selector`, `expected`, `key`, a predicate `condition`. A flow-control step
 * records `return` or `noop`, and neither carries any of those, so every
 * reference it makes is unvouchable by construction and the step declined
 * permanently: `{{username}} appears in no recorded action`, written into an
 * `ai: true` entry a later compile never revisits. `If {{username}} is shown
 * then return` could not compile at all, which the handbook and the story both
 * say it can.
 *
 * The exemption has to be NARROW, which is why the last two cases are here: an
 * ordinary step with the same placeholder and the same unvouching actions is
 * still declined, and a flow-control entry that inlines the resolved value is
 * still rejected by the leak guard. That guard, not the accounting, is what
 * stops a value being frozen into code — and it is untouched.
 */
describe('generateStepEntry — a flow-control step that names a placeholder', () => {
  const FLOW_STEP = 'If {{username}} is shown then return';
  const EXIT_ENTRY = JSON.stringify({
    entry: [
      `{`,
      `  source: ${JSON.stringify(FLOW_STEP)},`,
      `  async run({ page, step }) {`,
      `    if (await page.getByText(step.getVar('username')).isVisible()) step.exit();`,
      `  },`,
      `}`,
    ].join('\n'),
  });

  /** The two shapes a judged condition records: it held, or it did not. */
  for (const action of [{ action: 'return' as const }, { action: 'noop' as const }]) {
    it(`compiles when the recorded action is "${action.action}"`, async () => {
      const { client, calls } = stubClient(EXIT_ENTRY);
      const result = await generateStepEntry({
        binding: bindingFor(FLOW_STEP),
        actions: [action],
        resolvedParameters: { username: 'octocat-the-first' },
        recordingCarriesPlaceholders: true,
        aiClient: client,
        contextContent: '',
        testName: 'demo',
      });

      // Not `declined`: the model was actually asked, and what came back is an
      // entry. Before the exemption this returned
      // `{ kind: 'declined', reason: '{{username}} appears in no recorded action' }`
      // without ever making the call.
      expect(result.kind).toBe('entry');
      expect(calls).toHaveLength(1);
      expect(result.kind === 'entry' && result.code).toContain('step.exit()');
      expect(result.kind === 'entry' && result.code).toContain("step.getVar('username')");
    });
  }

  it('still rejects an entry that inlines the resolved value', async () => {
    // The leak guard is a different mechanism to the accounting and the
    // exemption does not touch it: `guardedValues` still carries every
    // resolved parameter into `findInlinedParameterValue`. If it did not, the
    // exemption would be exactly the hole the accounting exists to close.
    const { client } = stubClient(JSON.stringify({
      entry: `{ source: ${JSON.stringify(FLOW_STEP)}, async run({ page, step }) { if (await page.getByText('octocat-the-first').isVisible()) step.exit(); } }`,
    }));
    const result = await generateStepEntry({
      binding: bindingFor(FLOW_STEP),
      actions: [{ action: 'return' }],
      resolvedParameters: { username: 'octocat-the-first' },
      recordingCarriesPlaceholders: true,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/{{username}}/);
  });

  it('declines an ORDINARY step with the same placeholder and the same actions', async () => {
    // The composition that proves the exemption is narrow. Same placeholder,
    // same unvouching actions, same recording — the only difference is that
    // this line does not claim the flow-control form, so the rule applies to
    // it exactly as it always did.
    const { client, calls } = stubClient('should never be asked');
    const result = await generateStepEntry({
      binding: bindingFor('Enter the username {{username}}'),
      actions: [{ action: 'noop' }],
      resolvedParameters: { username: 'octocat-the-first' },
      recordingCarriesPlaceholders: true,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result).toEqual({
      kind: 'declined',
      reason: '{{username}} appears in no recorded action',
    });
    expect(calls).toHaveLength(0);
  });
});

/**
 * The leak guard against a literal the AUTHOR quoted (decisions 3 and 10): a
 * literal the author wrote is theirs, so an entry echoing it is not freezing a
 * resolved value into a file — the guard is for the value the author never wrote
 * into the line, a password. Measured on `failure-outcomes-live.md`, where step
 * 9's only possible entry was discarded and the compile died with `Rounds: 0`.
 */
describe('generateStepEntry — a value the author quoted in the step', () => {
  const FAIL_ACTIONS = [{ action: 'fail' as const, description: 'the variable holds peanuts' }];

  /** The entry the live compile produced, by line and by the literal it inlines. */
  const entryFor = (source: string, literal: string) =>
    JSON.stringify({
      entry:
        `{\n  source: ${JSON.stringify(source)},\n  async run({ step }) {\n` +
        `    if (step.getVar('a') === ${JSON.stringify(literal)}) `
        + `step.fail('The variable value was peanuts. Expected apples');\n  },\n}`,
    });

  /** One generation for `source`, answered by `client`. */
  const generate = (
    source: string,
    client: AiClient,
    resolvedParameters: Record<string, string>,
    over: Partial<Parameters<typeof generateStepEntry>[0]> = {},
  ) =>
    generateStepEntry({
      binding: bindingFor(source),
      actions: FAIL_ACTIONS,
      resolvedParameters,
      recordingCarriesPlaceholders: true,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
      ...over,
    });

  it('accepts the entry that echoes it', async () => {
    const source =
      `If {{a}} is "peanuts" then fail the test with error ` +
      `"The variable value was peanuts. Expected apples"`;
    const { client, calls } = stubClient(entryFor(source, 'peanuts'));
    const result = await generate(source, client, { a: 'peanuts' });
    // Before the exemption this was `{ kind: 'error', message: '… contains the
    // resolved value of {{a}} …' }`, which `compileTest` treats as fatal.
    expect(result).toMatchObject({ kind: 'entry' });
    expect(result.kind === 'entry' && result.code).toContain(`step.getVar('a')`);
    expect(result.kind === 'entry' && result.code).toContain('peanuts');
    expect(calls).toHaveLength(1);
  });

  it('still rejects a password the author did not quote', async () => {
    // The case the guard exists for: nobody quotes the password in the line too.
    const source = 'Enter the password {{password}}';
    const { client } = stubClient(JSON.stringify({
      entry: `{ source: ${JSON.stringify(source)}, async run({ page }) { `
        + `await page.fill('#password', 'hunter2-correct-horse'); } }`,
    }));
    const result = await generate(source, client, { password: 'hunter2-correct-horse' }, {
      actions: PASSING_ACTIONS,
      recordingCarriesPlaceholders: false,
    });
    expect(result).toEqual({
      kind: 'error',
      message:
        'the generated code contains the resolved value of {{password}} as a literal, ' +
        'so it was discarded',
    });
  });

  /** Exact and case-sensitive, against the WHOLE quoted content: a value that
   *  merely resembles what the author quoted is one they never wrote. */
  for (const quoted of ['Peanuts', 'peanuts and more']) {
    it(`still rejects it when the line quotes "${quoted}"`, async () => {
      const source = `If {{a}} is "${quoted}" then fail the test with error "Not the right value"`;
      const { client } = stubClient(entryFor(source, 'peanuts'));
      const result = await generate(source, client, { a: 'peanuts' });
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.message).toContain('{{a}}');
    });
  }

  it('rejects a second parameter the line does not quote, in the same entry', async () => {
    // The composition that proves the exemption is per VALUE, not a switch on the
    // step: `{{a}}` is exempt, `{{username}}` is not, and the entry inlining both
    // is refused — naming the one that leaked.
    const source =
      `If {{a}} is "peanuts" then fail the test with error "Wrong value for {{username}}"`;
    const { client } = stubClient(JSON.stringify({
      entry: `{ source: ${JSON.stringify(source)}, async run({ step }) { `
        + `if (step.getVar('a') === 'peanuts') `
        + `step.fail('Wrong value for octocat-the-cat'); } }`,
    }));
    const result = await generate(source, client, { a: 'peanuts', username: 'octocat-the-cat' });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('{{username}}');
    expect(result.kind === 'error' && result.message).not.toContain('{{a}}');
  });
});

/**
 * The backstop as generation drives it: one re-ask, never two, and never worse
 * than the answer it already had
 * (stories/codebehind-selector-ambiguity.md, "The static backstop").
 */
describe('generateStepEntry — the static backstop', () => {
  const MEASURED = [
    {
      action: 'click' as const,
      selector: 'a[href="/login"]',
      targeting: {
        matchCount: 2,
        visibleMatchCount: 1,
        resolvedSelector: '#nav a[href="/login"]',
        resolvedBy: 'scoped' as const,
      },
    },
  ];
  const BARE =
    `{ source: 'Click Sign in', async run({ page }) { await page.locator('a[href="/login"]').click(); } }`;
  const FIXED =
    `{ source: 'Click Sign in', async run({ page }) { await page.locator('#nav a[href="/login"]').click(); } }`;

  const generate = (client: AiClient) =>
    generateStepEntry({
      binding: bindingFor('Click Sign in'),
      actions: MEASURED,
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });

  it('refuses a bare-selector entry, re-asks once, and takes the corrected one', async () => {
    const { client, calls } = stubSequence(
      JSON.stringify({ entry: BARE }),
      JSON.stringify({ entry: FIXED }),
    );
    const result = await generate(client);

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ kind: 'entry', code: FIXED });
    // The second ask is the first one plus the refusal and the refused entry.
    const retry = contentBlocksToText(calls[1]![1]!.content);
    expect(retry).toContain('## Your previous answer was refused');
    expect(retry).toContain('this run measured 2 elements');
    expect(retry).toContain(BARE);
  });

  it('does not spin when the second answer is bare too', async () => {
    const { client, calls } = stubSequence(JSON.stringify({ entry: BARE }));
    const result = await generate(client);
    // One re-ask, then take what you get: the entry may throw on replay, and
    // the replay round — or the next run's heal — is what deals with that. A
    // textual check cannot be allowed to fail the whole compile.
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ kind: 'entry', code: BARE });
  });

  it('keeps the first answer when the re-ask produces nothing usable', async () => {
    const { client, calls } = stubSequence(
      JSON.stringify({ entry: BARE }),
      'I am afraid I cannot do that.',
    );
    const result = await generate(client);
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ kind: 'entry', code: BARE });
  });

  it('never re-asks when the transcript carries no count', async () => {
    const { client, calls } = stubSequence(JSON.stringify({ entry: BARE }));
    const result = await generateStepEntry({
      binding: bindingFor('Click Sign in'),
      actions: [{ action: 'click', selector: 'a[href="/login"]' }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ kind: 'entry', code: BARE });
  });

  it('still guards the re-asked entry against an inlined parameter value', async () => {
    // The backstop must not become a way round the leak guard: the second
    // answer goes through `askForEntry` exactly as the first did, so a leak
    // in it is refused and the guarded first answer stands.
    const leaky =
      `{ source: 'Sign in as {{username}}', async run({ page }) { await page.fill('#u', 'octocat-the-cat'); } }`;
    const bare =
      `{ source: 'Sign in as {{username}}', async run({ page, step }) { await page.locator('a[href="/login"]').click(); await page.fill('#u', step.getVar('username')); } }`;
    const { client, calls } = stubSequence(
      JSON.stringify({ entry: bare }),
      JSON.stringify({ entry: leaky }),
    );
    const result = await generateStepEntry({
      binding: bindingFor('Sign in as {{username}}'),
      actions: MEASURED,
      resolvedParameters: { username: 'octocat-the-cat' },
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(calls).toHaveLength(2);
    // `toMatchObject`, not `toEqual`: the entry also carries the placeholder
    // rule's accounting for this step (this recording names no placeholder, so
    // the old value match applied — codebehind-placeholder-rule.test.ts).
    expect(result).toMatchObject({ kind: 'entry', code: bare });
    expect(result.kind === 'entry' && result.code).not.toContain('octocat-the-cat');
  });

  // The unwaited-read check shares that one re-ask. Driven through generation
  // rather than called directly, because the fault it catches only matters if
  // it is actually in the chain — the shape here is the measured failure from
  // `securebank-upload.md`, and it needs no `targeting` to fire.
  it('re-asks about a read that never waited, and takes the waiting answer', async () => {
    const racy =
      `{ source: 'Upload and check the status', async run({ page, step }) { ` +
      `await page.locator('#upload-btn').click(); ` +
      `const m = await page.locator('#upload-status').textContent(); ` +
      `step.expect(m === 'Uploaded logo.png', 'status'); } }`;
    const waiting =
      `{ source: 'Upload and check the status', async run({ page, step }) { ` +
      `await page.locator('#upload-btn').click(); ` +
      `const s = page.locator('#upload-status', { hasText: 'Uploaded logo.png' }); ` +
      `await s.waitFor(); step.expect((await s.textContent()) !== null, 'status'); } }`;
    const { client, calls } = stubSequence(
      JSON.stringify({ entry: racy }),
      JSON.stringify({ entry: waiting }),
    );
    const result = await generateStepEntry({
      binding: bindingFor('Upload and check the status'),
      actions: [
        { action: 'click', selector: '#upload-btn' },
        { action: 'read', selector: '#upload-status' },
      ],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(calls).toHaveLength(2);
    expect(contentBlocksToText(calls[1]![1]!.content)).toContain('without ever waiting');
    expect(result).toEqual({ kind: 'entry', code: waiting });
  });

  // The same read with no action before it is not re-asked
  // (docs/specs/SPEC-codebehind-robustness.md §6.3): it raced nothing, and the
  // re-ask is what rewrote failure B's selector.
  it('does not re-ask a read-only entry about waiting', async () => {
    const readOnly =
      `{ source: 'Assert the status', async run({ page, step }) { ` +
      `const m = await page.locator('#upload-status').textContent(); ` +
      `step.expect(m === 'Uploaded logo.png', 'status'); } }`;
    const { client, calls } = stubSequence(JSON.stringify({ entry: readOnly }));
    const result = await generateStepEntry({
      binding: bindingFor('Assert the status'),
      actions: [{ action: 'read', selector: '#upload-status' }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ kind: 'entry', code: readOnly });
  });
});

describe('aiEntryFor', () => {
  it('writes an ai: true entry with the reason as a comment', () => {
    const entry = aiEntryFor('Verify the dashboard looks right', 'needs a judgement code cannot make');
    expect(entry).toContain('ai: true');
    expect(entry).toContain('needs a judgement code cannot make');
    expect(entry).toContain(`source: "Verify the dashboard looks right"`);
  });

  it('keeps a multi-line reason on one line and cannot close the comment early', () => {
    const entry = aiEntryFor('X', 'line one\nline two */ still the reason');
    expect(entry.split('\n').filter((l) => l.includes('line two'))).toHaveLength(1);
    expect(entry).not.toContain('*/');
  });
});

describe('generateStepEntry — which dotted names the prompt masks (§7.6)', () => {
  /** Every message of the one call the stub recorded, as text. */
  const promptTextOf = (calls: ChatMessage[][]): string =>
    calls[0]!
      .map((m) => (typeof m.content === 'string' ? m.content : contentBlocksToText(m.content)))
      .join('\n');

  const source = 'Verify the row shows {{row.keyword}} for {{user.apikey}}';
  /** A live map: `row.keyword` is a pass's binding, `user.apikey` is a data
   *  file's heading merged in beside it. Same spelling, different owner. */
  function liveMap(): Record<string, string> {
    const map: Record<string, string> = { 'row.keyword': 'AU', 'user.apikey': 'uk_live_1234' };
    markLoopBindings(map, ['row.keyword']);
    return map;
  }

  it('tells a pass binding from an author heading by the map it is handed', async () => {
    const { client, calls } = stubClient(JSON.stringify({ entry: null, reason: 'not needed' }));
    const map = liveMap();
    await generateStepEntry({
      binding: bindingFor(source),
      actions: PASSING_ACTIONS,
      resolvedParameters: map,
      parameterMap: map,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    const text = promptTextOf(calls);
    expect(text).toContain('{{row.keyword}} resolved to "AU" on this run');
    expect(text).toContain('{{user.apikey}} resolved to "***" on this run');
    expect(text).not.toContain('uk_live_1234');
  });

  it('without the map reads every dotted name as a binding — which is what the map buys', async () => {
    // What a caller that passes no map gets. Neither compiler is one any more:
    // the boxed compile used to be, and it put a data file's `user.apikey`
    // heading into its prompts in clear once its values stopped arriving
    // pre-redacted (review round 2, F1). This twin states the cost.
    const { client, calls } = stubClient(JSON.stringify({ entry: null, reason: 'not needed' }));
    await generateStepEntry({
      binding: bindingFor(source),
      actions: PASSING_ACTIONS,
      resolvedParameters: liveMap(),
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    const text = promptTextOf(calls);
    expect(text).toContain('{{row.keyword}} resolved to "AU" on this run');
    expect(text).toContain('{{user.apikey}} resolved to "uk_live_1234" on this run');
  });

  it('is handed the map at every prompt site of both compilers', () => {
    // The live compiler hands over its `liveCompileSnapshot`, the boxed one its
    // `passSnapshots` fold — generation, the condition prompt, and the repairs
    // (review round 2, F1). No prompt shows a site that dropped it: each also
    // hands over a mask set built from the same map, which masks the heading's
    // value on its own (measured: the generation prompt above is the same with
    // and without the map once that set is passed). The map is the second line,
    // so a site losing it leaves every behaviour test green.
    //
    // Hence a count, as codebehind-live-compile.test.ts counts the snapshot
    // sites in session-manager.ts:
    // every place a compiler builds one of those prompts, and every map handed
    // over, independently — a site that drops it, or a new one added without
    // it, makes them disagree, and renaming the variable it passes does not.
    for (const file of ['compile.ts', 'live-compile.ts']) {
      const source = readFileSync(path.join(repoRoot, 'src', 'codebehind', file), 'utf8');
      const sites = source.match(/\bgenerate(?:Step|Condition)Entry\(|: RepairPromptInput = \{/g) ?? [];
      const maps = source.match(/^\s*parameterMap: /gm) ?? [];
      expect(sites.length, file).toBeGreaterThanOrEqual(3);
      expect(maps, file).toHaveLength(sites.length);
    }
  });
});

describe('buildRepairPrompt', () => {
  it('carries the entry, the error, the DOM and the screenshot', () => {
    const msg = buildRepairPrompt({
      rawStepText: 'Click Sign in',
      stepIndex: 5,
      entryCode: `{ source: 'Click Sign in', async run({ page }) { await page.click('#nope'); } }`,
      error: 'locator.click: Timeout 30000ms exceeded',
      dom: '<button id="signin">Sign in</button>',
      url: 'https://app.test/login',
      screenshotBase64: 'AAAA',
      parameters: [{ name: 'username', value: 'octocat' }],
      round: { number: 2, max: 3 },
    });
    const text = contentBlocksToText(msg.content);
    expect(text).toContain(`await page.click('#nope')`);
    expect(text).toContain('Timeout 30000ms exceeded');
    expect(text).toContain('<button id="signin">Sign in</button>');
    expect(text).toContain('https://app.test/login');
    expect(text).toContain('repair round 2 of 3');
    expect(text).toContain('{{username}} resolved to "octocat" on this run');
    // The screenshot rides as an image block, not as text.
    expect(Array.isArray(msg.content)).toBe(true);
    expect((msg.content as Array<{ type: string }>).some((b) => b.type === 'image_url')).toBe(true);
  });

  it('sends a plain text message when there is no screenshot', () => {
    const msg = buildRepairPrompt({
      rawStepText: 'x',
      stepIndex: 1,
      entryCode: '{}',
      error: 'boom',
      parameters: [],
    });
    expect(typeof msg.content).toBe('string');
  });
});

describe('the review envelope', () => {
  it('asks about frozen dates, post-conditions and binding fields', () => {
    const text = contentBlocksToText(
      buildFileReviewPrompt({
        markdownName: 'smoke.md',
        file: 'export default defineSteps([]);',
        steps: ['Navigate to the baseUrl'],
      }).content,
    );
    expect(text).toContain('computed at runtime, not frozen');
    expect(text).toContain('post-condition');
    expect(text).toContain('1. Navigate to the baseUrl');
    expect(text).toContain('"file"');
  });

  it('reads the revised file out of the {"file": ...} envelope', () => {
    const file = `import { defineSteps } from 'steptix/codebehind';\nexport default defineSteps([]);`;
    expect(parseFileRevision(JSON.stringify({ file }))).toBe(`${file}\n`);
  });

  it('decodes a double-escaped revision', () => {
    const escaped = `import { defineSteps } from 'x';\\nexport default defineSteps([]);`;
    const revised = parseFileRevision(JSON.stringify({ file: escaped }));
    expect(revised).toContain('\n');
    expect(revised).not.toContain('\\n');
  });

  it('refuses a revision that is not a code-behind file', () => {
    expect(() => parseFileRevision(JSON.stringify({ file: 'const x = 1;' }))).toThrow(/defineSteps/);
    expect(() => parseFileRevision('sorry, no')).toThrow(/no revised file|defineSteps/);
  });
});

/**
 * A name off `Object.prototype` is not a parameter (`boundValue`,
 * src/runner/placeholder-substitution.ts).
 *
 * `resolvedParameters[name]` is a bare index, so a step writing
 * `{{constructor}}` handed the generator the Object FUNCTION as a value: the
 * prompt rendered `resolved to undefined` (`JSON.stringify` of a function is
 * `undefined`), and the leak guard was then asked to look for a function's
 * text in the generated code. With a secret in scope the block's masker threw
 * first — the same `out.split is not a function` the step prompt died with.
 */
describe('stepParameters — a reference nothing binds', () => {
  const bindingFor = (source: string): CodeBehindBinding => ({
    file: '/x/t.steps.ts',
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
  });

  const binding = (name: string, value: string): Record<string, string> =>
    Object.defineProperty({}, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    }) as Record<string, string>;

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'renders {{%s}} when the map really binds it, and not otherwise',
    (name) => {
      const source = `Verify {{${name}}} is shown`;
      // Nothing binds it: the prototype must not answer for the map.
      expect(stepParameters(bindingFor(source), {}, undefined)).toEqual([]);
      // A `[store as: constructor]` capture IS a parameter, and dropping it
      // leaves the leak guard with nothing to look for — the literal then
      // lands in a committed file, which is the failure the guard exists for.
      expect(stepParameters(bindingFor(source), binding(name, 'ACME'), undefined)).toEqual([
        { name, value: 'ACME' },
      ]);
    },
  );

  it('does not let a RENAMED name reach through the prototype either', () => {
    const renamed: CodeBehindBinding = {
      file: '/x/t.steps.ts',
      source: 'Verify {{who}} is shown',
      occurrence: 0,
      scope: { renames: { who: 'toString' }, inputs: {} },
    };
    expect(stepParameters(renamed, {}, undefined)).toEqual([]);
  });
});
