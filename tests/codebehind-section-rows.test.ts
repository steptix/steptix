import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Page, BrowserContext, Browser } from 'playwright';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import { buildCodeBehindRegistry, type CodeBehindBinding } from '../src/codebehind/loader.js';
import { runCodeBehindEntry } from '../src/codebehind/execute.js';
import { stepParameters } from '../src/codebehind/generate.js';
import type { CodeBehindContext } from '../src/codebehind/types.js';

/**
 * Code-behind inside a LOOPED section (stories/data-driven-rows.md, part B).
 *
 * One entry is generated per section body and reused by every iteration, the
 * way one entry serves every invocation of a skill. What makes that possible
 * is the frame: each iteration carries its row as `inputs`, so the generated
 * code keeps saying `step.getVar('file')` and the runtime answers with that
 * iteration's cell.
 *
 * Before this, `varScopeFor` walked to the nearest *skill* frame and gave a
 * plain section an empty scope — so a looped body's `{{file}}` reached the
 * generator with no name→value pair at all, the entry would inline row 1's
 * literal with the leak guard blind, and replay would read `undefined`.
 */

const tmpBase = path.join(os.tmpdir(), `cb-section-rows-${process.pid}`);
let counter = 0;
let dir: string;

const noPage = {} as Page;
const noContext = {} as BrowserContext;
const noBrowser = {} as Browser;

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

async function bindingsFor(testMd: string): Promise<CodeBehindBinding[]> {
  const testPath = await write('t.md', testMd);
  const parsed = await parseTestFile(testPath, { skillsDir: path.join(dir, 'skills') });
  const registry = await buildCodeBehindRegistry(
    {
      steps: parsed.steps,
      rawSteps: parsed.expansion!.rawSteps,
      origins: parsed.expansion!.origins,
      frames: parsed.expansion!.frames,
    },
    { testFilePath: parsed.filePath, onWarn: () => {} },
  );
  return parsed.steps.map((_, i) => registry.bindingFor(i)!);
}

async function runEntry(
  binding: CodeBehindBinding,
  params: Record<string, string>,
  body: (ctx: CodeBehindContext) => Promise<void> | void,
): Promise<Awaited<ReturnType<typeof runCodeBehindEntry>>> {
  return runCodeBehindEntry({
    binding: { ...binding, entry: { source: binding.source, run: body } },
    page: noPage,
    context: noContext,
    browser: noBrowser,
    resolvedParameters: params,
    label: 'test',
  });
}

const UPLOAD = `# Upload

## Steps
1. Upload each statement

### Upload each statement
| file        | status           |
|-------------|------------------|
| logo.png    | Uploaded logo    |
| receipt.png | Uploaded receipt |
1. Upload file {{file}}
2. Assert the status says "{{status}}"
`;

describe('one entry, every iteration', () => {
  it('binds every iteration of a body to the same entry', async () => {
    // Four executed steps, two authored — so a generated entry must be found
    // by all four, or three of them would fall back to AI.
    const bindings = await bindingsFor(UPLOAD);
    expect(bindings).toHaveLength(4);
    expect(bindings.map((b) => b.source)).toEqual([
      'Upload file {{file}}',
      'Assert the status says "{{status}}"',
      'Upload file {{file}}',
      'Assert the status says "{{status}}"',
    ]);
    // Same section scope for all of them: the entry is section-scoped, and a
    // per-iteration scope would make the lookup miss.
    expect(new Set(bindings.map((b) => b.section))).toEqual(
      new Set(['Upload each statement']),
    );
  });

  it('answers getVar with the iteration that is running', async () => {
    const bindings = await bindingsFor(UPLOAD);
    const seen: Array<string | undefined> = [];
    for (const binding of [bindings[0]!, bindings[2]!]) {
      await runEntry(binding, {}, ({ step }) => {
        seen.push(step.getVar('file'));
      });
    }
    expect(seen).toEqual(['logo.png', 'receipt.png']);
  });

  it('gives the generator the row values behind the placeholders', async () => {
    // The half the leak guard depends on: without a name→value pair the guard
    // has nothing to look for and the literal lands in a committed file.
    const bindings = await bindingsFor(UPLOAD);
    expect(stepParameters(bindings[0]!, {}, undefined)).toEqual([
      { name: 'file', value: 'logo.png' },
    ]);
    expect(stepParameters(bindings[1]!, {}, undefined)).toEqual([
      { name: 'status', value: 'Uploaded logo' },
    ]);
    // Iteration 2's binding sees iteration 2's values, which is what makes
    // "record two rows and diff" possible later.
    expect(stepParameters(bindings[2]!, {}, undefined)).toEqual([
      { name: 'file', value: 'receipt.png' },
    ]);
  });
});

