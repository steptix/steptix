import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';

/**
 * Regression guard: `ExpandedFrame.id` and the `__skill<N>_` internal
 * namespace must be unique across every invocation within one `expandSkills`
 * call.
 *
 * `expandRecursive` hands nested calls a spread copy of its `ExpandContext`.
 * While `frames` is shared by reference, the `seq` counter used to be a bare
 * `number` — copied by value — so increments inside a nested body never
 * reached the parent level. The next sibling invocation at the outer level
 * then re-minted an id the nested frame already held, with two distinct
 * failures:
 *
 *  1. the nested frame was overwritten in the shared `frames` map, so its
 *     steps reported a frame belonging to an unrelated skill (wrong
 *     `sourceSkill` in reports, wrong call-stack rows);
 *  2. both instances shared one `__skill<N>_` prefix, so one skill's
 *     `[store as:]` clobbered the other's value in session scope — the exact
 *     cross-instance leak the namespacing exists to prevent.
 *
 * Trigger is any nested invocation followed by a later sibling at the outer
 * level. Inline sections make that arrangement the norm rather than an
 * unusual skill-nesting case, which is how it surfaced.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-frameid-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

describe('expandSkills frame-id uniqueness across nested + sibling invocations', () => {
  beforeEach(async () => {
    await writeSkill(
      'outer',
      `---
type: skill
---
# outer
## Steps
1. [skill: inner]
`,
    );
    await writeSkill(
      'inner',
      `---
type: skill
---
# inner
## Steps
1. Capture the code [store as: token]
2. Use {{token}} on the inner page
`,
    );
    await writeSkill(
      'sibling',
      `---
type: skill
---
# sibling
## Steps
1. Capture the code [store as: token]
2. Use {{token}} on the sibling page
`,
    );
  });

  it('mints a distinct frame for every invocation, nested ones included', async () => {
    const result = await expandSkills(
      ['[skill: outer]', '[skill: sibling]'],
      tmpDir,
      undefined,
      path.join(tmpDir, 'test.md'),
      [1, 2],
    );

    // outer, inner (nested inside outer), sibling — three separate frames.
    const frameIds = Object.keys(result.frames);
    expect(frameIds).toHaveLength(3);
    expect(new Set(frameIds).size).toBe(3);

    const byName = Object.fromEntries(
      Object.values(result.frames).map((f) => [f.skillName, f]),
    );
    expect(Object.keys(byName).sort()).toEqual(['inner', 'outer', 'sibling']);

    // The nested frame is a child of outer; sibling is top-level. Before the
    // fix, `inner` was overwritten by `sibling` and this lookup was undefined.
    expect(byName.inner!.parentId).toBe(byName.outer!.id);
    expect(byName.sibling!.parentId).toBeNull();
  });

  it('attributes each expanded step to the frame it actually came from', async () => {
    const result = await expandSkills(
      ['[skill: outer]', '[skill: sibling]'],
      tmpDir,
      undefined,
      path.join(tmpDir, 'test.md'),
      [1, 2],
    );

    const byName = Object.fromEntries(
      Object.values(result.frames).map((f) => [f.skillName, f]),
    );

    // Two steps from inner's body, then two from sibling's.
    expect(result.steps).toHaveLength(4);
    expect(result.origins.map((o) => o.frameId)).toEqual([
      byName.inner!.id,
      byName.inner!.id,
      byName.sibling!.id,
      byName.sibling!.id,
    ]);

    // Before the fix every origin reported the same id, so the inner steps
    // resolved to the sibling skill.
    expect(new Set(result.origins.map((o) => o.frameId)).size).toBe(2);
  });

  it('gives each skill instance its own __skill<N>_ internal namespace', async () => {
    const result = await expandSkills(
      ['[skill: outer]', '[skill: sibling]'],
      tmpDir,
      undefined,
      path.join(tmpDir, 'test.md'),
      [1, 2],
    );

    const namespaces = [
      ...new Set(
        result.steps.flatMap((s) =>
          [...s.matchAll(/__skill\d+_\w+/g)].map((m) => m[0]),
        ),
      ),
    ];

    // `token` is neither a parameter nor a declared output in either skill,
    // so both instances namespace it — to DIFFERENT prefixes. Sharing one
    // prefix means sibling's capture overwrites inner's in session scope.
    expect(namespaces).toHaveLength(2);

    const innerStep = result.steps.find((s) => s.includes('inner page'))!;
    const siblingStep = result.steps.find((s) => s.includes('sibling page'))!;
    const nameIn = (s: string) => /__skill\d+_token/.exec(s)?.[0];
    expect(nameIn(innerStep)).toBeDefined();
    expect(nameIn(siblingStep)).toBeDefined();
    expect(nameIn(innerStep)).not.toBe(nameIn(siblingStep));
  });
});
