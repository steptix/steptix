import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import { buildStepCodePrompt, RECORDED_CAPTURE_RULE } from '../src/ai/prompts.js';
import {
  capturedValueGuards,
  generateStepEntry,
  recordedCapturesOf,
  type GuardedValue,
} from '../src/codebehind/generate.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import type { RecordedAction } from '../src/codebehind/recording.js';

/**
 * What the recording captured, shown to generation and repair and held by the
 * leak guard (stories/codebehind-loops-and-conditions.md, "What the live half
 * decided").
 *
 * Measured on a real-model Run & Compile of templates/init/tests/control-flow.md:
 * `Read the name of every account in the Your accounts panel [store as:
 * accounts]` compiled to a locator that matched each row's three spans, so the
 * entry stored nine values where the recording's read stored three — and the
 * prompt had never said what the recording read. These pin the three halves:
 * the prompt shows the value (masked as the parameter block masks one), the
 * repair prompt does too, and an entry that writes the value in is refused and
 * re-asked once.
 */

const READ = 'Read the name of every account in the Your accounts panel [store as: accounts]';
const RECORDED = '["Everyday","Savings","Travel"]';
const READ_ACTION: RecordedAction = {
  action: 'read',
  selector: '#account-list > li[data-testid="account-row"] > span > span:first-child',
  multiple: true,
  as: 'accounts',
};

function bindingFor(source: string, overrides: Partial<CodeBehindBinding> = {}): CodeBehindBinding {
  return {
    file: path.resolve(path.sep, 'nowhere', 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...overrides,
  };
}

/** A client answering each text in turn (the last repeats), recording every prompt. */
function stubSequence(...texts: string[]): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1];
      prompts.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content));
      return { text: texts[Math.min(prompts.length - 1, texts.length - 1)]!, model: 'stub-model' };
    },
  } as unknown as AiClient;
  return { client, prompts };
}

const entry = (body: string, source = READ): string =>
  JSON.stringify({ entry: `{ source: ${JSON.stringify(source)}, async run({ page, step }) { ${body} } }` });

const CLEAN = entry(
  "const names = page.locator('#account-list > li > span > span:first-child'); " +
    "await names.first().waitFor(); step.setVar('accounts', JSON.stringify(await names.allTextContents()));",
);

describe('the step prompt shows what the recording captured', () => {
  it('beside the capture it belongs to, as the JSON the run stored, with its item count and the rule', () => {
    const text = buildStepCodePrompt({
      rawStepText: READ,
      parameters: [],
      actions: [READ_ACTION],
      captures: ['accounts'],
      recordedCaptures: { accounts: RECORDED },
    }).content as string;

    expect(text).toContain(
      `## Values this step must capture\n- \`step.setVar('accounts', ...)\` — the recording captured ` +
        `a list of 3 items: ${RECORDED}`,
    );
    expect(text).toContain(RECORDED_CAPTURE_RULE);
    expect(RECORDED_CAPTURE_RULE).toContain('the same number of items, the same text');
    expect(RECORDED_CAPTURE_RULE).toContain('nested elements, hidden duplicates, extra columns');
    expect(RECORDED_CAPTURE_RULE).toContain('prefer the selector the recorded read used');
    expect(RECORDED_CAPTURE_RULE).toContain('Never write the value');
  });

  it('quotes a plain value, and says nothing more about a capture it has no value for', () => {
    const text = buildStepCodePrompt({
      rawStepText: 'Read the balance [store as: balance] and the owner [store as: owner]',
      parameters: [],
      actions: [READ_ACTION],
      captures: ['balance', 'owner'],
      recordedCaptures: { balance: '$1,234.56' },
    }).content as string;
    expect(text).toContain(`- \`step.setVar('balance', ...)\` — the recording captured "$1,234.56"\n`);
    expect(text).toContain(`- \`step.setVar('owner', ...)\`\n\n${RECORDED_CAPTURE_RULE}`);
  });

  it('leaves the block exactly as it was when nothing was recorded', () => {
    const base = { rawStepText: READ, parameters: [], actions: [READ_ACTION], captures: ['accounts'] };
    const without = buildStepCodePrompt(base).content as string;
    expect(without).toContain("## Values this step must capture\n- `step.setVar('accounts', ...)`\n\n## What to return");
    expect(without).not.toContain('Match what the recording captured');
    expect(buildStepCodePrompt({ ...base, recordedCaptures: {} }).content).toBe(without);
    // A recorded name the step does not capture is not shown.
    expect(buildStepCodePrompt({ ...base, recordedCaptures: { other: 'x' } }).content).toBe(without);
  });

  it('masks a secret-named capture outright, and says the rule holds for it', () => {
    const text = buildStepCodePrompt({
      rawStepText: 'Read the one-time code [store as: otp_token]',
      parameters: [],
      actions: [{ action: 'read', selector: '#otp', as: 'otp_token' }],
      captures: ['otp_token'],
      recordedCaptures: { otp_token: '482913' },
    }).content as string;
    expect(text).toContain(`- \`step.setVar('otp_token', ...)\` — the recording captured "***"`);
    expect(text).toContain('A value shown as "***" is a secret and is masked here');
    expect(text).not.toContain('482913');
  });

  it('masks a known secret inside a value no name marks, and a secret column of a record', () => {
    const text = buildStepCodePrompt({
      rawStepText: 'Read the header [store as: header] and the login row [store as: login]',
      parameters: [],
      actions: [READ_ACTION],
      captures: ['header', 'login'],
      recordedCaptures: {
        header: 'Bearer uk_live_1234567890',
        login: '{"user":"bob","password":"abc"}',
      },
      secrets: ['uk_live_1234567890'],
    }).content as string;
    expect(text).toContain(`- \`step.setVar('header', ...)\` — the recording captured "Bearer ***"`);
    expect(text).toContain(`- \`step.setVar('login', ...)\` — the recording captured {"user":"bob","password":"***"}`);
    expect(text).not.toContain('uk_live_1234567890');
    expect(text).not.toContain('"abc"');
  });

  it('masks before it clips, so a clip cannot cut a secret in half past the mask', () => {
    const secret = 'sk_live_ABCDEFGHIJKLMNOP';
    // The secret straddles the 1500-character clip.
    const value = `${'x'.repeat(1490)}${secret}${'y'.repeat(100)}`;
    const text = buildStepCodePrompt({
      rawStepText: 'Read the log [store as: log]',
      parameters: [],
      actions: [READ_ACTION],
      captures: ['log'],
      recordedCaptures: { log: value },
      secrets: [secret],
    }).content as string;
    expect(text).not.toContain('sk_live');
    expect(text).toMatch(/more characters\)/);
  });
});

