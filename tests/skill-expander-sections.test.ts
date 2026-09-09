import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';
import { buildCodeBehindRegistry } from '../src/codebehind/loader.js';
import { parseTestFile, parseTestContent } from '../src/parser/markdown.js';
import { logger } from '../src/utils/logger.js';

/**
 * Expander-side coverage for inline sections. See
 * stories/test-script-sections.md and the frozen contract in
 * stories/test-script-sections-contract.md.
 */

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sections',
);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sections-exp-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function writeSkill(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${name}.md`), content);
}

async function writeTest(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  return p;
}

/** Expand a test file's own sections with no skills directory configured. */
async function expandInline(md: string) {
  const parsed = parseTestContent(md, '/t/inline.md');
  return expandSkills(parsed.steps, undefined, undefined, '/t/inline.md', parsed.stepLines, {
    sections: parsed.sections,
    rawSteps: parsed.rawSteps,
    warnDeadSections: false,
  });
}

// ── The shared match table, driven through the real parser ────────────────

describe('match rule (shared fixture, through the parser)', () => {
  const table = JSON.parse(
    readFileSync(path.join(FIXTURES, 'match-table.json'), 'utf-8'),
  ) as {
    rows: {
      name: string;
      sectionName: string;
      stepRawText: string;
      matches: boolean;
      documentExpressible?: boolean;
    }[];
  };

  const expressible = table.rows.filter((r) => r.documentExpressible !== false);

  it('exercises most of the frozen table', () => {
    // Guards against the filter silently swallowing the whole table.
    expect(expressible.length).toBeGreaterThanOrEqual(table.rows.length - 2);
  });

  for (const row of expressible) {
    it(`${row.matches ? 'resolves' : 'does not resolve'}: ${row.name}`, async () => {
      // Tight list on purpose: it is what real files look like, and it is the
      // layout in which extractPlainText is the identity function.
      const md = [
        '# T', '', '## Steps',
        `1. ${row.stepRawText}`,
        '',
        `### ${row.sectionName}`,
        '1. body step',
      ].join('\n');

      const result = await expandInline(md);
      if (row.matches) {
        expect(result.steps).toEqual(['body step']);
      } else {
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0]).not.toBe('body step');
      }
    });
  }
});

// ── Expansion shape ───────────────────────────────────────────────────────

describe('section expansion', () => {
  it('inlines a section body at the call site', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. Login', '2. Done', '', '### Login', '1. A', '2. B'].join('\n'),
    );
    expect(result.steps).toEqual(['A', 'B', 'Done']);
  });

  it('expands a section invoked twice, twice', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. Login', '2. Middle', '3. Login', '', '### Login', '1. A'].join('\n'),
    );
    expect(result.steps).toEqual(['A', 'Middle', 'A']);
    // Two invocations, two distinct frames.
    expect(Object.keys(result.frames)).toHaveLength(2);
  });

  it('resolves a call placed before its definition', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. Later', '', '### Later', '1. A'].join('\n'),
    );
    expect(result.steps).toEqual(['A']);
  });

  it('lets a section call a sibling section', async () => {
    const result = await expandInline(
      [
        '# T', '', '## Steps', '1. Outer', '',
        '### Outer', '1. before', '2. Inner', '3. after', '',
        '### Inner', '1. deep',
      ].join('\n'),
    );
    expect(result.steps).toEqual(['before', 'deep', 'after']);
  });

  it('records a section frame with the defining file and the invocation line', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. Login', '', '### Login', '1. A'].join('\n'),
    );
    const frame = Object.values(result.frames)[0]!;
    expect(frame).toMatchObject({
      kind: 'section',
      uri: '/t/inline.md',
      skillName: 'Login',
      parentId: null,
      invocationLine: 4,
    });
    // Macros take no arguments and declare no outputs.
    expect(frame.inputs).toBeUndefined();
    expect(frame.outputs).toBeUndefined();
  });

  it('points body-step origins at the section body lines', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. Login', '', '### Login', '1. A', '2. B'].join('\n'),
    );
    expect(result.origins.map((o) => o.skillLine)).toEqual([7, 8]);
    // Both body steps attribute back to the single invocation step.
    expect(result.origins.map((o) => o.inputIndex)).toEqual([0, 0]);
  });

  it('does not treat a bracket-token step as a section call', async () => {
    // `[skill:]` is claimed first, however the text compares.
    await writeSkill('login', ['---', 'type: skill', '---', '# login', '## Steps', '1. from skill'].join('\n'));
    const file = await writeTest(
      'bracket.md',
      ['# T', '', '## Steps', '1. [skill: login]', '', '### login', '1. from section'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['from skill']);
  });
});

