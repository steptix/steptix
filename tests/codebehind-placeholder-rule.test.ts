import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import type { StepResult } from '../src/report/types.js';
import {
  accountPlaceholders,
  ambiguousSelectorComplaint,
  anyActionCarriesPlaceholder,
  generateStepEntry,
  placeholderNamesIn,
  unresolvedInputRefs,
} from '../src/codebehind/generate.js';
import {
  compileTest,
  type CompileEvent,
  type CompileRunOutcome,
  type CompileRunner,
} from '../src/codebehind/compile.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import type { RecordedAction } from '../src/codebehind/recording.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * The exact reference rule (stories/placeholder-preserving-actions.md,
 * decisions 5 and 6).
 *
 * A step compiles only when every reference its authored text makes appears —
 * AS A TOKEN, not as its value — in a value-bearing field of some recorded
 * action. What the model NAMED is the evidence, so `Dashboard` sitting in an
 * assertion's `expected` no longer vouches for a `{{outcome}}` column that
 * happens to read "Dashboard", and `Click the {{plan}} tab` compiles because
 * the recorded selector says `text={{plan}}`.
 *
 * Two carve-outs are tested as hard as the rule: a name the binding's SCOPE
 * supplies (a skill argument, a looped section's row) keeps the old value
 * match silently, because in phase 1 the expander bakes those into the body
 * text and no token can exist; and a recording made before the change — no
 * action names anything — is judged the old way for every step, with one
 * notice saying so.
 *
 * No model and no browser: the AI client is a stub, and every recording is
 * built by hand.
 */

/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

let counter = 0;
let dir: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-placeholder-rule');
});

beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

// ───────────────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────────────

/** An AI client that answers with each text in turn and records the prompts. */
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

/** A recorded action, with the `description` every action carries. */
function act(action: Partial<RecordedAction> & { action: AIAction['action'] }): RecordedAction {
  return { description: `did ${action.action}`, ...action } as RecordedAction;
}

/** Generation with the exact rule on, answering with an entry that reads the
 *  named variable — so a result of `entry` means the rule let the step past. */
async function generate(options: {
  source: string;
  actions: RecordedAction[];
  parameters?: Record<string, string>;
  binding?: Partial<CodeBehindBinding>;
  recordingCarriesPlaceholders?: boolean;
  entry?: string;
}): Promise<{ result: Awaited<ReturnType<typeof generateStepEntry>>; calls: number }> {
  const entry =
    options.entry ??
    `{ source: ${JSON.stringify(options.source)}, async run({ page, step }) { await page.locator('#f').fill(String(step.getVar('x'))); } }`;
  const { client, calls } = stubSequence(JSON.stringify({ entry }));
  const result = await generateStepEntry({
    binding: bindingFor(options.source, options.binding ?? {}),
    actions: options.actions,
    resolvedParameters: options.parameters ?? {},
    recordingCarriesPlaceholders: options.recordingCarriesPlaceholders ?? true,
    aiClient: client,
    contextContent: '',
    testName: 'demo',
  });
  return { result, calls: calls.length };
}

// ───────────────────────────────────────────────────────────────────────────
// Reading the references out of a step
// ───────────────────────────────────────────────────────────────────────────

describe('placeholderNamesIn', () => {
  it('reads the wider grammar the model can write, deduped and in order', () => {
    expect(placeholderNamesIn('Enter {{email}} then {{ password }} and {{email}} again')).toEqual([
      'email',
      'password',
    ]);
  });

  it('leaves a capture DEFINITION out — nothing holds that value yet', () => {
    // `store as {{balance}}` names a variable the step writes. Reading it as a
    // reference would decline every capture step, which is decision 4's point.
    expect(placeholderNamesIn('Read the balance and store as {{balance}}')).toEqual([]);
    expect(placeholderNamesIn('Read {{account}} and save as: {{balance}}')).toEqual(['account']);
  });
});

