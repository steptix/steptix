/**
 * Tests for inline `[...]` JSON-array literal arguments in `[tool: ...]`
 * invocations. The parser should:
 *  - capture the bracketed source verbatim (including the outer brackets)
 *  - track bracket depth so nested arrays close correctly
 *  - skip over `"`-quoted strings so a `]` inside a string doesn't terminate
 *    the literal early
 *  - reject inline arrays for `out.X=` aliases (output aliases must be strings)
 *  - error on an unterminated literal
 */
import { describe, it, expect } from 'vitest';
import { parseToolCall, ToolCallSyntaxError } from '../src/tools/tool-call-parser.js';

describe('parseToolCall — inline JSON-array literals', () => {
  it('captures a simple string array', () => {
    const call = parseToolCall('[tool: visit-each urls=["/a","/b","/c"]]');
    expect(call?.args['urls']).toBe('["/a","/b","/c"]');
  });

  it('captures an array with whitespace inside', () => {
    const call = parseToolCall('[tool: x list=[ "a" , "b" ]]');
    expect(call?.args['list']).toBe('[ "a" , "b" ]');
  });

  it('handles a `]` inside a quoted string element', () => {
    const call = parseToolCall('[tool: x v=["weird]value", "ok"]]');
    expect(call?.args['v']).toBe('["weird]value", "ok"]');
  });

  it('handles a nested array', () => {
    const call = parseToolCall('[tool: x grid=[[1,2],[3,4]]]');
    expect(call?.args['grid']).toBe('[[1,2],[3,4]]');
  });

  it('mixes scalar and array args in one invocation', () => {
    const call = parseToolCall('[tool: x mode="loop" urls=["/a","/b"]]');
    expect(call?.args['mode']).toBe('loop');
    expect(call?.args['urls']).toBe('["/a","/b"]');
  });

  it('rejects an array literal as an output-alias value', () => {
    expect(() => parseToolCall('[tool: x out.titles=["a","b"]]')).toThrow(
      /output alias 'titles' must be a quoted string, not an array/,
    );
  });

  it('reports an unterminated array literal with a caret', () => {
    let caught: ToolCallSyntaxError | undefined;
    try {
      parseToolCall('[tool: x urls=["a","b"');
    } catch (e) {
      caught = e as ToolCallSyntaxError;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toMatch(/unterminated array literal/);
  });
});
