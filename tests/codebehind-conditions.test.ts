import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, BrowserContext, Browser } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { buildCodeBehindRegistry, type CodeBehindBinding } from '../src/codebehind/loader.js';
import {
  entrySourceText,
  EXIT_NOT_CLAIMED,
  runCodeBehindCondition,
  runCodeBehindEntry,
} from '../src/codebehind/execute.js';
import type { CodeBehindContext, StepCodeEntry } from '../src/codebehind/types.js';
import { executeStep } from '../src/runner/step-executor.js';
import { logger } from '../src/utils/logger.js';

/**
 * The `condition` entry (stories/codebehind-loops-and-conditions.md,
 * decisions 4 and 7, "The entry, loading and running it").
 *
 * A condition line — `If`, `Else if`, `While`, `Repeat … until` — gets an entry
 * whose `condition` answers true or false. This file covers the entry itself:
 * what the loader keeps, what running one returns, and what happens when one
 * lands on a line that is not a condition. What a GUARD does with the answer is
 * tests/guard-condition-codebehind.test.ts.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-conditions');

const noPage = {} as unknown as Page;
const noContext = {} as unknown as BrowserContext;
const noBrowser = {} as unknown as Browser;

let counter = 0;
let dir: string;

beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
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

async function registryFor(testPath: string, warnings: string[] = [], skillsDir?: string) {
  const parsed = await parseTestFile(testPath, skillsDir ? { skillsDir } : {});
  const registry = await buildCodeBehindRegistry(
    {
      steps: parsed.steps,
      rawSteps: parsed.expansion!.rawSteps,
      origins: parsed.expansion!.origins,
      frames: parsed.expansion!.frames,
    },
    { testFilePath: parsed.filePath, onWarn: (m) => warnings.push(m) },
  );
  return { steps: parsed.steps, registry };
}

const WHILE_LINE = 'While the Next button is enabled, Go to the next page';
const LOOP_MD = [
  '# Statements',
  '',
  '## Steps',
  '1. Open the statements page',
  `2. ${WHILE_LINE}`,
  '3. Verify the last page is shown',
].join('\n');

// ─── Loading ────────────────────────────────────────────────────────────────

describe('loading a condition entry', () => {
  it('keeps an entry that has only a `condition`, bound by its whole line', async () => {
    const md = await write('statements.md', LOOP_MD);
    await write('statements.steps.ts', `export default [
  {
    source: ${JSON.stringify(WHILE_LINE)},
    async condition({ page }) { return page.url().includes('page=1'); },
  },
];
`);
    const warnings: string[] = [];
    const { steps, registry } = await registryFor(md, warnings);
    const index = steps.indexOf(WHILE_LINE);
    const entry = registry.bindingFor(index)?.entry;
    expect(typeof entry?.condition).toBe('function');
    expect(entry?.run).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('drops an entry with both `run` and `condition`, saying why', async () => {
    const md = await write('statements.md', LOOP_MD);
    await write('statements.steps.ts', `export default [
  {
    source: ${JSON.stringify(WHILE_LINE)},
    async run() {},
    async condition() { return true; },
  },
];
`);
    const warnings: string[] = [];
    const { steps, registry } = await registryFor(md, warnings);
    expect(registry.bindingFor(steps.indexOf(WHILE_LINE))?.entry).toBeUndefined();
    expect(warnings.some((w) => w.includes('has both a `run` and a `condition` function'))).toBe(true);
  });

  it('still drops a half-written entry, and names `condition` among the ways to finish it', async () => {
    const md = await write('statements.md', LOOP_MD);
    await write('statements.steps.ts', `export default [{ source: 'Open the statements page' }];\n`);
    const warnings: string[] = [];
    const { registry } = await registryFor(md, warnings);
    expect(registry.bindingFor(0)?.entry).toBeUndefined();
    expect(warnings.some((w) => w.includes('a `condition` function'))).toBe(true);
  });
});

// ─── Running one ────────────────────────────────────────────────────────────

function bare(condition: StepCodeEntry['condition']): CodeBehindBinding {
  return {
    file: path.join(dir, 'x.steps.ts'),
    source: WHILE_LINE,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
    entry: { source: WHILE_LINE, ...(condition && { condition }) },
  };
}

async function runCondition(
  condition: (ctx: CodeBehindContext) => unknown,
  parameters: Record<string, string> = {},
) {
  return runCodeBehindCondition({
    binding: bare(condition as StepCodeEntry['condition']),
    page: noPage,
    context: noContext,
    browser: noBrowser,
    resolvedParameters: parameters,
    label: 'condition:2',
  });
}

describe('runCodeBehindCondition', () => {
  it('returns the answer, true or false', async () => {
    const yes = await runCondition(async () => true);
    expect(yes).toMatchObject({ status: 'passed', value: true, expectationFailed: false });
    const no = await runCondition(() => false);
    expect(no).toMatchObject({ status: 'passed', value: false });
    expect(no.error).toBeUndefined();
  });

  it('reads variables through the same step API as a run entry', async () => {
    const out = await runCondition(({ step }) => step.getVar('plan') === 'pro', { plan: 'pro' });
    expect(out.value).toBe(true);
  });

  it.each([
    [undefined, 'returned undefined; a condition must return true or false'],
    [null, 'returned null; a condition must return true or false'],
    ['yes', 'returned a string; a condition must return true or false'],
    [1, 'returned a number; a condition must return true or false'],
    [{ held: true }, 'returned an object; a condition must return true or false'],
  ])('treats %o as broken code, never coerced', async (value, error) => {
    const out = await runCondition(async () => value);
    expect(out.status).toBe('failed');
    expect(out.value).toBeUndefined();
    expect(out.error).toBe(error);
    expect(out.expectationFailed).toBe(false);
    expect(out.nonRetryable).toBeUndefined();
  });

  it('never puts the returned VALUE in the message — it can be a piece of the page', async () => {
    const out = await runCondition(async () => 'Balance: $4,210.77');
    expect(out.error).not.toContain('4,210');
  });

  it('reports a throw as broken code', async () => {
    const out = await runCondition(async () => { throw new Error('locator resolved to 2 elements'); });
    expect(out).toMatchObject({
      status: 'failed',
      expectationFailed: false,
      error: 'locator resolved to 2 elements',
    });
    expect(out.nonRetryable).toBeUndefined();
  });

  it('reports step.expect and step.fail as real failures', async () => {
    const expected = await runCondition(({ step }) => { step.expect(false, 'no list'); return true; });
    expect(expected).toMatchObject({ status: 'failed', expectationFailed: true, error: 'no list' });
    expect(expected.deliberate).toBeUndefined();

    const failed = await runCondition(({ step }) => step.fail('nothing to page through'));
    expect(failed).toMatchObject({ status: 'failed', expectationFailed: true, deliberate: true });
  });

  it('refuses step.exit(): a condition answers, it does not end the flow', async () => {
    const out = await runCondition(({ step }) => step.exit());
    expect(out.status).toBe('failed');
    expect(out.nonRetryable).toBe(true);
    expect(out.nonRetryableKind).toBe('exit-unclaimed');
    expect(out.error).toBe(EXIT_NOT_CLAIMED);
  });

  it('captures what the entry logged', async () => {
    const out = await runCondition(({ log }) => { log.info('checked Next'); return true; });
    expect(out.logs).toEqual([{ level: 'info', message: 'checked Next' }]);
  });

  it('entrySourceText shows a condition function, not "(no run function)"', () => {
    const text = entrySourceText({
      source: WHILE_LINE,
      async condition({ page }) { return page.url().length > 0; },
    });
    expect(text).toContain('condition');
    expect(text).not.toBe('(no run function)');
  });
});

// ─── In the wrong place ──────────────────────────────────────────────────────

/** Enough `Page` for the executor's bookkeeping; nothing here touches a DOM. */
function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/statements',
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

