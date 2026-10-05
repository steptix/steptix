import { describe, it, expect } from 'vitest';
import {
  parseSkillCall,
  SkillCallSyntaxError,
} from '../src/skills/skill-call-parser.js';

describe('parseSkillCall — non-matches', () => {
  it('returns null for plain natural-language steps', () => {
    expect(parseSkillCall('Click the login button')).toBeNull();
    expect(parseSkillCall('Verify the page has loaded')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseSkillCall('')).toBeNull();
  });

  it('returns null for whitespace-only lines', () => {
    expect(parseSkillCall('   ')).toBeNull();
    expect(parseSkillCall('\t\t')).toBeNull();
  });

  it('returns null when `[skill:` does not appear in the line at all', () => {
    expect(parseSkillCall('Click the [submit] button')).toBeNull();
    expect(parseSkillCall('[skil: foo]')).toBeNull();
  });
});

describe('parseSkillCall — optional colon', () => {
  it('parses `[skill name]` identically to `[skill: name]`', () => {
    // Same call in every field except nameColumn — the name naturally sits
    // one character earlier when the colon is omitted.
    const bare = parseSkillCall('[skill login]');
    const colon = parseSkillCall('[skill: login]');
    expect(bare).toEqual({ ...colon, nameColumn: 7 });
  });

  it('records the same nameColumn under both spellings', () => {
    // `[skill login]` and `[skill: login]` both put `l` at column 8.
    expect(parseSkillCall('[skill  login]')?.nameColumn).toBe(8);
    expect(parseSkillCall('[skill: login]')?.nameColumn).toBe(8);
  });

  it('accepts extra whitespace, and whitespace before the colon', () => {
    expect(parseSkillCall('[skill   login]')?.name).toBe('login');
    expect(parseSkillCall('[skill : login]')?.name).toBe('login');
    expect(parseSkillCall('[skill:login]')?.name).toBe('login');
  });

  it('parses the full arg shapes without the colon', () => {
    const result = parseSkillCall(
      'Sign in [skill auth/login username role="admin" out.session_id] # note',
    );
    expect(result?.label).toBe('Sign in');
    expect(result?.name).toBe('auth/login');
    expect(result?.args).toEqual({ username: '{{username}}', role: 'admin' });
    expect(result?.outputAliases).toEqual({ session_id: 'session_id' });
    expect(result?.trailing).toBe(' # note');
  });

  it('does not claim bracketed prose that merely contains the keyword', () => {
    // No `:` and no whitespace directly after `skill` — these never open a call.
    expect(parseSkillCall('Check the [skillful] animation')).toBeNull();
    expect(parseSkillCall('Open the [skills] page')).toBeNull();
    expect(parseSkillCall('A bare [skill] token is not a call either')).toBeNull();
  });

  it('scans past a near-miss to find the real token', () => {
    expect(parseSkillCall('see [skillful] then [skill login]')?.name).toBe('login');
  });

  it('a colon-less token that does not parse is prose, not an error', () => {
    // The colon-less spelling is reachable by ordinary English, and
    // `extractSteps` throws at PARSE time — so committing to it would let one
    // prose sentence fail the whole test file. `[skill:` keeps the strict
    // reading (the syntax-error tests below); the space form degrades to prose.
    expect(parseSkillCall('[skill ]')).toBeNull();
    expect(parseSkillCall('Verify the [skill level: expert] badge')).toBeNull();
    expect(parseSkillCall('Click the [skill (beta)] badge')).toBeNull();
    expect(parseSkillCall('Confirm the [skill 50%] chip')).toBeNull();
  });
});

describe('parseSkillCall — markdown links are not invocations', () => {
  // `[text](url)` is the likeliest way a bracketed keyword appears in a
  // markdown-authored suite. Claiming it resolved a skill named after the
  // link text and failed the ENTIRE file when no such skill existed.
  it('does not claim a link, in either spelling', () => {
    expect(parseSkillCall('Click the [skill guide](https://example.com) link')).toBeNull();
    expect(parseSkillCall('Open the [skill matrix](./m.md) and verify')).toBeNull();
    expect(parseSkillCall('See [skill: guide](./g.md) for details')).toBeNull();
  });

  it('still parses a real call followed by a parenthesised comment', () => {
    // Only an IMMEDIATELY adjacent `(` is a link.
    const result = parseSkillCall('[skill: login] (smoke only)');
    expect(result?.name).toBe('login');
    expect(result?.trailing).toBe(' (smoke only)');
  });

  it('a declined candidate does not swallow a real call later on the line', () => {
    // The scan resumes past a link or an unparseable colon-less token. Taking
    // only the FIRST candidate made these prose, silently skipping a live
    // call the runner should have dispatched.
    expect(parseSkillCall('See the [skill guide](./g.md) and then [skill: login]')?.name).toBe(
      'login',
    );
    expect(
      parseSkillCall('Check the [skill level: expert] badge then [skill: login]')?.name,
    ).toBe('login');
    // …and a line of nothing but declined candidates is still prose.
    expect(parseSkillCall('The [skill guide](./g.md) and the [skill matrix](./m.md)')).toBeNull();
  });
});

