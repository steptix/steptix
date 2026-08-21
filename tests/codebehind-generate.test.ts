import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import { findInlinedParameterValue, parseStepCode } from '../src/ai/action-parser.js';
import { buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { generateCodeBehind } from '../src/codebehind/generate.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';

/**
 * Generation: the prompt's parse, the secret-literal guard, and the two
 * refusals that keep the writer from being asked to write the wrong thing
 * (stories/step-codebehind.md, "Generation").
 *
 * No real model is involved — the AI client is a stub that returns whatever
 * the case is about.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-generate');

let counter = 0;
let dir: string;

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

/** An AI client that answers with `text` and records what it was asked. */
function stubClient(text: string): { client: AiClient; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
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

const PASSING_TURN = {
  rawResponse: '{}',
  reasoning: 'typed the password',
  actions: [
    { action: 'type' as const, selector: '#password', value: 'hunter2-correct-horse' },
    { action: 'click' as const, selector: 'button[type=submit]' },
  ],
};

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
      actions: PASSING_TURN.actions,
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
});

describe('generateCodeBehind', () => {
  it('writes the entry the model returned', async () => {
    // The primary live shape: the JSON envelope a json_object-mode client emits.
    const { client, calls } = stubClient(JSON.stringify({
      entry: [
        `{`,
        `  source: 'Enter the username {{username}}',`,
        `  async run({ page, step }) {`,
        `    await page.locator('#login_field').fill(step.getVar('username'));`,
        `  },`,
        `}`,
      ].join('\n'),
    }));

    const binding = bindingFor('Enter the username {{username}}');
    const action = await generateCodeBehind({
      binding,
      turns: [PASSING_TURN],
      resolvedParameters: { username: 'octocat' },
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });

    expect(action).toBe('created');
    expect(calls).toHaveLength(1);
    const written = await fs.readFile(binding.file, 'utf-8');
    expect(written).toContain(`import { defineSteps } from 'ai-ui-automation/codebehind';`);
    expect(written).toContain("step.getVar('username')");
    expect(written).not.toContain('octocat');
  });

  it('stamps the runner\'s section scope, not the model\'s', async () => {
    const { client } = stubClient(
      "```ts\n{ section: 'GuessedWrong', source: 'Click Pay now', async run({ page }) { await page.click('#pay'); } }\n```",
    );
    const binding = bindingFor('Click Pay now', { section: 'Checkout' });
    expect(await generateCodeBehind({
      binding,
      turns: [{ rawResponse: '{}', reasoning: '', actions: [{ action: 'click', selector: '#pay' }] }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    })).toBe('created');

    const written = await fs.readFile(binding.file, 'utf-8');
    expect(written).toContain('section: "Checkout"');
    expect(written).not.toContain('GuessedWrong');
  });

  it('refuses — and writes NOTHING — when the code inlines a parameter value', async () => {
    const { client } = stubClient([
      '```ts',
      `{`,
      `  source: 'Enter the password {{password}}',`,
      `  async run({ page }) { await page.fill('#password', 'hunter2-correct-horse'); },`,
      `}`,
      '```',
    ].join('\n'));

    const binding = bindingFor('Enter the password {{password}}');
    const action = await generateCodeBehind({
      binding,
      turns: [PASSING_TURN],
      resolvedParameters: { password: 'hunter2-correct-horse' },
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });

    expect(action).toBeNull();
    await expect(fs.access(binding.file)).rejects.toThrow();
  });

  it('skips a step whose transcript changed runner state rather than the page', async () => {
    const { client, calls } = stubClient('should never be asked');
    const action = await generateCodeBehind({
      binding: bindingFor('Open a second browser and sign in there'),
      turns: [{
        rawResponse: '{}',
        reasoning: '',
        actions: [{ action: 'openBrowser', value: 'worker' }, { action: 'click', selector: '#x' }],
      }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(action).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('skips a bracket-token step — code-behind for those is a stated non-goal', async () => {
    const { client, calls } = stubClient('should never be asked');
    for (const source of ['[output: balance] Read the balance', '[input: pin] Enter your PIN']) {
      expect(await generateCodeBehind({
        binding: bindingFor(source),
        turns: [{ rawResponse: '{}', reasoning: '', actions: [{ action: 'read', selector: '#b', as: 'balance' }] }],
        resolvedParameters: {},
        aiClient: client,
        contextContent: '',
        testName: 'demo',
      })).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('skips a step with no recorded actions', async () => {
    const { client, calls } = stubClient('should never be asked');
    expect(await generateCodeBehind({
      binding: bindingFor('Nothing happened'),
      turns: [],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('swallows an unparseable response — a step that passed must not fail here', async () => {
    const { client } = stubClient('I am afraid I cannot do that.');
    const binding = bindingFor('Click Sign in');
    expect(await generateCodeBehind({
      binding,
      turns: [{ rawResponse: '{}', reasoning: '', actions: [{ action: 'click', selector: '#x' }] }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    })).toBeNull();
    await expect(fs.access(binding.file)).rejects.toThrow();
  });

  it('resolves a skill-frame parameter through the frame scope before guarding it', async () => {
    const { client, calls } = stubClient(
      "```ts\n{ source: 'Sign in as {{username}}', async run({ page, step }) { await page.fill('#u', step.getVar('username')); } }\n```",
    );
    const binding = bindingFor('Sign in as {{username}}', {
      scope: { renames: {}, inputs: { username: 'alice-from-the-caller' } },
    });
    expect(await generateCodeBehind({
      binding,
      turns: [{ rawResponse: '{}', reasoning: '', actions: [{ action: 'type', selector: '#u', value: 'alice-from-the-caller' }] }],
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    })).toBe('created');
    // The prompt was told the frame's value, so the guard covers it.
    expect(contentBlocksToText(calls[0]![1]!.content)).toContain('alice-from-the-caller');
  });
});
