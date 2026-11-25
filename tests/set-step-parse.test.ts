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
    expect(() => parseTestContent(md)).toThrow(/must end at the closing quote/);
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
    mkdirSync(path.join(dir, 'macros'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const writeMacro = (name: string, body: string): void => {
    writeFileSync(path.join(dir, 'macros', `${name}.md`), body);
  };

  it("refuses a Set onto a macro's own parameter", async () => {
    writeMacro(
      'login',
      `---\ntype: macro\n---\n\n# login\n\n## Parameters\n- username: who\n\n## Steps\n1. Set {{username}} to "someone else"\n`,
    );
    const file = path.join(dir, 'test1.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [macro: login username="a"]\n`);
    await expect(parseTestFile(file, { macrosDir: path.join(dir, 'macros') })).rejects.toThrow(
      /it is a parameter of this macro/,
    );
  });

  it("allows a Set onto a macro's declared output", async () => {
    writeMacro(
      'capture',
      `---\ntype: macro\n---\n\n# capture\n\n## Parameters\n- src: input\n\n## Outputs\n- label\n\n## Steps\n1. Set {{label}} to "from {{src}}"\n`,
    );
    const file = path.join(dir, 'test2.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [macro: capture src="x" out.label="tag"]\n`);
    const parsed = await parseTestFile(file, { macrosDir: path.join(dir, 'macros') });
    // The output alias renames the target the same way it renames a
    // `[store as:]`, because a Set target IS a `{{X}}` placeholder.
    expect(parsed.steps[0]).toBe('Set {{tag}} to "from x"');
  });

  it('allows a Set onto an internal name inside a macro, namespaced', async () => {
    writeMacro(
      'internal',
      `---\ntype: macro\n---\n\n# internal\n\n## Steps\n1. Set {{scratch}} to "value"\n2. Type "{{scratch}}" into the box\n`,
    );
    const file = path.join(dir, 'test3.md');
    writeFileSync(file, `# T\n\n## Steps\n1. [macro: internal]\n`);
    const parsed = await parseTestFile(file, { macrosDir: path.join(dir, 'macros') });
    expect(parsed.steps[0]).toMatch(/^Set \{\{__macro\d+_scratch\}\} to "value"$/);
    // Namespaced consistently on both sides, or the write and the read would
    // be different variables.
    expect(parsed.steps[1]).toMatch(/^Type "\{\{__macro\d+_scratch\}\}"/);
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
    return parseTestFile(file, { macrosDir: path.join(dir, 'macros') });
  };

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-expand-'));
    mkdirSync(path.join(dir, 'macros'), { recursive: true });
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
    mkdirSync(path.join(dir, 'macros'), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const macro = (name: string, body: string): void =>
    writeFileSync(path.join(dir, 'macros', `${name}.md`), body);
  const testFile = (md: string): string => {
    const file = path.join(dir, `t-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(file, md);
    return file;
  };

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

  it('refuses an array-literal argument that breaks the assigned value', async () => {
    macro(
      'arr',
      ['---', 'type: macro', '---', '', '# arr', '', '## Parameters', '- items: list', '',
       '## Steps', '1. Set {{m}} to "got {{items}}"', ''].join('\n'),
    );
    const file = testFile('# T\n\n## Steps\n1. [macro: arr items=["a","b"]]\n');
    await expect(
      parseTestFile(file, { macrosDir: path.join(dir, 'macros') }),
    ).rejects.toThrow(/unparseable once its arguments/);
  });

  it('still expands an ordinary macro argument into a Set template', async () => {
    macro(
      'ok',
      ['---', 'type: macro', '---', '', '# ok', '', '## Parameters', '- who: name', '',
       '## Steps', '1. Set {{greeting}} to "Hello {{who}}"', ''].join('\n'),
    );
    const file = testFile('# T\n\n## Steps\n1. [macro: ok who="Alice"]\n');
    const parsed = await parseTestFile(file, { macrosDir: path.join(dir, 'macros') });
    expect(parsed.steps[0]).toBe('Set {{__macro1_greeting}} to "Hello Alice"');
  });
});

/**
 * The enumeration five review rounds each proved was missing.
 *
 * Rounds one to five each found the SAME defect at the next substitution site
 * along — row bindings, macro arguments, hook baking, the macro body — because
 * each round fixed the instance and then asserted closure in prose. The story
 * sentence claiming "the one asymmetry left is hooks" is what told round four
 * to stop looking; there were three sites left.
 *
 * This pins the FOUR KNOWN sites, each proven by mutation to have teeth: remove
 * its guard and the corresponding row fails. What it does NOT do is notice a
 * site nobody has named — round six proved that by adding one in fifteen lines
 * and watching the whole suite stay green. `tests/substitution-sites.test.ts`
 * is the canary for that half: it inventories every substitution CALL in
 * `src/`, so a new one fails until someone classifies it.
 */
describe('every substitution site preserves a Set step', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'set-sites-all-'));
    mkdirSync(path.join(dir, 'macros'), { recursive: true });
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
    /** This site's own refusal — so a row cannot pass on another site's. */
    refusal: RegExp;
  }> = [
    {
      site: 'markdown.ts — macro body ${…}',
      refusal: /A value substituted into macro "body" makes "Set \{\{g\}\} to …" unparseable/,
      build: () => {
        write(
          'macros/body.md',
          ['---', 'type: macro', '---', '', '# body', '', '## Outputs', '- g', '',
           '## Steps', '1. Set {{g}} to "${env.GREETING}"', ''].join('\n'),
        );
        return {
          file: write('t-body.md', '# T\n\n## Steps\n1. [macro: body]\n'),
          opts: { macrosDir: path.join(dir, 'macros'), envData: { env: { GREETING: HOSTILE } } },
        };
      },
    },
    {
      site: 'markdown.ts — macro SECTION body ${…}',
      refusal: /A value substituted into macro "sect" makes "Set \{\{g\}\} to …" unparseable/,
      build: () => {
        write(
          'macros/sect.md',
          ['---', 'type: macro', '---', '', '# sect', '', '## Outputs', '- g', '',
           '## Steps', '1. Inner', '', '### Inner', '',
           '1. Set {{g}} to "${env.GREETING}"', ''].join('\n'),
        );
        return {
          file: write('t-sect.md', '# T\n\n## Steps\n1. [macro: sect]\n'),
          opts: { macrosDir: path.join(dir, 'macros'), envData: { env: { GREETING: HOSTILE } } },
        };
      },
    },
    {
      site: 'expander.ts — macro arguments (output-name collision)',
      refusal: /The call to macro "args" makes "Set \{\{g\}\} to …" unparseable once its arguments are substituted/,
      build: () => {
        // NOT a hostile quoted value: the invocation parser refuses
        // `who="He said "hi""` before the expander sees it, so that half of
        // this site is unreachable. The reachable half is an argument named
        // after a declared OUTPUT — outputs are not renamed, so the value
        // bakes straight over the assignment's target and the assignment
        // silently never happens. `validateCall` only warns about an argument
        // that is not a parameter, so nothing else stops it.
        write(
          'macros/args.md',
          ['---', 'type: macro', '---', '', '# args', '', '## Parameters', '- who: n', '',
           '## Outputs', '- g', '',
           '## Steps', '1. Set {{g}} to "hi {{who}}"', ''].join('\n'),
        );
        return {
          file: write('t-args.md', '# T\n\n## Steps\n1. [macro: args who="x" g="baked"]\n'),
          opts: { macrosDir: path.join(dir, 'macros') },
        };
      },
    },
    {
      site: 'expander.ts — looped section row bindings',
      // A `"` in the row value breaks the `[^"]*` grammar once baked in, so
      // that ROW's assignment was skipped while the variable still held the
      // PREVIOUS row's value — the row then ran on stale data.
      refusal: /A row value used by "Set \{\{g\}\} to …" in the body of section "Greet" makes the step unparseable/,
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

  it.each(SITES)('refuses a hostile value at $site', async ({ build, refusal }) => {
    const { file, opts } = build();
    // Every guarded site throws rather than producing a line that is no
    // longer a Set step — each with its own message, naming the site, which
    // is what an author has to act on.
    await expect(parseTestFile(file, opts)).rejects.toThrow(refusal);
  });

  it('the HOOK site preserves rather than refuses, and that is deliberate', async () => {
    // A hook Set is not broken by baking — it is simply better resolved per
    // run, because `runHookScope` passes `envData` into `runSetStep`. So this
    // site keeps the token instead of refusing the substitution. (Baked, a
    // value containing a `"` turned the hook into an unparseable line that
    // ran as AI prose and never assigned.)
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
      'macros/plain.md',
      ['---', 'type: macro', '---', '', '# plain', '', '## Parameters', '- who: n', '',
       '## Steps', '1. Type "{{who}}" into ${env.FIELD}', ''].join('\n'),
    );
    const file = write(
      't-plain.md',
      ['# T', '', '## Hooks', '- before: Navigate to ${env.FIELD}', '',
       // A benign arg value: a quoted one containing a quote is refused by
       // the invocation parser, which is a different (and correct) refusal.
       '## Steps', '1. [macro: plain who="Alice"]', '2. Loop', '',
       '### Loop', '', '| who |', '| --- |', `| ${HOSTILE} |`, '',
       '1. Type "{{who}}" into the box', ''].join('\n'),
    );
    await expect(
      parseTestFile(file, {
        macrosDir: path.join(dir, 'macros'),
        envData: { env: { FIELD: '#search', GREETING: HOSTILE } },
      }),
    ).resolves.toBeDefined();
  });
});