describe('composing along the frame chain', () => {
  it('lets an inner loop read the outer row', async () => {
    const bindings = await bindingsFor(`# T

## Steps
1. Per account

### Per account
| account  |
|----------|
| Everyday |
| Savings  |
1. Per month

### Per month
| month |
|-------|
| Jan   |
1. Check {{account}} in {{month}}
`);
    expect(bindings).toHaveLength(2);
    const seen: Array<Record<string, string | undefined>> = [];
    for (const binding of bindings) {
      await runEntry(binding, {}, ({ step }) => {
        seen.push({ account: step.getVar('account'), month: step.getVar('month') });
      });
    }
    expect(seen).toEqual([
      { account: 'Everyday', month: 'Jan' },
      { account: 'Savings', month: 'Jan' },
    ]);
  });

  it('lets the inner row shadow an outer column of the same name', async () => {
    const bindings = await bindingsFor(`# T

## Steps
1. Outer

### Outer
| label |
|-------|
| outer |
1. Inner

### Inner
| label |
|-------|
| inner |
1. Use {{label}}
`);
    const values: Array<string | undefined> = [];
    await runEntry(bindings[0]!, {}, ({ step }) => {
      values.push(step.getVar('label'));
    });
    expect(values).toEqual(['inner']);
  });

  it('keeps a skill namespace while still seeing the enclosing row', async () => {
    // The two halves of the scope answer different questions: `renames` come
    // from the nearest skill instance alone, `inputs` from every enclosing
    // frame. A step inside a skill called from a looped body needs both.
    await write(
      'skills/handle.md',
      [
        '---', 'type: skill', '---', '# handle', '',
        '## Parameters', '- what: the thing', '',
        '## Steps',
        // `scratch` is written before it is read, which is what makes the
        // expander treat it as skill-internal and namespace it.
        '1. Note a value [store as: scratch]',
        '2. Handle {{what}} and reuse {{scratch}}',
      ].join('\n'),
    );
    const bindings = await bindingsFor(`# T

## Steps
1. Each thing

### Each thing
| thing |
|-------|
| alpha |
1. [skill: handle what="{{thing}}"]
`);
    expect(bindings).toHaveLength(2);
    // Read the namespaced name off the binding rather than guessing it: the
    // `__skill<N>_` counter is shared with the section frames, so hard-coding
    // it would be testing the sequence number, not the composition.
    const namespaced = bindings[1]!.scope.renames['scratch'];
    expect(namespaced, 'the skill frame must still supply its renames').toBeDefined();

    const seen: Record<string, string | undefined> = {};
    await runEntry(bindings[1]!, { [namespaced!]: 'from-skill-scope' }, ({ step }) => {
      // The skill's own parameter, and the enclosing loop's row.
      seen.what = step.getVar('what');
      seen.thing = step.getVar('thing');
      // The namespaced internal still resolves through the skill's renames.
      seen.scratch = step.getVar('scratch');
    });
    expect(seen).toEqual({
      what: 'alpha',
      thing: 'alpha',
      scratch: 'from-skill-scope',
    });
  });

  it('leaves an unlooped section with no scope at all', async () => {
    // The regression guard: a plain section shares the caller's scope, and
    // inventing inputs for it would shadow real parameters.
    const bindings = await bindingsFor(`# T

## Steps
1. Sign in

### Sign in
1. Enter {{email}}
`);
    const values: Array<string | undefined> = [];
    await runEntry(bindings[0]!, { email: 'from-params' }, ({ step }) => {
      values.push(step.getVar('email'));
    });
    expect(values).toEqual(['from-params']);
  });
});