describe('the repair prompt shows what the recording captured', () => {
  const base = {
    rawStepText: READ,
    stepIndex: 11,
    entryCode: `{ source: ${JSON.stringify(READ)}, async run({ page, step }) { /* … */ } }`,
    error: 'strict mode violation',
    parameters: [],
  };

  it('with the same lines and rule as generation', () => {
    const text = buildRepairPrompt({ ...base, recordedCaptures: { accounts: RECORDED } }).content as string;
    expect(text).toContain(
      `## Values this step must capture\n- \`step.setVar('accounts', ...)\` — the recording captured ` +
        `a list of 3 items: ${RECORDED}\n\n${RECORDED_CAPTURE_RULE}`,
    );
  });

  it('masked as generation masks it', () => {
    const text = buildRepairPrompt({
      ...base,
      rawStepText: 'Read the header [store as: header] and the pin [store as: pin_secret]',
      recordedCaptures: { header: 'Bearer uk_live_1234567890', pin_secret: '4455' },
      secrets: ['uk_live_1234567890'],
    }).content as string;
    expect(text).toContain(`the recording captured "Bearer ***"`);
    expect(text).toContain(`- \`step.setVar('pin_secret', ...)\` — the recording captured "***"`);
    expect(text).not.toContain('uk_live_1234567890');
    expect(text).not.toContain('4455');
  });

  it('is unchanged without it, and states the value once', () => {
    const without = buildRepairPrompt(base).content as string;
    expect(without).not.toContain('## Values this step must capture');
    // The pass-count block that also stated it went with the pass-count
    // failure (review round 3, G1): a count difference is a warning now, and
    // no repair is asked for over one.
    expect(without).not.toContain('## What the recording captured');
    const text = buildRepairPrompt({ ...base, recordedCaptures: { accounts: RECORDED } }).content as string;
    expect(text.split(RECORDED)).toHaveLength(2);
  });

  it('carries the refusal and the masked answer on the one re-ask', () => {
    const text = buildRepairPrompt({
      ...base,
      retry: { previousEntry: "step.setVar('accounts', '***')", complaint: 'it wrote the value in' },
    }).content as string;
    expect(text).toContain(
      "## Your previous answer was refused\nit wrote the value in\n\nThat answer was:\n\n```ts\nstep.setVar('accounts', '***')\n```",
    );
  });
});

describe('recordedCapturesOf', () => {
  it('keeps only what the line captures, by the authored name', () => {
    expect(recordedCapturesOf(bindingFor(READ), { accounts: RECORDED, other: 'x' })).toEqual({ accounts: RECORDED });
    expect(recordedCapturesOf(bindingFor(READ), { other: 'x' })).toBeUndefined();
    expect(recordedCapturesOf(bindingFor('Click Next'), { accounts: RECORDED })).toBeUndefined();
    expect(recordedCapturesOf(bindingFor(READ), undefined)).toBeUndefined();
  });

  it('reads a skill body capture through its rename', () => {
    const binding = bindingFor('Read the total [store as: total]', {
      scope: { renames: { total: 'grand_total' }, inputs: {} },
    });
    expect(recordedCapturesOf(binding, { grand_total: '$9.00' })).toEqual({ total: '$9.00' });
  });
});

