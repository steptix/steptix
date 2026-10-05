import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';

/**
 * Phase 1 of the step-into work: the expander must surface frame metadata so
 * the server can emit `frame:push` / `frame:pop` between flattened skill
 * bodies. These tests pin the shape of `origins` + `frames` against a few
 * fixtures — covering the inline-only case, a single skill descent, and a
 * nested skill descent.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-frames-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

describe('expandSkills frame metadata', () => {
  it('returns no frames and inline origins when no skill is invoked', async () => {
    const result = await expandSkills(
      ['Click login', 'Type username'],
      tmpDir,
    );

    expect(Object.keys(result.frames)).toEqual([]);
    expect(result.origins).toHaveLength(2);
    expect(result.origins[0]).toMatchObject({ inputIndex: 0, frameId: '' });
    expect(result.origins[1]).toMatchObject({ inputIndex: 1, frameId: '' });
    expect(result.origins[0]).not.toHaveProperty('skillFilePath');
    expect(result.origins[1]).not.toHaveProperty('skillFilePath');
  });

  it('records a single frame with the skill file + invocation line', async () => {
    await writeSkill(
      'search',
      `---
type: skill
---
# search
## Parameters
- query: the term
## Steps
1. Navigate to https://example.com
2. Type "{{query}}" into the search box
`,
    );

    const result = await expandSkills(
      ['Open the page', '[skill: search query="GPT-5"]', 'Verify results loaded'],
      tmpDir,
    );

    // Flattened: 1 inline + 2 skill-body + 1 inline = 4
    expect(result.steps).toHaveLength(4);

    // One frame for the single skill invocation
    const frameIds = Object.keys(result.frames);
    expect(frameIds).toHaveLength(1);
    const frame = result.frames[frameIds[0]!]!;
    expect(frame.kind).toBe('skill');
    expect(frame.skillName).toBe('search');
    expect(frame.parentId).toBeNull();
    expect(frame.uri).toBe(path.resolve(tmpDir, 'search.md'));

    // Origins: inline before, two skill steps, inline after
    expect(result.origins[0]).toMatchObject({ inputIndex: 0, frameId: '' });
    expect(result.origins[1]?.frameId).toBe(frameIds[0]);
    expect(result.origins[2]?.frameId).toBe(frameIds[0]);
    expect(result.origins[3]).toMatchObject({ inputIndex: 2, frameId: '' });

    // The skill-body entries carry skillLine pointing inside the skill .md
    expect(result.origins[1]?.skillFilePath).toBe(frame.uri);
    expect(typeof result.origins[1]?.skillLine).toBe('number');
    expect(result.origins[1]?.skillLine).toBeGreaterThan(0);
    expect(result.origins[2]?.skillLine).toBeGreaterThan(result.origins[1]!.skillLine!);
  });

  it('records a skill frame\'s effective output names (aliased + unaliased)', async () => {
    await writeSkill(
      'count',
      `---
type: skill
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
    const result = await expandSkills(
      ['[skill: count out.result_count="my_count"]'],
      tmpDir,
    );

    const frame = result.frames[Object.keys(result.frames)[0]!]!;
    // Effective session-scope names: aliased output uses the alias, the
    // unaliased one keeps its declared name. Order follows `## Outputs`.
    expect(frame.outputs).toEqual(['my_count', 'page_total']);
  });

  it('records an empty outputs list for a skill with no declared outputs', async () => {
    await writeSkill(
      'noop',
      `---
type: skill
---
# noop
## Steps
1. Do nothing
`,
    );

    const result = await expandSkills(['[skill: noop]'], tmpDir);
    const frame = result.frames[Object.keys(result.frames)[0]!]!;
    expect(frame.outputs).toEqual([]);
  });

  it('chains frames when a skill calls another skill', async () => {
    await writeSkill(
      'inner',
      `---
type: skill
---
# inner
## Steps
1. Click submit
`,
    );
    await writeSkill(
      'outer',
      `---
type: skill
---
# outer
## Steps
1. Open the form
2. [skill: inner]
`,
    );

    const result = await expandSkills(['[skill: outer]'], tmpDir);

    // outer: step1 inline + step2 [skill: inner] expanding to 1 step = 2
    expect(result.steps).toHaveLength(2);

    const frames = result.frames;
    const frameIds = Object.keys(frames);
    expect(frameIds).toHaveLength(2);

    const outerFrame = Object.values(frames).find((f) => f.skillName === 'outer')!;
    const innerFrame = Object.values(frames).find((f) => f.skillName === 'inner')!;
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
