import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandSkills, clearSkillCache } from '../src/skills/expander.js';
import { parseTestFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
  clearSkillCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Write `<tmpDir>/<name>.md`. `name` may be path-qualified (`auth/login`),
 *  in which case the subfolder is created — that is how a skill reached by
 *  `[skill: auth/login]` sits on disk. */
async function writeSkill(name: string, content: string): Promise<void> {
  const file = path.join(tmpDir, `${name}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

describe('expandSkills', () => {
  it('returns steps unchanged when no skill references are present', async () => {
    const steps = ['Click login', 'Type username'];
    const result = await expandSkills(steps, tmpDir);
    expect(result.steps).toEqual(steps);
    expect(result.sourceSkills).toEqual([null, null]);
  });

  it('inlines a skill body and interpolates parameters', async () => {
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
      ['[skill: search query="GPT-5"]', 'Verify results loaded'],
      tmpDir,
    );

    expect(result.steps).toEqual([
      'Navigate to https://example.com',
      'Type "GPT-5" into the search box',
      'Verify results loaded',
    ]);
    expect(result.sourceSkills).toEqual(['search', 'search', null]);
  });

  it('mints a distinct frame per invocation when one skill is used twice (issue 016 / Bug 1)', async () => {
    // Foundation of the Bug 1 cache-key fix: each [skill: ...] invocation must
    // get its own frame, so two invocations of one skill — whose body steps
    // share the same skill-file line — are distinguishable downstream. If the
    // expander reused a frame id here, the frame-scoped cache key would collide
    // again and the second invocation would replay the first's cached actions.
    await writeSkill(
      'echo',
      `---
type: skill
---
# echo
## Parameters
- msg: the message
## Steps
1. Note "{{msg}}"
`,
    );

    const result = await expandSkills(
      ['[skill: echo msg="a"]', '[skill: echo msg="b"]'],
      tmpDir,
    );

    expect(result.steps).toEqual(['Note "a"', 'Note "b"']);
    expect(result.origins).toHaveLength(2);
    const [o0, o1] = result.origins;
    expect(o0!.frameId).toMatch(/^f\d+$/);
    expect(o1!.frameId).toMatch(/^f\d+$/);
    expect(o0!.frameId).not.toBe(o1!.frameId);   // distinct frames per invocation
    expect(o0!.skillLine).toBe(o1!.skillLine);   // same source line in the skill file
  });

  it('strips trailing comment text after the skill bracket', async () => {
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

    const result = await expandSkills(
      ['[skill: noop] human-readable comment that should be ignored'],
      tmpDir,
    );

    expect(result.steps).toEqual(['Do nothing']);
  });

  it('namespaces internal capture names so they cannot collide with the caller', async () => {
    await writeSkill(
      'capture',
      `---
type: skill
---
# capture
## Steps
1. Read the value [store as: temp]
2. Type {{temp}} into the field
`,
    );

    const result = await expandSkills(['[skill: capture]'], tmpDir);

    expect(result.steps[0]).toBe('Read the value [store as: __skill1_temp]');
    expect(result.steps[1]).toBe('Type {{__skill1_temp}} into the field');
  });

  it('declared outputs leak under their declared name when no alias is given', async () => {
    await writeSkill(
      'count',
      `---
type: skill
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
    );

    const result = await expandSkills(
      ['[skill: count]', 'The page shows {{result_count}} items'],
      tmpDir,
    );

    expect(result.steps[0]).toBe('Count rows [store as: result_count]');
    expect(result.steps[1]).toBe('The page shows {{result_count}} items');
  });

  it('renames outputs when caller provides out.<name>="alias"', async () => {
    await writeSkill(
      'count',
      `---
type: skill
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
    );

    const result = await expandSkills(
      ['[skill: count out.result_count="my_count"]', 'Total: {{my_count}}'],
      tmpDir,
    );

    expect(result.steps[0]).toBe('Count rows [store as: my_count]');
    expect(result.steps[1]).toBe('Total: {{my_count}}');
  });

  it('throws when a required parameter is missing', async () => {
    await writeSkill(
      'search',
      `---
type: skill
---
# search
## Parameters
- query: required
## Steps
1. Search for {{query}}
`,
    );

    await expect(expandSkills(['[skill: search]'], tmpDir)).rejects.toThrow(
      /requires parameter "query"/,
    );
  });

  it('throws when caller aliases an undeclared output', async () => {
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

    await expect(
      expandSkills(['[skill: noop out.bogus="x"]'], tmpDir),
    ).rejects.toThrow(/no declared output "bogus"/);
  });

  it('throws when the skill file does not exist', async () => {
    await expect(
      expandSkills(['[skill: missing_skill]'], tmpDir),
    ).rejects.toThrow(/Skill "missing_skill" not found/);
  });

  it('resolves a path-qualified name into a subfolder of skillsDir', async () => {
    await writeSkill(
      'auth/login',
      `---
type: skill
---
# login
## Parameters
- username: the account
## Steps
1. Navigate to the login page
2. Type "{{username}}" into the username field
`,
    );

    const result = await expandSkills(
      ['[skill: auth/login username="admin"]', 'Verify the dashboard loads'],
      tmpDir,
    );

    expect(result.steps).toEqual([
      'Navigate to the login page',
      'Type "admin" into the username field',
      'Verify the dashboard loads',
    ]);
    expect(result.sourceSkills).toEqual(['auth/login', 'auth/login', null]);
  });

  it('treats a leading slash as sugar for the same subfolder skill', async () => {
    await writeSkill(
      'auth/login',
      `---
type: skill
---
# login
## Parameters
- username: the account
## Steps
1. Navigate to the login page
2. Type "{{username}}" into the username field
`,
    );

    const bare = await expandSkills(['[skill: auth/login username="admin"]'], tmpDir);
    const slashed = await expandSkills(['[skill: /auth/login username="admin"]'], tmpDir);

    expect(slashed.steps).toEqual(bare.steps);
    // The canonical (slash-free) name is what everything downstream sees, so a
    // report badge and a frame name read the same either way it was authored.
    expect(slashed.sourceSkills).toEqual(['auth/login', 'auth/login']);
    expect(slashed.sourceSkills).toEqual(bare.sourceSkills);
  });

  it('names the skill and the full resolved path when a subfolder skill is missing', async () => {
    await expect(expandSkills(['[skill: auth/nope]'], tmpDir)).rejects.toThrow(
      /Skill "auth\/nope" not found at .*auth[\\/]nope\.md/,
    );
  });

  it('detects direct cycles', async () => {
    await writeSkill(
      'a',
      `---
type: skill
---
# a
## Steps
1. [skill: a]
`,
    );

    await expect(expandSkills(['[skill: a]'], tmpDir)).rejects.toThrow(
      /Skill cycle detected/,
    );
  });

  it('detects indirect cycles', async () => {
    await writeSkill(
      'a',
      `---
type: skill
---
# a
## Steps
1. [skill: b]
`,
    );
    await writeSkill(
      'b',
      `---
type: skill
---
# b
## Steps
1. [skill: a]
`,
    );

    await expect(expandSkills(['[skill: a]'], tmpDir)).rejects.toThrow(
      /Skill cycle detected: a -> b -> a/,
    );
  });

  it('sees through both spellings when detecting a cycle', async () => {
    // The two skills reference each other with the *other* spelling to the one
    // the entry point uses. Only because `parseSkillCall` canonicalises does
    // the `visited` set recognise `/a/x` as the `a/x` already on the stack —
    // otherwise this recurses until the depth guard instead of naming a cycle.
    await writeSkill(
      'a/x',
      `---
type: skill
---
# x
## Steps
1. [skill: /a/y]
`,
    );
    await writeSkill(
      'a/y',
      `---
type: skill
---
# y
## Steps
1. [skill: /a/x]
`,
    );

    await expect(expandSkills(['[skill: a/x]'], tmpDir)).rejects.toThrow(
      /Skill cycle detected: a\/x -> a\/y -> a\/x/,
    );
  });

  it('expands nested skills recursively', async () => {
    await writeSkill(
      'inner',
      `---
type: skill
---
# inner
## Parameters
- text: input
## Steps
1. Type "{{text}}"
`,
    );
    await writeSkill(
      'outer',
      `---
type: skill
---
# outer
## Parameters
- name: input
## Steps
1. Click start
2. [skill: inner text="hello {{name}}"]
3. Click finish
`,
    );

    const result = await expandSkills(['[skill: outer name="world"]'], tmpDir);

    expect(result.steps).toEqual([
      'Click start',
      'Type "hello world"',
      'Click finish',
    ]);
    // Outermost-skill attribution: every step inside `outer` is tagged with
    // `outer`, including the steps that were physically authored in `inner`.
    expect(result.sourceSkills).toEqual(['outer', 'outer', 'outer']);
  });

  it('two invocations of the same skill get distinct internal namespaces', async () => {
    await writeSkill(
      'cap',
      `---
type: skill
---
# cap
## Steps
1. Read [store as: x]
`,
    );

    const result = await expandSkills(
      ['[skill: cap]', '[skill: cap]'],
      tmpDir,
    );

    expect(result.steps[0]).toBe('Read [store as: __skill1_x]');
    expect(result.steps[1]).toBe('Read [store as: __skill2_x]');
  });

  describe('bare-identifier shorthand', () => {
    it('expands a bare param to a {{name}} placeholder forwarded to the skill body', async () => {
      await writeSkill(
        'login',
        `---
type: skill
---
# login
## Parameters
- password: required
## Steps
1. Type "{{password}}" into the password field
`,
      );

      const result = await expandSkills(['[skill: login password]'], tmpDir);

      // The shorthand sets args.password = "{{password}}", so after the
      // skill body is interpolated, the literal `{{password}}` survives in the
      // expanded step — to be resolved against the caller's parameter scope at
      // runtime.
      expect(result.steps).toEqual([
        'Type "{{password}}" into the password field',
      ]);
    });

    it('mixes bare and explicit args in one call', async () => {
      await writeSkill(
        'login',
        `---
type: skill
---
# login
## Parameters
- username: required
- password: required
- role: required
## Steps
1. Type "{{username}}" / "{{password}}" with role "{{role}}"
`,
      );

      const result = await expandSkills(
        ['[skill: login username password role="admin"]'],
        tmpDir,
      );

      expect(result.steps).toEqual([
        'Type "{{username}}" / "{{password}}" with role "admin"',
      ]);
    });

    it('bare `out.name` validates against declared outputs and leaks under that name', async () => {
      await writeSkill(
        'count',
        `---
type: skill
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
      );

      const result = await expandSkills(
        ['[skill: count out.result_count]', 'Total: {{result_count}}'],
        tmpDir,
      );

      expect(result.steps).toEqual([
        'Count rows [store as: result_count]',
        'Total: {{result_count}}',
      ]);
    });

    it('bare `out.<name>` for an undeclared output throws (catches typos)', async () => {
      await writeSkill(
        'count',
        `---
type: skill
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
      );

      await expect(
        expandSkills(['[skill: count out.resultcount]'], tmpDir),
      ).rejects.toThrow(/no declared output "resultcount"/);
    });
  });

  describe('syntax errors are surfaced', () => {
    it('throws a SkillCallSyntaxError with caret diagnostic on unterminated quote', async () => {
      await expect(
        expandSkills(['[skill: login password="{{password}}]'], tmpDir),
      ).rejects.toThrow(/unterminated string for argument 'password'/);
    });

    it('throws on missing closing bracket', async () => {
      await expect(
        expandSkills(['[skill: foo'], tmpDir),
      ).rejects.toThrow(/expected '\]'/);
    });

    it('throws on an unquoted `key=value` argument', async () => {
      await expect(
        expandSkills(['[skill: foo bar=baz]'], tmpDir),
      ).rejects.toThrow(
        /expected '"', '\[', a number, or true\/false after '=' for argument 'bar'/,
      );
    });
  });
});

describe('parseTestFile with skillsDir', () => {
  it('expands skills inline when skillsDir is provided', async () => {
    await writeSkill(
      'login',
      `---
type: skill
---
# login
## Parameters
- user: username
## Steps
1. Type "{{user}}" into the username field
2. Click submit
`,
    );

    const testPath = path.join(tmpDir, 'mytest.md');
    await fs.writeFile(
      testPath,
      `# My test\n\n## Steps\n1. [skill: login user="alice"]\n2. Verify dashboard\n`,
    );

    const parsed = await parseTestFile(testPath, { skillsDir: tmpDir });

    expect(parsed.steps).toEqual([
      'Type "alice" into the username field',
      'Click submit',
      'Verify dashboard',
    ]);
  });

  it('leaves skill references intact when no skillsDir is provided', async () => {
    const testPath = path.join(tmpDir, 'mytest.md');
    await fs.writeFile(
      testPath,
      `# My test\n\n## Steps\n1. [skill: login user="alice"]\n`,
    );

    const parsed = await parseTestFile(testPath);
    expect(parsed.steps).toEqual(['[skill: login user="alice"]']);
  });
});
