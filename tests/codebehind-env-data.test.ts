import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, BrowserContext, Browser } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { buildStepCodePrompt } from '../src/ai/prompts.js';
import {
  envDataRefsIn,
  envDataSecretValues,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../src/parser/interpolate-env-data.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { runCodeBehindEntry } from '../src/codebehind/execute.js';
import {
  generateStepEntry,
  guardedValues,
  stepEnvRefs,
  unresolvedRefsReason,
} from '../src/codebehind/generate.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import {
  readRecording,
  recordingDirFor,
  writeRecording,
  writeReplayFailure,
} from '../src/codebehind/recording.js';
import {
  compileTest,
  type CompileRunOutcome,
  type CompileRunRequest,
  type CompileRunner,
} from '../src/codebehind/compile.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import type { StepResult } from '../src/report/types.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * Code-behind reads `${data.*}` / `${env.*}` / `${<source>.*}`
 * (stories/codebehind-env-data.md).
 *
 * Caught live: `Navigate to ${data.url}` ran fine — the parser substitutes
 * the URL from `data/uat.json` before the run — and compiled to `ai: true`,
 * because the generator was handed the authored text with "no parameters",
 * the only variable API it has could not reach the environment, and the
 * repair round concluded, correctly, that no `url` was in scope. The fix is
 * one rule in two places: whatever is inside `${...}` is the `step.getVar`
 * name, at run time and in the prompt.
 */

/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-env-data');
});

let counter = 0;
let dir: string;

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

/** The `uat` environment of the live case, minus anything real. */
const UAT: EnvDataContext = {
  env: {
    GITHUB_USERNAME: 'octocat',
    GITHUB_PASSWORD: 'hunter2-uat-secret',
    AI_API_KEY: 'sk-uat-key-value',
    STEPTIX_SERVER_URL: 'http://localhost:3100',
  },
  data: {
    url: 'https://uat.example/',
    users: { admin: { email: 'uat-admin@example.test', password: 'admin-pw-uat' } },
    fixtures: { minBalance: 100, currency: 'USD', tags: ['a', 'b'] },
    credentials: { apiSecrets: ['s3cret-one', 's3cret-two'] },
  },
  extraData: { endpoints: { api: { url: 'https://uat-api.example/' } } },
  envName: 'uat',
};

const noPage = {} as unknown as Page;
const noContext = {} as unknown as BrowserContext;
const noBrowser = {} as unknown as Browser;