describe('anyActionCarriesPlaceholder', () => {
  it('is true for a token in any field and false for a recording of values', () => {
    expect(anyActionCarriesPlaceholder([act({ action: 'type', value: '{{email}}' })])).toBe(true);
    expect(anyActionCarriesPlaceholder([act({ action: 'navigate', url: '${data.url}' })])).toBe(true);
    expect(anyActionCarriesPlaceholder([act({ action: 'type', value: 'demo@bank.test' })])).toBe(
      false,
    );
    // A pre-change recording of a secret step: the value is already `***`.
    expect(anyActionCarriesPlaceholder([act({ action: 'type', value: '***' })])).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The exact rule
// ───────────────────────────────────────────────────────────────────────────

describe('a reference the model named', () => {
  it('compiles when the token is in `value`', async () => {
    const { result, calls } = await generate({
      source: 'Enter the email {{email}}',
      actions: [act({ action: 'type', selector: '#email', value: '{{email}}' })],
      parameters: { email: 'demo@securebank.com' },
    });
    expect(result.kind).toBe('entry');
    expect(calls).toBe(1);
    expect(result.kind === 'entry' && result.references).toBeUndefined();
  });

  it('compiles when the token is in `expected` — a per-row expectation', async () => {
    const { result } = await generate({
      source: 'Verify the total is {{expected_total}}',
      actions: [
        act({
          action: 'assert',
          selector: '#total',
          condition: 'the total is {{expected_total}}',
          expected: '{{expected_total}}',
        }),
      ],
      parameters: { expected_total: '£42.00' },
    });
    expect(result.kind).toBe('entry');
  });

  it('compiles when the token is in a PREDICATE condition', async () => {
    // The one free-text field that is value-bearing: a predicate compares
    // values rather than reporting the model's reading of the page.
    const { result } = await generate({
      source: 'Assert that {{order_count}} is at least 5',
      actions: [
        act({
          action: 'assert',
          against: 'predicate',
          condition: '{{order_count}} is at least 5',
        }),
      ],
      parameters: { order_count: '7' },
    });
    expect(result.kind).toBe('entry');
  });

  it('compiles a placeholder-bearing SELECTOR — the rows story\'s open cost', async () => {
    const { result } = await generate({
      source: 'Click the {{plan}} tab',
      actions: [
        act({
          action: 'click',
          selector: 'text={{plan}}',
          targeting: { matchCount: 1, resolvedSelector: 'a[href="plans/premium.html"]' } as never,
        }),
      ],
      parameters: { plan: 'Premium' },
      entry: `{ source: 'Click the {{plan}} tab', async run({ page, step }) { await page.locator(\`text=\${step.getVar('plan')}\`).click(); } }`,
    });
    expect(result.kind).toBe('entry');
  });

  it('compiles when the token is in a nested api_call body or a header', async () => {
    const { result } = await generate({
      source: 'Post the order for {{customer}} with {{token}}',
      actions: [
        act({
          action: 'api_call',
          url: '/api/orders',
          method: 'POST',
          body: { order: { lines: ['{{customer}}'] } },
          apiHeaders: { Authorization: 'Bearer {{token}}' },
        }),
      ],
      parameters: { customer: 'Ada Lovelace', token: 'tok_live_123' },
    });
    expect(result.kind).toBe('entry');
  });
});

describe('a reference the model interpreted instead', () => {
  it('declines when the token is only in a non-predicate condition, naming the field', async () => {
    // `Verify {{outcome}}` — the column reads "the Dashboard page is shown".
    // Nothing about that sentence is a value, so the model could only put it
    // where its own reading of the page goes.
    const { result, calls } = await generate({
      source: 'Verify {{outcome}}',
      actions: [
        act({
          action: 'assert',
          selector: 'h1',
          condition: 'the page shows {{outcome}}',
          expected: 'Dashboard',
        }),
      ],
      parameters: { outcome: 'the Dashboard page is shown' },
    });
    expect(result).toEqual({
      kind: 'declined',
      reason:
        "{{outcome}} appears only in an assertion's condition, which is interpreted at run time " +
        'and cannot be compiled',
    });
    // Declined BEFORE the model call — the compiler never pays for an answer
    // it would throw away.
    expect(calls).toBe(0);
  });

  it('declines when the token is only in an action description', async () => {
    const { result } = await generate({
      source: 'Verify {{outcome}}',
      actions: [
        act({ action: 'click', selector: '#go', description: 'clicked through to {{outcome}}' }),
      ],
      parameters: { outcome: 'the banner is shown' },
    });
    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toMatch(
      /\{\{outcome\}\} appears only in an action's description/,
    );
  });

  it('declines when the token is nowhere and no literal matches', async () => {
    const { result, calls } = await generate({
      source: 'Verify {{outcome}}',
      actions: [act({ action: 'assert', selector: 'h1', expected: 'Welcome back' })],
      parameters: { outcome: 'the Dashboard page is shown' },
    });
    expect(result).toEqual({
      kind: 'declined',
      reason: '{{outcome}} appears in no recorded action',
    });
    expect(calls).toBe(0);
  });

  it('names the ONE unaccounted reference when the step makes two', async () => {
    const { result } = await generate({
      source: 'Enter {{email}} and verify {{outcome}}',
      actions: [
        act({ action: 'type', selector: '#email', value: '{{email}}' }),
        act({ action: 'assert', selector: 'h1', expected: 'Dashboard' }),
      ],
      parameters: { email: 'demo@securebank.com', outcome: 'the Dashboard page is shown' },
    });
    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toBe(
      '{{outcome}} appears in no recorded action',
    );
  });

  it('does not let an exploration action vouch', async () => {
    // `find` and `expand` are in the transcript and nothing replayable carries
    // them, so a token in one proves nothing about what the step DID.
    const { result } = await generate({
      source: 'Click the {{plan}} tab',
      actions: [
        act({ action: 'find', value: '{{plan}}', selector: 'text={{plan}}' }),
        act({ action: 'expand', selector: '#plans-{{plan}}' }),
        act({ action: 'click', selector: '#chosen' }),
      ],
      parameters: { plan: 'Premium' },
    });
    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toBe(
      '{{plan}} appears in no recorded action',
    );
  });
});

describe('the value-match fallback, and its warning', () => {
  it('compiles with a warning when a recorded literal equals the value', async () => {
    const { result } = await generate({
      source: 'Enter the email {{email}}',
      actions: [act({ action: 'type', selector: '#email', value: 'demo@securebank.com' })],
      parameters: { email: 'demo@securebank.com' },
      entry: `{ source: 'Enter the email {{email}}', async run({ page, step }) { await page.fill('#email', String(step.getVar('email'))); } }`,
    });
    expect(result.kind).toBe('entry');
    expect(result.kind === 'entry' && result.references).toEqual({
      recoveredByValue: ['email'],
      preChangeFallback: false,
    });
  });

  it('reports the Dashboard coincidence rather than compiling it silently', async () => {
    // `expected: "Dashboard"` and an `outcome` column that reads "Dashboard".
    // The old rule excluded assert fields precisely because this looks like a
    // match; the new one lets it through as a RECOVERY, which is counted and
    // warned about, never a silent compile.
    const { result } = await generate({
      source: 'Verify {{outcome}}',
      actions: [act({ action: 'assert', selector: 'h1', expected: 'Dashboard' })],
      parameters: { outcome: 'Dashboard' },
      entry: `{ source: 'Verify {{outcome}}', async run({ page, step }) { step.expect((await page.locator('h1').textContent()) === step.getVar('outcome')); } }`,
    });
    expect(result.kind).toBe('entry');
    expect(result.kind === 'entry' && result.references?.recoveredByValue).toEqual(['outcome']);
  });

  it('will not vouch on a value shorter than the guard\'s floor', async () => {
    const { result } = await generate({
      source: 'Enter the code {{code}}',
      actions: [act({ action: 'type', selector: '#code', value: 'ok' })],
      parameters: { code: 'ok' },
    });
    expect(result.kind).toBe('declined');
  });
});

describe('the scope carve-out (decision 6)', () => {
  it('recovers a SKILL parameter by value with no warning at all', async () => {
    // The expander interpolated the caller's argument into the body text, so
    // the runtime never saw a placeholder and the model could not have named
    // one. Warning here would drown the measurement in cases nobody can act on.
    const { result } = await generate({
      source: 'Sign in as {{username}}',
      binding: { scope: { renames: {}, inputs: { username: 'alice-from-the-caller' } } },
      actions: [act({ action: 'type', selector: '#u', value: 'alice-from-the-caller' })],
      entry: `{ source: 'Sign in as {{username}}', async run({ page, step }) { await page.fill('#u', String(step.getVar('username'))); } }`,
    });
    expect(result.kind).toBe('entry');
    expect(result.kind === 'entry' && result.references).toBeUndefined();
  });

  it('never declines a scope-supplied name, however the recording reads', async () => {
    const { result } = await generate({
      source: 'Upload file {{file}}',
      binding: { scope: { renames: {}, inputs: { file: 'logo.png' } } },
      // A row value the model interpreted away entirely: under the exact rule
      // this would decline, and until phase 2 that would be a false positive.
      actions: [act({ action: 'click', selector: '#upload' })],
      entry: `{ source: 'Upload file {{file}}', async run({ page, step }) { await page.locator('#f').setInputFiles(step.filePath(String(step.getVar('file')))); } }`,
    });
    expect(result.kind).toBe('entry');
  });

  it('holds a skill RENAME to the exact rule, under its run-time name', async () => {
    // A rename is not a carve-out: the expander rewrote the step text to
    // `{{__skill1_username}}` and the RUNTIME substitutes that, so the model
    // is shown a placeholder and can name it. The reason names the authored
    // name, which is what the author wrote.
    const named = await generate({
      source: 'Sign in as {{username}}',
      binding: { scope: { renames: { username: '__skill1_username' }, inputs: {} } },
      actions: [act({ action: 'type', selector: '#u', value: '{{__skill1_username}}' })],
      parameters: { __skill1_username: 'alice' },
      entry: `{ source: 'Sign in as {{username}}', async run({ page, step }) { await page.fill('#u', String(step.getVar('username'))); } }`,
    });
    expect(named.result.kind).toBe('entry');

    const silent = await generate({
      source: 'Sign in as {{username}}',
      binding: { scope: { renames: { username: '__skill1_username' }, inputs: {} } },
      actions: [act({ action: 'click', selector: '#go' })],
      parameters: { __skill1_username: 'alice' },
    });
    expect(silent.result.kind).toBe('declined');
    expect(silent.result.kind === 'declined' && silent.result.reason).toBe(
      '{{username}} appears in no recorded action',
    );
  });
});

describe('a pre-change recording', () => {
  it('keeps the old rule for every step and says so once', async () => {
    const { result } = await generate({
      source: 'Enter the password {{password}}',
      // What a recording made before this change holds for a secret step.
      actions: [act({ action: 'type', selector: '#password', value: '***' })],
      parameters: { password: 'hunter2-correct-horse' },
      recordingCarriesPlaceholders: false,
      entry: `{ source: 'Enter the password {{password}}', async run({ page, step }) { await page.fill('#password', String(step.getVar('password'))); } }`,
    });
    expect(result.kind).toBe('entry');
    expect(result.kind === 'entry' && result.references).toEqual({
      // No warning: the recovery is not the model's failure to comply, it is
      // a recording that could not have complied.
      recoveredByValue: [],
      preChangeFallback: true,
    });
  });

  it('flags nothing for a step that references nothing', async () => {
    const { result } = await generate({
      source: 'Click Sign in',
      actions: [act({ action: 'click', selector: '#signin' })],
      recordingCarriesPlaceholders: false,
      entry: `{ source: 'Click Sign in', async run({ page }) { await page.locator('#signin').click(); } }`,
    });
    expect(result.kind === 'entry' && result.references).toBeUndefined();
  });
});

describe('accountPlaceholders — the rule on its own', () => {
  it('answers for an environment reference the same way', () => {
    const envData = { envName: 'ci', data: { url: 'https://app.test' } } as never;
    const named = accountPlaceholders({
      binding: bindingFor('Go to ${data.url}'),
      actions: [act({ action: 'navigate', url: '${data.url}' })],
      resolvedParameters: {},
      envData,
      recordingCarriesPlaceholders: true,
    });
    expect(named).toEqual({ recoveredByValue: [], preChangeFallback: false });

    const unnamed = accountPlaceholders({
      binding: bindingFor('Go to ${data.url}'),
      actions: [act({ action: 'navigate', url: 'https://app.test' })],
      resolvedParameters: {},
      envData,
      recordingCarriesPlaceholders: true,
    });
    expect(unnamed.recoveredByValue).toEqual(['${data.url}']);
    expect(unnamed.decline).toBeUndefined();
  });
});

/**
 * A `For each` pass's dotted binding, through the same rule
 * (docs/specs/SPEC-structured-table-reads.md §9.3).
 *
 * The rule's failure direction is the model freezing a resolved VALUE into
 * generated source. A dotted reference is the sharpest case of that — the
 * value is one row of one pass and the file is committed and re-run for years
 * — so the accounting has to read `{{order.id}}` as ONE reference to the
 * runtime binding. Read as an unknown root, or not read at all, the step
 * either declines forever or compiles with row 1's order number baked in.
 */
describe('a dotted reference to a For each binding', () => {
  it('is one reference, not a root plus stray text', () => {
    expect(
      placeholderNamesIn('Verify the row for "{{order.id}}" shows "{{order.status}}"'),
    ).toEqual(['order.id', 'order.status']);
    // `{{order}}` and `{{order.id}}` are different references to the same row,
    // and both are accounted for.
    expect(placeholderNamesIn('Print {{order}} then {{order.id}}')).toEqual([
      'order',
      'order.id',
    ]);
  });

  it('compiles when the model named the dotted token', () => {
    const accounting = accountPlaceholders({
      binding: bindingFor('Click Review in the row for "{{order.id}}"'),
      actions: [act({ action: 'click', selector: 'tr:has-text("{{order.id}}") button' })],
      // The dotted key is what the pass wrote into the live map, so it is
      // what the accounting looks the value up by.
      resolvedParameters: { 'order.id': 'ORD-1001' },
      recordingCarriesPlaceholders: true,
    });
    expect(accounting).toEqual({ recoveredByValue: [], preChangeFallback: false });
  });

  it('declines — and names the dotted reference — when the model inlined the row', () => {
    const accounting = accountPlaceholders({
      binding: bindingFor('Click Review in the row for "{{order.id}}"'),
      // The model wrote THIS pass's order number instead of the placeholder.
      actions: [act({ action: 'click', selector: 'tr:has-text("ORD-1001") button' })],
      resolvedParameters: { 'order.id': 'ORD-1001' },
      recordingCarriesPlaceholders: true,
    });
    // The value-match fallback is exact-whole-field, so a row number buried in
    // a selector does not recover it — the step declines, and the reason names
    // the DOTTED reference rather than an `order` nobody wrote. Which is the
    // right answer twice over: a selector built from one pass's order number
    // is precisely what a loop body must not compile to.
    expect(accounting.decline).toBe('{{order.id}} appears in no recorded action');
    expect(accounting.recoveredByValue).toEqual([]);
  });

  it('recovers by value when the whole field IS the row value', () => {
    const accounting = accountPlaceholders({
      binding: bindingFor('Type the order number {{order.id}}'),
      actions: [act({ action: 'type', selector: '#q', value: 'ORD-1001' })],
      resolvedParameters: { 'order.id': 'ORD-1001' },
      recordingCarriesPlaceholders: true,
    });
    expect(accounting.recoveredByValue).toEqual(['order.id']);
    expect(accounting.decline).toBeUndefined();
  });

  it('declines when a dotted reference landed only in a description', () => {
    const accounting = accountPlaceholders({
      binding: bindingFor('Click Review in the row for "{{order.id}}"'),
      actions: [
        act({
          action: 'click',
          selector: '#review',
          description: 'review the row for {{order.id}}',
        }),
      ],
      resolvedParameters: { 'order.id': 'ORD-1001' },
      recordingCarriesPlaceholders: true,
    });
    expect(accounting.decline).toBe(
      "{{order.id}} appears only in an action's description, which is the model's own words rather than a value it used",
    );
  });
});

/**
 * §9.2: `readTable` is deterministic and is MEANT to compile, through the
 * shared `tables.read` helper — which is phase 3. Until then it stays AI, and
 * the entry says why rather than a compile reinventing header mapping.
 */
describe('readTable is AI-only until phase 3', () => {
  it('refuses the step and names the action', async () => {
    const { result, calls } = await generate({
      source: 'Read the Order ID column as id from every row in the Orders table [store as: o]',
      actions: [act({ action: 'readTable', selector: '#orders' })],
    });
    // `declined` is how a step becomes an `ai: true` entry carrying its reason.
    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('readTable');
    // No model call was paid for an answer that would be thrown away —
    // `refuseReason` runs before the client is touched.
    expect(calls).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The static backstop
// ───────────────────────────────────────────────────────────────────────────

describe('ambiguousSelectorComplaint with a placeholder-bearing selector', () => {
  const AMBIGUOUS: RecordedAction[] = [
    act({
      action: 'click',
      selector: 'text={{plan}}',
      targeting: { matchCount: 3, resolvedSelector: 'a[href="plans/premium.html"]' } as never,
    }),
  ];
  const substitute = (text: string): string => text.replace(/\{\{\s*plan\s*\}\}/g, 'Premium');

  it('sees the SUBSTITUTED selector the entry actually inlined', () => {
    const code = `{ async run({ page }) { await page.click('text=Premium'); } }`;
    expect(ambiguousSelectorComplaint(code, AMBIGUOUS, substitute)).toMatch(/measured 3 elements/);
    // Without the substitution the check is blind on exactly the steps
    // placeholders were introduced for.
    expect(ambiguousSelectorComplaint(code, AMBIGUOUS)).toBeUndefined();
  });

  it('still sees the recorded spelling, and still leaves a narrowed use alone', () => {
    expect(
      ambiguousSelectorComplaint(
        `{ async run({ page, step }) { await page.locator('text={{plan}}').click(); } }`,
        AMBIGUOUS,
        substitute,
      ),
    ).toMatch(/measured 3 elements/);
    expect(
      ambiguousSelectorComplaint(
        `{ async run({ page }) { await page.locator('text=Premium').first().click(); } }`,
        AMBIGUOUS,
        substitute,
      ),
    ).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Through the compile pipeline
// ───────────────────────────────────────────────────────────────────────────

const CONFIG: Config = { ...DEFAULT_CONFIG };
const REVIEW_NOOP = '<<review: echo the file back>>';

function scriptedClient(responses: string[]): AiClient {
  return {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1];
      const prompt =
        typeof last?.content === 'string'
          ? last.content
          : (last?.content ?? []).map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
      const text = responses.shift();
      if (text === undefined) throw new Error('AI called more times than the test scripted');
      if (text === REVIEW_NOOP) {
        const file = /```ts\n([\s\S]*?)```/.exec(prompt)?.[1];
        if (!file) throw new Error('review prompt carried no file to echo');
        return { text: JSON.stringify({ file }), model: 'stub-model' };
      }
      return { text, model: 'stub-model' };
    },
  } as unknown as AiClient;
}

function entryEnvelope(source: string, body: string): string {
  return JSON.stringify({
    entry: `{\n  source: ${JSON.stringify(source)},\n  async run({ page, step, log }) {\n    ${body}\n  },\n}`,
  });
}

function stepWith(index: number, actions: RecordedAction[]): StepResult {
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
        subActions: actions.map((action, i) => ({ index: i + 1, action, durationMs: 5 })),
      },
    ],
    durationMs: 10,
    retried: false,
    pageUrl: 'https://app.test/login',
    stepContext: {
      domBefore: '<form></form>',
      urlBefore: 'https://app.test/login',
      domAfter: '<form></form>',
      urlAfter: 'https://app.test/login',
    },
  };
}

/** Records the supplied outcome, then replays green. */
function runnerFor(record: CompileRunOutcome, totalSteps: number): CompileRunner {
  return async (request) => {
    if (request.purpose === 'record') return record;
    return {
      status: 'passed',
      steps: Array.from({ length: totalSteps }, (_, i) =>
        stepWith(i + 1, [act({ action: 'click', selector: '#x' })]),
      ),
      resolvedParameters: record.resolvedParameters,
      tokensUsed: 0,
    };
  };
}

const MATRIX_MD = [
  '# Sign in',
  '',
  '## Parameters',
  '- email: demo@securebank.com',
  '- password: hunter2-correct-horse',
  '',
  '## Steps',
  '1. Enter the email {{email}}',
  '2. Enter the password {{password}}',
].join('\n');

describe('the compile summary carries the compliance count', () => {
  it('counts each recovery, names it, and puts the total in the headline', async () => {
    const md = path.join(dir, 'signin.md');
    await fs.writeFile(md, MATRIX_MD, 'utf-8');
    const test = await parseTestFile(md);
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [
        // Step 1 names its placeholder — which is also what makes this a
        // post-change recording for the whole run.
        stepWith(1, [act({ action: 'type', selector: '#email', value: '{{email}}' })]),
        // Step 2 did not: the value is there instead, so it is recovered and
        // counted.
        stepWith(2, [
          act({ action: 'type', selector: '#password', value: 'hunter2-correct-horse' }),
        ]),
      ],
      resolvedParameters: {
        email: 'demo@securebank.com',
        password: 'hunter2-correct-horse',
      },
      tokensUsed: 0,
    };
    const events: CompileEvent[] = [];
    const result = await compileTest({
      test,
      config: CONFIG,
      contextContent: '',
      aiClient: scriptedClient([
        entryEnvelope(
          'Enter the email {{email}}',
          `await page.locator('#email').fill(String(step.getVar('email')));`,
        ),
        entryEnvelope(
          'Enter the password {{password}}',
          `await page.locator('#password').fill(String(step.getVar('password')));`,
        ),
        REVIEW_NOOP,
      ]),
      runner: runnerFor(record, 2),
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('green');
    expect(result.summary.recoveredByValue).toEqual([{ step: 2, name: 'password' }]);
    const done = events.find((e) => e.kind === 'done');
    expect(done && done.kind === 'done' && done.message).toContain('1 recovered by value match');
    // …and the author is told which step, in the words the metric uses.
    expect(
      events.some(
        (e) =>
          e.kind === 'note' &&
          e.level === 'warn' &&
          e.message.includes('recovered {{password}} by value match; the model did not name it'),
      ),
    ).toBe(true);
    // No pre-change notice: step 1 proved this recording is a post-change one.
    expect(events.some((e) => e.kind === 'note' && e.message.includes('predates'))).toBe(false);
  });

  it('says once that a pre-change recording was judged the old way', async () => {
    const md = path.join(dir, 'signin.md');
    await fs.writeFile(md, MATRIX_MD, 'utf-8');
    const test = await parseTestFile(md);
    const record: CompileRunOutcome = {
      status: 'passed',
      steps: [
        stepWith(1, [act({ action: 'type', selector: '#email', value: 'demo@securebank.com' })]),
        // The secret is already redacted, which is why the old rule has to
        // stand for the whole recording rather than decline this step.
        stepWith(2, [act({ action: 'type', selector: '#password', value: '***' })]),
      ],
      resolvedParameters: {
        email: 'demo@securebank.com',
        password: 'hunter2-correct-horse',
      },
      tokensUsed: 0,
    };
    const events: CompileEvent[] = [];
    const result = await compileTest({
      test,
      config: CONFIG,
      contextContent: '',
      aiClient: scriptedClient([
        entryEnvelope(
          'Enter the email {{email}}',
          `await page.locator('#email').fill(String(step.getVar('email')));`,
        ),
        entryEnvelope(
          'Enter the password {{password}}',
          `await page.locator('#password').fill(String(step.getVar('password')));`,
        ),
        REVIEW_NOOP,
      ]),
      runner: runnerFor(record, 2),
      onEvent: (e) => events.push(e),
    });

    // Both steps compiled — the old rule declines nothing over a token.
    expect(result.status).toBe('green');
    expect(result.summary.compiled).toBe(2);
    expect(result.summary.recoveredByValue).toEqual([]);
    const notices = events.filter(
      (e) => e.kind === 'note' && e.message.includes('predates placeholder-preserving actions'),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0] && notices[0].kind === 'note' && notices[0].level).toBe('info');
  });
});

/**
 * The compiler's two remaining bare reads of a binding's scope.
 *
 * `binding.scope.renames[name]` and `binding.scope.inputs[name]` are
 * plain-object indexes, and `{{constructor}}` answers off `Object.prototype`
 * on a scope that renames and inputs nothing. `stepParameters` was taught this
 * in review 4; these two were not, and each turns the function's answer into a
 * different wrong one:
 *
 * - `accountPlaceholders` takes the rename branch, so the TOKEN it looks for
 *   in the recorded actions is the `Object` function — which no recorded
 *   string can equal — and a step that named its placeholder perfectly well
 *   declines with "appears in no recorded action" forever.
 * - `unresolvedInputRefs` takes the same branch and returns BEFORE looking at
 *   the input, so a caller argument this run cannot resolve is reported as
 *   resolved, and `generateStepEntry` compiles the literal `${data.username}`
 *   text into a committed file instead of declining.
 */
describe('a scope read for a reference named after a prototype key', () => {
  it('accounts for {{constructor}} against the token the model actually wrote', () => {
    const accounting = accountPlaceholders({
      binding: bindingFor('Type {{constructor}} into the search box'),
      // The model did the right thing: it wrote the placeholder back.
      actions: [act({ action: 'type', selector: '#q', value: '{{constructor}}' })],
      // A `[store as: constructor]` capture — an own property of the map.
      resolvedParameters: { constructor: 'ORD-1001' },
      recordingCarriesPlaceholders: true,
    });
    expect(accounting.decline).toBeUndefined();
    expect(accounting.recoveredByValue).toEqual([]);
  });

  it('judges {{constructor}} instead of waving it through as expander-supplied', () => {
    // Decision 6's carve-out is for a name the SCOPE supplies, and this scope
    // supplies nothing: `inputs['constructor']` is the `Object` function, not
    // an argument. Read bare, the carve-out fired, the reference was never
    // judged at all, and a step whose model had inlined the value compiled
    // with it frozen in — silently, since a skipped reference produces no
    // decline and no warning.
    const accounting = accountPlaceholders({
      binding: bindingFor('Type {{constructor}} into the search box'),
      actions: [act({ action: 'type', selector: '#q', value: 'something else' })],
      resolvedParameters: { constructor: 'ORD-1001' },
      recordingCarriesPlaceholders: true,
    });
    expect(accounting.decline).toBe('{{constructor}} appears in no recorded action');
  });

  it('declines, rather than THROWING, when a rename targets a prototype key', () => {
    // A skill output the caller aliased onto `constructor`, with nothing bound
    // to it yet. The value lookup is `resolvedParameters[renamed]`, so bare it
    // handed `value?.trim()` the `Object` function and the compile died on
    // `value.trim is not a function` — a TypeError out of a pre-check, in
    // place of the ordinary decline the author can read.
    const binding = bindingFor('Type {{who}} into the search box', {
      scope: { renames: { who: 'constructor' }, inputs: {} },
    });
    let accounting: ReturnType<typeof accountPlaceholders> | undefined;
    expect(() => {
      accounting = accountPlaceholders({
        binding,
        // The model inlined something else, so the judge reaches the
        // value-match fallback — which is where the value is read.
        actions: [act({ action: 'type', selector: '#q', value: 'something else' })],
        resolvedParameters: {},
        recordingCarriesPlaceholders: true,
      });
    }).not.toThrow();
    // Named by the AUTHORED spelling, which is what the author wrote.
    expect(accounting!.decline).toBe('{{who}} appears in no recorded action');
  });

  it('reports an unresolvable caller argument bound to a prototype-key name', () => {
    // `[skill: login constructor="${data.username}"]` in a run with no
    // environment. The argument is in the frame's `inputs`, raw.
    const binding = bindingFor('Sign in as {{constructor}}', {
      scope: { renames: {}, inputs: { constructor: '${data.username}' } },
    });
    expect(unresolvedInputRefs(binding, {}, undefined)).toEqual(['data.username']);
    // And with an environment that answers it, nothing is unresolved.
    expect(
      unresolvedInputRefs(binding, {}, { envName: 'ci', data: { username: 'alice' } } as never),
    ).toEqual([]);

    // The other half: a scope that supplies NOTHING. Bare, the inputs map
    // answered with the `Object` function, which `interpolate` then called
    // `.replace` on — `text.replace is not a function`, thrown out of a
    // pre-check that is supposed to return a list.
    expect(unresolvedInputRefs(bindingFor('Sign in as {{constructor}}'), {}, undefined)).toEqual([]);
  });
});
