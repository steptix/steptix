import { describe, it, expect } from 'vitest';
import {
  parseMacroCall,
  MacroCallSyntaxError,
} from '../src/macros/macro-call-parser.js';

describe('parseMacroCall — non-matches', () => {
  it('returns null for plain natural-language steps', () => {
    expect(parseMacroCall('Click the login button')).toBeNull();
    expect(parseMacroCall('Verify the page has loaded')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseMacroCall('')).toBeNull();
  });

  it('returns null for whitespace-only lines', () => {
    expect(parseMacroCall('   ')).toBeNull();
    expect(parseMacroCall('\t\t')).toBeNull();
  });

  it('returns null when `[macro:` does not appear in the line at all', () => {
    expect(parseMacroCall('Click the [submit] button')).toBeNull();
    expect(parseMacroCall('[macr: foo]')).toBeNull();
  });
});

describe('parseMacroCall — optional colon', () => {
  it('parses `[macro name]` identically to `[macro: name]`', () => {
    // Same call in every field except nameColumn — the name naturally sits
    // one character earlier when the colon is omitted.
    const bare = parseMacroCall('[macro login]');
    const colon = parseMacroCall('[macro: login]');
    expect(bare).toEqual({ ...colon, nameColumn: 7 });
  });

  it('records the same nameColumn under both spellings', () => {
    // `[macro login]` and `[macro: login]` both put `l` at column 8.
    expect(parseMacroCall('[macro  login]')?.nameColumn).toBe(8);
    expect(parseMacroCall('[macro: login]')?.nameColumn).toBe(8);
  });

  it('accepts extra whitespace, and whitespace before the colon', () => {
    expect(parseMacroCall('[macro   login]')?.name).toBe('login');
    expect(parseMacroCall('[macro : login]')?.name).toBe('login');
    expect(parseMacroCall('[macro:login]')?.name).toBe('login');
  });

  it('parses the full arg shapes without the colon', () => {
    const result = parseMacroCall(
      'Sign in [macro auth/login username role="admin" out.session_id] # note',
    );
    expect(result?.label).toBe('Sign in');
    expect(result?.name).toBe('auth/login');
    expect(result?.args).toEqual({ username: '{{username}}', role: 'admin' });
    expect(result?.outputAliases).toEqual({ session_id: 'session_id' });
    expect(result?.trailing).toBe(' # note');
  });

  it('does not claim bracketed prose that merely contains the keyword', () => {
    // No `:` and no whitespace directly after `macro` — these never open a call.
    expect(parseMacroCall('Check the [macroscopic] animation')).toBeNull();
    expect(parseMacroCall('Open the [macros] page')).toBeNull();
    expect(parseMacroCall('A bare [macro] token is not a call either')).toBeNull();
  });

  it('scans past a near-miss to find the real token', () => {
    expect(parseMacroCall('see [macroscopic] then [macro login]')?.name).toBe('login');
  });

  it('a colon-less token that does not parse is prose, not an error', () => {
    // The colon-less spelling is reachable by ordinary English, and
    // `extractSteps` throws at PARSE time — so committing to it would let one
    // prose sentence fail the whole test file. `[macro:` keeps the strict
    // reading (the syntax-error tests below); the space form degrades to prose.
    expect(parseMacroCall('[macro ]')).toBeNull();
    expect(parseMacroCall('Verify the [macro level: expert] badge')).toBeNull();
    expect(parseMacroCall('Click the [macro (beta)] badge')).toBeNull();
    expect(parseMacroCall('Confirm the [macro 50%] chip')).toBeNull();
  });
});

describe('parseMacroCall — markdown links are not invocations', () => {
  // `[text](url)` is the likeliest way a bracketed keyword appears in a
  // markdown-authored suite. Claiming it resolved a macro named after the
  // link text and failed the ENTIRE file when no such macro existed.
  it('does not claim a link, in either spelling', () => {
    expect(parseMacroCall('Click the [macro guide](https://example.com) link')).toBeNull();
    expect(parseMacroCall('Open the [macro matrix](./m.md) and verify')).toBeNull();
    expect(parseMacroCall('See [macro: guide](./g.md) for details')).toBeNull();
  });

  it('still parses a real call followed by a parenthesised comment', () => {
    // Only an IMMEDIATELY adjacent `(` is a link.
    const result = parseMacroCall('[macro: login] (smoke only)');
    expect(result?.name).toBe('login');
    expect(result?.trailing).toBe(' (smoke only)');
  });

  it('a declined candidate does not swallow a real call later on the line', () => {
    // The scan resumes past a link or an unparseable colon-less token. Taking
    // only the FIRST candidate made these prose, silently skipping a live
    // call the runner should have dispatched.
    expect(parseMacroCall('See the [macro guide](./g.md) and then [macro: login]')?.name).toBe(
      'login',
    );
    expect(
      parseMacroCall('Check the [macro level: expert] badge then [macro: login]')?.name,
    ).toBe('login');
    // …and a line of nothing but declined candidates is still prose.
    expect(parseMacroCall('The [macro guide](./g.md) and the [macro matrix](./m.md)')).toBeNull();
  });
});

