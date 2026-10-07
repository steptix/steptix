import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, BrowserContext, Browser } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { buildStepCodePrompt, contentBlocksToText, offersSelfCheck } from '../src/ai/prompts.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { buildCodeBehindRegistry, type CodeBehindBinding } from '../src/codebehind/loader.js';
import { buildFileReviewPrompt } from '../src/codebehind/review.js';
import {
  CodeBehindCheckError,
  CodeBehindExpectationError,
  runCodeBehindCondition,
  runCodeBehindEntry,
} from '../src/codebehind/execute.js';
import { selfCheckInActingEntryComplaint, unwaitedReadComplaint } from '../src/codebehind/generate.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * `step.check` — a failed self-check in an entry that takes no action heals
 * (docs/specs/SPEC-codebehind-robustness.md §6.5, D4).
 *
 * Failure B's entry checked its own read with `step.expect` — one name per
 * account row — and when a rewrite had made the read wrong, that check turned
 * a code fault into a red run that nothing repaired. `step.check` is the same
 * check with the code's own failure semantics: the step re-runs under AI, the
 * entry is flagged stale, and the next compile regenerates it. In an entry that
 * acts it fails like `step.expect`, because a heal after a click re-runs the
 * click.
 */

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<html><body>dom</body></html>') };
});
vi.mock('../src/browser/screenshot.js', () => ({ captureScreenshot: async () => null }));
vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) =>
      action.action === 'read'
        ? { success: true, capturedValues: ['Everyday', 'Savings', 'Travel'] }
        : { success: true },
    ),
  };
});

import { executeStep } from '../src/runner/step-executor.js';

let tmpBase: string;
let counter = 0;
let dir: string;
beforeAll(async () => {
  tmpBase = await makeScratchBase('self-check');
});
beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await removeScratchBase(tmpBase);
});

const READ_STEP = 'Read the name of every account [store as: accounts]';
/** Failure B's outcome, as a check: six names for three rows. */
const WRONG_READ_BODY = "const names = ['Everyday', '4417', 'Savings', '8812', 'Travel', '2291']; " +
  "step.check(names.length === 3, `one name per account row (${names.length} names for 3 rows)`); " +
  "step.setVar('accounts', JSON.stringify(names));";

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'http://localhost:8787/control-flow.html',
    title: async () => 'Control flow',
    click: async () => {},
    context: () => ({ browser: () => ({}) }),
    evaluate: async () => {
      throw new Error('no DOM in this test');
    },
    screenshot: async () => Buffer.alloc(24),
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

/** A model that answers the healed step with the read the run made. */
function healingModel(): AiClient & { calls: number } {
  const client = {
    calls: 0,
    complete: async () => {
      client.calls++;
      return {
        text: JSON.stringify({
          actions: [{ action: 'read', multiple: true, selector: '.account-name', as: 'accounts', description: 'Read the names' }],
          reasoning: 'read',
          needs_reeval: false,
        }),
        model: 'stub',
      };
    },
  };
  return client as unknown as AiClient & { calls: number };
}

async function bindingFor(body: string, source = READ_STEP): Promise<{ binding: CodeBehindBinding; step: string }> {
  const md = path.join(dir, 'accounts.md');
  await fs.writeFile(md, ['# Accounts', '', '## Steps', `1. ${source}`, ''].join('\n'), 'utf-8');
  await fs.writeFile(
    path.join(dir, 'accounts.steps.ts'),
    `import { defineSteps } from 'steptix/codebehind';\nexport default defineSteps([\n  { source: ${JSON.stringify(source)}, async run({ page, step }) { ${body} } },\n]);\n`,
    'utf-8',
  );
  const parsed = await parseTestFile(md);
  const registry = await buildCodeBehindRegistry(
    { steps: parsed.steps, rawSteps: parsed.expansion!.rawSteps, origins: parsed.expansion!.origins, frames: parsed.expansion!.frames },
    { testFilePath: parsed.filePath, onWarn: () => {} },
  );
  return { binding: registry.bindingFor(0)!, step: parsed.steps[0]! };
}

async function run(body: string, extra: Record<string, unknown> = {}, client: AiClient = healingModel()) {
  const { binding, step } = await bindingFor(body);
  const result = await executeStep(1, 1, step, {
    page: fakePage(),
    config: CONFIG,
    aiClient: client,
    contextContent: '',
    testName: 'accounts',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    codeBehind: binding,
    ...extra,
  });
  return { result, binding };
}

describe('step.check in an entry that takes no action', () => {
  it('heals on a normal run: the step re-runs under AI, passes, and the entry is flagged stale', async () => {
    const client = healingModel();
    const { result, binding } = await run(WRONG_READ_BODY, {}, client);
    expect(result.status).toBe('passed');
    expect(client.calls).toBe(1);
    expect(result.codeBehindStale?.error).toBe('Self-check failed: one name per account row (6 names for 3 rows)');
    // Discarded for the rest of the run, as any broken entry is.
    expect(binding.entry).toBeUndefined();
  });

  it('is red under a strict replay — compile proves code, it does not heal it', async () => {
    const { result } = await run(WRONG_READ_BODY, { codeBehindStrict: true }, forbidden());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Self-check failed: one name per account row (6 names for 3 rows)');
    expect(result.codeBehindStale).toBeUndefined();
  });

  it('is not healed on a keyless run, and says so for the next compile', async () => {
    const { result } = await run(WRONG_READ_BODY, { keyless: true }, forbidden());
    expect(result.status).toBe('failed');
    expect(result.codeBehindHealSkipped?.error).toBe('Self-check failed: one name per account row (6 names for 3 rows)');
  });

  it('passes quietly when it holds', async () => {
    const { result } = await run(
      "const names = ['Everyday', 'Savings', 'Travel']; step.check(names.length === 3, 'one per row'); step.setVar('accounts', JSON.stringify(names));",
      {},
      forbidden(),
    );
    expect(result.status).toBe('passed');
    expect(result.fromCodeBehind).toBe(true);
    expect(result.outputs).toEqual({ accounts: '["Everyday","Savings","Travel"]' });
  });
});

