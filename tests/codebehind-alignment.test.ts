import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTestFile } from '../src/parser/markdown.js';
import { clearSkillCache } from '../src/skills/expander.js';
import {
  buildCodeBehindRegistry,
  codeBehindPathFor,
  type CodeBehindRegistry,
} from '../src/codebehind/loader.js';
import { makeScratchBase, removeScratchBase } from './codebehind-scratch.js';

/**
 * Binding: which `.steps.ts` entry (if any) each expanded step owns.
 * See stories/step-codebehind.md, "Binding" and "Sections and skills".
 *
 * Every case drives `parseTestFile` + expansion rather than hand-building
 * step arrays — the contract's §2.3 lesson. Hand-built inputs bypass
 * `extractPlainText` and `applySkillScope`, which are exactly the transforms
 * that make the match side interesting.
 *
 * Fixtures live under the repo (not `os.tmpdir()`) so a `.steps.ts` can
 * resolve `steptix/codebehind` by package self-reference, as a real
 * user's file resolves it from under their own project. Requires a built
 * `dist/`, same as the tool suites.
 */

/** This run's own directory, with the house Prettier style pinned at its root
 *  (tests/codebehind-scratch.ts says why both matter). */
let tmpBase: string;

beforeAll(async () => {
  tmpBase = await makeScratchBase('codebehind-align');
});

let counter = 0;
let dir: string;

beforeEach(async () => {
  clearSkillCache();
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await removeScratchBase(tmpBase);
});

async function write(rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, 'utf-8');
  return abs;
}

/** A `.steps.ts` whose entries just record that they ran. */
function stepsFile(entries: string[]): string {
  return `import { defineSteps } from 'steptix/codebehind';
export default defineSteps([
${entries.join(',\n')},
]);
`;
}

function entry(source: string, marker: string, section?: string): string {
  const scope = section === undefined ? '' : `    section: ${JSON.stringify(section)},\n`;
  return `  {
${scope}    source: ${JSON.stringify(source)},
    async run({ step }) { step.setVar('marker', ${JSON.stringify(marker)}); },
  }`;
}

async function registryFor(
  testPath: string,
  opts: { skillsDir?: string; warnings?: string[] } = {},
): Promise<{ steps: string[]; registry: CodeBehindRegistry }> {
  const parsed = await parseTestFile(
    testPath,
    opts.skillsDir ? { skillsDir: opts.skillsDir } : {},
  );
  const expansion = parsed.expansion!;
  const registry = await buildCodeBehindRegistry(
    {
      steps: parsed.steps,
      rawSteps: expansion.rawSteps,
      origins: expansion.origins,
      frames: expansion.frames,
    },
    {
      testFilePath: parsed.filePath,
      ...(opts.warnings && { onWarn: (m: string) => opts.warnings!.push(m) }),
    },
  );
  return { steps: parsed.steps, registry };
}

/** The marker an expanded step's bound entry would write, or undefined. */
async function markerAt(registry: CodeBehindRegistry, index: number): Promise<string | undefined> {
  const binding = registry.bindingFor(index);
  if (!binding?.entry?.run) return undefined;
  const scope: Record<string, string> = {};
  await binding.entry.run({
    step: {
      getVar: (n) => scope[n],
      setVar: (n, v) => { scope[n] = String(v); },
      expect: () => {},
    },
  } as never);
  return scope['marker'];
}