describe('parseMacroCall — label prefix', () => {
  it('captures text before `[macro:` as the step label, trimmed', () => {
    const result = parseMacroCall('Search with DuckDuckGo [macro: duckduckgo]');
    expect(result?.name).toBe('duckduckgo');
    expect(result?.label).toBe('Search with DuckDuckGo');
  });

  it('trims surrounding whitespace from the label', () => {
    const result = parseMacroCall('   Sign in   [macro: login]');
    expect(result?.label).toBe('Sign in');
  });

  it('preserves internal whitespace inside the label', () => {
    const result = parseMacroCall('Click  and verify [macro: foo]');
    expect(result?.label).toBe('Click  and verify');
  });

  it('accepts a stray `[` in the label without treating it as the prefix', () => {
    const result = parseMacroCall('Step [1/3] [macro: foo]');
    expect(result?.label).toBe('Step [1/3]');
    expect(result?.name).toBe('foo');
  });

  it('matches the first `[macro:` when the label happens to contain another', () => {
    // Ambiguous user input — we resolve by binding to the first occurrence.
    // The second `[macro:` lives in `trailing` and isn't re-scanned.
    const result = parseMacroCall('a [macro: x] b [macro: y]');
    expect(result?.name).toBe('x');
    expect(result?.label).toBe('a');
    expect(result?.trailing).toBe(' b [macro: y]');
  });
});