describe('parseSkillCall — label prefix', () => {
  it('captures text before `[skill:` as the step label, trimmed', () => {
    const result = parseSkillCall('Search with DuckDuckGo [skill: duckduckgo]');
    expect(result?.name).toBe('duckduckgo');
    expect(result?.label).toBe('Search with DuckDuckGo');
  });

  it('trims surrounding whitespace from the label', () => {
    const result = parseSkillCall('   Sign in   [skill: login]');
    expect(result?.label).toBe('Sign in');
  });

  it('preserves internal whitespace inside the label', () => {
    const result = parseSkillCall('Click  and verify [skill: foo]');
    expect(result?.label).toBe('Click  and verify');
  });

  it('accepts a stray `[` in the label without treating it as the prefix', () => {
    const result = parseSkillCall('Step [1/3] [skill: foo]');
    expect(result?.label).toBe('Step [1/3]');
    expect(result?.name).toBe('foo');
  });

  it('matches the first `[skill:` when the label happens to contain another', () => {
    // Ambiguous user input — we resolve by binding to the first occurrence.
    // The second `[skill:` lives in `trailing` and isn't re-scanned.
    const result = parseSkillCall('a [skill: x] b [skill: y]');
    expect(result?.name).toBe('x');
    expect(result?.label).toBe('a');
    expect(result?.trailing).toBe(' b [skill: y]');
  });
});