describe('code-behind binding — main flow', () => {
  it('binds a step to the entry whose source is its authored text', async () => {
    const md = await write('t.md', ['# T', '', '## Steps', '1. Click Sign in', '2. Verify the dashboard'].join('\n'));
    await write('t.steps.ts', stepsFile([entry('Click Sign in', 'signin')]));

    const { registry } = await registryFor(md);
    expect(await markerAt(registry, 0)).toBe('signin');
    expect(registry.bindingFor(1)?.entry).toBeUndefined();
  });

  it('binds the file next to the markdown, and remembers the scope-free target for a miss', async () => {
    const md = await write('t.md', ['# T', '', '## Steps', '1. Click Sign in'].join('\n'));

    const { registry } = await registryFor(md);
    const binding = registry.bindingFor(0)!;
    expect(binding.file).toBe(codeBehindPathFor(md));
    expect(binding.source).toBe('Click Sign in');
    expect(binding.section).toBeUndefined();
    expect(binding.occurrence).toBe(0);
    expect(binding.entry).toBeUndefined();
  });

  it('binds duplicate steps to duplicate entries by occurrence', async () => {
    const md = await write('t.md', ['# T', '', '## Steps', '1. Click Next', '2. Click Next'].join('\n'));
    await write('t.steps.ts', stepsFile([entry('Click Next', 'first'), entry('Click Next', 'second')]));

    const { registry } = await registryFor(md);
    expect(await markerAt(registry, 0)).toBe('first');
    expect(await markerAt(registry, 1)).toBe('second');
  });

  it('misses when the step text was edited — case-sensitively', async () => {
    const md = await write('t.md', ['# T', '', '## Steps', '1. Click sign in'].join('\n'));
    await write('t.steps.ts', stepsFile([entry('Click Sign in', 'signin')]));

    const { registry } = await registryFor(md);
    expect(registry.bindingFor(0)?.entry).toBeUndefined();
  });

  it('keeps matches when the steps are reordered — binding is by text, not position', async () => {
    const md = await write('t.md', ['# T', '', '## Steps', '1. Beta', '2. Alpha'].join('\n'));
    await write('t.steps.ts', stepsFile([entry('Alpha', 'a'), entry('Beta', 'b')]));

    const { registry } = await registryFor(md);
    expect(await markerAt(registry, 0)).toBe('b');
    expect(await markerAt(registry, 1)).toBe('a');
  });

  it('warns about an entry matching no step, and still ignores it at runtime', async () => {
    const md = await write('t.md', ['# T', '', '## Steps', '1. Alpha'].join('\n'));
    await write('t.steps.ts', stepsFile([entry('Alpha', 'a'), entry('Gamma (renamed away)', 'g')]));

    const warnings: string[] = [];
    const { registry } = await registryFor(md, { warnings });
    expect(await markerAt(registry, 0)).toBe('a');
    expect(warnings.some((w) => w.includes('Gamma (renamed away)') && w.includes('matches no step'))).toBe(true);
  });

  it('honours `ai: true` — the entry matches but carries no code to run', async () => {
    const md = await write('t.md', ['# T', '', '## Steps', '1. Verify the dashboard looks correct'].join('\n'));
    await write('t.steps.ts', stepsFile([
      `  { source: 'Verify the dashboard looks correct', ai: true }`,
    ]));

    const { registry } = await registryFor(md);
    const binding = registry.bindingFor(0)!;
    expect(binding.entry?.ai).toBe(true);
    expect(binding.entry?.run).toBeUndefined();
  });

  it('keeps `{{param}}` and `[store as: x]` markers in the bound source', async () => {
    const md = await write('t.md', [
      '# T', '', '## Parameters', '- username: alice', '',
      '## Steps', '1. Enter the username {{username}} [store as: entered]',
    ].join('\n'));

    const { registry } = await registryFor(md);
    expect(registry.bindingFor(0)?.source).toBe('Enter the username {{username}} [store as: entered]');
  });
});

describe('code-behind binding — sections', () => {
  const sectioned = [
    '# T', '', '## Steps',
    '1. Open the cart',
    '2. Checkout',
    '3. Checkout',
    '',
    '### Checkout',
    '1. Click Pay now',
    '2. Click Pay now',
  ].join('\n');

  it('binds a section-body step only to an entry carrying that section scope', async () => {
    const md = await write('t.md', sectioned);
    await write('t.steps.ts', stepsFile([
      entry('Click Pay now', 'unscoped'),
      entry('Click Pay now', 'scoped-1', 'Checkout'),
      entry('Click Pay now', 'scoped-2', 'Checkout'),
    ]));

    const { steps, registry } = await registryFor(md);
    // The section-call lines expanded away: 1 main-flow step + 2 bodies of 2.
    expect(steps).toHaveLength(5);
    expect(await markerAt(registry, 1)).toBe('scoped-1');
    expect(await markerAt(registry, 2)).toBe('scoped-2');
    expect(registry.bindingFor(1)?.section).toBe('Checkout');
  });

  it('binds both invocations of a section to the same entries, in body order', async () => {
    const md = await write('t.md', sectioned);
    await write('t.steps.ts', stepsFile([
      entry('Click Pay now', 'body-1', 'Checkout'),
      entry('Click Pay now', 'body-2', 'Checkout'),
    ]));

    const { registry } = await registryFor(md);
    expect([0, 1, 2, 3, 4].map((i) => registry.bindingFor(i)?.occurrence)).toEqual([0, 0, 1, 0, 1]);
    expect(await markerAt(registry, 1)).toBe('body-1');
    expect(await markerAt(registry, 2)).toBe('body-2');
    // Second invocation: occurrence counting restarted, so the same two
    // entries bind again rather than falling off the end.
    expect(await markerAt(registry, 3)).toBe('body-1');
    expect(await markerAt(registry, 4)).toBe('body-2');
  });

  it('never binds the section-call line itself — it expands away before binding', async () => {
    const md = await write('t.md', sectioned);
    await write('t.steps.ts', stepsFile([entry('Checkout', 'call-line')]));

    const warnings: string[] = [];
    const { registry } = await registryFor(md, { warnings });
    for (let i = 0; i < 5; i++) expect(await markerAt(registry, i)).toBeUndefined();
    expect(warnings.some((w) => w.includes('"Checkout"') && w.includes('matches no step'))).toBe(true);
  });
});