// ── Scope transparency ────────────────────────────────────────────────────

describe('scope transparency', () => {
  it('leaves a test-file section body completely unscoped', async () => {
    const result = await expandInline(
      [
        '# T', '', '## Parameters', '- user: bob', '', '## Steps', '1. Login', '2. Use {{token}}', '',
        '### Login', '1. Capture it [store as: token]', '2. Type {{user}}',
      ].join('\n'),
    );
    // No namespacing, no pre-interpolation: the body reads exactly as authored.
    expect(result.steps).toEqual([
      'Capture it [store as: token]',
      'Type {{user}}',
      'Use {{token}}',
    ]);
  });

  it('scopes a skill-internal section to that skill instance', async () => {
    await writeSkill(
      'login',
      [
        '---', 'type: skill', '---', '# login',
        '## Parameters', '- user: the user',
        '## Outputs', '- welcome',
        '## Steps', '1. Do login', '',
        '### Do login',
        '1. Type "{{user}}"',
        '2. Capture greeting [store as: welcome]',
        '3. Note it [store as: scratch]',
        '4. Reuse {{scratch}}',
      ].join('\n'),
    );
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. [skill: login user="alice" out.welcome="greeting"]'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });

    // Caller args interpolated, declared output aliased, and `scratch` — used
    // ONLY inside the section body — still namespaced.
    expect(parsed.steps[0]).toBe('Type "alice"');
    expect(parsed.steps[1]).toBe('Capture greeting [store as: greeting]');
    expect(parsed.steps[2]).toMatch(/^Note it \[store as: __skill\d+_scratch\]$/);
    expect(parsed.steps[3]).toMatch(/^Reuse \{\{__skill\d+_scratch\}\}$/);
  });

  it('never mutates the cached ParsedSkill across invocations', async () => {
    await writeSkill(
      'greet',
      [
        '---', 'type: skill', '---', '# greet',
        '## Parameters', '- who: the name',
        '## Steps', '1. Say hello', '',
        '### Say hello', '1. Greet {{who}}',
      ].join('\n'),
    );
    const file = await writeTest(
      't.md',
      [
        '# T', '', '## Steps',
        '1. [skill: greet who="alice"]',
        '2. [skill: greet who="bob"]',
      ].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    // If the scoped copy mutated the cached skill, the second invocation would
    // inherit "alice" (or both would read the same value).
    expect(parsed.steps).toEqual(['Greet alice', 'Greet bob']);
  });

  it('applies the parse-time env/data pass to section bodies', async () => {
    await writeSkill(
      'envskill',
      [
        '---', 'type: skill', '---', '# envskill',
        '## Steps', '1. Go', '',
        '### Go', '1. Open ${env.BASE_URL}',
      ].join('\n'),
    );
    const file = await writeTest('t.md', ['# T', '', '## Steps', '1. [skill: envskill]'].join('\n'));
    const parsed = await parseTestFile(file, {
      skillsDir: tmpDir,
      envData: { env: { BASE_URL: 'https://example.test' } },
    });
    expect(parsed.steps).toEqual(['Open https://example.test']);
  });

  it('matches on authored text, not on the interpolated value', async () => {
    // The contract §2.3 discriminator. `applySkillScope` rewrites steps[i] to
    // "Login", which WOULD match the skill's `### Login`; rawSteps[i] stays
    // "{{target}}", which must not. Unlike a `**Login**` test, this bites in a
    // tight list — where extractPlainText is the identity function.
    await writeSkill(
      'router',
      [
        '---', 'type: skill', '---', '# router',
        '## Parameters', '- target: what to do',
        '## Steps', '1. {{target}}', '',
        '### Login', '1. section body ran',
      ].join('\n'),
    );
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. [skill: router target="Login"]'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['Login']);
    expect(parsed.steps).not.toContain('section body ran');
  });
});

// ── Provenance tagging ────────────────────────────────────────────────────

describe('sourceSections tagging', () => {
  it('tags a test-file section body with its name and leaves main flow null', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. Before', '2. Login', '3. After', '', '### Login', '1. A'].join('\n'),
    );
    expect(result.steps).toEqual(['Before', 'A', 'After']);
    expect(result.sourceSections).toEqual([null, 'Login', null]);
  });

  it('keeps the outermost section for nested test-file sections', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. Outer', '', '### Outer', '1. Inner', '', '### Inner', '1. deep'].join('\n'),
    );
    expect(result.sourceSections).toEqual(['Outer']);
  });

  it('sets both tags for a skill invoked from inside a section', async () => {
    await writeSkill('helper', ['---', 'type: skill', '---', '# helper', '## Steps', '1. from skill'].join('\n'));
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. Wrapper', '', '### Wrapper', '1. [skill: helper]'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['from skill']);
    expect(parsed.sourceSkills).toEqual(['helper']);
    expect(parsed.sourceSections).toEqual(['Wrapper']);
  });

  it('never surfaces a skill-private section name', async () => {
    await writeSkill(
      'helper',
      ['---', 'type: skill', '---', '# helper', '## Steps', '1. Private', '', '### Private', '1. hidden'].join('\n'),
    );
    const file = await writeTest('t.md', ['# T', '', '## Steps', '1. [skill: helper]'].join('\n'));
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['hidden']);
    expect(parsed.sourceSkills).toEqual(['helper']);
    // The skill badge already names what the author wrote.
    expect(parsed.sourceSections).toEqual([null]);
  });

  it('keeps the enclosing test section when a skill has its own sections', async () => {
    await writeSkill(
      'helper',
      ['---', 'type: skill', '---', '# helper', '## Steps', '1. Private', '', '### Private', '1. hidden'].join('\n'),
    );
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. Wrapper', '', '### Wrapper', '1. [skill: helper]'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    // Outermost section outside any skill frame — "Wrapper", not "Private".
    expect(parsed.sourceSections).toEqual(['Wrapper']);
  });
});

