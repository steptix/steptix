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

  it('returns null for steps that mention `[skill:` only mid-line', () => {
    expect(parseSkillCall('See the docs about [skill: foo]')).toBeNull();
  });
});

describe('parseSkillCall — happy path', () => {
  it('parses a skill with no arguments', () => {
    const result = parseSkillCall('[skill: foo]');
    expect(result).toEqual({
      name: 'foo',
      args: {},
      outputAliases: {},
      trailing: '',
    });
  });

  it('tolerates leading whitespace', () => {
    const result = parseSkillCall('   [skill: foo]');
    expect(result?.name).toBe('foo');
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

  it('mixes shorthand and explicit args in one call', () => {
    const result = parseSkillCall(
      '[skill: login username password role="admin" out.session_id]',
    );
    expect(result?.args).toEqual({
      username: '{{username}}',
      password: '{{password}}',
      role: 'admin',
    });
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
