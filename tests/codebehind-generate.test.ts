import { describe, it, expect, beforeEach, afterAll } from 'vitest';
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
import { aiEntryFor, generateStepEntry, refuseReason } from '../src/codebehind/generate.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { buildFileReviewPrompt, parseFileRevision } from '../src/codebehind/review.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';

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

  it('states the post-condition rule and offers the decline envelope', () => {
    const text = contentBlocksToText(
      buildStepCodePrompt({ rawStepText: 'x', parameters: [], actions: [] }).content,
    );
    expect(text).toContain('End with a post-condition');
    expect(text).toContain('"entry": null');
  });
});

describe('refuseReason', () => {
  it('refuses a transcript that changed runner state rather than the page', () => {
    expect(refuseReason('Open a second browser', [
      { action: 'openBrowser', value: 'worker' },
      { action: 'click', selector: '#x' },
    ])).toMatch(/openBrowser/);
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

describe('generateStepEntry', () => {
  it('returns the entry the model produced', async () => {
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
    expect(result.kind === 'entry' && result.code).toContain("step.getVar('username')");
    expect(result.kind === 'entry' && result.code).not.toContain('octocat');
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
      binding: bindingFor('Open a second browser and sign in there'),
      actions: [{ action: 'openBrowser', value: 'worker' }],
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
    expect(text).toContain('{{username}} resolves to "octocat"');
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
    const file = `import { defineSteps } from 'ai-ui-automation/codebehind';\nexport default defineSteps([]);`;
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
