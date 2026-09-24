import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiClient } from '../src/ai/client.js';
import type { Config } from '../src/config/types.js';
import type { CodeBehindBinding } from '../src/codebehind/loader.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { parseSkillFile, parseTestContent, parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { identifyStepGroups } from '../src/runner/step-grouper.js';
import { stepReadsScreen } from '../src/runner/computer-step.js';
import { generationRefusal } from '../src/codebehind/live-compile.js';
import {
  refuseReason,
  SET_STEP_NOT_COMPILED,
  USE_AI_NOT_COMPILED,
} from '../src/codebehind/generate.js';
import { compileTest } from '../src/codebehind/compile.js';
import { assembleSteps } from '../src/mcp/assemble.js';
import { resolveProject } from '../src/mcp/project.js';

/**
 * `[use ai] <step>` where a FILE is read, and where the step's text is judged
 * without being run (stories/use-ai-step.md §Tests): the markdown parser, the
 * skill-body rule, the conditional grouper, the computer lock's predicate, the
 * three compile classifiers, and the MCP pre-flight.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-use-ai-step');
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

const doc = (...steps: string[]) =>
  ['# T', '', '## Steps', ...steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');

// ---------------------------------------------------------------------------
// The markdown parser
// ---------------------------------------------------------------------------

describe('the markdown parser', () => {
  it('accepts a [use ai] step in the main flow and in a section body, as written', () => {
    const text = [
      '# T',
      '',
      '## Steps',
      '1. [use ai] Create a name starting with "AUTO" and store it in random_name',
      '2. Make a note',
      '',
      '### Make a note',
      '1. [use ai] Write one sentence about {{random_name}} [store as: note]',
      '',
    ].join('\n');
    const parsed = parseTestContent(text, 'tests/t.md');
    expect(parsed.steps[0]).toBe(
      '[use ai] Create a name starting with "AUTO" and store it in random_name',
    );
    expect(parsed.sections['make a note']!.steps).toEqual([
      '[use ai] Write one sentence about {{random_name}} [store as: note]',
    ]);
  });

  it('refuses each misuse before any browser opens, with the grammar\'s message', () => {
    const cases: [string, RegExp][] = [
      ['[use ai]', /needs a step after it/],
      ['[use ai timeout=30] Write a line', /takes no arguments/],
      ['Write a random paragraph about Australia [use ai] [store as: text]', /at the start of the step/],
      ['[use ai] Pick a colour [store as: a] [as: b]', /produces one value/],
      ['If the name is empty, then [use ai] Make up a name [store as: name]', /cannot be the step a control line runs/],
    ];
    for (const [step, message] of cases) {
      expect(() => parseTestContent(doc('Click Save', step), 'tests/t.md'), step).toThrow(message);
    }
  });

  it('refuses a name a looped section would bake its row value over', () => {
    const text = [
      '# T',
      '',
      '## Steps',
      '1. Greet',
      '',
      '### Greet',
      '',
      '| who |',
      '| --- |',
      '| Ada |',
      '',
      '1. [use ai] Write a greeting and store it as {{who}}',
      '',
    ].join('\n');
    expect(() => parseTestContent(text, 'tests/t.md')).toThrow(
      /Cannot store a \[use ai\] value as \{\{who\}\}.*column of the table/,
    );
  });

  it('leaves a hook\'s ${…} intact for the runner to fill and mask', async () => {
    const file = await write(
      'hook.md',
      ['# T', '', '## Hooks', '- before: [use ai] Describe ${env.REGION} [store as: region_blurb]', '',
       '- before: Navigate to ${env.BASE}', '',
       '## Steps', '1. Click Save', ''].join('\n'),
    );
    const parsed = await parseTestFile(file, {
      envData: { env: { REGION: 'eu', BASE: 'https://app.test' } },
    });
    expect(parsed.hooks.before).toEqual([
      '[use ai] Describe ${env.REGION} [store as: region_blurb]',
      // …while an ordinary hook is still baked, as before.
      'Navigate to https://app.test',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Inside a skill body the name must be explicit (decision 7)
// ---------------------------------------------------------------------------

describe('a [use ai] step in a skill body', () => {
  const skill = (...steps: string[]) =>
    ['---', 'type: skill', '---', '', '# gen', '', '## Outputs', '- code', '',
     '## Steps', ...steps.map((s, i) => `${i + 1}. ${s}`), ''].join('\n');

  it('is refused with no explicit name, saying why and showing [store as:]', async () => {
    const file = await write('skills/gen.md', skill('[use ai] Make up a promo code and store it in code'));
    await expect(parseSkillFile(file)).rejects.toThrow(
      /must name the value it stores[\s\S]*renames its variables per call[\s\S]*`\[store as: name\]`/,
    );
  });

  it('is refused with [as:] or [output:], which a skill does not rename', async () => {
    const file = await write('skills/gen.md', skill('[use ai] Make up a promo code [as: code]'));
    await expect(parseSkillFile(file)).rejects.toThrow(/`\[store as: name\]` or `store as \{\{name\}\}`/);
  });

  it('is accepted with [store as:], and scoped by the caller\'s alias', async () => {
    await write('skills/gen.md', skill('[use ai] Make up a promo code [store as: code]', 'Type {{code}} into the box'));
    const test = await write(
      'uses-skill.md',
      ['# T', '', '## Steps', '1. [skill: gen out.code="my_code"]', '2. Check {{my_code}}', ''].join('\n'),
    );
    const parsed = await parseTestFile(test, { skillsDir: path.join(dir, 'skills') });
    expect(parsed.steps.slice(0, 2)).toEqual([
      '[use ai] Make up a promo code [store as: my_code]',
      'Type {{my_code}} into the box',
    ]);
  });

  it('an internal name becomes the skill\'s own, never the caller\'s', async () => {
    await write(
      'skills/gen.md',
      ['---', 'type: skill', '---', '', '# gen', '', '## Steps',
       '1. [use ai] Make up a word and store it as {{scratch}}', '2. Type {{scratch}} into the box', ''].join('\n'),
    );
    const test = await write('uses-skill.md', ['# T', '', '## Steps', '1. [skill: gen]', ''].join('\n'));
    const parsed = await parseTestFile(test, { skillsDir: path.join(dir, 'skills') });
    expect(parsed.steps[0]).toMatch(/^\[use ai\] Make up a word and store it as \{\{__skill\d+_scratch\}\}$/);
  });
});

// ---------------------------------------------------------------------------
// The grouper and the computer lock
// ---------------------------------------------------------------------------

describe('the grouper and the computer lock leave a [use ai] step alone', () => {
  it('an If step followed by a [use ai] step does not group them', () => {
    expect(
      identifyStepGroups([
        'If prompted for MFA, enter the code',
        '[use ai] Make up a name [store as: name]',
      ]).size,
    ).toBe(0);
  });

  it('a [use ai] step whose question opens with "If" is never a watch', () => {
    // The grouper strips leading brackets before its `If …` test, which would
    // otherwise read this as a conditional and hand it to a page model.
    expect(
      identifyStepGroups([
        '[use ai] If the name is empty, give "Ada", else give the name [store as: n]',
        'Click Save',
      ]).size,
    ).toBe(0);
  });

  it('stepReadsScreen is false for it — no computer lock is taken', () => {
    expect(stepReadsScreen('[use ai] Make up a name [store as: name]')).toBe(false);
    expect(stepReadsScreen('[no-hooks] [use ai] Make up a name [store as: name]')).toBe(false);
    // …while an ordinary prose step still takes it.
    expect(stepReadsScreen('Click Save')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The three compile classifiers (decision 1)
// ---------------------------------------------------------------------------

describe('never compiled, by any of the three classifiers', () => {
  const binding = (source: string): CodeBehindBinding => ({
    file: path.join(dir, 'booking.steps.ts'),
    source,
    occurrence: 0,
    scope: { renames: {}, inputs: {} },
  });

  it('generationRefusal (live compile) refuses it with the reason', () => {
    const text = '[use ai] Make up a name [store as: name]';
    expect(generationRefusal({ binding: binding(text), text, status: 'passed' })).toBe(
      USE_AI_NOT_COMPILED,
    );
    expect(USE_AI_NOT_COMPILED).toBe('a [use ai] step asks the model on every run');
  });

  it('generationRefusal refuses a Set step too — the open question, answered', () => {
    // Before this story it answered `undefined` for a passed Set, and
    // generation's "no page actions" decline then wrote it into the file as an
    // `ai: true` entry (`applyGenerated` → `aiEntryFor`).
    const text = 'Set {{ref}} to "Ref: {{order}}"';
    expect(generationRefusal({ binding: binding(text), text, status: 'passed' })).toBe(
      SET_STEP_NOT_COMPILED,
    );
  });

  it('refuseReason (generation) refuses it ahead of the "no page actions" rule', () => {
    expect(refuseReason('[use ai] Make up a name [store as: name]', [])).toBe(USE_AI_NOT_COMPILED);
  });

  it('describeSteps (the boxed compile) names it when the author selects it', async () => {
    const md = await write(
      'booking.md',
      doc('Enter the booking code', '[use ai] Make up a reference [store as: ref]'),
    );
    const test = await parseTestFile(md);
    const config: Config = {
      ...DEFAULT_CONFIG,
      ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
      execution: { ...DEFAULT_CONFIG.execution, retries: 0 },
    };
    const asked: unknown[] = [];
    const aiClient = {
      complete: async (messages: unknown) => {
        asked.push(messages);
        throw new Error('compile must not ask the model about this step');
      },
    } as unknown as AiClient;
    const result = await compileTest({
      test,
      config,
      contextContent: '',
      aiClient,
      runner: async () => ({ status: 'passed', steps: [], resolvedParameters: {}, tokensUsed: 0 }),
      select: { steps: [2] },
    });
    expect(result.status).toBe('failed');
    expect(result.summary.error).toBe(`step 2 cannot be compiled: ${USE_AI_NOT_COMPILED}`);
    expect(asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The MCP pre-flight
// ---------------------------------------------------------------------------

describe('the MCP pre-flight knows what a [use ai] step will name', () => {
  let root: string;
  const created: string[] = [];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'aiui-use-ai-')));
    created.push(root);
    writeFileSync(path.join(root, 'aiui.config.json'), JSON.stringify({}));
    writeFileSync(path.join(root, '.env'), 'SERVER_URL=http://127.0.0.1:3100\n');
    process.env['AIUI_MCP_ROOTS'] = root;
  });

  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env['AIUI_MCP_ROOTS'];
  });

  const warningsFor = async (steps: string[]): Promise<string> => {
    const run = await assembleSteps({ steps, resolveProject, projectRoot: root });
    return run.warnings.join('\n');
  };

  it('an explicit name — bracket or prose — answers a later {{x}}', async () => {
    const text = await warningsFor([
      '[use ai] Make up a name [store as: customer]',
      '[use ai] Pick a colour and store it as {{colour}}',
      'Type {{customer}} and {{colour}} into the form',
    ]);
    expect(text).not.toContain('{{customer}}');
    expect(text).not.toContain('{{colour}}');
  });

  it('with no explicit name, a later {{x}} is answered only when the step says x', async () => {
    const answered = await warningsFor([
      '[use ai] Create a name starting with "AUTO" and store it in random_name',
      'Type {{random_name}} into the name field',
    ]);
    expect(answered).not.toContain('{{random_name}}');

    // The step never says what to call it, so the run would fail — and so the
    // pre-flight warns.
    const unanswered = await warningsFor([
      '[use ai] Write a random paragraph about Australia',
      'Type {{blurb}} into the notes field',
    ]);
    expect(unanswered).toContain('will reach the AI literally');
    expect(unanswered).toContain('{{blurb}}');
  });

  it('an EARLIER step answers, not a later one', async () => {
    const text = await warningsFor([
      'Type {{random_name}} into the name field',
      '[use ai] Create a name and store it in random_name',
    ]);
    expect(text).toContain('{{random_name}}');
  });

  it('refuses a misplaced [use ai] before any session exists', async () => {
    await expect(
      assembleSteps({ steps: ['Write a paragraph [use ai] [store as: t]'], resolveProject, projectRoot: root }),
    ).rejects.toThrow(/at the start of the step/);
  });
});
