import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandMacros, clearMacroCache } from '../src/macros/expander.js';

/**
 * Phase 1 of the step-into work: the expander must surface frame metadata so
 * the server can emit `frame:push` / `frame:pop` between flattened macro
 * bodies. These tests pin the shape of `origins` + `frames` against a few
 * fixtures — covering the inline-only case, a single macro descent, and a
 * nested macro descent.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'macro-frames-'));
  clearMacroCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeMacro(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

describe('expandMacros frame metadata', () => {
  it('returns no frames and inline origins when no macro is invoked', async () => {
    const result = await expandMacros(
      ['Click login', 'Type username'],
      tmpDir,
    );

    expect(Object.keys(result.frames)).toEqual([]);
    expect(result.origins).toHaveLength(2);
    expect(result.origins[0]).toMatchObject({ inputIndex: 0, frameId: '' });
    expect(result.origins[1]).toMatchObject({ inputIndex: 1, frameId: '' });
    expect(result.origins[0]).not.toHaveProperty('macroFilePath');
    expect(result.origins[1]).not.toHaveProperty('macroFilePath');
  });

  it('records a single frame with the macro file + invocation line', async () => {
    await writeMacro(
      'search',
      `---
type: macro
---
# search
## Parameters
- query: the term
## Steps
1. Navigate to https://example.com
2. Type "{{query}}" into the search box
`,
    );

    const result = await expandMacros(
      ['Open the page', '[macro: search query="GPT-5"]', 'Verify results loaded'],
      tmpDir,
    );

    // Flattened: 1 inline + 2 macro-body + 1 inline = 4
    expect(result.steps).toHaveLength(4);

    // One frame for the single macro invocation
    const frameIds = Object.keys(result.frames);
    expect(frameIds).toHaveLength(1);
    const frame = result.frames[frameIds[0]!]!;
    expect(frame.kind).toBe('macro');
    expect(frame.macroName).toBe('search');
    expect(frame.parentId).toBeNull();
    expect(frame.uri).toBe(path.resolve(tmpDir, 'search.md'));

    // Origins: inline before, two macro steps, inline after
    expect(result.origins[0]).toMatchObject({ inputIndex: 0, frameId: '' });
    expect(result.origins[1]?.frameId).toBe(frameIds[0]);
    expect(result.origins[2]?.frameId).toBe(frameIds[0]);
    expect(result.origins[3]).toMatchObject({ inputIndex: 2, frameId: '' });

    // The macro-body entries carry macroLine pointing inside the macro .md
    expect(result.origins[1]?.macroFilePath).toBe(frame.uri);
    expect(typeof result.origins[1]?.macroLine).toBe('number');
    expect(result.origins[1]?.macroLine).toBeGreaterThan(0);
    expect(result.origins[2]?.macroLine).toBeGreaterThan(result.origins[1]!.macroLine!);
  });

  it('records a macro frame\'s effective output names (aliased + unaliased)', async () => {
    await writeMacro(
      'count',
      `---
type: macro
---
# count
## Outputs
- result_count
- page_total
## Steps
1. Count rows [store as: result_count]
2. Read total [store as: page_total]
`,
    );

    // Caller aliases one output, leaves the other under its declared name.
    const result = await expandMacros(
      ['[macro: count out.result_count="my_count"]'],
      tmpDir,
    );

    const frame = result.frames[Object.keys(result.frames)[0]!]!;
    // Effective session-scope names: aliased output uses the alias, the
    // unaliased one keeps its declared name. Order follows `## Outputs`.
    expect(frame.outputs).toEqual(['my_count', 'page_total']);
  });

  it('records an empty outputs list for a macro with no declared outputs', async () => {
    await writeMacro(
      'noop',
      `---
type: macro
---
# noop
## Steps
1. Do nothing
`,
    );

    const result = await expandMacros(['[macro: noop]'], tmpDir);
    const frame = result.frames[Object.keys(result.frames)[0]!]!;
    expect(frame.outputs).toEqual([]);
  });

  it('chains frames when a macro calls another macro', async () => {
    await writeMacro(
      'inner',
      `---
type: macro
---
# inner
## Steps
1. Click submit
`,
    );
    await writeMacro(
      'outer',
      `---
type: macro
---
# outer
## Steps
1. Open the form
2. [macro: inner]
`,
    );

    const result = await expandMacros(['[macro: outer]'], tmpDir);

    // outer: step1 inline + step2 [macro: inner] expanding to 1 step = 2
    expect(result.steps).toHaveLength(2);

    const frames = result.frames;
    const frameIds = Object.keys(frames);
    expect(frameIds).toHaveLength(2);

    const outerFrame = Object.values(frames).find((f) => f.macroName === 'outer')!;
    const innerFrame = Object.values(frames).find((f) => f.macroName === 'inner')!;
    expect(outerFrame).toBeDefined();
    expect(innerFrame).toBeDefined();

    // outer's parent is the test (null), inner's parent is outer
    expect(outerFrame.parentId).toBeNull();
    expect(innerFrame.parentId).toBe(outerFrame.id);

    // The two emitted steps: outer step1 in outer's frame, inner step1 in
    // inner's frame
    expect(result.origins[0]?.frameId).toBe(outerFrame.id);
    expect(result.origins[1]?.frameId).toBe(innerFrame.id);
  });
});