describe('parseSkillCall — happy path', () => {
  it('parses a skill with no arguments', () => {
    const result = parseSkillCall('[skill: foo]');
    expect(result).toEqual({
      name: 'foo',
      // 0-based column of `f` in `[skill: foo]` — recorded by the tokenizer so
      // callers can point a caret at the name without re-deriving the offset.
      nameColumn: 8,
      args: {},
      outputAliases: {},
      trailing: '',
    });
  });

  it('tolerates leading whitespace, and does not keep it as a label', () => {
    const result = parseSkillCall('   [skill: foo]');
    expect(result?.name).toBe('foo');
    expect(result?.label).toBeUndefined();
  });

  it('parses an explicit `key="value"` argument', () => {
    const result = parseSkillCall('[skill: foo bar="baz"]');
    expect(result?.args).toEqual({ bar: 'baz' });
  });

  it('parses multiple explicit arguments', () => {
    const result = parseSkillCall('[skill: foo a="1" b="2" c="3"]');
    expect(result?.args).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('parses an `out.name="alias"` rename', () => {
    const result = parseSkillCall('[skill: foo out.x="renamed"]');
    expect(result?.outputAliases).toEqual({ x: 'renamed' });
    expect(result?.args).toEqual({});
  });

  it('preserves trailing comment text after the closing `]`', () => {
    const result = parseSkillCall('[skill: foo] # human-readable note');
    expect(result?.name).toBe('foo');
    expect(result?.trailing).toBe(' # human-readable note');
  });

  it('accepts hyphens in the skill name', () => {
    const result = parseSkillCall('[skill: my-cool-skill]');
    expect(result?.name).toBe('my-cool-skill');
  });

  it('accepts a path-qualified name for a skill in a subfolder', () => {
    const result = parseSkillCall('[skill: auth/login]');
    expect(result?.name).toBe('auth/login');
  });

  it('canonicalises away a leading slash so both spellings name one skill', () => {
    expect(parseSkillCall('[skill: /auth/login]')?.name).toBe('auth/login');
    expect(parseSkillCall('[skill: /capture_url]')?.name).toBe('capture_url');
  });

  it('parses args and out. aliases on a path-qualified call', () => {
    const result = parseSkillCall(
      '[skill: /auth/login username password role="admin" out.session_id="admin_session"] # note',
    );
    expect(result?.name).toBe('auth/login');
    expect(result?.args).toEqual({
      username: '{{username}}',
      password: '{{password}}',
      role: 'admin',
    });
    expect(result?.outputAliases).toEqual({ session_id: 'admin_session' });
    expect(result?.trailing).toBe(' # note');
  });

  it('accepts arbitrary text inside a quoted value, including `]` and `=`', () => {
    const result = parseSkillCall('[skill: foo q="a]b=c d"]');
    expect(result?.args).toEqual({ q: 'a]b=c d' });
  });

  it('accepts an empty quoted value', () => {
    const result = parseSkillCall('[skill: foo q=""]');
    expect(result?.args).toEqual({ q: '' });
  });
});

describe('parseSkillCall — bare-identifier shorthand', () => {
  it('desugars a bare param to `{{param}}`', () => {
    const result = parseSkillCall('[skill: login password]');
    expect(result?.args).toEqual({ password: '{{password}}' });
  });

  it('desugars multiple bare params', () => {
    const result = parseSkillCall('[skill: login username password]');
    expect(result?.args).toEqual({
      username: '{{username}}',
      password: '{{password}}',
    });
  });

  it('desugars a bare `out.name` to alias = name', () => {
    const result = parseSkillCall('[skill: foo out.session_id]');
    expect(result?.outputAliases).toEqual({ session_id: 'session_id' });
  });
});

describe('parseSkillCall — syntax errors', () => {
  it('throws on an unclosed skill invocation', () => {
    expect(() => parseSkillCall('[skill: foo')).toThrow(SkillCallSyntaxError);
    try {
      parseSkillCall('[skill: foo');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillCallSyntaxError);
      const err = e as SkillCallSyntaxError;
      expect(err.reason).toMatch(/expected '\]'/);
      expect(err.column).toBe('[skill: foo'.length);
    }
  });

  it('throws when the skill name is missing', () => {
    try {
      parseSkillCall('[skill: ]');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillCallSyntaxError);
      expect((e as SkillCallSyntaxError).reason).toMatch(/name missing/);
    }
  });

  it('throws on an unterminated string and points at the opening quote', () => {
    const line = '[skill: login password="{{password}}]';
    try {
      parseSkillCall(line);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillCallSyntaxError);
      const err = e as SkillCallSyntaxError;
      expect(err.reason).toMatch(/unterminated string for argument 'password'/);
      // Column should land on the opening quote of the broken arg.
      expect(line[err.column]).toBe('"');
    }
  });

  it('throws when `=` is not followed by `"`', () => {
    const line = '[skill: foo bar=baz]';
    try {
      parseSkillCall(line);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as SkillCallSyntaxError;
      expect(err.reason).toMatch(
        /expected '"', '\[', a number, or true\/false after '=' for argument 'bar'/,
      );
      expect(line[err.column]).toBe('b');
    }
  });

  it('throws on a stray character after a bare argument', () => {
    expect(() => parseSkillCall('[skill: foo bar! ]')).toThrow(
      /unexpected character '!' after argument 'bar'/,
    );
  });

  it('throws when args are not separated by whitespace', () => {
    expect(() => parseSkillCall('[skill: foo bar="x"baz="y"]')).toThrow(
      /expected whitespace or '\]' before next argument/,
    );
  });

  it('throws when `out.` is not followed by an identifier', () => {
    expect(() => parseSkillCall('[skill: foo out. ]')).toThrow(
      /expected output name after 'out\.'/,
    );
  });

  it('throws on a doubled slash in the name', () => {
    expect(() => parseSkillCall('[skill: auth//login]')).toThrow(
      SkillCallSyntaxError,
    );
    expect(() => parseSkillCall('[skill: auth//login]')).toThrow(
      /empty path segment/,
    );
  });

  it('throws on a trailing slash in the name', () => {
    expect(() => parseSkillCall('[skill: auth/]')).toThrow(/empty path segment/);
  });

  it('throws on a name that is nothing but a slash', () => {
    expect(() => parseSkillCall('[skill: /]')).toThrow(/empty path segment/);
  });

  it('throws on a name of nothing but slashes', () => {
    // The leading-slash strip leaves `/`, whose segments are both empty.
    expect(() => parseSkillCall('[skill: //]')).toThrow(/empty path segment/);
  });

  it('points the caret at the malformed name', () => {
    const line = '1. [skill: auth//login]';
    try {
      parseSkillCall(line);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillCallSyntaxError);
      const err = e as SkillCallSyntaxError;
      expect(err.column).toBe(line.indexOf('auth//login'));
    }
  });

  it('points the caret at the invocation, not at a label that repeats the name', () => {
    // The caret column must come from the tokenizer's recorded position. A
    // re-derived `line.indexOf(name)` finds the LABEL's copy at column 0 and
    // decorates the wrong half of the line.
    const line = 'auth//login [skill: auth//login]';
    try {
      parseSkillCall(line);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillCallSyntaxError);
      const err = e as SkillCallSyntaxError;
      expect(err.column).toBe(20);
      expect(line.slice(err.column)).toBe('auth//login]');
    }
  });
});

describe('parseSkillCall — traversal is unlexable', () => {
  // `loadSkill` does `path.resolve(skillsDir, name + '.md')` with NO containment
  // check, and is safe only because of two properties: the name grammar admits
  // no `.` and no `\`, and `parseSkillCall` strips the leading slash before
  // anything resolves. These pin the first half — every spelling of a traversal
  // attempt must die at the tokenizer, not reach the filesystem.
  const traversals = [
    '[skill: ../x]',       // `.` is not in the name class → no name at all
    '[skill: a/../b]',     // reads `a/`, stops at `.` → trailing empty segment
    '[skill: a\\b]',       // `\` is not in the name class → stray character
    '[skill: C:/x]',       // `:` is not in the name class → stray character
  ];

  for (const line of traversals) {
    it(`refuses ${line}`, () => {
      expect(() => parseSkillCall(line)).toThrow(SkillCallSyntaxError);
    });
  }

  it('error message includes the source line and a caret', () => {
    const line = '[skill: foo bar=baz]';
    try {
      parseSkillCall(line);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as SkillCallSyntaxError;
      const lines = err.message.split('\n');
      // Format: <reason>\n  <source>\n  <caret>
      expect(lines[1]).toContain(line);
      expect(lines[2]).toMatch(/^\s+\^$/);
    }
  });
});
