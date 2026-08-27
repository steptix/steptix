/**
 * Replay on a machine with no AI at all
 * (stories/keyless-replay-and-gateway-env.md §Part B).
 *
 * The corporate story this file holds up: a compiled test runs inside a
 * restricted network with nothing configured to call out, and when the app
 * changes under it the run says so plainly instead of dying in the heal
 * fall-through with a gateway `invalid_api_key`.
 *
 * Driven through the real `executeStep` seam — the same harness shape
 * `codebehind-integration.test.ts` uses — because what is under test is the
 * executor's decision order: which broken entries heal, which fail, and what
 * the failed ones say. A fake page, because none of it turns on what the page
 * does.
 *
 * `keyless` is an explicit option here rather than something derived from
 * `config.ai`, so these cases cannot be quietly un-keylessed by a real
 * AI_API_KEY in the machine-wide `%LOCALAPPDATA%\aiui\.env` or the process
 * env. The runner-side half of that wiring — where the flag comes FROM — is
 * `keyless-diagnosis.test.ts`.
 */
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
import { executeStep, KEYLESS_HEAL_SKIPPED_ERROR } from '../src/runner/step-executor.js';
import { buildCodeBehindRegistry, type CodeBehindRegistry } from '../src/codebehind/loader.js';

/** The story's copy, restated rather than imported, so a silent edit to the
 *  constant fails here instead of passing by agreeing with itself. */
const KEYLESS_COPY =
  'replay failed and was not healed: AI is not configured on this machine. ' +
  'Recompile or repair this step where AI is available.';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-keyless-replay');

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
    url: () => 'https://bank.test/accounts',
    context: () => ({ browser: () => ({}) }),
    evaluate: async () => { throw new Error('no DOM in this test'); },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

/**
 * The spy the story names: an AI client that fails the test if ANY request
 * method is called, and counts the attempts so "untouched" is asserted rather
 * than assumed. A keyless run must never reach it — proactively, before a
 * request is built.
 */
function forbiddenClient(): { client: AiClient; attempts: number[] } {
  const attempts: number[] = [];
  const client = {
    complete: async () => {
      attempts.push(1);
      throw new Error('the AI must not be called on a keyless run');
    },
  } as unknown as AiClient;
  return { client, attempts };
}

/** An AI client that hands back queued responses and records its calls. */
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