function bindingFor(source: string, over: Partial<CodeBehindBinding> = {}): CodeBehindBinding {
  return {
    file: path.join(dir, 'x.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    ...over,
  };
}

/** An AI client that answers from a queue and records every prompt's text. */
function scriptedClient(responses: string[]): { client: AiClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      const last = messages[messages.length - 1];
      const prompt = typeof last?.content === 'string'
        ? last.content
        : (last?.content ?? []).map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
      prompts.push(prompt);
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
  return { client, prompts };
}

const REVIEW_NOOP = '<<review: echo the file back>>';

function entryEnvelope(source: string, body: string): string {
  return JSON.stringify({
    entry: `{\n  source: ${JSON.stringify(source)},\n  async run({ page, step, log }) {\n    ${body}\n  },\n}`,
  });
}

function stepResult(index: number, over: Partial<StepResult> = {}): StepResult {
  return {
    index,
    instruction: `step ${index}`,
    status: 'passed',
    turns: [
      {
        turn: 1,
        actions: [{ action: 'navigate', url: 'https://uat.example/' }],
        subActions: [{ action: 'navigate', url: 'https://uat.example/' }],
        reasoning: 'go',
      },
    ] as unknown as StepResult['turns'],
    durationMs: 10,
    retried: false,
    pageUrl: 'https://uat.example/',
    stepContext: {
      domBefore: '<html><body>before</body></html>',
      urlBefore: 'about:blank',
      domAfter: '<html><body>after</body></html>',
      urlAfter: 'https://uat.example/',
    },
    ...over,
  };
}

function recordOutcome(count: number): CompileRunOutcome {
  return {
    status: 'passed',
    steps: Array.from({ length: count }, (_, i) => stepResult(i + 1)),
    resolvedParameters: {},
    tokensUsed: 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The grammar, shared with the parser
// ───────────────────────────────────────────────────────────────────────────

describe('envDataRefsIn', () => {
  it('finds every namespace the parser knows, as the name inside the braces', () => {
    expect(
      envDataRefsIn('Log in to ${data.url} as ${env.GITHUB_USERNAME} via ${endpoints.api.url} on ${envName}'),
    ).toEqual(['data.url', 'env.GITHUB_USERNAME', 'endpoints.api.url', 'envName']);
  });

  it('tolerates whitespace inside the braces, dedupes, and ignores {{name}}', () => {
    expect(envDataRefsIn('Open ${ data.url } then ${data.url} for {{username}}')).toEqual(['data.url']);
  });

  it('reports nothing for a step without references, or a bare ${word} the parser would not resolve', () => {
    expect(envDataRefsIn('Click Sign in')).toEqual([]);
    expect(envDataRefsIn('Use ${url}')).toEqual([]);
  });
});

describe('resolveEnvDataRef', () => {
  it('resolves each namespace the way the parser does', () => {
    expect(resolveEnvDataRef('data.url', UAT)).toBe('https://uat.example/');
    expect(resolveEnvDataRef('data.users.admin.email', UAT)).toBe('uat-admin@example.test');
    expect(resolveEnvDataRef('env.GITHUB_USERNAME', UAT)).toBe('octocat');
    expect(resolveEnvDataRef('endpoints.api.url', UAT)).toBe('https://uat-api.example/');
    expect(resolveEnvDataRef('envName', UAT)).toBe('uat');
    expect(resolveEnvDataRef(' data.url ', UAT)).toBe('https://uat.example/');
  });

  it('stringifies a non-string leaf as the step text would see it', () => {
    expect(resolveEnvDataRef('data.fixtures.minBalance', UAT)).toBe('100');
    expect(resolveEnvDataRef('data.fixtures.tags', UAT)).toBe('["a","b"]');
    expect(resolveEnvDataRef('data.fixtures.tags.1', UAT)).toBe('b');
  });

  it('answers undefined for anything the context does not define', () => {
    expect(resolveEnvDataRef('data.nope', UAT)).toBeUndefined();
    expect(resolveEnvDataRef('env.NOPE', UAT)).toBeUndefined();
    expect(resolveEnvDataRef('secrets.x', UAT)).toBeUndefined();
    expect(resolveEnvDataRef('data', UAT)).toBeUndefined();
    expect(resolveEnvDataRef('data.', UAT)).toBeUndefined();
    // A skill-level context has no `data`; `${data.X}` passes through there.
    expect(resolveEnvDataRef('data.url', { env: UAT.env })).toBeUndefined();
    expect(resolveEnvDataRef('envName', { env: UAT.env })).toBeUndefined();
  });
});

describe('envDataSecretValues', () => {
  it('collects secret-named env vars and data leaves under a secret-named key, nothing else', () => {
    const secrets = envDataSecretValues(UAT);
    expect(secrets).toEqual(
      expect.arrayContaining(['hunter2-uat-secret', 'sk-uat-key-value', 'admin-pw-uat', 's3cret-one', 's3cret-two']),
    );
    expect(secrets).not.toContain('octocat');
    expect(secrets).not.toContain('https://uat.example/');
    expect(secrets).not.toContain('uat-admin@example.test');
    expect(secrets).not.toContain('USD');
  });

  it('skips empty values', () => {
    expect(envDataSecretValues({ env: { PASSWORD: '' }, data: { token: '' } })).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Run time: step.getVar
// ───────────────────────────────────────────────────────────────────────────

describe('step.getVar at run time', () => {
  async function read(
    name: string,
    params: Record<string, string>,
    envData: EnvDataContext | undefined,
  ): Promise<string | undefined> {
    let seen: string | undefined;
    const binding = bindingFor('Navigate to ${data.url}');
    const outcome = await runCodeBehindEntry({
      binding: {
        ...binding,
        entry: { source: binding.source, run: ({ step }) => { seen = step.getVar(name); } },
      },
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: params,
      ...(envData && { envData }),
      label: 'test',
    });
    expect(outcome.status).toBe('passed');
    return seen;
  }

  it('reads an environment reference by the name inside its braces', async () => {
    expect(await read('data.url', {}, UAT)).toBe('https://uat.example/');
    expect(await read('env.GITHUB_USERNAME', {}, UAT)).toBe('octocat');
    expect(await read('endpoints.api.url', {}, UAT)).toBe('https://uat-api.example/');
    expect(await read('envName', {}, UAT)).toBe('uat');
  });

  it('lets a parameter of the same name win, as it would in the markdown', async () => {
    expect(await read('envName', { envName: 'from the parameters' }, UAT)).toBe('from the parameters');
  });

  it('answers undefined with no environment — exactly what it did before', async () => {
    expect(await read('data.url', {}, undefined)).toBeUndefined();
    expect(await read('username', { username: 'still works' }, undefined)).toBe('still works');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The parsed test carries its context
// ───────────────────────────────────────────────────────────────────────────

describe('parseTestFile', () => {
  const MD = ['# T', '', '## Steps', '1. Navigate to ${data.url}', '2. Click Sign in'].join('\n');

  it('keeps the context it interpolated with, sources included, next to the raw steps', async () => {
    await write('endpoints.json', JSON.stringify({ api: { url: 'https://from-source/' } }));
    const md = await write(
      't.md',
      ['---', 'dataSources:', '  endpoints: ./endpoints.json', '---', MD].join('\n'),
    );
    const parsed = await parseTestFile(md, {
      envData: { env: UAT.env, data: UAT.data!, envName: 'uat' },
    });
    // The parse VALIDATES references and keeps the tokens; the runner
    // substitutes per step, so the model can be shown the step as written
    // (stories/placeholder-preserving-actions.md §Environment and data-file
    // references). `steps` and `rawSteps` therefore agree on this step.
    expect(parsed.steps[0]).toBe('Navigate to ${data.url}');
    expect(parsed.expansion!.rawSteps[0]).toBe('Navigate to ${data.url}');
    expect(parsed.envData).toBeDefined();
    expect(resolveEnvDataRef('data.url', parsed.envData!)).toBe('https://uat.example/');
    expect(resolveEnvDataRef('endpoints.api.url', parsed.envData!)).toBe('https://from-source/');
    expect(parsed.envData!.envName).toBe('uat');
  });

  it('carries none without an environment, and the placeholder stays literal', async () => {
    const md = await write('t.md', MD);
    const parsed = await parseTestFile(md);
    expect(parsed.envData).toBeUndefined();
    expect(parsed.steps[0]).toBe('Navigate to ${data.url}');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Generation
// ───────────────────────────────────────────────────────────────────────────

describe('stepEnvRefs', () => {
  it('splits a step\'s references by whether the run can answer them', () => {
    const refs = stepEnvRefs(bindingFor('Open ${data.url} for ${secrets.key} on ${envName}'), UAT);
    expect(refs.resolved).toEqual([
      { ref: 'data.url', value: 'https://uat.example/' },
      { ref: 'envName', value: 'uat' },
    ]);
    expect(refs.unresolved).toEqual(['secrets.key']);
  });

  it('answers nothing without a context', () => {
    const refs = stepEnvRefs(bindingFor('Open ${data.url}'), undefined);
    expect(refs).toEqual({ resolved: [], unresolved: ['data.url'] });
  });
});

describe('the generation prompt', () => {
  it('lists each reference with its value and the getVar call that reads it', () => {
    const msg = buildStepCodePrompt({
      rawStepText: 'Log in to ${data.url} as {{username}}',
      parameters: [{ name: 'username', value: 'octocat' }],
      envRefs: [{ ref: 'data.url', value: 'https://uat.example/' }],
      actions: [{ action: 'navigate', url: 'https://uat.example/' }],
    });
    const text = msg.content as string;
    expect(text).toContain('- {{username}} resolved to "octocat" on this run');
    expect(text).toContain(
      '- ${data.url} resolved to "https://uat.example/" on this run — read it with step.getVar("data.url"); the value differs per environment',
    );
    // The mapping is stated where `step.getVar` is described, and in rule 1.
    expect(text).toContain("`${data.url}` is `step.getVar('data.url')`");
    expect(text).toContain('resolved parameter or environment value as a literal is REJECTED');
  });

  it('says "no parameters" only when there are neither', () => {
    const none = buildStepCodePrompt({ rawStepText: 'Click Sign in', parameters: [], actions: [] });
    expect(none.content as string).toContain('(this step uses no parameters)');
    const refsOnly = buildStepCodePrompt({
      rawStepText: 'Open ${data.url}',
      parameters: [],
      envRefs: [{ ref: 'data.url', value: 'https://uat.example/' }],
      actions: [],
    });
    expect(refsOnly.content as string).not.toContain('(this step uses no parameters)');
  });

  it('is mirrored by the repair prompt', () => {
    const msg = buildRepairPrompt({
      rawStepText: 'Open ${data.url}',
      stepIndex: 1,
      entryCode: '{ ... }',
      error: 'page.goto: Cannot navigate to invalid URL',
      parameters: [],
      envRefs: [{ ref: 'data.url', value: 'https://uat.example/' }],
    });
    const text = msg.content as string;
    expect(text).toContain('- ${data.url} resolved to "https://uat.example/" on this run — read it with step.getVar("data.url")');
    expect(text).toContain("`${data.url}` is `step.getVar('data.url')`");
  });
});

describe('generateStepEntry with an environment', () => {
  const NAVIGATE = [{ action: 'navigate' as const, url: 'https://uat.example/' }];

  it('accepts code that reads the reference through getVar', async () => {
    const { client, prompts } = scriptedClient([
      entryEnvelope('Navigate to ${data.url}', `const url = step.getVar('data.url'); await page.goto(url); await page.waitForURL(url);`),
    ]);
    const result = await generateStepEntry({
      binding: bindingFor('Navigate to ${data.url}'),
      actions: NAVIGATE,
      resolvedParameters: {},
      envData: UAT,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('entry');
    expect(prompts[0]).toContain('${data.url} resolved to "https://uat.example/" on this run');
  });

  it('rejects code that inlines the value this environment happened to have', async () => {
    const { client } = scriptedClient([
      entryEnvelope('Navigate to ${data.url}', `await page.goto('https://uat.example/');`),
    ]);
    const result = await generateStepEntry({
      binding: bindingFor('Navigate to ${data.url}'),
      actions: NAVIGATE,
      resolvedParameters: {},
      envData: UAT,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result).toEqual({
      kind: 'error',
      message: 'the generated code contains the resolved value of ${data.url} as a literal, so it was discarded',
    });
  });

  it('rejects an inlined environment secret the same way — the case that makes the guard non-negotiable', async () => {
    const { client } = scriptedClient([
      entryEnvelope('Enter the password ${env.GITHUB_PASSWORD}', `await page.locator('#password').fill('hunter2-uat-secret');`),
    ]);
    const result = await generateStepEntry({
      binding: bindingFor('Enter the password ${env.GITHUB_PASSWORD}'),
      actions: [{ action: 'type', selector: '#password', value: 'hunter2-uat-secret' }],
      resolvedParameters: {},
      envData: UAT,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('${env.GITHUB_PASSWORD}');
  });

  it('declines a reference the run cannot answer before asking the model', async () => {
    const { client, prompts } = scriptedClient([]);
    const result = await generateStepEntry({
      binding: bindingFor('Navigate to ${endpoints.api.url}/'),
      actions: NAVIGATE,
      resolvedParameters: {},
      envData: { env: UAT.env, data: UAT.data!, envName: 'uat' },
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(prompts).toHaveLength(0);
    expect(result.kind).toBe('declined');
    expect(result.kind === 'declined' && result.reason).toContain('${endpoints.api.url}');
    expect(result.kind === 'declined' && result.reason).toContain('skill-private data source');
  });

  it('declines every reference when the compile ran without an environment, and says so', async () => {
    const { client, prompts } = scriptedClient([]);
    const result = await generateStepEntry({
      binding: bindingFor('Navigate to ${data.url}'),
      actions: NAVIGATE,
      resolvedParameters: {},
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(prompts).toHaveLength(0);
    expect(result).toEqual({
      kind: 'declined',
      reason: unresolvedRefsReason(['data.url'], undefined),
    });
    expect(result.kind === 'declined' && result.reason).toContain('without an environment');
  });

  it('keeps a step with no references exactly as it was', async () => {
    const { client, prompts } = scriptedClient([
      entryEnvelope('Click Sign in', `await page.getByRole('link', { name: 'Sign in' }).click();`),
    ]);
    const result = await generateStepEntry({
      binding: bindingFor('Click Sign in'),
      actions: [{ action: 'click', selector: 'a' }],
      resolvedParameters: {},
      envData: UAT,
      aiClient: client,
      contextContent: '',
      testName: 'demo',
    });
    expect(result.kind).toBe('entry');
    expect(prompts[0]).toContain('(this step uses no parameters)');
  });
});

describe('guardedValues', () => {
  it('names a parameter as {{name}} and a reference as ${ref}', () => {
    expect(
      guardedValues([{ name: 'username', value: 'octocat' }], [{ ref: 'data.url', value: 'https://uat.example/' }]),
    ).toEqual([
      { name: 'username', value: 'octocat' },
      { name: '${data.url}', value: 'https://uat.example/' },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The recording redacts the environment's secrets
// ───────────────────────────────────────────────────────────────────────────

describe('the recording on disk', () => {
  it('redacts environment secrets from the actions and the DOM, beside the secret-named parameters', async () => {
    const md = await write('login.md', '# Login\n\n## Steps\n1. Enter the password ${env.GITHUB_PASSWORD}\n');
    const dirPath = await writeRecording(md, {
      steps: [
        stepResult(1, {
          instruction: 'Enter the password hunter2-uat-secret',
          turns: [
            {
              turn: 1,
              actions: [{ action: 'type', selector: '#password', value: 'hunter2-uat-secret' }],
              subActions: [{ action: 'type', selector: '#password', value: 'hunter2-uat-secret' }],
              reasoning: 'typed admin-pw-uat too',
            },
          ] as unknown as StepResult['turns'],
          stepContext: {
            domBefore: '<input value="hunter2-uat-secret"><p>octocat</p>',
            urlBefore: 'https://uat.example/login',
            domAfter: '<input value="admin-pw-uat">',
            urlAfter: 'https://uat.example/home',
          },
        }),
      ],
      status: 'passed',
      startedAt: new Date().toISOString(),
      parameters: { username: 'octocat' },
      secrets: envDataSecretValues(UAT),
      source: 'cli',
    });
    expect(dirPath).toBe(recordingDirFor(md));
    const before = await fs.readFile(path.join(dirPath!, 'step-01.before.html'), 'utf-8');
    const after = await fs.readFile(path.join(dirPath!, 'step-01.after.html'), 'utf-8');
    const step = await fs.readFile(path.join(dirPath!, 'step-01.json'), 'utf-8');
    expect(before).toBe('<input value="***"><p>octocat</p>');
    expect(after).toBe('<input value="***">');
    expect(step).not.toContain('hunter2-uat-secret');
    expect(step).not.toContain('admin-pw-uat');
    expect(step).toContain('***');
    // The manifest still lists parameter names only: no secret, no value.
    const recording = await readRecording(md);
    expect(recording!.manifest.parameters).toEqual(['username']);
  });

  it('redacts them from a replay failure too', async () => {
    const md = await write('login.md', '# Login\n\n## Steps\n1. x\n');
    await writeReplayFailure(
      md,
      { round: 1, step: 1, error: 'fill("hunter2-uat-secret") timed out', dom: '<p>hunter2-uat-secret</p>' },
      {},
      envDataSecretValues(UAT),
    );
    const failure = await fs.readFile(path.join(recordingDirFor(md), 'replay-1.failure.json'), 'utf-8');
    const dom = await fs.readFile(path.join(recordingDirFor(md), 'replay-1.failure.html'), 'utf-8');
    expect(failure).not.toContain('hunter2-uat-secret');
    expect(failure).toContain('***');
    expect(dom).toBe('<p>***</p>');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The compile, end to end with a stub model and a scripted runner
// ───────────────────────────────────────────────────────────────────────────

describe('compileTest on a test that navigates to ${data.url}', () => {
  const CONFIG: Config = { ...DEFAULT_CONFIG };
  const MD = ['# Login', '', '## Steps', '1. Navigate to ${data.url}', '2. Click Sign in'].join('\n');

  function passingRunner(): { runner: CompileRunner; requests: CompileRunRequest[] } {
    const requests: CompileRunRequest[] = [];
    const runner: CompileRunner = async (request) => {
      requests.push(request);
      if (request.purpose === 'record') return recordOutcome(2);
      return {
        status: 'passed',
        steps: [stepResult(1, { fromCodeBehind: true }), stepResult(2, { fromCodeBehind: true })],
        resolvedParameters: {},
        tokensUsed: 0,
      };
    };
    return { runner, requests };
  }

  it('writes an entry that reads the URL through getVar, never the URL itself', async () => {
    const md = await write('login.md', MD);
    const test = await parseTestFile(md, { envData: { env: UAT.env, data: UAT.data!, envName: 'uat' } });
    const { client, prompts } = scriptedClient([
      entryEnvelope('Navigate to ${data.url}', `const url = step.getVar('data.url'); await page.goto(url); await page.waitForURL(url);`),
      entryEnvelope('Click Sign in', `await page.getByRole('link', { name: 'Sign in' }).click(); await page.waitForURL(/login/);`),
      REVIEW_NOOP,
    ]);
    const { runner } = passingRunner();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });

    expect(result.status).toBe('green');
    const written = await fs.readFile(path.join(dir, 'login.steps.ts'), 'utf-8');
    expect(written).toContain("source: 'Navigate to ${data.url}'");
    expect(written).toContain("step.getVar('data.url')");
    expect(written).not.toContain('https://uat.example/');
    expect(written).not.toContain('ai: true');
    // The generator was told what the reference resolved to and how to read it.
    expect(prompts[0]).toContain('${data.url} resolved to "https://uat.example/" on this run — read it with step.getVar("data.url")');
    // Step 2 makes no reference; its prompt says so, as before.
    expect(prompts[1]).toContain('(this step uses no parameters)');
    // The reviewer saw the authored steps, not the interpolated ones.
    expect(prompts[2]).toContain('1. Navigate to ${data.url}');
    expect(prompts[2]).not.toContain('https://uat.example/');
  });

  it('fails the compile, naming the reference, when the model inlines the URL', async () => {
    const md = await write('login.md', MD);
    const test = await parseTestFile(md, { envData: { env: UAT.env, data: UAT.data!, envName: 'uat' } });
    const { client } = scriptedClient([
      entryEnvelope('Navigate to ${data.url}', `await page.goto('https://uat.example/');`),
    ]);
    const { runner } = passingRunner();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });

    expect(result.status).toBe('failed');
    expect(result.summary.error).toContain('generation failed for step 1');
    expect(result.summary.error).toContain('resolved value of ${data.url}');
    await expect(fs.access(path.join(dir, 'login.steps.ts'))).rejects.toThrow();
  });

  it('keeps the generated file when the review inlines the URL', async () => {
    const md = await write('login.md', MD);
    const test = await parseTestFile(md, { envData: { env: UAT.env, data: UAT.data!, envName: 'uat' } });
    const { client } = scriptedClient([
      entryEnvelope('Navigate to ${data.url}', `await page.goto(step.getVar('data.url')); await page.waitForURL(/./);`),
      entryEnvelope('Click Sign in', `await page.getByRole('link', { name: 'Sign in' }).click(); await page.waitForURL(/login/);`),
      JSON.stringify({ file: `// reviewed\nexport default defineSteps([{ source: 'Navigate to \${data.url}', async run({ page }) { await page.goto('https://uat.example/'); } }]);\n` }),
    ]);
    const { runner } = passingRunner();
    const events: string[] = [];

    const result = await compileTest({
      test, config: CONFIG, contextContent: '', aiClient: client, runner,
      onEvent: (e) => { if (e.kind === 'phase' && e.phase === 'review') events.push(e.message); },
    });

    expect(result.status).toBe('green');
    expect(events).toContainEqual('rejected: the revision inlines ${data.url} — the generated file stands');
    const written = await fs.readFile(path.join(dir, 'login.steps.ts'), 'utf-8');
    expect(written).toContain("step.getVar('data.url')");
    expect(written).not.toContain('https://uat.example/');
  });

  it('writes the step off with the reason when the compile has no environment to read', async () => {
    // `steptix compile login.md` with no --env: the parser left `${data.url}`
    // literal, so the recording's AI step did whatever it did with that text.
    // The generator does not guess; the entry says why it is AI.
    const md = await write('login.md', MD);
    const test = await parseTestFile(md);
    const { client, prompts } = scriptedClient([
      entryEnvelope('Click Sign in', `await page.getByRole('link', { name: 'Sign in' }).click(); await page.waitForURL(/login/);`),
      REVIEW_NOOP,
    ]);
    const { runner } = passingRunner();

    const result = await compileTest({ test, config: CONFIG, contextContent: '', aiClient: client, runner });

    expect(result.status).toBe('green');
    // Only step 2 reached the model; step 1 was declined before any call.
    expect(prompts[0]).toContain('Click Sign in');
    const written = await fs.readFile(path.join(dir, 'login.steps.ts'), 'utf-8');
    expect(written).toContain("source: 'Navigate to ${data.url}'");
    expect(written).toContain('ai: true');
    expect(written).toContain('without an environment');
  });
});