describe('a condition entry bound to an ordinary step', () => {
  it('is not run: the step runs under AI, nothing is stale, and the author is told once', async () => {
    const md = await write('statements.md', LOOP_MD);
    await write('statements.steps.ts', `export default [
  {
    source: 'Open the statements page',
    async condition() { globalThis.__conditionRan = (globalThis.__conditionRan ?? 0) + 1; return true; },
  },
];
`);
    const { steps, registry } = await registryFor(md);
    const binding = registry.bindingFor(0)!;
    expect(typeof binding.entry?.condition).toBe('function');

    const calls: ChatMessage[][] = [];
    const client = {
      complete: async (messages: ChatMessage[]) => {
        calls.push(messages);
        return {
          text: JSON.stringify({
            reasoning: 'Opened it',
            actions: [{ action: 'noop', description: 'already there' }],
          }),
          model: 'stub-model',
        };
      },
    } as unknown as AiClient;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const run = () =>
      executeStep(1, steps.length, steps[0]!, {
        page: fakePage(),
        config: CONFIG,
        aiClient: client,
        contextContent: '',
        testName: 'statements',
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters: {},
        codeBehind: binding,
      });

    const first = await run();
    const second = await run();

    for (const result of [first, second]) {
      expect(result.status).toBe('passed');
      expect(result.fromCodeBehind).toBeUndefined();
      expect(result.codeBehindStale).toBeUndefined();
    }
    // The AI flow ran both times; the entry did not.
    expect(calls).toHaveLength(2);
    const ran = (globalThis as { __conditionRan?: number }).__conditionRan ?? 0;
    expect(ran).toBe(0);
    // Not discarded — it is not broken, only in the wrong place.
    expect(binding.entry).toBeDefined();
    const said = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('a condition entry is bound to a step that is not a condition line — the step runs under AI'));
    expect(said).toHaveLength(1);
  });

  it('leaves a run entry on an ordinary step exactly as before', async () => {
    const out = await runCodeBehindEntry({
      binding: {
        file: path.join(dir, 'x.steps.ts'),
        source: 'Open the statements page',
        occurrence: 0,
        scope: { renames: {}, inputs: {} },
        entry: { source: 'Open the statements page', run: () => {} },
      },
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: {},
      label: 't',
    });
    expect(out.status).toBe('passed');
  });
});