const ACTION_PLAN = JSON.stringify({
  reasoning: 'Opened the transfers tab',
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

const TEST_MD = [
  '# Transfers',
  '',
  '## Steps',
  '1. Sign in',
  '2. Click the "Transfers" tab',
  '3. Read the balance',
].join('\n');

/** Three entries; `middle` decides whether step 2's entry throws. */
function stepsFile(middle: 'works' | 'throws' | 'asserts'): string {
  const bodies = {
    works: `step.setVar('tab', 'transfers');`,
    throws: `throw new Error('#transfers-tab went away in a redesign');`,
    asserts: `step.expect(false, 'the transfers tab never appeared');`,
  };
  return `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  { source: 'Sign in', async run({ step }) { step.setVar('user', 'ada'); } },
  { source: 'Click the "Transfers" tab', async run({ step }) { ${bodies[middle]} } },
  { source: 'Read the balance', async run({ step }) { step.setVar('balance', '1200.00'); } },
]);
`;
}

/** Run every step of the fixture in order, returning the results. */
async function runAll(
  steps: string[],
  registry: CodeBehindRegistry,
  aiClient: AiClient,
  extra: { keyless?: boolean; codeBehindStrict?: boolean } = {},
) {
  const page = fakePage();
  const resolvedParameters: Record<string, string> = {};
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    results.push(
      await executeStep(i + 1, steps.length, steps[i]!, {
        page,
        config: CONFIG,
        aiClient,
        contextContent: '',
        testName: 'transfers',
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters,
        codeBehind: registry.bindingFor(i)!,
        ...extra,
      }),
    );
  }
  return { results, resolvedParameters };
}

describe('a keyless run of a compiled test', () => {
  it('replays green with zero AI requests', async () => {
    const md = await write('transfers.md', TEST_MD);
    await write('transfers.steps.ts', stepsFile('works'));

    const { steps, registry } = await registryFor(md);
    const { client, attempts } = forbiddenClient();
    const { results, resolvedParameters } = await runAll(steps, registry, client, {
      keyless: true,
    });

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed', 'passed']);
    expect(results.every((r) => r.fromCodeBehind === true)).toBe(true);
    expect(results.every((r) => r.turns.length === 0)).toBe(true);
    // The spy is untouched: no request was built, let alone sent.
    expect(attempts).toEqual([]);
    expect(resolvedParameters).toEqual({ user: 'ada', tab: 'transfers', balance: '1200.00' });
  });

  it('fails the broken step with the keyless copy, leaving its siblings replaying as code', async () => {
    const md = await write('transfers.md', TEST_MD);
    await write('transfers.steps.ts', stepsFile('throws'));

    const { steps, registry } = await registryFor(md);
    const broken = registry.bindingFor(1)!;
    const { client, attempts } = forbiddenClient();
    const { results, resolvedParameters } = await runAll(steps, registry, client, {
      keyless: true,
    });

    const [first, failed, third] = results;
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe(KEYLESS_COPY);
    expect(KEYLESS_HEAL_SKIPPED_ERROR).toBe(KEYLESS_COPY);
    // No `invalid_api_key` anywhere near it — the point of the proactive skip.
    expect(failed!.error).not.toMatch(/api[_ ]?key/i);
    expect(failed!.fromCodeBehind).toBe(true);
    // Nothing healed, so nothing is flagged stale: `healedSteps` /
    // `healedTokens` are counted off this field and must not move.
    expect(failed!.codeBehindStale).toBeUndefined();
    // The failure travels structurally instead, for the sidecar writers — the
    // step still has to be findable by the compile that repairs it
    // (stories/keyless-replay-and-gateway-env.md §Part B).
    expect(failed!.codeBehindHealSkipped).toEqual({
      file: broken.file,
      source: 'Click the "Transfers" tab',
      error: '#transfers-tab went away in a redesign',
    });
    // The entry stays bound — a heal discards it, and this is not a heal.
    expect(broken.entry).toBeDefined();

    // Each step is executed on its own here, and the keyless skip touches only
    // the one whose entry broke: the entries either side still replay as code,
    // with no AI. Whether the RUN goes on past a failed step is the runner's
    // call and keyless does not change it — today both runners stop at the
    // first failure, exactly as they did before this feature.
    expect(first!.status).toBe('passed');
    expect(first!.fromCodeBehind).toBe(true);
    expect(third!.status).toBe('passed');
    expect(third!.fromCodeBehind).toBe(true);
    expect(resolvedParameters).toEqual({ user: 'ada', balance: '1200.00' });

    expect(attempts).toEqual([]);
  });

  it('names the underlying entry failure in the explanation, not in the error', async () => {
    // The error line is what the console, the report row and the client all
    // render, so it stays the instruction. The thrown message is still
    // recoverable — it is what tells the author WHAT to repair.
    const md = await write('transfers.md', TEST_MD);
    await write('transfers.steps.ts', stepsFile('throws'));

    const { steps, registry } = await registryFor(md);
    const { results } = await runAll(steps, registry, forbiddenClient().client, {
      keyless: true,
    });

    expect(results[1]!.aiExplanation).toContain('#transfers-tab went away in a redesign');
    expect(results[1]!.aiExplanation).toContain('no AI configured');
  });

  it('leaves a failed step.expect saying what the assertion said', async () => {
    // The composition, not just the shape: broken code and a failed assertion
    // are different things, and keyless must not flatten the two. A failed
    // assertion never healed in the first place.
    const md = await write('transfers.md', TEST_MD);
    await write('transfers.steps.ts', stepsFile('asserts'));

    const { steps, registry } = await registryFor(md);
    const { client, attempts } = forbiddenClient();
    const { results } = await runAll(steps, registry, client, { keyless: true });

    expect(results[1]!.status).toBe('failed');
    expect(results[1]!.error).toBe('the transfers tab never appeared');
    expect(results[1]!.error).not.toBe(KEYLESS_COPY);
    expect(attempts).toEqual([]);
  });

  it('lets a compile replay keep its own copy when it also runs keyless', async () => {
    // Strict is the explicit mode and it wins: a replay that happens to run on
    // a keyless machine is still a replay, and its message is the one that
    // explains the red step.
    const md = await write('transfers.md', TEST_MD);
    await write('transfers.steps.ts', stepsFile('throws'));

    const { steps, registry } = await registryFor(md);
    const { results } = await runAll(steps, registry, forbiddenClient().client, {
      keyless: true,
      codeBehindStrict: true,
    });

    expect(results[1]!.status).toBe('failed');
    expect(results[1]!.error).toContain('#transfers-tab went away in a redesign');
    expect(results[1]!.error).not.toBe(KEYLESS_COPY);
  });
});

describe('the same broken entry on a machine that HAS a key', () => {
  it('still heals under AI — the keyless branch does not eat the heal path', async () => {
    // The control. Without it, a keyless skip that fired unconditionally would
    // pass every test above while silently ending healing for everyone.
    const md = await write('transfers.md', TEST_MD);
    await write('transfers.steps.ts', stepsFile('throws'));

    const { steps, registry } = await registryFor(md);
    const broken = registry.bindingFor(1)!;
    const { client, calls } = scriptedClient([ACTION_PLAN]);
    const { results } = await runAll(steps, registry, client);

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed', 'passed']);
    expect(calls).toHaveLength(1);
    // Healed: the step ran under AI and is flagged for the next compile.
    expect(results[1]!.fromCodeBehind).toBeUndefined();
    expect(results[1]!.codeBehindStale).toEqual({
      file: broken.file,
      source: 'Click the "Transfers" tab',
      error: '#transfers-tab went away in a redesign',
    });
    expect(broken.entry).toBeUndefined();
  });
});