describe('step.check in an entry that acts', () => {
  it('fails the step without healing — a re-run after a click would click twice', async () => {
    const { result, binding } = await run(
      "await page.click('#sign-in-btn'); step.check(false, 'the dashboard loaded');",
      {},
      forbidden(),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Self-check failed: the dashboard loaded');
    expect(result.codeBehindStale).toBeUndefined();
    expect(binding.entry).toBeDefined();
  });

  it('counts a helper call as acting', async () => {
    const { result } = await run(
      "const submit = async () => { await page.click('#go'); }; await submit(); step.check(false, 'submitted');",
      {},
      forbidden(),
    );
    expect(result.status).toBe('failed');
    expect(result.codeBehindStale).toBeUndefined();
  });
});

describe('step.expect is unchanged', () => {
  it('a failed expectation fails the step, read-only entry or not', async () => {
    const { result } = await run("step.expect(false, 'the total is $4.00');", {}, forbidden());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('the total is $4.00');
    expect(result.codeBehindStale).toBeUndefined();
  });
});

describe('step.check in a condition entry', () => {
  it('is a throw like any other: broken code, which the guard heals', async () => {
    const outcome = await runCodeBehindCondition({
      binding: {
        file: path.join(dir, 'x.steps.ts'),
        source: 'While the Next button is enabled, Go to the next page',
        occurrence: 0,
        scope: { renames: {}, inputs: {} },
        entry: {
          source: 'While the Next button is enabled, Go to the next page',
          condition({ step }) {
            step.check(false, 'the pager was on the page');
            return true;
          },
        },
      },
      page: {} as Page,
      context: {} as BrowserContext,
      browser: {} as Browser,
      resolvedParameters: {},
      label: 'test',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.expectationFailed).toBe(false);
    expect(outcome.nonRetryable).toBeUndefined();
    expect(outcome.error).toBe('Self-check failed: the pager was on the page');
  });
});

describe('the error classes', () => {
  it('a self-check failure is not an expectation failure', async () => {
    const outcome = await runCodeBehindEntry({
      binding: {
        file: path.join(dir, 'x.steps.ts'),
        source: READ_STEP,
        occurrence: 0,
        scope: { renames: {}, inputs: {} },
        entry: { source: READ_STEP, run({ step }) { step.check(false); } },
      },
      page: {} as Page,
      context: {} as BrowserContext,
      browser: {} as Browser,
      resolvedParameters: {},
      label: 'test',
    });
    expect(outcome.expectationFailed).toBe(false);
    expect(outcome.error).toBe("Self-check failed: the entry's own check");
    expect(new CodeBehindCheckError('x')).not.toBeInstanceOf(CodeBehindExpectationError);
  });
});

describe('compile: where step.check belongs', () => {
  it('refuses step.check in an entry that acts, and lets it be in one that only reads', () => {
    expect(
      selfCheckInActingEntryComplaint("{ source: 'x', async run({ page, step }) { await page.click('#go'); step.check(true, 'x'); } }"),
    ).toMatch(/calls `step\.check` and also acts on the page \(`\.click\(`\)/);
    expect(
      selfCheckInActingEntryComplaint(
        "{ source: 'x', async run({ page, step }) { const n = await page.locator('li').count(); step.check(n > 0, 'rows'); } }",
      ),
    ).toBeUndefined();
  });

  it('counts step.check as an assertion for the wait check', () => {
    expect(
      unwaitedReadComplaint(
        "{ source: 'x', async run({ page, step }) { await page.click('#go'); step.check((await page.title()) === 'x', 'x'); } }",
      ),
    ).toBeDefined();
  });

  it('offers step.check only to a step whose actions all read, count or explore', () => {
    expect(offersSelfCheck([{ action: 'read' }, { action: 'find' }])).toBe(true);
    expect(offersSelfCheck([{ action: 'count' }])).toBe(true);
    expect(offersSelfCheck([{ action: 'click' }, { action: 'read' }])).toBe(false);
    expect(offersSelfCheck([{ action: 'read' }, { action: 'assert' }])).toBe(false);
    expect(offersSelfCheck([{ action: 'find' }])).toBe(false);

    const reads = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: READ_STEP,
        parameters: [],
        actions: [{ action: 'read', multiple: true, selector: '.account-name', as: 'accounts' }],
      }).content,
    );
    expect(reads).toContain('`step.check(condition, message)` — a self-check on your OWN read');
    expect(reads).toContain('In this step, write that check as `step.check(condition, message)`');
    const acts = contentBlocksToText(
      buildStepCodePrompt({ rawStepText: 'Click Go', parameters: [], actions: [{ action: 'click', selector: '#go' }] }).content,
    );
    expect(acts).not.toContain('step.check');
  });

  it('tells Review about step.check only for a file that uses it', () => {
    const uses = buildFileReviewPrompt({ markdownName: 'a.md', file: "step.check(n > 0, 'rows')", steps: [READ_STEP] }).content as string;
    expect(uses).toContain('makes about its own read is `step.check(…)`');
    const none = buildFileReviewPrompt({ markdownName: 'a.md', file: "step.expect(n > 0, 'rows')", steps: [READ_STEP] }).content as string;
    expect(none).not.toContain('step.check');
  });
});

function forbidden(): AiClient {
  return {
    complete: async () => {
      throw new Error('the AI must not be called for this step');
    },
  } as unknown as AiClient;
}
