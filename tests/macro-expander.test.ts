import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expandMacros, clearMacroCache } from '../src/macros/expander.js';
import { parseTestFile } from '../src/parser/markdown.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'macro-test-'));
  clearMacroCache();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Write `<tmpDir>/<name>.md`. `name` may be path-qualified (`auth/login`),
 *  in which case the subfolder is created — that is how a macro reached by
 *  `[macro: auth/login]` sits on disk. */
async function writeMacro(name: string, content: string): Promise<void> {
  const file = path.join(tmpDir, `${name}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

describe('expandMacros', () => {
  it('returns steps unchanged when no macro references are present', async () => {
    const steps = ['Click login', 'Type username'];
    const result = await expandMacros(steps, tmpDir);
    expect(result.steps).toEqual(steps);
    expect(result.sourceMacros).toEqual([null, null]);
  });

  it('inlines a macro body and interpolates parameters', async () => {
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
      ['[macro: search query="GPT-5"]', 'Verify results loaded'],
      tmpDir,
    );

    expect(result.steps).toEqual([
      'Navigate to https://example.com',
      'Type "GPT-5" into the search box',
      'Verify results loaded',
    ]);
    expect(result.sourceMacros).toEqual(['search', 'search', null]);
  });

  it('mints a distinct frame per invocation when one macro is used twice', async () => {
    // Each [macro: ...] invocation must get its own frame, so two invocations
    // of one macro — whose body steps share the same macro-file line — are
    // distinguishable downstream (report rows, call stack, `[store as:]`
    // namespacing).
    await writeMacro(
      'echo',
      `---
type: macro
---
# echo
## Parameters
- msg: the message
## Steps
1. Note "{{msg}}"
`,
    );

    const result = await expandMacros(
      ['[macro: echo msg="a"]', '[macro: echo msg="b"]'],
      tmpDir,
    );

    expect(result.steps).toEqual(['Note "a"', 'Note "b"']);
    expect(result.origins).toHaveLength(2);
    const [o0, o1] = result.origins;
    expect(o0!.frameId).toMatch(/^f\d+$/);
    expect(o1!.frameId).toMatch(/^f\d+$/);
    expect(o0!.frameId).not.toBe(o1!.frameId);   // distinct frames per invocation
    expect(o0!.macroLine).toBe(o1!.macroLine);   // same source line in the macro file
  });

  it('strips trailing comment text after the macro bracket', async () => {
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

    const result = await expandMacros(
      ['[macro: noop] human-readable comment that should be ignored'],
      tmpDir,
    );

    expect(result.steps).toEqual(['Do nothing']);
  });

  it('namespaces internal capture names so they cannot collide with the caller', async () => {
    await writeMacro(
      'capture',
      `---
type: macro
---
# capture
## Steps
1. Read the value [store as: temp]
2. Type {{temp}} into the field
`,
    );

    const result = await expandMacros(['[macro: capture]'], tmpDir);

    expect(result.steps[0]).toBe('Read the value [store as: __macro1_temp]');
    expect(result.steps[1]).toBe('Type {{__macro1_temp}} into the field');
  });

  it('declared outputs leak under their declared name when no alias is given', async () => {
    await writeMacro(
      'count',
      `---
type: macro
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
    );

    const result = await expandMacros(
      ['[macro: count]', 'The page shows {{result_count}} items'],
      tmpDir,
    );

    expect(result.steps[0]).toBe('Count rows [store as: result_count]');
    expect(result.steps[1]).toBe('The page shows {{result_count}} items');
  });

  it('renames outputs when caller provides out.<name>="alias"', async () => {
    await writeMacro(
      'count',
      `---
type: macro
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
    );

    const result = await expandMacros(
      ['[macro: count out.result_count="my_count"]', 'Total: {{my_count}}'],
      tmpDir,
    );

    expect(result.steps[0]).toBe('Count rows [store as: my_count]');
    expect(result.steps[1]).toBe('Total: {{my_count}}');
  });

  it('throws when a required parameter is missing', async () => {
    await writeMacro(
      'search',
      `---
type: macro
---
# search
## Parameters
- query: required
## Steps
1. Search for {{query}}
`,
    );

    await expect(expandMacros(['[macro: search]'], tmpDir)).rejects.toThrow(
      /requires parameter "query"/,
    );
  });

  it('throws when caller aliases an undeclared output', async () => {
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

    await expect(
      expandMacros(['[macro: noop out.bogus="x"]'], tmpDir),
    ).rejects.toThrow(/no declared output "bogus"/);
  });

  it('throws when the macro file does not exist', async () => {
    await expect(
      expandMacros(['[macro: missing_macro]'], tmpDir),
    ).rejects.toThrow(/Macro "missing_macro" not found/);
  });

  it('resolves a path-qualified name into a subfolder of macrosDir', async () => {
    await writeMacro(
      'auth/login',
      `---
type: macro
---
# login
## Parameters
- username: the account
## Steps
1. Navigate to the login page
2. Type "{{username}}" into the username field
`,
    );

    const result = await expandMacros(
      ['[macro: auth/login username="admin"]', 'Verify the dashboard loads'],
      tmpDir,
    );

    expect(result.steps).toEqual([
      'Navigate to the login page',
      'Type "admin" into the username field',
      'Verify the dashboard loads',
    ]);
    expect(result.sourceMacros).toEqual(['auth/login', 'auth/login', null]);
  });

  it('treats a leading slash as sugar for the same subfolder macro', async () => {
    await writeMacro(
      'auth/login',
      `---
type: macro
---
# login
## Parameters
- username: the account
## Steps
1. Navigate to the login page
2. Type "{{username}}" into the username field
`,
    );

    const bare = await expandMacros(['[macro: auth/login username="admin"]'], tmpDir);
    const slashed = await expandMacros(['[macro: /auth/login username="admin"]'], tmpDir);

    expect(slashed.steps).toEqual(bare.steps);
    // The canonical (slash-free) name is what everything downstream sees, so a
    // report badge and a frame name read the same either way it was authored.
    expect(slashed.sourceMacros).toEqual(['auth/login', 'auth/login']);
    expect(slashed.sourceMacros).toEqual(bare.sourceMacros);
  });

  it('names the macro and the full resolved path when a subfolder macro is missing', async () => {
    await expect(expandMacros(['[macro: auth/nope]'], tmpDir)).rejects.toThrow(
      /Macro "auth\/nope" not found at .*auth[\\/]nope\.md/,
    );
  });

  it('resolves a leading-slash name INSIDE macrosDir, not at the filesystem root', async () => {
    // The containment property, asserted through the not-found message: the
    // leading slash must be stripped BEFORE `path.resolve`, which would
    // otherwise read `/nope.md` as absolute and land on the drive root. The
    // message also proves the canonical (slash-free) name is what surfaces.
    const escaped = tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(expandMacros(['[macro: /nope]'], tmpDir)).rejects.toThrow(
      new RegExp(`Macro "nope" not found at ${escaped}[\\\\/]nope\\.md`),
    );
  });

  it('resolves a `### Section` inside a subfolder macro', async () => {
    // A macro-private section is called by bare name from the macro's own body.
    // The section index is built from the macro file, so a subfolder macro's
    // sections must resolve exactly like a flat one's.
    await writeMacro(
      'flows/greet',
      `---
type: macro
---
# greet
## Parameters
- who: the name
## Steps
1. Say hello

### Say hello
1. Greet {{who}}
`,
    );

    const result = await expandMacros(['[macro: flows/greet who="alice"]'], tmpDir);

    expect(result.steps).toEqual(['Greet alice']);
    expect(result.sourceMacros).toEqual(['flows/greet']);
  });

  it('names the invocation too when the H1 differs from the path-qualified call', async () => {
    // `macro.name` is the H1, so two subfolders can hold the same one
    // (`auth/login.md` and `admin/login.md` are both `# login`). Without the
    // suffix, the error names neither file.
    await writeMacro(
      'auth/login',
      `---
type: macro
---
# login
## Parameters
- username: the account
## Steps
1. Type "{{username}}"
`,
    );

    await expect(expandMacros(['[macro: auth/login]'], tmpDir)).rejects.toThrow(
      /Macro "login" requires parameter "username" but caller did not supply it \(invoked as "auth\/login"\)/,
    );

    // The undeclared-output refusal carries the same suffix — with
    // auth/login.md and admin/login.md both conventionally `# login`, a
    // message naming only the H1 identifies neither file.
    await expect(
      expandMacros(['[macro: auth/login username="u" out.token="t"]'], tmpDir),
    ).rejects.toThrow(
      /Macro "login" has no declared output "token" — declared outputs: \[none\] \(invoked as "auth\/login"\)/,
    );
  });

  it('detects direct cycles', async () => {
    await writeMacro(
      'a',
      `---
type: macro
---
# a
## Steps
1. [macro: a]
`,
    );

    await expect(expandMacros(['[macro: a]'], tmpDir)).rejects.toThrow(
      /Macro cycle detected/,
    );
  });

  it('detects indirect cycles', async () => {
    await writeMacro(
      'a',
      `---
type: macro
---
# a
## Steps
1. [macro: b]
`,
    );
    await writeMacro(
      'b',
      `---
type: macro
---
# b
## Steps
1. [macro: a]
`,
    );

    await expect(expandMacros(['[macro: a]'], tmpDir)).rejects.toThrow(
      /Macro cycle detected: a -> b -> a/,
    );
  });

  it('sees through both spellings when detecting a cycle', async () => {
    // The two macros reference each other with the *other* spelling to the one
    // the entry point uses. Only because `parseMacroCall` canonicalises does
    // the `visited` set recognise `/a/x` as the `a/x` already on the stack —
    // otherwise this recurses until the depth guard instead of naming a cycle.
    await writeMacro(
      'a/x',
      `---
type: macro
---
# x
## Steps
1. [macro: /a/y]
`,
    );
    await writeMacro(
      'a/y',
      `---
type: macro
---
# y
## Steps
1. [macro: /a/x]
`,
    );

    await expect(expandMacros(['[macro: a/x]'], tmpDir)).rejects.toThrow(
      /Macro cycle detected: a\/x -> a\/y -> a\/x/,
    );
  });

  it('expands nested macros recursively', async () => {
    await writeMacro(
      'inner',
      `---
type: macro
---
# inner
## Parameters
- text: input
## Steps
1. Type "{{text}}"
`,
    );
    await writeMacro(
      'outer',
      `---
type: macro
---
# outer
## Parameters
- name: input
## Steps
1. Click start
2. [macro: inner text="hello {{name}}"]
3. Click finish
`,
    );

    const result = await expandMacros(['[macro: outer name="world"]'], tmpDir);

    expect(result.steps).toEqual([
      'Click start',
      'Type "hello world"',
      'Click finish',
    ]);
    // Outermost-macro attribution: every step inside `outer` is tagged with
    // `outer`, including the steps that were physically authored in `inner`.
    expect(result.sourceMacros).toEqual(['outer', 'outer', 'outer']);
  });

  it('two invocations of the same macro get distinct internal namespaces', async () => {
    await writeMacro(
      'cap',
      `---
type: macro
---
# cap
## Steps
1. Read [store as: x]
`,
    );

    const result = await expandMacros(
      ['[macro: cap]', '[macro: cap]'],
      tmpDir,
    );

    expect(result.steps[0]).toBe('Read [store as: __macro1_x]');
    expect(result.steps[1]).toBe('Read [store as: __macro2_x]');
  });

  describe('bare-identifier shorthand', () => {
    it('expands a bare param to a {{name}} placeholder forwarded to the macro body', async () => {
      await writeMacro(
        'login',
        `---
type: macro
---
# login
## Parameters
- password: required
## Steps
1. Type "{{password}}" into the password field
`,
      );

      const result = await expandMacros(['[macro: login password]'], tmpDir);

      // The shorthand sets args.password = "{{password}}", so after the
      // macro body is interpolated, the literal `{{password}}` survives in the
      // expanded step — to be resolved against the caller's parameter scope at
      // runtime.
      expect(result.steps).toEqual([
        'Type "{{password}}" into the password field',
      ]);
    });

    it('mixes bare and explicit args in one call', async () => {
      await writeMacro(
        'login',
        `---
type: macro
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

      const result = await expandMacros(
        ['[macro: login username password role="admin"]'],
        tmpDir,
      );

      expect(result.steps).toEqual([
        'Type "{{username}}" / "{{password}}" with role "admin"',
      ]);
    });

    it('bare `out.name` validates against declared outputs and leaks under that name', async () => {
      await writeMacro(
        'count',
        `---
type: macro
---
# count
## Outputs
- result_count
## Steps
1. Count rows [store as: result_count]
`,
      );

      const result = await expandMacros(
        ['[macro: count out.result_count]', 'Total: {{result_count}}'],
        tmpDir,
      );

      expect(result.steps).toEqual([
        'Count rows [store as: result_count]',
        'Total: {{result_count}}',
      ]);
    });
  });

  describe('syntax errors are surfaced', () => {
    it('throws a MacroCallSyntaxError with caret diagnostic on unterminated quote', async () => {
      await expect(
        expandMacros(['[macro: login password="{{password}}]'], tmpDir),
      ).rejects.toThrow(/unterminated string for argument 'password'/);
    });
  });
});

describe('parseTestFile with macrosDir', () => {
  it('expands macros inline when macrosDir is provided', async () => {
    await writeMacro(
      'login',
      `---
type: macro
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
      `# My test\n\n## Steps\n1. [macro: login user="alice"]\n2. Verify dashboard\n`,
    );

    const parsed = await parseTestFile(testPath, { macrosDir: tmpDir });

    expect(parsed.steps).toEqual([
      'Type "alice" into the username field',
      'Click submit',
      'Verify dashboard',
    ]);
  });

  it('leaves macro references intact when no macrosDir is provided', async () => {
    const testPath = path.join(tmpDir, 'mytest.md');
    await fs.writeFile(
      testPath,
      `# My test\n\n## Steps\n1. [macro: login user="alice"]\n`,
    );

    const parsed = await parseTestFile(testPath);
    expect(parsed.steps).toEqual(['[macro: login user="alice"]']);
  });
});
