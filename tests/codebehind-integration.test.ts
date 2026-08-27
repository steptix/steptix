import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { executeStep } from '../src/runner/step-executor.js';
import { buildCodeBehindRegistry, type CodeBehindRegistry } from '../src/codebehind/loader.js';
import { countStepOrigins, renderStep, CODE_BEHIND_MARK } from '../src/report/generator.js';

/**
 * The end-to-end behaviours the stories name, driven through the real
 * `executeStep` seam with a stubbed AI client and a fake page:
 *
 *  1. a test with a complete hand-written `.steps.ts` runs with zero AI calls;
 *  2. an entry that throws falls through to AI, the step still passes, and the
 *     result carries `codeBehindStale` — a run flags the failure instead of
 *     rewriting the file (stories/codebehind-compile.md);
 *  3. under `codeBehindStrict`, that same throw fails the step instead;
 *  4. a run never writes a `.steps.ts`, whatever happened.
 *
 * A fake page rather than a browser: none of these turn on what the page
 * does, and the point is the executor's decision order.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-integration');

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

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

/** Enough `Page` for the executor's bookkeeping; nothing here touches a DOM. */
function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/dashboard',
    context: () => ({ browser: () => ({}) }),
    // captureDomSnapshot swallows this and returns its error marker; the AI
    // stub doesn't care what the DOM said.
    evaluate: async () => { throw new Error('no DOM in this test'); },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

/** Screenshots and DOM images off, one turn, no retry — the executor's
 *  decision order is what's under test, not its capture policy. */
const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

/** An AI client that hands back queued responses and counts its calls. */
function scriptedClient(responses: string[]): { client: AiClient; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const client = {
    complete: async (messages: ChatMessage[]) => {
      calls.push(messages);
      const text = responses.shift();
      if (text === undefined) throw new Error('AI called more times than the test scripted');
      return { text, model: 'stub-model' };
    },
  } as unknown as AiClient;
  return { client, calls };
}

/** An AI client that fails the test if it is called at all. */
function forbiddenClient(): AiClient {
  return {
    complete: async () => { throw new Error('the AI must not be called for this step'); },
  } as unknown as AiClient;
}

const ACTION_PLAN = JSON.stringify({
  reasoning: 'Filled the field',
  actions: [{ action: 'noop', description: 'nothing further to do' }],
});

async function registryFor(testPath: string): Promise<{ steps: string[]; registry: CodeBehindRegistry }> {
  const parsed = await parseTestFile(testPath);
  const registry = await buildCodeBehindRegistry(
    {
      steps: parsed.steps,
      rawSteps: parsed.expansion!.rawSteps,
      origins: parsed.expansion!.origins,
      frames: parsed.expansion!.frames,
    },
    { testFilePath: parsed.filePath, onWarn: () => {} },
  );
  return { steps: parsed.steps, registry };
}

const TEST_MD = ['# Booking', '', '## Steps', '1. Enter the booking code', '2. Confirm the booking'].join('\n');

describe('a code-behind file that does not load', () => {
  it('is recorded on the registry, not only warned about', async () => {
    // The steps fall back to AI, as before — but a strict replay needs to know
    // the file never loaded, or it would report "passed as code" for code
    // that never ran (stories/codebehind-recording-on-disk.md §What was built).
    const md = await write('booking.md', TEST_MD);
    const stepsFile = await write('booking.steps.ts', `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', async run({ page }) { const x = ; } },
]);
`);
    const warnings: string[] = [];
    const parsed = await parseTestFile(md);
    const registry = await buildCodeBehindRegistry(
      {
        steps: parsed.steps,
        rawSteps: parsed.expansion!.rawSteps,
        origins: parsed.expansion!.origins,
        frames: parsed.expansion!.frames,
      },
      { testFilePath: parsed.filePath, onWarn: (m) => warnings.push(m) },
    );
    expect(registry.bindingFor(0)?.entry).toBeUndefined();
    expect(registry.loadErrors).toHaveLength(1);
    expect(registry.loadErrors[0]!.file).toBe(stepsFile);
    expect(registry.loadErrors[0]!.error).toMatch(/Expected|Unexpected|syntax/i);
    expect(warnings.some((w) => w.includes('Failed to load code-behind file'))).toBe(true);
  });
});