describe('capturedValueGuards', () => {
  const values = (guards: GuardedValue[]): string[] => guards.map((g) => g.value);

  it('guards a JSON list whole and item by item, each marked as captured', () => {
    const guards = capturedValueGuards({ accounts: RECORDED }, READ);
    expect(values(guards)).toEqual([RECORDED, 'Everyday', 'Savings', 'Travel']);
    expect(guards.every((g) => g.captured === true && g.name === 'accounts')).toBe(true);
  });

  it('keeps the minimum length, and never guards the mask or a JSON literal word', () => {
    expect(values(capturedValueGuards({ n: '8', code: 'AU', m: '***', e: '(empty)', t: 'true' }, 'x'))).toEqual([]);
    expect(values(capturedValueGuards({ list: '["AU","NZ","Fiji"]' }, 'x'))).toEqual(['["AU","NZ","Fiji"]', 'Fiji']);
  });

  it('exempts a value the author quoted in the step, as a parameter is exempt', () => {
    const source = 'Read the status, which should say "Active" [store as: status]';
    expect(values(capturedValueGuards({ status: 'Active' }, source))).toEqual([]);
  });

  it('exempts a value the step names unquoted — the step\'s own words, not the recording\'s answer', () => {
    const source = 'Read the label of the Submit button [store as: label]';
    expect(values(capturedValueGuards({ label: 'Submit' }, source))).toEqual([]);
    // …but only as a whole word: "Sub" inside "Submit" is not the author naming it.
    expect(values(capturedValueGuards({ label: 'Sub' }, source))).toEqual(['Sub']);
  });
});

describe('generation refuses an entry that writes the recorded value in', () => {
  const generate = (client: AiClient, source = READ, recorded: Record<string, string> = { accounts: RECORDED }) =>
    generateStepEntry({
      binding: bindingFor(source),
      actions: [READ_ACTION],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'accounts',
      recordedCaptures: recorded,
    });

  it('re-asks once, told why and shown its answer with the value masked, and keeps the clean answer', async () => {
    const inlined = entry(`step.setVar('accounts', '${RECORDED}');`);
    const { client, prompts } = stubSequence(inlined, CLEAN);

    const result = await generate(client);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(`the recording captured a list of 3 items: ${RECORDED}`);
    expect(prompts[1]).toContain('## Your previous answer was refused');
    expect(prompts[1]).toContain('The entry writes the value the recording captured into {{accounts}}');
    expect(prompts[1]).toContain("step.setVar('accounts', '***')");
    expect(result.kind).toBe('entry');
    expect(result.kind === 'entry' && result.code).toContain('allTextContents');
  });

  it('catches one item written in, even in a comment', async () => {
    const { client, prompts } = stubSequence(
      entry("// the accounts are Everyday, Savings and Travel\nstep.setVar('accounts', '[]');"),
      CLEAN,
    );
    const result = await generate(client);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('// the accounts are ***, *** and ***');
    expect(result.kind).toBe('entry');
  });

  it('fails when the re-ask writes it in again, and says which capture', async () => {
    const inlined = entry(`step.setVar('accounts', JSON.stringify(['Everyday', 'Savings', 'Travel']));`);
    const { client, prompts } = stubSequence(inlined);
    const result = await generate(client);
    expect(prompts).toHaveLength(2);
    expect(result).toEqual({
      kind: 'error',
      message: 'the generated code contains the value the recording captured into {{accounts}} as a literal, so it was discarded',
    });
  });

  it('asks once when the answer only echoes what the author wrote', async () => {
    const source = 'Read the text of the "Everyday" row\'s name [store as: first]';
    const { client, prompts } = stubSequence(
      entry("step.setVar('first', await page.getByText('Everyday').innerText());", source),
    );
    const result = await generate(client, source, { first: 'Everyday' });
    expect(prompts).toHaveLength(1);
    expect(result.kind).toBe('entry');
  });

  it('reads a captured value as a whole token — a longer number or word is not it', async () => {
    const source = 'Read the page size [store as: size]';
    const { client, prompts } = stubSequence(
      entry("await page.waitForTimeout(1000); step.setVar('size', await page.locator('#size').innerText());", source),
    );
    const result = await generate(client, source, { size: '100' });
    expect(prompts).toHaveLength(1);
    expect(result.kind).toBe('entry');
  });
});
