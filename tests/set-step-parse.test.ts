/**
 * What a `Set {{name}} to "…"` step is refused for at PARSE time — before a
 * browser is launched (stories/variable-assignment.md §Locked).
 *
 * Two families:
 *
 *  - the grammar: a line that claimed the form and did not complete it;
 *  - the bake-over: a target whose name belongs to something expansion writes
 *    into the step TEXT rather than keeping as a variable, so the runner would
 *    never see the name at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTestContent, parseTestFile } from '../src/parser/markdown.js';

describe('grammar, at parse time', () => {
  it('refuses an unquoted value and names the file and line', () => {
    const md = `# T\n\n## Steps\n1. Click Save\n2. Set {{ref}} to Ref: 1234\n`;
    expect(() => parseTestContent(md, '/tests/a.md')).toThrow(/double-quoted string/);
    expect(() => parseTestContent(md, '/tests/a.md')).toThrow(/a\.md at line 5/);
  });

  it('refuses trailing text after the closing quote', () => {
    const md = `# T\n\n## Steps\n1. Set {{a}} to "x" and click Save\n`;
    expect(() => parseTestContent(md)).toThrow(/Nothing may follow the closing quote/);
  });

  it('accepts the complete form, and keeps the line authored', () => {
    const md = `# T\n\n## Steps\n1. Set {{ref}} to "Ref: {{acct}}"\n`;
    const parsed = parseTestContent(md);
    expect(parsed.steps).toEqual(['Set {{ref}} to "Ref: {{acct}}"']);
  });

  it('leaves prose that merely starts with Set alone', () => {
    const md = `# T\n\n## Steps\n1. Set the filter to Recent\n2. Set {{a}} using the dropdown\n`;
    expect(() => parseTestContent(md)).not.toThrow();
  });
});

describe('bake-over refusals', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-step-'));
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const writeSkill = (name: string, body: string): void => {
    writeFileSync(path.join(dir, 'skills', `${name}.md`), body);
  };

  it("refuses a Set onto a skill's own parameter", async () => {
    writeSkill(
      'login',
      `---\ntype: skill\n---\n\n# login\n\n## Parameters\n- username: who\n\n## Steps\n1. Set {{username}} to "someone else"\n`,
    );
    const file = path.join(dir, 'test1.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [skill: login username="a"]\n`);
    await expect(parseTestFile(file, { skillsDir: path.join(dir, 'skills') })).rejects.toThrow(
      /it is a parameter of this skill/,
    );
  });

  it("allows a Set onto a skill's declared output", async () => {
    writeSkill(
      'capture',
      `---\ntype: skill\n---\n\n# capture\n\n## Parameters\n- src: input\n\n## Outputs\n- label\n\n## Steps\n1. Set {{label}} to "from {{src}}"\n`,
    );
    const file = path.join(dir, 'test2.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [skill: capture src="x" out.label="tag"]\n`);
    const parsed = await parseTestFile(file, { skillsDir: path.join(dir, 'skills') });
    // The output alias renames the target the same way it renames a
    // `[store as:]`, because a Set target IS a `{{X}}` placeholder.
    expect(parsed.steps[0]).toBe('Set {{tag}} to "from x"');
  });

  it('allows a Set onto an internal name inside a skill, namespaced', async () => {
    writeSkill(
      'internal',
      `---\ntype: skill\n---\n\n# internal\n\n## Steps\n1. Set {{scratch}} to "value"\n2. Type "{{scratch}}" into the box\n`,
    );
    const file = path.join(dir, 'test3.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [skill: internal]\n`);
    const parsed = await parseTestFile(file, { skillsDir: path.join(dir, 'skills') });
    expect(parsed.steps[0]).toMatch(/^Set \{\{__skill\d+_scratch\}\} to "value"$/);
    // Namespaced consistently on both sides, or the write and the read would
    // be different variables.
    expect(parsed.steps[1]).toMatch(/^Type "\{\{__skill\d+_scratch\}\}"/);
  });

  it("refuses a Set onto a looped section's row column", () => {
    const md = [
      '# T',
      '',
      '## Steps',
      '1. Sign in',
      '',
      '### Sign in',
      '',
      '| user | pass |',
      '| --- | --- |',
      '| a | b |',
      '',
      '1. Set {{user}} to "someone else"',
      '',
    ].join('\n');
    expect(() => parseTestContent(md)).toThrow(/it is a column of the table/);
  });

  it("allows a Set onto a run-level row column — those are runtime variables", () => {
    const md = [
      '# T',
      '',
      '## Steps',
      '',
      '| user | pass |',
      '| --- | --- |',
      '| a | b |',
      '',
      '1. Set {{user}} to "someone else"',
      '',
    ].join('\n');
    expect(() => parseTestContent(md)).not.toThrow();
  });
});

describe('bake-over refusals that only expansion can see', () => {
  // The parse-time guard in markdown.ts checks the step's OWN section's
  // columns. Review found two cases it structurally cannot reach, and both
  // were worse than "degrades to prose": each passed GREEN on wrong data.
  const parse = (md: string): Promise<unknown> => {
    const file = path.join(dir, `expand-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(file, md);
    return parseTestFile(file, { skillsDir: path.join(dir, 'skills') });
  };

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-expand-'));
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a target that an ENCLOSING looped section's row bakes over", async () => {
    // The inner body inherits the outer table's bindings (`rowBindings` is
    // merged), so `{{tag}}` was baked to the outer row value: the assignment
    // silently vanished AND the next step read `a` instead of `assigned-1`,
    // passing green on the wrong data.
    await expect(
      parse(
        [
          '# T', '', '## Steps', '1. Outer', '',
          '### Outer', '', '| tag |', '| --- |', '| a |', '| b |', '',
          '1. Inner', '',
          '### Inner', '', '| n |', '| --- |', '| 1 |', '',
          '1. Set {{tag}} to "assigned-{{n}}"',
          '2. Type {{tag}} into the box', '',
        ].join('\n'),
      ),
    ).rejects.toThrow(/Cannot assign to \{\{tag\}\}.*enclosing it/s);
  });

  it('refuses a row value that makes the assignment unparseable', async () => {
    // A `"` in the row value breaks the `[^"]*` grammar once baked in, so
    // that ROW's assignment was skipped while the variable still held the
    // PREVIOUS row's value — the row then ran on stale data.
    await expect(
      parse(
        [
          '# T', '', '## Steps', '1. Greet', '',
          '### Greet', '', '| who |', '| --- |', '| Alice |', '| He said "hi" |', '',
          '1. Set {{msg}} to "Hello {{who}}"', '',
        ].join('\n'),
      ),
    ).rejects.toThrow(/makes the step unparseable/);
  });

  it('still expands a looped section whose Set target is not a column', async () => {
    // The guard must not refuse the legitimate shape.
    const parsed = (await parse(
      [
        '# T', '', '## Steps', '1. Greet', '',
        '### Greet', '', '| who |', '| --- |', '| Alice |', '| Bob |', '',
        '1. Set {{greeting}} to "Hello {{who}}"', '',
      ].join('\n'),
    )) as { steps: string[] };
    expect(parsed.steps).toEqual([
      'Set {{greeting}} to "Hello Alice"',
      'Set {{greeting}} to "Hello Bob"',
    ]);
  });
});

describe('bake-overs at the other substitution sites', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-sites-'));
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const skill = (name: string, body: string): void =>
    writeFileSync(path.join(dir, 'skills', `${name}.md`), body);
  const testFile = (md: string): string => {
    const file = path.join(dir, `t-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(file, md);
    return file;
  };

  it('leaves a HOOK Set uninterpolated so a quote-bearing ${...} still assigns', async () => {
    // Hooks are baked at parse time — they are never shown to the model as
    // authored text. But a Set step IS read back by `parseSetStep` at run
    // time, so baking a data value containing a `"` turned the hook into an
    // unparseable line that ran as AI prose and never assigned.
    const file = testFile(
      ['# T', '', '## Hooks', '- before: Set {{g}} to "${data.greeting}"', '',
       '## Steps', '1. Click Save', ''].join('\n'),
    );
    const parsed = await parseTestFile(file, {
      envData: { env: {}, data: { greeting: 'He said "hi"' } },
    });
    // The token survives parse; `resolveSetTemplate` resolves it per run.
    expect(parsed.hooks.before[0]).toBe('Set {{g}} to "${data.greeting}"');
  });

  it('still bakes a NON-Set hook, which has nothing to preserve', async () => {
    const file = testFile(
      ['# T', '', '## Hooks', '- before: Navigate to ${data.url}', '',
       '## Steps', '1. Click Save', ''].join('\n'),
    );
    const parsed = await parseTestFile(file, {
      envData: { env: {}, data: { url: 'https://x.test' } },
    });
    expect(parsed.hooks.before[0]).toBe('Navigate to https://x.test');
  });

  it('refuses a skill argument named after a declared OUTPUT', async () => {
    // Outputs are excluded from internal renaming, so the argument was baked
    // straight over the assignment's target and it silently never happened.
    skill(
      'outp',
      // `msg` is an OUTPUT only — not a parameter — so the skill-parameter
      // refusal does not fire. `validateCall` merely warns about an unknown
      // argument, and the value still reaches `interpolate` and bakes the
      // assignment's target away.
      ['---', 'type: skill', '---', '', '# outp', '',
       '## Outputs', '- msg', '', '## Steps', '1. Set {{msg}} to "assigned"', ''].join('\n'),
    );
    const file = testFile('# T\n\n## Steps\n1. [skill: outp msg="baked"]\n');
    await expect(
      parseTestFile(file, { skillsDir: path.join(dir, 'skills') }),
    ).rejects.toThrow(/unparseable once its arguments/);
  });

  it('refuses an array-literal argument that breaks the assigned value', async () => {
    skill(
      'arr',
      ['---', 'type: skill', '---', '', '# arr', '', '## Parameters', '- items: list', '',
       '## Steps', '1. Set {{m}} to "got {{items}}"', ''].join('\n'),
    );
    const file = testFile('# T\n\n## Steps\n1. [skill: arr items=["a","b"]]\n');
    await expect(
      parseTestFile(file, { skillsDir: path.join(dir, 'skills') }),
    ).rejects.toThrow(/unparseable once its arguments/);
  });

  it('still expands an ordinary skill argument into a Set template', async () => {
    skill(
      'ok',
      ['---', 'type: skill', '---', '', '# ok', '', '## Parameters', '- who: name', '',
       '## Steps', '1. Set {{greeting}} to "Hello {{who}}"', ''].join('\n'),
    );
    const file = testFile('# T\n\n## Steps\n1. [skill: ok who="Alice"]\n');
    const parsed = await parseTestFile(file, { skillsDir: path.join(dir, 'skills') });
    expect(parsed.steps[0]).toBe('Set {{__skill1_greeting}} to "Hello Alice"');
  });
});

/**
 * The enumeration five review rounds each proved was missing.
 *
 * Rounds one to five each found the SAME defect at the next substitution site
 * along — row bindings, skill arguments, hook baking, the skill body — because
 * each round fixed the instance and then asserted closure in prose. The story
 * sentence claiming "the one asymmetry left is hooks" is what told round four
 * to stop looking; there were three sites left.
 *
 * This is that claim made checkable. The table names every place that writes a
 * value into step TEXT before `parseSetStep` reads it, and the test drives a
 * real file through each. A new substitution site added without a guard fails
 * here, whatever the site — which is the property no amount of prose had.
 */