// ── Errors ────────────────────────────────────────────────────────────────

describe('errors', () => {
  it('throws when a section invokes itself', async () => {
    await expect(
      expandInline(['# T', '', '## Steps', '1. Loop', '', '### Loop', '1. Loop'].join('\n')),
    ).rejects.toThrow(/cycle/i);
  });

  it('throws on a mutual section cycle', async () => {
    await expect(
      expandInline(
        ['# T', '', '## Steps', '1. A', '', '### A', '1. B', '', '### B', '1. A'].join('\n'),
      ),
    ).rejects.toThrow(/cycle/i);
  });

  it('does not let a skill body reach back into the caller’s sections', async () => {
    await writeSkill('s', ['---', 'type: skill', '---', '# s', '## Steps', '1. Sec'].join('\n'));
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. Sec', '', '### Sec', '1. [skill: s]'].join('\n'),
    );
    // The skill's body says "Sec", which is a section name in the *caller*.
    // Sections are file-local, and recursing into a skill swaps in that
    // skill's own (here empty) map — so this is an ordinary AI step, not a
    // section call, and therefore not an infinite loop either.
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['Sec']);
  });

  it('strips a [no-hooks] marker from a body step as it is inlined', async () => {
    // The CLI parser already strips these, but the server receives markers
    // verbatim in the wire payload, so the strip has to live in the expander
    // too or the two paths send different text to the AI. Driven through the
    // wire-shaped SectionDefs (no rawSteps) to exercise the server's path.
    const result = await expandSkills(
      ['Login', 'After'],
      undefined,
      undefined,
      '/t/wire.md',
      [1, 2],
      {
        sections: {
          login: {
            name: 'Login',
            headingLine: 4,
            steps: ['[no-hooks] Type the username', 'Click sign in'],
            stepLines: [5, 6],
          },
        },
        warnDeadSections: false,
      },
    );
    expect(result.steps).toEqual(['Type the username', 'Click sign in', 'After']);
  });

  it('resolves a nested bare-name call when the map carries no rawSteps', async () => {
    // The server path: `SectionDefs.rawSteps` is absent, so matchInput falls
    // back to steps[i]. A section body calling a sibling must still resolve.
    const result = await expandSkills(['Outer'], undefined, undefined, '/t/wire.md', [1], {
      sections: {
        outer: { name: 'Outer', headingLine: 3, steps: ['before', 'Inner', 'after'], stepLines: [4, 5, 6] },
        inner: { name: 'Inner', headingLine: 8, steps: ['deep'], stepLines: [9] },
      },
      warnDeadSections: false,
    });
    expect(result.steps).toEqual(['before', 'deep', 'after']);
  });

  it('throws when an invoked section has no steps', async () => {
    await expect(
      expandInline(['# T', '', '## Steps', '1. Empty', '', '### Empty', '', 'Just prose.'].join('\n')),
    ).rejects.toThrow(/Section "Empty".*has no steps/s);
  });

  it('throws a clean error for [skill:] with no skillsDir', async () => {
    await expect(
      expandInline(['# T', '', '## Steps', '1. Sec', '', '### Sec', '1. [skill: nope]'].join('\n')),
    ).rejects.toThrow(/no skills directory is configured/i);
  });

  it('names both files when a section cycles across a skill boundary', async () => {
    // Two files may define same-named sections without colliding: the cycle
    // key is namespaced by file path.
    await writeSkill(
      'inner',
      ['---', 'type: skill', '---', '# inner', '## Steps', '1. Shared', '', '### Shared', '1. from skill'].join('\n'),
    );
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. Shared', '', '### Shared', '1. [skill: inner]'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['from skill']);
  });
});