// ─── getVar through a renamed root ───────────────────────────────────────────

describe('step.getVar on a dotted name whose root the frame renames', () => {
  /** A skill whose `For each` item the expander rewrites to `__skill<N>_order`. */
  const REVIEW_SKILL = [
    '---', 'type: skill', '---', '# review', '',
    '## Steps',
    '1. Read the orders [store as: orders]',
    '2. For each {{order}} in {{orders}}, Open the order {{order.id}}',
  ].join('\n');

  async function tailBinding(): Promise<CodeBehindBinding> {
    await write('skills/review.md', REVIEW_SKILL);
    const md = await write('t.md', ['# T', '', '## Steps', '1. [skill: review]'].join('\n'));
    const { steps, registry } = await registryFor(md, [], path.join(dir, 'skills'));
    const index = steps.findIndex((s) => s.startsWith('Open the order'));
    return registry.bindingFor(index)!;
  }

  async function read(binding: CodeBehindBinding, name: string, parameters: Record<string, string>) {
    let seen: string | undefined = 'unset';
    const out = await runCodeBehindEntry({
      binding: { ...binding, entry: { source: binding.source, run: ({ step }) => { seen = step.getVar(name); } } },
      page: noPage,
      context: noContext,
      browser: noBrowser,
      resolvedParameters: parameters,
      label: 't',
    });
    expect(out.status).toBe('passed');
    return seen;
  }

  it('reads `order.id` from the scoped key the pass bound', async () => {
    const binding = await tailBinding();
    const scoped = binding.scope.renames['order']!;
    expect(scoped).toMatch(/^__skill\d+_order$/);
    const seen = await read(binding, 'order.id', {
      [scoped]: '{"id":"ORD-7"}',
      [`${scoped}.id`]: 'ORD-7',
    });
    expect(seen).toBe('ORD-7');
  });

  it('lets a map that binds the whole dotted name win', async () => {
    const binding = await tailBinding();
    const scoped = binding.scope.renames['order']!;
    const seen = await read(binding, 'order.id', { 'order.id': 'bare', [`${scoped}.id`]: 'scoped' });
    expect(seen).toBe('bare');
  });

  it('answers undefined for a property the pass did not bind', async () => {
    const binding = await tailBinding();
    const scoped = binding.scope.renames['order']!;
    expect(await read(binding, 'order.note', { [`${scoped}.id`]: 'ORD-7' })).toBeUndefined();
  });

  it('works on a hand-built scope too, and never through a prototype key', async () => {
    const binding: CodeBehindBinding = {
      file: path.join(dir, 'x.steps.ts'),
      source: 'x',
      occurrence: 0,
      scope: { renames: { order: '__skill3_order' }, inputs: {} },
    };
    expect(await read(binding, 'order.id', { '__skill3_order.id': 'A' })).toBe('A');
    expect(await read(binding, 'constructor.name', {})).toBeUndefined();
    // A flat name keeps its own rule — the rename, not a dotted lookup.
    expect(await read(binding, 'order', { __skill3_order: 'flat' })).toBe('flat');
  });
});