describe('every substitution site preserves a Set step', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-sites-all-'));
    mkdirSync(path.join(dir, 'skills'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (rel: string, body: string): string => {
    const p = path.join(dir, rel);
    writeFileSync(p, body);
    return p;
  };
  /** A value that breaks the assigned value wherever it is written in. */
  const HOSTILE = 'He said "hi"';

  const SITES: Array<{
    site: string;
    /** Builds a file whose Set step this site substitutes into. */
    build: () => { file: string; opts: Parameters<typeof parseTestFile>[1] };
  }> = [
    {
      site: 'markdown.ts — skill body ${…}',
      build: () => {
        write(
          'skills/body.md',
          ['---', 'type: skill', '---', '', '# body', '', '## Outputs', '- g', '',
           '## Steps', '1. Set {{g}} to "${env.GREETING}"', ''].join('\n'),
        );
        return {
          file: write('t-body.md', '# T\n\n## Steps\n1. [skill: body]\n'),
          opts: { skillsDir: path.join(dir, 'skills'), envData: { env: { GREETING: HOSTILE } } },
        };
      },
    },
    {
      site: 'markdown.ts — skill SECTION body ${…}',
      build: () => {
        write(
          'skills/sect.md',
          ['---', 'type: skill', '---', '', '# sect', '', '## Outputs', '- g', '',
           '## Steps', '1. Inner', '', '### Inner', '',
           '1. Set {{g}} to "${env.GREETING}"', ''].join('\n'),
        );
        return {
          file: write('t-sect.md', '# T\n\n## Steps\n1. [skill: sect]\n'),
          opts: { skillsDir: path.join(dir, 'skills'), envData: { env: { GREETING: HOSTILE } } },
        };
      },
    },
    {
      site: 'expander.ts — skill arguments (output-name collision)',
      build: () => {
        // NOT a hostile quoted value: the invocation parser refuses
        // `who="He said "hi""` before the expander sees it, so that half of
        // this site is unreachable. The reachable half is an argument named
        // after a declared OUTPUT — outputs are not renamed, so the value
        // bakes straight over the assignment's target.
        write(
          'skills/args.md',
          ['---', 'type: skill', '---', '', '# args', '', '## Parameters', '- who: n', '',
           '## Outputs', '- g', '',
           '## Steps', '1. Set {{g}} to "hi {{who}}"', ''].join('\n'),
        );
        return {
          file: write('t-args.md', '# T\n\n## Steps\n1. [skill: args who="x" g="baked"]\n'),
          opts: { skillsDir: path.join(dir, 'skills') },
        };
      },
    },
    {
      site: 'expander.ts — looped section row bindings',
      build: () => ({
        file: write(
          't-rows.md',
          ['# T', '', '## Steps', '1. Greet', '', '### Greet', '',
           '| who |', '| --- |', `| ${HOSTILE} |`, '',
           '1. Set {{g}} to "hi {{who}}"', ''].join('\n'),
        ),
        opts: {},
      }),
    },
  ];

  it.each(SITES)('refuses a hostile value at $site', async ({ build }) => {
    const { file, opts } = build();
    // Every guarded site throws rather than producing a line that is no
    // longer a Set step. The message differs per site; that it refuses at
    // all is the invariant.
    await expect(parseTestFile(file, opts)).rejects.toThrow(
      /unparseable|may not contain a double quote|Cannot assign/,
    );
  });

  it('the HOOK site preserves rather than refuses, and that is deliberate', async () => {
    // A hook Set is not broken by baking — it is simply better resolved per
    // run, because `runHookScope` passes `envData` into `runSetStep`. So this
    // site keeps the token instead of refusing the substitution.
    const file = write(
      't-hook.md',
      ['# T', '', '## Hooks', '- before: Set {{g}} to "${env.GREETING}"', '',
       '## Steps', '1. Click Save', ''].join('\n'),
    );
    const parsed = await parseTestFile(file, { envData: { env: { GREETING: HOSTILE } } });
    expect(parsed.hooks.before[0]).toBe('Set {{g}} to "${env.GREETING}"');
  });

  it('none of these sites refuses a file with no Set step', async () => {
    // The guards must be invisible to everything else, or every existing test
    // file becomes a parse error.
    write(
      'skills/plain.md',
      ['---', 'type: skill', '---', '', '# plain', '', '## Parameters', '- who: n', '',
       '## Steps', '1. Type "{{who}}" into ${env.FIELD}', ''].join('\n'),
    );
    const file = write(
      't-plain.md',
      ['# T', '', '## Hooks', '- before: Navigate to ${env.FIELD}', '',
       // A benign arg value: a quoted one containing a quote is refused by
       // the invocation parser, which is a different (and correct) refusal.
       '## Steps', '1. [skill: plain who="Alice"]', '2. Loop', '',
       '### Loop', '', '| who |', '| --- |', `| ${HOSTILE} |`, '',
       '1. Type "{{who}}" into the box', ''].join('\n'),
    );
    await expect(
      parseTestFile(file, {
        skillsDir: path.join(dir, 'skills'),
        envData: { env: { FIELD: '#search', GREETING: HOSTILE } },
      }),
    ).resolves.toBeDefined();
  });
});