// ── Dead-section warning ──────────────────────────────────────────────────

describe('dead-section warning', () => {
  const warnings = (): string[] => {
    const spy = vi.spyOn(logger, 'warn');
    return spy.mock.calls.map((c) => String(c[0]));
  };

  it('warns for a section that is never invoked', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. One', '', '### Dead', '1. never runs'].join('\n'),
      '/t/x.md',
    );
    await expandSkills(parsed.steps, undefined, undefined, '/t/x.md', parsed.stepLines, {
      sections: parsed.sections,
      rawSteps: parsed.rawSteps,
    });
    expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Section "Dead".*never/s);
  });

  it('does not warn for a section invoked only from another section', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. Outer', '', '### Outer', '1. Inner', '', '### Inner', '1. deep'].join('\n'),
      '/t/x.md',
    );
    await expandSkills(parsed.steps, undefined, undefined, '/t/x.md', parsed.stepLines, {
      sections: parsed.sections,
      rawSteps: parsed.rawSteps,
    });
    expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/never/);
  });

  it('counts a call site inside a dead section (flat scan)', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. One', '', '### Dead', '1. Alive', '', '### Alive', '1. x'].join('\n'),
      '/t/x.md',
    );
    await expandSkills(parsed.steps, undefined, undefined, '/t/x.md', parsed.stepLines, {
      sections: parsed.sections,
      rawSteps: parsed.rawSteps,
    });
    const text = spy.mock.calls.map((c) => String(c[0])).join('\n');
    // "Dead" is genuinely unused; "Alive" is called from inside it and counts.
    expect(text).toMatch(/Section "Dead"/);
    expect(text).not.toMatch(/Section "Alive"/);
  });

  it('is silent when warnDeadSections is false', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parsed = parseTestContent(
      ['# T', '', '## Steps', '1. One', '', '### Dead', '1. never'].join('\n'),
      '/t/x.md',
    );
    await expandSkills(parsed.steps, undefined, undefined, '/t/x.md', parsed.stepLines, {
      sections: parsed.sections,
      rawSteps: parsed.rawSteps,
      warnDeadSections: false,
    });
    expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/never invoked/);
  });

  it('reproduces the frozen dead-section expectation for the shared fixture', async () => {
    // The fixture's $comment states the property it pins: "expanding it must
    // emit exactly one warning, naming Cleanup". Assert that by running the
    // real expansion — computing liveness here instead would only prove the
    // fixture agrees with a reimplementation written beside it.
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fixturePath = path.join(FIXTURES, 'classification.md');
    const parsed = parseTestContent(readFileSync(fixturePath, 'utf-8'), fixturePath);

    await expandSkills(parsed.steps, undefined, undefined, fixturePath, parsed.stepLines, {
      sections: parsed.sections,
      rawSteps: parsed.rawSteps,
    });

    const frozen = JSON.parse(
      readFileSync(path.join(FIXTURES, 'classification.json'), 'utf-8'),
    ) as { files: Record<string, { expectedDeadSections?: string[] }> };
    const expected = frozen.files['classification.md']!.expectedDeadSections!;

    const warned = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /is defined but never invoked/.test(m));
    expect(warned).toHaveLength(expected.length);
    for (const name of expected) {
      expect(warned.some((m) => m.includes(`Section "${name}"`))).toBe(true);
    }
  });

  it('warns once per skill file however many times it is invoked', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await writeSkill(
      'helper',
      ['---', 'type: skill', '---', '# helper', '## Steps', '1. work', '', '### Dead', '1. never'].join('\n'),
    );
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. [skill: helper]', '2. [skill: helper]'].join('\n'),
    );
    await parseTestFile(file, { skillsDir: tmpDir });
    const hits = spy.mock.calls.map((c) => String(c[0])).filter((m) => /Section "Dead"/.test(m));
    expect(hits).toHaveLength(1);
  });

  it('never resolves a hook entry to a section, and hooks do not count as call sites', async () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const file = await writeTest(
      't.md',
      [
        '# T', '', '## Hooks', '- beforeEach: Login', '',
        '## Steps', '1. Something else', '',
        '### Login', '1. body',
      ].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    // The hook entry stays an ordinary AI instruction...
    expect(parsed.hooks.beforeEach).toEqual(['Login']);
    // ...and does not keep the section alive.
    expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Section "Login"/);
  });
});

