import { describe, it, expect } from 'vitest';
import { parseToolCall, ToolCallSyntaxError } from '../src/tools/tool-call-parser.js';

describe('parseToolCall — non-matches', () => {
  it('returns null for plain natural-language steps', () => {
    expect(parseToolCall('Click the login button')).toBeNull();
    expect(parseToolCall('Verify the page has loaded')).toBeNull();
  });

  it('returns null for skill calls (different prefix)', () => {
    expect(parseToolCall('[skill: login]')).toBeNull();
  });

  it('returns null for empty / whitespace-only lines', () => {
    expect(parseToolCall('')).toBeNull();
    expect(parseToolCall('   ')).toBeNull();
  });
});

describe('parseToolCall — happy path', () => {
  it('parses a tool with no arguments', () => {
    const result = parseToolCall('[tool: read_page_title]');
    expect(result).toEqual({
      name: 'read_page_title',
      args: {},
      outputAliases: {},
    });
  });

  it('parses an explicit `key="value"` argument', () => {
    const result = parseToolCall('[tool: fetch_csrf_token baseUrl="http://localhost:8787"]');
    expect(result?.args).toEqual({ baseUrl: 'http://localhost:8787' });
  });

  it('parses an `out.name="alias"` rename', () => {
    const result = parseToolCall('[tool: foo out.csrf="my_token"]');
    expect(result?.outputAliases).toEqual({ csrf: 'my_token' });
  });

  it('tolerates leading whitespace and discards trailing comment text', () => {
    const result = parseToolCall('   [tool: foo]   trailing notes');
    expect(result?.name).toBe('foo');
  });

  it('accepts hyphens in the tool name', () => {
    const result = parseToolCall('[tool: my-cool-tool]');
    expect(result?.name).toBe('my-cool-tool');
  });
});

describe('parseToolCall — bare-identifier shorthand (parity with skill calls)', () => {
  it('desugars a bare param to `{{param}}`', () => {
    const result = parseToolCall('[tool: fetch_csrf_token baseUrl]');
    expect(result?.args).toEqual({ baseUrl: '{{baseUrl}}' });
  });

  it('desugars a bare `out.name` to alias = name', () => {
    const result = parseToolCall('[tool: fetch_csrf_token out.csrf]');
    expect(result?.outputAliases).toEqual({ csrf: 'csrf' });
  });

  it('mixes shorthand and explicit args in one call', () => {
    const result = parseToolCall(
      '[tool: do_thing username password role="admin" out.session_id]',
    );
    expect(result?.args).toEqual({
      username: '{{username}}',
      password: '{{password}}',
      role: 'admin',
    });
    expect(result?.outputAliases).toEqual({ session_id: 'session_id' });
  });
});

describe('parseToolCall — syntax errors', () => {
  it('throws on an unclosed tool invocation', () => {
    expect(() => parseToolCall('[tool: foo')).toThrow(ToolCallSyntaxError);
  });

  it('throws when the tool name is missing', () => {
    expect(() => parseToolCall('[tool: ]')).toThrow(/name missing/);
  });

  it('throws on an unterminated string and points at the opening quote', () => {
    const line = '[tool: fetch_csrf baseUrl="http://x';
    try {
      parseToolCall(line);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolCallSyntaxError);
      const err = e as ToolCallSyntaxError;
      expect(err.reason).toMatch(/unterminated string for argument 'baseUrl'/);
      expect(line[err.column]).toBe('"');
    }
  });

  it('throws when `=` is not followed by `"`', () => {
    expect(() => parseToolCall('[tool: foo bar=baz]')).toThrow(
      /expected '"', '\[', a number, or true\/false after '=' for argument 'bar'/,
    );
  });

  it('error class name is ToolCallSyntaxError (distinct from skill error)', () => {
    try {
      parseToolCall('[tool: foo bar=baz]');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).name).toBe('ToolCallSyntaxError');
    }
  });
});
