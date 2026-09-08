/**
 * "Where does the flow this step is in end?" — `frameExitIndex` and friends
 * (stories/step-flow-control.md §Tests, "Frame exit").
 *
 * The frame tables here are built by running the REAL expander over small
 * fixtures rather than hand-written. Hand-written frames pass whatever the
 * helper believes about `parentId`, `frameId` and the root's `''`; expanded
 * ones pass only what the expander actually produces, which is the table the
 * runners will hand it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache, type SkillExpansion } from '../src/skills/expander.js';
import { parseTestContent } from '../src/parser/markdown.js';
import {
  frameExitIndex,
  frameLabel,
  flowControlExplanation,
  skippedByReturn,
  skippedByReturnReason,
} from '../src/runner/flow-control.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-control-frames-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

/** Expand a whole test document — sections, skills and all — the way
 *  `parseTestFile` does, so `origins`/`frames` are the real thing. */
async function expand(md: string): Promise<SkillExpansion> {
  const filePath = path.join(tmpDir, 'flow.md');
  await fs.writeFile(filePath, md);
  const parsed = parseTestContent(md, filePath);
  return expandSkills(parsed.steps, tmpDir, undefined, filePath, parsed.stepLines, {
    sections: parsed.sections,
    rawSteps: parsed.rawSteps,
    warnDeadSections: false,
  });
}

/** `frameExitIndex` over a whole expansion, so a test can read the shape of
 *  the flat list beside the answer. */
function exitOf(exp: SkillExpansion, i: number): number {
  return frameExitIndex(exp.origins, exp.frames, i, exp.steps.length);
}

function labelOf(exp: SkillExpansion, i: number): string | null {
  return frameLabel(exp.origins, exp.frames, i);
}

describe('frameExitIndex — the root frame', () => {
  it('runs to the last step: a main-flow return ends the test', async () => {
    const exp = await expand(`# t

## Steps
1. Navigate to /
2. If the title is Dashboard then stop
3. Click Sign out
4. Verify the login form is shown
`);
    expect(exp.steps).toHaveLength(4);
    expect(exitOf(exp, 1)).toBe(3);
    expect(labelOf(exp, 1)).toBeNull();
  });

  it('returns i itself on the last step, so nothing is skipped', async () => {
    const exp = await expand(`# t

## Steps
1. Navigate to /
2. Stop
`);
    expect(exitOf(exp, 1)).toBe(1);
  });

  it('treats a runner with no expansion as all-root', () => {
    // The raw `parseTestContent` path and the MCP errand runner have no
    // frames at all. `stepCount` is the whole answer for them.
    expect(frameExitIndex(undefined, undefined, 1, 5)).toBe(4);
    expect(frameLabel(undefined, undefined, 1)).toBeNull();
  });

  it('treats a frame id the table does not know as root', async () => {
    const exp = await expand(`# t

## Steps
1. Sign in
2. Click Sign out

### Sign in
1. Type the username
2. Click Sign in
`);
    // Step 0 is inside the section frame; strip the table and the helper must
    // fall back to "the whole run" rather than throw or loop.
    expect(frameExitIndex(exp.origins, {}, 0, exp.steps.length)).toBe(exp.steps.length - 1);
  });
});

describe('frameExitIndex — a section', () => {
  it('ends at the last body step, not at the end of the test', async () => {
    const exp = await expand(`# t

## Steps
1. Navigate to /
2. Sign in
3. Click Sign out

### Sign in
1. If the title is Dashboard then return
2. Type the username
3. Type the password
4. Click Sign in
`);
    // Flat list: [Navigate, body1..body4, Click Sign out]
    expect(exp.steps).toEqual([
      'Navigate to /',
      'If the title is Dashboard then return',
      'Type the username',
      'Type the password',
      'Click Sign in',
      'Click Sign out',
    ]);
    // The return is at index 1; its flow ends at index 4 — the LAST body
    // step — so `Click Sign out` (index 5) still runs.
    expect(exitOf(exp, 1)).toBe(4);
    expect(labelOf(exp, 1)).toBe('Sign in');
    // The step after the section is root again.
    expect(exitOf(exp, 5)).toBe(5);
    expect(labelOf(exp, 5)).toBeNull();
  });

  it('ends the INNER section when a section is nested in a section', async () => {
    const exp = await expand(`# t

## Steps
1. Outer
2. Done

### Outer
1. Before inner
2. Inner
3. After inner

### Inner
1. If ready then return
2. Never reached
`);
    expect(exp.steps).toEqual([
      'Before inner',
      'If ready then return',
      'Never reached',
      'After inner',
      'Done',
    ]);
    // The return is inside Inner: only `Never reached` is left behind.
    expect(exitOf(exp, 1)).toBe(2);
    expect(labelOf(exp, 1)).toBe('Inner');
    // A return on the FIRST step of Outer would take the inner call with it —
    // the inner frame is a descendant of the outer one.
    expect(exitOf(exp, 0)).toBe(3);
    expect(labelOf(exp, 0)).toBe('Outer');
  });

  it('ends the SKILL, not the enclosing section, for a skill called inside one', async () => {
    await writeSkill(
      'login',
      `---
type: skill
---
# login
## Steps
1. If already signed in then return
2. Type the username
`,
    );
    const exp = await expand(`# t

## Steps
1. Prepare
2. Finish

### Prepare
1. Open the login page
2. [skill: login]
3. Close the banner
`);
    expect(exp.steps).toEqual([
      'Open the login page',
      'If already signed in then return',
      'Type the username',
      'Close the banner',
      'Finish',
    ]);
    expect(labelOf(exp, 1)).toBe('login');
    // Only the skill body ends: `Close the banner` belongs to the section.
    expect(exitOf(exp, 1)).toBe(2);
  });
});