// ── skipHooks alignment ───────────────────────────────────────────────────

describe('[no-hooks] on an invocation covers the whole expanded body', () => {
  it('for a section', async () => {
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. [no-hooks] Login', '2. After', '', '### Login', '1. A', '2. B'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['A', 'B', 'After']);
    expect(parsed.skipHooks).toEqual([true, true, false]);
  });

  it('for a multi-step skill (the pre-existing misalignment this also fixes)', async () => {
    await writeSkill(
      'multi',
      ['---', 'type: skill', '---', '# multi', '## Steps', '1. one', '2. two', '3. three'].join('\n'),
    );
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. [no-hooks] [skill: multi]', '2. After'].join('\n'),
    );
    const parsed = await parseTestFile(file, { skillsDir: tmpDir });
    expect(parsed.steps).toEqual(['one', 'two', 'three', 'After']);
    // Previously padded with `false`, so only the first expanded step skipped.
    expect(parsed.skipHooks).toEqual([true, true, true, false]);
  });

  it('resolves a [no-hooks]-prefixed call to its section', async () => {
    const result = await expandInline(
      ['# T', '', '## Steps', '1. [NO-HOOKS] Login', '', '### Login', '1. A'].join('\n'),
    );
    expect(result.steps).toEqual(['A']);
  });
});

// ── parseTestFile integration ─────────────────────────────────────────────

describe('parseTestFile gating', () => {
  it('expands sections even with no skillsDir configured', async () => {
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. Login', '', '### Login', '1. A', '2. B'].join('\n'),
    );
    const parsed = await parseTestFile(file);
    expect(parsed.steps).toEqual(['A', 'B']);
  });

  it('leaves a sectionless file with no skillsDir completely untouched', async () => {
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. [skill: whatever]', '2. Plain'].join('\n'),
    );
    const parsed = await parseTestFile(file);
    // Legacy raw pass-through: no expansion runs, so no missing-skillsDir error.
    expect(parsed.steps).toEqual(['[skill: whatever]', 'Plain']);
  });

  it('re-aligns stepLines to the invocation line for section-expanded steps', async () => {
    const file = await writeTest(
      't.md',
      ['# T', '', '## Steps', '1. Login', '2. After', '', '### Login', '1. A', '2. B'].join('\n'),
    );
    const parsed = await parseTestFile(file);
    // Body steps point at the call site — the line the author has open.
    expect(parsed.stepLines).toEqual([4, 4, 5]);
  });
});

