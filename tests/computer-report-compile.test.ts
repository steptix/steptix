/**
 * What a computer-mode run leaves behind — SPEC-use-computer.md §9 and §10.1.
 *
 * Three consumers of the one new fact on a `StepResult` (`surface`):
 *
 *  - the REPORT, which renders a `[use …]` row as a mode marker and a
 *    computer-mode turn with the capture the model saw and a ring where the
 *    pointer went;
 *  - the RECORDING, which stamps the surface so a later compile can read it;
 *  - the COMPILE, which answers `computer` with `ai: true` and the reason,
 *    because a coordinate is specific to one machine.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiClient } from '../src/ai/client.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult, TurnResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import {
  compileTest,
  type CompileEvent,
  type CompileRunOutcome,
  type CompileRunner,
} from '../src/codebehind/compile.js';
import { COMPUTER_MODE_STAYS_AI, generationRefusal } from '../src/codebehind/live-compile.js';
import { readRecording, writeRecording } from '../src/codebehind/recording.js';
import { renderStep, renderModeStep } from '../src/report/generator.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-computer-report-compile');
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

// A 1×1 PNG, so the assertions are about the wiring rather than about jimp.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// §10.1 — the report
// ---------------------------------------------------------------------------

describe('a [use …] row renders as a mode marker (§10.1)', () => {
  const modeStep = (surface: 'browser' | 'computer'): StepResult => ({
    index: 3,
    instruction: `[use ${surface}]`,
    status: 'passed',
    stepKind: 'mode',
    surface,
    turns: [],
    durationMs: 0,
    retried: false,
    aiExplanation: `Switched to the ${surface} surface.`,
  });

  it('shows the arrow and none of the ordinary step chrome', () => {
    const html = renderStep(modeStep('computer'));

    expect(html).toContain('step-mode');
    expect(html).toContain('→ computer');
    expect(html).toContain('[use computer]');
    // Not a step that passed: no ✓ badge, no duration, and no "screenshot not
    // captured" placeholder answering a question this line never asked.
    expect(html).not.toContain('badge-pass');
    expect(html).not.toContain('Screenshot not captured');
    expect(html).not.toContain('step-chevron');
  });

  it('points the other way for [use browser]', () => {
    expect(renderModeStep(modeStep('browser'), 'Step 9')).toContain('→ browser');
  });

  it('keeps the message when a precondition refused the switch', () => {
    const html = renderStep({
      ...modeStep('computer'),
      status: 'failed',
      error: 'computer mode is disabled for this project; set `desktop.enabled: true` in aiui.config.json',
    });

    expect(html).toContain('step-mode-failed');
    expect(html).toContain('desktop.enabled');
  });
});

describe('a computer-mode turn shows what the model saw (§10.1, §10.2)', () => {
  const turn = (computer: TurnResult['computer']): StepResult => ({
    index: 4,
    instruction: 'Click the Cancel button in the Print dialog',
    status: 'passed',
    surface: 'computer',
    turns: [
      {
        turnNumber: 1,
        attemptNumber: 1,
        timestamp: new Date().toISOString(),
        aiInteractions: [],
        subActions: [],
        ...(computer && { computer }),
      },
    ],
    durationMs: 12,
    retried: false,
  });

  it('embeds the capture and rings the pointer', () => {
    const html = renderStep(
      turn({
        screenshotBase64: PNG,
        imageWidth: 1600,
        imageHeight: 900,
        kind: 'full',
        imagePoint: { x: 800, y: 450 },
        screenPoint: { x: 1720, y: 968 },
      }),
    );

    expect(html).toContain('computer-screenshot');
    expect(html).toContain(`data:image/png;base64,${PNG}`);
    expect(html).toContain('computer-click-ring');
    // Positioned as a percentage of the image, which is the space the recorded
    // PNG is in — 800/1600 and 450/900.
    expect(html).toContain('left:50.000%');
    expect(html).toContain('top:50.000%');
    // Both numbers §10.2's log line prints are in the tooltip.
    expect(html).toContain('image(800,450)');
    expect(html).toContain('screen(1720,968)');
  });

  it('labels a zoomed turn as zoomed', () => {
    const html = renderStep(
      turn({ screenshotBase64: PNG, imageWidth: 1600, imageHeight: 900, kind: 'zoom' }),
    );

    expect(html).toContain('ZOOMED view');
  });

  it('says WHY there is no image when reportScreenshots is off', () => {
    const html = renderStep(turn({ imageWidth: 1600, imageHeight: 900, kind: 'full' }));

    expect(html).not.toContain('computer-click-ring');
    expect(html).toContain('desktop.reportScreenshots');
    expect(html).toContain('the whole screen');
  });

  it('a page-surface turn is untouched', () => {
    const html = renderStep(turn(undefined));

    expect(html).not.toContain('computer-screenshot');
    expect(html).not.toContain('computer-click-ring');
  });
});

// ---------------------------------------------------------------------------
// §9 — the recording and the compile
// ---------------------------------------------------------------------------

describe('the recording stamps the surface (§9)', () => {
  it('writes `computer` and leaves a browser step unmarked', async () => {
    const testFile = await write('pdf.md', '# PDF\n\n## Steps\n1. a\n2. b\n');
    const steps: StepResult[] = [
      { index: 1, instruction: 'Navigate to statement.pdf', status: 'passed', turns: [], durationMs: 1, retried: false },
      { index: 2, instruction: 'Click the Print button', status: 'passed', surface: 'computer', turns: [], durationMs: 1, retried: false },
    ];

    await writeRecording(testFile, {
      steps,
      status: 'passed',
      startedAt: new Date().toISOString(),
      parameters: {},
      source: 'cli',
    });

    const recording = await readRecording(testFile);
    expect(recording!.steps[0]!.surface).toBeUndefined();
    expect(recording!.steps[1]!.surface).toBe('computer');
  });
});

describe('a computer-mode step compiles to `ai: true` (§9)', () => {
  it('generationRefusal answers with the reason, before any model call', () => {
    expect(
      generationRefusal({
        text: 'Click the Print button in the PDF viewer toolbar',
        status: 'passed',
        surface: 'computer',
        binding: { file: '/tmp/x.steps.ts', source: 'Click the Print button' } as never,
      }),
    ).toBe(COMPUTER_MODE_STAYS_AI);
    expect(COMPUTER_MODE_STAYS_AI).toBe('computer-mode step; coordinates are not portable');
  });

  it('the boxed pipeline writes the entry and never asks the model about it', async () => {
    const md = await write(
      'pdf.md',
      ['# PDF', '', '## Steps', '1. Enter the booking code', '2. Click Save in the dialog'].join('\n'),
    );
    const test = await parseTestFile(md);

    const prompts: string[] = [];
    const responses = [
      // Step 1 only: step 2 ran in computer mode and must never be asked about.
      JSON.stringify({
        entry: `{\n  source: 'Enter the booking code',\n  async run({ page }) {\n    await page.locator('#code').waitFor();\n  },\n}`,
      }),
      '<<echo>>',
    ];
    const client = {
      complete: async (messages: ChatMessage[]) => {
        const last = messages[messages.length - 1];
        const prompt = typeof last?.content === 'string'
          ? last.content
          : (last?.content ?? []).map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
        prompts.push(prompt);
        const text = responses.shift();
        if (text === undefined) throw new Error('AI called more times than the test scripted');
        if (text === '<<echo>>') {
          const file = /```ts\n([\s\S]*?)```/.exec(prompt)?.[1];
          if (!file) throw new Error('review prompt carried no file to echo');
          return { text: JSON.stringify({ file }), model: 'stub' };
        }
        return { text, model: 'stub' };
      },
    } as unknown as AiClient;

    const recorded: CompileRunOutcome = {
      status: 'passed',
      steps: [
        {
          index: 1,
          instruction: 'Enter the booking code',
          status: 'passed',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                { index: 1, action: { action: 'type', selector: '#code', value: '220826' }, durationMs: 1 },
              ],
            },
          ],
          durationMs: 2,
          retried: false,
        },
        {
          index: 2,
          instruction: 'Click Save in the dialog',
          status: 'passed',
          surface: 'computer',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                { index: 1, action: { action: 'click' } as never, durationMs: 1 },
              ],
            },
          ],
          durationMs: 2,
          retried: false,
        },
      ],
      resolvedParameters: {},
      tokensUsed: 0,
    };

    const events: CompileEvent[] = [];
    const runner: CompileRunner = async (request) => {
      if (request.purpose === 'record') return recorded;
      return {
        status: 'passed',
        steps: [
          { index: 1, instruction: 'Enter the booking code', status: 'passed', turns: [], durationMs: 1, retried: false, fromCodeBehind: true },
          { index: 2, instruction: 'Click Save in the dialog', status: 'passed', turns: [], durationMs: 1, retried: false },
        ],
        resolvedParameters: {},
        tokensUsed: 0,
      };
    };

    const result = await compileTest({
      test,
      config: { ...DEFAULT_CONFIG } as Config,
      contextContent: '',
      aiClient: client,
      runner,
      onEvent: (e) => events.push(e),
    });

    const written = await fs.readFile(path.join(dir, 'pdf.steps.ts'), 'utf-8');
    expect(written).toContain(`source: 'Click Save in the dialog'`);
    expect(written).toContain('ai: true');
    expect(written).toContain(COMPUTER_MODE_STAYS_AI);
    // The reason is in the compile report, on the step it belongs to.
    expect(
      events.find(
        (e) => e.kind === 'step' && e.step === 2 && e.message === COMPUTER_MODE_STAYS_AI,
      ),
    ).toBeDefined();
    // Two model calls for a two-step test: ONE generation (step 1) and the
    // review. Step 2 was answered without asking — which is the point, since
    // what it would be asked to write is a coordinate.
    //
    // Counted rather than matched on text: step 1's generation prompt carries
    // the WHOLE test for context, so step 2's words are in it either way.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Enter the booking code');
    expect(result.summary.keptAi).toBeGreaterThanOrEqual(1);
  });
});