describe('code-behind binding — skills', () => {
  const skill = [
    '---', 'type: skill', '---', '# login', '',
    '## Parameters', '- username: who', '',
    '## Steps', '1. Sign in as {{username}}',
  ].join('\n');

  it('resolves a skill-body step to the SKILL\'s own .steps.ts, shared by every caller', async () => {
    const skillsDir = path.join(dir, 'skills');
    const skillPath = await write('skills/login.md', skill);
    await write('skills/login.steps.ts', stepsFile([entry('Sign in as {{username}}', 'from-skill')]));
    const a = await write('a.md', ['# A', '', '## Steps', '1. [skill: login username="alice"]'].join('\n'));
    const b = await write('b.md', ['# B', '', '## Steps', '1. [skill: login username="bob"]'].join('\n'));

    const ra = await registryFor(a, { skillsDir });
    const rb = await registryFor(b, { skillsDir });

    expect(ra.registry.bindingFor(0)?.file).toBe(codeBehindPathFor(skillPath));
    expect(rb.registry.bindingFor(0)?.file).toBe(codeBehindPathFor(skillPath));
    expect(await markerAt(ra.registry, 0)).toBe('from-skill');
    expect(await markerAt(rb.registry, 0)).toBe('from-skill');
  });

  it('binds the AUTHORED text, not the interpolated text', async () => {
    const skillsDir = path.join(dir, 'skills');
    await write('skills/login.md', skill);
    const t = await write('t.md', ['# T', '', '## Steps', '1. [skill: login username="alice"]'].join('\n'));

    const { steps, registry } = await registryFor(t, { skillsDir });
    expect(steps[0]).toBe('Sign in as alice');
    expect(registry.bindingFor(0)?.source).toBe('Sign in as {{username}}');
  });

  it('resolves a skill-internal section to the skill file, under the section scope', async () => {
    const skillsDir = path.join(dir, 'skills');
    const skillPath = await write('skills/login.md', [
      '---', 'type: skill', '---', '# login', '',
      '## Parameters', '- username: who', '',
      '## Steps', '1. Open the form', '2. Fill it', '',
      '### Fill it', '1. Type {{username}}',
    ].join('\n'));
    await write('skills/login.steps.ts', stepsFile([
      entry('Type {{username}}', 'skill-section', 'Fill it'),
    ]));
    const t = await write('t.md', ['# T', '', '## Steps', '1. [skill: login username="alice"]'].join('\n'));

    const { registry } = await registryFor(t, { skillsDir });
    const bodyBinding = registry.bindingFor(1)!;
    expect(bodyBinding.file).toBe(codeBehindPathFor(skillPath));
    expect(bodyBinding.section).toBe('Fill it');
    expect(await markerAt(registry, 1)).toBe('skill-section');
  });

  it('a test-file section keeps the TEST file, even when a skill runs inside it', async () => {
    const skillsDir = path.join(dir, 'skills');
    await write('skills/login.md', skill);
    const t = await write('t.md', [
      '# T', '', '## Steps',
      '1. Sign in block',
      '',
      '### Sign in block',
      '1. [skill: login username="alice"]',
      '2. Confirm the banner',
    ].join('\n'));

    const { registry } = await registryFor(t, { skillsDir });
    // Step 0 came from the skill body (skill file, no section scope);
    // step 1 is the section's own body step (test file, section scope).
    expect(registry.bindingFor(0)?.file).toBe(codeBehindPathFor(path.join(dir, 'skills', 'login.md')));
    expect(registry.bindingFor(0)?.section).toBeUndefined();
    expect(registry.bindingFor(1)?.file).toBe(codeBehindPathFor(t));
    expect(registry.bindingFor(1)?.section).toBe('Sign in block');
  });
});
