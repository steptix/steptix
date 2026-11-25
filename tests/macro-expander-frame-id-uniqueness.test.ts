import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandMacros, clearMacroCache } from '../src/macros/expander.js';

/**
 * Regression guard: `ExpandedFrame.id` and the `__macro<N>_` internal
 * namespace must be unique across every invocation within one `expandMacros`
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
 *     steps reported a frame belonging to an unrelated macro (wrong
 *     `sourceMacro` in reports, wrong call-stack rows);
 *  2. both instances shared one `__macro<N>_` prefix, so one macro's
 *     `[store as:]` clobbered the other's value in session scope — the exact
 *     cross-instance leak the namespacing exists to prevent.
 *
 * Trigger is any nested invocation followed by a later sibling at the outer
 * level. Inline sections make that arrangement the norm rather than an
 * unusual macro-nesting case, which is how it surfaced.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'macro-frameid-'));
  clearMacroCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeMacro(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

describe('expandMacros frame-id uniqueness across nested + sibling invocations', () => {
  beforeEach(async () => {
    await writeMacro(
      'outer',
      `---
type: macro
---
# outer
## Steps
1. [macro: inner]
`,
    );
    await writeMacro(
      'inner',
      `---
type: macro
---
# inner
## Steps
1. Capture the code [store as: token]
2. Use {{token}} on the inner page
`,
    );
    await writeMacro(
      'sibling',
      `---
type: macro
---
# sibling
## Steps
1. Capture the code [store as: token]
2. Use {{token}} on the sibling page
`,
    );
  });

  it('mints a distinct frame for every invocation, nested ones included', async () => {
    const result = await expandMacros(
      ['[macro: outer]', '[macro: sibling]'],
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
      Object.values(result.frames).map((f) => [f.macroName, f]),
    );
    expect(Object.keys(byName).sort()).toEqual(['inner', 'outer', 'sibling']);

    // The nested frame is a child of outer; sibling is top-level. Before the
    // fix, `inner` was overwritten by `sibling` and this lookup was undefined.
    expect(byName.inner!.parentId).toBe(byName.outer!.id);
    expect(byName.sibling!.parentId).toBeNull();
  });

  it('attributes each expanded step to the frame it actually came from', async () => {
    const result = await expandMacros(
      ['[macro: outer]', '[macro: sibling]'],
      tmpDir,
      undefined,
      path.join(tmpDir, 'test.md'),
      [1, 2],
    );

    const byName = Object.fromEntries(
      Object.values(result.frames).map((f) => [f.macroName, f]),
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
    // resolved to the sibling macro.
    expect(new Set(result.origins.map((o) => o.frameId)).size).toBe(2);
  });

  it('gives each macro instance its own __macro<N>_ internal namespace', async () => {
    const result = await expandMacros(
      ['[macro: outer]', '[macro: sibling]'],
      tmpDir,
      undefined,
      path.join(tmpDir, 'test.md'),
      [1, 2],
    );

    const namespaces = [
      ...new Set(
        result.steps.flatMap((s) =>
          [...s.matchAll(/__macro\d+_\w+/g)].map((m) => m[0]),
        ),
      ),
    ];

    // `token` is neither a parameter nor a declared output in either macro,
    // so both instances namespace it — to DIFFERENT prefixes. Sharing one
    // prefix means sibling's capture overwrites inner's in session scope.
    expect(namespaces).toHaveLength(2);

    const innerStep = result.steps.find((s) => s.includes('inner page'))!;
    const siblingStep = result.steps.find((s) => s.includes('sibling page'))!;
    const nameIn = (s: string) => /__macro\d+_token/.exec(s)?.[0];
    expect(nameIn(innerStep)).toBeDefined();
    expect(nameIn(siblingStep)).toBeDefined();
    expect(nameIn(innerStep)).not.toBe(nameIn(siblingStep));
  });
});