describe('parseMacroCall — happy path', () => {
  it('parses a macro with no arguments', () => {
    const result = parseMacroCall('[macro: foo]');
    expect(result).toEqual({
      name: 'foo',
      // 0-based column of `f` in `[macro: foo]` — recorded by the tokenizer so
      // callers can point a caret at the name without re-deriving the offset.
      nameColumn: 8,
      args: {},
      outputAliases: {},
      trailing: '',
    });
  });

  it('tolerates leading whitespace, and does not keep it as a label', () => {
    const result = parseMacroCall('   [macro: foo]');
    expect(result?.name).toBe('foo');
    expect(result?.label).toBeUndefined();
  });

  it('parses an explicit `key="value"` argument', () => {
    const result = parseMacroCall('[macro: foo bar="baz"]');
    expect(result?.args).toEqual({ bar: 'baz' });
  });

  it('parses multiple explicit arguments', () => {
    const result = parseMacroCall('[macro: foo a="1" b="2" c="3"]');
    expect(result?.args).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('parses an `out.name="alias"` rename', () => {
    const result = parseMacroCall('[macro: foo out.x="renamed"]');
    expect(result?.outputAliases).toEqual({ x: 'renamed' });
    expect(result?.args).toEqual({});
  });

  it('preserves trailing comment text after the closing `]`', () => {
    const result = parseMacroCall('[macro: foo] # human-readable note');
    expect(result?.name).toBe('foo');
    expect(result?.trailing).toBe(' # human-readable note');
  });

  it('accepts hyphens in the macro name', () => {
    const result = parseMacroCall('[macro: my-cool-macro]');
    expect(result?.name).toBe('my-cool-macro');
  });

  it('accepts a path-qualified name for a macro in a subfolder', () => {
    const result = parseMacroCall('[macro: auth/login]');
    expect(result?.name).toBe('auth/login');
  });

  it('canonicalises away a leading slash so both spellings name one macro', () => {
    expect(parseMacroCall('[macro: /auth/login]')?.name).toBe('auth/login');
    expect(parseMacroCall('[macro: /capture_url]')?.name).toBe('capture_url');
  });

  it('parses args and out. aliases on a path-qualified call', () => {
    const result = parseMacroCall(
      '[macro: /auth/login username password role="admin" out.session_id="admin_session"] # note',
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
    const result = parseMacroCall('[macro: foo q="a]b=c d"]');
    expect(result?.args).toEqual({ q: 'a]b=c d' });
  });

  it('accepts an empty quoted value', () => {
    const result = parseMacroCall('[macro: foo q=""]');
    expect(result?.args).toEqual({ q: '' });
  });
});

describe('parseMacroCall — bare-identifier shorthand', () => {
  it('desugars a bare param to `{{param}}`', () => {
    const result = parseMacroCall('[macro: login password]');
    expect(result?.args).toEqual({ password: '{{password}}' });
  });

  it('desugars multiple bare params', () => {
    const result = parseMacroCall('[macro: login username password]');
    expect(result?.args).toEqual({
      username: '{{username}}',
      password: '{{password}}',
    });
  });

  it('desugars a bare `out.name` to alias = name', () => {
    const result = parseMacroCall('[macro: foo out.session_id]');
    expect(result?.outputAliases).toEqual({ session_id: 'session_id' });
  });
});

describe('parseMacroCall — syntax errors', () => {
  it('throws on an unclosed macro invocation', () => {
    expect(() => parseMacroCall('[macro: foo')).toThrow(MacroCallSyntaxError);
    try {
      parseMacroCall('[macro: foo');
    } catch (e) {
      expect(e).toBeInstanceOf(MacroCallSyntaxError);
      const err = e as MacroCallSyntaxError;
      expect(err.reason).toMatch(/expected '\]'/);
      expect(err.column).toBe('[macro: foo'.length);
    }
  });

  it('throws when the macro name is missing', () => {
    try {
      parseMacroCall('[macro: ]');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MacroCallSyntaxError);
      expect((e as MacroCallSyntaxError).reason).toMatch(/name missing/);
    }
  });

  it('throws on an unterminated string and points at the opening quote', () => {
    const line = '[macro: login password="{{password}}]';
    try {
      parseMacroCall(line);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MacroCallSyntaxError);
      const err = e as MacroCallSyntaxError;
      expect(err.reason).toMatch(/unterminated string for argument 'password'/);
      // Column should land on the opening quote of the broken arg.
      expect(line[err.column]).toBe('"');
    }
  });

  it('throws when `=` is not followed by `"`', () => {
    const line = '[macro: foo bar=baz]';
    try {
      parseMacroCall(line);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as MacroCallSyntaxError;
      expect(err.reason).toMatch(
        /expected '"', '\[', a number, or true\/false after '=' for argument 'bar'/,
      );
      expect(line[err.column]).toBe('b');
    }
  });

  it('throws on a stray character after a bare argument', () => {
    expect(() => parseMacroCall('[macro: foo bar! ]')).toThrow(
      /unexpected character '!' after argument 'bar'/,
    );
  });

  it('throws when args are not separated by whitespace', () => {
    expect(() => parseMacroCall('[macro: foo bar="x"baz="y"]')).toThrow(
      /expected whitespace or '\]' before next argument/,
    );
  });

  it('throws when `out.` is not followed by an identifier', () => {
    expect(() => parseMacroCall('[macro: foo out. ]')).toThrow(
      /expected output name after 'out\.'/,
    );
  });

  it('throws on a doubled slash in the name', () => {
    expect(() => parseMacroCall('[macro: auth//login]')).toThrow(
      MacroCallSyntaxError,
    );
    expect(() => parseMacroCall('[macro: auth//login]')).toThrow(
      /empty path segment/,
    );
  });

  it('throws on a trailing slash in the name', () => {
    expect(() => parseMacroCall('[macro: auth/]')).toThrow(/empty path segment/);
  });

  it('throws on a name that is nothing but a slash', () => {
    expect(() => parseMacroCall('[macro: /]')).toThrow(/empty path segment/);
  });

  it('throws on a name of nothing but slashes', () => {
    // The leading-slash strip leaves `/`, whose segments are both empty.
    expect(() => parseMacroCall('[macro: //]')).toThrow(/empty path segment/);
  });

  it('points the caret at the malformed name', () => {
    const line = '1. [macro: auth//login]';
    try {
      parseMacroCall(line);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MacroCallSyntaxError);
      const err = e as MacroCallSyntaxError;
      expect(err.column).toBe(line.indexOf('auth//login'));
    }
  });

  it('points the caret at the invocation, not at a label that repeats the name', () => {
    // The caret column must come from the tokenizer's recorded position. A
    // re-derived `line.indexOf(name)` finds the LABEL's copy at column 0 and
    // decorates the wrong half of the line.
    const line = 'auth//login [macro: auth//login]';
    try {
      parseMacroCall(line);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MacroCallSyntaxError);
      const err = e as MacroCallSyntaxError;
      expect(err.column).toBe(20);
      expect(line.slice(err.column)).toBe('auth//login]');
    }
  });
});

describe('parseMacroCall — traversal is unlexable', () => {
  // `loadMacro` does `path.resolve(macrosDir, name + '.md')` with NO containment
  // check, and is safe only because of two properties: the name grammar admits
  // no `.` and no `\`, and `parseMacroCall` strips the leading slash before
  // anything resolves. These pin the first half — every spelling of a traversal
  // attempt must die at the tokenizer, not reach the filesystem.
  const traversals = [
    '[macro: ../x]',       // `.` is not in the name class → no name at all
    '[macro: a/../b]',     // reads `a/`, stops at `.` → trailing empty segment
    '[macro: a\\b]',       // `\` is not in the name class → stray character
    '[macro: C:/x]',       // `:` is not in the name class → stray character
  ];

  for (const line of traversals) {
    it(`refuses ${line}`, () => {
      expect(() => parseMacroCall(line)).toThrow(MacroCallSyntaxError);
    });
  }

  it('error message includes the source line and a caret', () => {
    const line = '[macro: foo bar=baz]';
    try {
      parseMacroCall(line);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as MacroCallSyntaxError;
      const lines = err.message.split('\n');
      // Format: <reason>\n  <source>\n  <caret>
      expect(lines[1]).toContain(line);
      expect(lines[2]).toMatch(/^\s+\^$/);
    }
  });
});