describe('frameExitIndex — a looped section', () => {
  it('ends ONE iteration; the next iteration still runs', async () => {
    const exp = await expand(`# t

## Steps
1. Navigate to /
2. Check each

### Check each

| term |
| --- |
| shoes |
| hats |

1. Search for {{term}}
2. If no results then return
3. Open the first result
`);
    // Two iterations of a three-step body, inlined back to back.
    expect(exp.steps).toEqual([
      'Navigate to /',
      'Search for shoes',
      'If no results then return',
      'Open the first result',
      'Search for hats',
      'If no results then return',
      'Open the first result',
    ]);
    // Each iteration is its own frame, so the return at index 2 leaves only
    // index 3 behind — iteration 2 starts at index 4.
    expect(exitOf(exp, 2)).toBe(3);
    expect(exitOf(exp, 5)).toBe(6);
    expect(labelOf(exp, 2)).toBe('Check each');
    // Proven a different way: the two iterations really are distinct frames.
    expect(exp.origins[1]!.frameId).not.toBe(exp.origins[4]!.frameId);
  });

  it('ends the run when the last iteration returns on its last step', async () => {
    const exp = await expand(`# t

## Steps
1. Check each

### Check each

| term |
| --- |
| shoes |

1. Search for {{term}}
2. Stop
`);
    expect(exp.steps).toEqual(['Search for shoes', 'Stop']);
    expect(exitOf(exp, 1)).toBe(1);
  });
});

describe('the reason strings', () => {
  const RETURN_LINE = 'If the page title contains "Dashboard" then return';

  it('names the step, the flow it left, and the line that left it', () => {
    // Two halves, two readers. `step 3` is the EXPANDED index, which is what
    // the report rows and the server's run log are numbered by ("Step 3/13").
    // The editor is numbered by nothing of the sort — a hover on a section
    // body line saying "step 3 returned" names a step that is not on screen —
    // so the returning step's own authored line comes with it.
    expect(skippedByReturnReason(2, 'Sign in', RETURN_LINE)).toBe(
      `Not run: step 3 returned from "Sign in" — ${RETURN_LINE}`,
    );
    expect(skippedByReturnReason(2, null, RETURN_LINE)).toBe(
      `Not run: step 3 ended the run — ${RETURN_LINE}`,
    );
  });

  it('clips a long returning line at 80 characters, ellipsis included', () => {
    const long = `If the page title contains "Dashboard" then stop running the remaining steps ${'x'.repeat(40)}`;
    const reason = skippedByReturnReason(2, null, long);
    const appended = reason.slice('Not run: step 3 ended the run — '.length);
    expect(appended).toHaveLength(80);
    expect(appended.endsWith('…')).toBe(true);
    expect(appended.startsWith('If the page title contains "Dashboard"')).toBe(true);
  });

  it('leaves the sentence whole when there is no line to append', () => {
    // A runner with no authored text to hand (a wire shape that carried none)
    // gets the sentence it always had, not a trailing dash.
    expect(skippedByReturnReason(2, 'Sign in', '')).toBe('Not run: step 3 returned from "Sign in"');
    expect(skippedByReturnReason(2, null, '   ')).toBe('Not run: step 3 ended the run');
  });

  it('builds a skipped StepResult that spent nothing', () => {
    const result = skippedByReturn(4, 'Click Sign out', 2, 'Sign in', RETURN_LINE);
    expect(result).toEqual({
      index: 5,
      instruction: 'Click Sign out',
      status: 'skipped',
      turns: [],
      durationMs: 0,
      retried: false,
      aiExplanation: `Not run: step 3 returned from "Sign in" — ${RETURN_LINE}`,
    });
  });

  it('formats the returning step`s own explanation, with and without a model detail', () => {
    expect(flowControlExplanation('Sign in')).toBe('Returned from "Sign in"');
    expect(flowControlExplanation(null)).toBe('Ended the run');
    expect(flowControlExplanation('Sign in', 'the title already reads Dashboard')).toBe(
      'Returned from "Sign in": the title already reads Dashboard',
    );
    expect(flowControlExplanation(null, 'the title already reads Dashboard')).toBe(
      'Ended the run: the title already reads Dashboard',
    );
    // An empty detail must not leave a dangling colon.
    expect(flowControlExplanation('Sign in', '   ')).toBe('Returned from "Sign in"');
  });
});