// ── Narrowed section bodies ──────────────────────────────────────────────

/**
 * `runSteps` — run only some of a section's body steps, per iteration
 * (stories/data-row-progress-and-selection.md, decision 3).
 *
 * The body arrives whole and the indices say which of it runs, so a narrowed
 * run is a SUBSET of the run it narrows rather than a differently-numbered run
 * of its own: same lines, same code-behind slots, same frames.
 */
describe('runSteps narrows a section body', () => {
  /** Expand `steps` against one section definition, wire-style (no rawSteps). */
  const expandWith = async (
    steps: string[],
    section: Record<string, unknown>,
  ) =>
    expandSkills(steps, undefined, undefined, '/t/n.md', [4], {
      sections: { 'log in': section } as never,
      warnDeadSections: false,
    });

  const LOG_IN = {
    name: 'Log In',
    headingLine: 6,
    steps: ['Enter the email {{email}}', 'Enter the password {{password}}'],
    stepLines: [11, 12],
    rows: [{ email: 'a@b.c', password: 'pw1' }, { email: 'd@e.f', password: 'pw2' }],
  };

  it('emits only the named body steps, on their authored lines', async () => {
    const exp = await expandWith(['Log In'], { ...LOG_IN, runSteps: [1] });
    expect(exp.steps).toEqual(['Enter the password pw1', 'Enter the password pw2']);
    // Line 12, not 11: filtering the parallel arrays together is what keeps a
    // kept step pointing at the line the author selected.
    expect(exp.origins.map((o) => o.skillLine)).toEqual([12, 12]);
    // And the iterations still number themselves off the table.
    expect(
      Object.values(exp.frames)
        .filter((f) => f.kind === 'section')
        .map((f) => [f.iteration, f.iterationCount]),
    ).toEqual([[1, 2], [2, 2]]);
  });

  it('runs the whole body for an absent, empty or complete list', async () => {
    // An axis nobody narrowed means all of it, and a list that keeps
    // everything has narrowed nothing.
    for (const runSteps of [undefined, [], [0, 1], [0, 1, 5]]) {
      const exp = await expandWith(['Log In'], { ...LOG_IN, ...(runSteps && { runSteps }) });
      expect(exp.steps).toHaveLength(4);
      expect(exp.origins.every((o) => o.occurrenceOffset === undefined)).toBe(true);
    }
  });

  it('keeps a kept step in the code-behind slot a full run would give it', async () => {
    // The one thing filtering could silently break. Occurrence is a count of
    // same-text steps within the frame, so dropping the first `Click Next`
    // would slide the third into the first one's entry — a different piece of
    // code, run without a word.
    const wizard = {
      name: 'Log In',
      headingLine: 6,
      steps: ['Click Next', 'Enter the email', 'Click Next', 'Click Next'],
      stepLines: [11, 12, 13, 14],
    };
    const full = await expandWith(['Log In'], wizard);
    const narrow = await expandWith(['Log In'], { ...wizard, runSteps: [3] });

    const occurrences = async (exp: Awaited<ReturnType<typeof expandWith>>) => {
      const registry = await buildCodeBehindRegistry(
        { steps: exp.steps, rawSteps: exp.rawSteps, origins: exp.origins, frames: exp.frames },
        { testFilePath: '/t/n.md', onWarn: () => {} },
      );
      return exp.steps.map((_, i) => registry.bindingFor(i)?.occurrence);
    };

    expect(await occurrences(full)).toEqual([0, 0, 1, 2]);
    // The fourth body step alone, and it still binds the THIRD `Click Next`.
    expect(await occurrences(narrow)).toEqual([2]);
  });
});