describe('code-behind end to end', () => {
  it('runs a fully covered test with zero AI calls', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  {
    source: 'Enter the booking code',
    async run({ step }) { step.setVar('code', '220826'); },
  },
  {
    source: 'Confirm the booking',
    async run({ step, log }) {
      log.info('confirming');
      step.expect(step.getVar('code') === '220826', 'code should have been entered');
      step.setVar('confirmed', 'yes');
    },
  },
]);
`);

    const { steps, registry } = await registryFor(md);
    const resolvedParameters: Record<string, string> = {};
    const page = fakePage();

    const results = [];
    for (let i = 0; i < steps.length; i++) {
      results.push(await executeStep(i + 1, steps.length, steps[i]!, {
        page,
        config: CONFIG,
        aiClient: forbiddenClient(),
        contextContent: '',
        testName: 'booking',
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters,
        codeBehind: registry.bindingFor(i)!,
      }));
    }

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(results.every((r) => r.fromCodeBehind === true)).toBe(true);
    expect(results.every((r) => r.turns.length === 0)).toBe(true);
    expect(resolvedParameters).toEqual({ code: '220826', confirmed: 'yes' });
    // `setVar` writes surface on the step result, so the report shows them.
    expect(results[0]!.outputs).toEqual({ code: '220826' });
    expect(results[1]!.outputs).toEqual({ confirmed: 'yes' });
    // The report gets the code and the logs.
    expect(results[0]!.codeBehind?.file).toContain('booking.steps.ts');
    expect(results[1]!.codeBehind?.logs).toEqual([{ level: 'info', message: 'confirming' }]);
  });

  it('fails the step outright when a step.expect fails — broken code heals, a failed assertion does not', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  {
    source: 'Enter the booking code',
    async run({ step }) { step.expect(false, 'the confirmation banner never appeared'); },
  },
]);
`);

    const { steps, registry } = await registryFor(md);
    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage(),
      config: CONFIG,
      aiClient: forbiddenClient(),
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: registry.bindingFor(0)!,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('the confirmation banner never appeared');
    expect(result.fromCodeBehind).toBe(true);
  });

  const BROKEN_STEPS = `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  {
    source: 'Enter the booking code',
    async run() { throw new Error('#booking-code went away in a redesign'); },
  },
]);
`;

  it('falls through to AI when the entry throws, flags it stale, and discards it', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', BROKEN_STEPS);

    const { steps, registry } = await registryFor(md);
    const { client, calls } = scriptedClient([ACTION_PLAN]);
    const binding = registry.bindingFor(0)!;
    expect(binding.entry).toBeDefined();

    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage(),
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: binding,
    });

    expect(result.status).toBe('passed');
    expect(result.fromCodeBehind).toBeUndefined();
    expect(calls).toHaveLength(1);
    // The failure is flagged for the next compile rather than repaired here.
    expect(result.codeBehindStale).toEqual({
      file: binding.file,
      source: 'Enter the booking code',
      error: '#booking-code went away in a redesign',
    });
    // Discarded for the rest of the run — a re-execution won't re-run the
    // broken code and pay the failure again.
    expect(binding.entry).toBeUndefined();
  });

  it('fails the step instead of healing under codeBehindStrict — compile replay', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', BROKEN_STEPS);

    const { steps, registry } = await registryFor(md);
    const binding = registry.bindingFor(0)!;
    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage(),
      config: CONFIG,
      aiClient: forbiddenClient(),
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: binding,
      codeBehindStrict: true,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('#booking-code went away in a redesign');
    expect(result.fromCodeBehind).toBe(true);
    expect(result.codeBehindStale).toBeUndefined();
    // The entry stays bound: a strict replay is not healing anything.
    expect(binding.entry).toBeDefined();
  });

  it('keeps the code-behind crash on the result when the AI attempt fails too', async () => {
    // The entry throws, the step falls through to AI, and the AI fails as
    // well. The failed result must still carry `codeBehindStale` — dropping
    // it here (which is what used to happen) erased the code-behind error
    // everywhere downstream: the step:fail event, the report, the sidecar.
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', BROKEN_STEPS);

    const { steps, registry } = await registryFor(md);
    const binding = registry.bindingFor(0)!;
    const failingClient = {
      complete: async () => { throw new Error('gateway on fire'); },
    } as unknown as AiClient;

    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage(),
      config: CONFIG,
      aiClient: failingClient,
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: binding,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('gateway on fire');
    expect(result.codeBehindStale).toEqual({
      file: binding.file,
      source: 'Enter the booking code',
      error: '#booking-code went away in a redesign',
    });
  });

  it('never writes a .steps.ts from a run — generation is `aiui compile`', async () => {
    const md = await write('booking.md', TEST_MD);
    const { client, calls } = scriptedClient([ACTION_PLAN]);
    const { steps, registry } = await registryFor(md);

    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage(),
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: registry.bindingFor(0)!,
    });

    expect(result.status).toBe('passed');
    // One call: the action plan. There is no second, generating call any more.
    expect(calls).toHaveLength(1);
    await expect(fs.access(path.join(dir, 'booking.steps.ts'))).rejects.toThrow();
  });

  it('renders the code mark and a collapsed code block in the report', () => {
    const html = renderStep({
      index: 1,
      instruction: 'Enter the booking code',
      status: 'passed',
      turns: [],
      durationMs: 42,
      retried: false,
      fromCodeBehind: true,
      codeBehind: {
        file: '/p/tests/booking.steps.ts',
        code: `async run({ step }) { step.setVar('code', '220826'); }`,
        logs: [{ level: 'info', message: 'confirming' }],
      },
    });

    expect(html).toContain(`${CODE_BEHIND_MARK} code</span>`);
    expect(html).toContain(`${CODE_BEHIND_MARK} Code-behind`);
    expect(html).toContain('/p/tests/booking.steps.ts');
    expect(html).toContain('<summary>Step code</summary>');
    expect(html).toContain('[info] confirming');
    // The cache's own glyph stays the cache's.
    expect(html).not.toContain('⚡');
  });

  it('renders the cache\'s ⚡ for a cached step and nothing for a plain one', () => {
    const base = {
      index: 1, instruction: 'x', status: 'passed' as const, turns: [], durationMs: 1, retried: false,
    };
    expect(renderStep({ ...base, fromCache: true })).toContain('⚡ cached');
    const plain = renderStep(base);
    expect(plain).not.toContain('⚡');
    expect(plain).not.toContain('cb-mark');
  });

  it('leaves an `ai: true` step to the AI, and never rewrites the file', async () => {
    const md = await write('booking.md', TEST_MD);
    await write('booking.steps.ts', `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  { source: 'Enter the booking code', ai: true },
]);
`);
    const before = await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8');

    const { steps, registry } = await registryFor(md);
    const { client, calls } = scriptedClient([ACTION_PLAN]);
    const result = await executeStep(1, steps.length, steps[0]!, {
      page: fakePage(),
      config: CONFIG,
      aiClient: client,
      contextContent: '',
      testName: 'booking',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: registry.bindingFor(0)!,
    });

    expect(result.status).toBe('passed');
    expect(result.fromCodeBehind).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, 'booking.steps.ts'), 'utf-8')).toBe(before);
  });

  it('renders ⚠ and the recompile hint for a stale step, and counts it in the summary', () => {
    const html = renderStep({
      index: 1,
      instruction: 'Enter the booking code',
      status: 'passed',
      turns: [],
      durationMs: 42,
      retried: false,
      codeBehindStale: {
        file: '/p/tests/booking.steps.ts',
        source: 'Enter the booking code',
        error: 'locator.fill: Timeout 30000ms exceeded',
      },
    });
    expect(html).toContain('⚠ ran under AI — code-behind failed');
    expect(html).toContain('locator.fill: Timeout 30000ms exceeded');
    expect(html).toContain('aiui compile /p/tests/booking.md --only-stale');
    // ⚠ outranks the code mark: the step did NOT run as code.
    expect(html).not.toContain('cb-mark');

    // A step whose heal FAILED keeps the flag too (the executor no longer
    // drops it on the failed path), so the report shows both halves: the
    // code-behind crash and the AI failure that followed it.
    const failedHtml = renderStep({
      index: 1,
      instruction: 'Enter the booking code',
      status: 'failed',
      turns: [],
      durationMs: 42,
      retried: true,
      error: 'AI could not find the button either',
      codeBehindStale: {
        file: '/p/tests/booking.steps.ts',
        source: 'Enter the booking code',
        error: 'locator.fill: Timeout 30000ms exceeded',
      },
    });
    expect(failedHtml).toContain('locator.fill: Timeout 30000ms exceeded');
    expect(failedHtml).toContain('AI could not find the button either');

    const base = { instruction: 'x', status: 'passed' as const, turns: [], durationMs: 1, retried: false };
    expect(
      countStepOrigins([
        { ...base, index: 1, fromCodeBehind: true },
        { ...base, index: 2 },
        { ...base, index: 3, codeBehindStale: { file: 'f', source: 's', error: 'e' } },
        // Hook rows are not steps of the test and must not be counted.
        { ...base, index: 3, hookScope: 'afterEach' },
      ]),
    ).toEqual({ code: 1, ai: 1, stale: 1 });
  });
});
