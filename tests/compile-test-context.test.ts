import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import {
  compileTest,
  type CompileRunOutcome,
  type CompileRunner,
} from '../src/codebehind/compile.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * A test's own `## Context` on the boxed compile pipeline (issue #36,
 * docs/specs/SPEC-web-survey-fixes.md §2.46).
 *
 * `compileTest` is handed the PROJECT's context, as `runTest` is, and adds the
 * test's own for its generation prompts — the code written from a recording
 * has to know the frame and the selectors the recorded run was told about.
 * Its default runner hands the project's context to `runTest`, which adds the
 * test's block itself, so that block must not reach a run twice.
 *
 * The server's compile route is covered in compile-runner-test-context.test.ts.
 */

/** What the default runner handed `runTest`, one entry per run. */
const runTestCalls = vi.hoisted(() => ({ projectContexts: [] as string[] }));

vi.mock('../src/runner/test-runner.js', () => ({
  runTest: vi.fn(async (_instance: unknown, _config: unknown, projectContext: string): Promise<TestReport> => {
    runTestCalls.projectContexts.push(projectContext);
    // A run that reached nothing: the compile ends red at the recording,
    // which is all this case needs — it is about what the run was handed.
    return {
      status: 'failed',
      error: 'stopped by the test',
      steps: [],
      parameters: {},
      tokensUsed: 0,
    } as unknown as TestReport;
  }),
}));

let tmpBase: string;
let dir: string;
let counter = 0;

beforeAll(async () => {
  tmpBase = await makeScratchBase('compile-test-context');
});

beforeEach(async () => {
  clearSkillCache();
  runTestCalls.projectContexts.length = 0;
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

const CONFIG: Config = { ...DEFAULT_CONFIG };

// Invented names: the framework's tests teach a pattern, not a site's answer.
const CONTEXT_LINE = 'The grid is inside the iframe `#host`. Row ids start at zero, so "row 3" is `#grid_row_2`.';
const PROJECT_CONTEXT = '### Context: app.md\n\nThe app is an inventory tool.';

const WITH_CONTEXT_MD = [
  '# Edit a row',
  '',
  '## Context',
  `- ${CONTEXT_LINE}`,
  '',
  '## Steps',
  '1. Change row 3\'s name to "Ada"',
].join('\n');

const WITHOUT_CONTEXT_MD = [
  '# Edit a row',
  '',
  '## Steps',
  '1. Change row 3\'s name to "Ada"',
].join('\n');

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

/** Every message's text, system prompt included, per AI call. */
function recordingClient(responses: string[]): { client: AiClient; calls: string[] } {
  const calls: string[] = [];
  const text = (m: ChatMessage): string =>
    typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
  const client = {
    complete: async (messages: ChatMessage[]) => {
      calls.push(messages.map(text).join('\n\n'));
      const next = responses.shift();
      if (next === undefined) throw new Error('AI called more times than the test scripted');
      return { text: next, model: 'stub-model' };
    },
  } as unknown as AiClient;
  return { client, calls };
}

/** One entry for the one step. */
const ENTRY = JSON.stringify({
  entry:
    "{\n  source: 'Change row 3\\'s name to \"Ada\"',\n  async run({ page }) {\n" +
    "    await page.frameLocator('#host').locator('#grid_row_2 input').fill('Ada');\n  },\n}",
});

function recordedStep(): StepResult {
  return {
    index: 1,
    instruction: 'Change row 3\'s name to "Ada"',
    status: 'passed',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: new Date().toISOString(),
        aiInteractions: [],
        subActions: [
          {
            index: 1,
            action: { action: 'type', selector: '#grid_row_2 input', value: 'Ada' },
            durationMs: 5,
          },
        ],
      },
    ],
    durationMs: 10,
    retried: false,
    pageUrl: 'https://app.test/grid',
    stepContext: {
      domBefore: '<input id="grid_row_2">',
      urlBefore: 'https://app.test/grid',
      domAfter: '<input id="grid_row_2" value="Ada">',
      urlAfter: 'https://app.test/grid',
    },
  };
}

/** Records once, then fails every replay: generation is what is under test. */
const recordOnly: CompileRunner = async (request): Promise<CompileRunOutcome> =>
  request.purpose === 'record'
    ? { status: 'passed', steps: [recordedStep()], resolvedParameters: {}, tokensUsed: 0 }
    : { status: 'failed', error: 'replay not under test', steps: [], resolvedParameters: {}, tokensUsed: 0 };

describe("compileTest's generation prompt", () => {
  it("carries the test's ## Context after the project's", async () => {
    const test = await parseTestFile(await write('grid.md', WITH_CONTEXT_MD));
    const { client, calls } = recordingClient([ENTRY, ENTRY, ENTRY, ENTRY, ENTRY, ENTRY, ENTRY, ENTRY]);

    await compileTest({
      test, config: CONFIG, contextContent: PROJECT_CONTEXT, aiClient: client,
      runner: recordOnly, maxRounds: 1, dryRun: true,
    });

    // The first call is Generate for step 1.
    const generate = calls[0]!;
    expect(generate).toContain(CONTEXT_LINE);
    expect(generate).toContain("### Context: this test (from the test file's ## Context");
    // The project's context still leads; the test's block is the most specific.
    expect(generate.indexOf(PROJECT_CONTEXT)).toBeGreaterThanOrEqual(0);
    expect(generate.indexOf(PROJECT_CONTEXT)).toBeLessThan(generate.indexOf(CONTEXT_LINE));
  });

  it('is unchanged for a test without ## Context', async () => {
    const test = await parseTestFile(await write('grid.md', WITHOUT_CONTEXT_MD));
    const { client, calls } = recordingClient([ENTRY, ENTRY, ENTRY, ENTRY, ENTRY, ENTRY, ENTRY, ENTRY]);

    await compileTest({
      test, config: CONFIG, contextContent: PROJECT_CONTEXT, aiClient: client,
      runner: recordOnly, maxRounds: 1, dryRun: true,
    });

    expect(calls[0]).toContain(PROJECT_CONTEXT);
    expect(calls[0]).not.toContain('### Context: this test');
  });
});

describe("compileTest's default runner", () => {
  it("hands runTest the project's context, which adds the test's own once", async () => {
    const test = await parseTestFile(await write('grid.md', WITH_CONTEXT_MD));
    const { client } = recordingClient([]);

    await compileTest({
      test, config: CONFIG, contextContent: PROJECT_CONTEXT, aiClient: client, dryRun: true,
    });

    // `runTest` composes `withTestContext(projectContext, test.context)` for
    // every step. Handed the already-combined text, its prompts would carry
    // the test's block twice.
    expect(runTestCalls.projectContexts).toEqual([PROJECT_CONTEXT]);
  });
});
