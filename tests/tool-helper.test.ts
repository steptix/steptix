import { describe, it, expect } from 'vitest';
import { tool, isDeferredTool, IS_DEFERRED_TOOL } from '../src/tools/tool-helper.js';

describe('tool() helper', () => {
  it('returns a deferred tool for tool(fn)', () => {
    const t = tool(() => 'hello');
    expect(isDeferredTool(t)).toBe(true);
    expect((t as Record<symbol, unknown>)[IS_DEFERRED_TOOL]).toBe(true);
    expect(t.explicitName).toBeUndefined();
    expect(typeof t.fn).toBe('function');
  });

  it('returns a deferred tool with explicit name for tool(name, fn)', () => {
    const t = tool('greet', () => 'hi');
    expect(isDeferredTool(t)).toBe(true);
    expect(t.explicitName).toBe('greet');
  });

  it('preserves the function reference verbatim', () => {
    const fn = () => 'x';
    const t = tool(fn);
    expect(t.fn).toBe(fn);
  });

  it('throws on tool(fn) when the argument is not a function', () => {
    // @ts-expect-error testing runtime guard
    expect(() => tool('only-name-no-fn')).toThrow(/argument must be a function/);
  });

  it('throws on tool(name, fn) when the second argument is not a function', () => {
    // @ts-expect-error testing runtime guard
    expect(() => tool('greet', 'not-a-function')).toThrow(/second argument must be a function/);
  });

  it('returns a frozen object so authors cannot mutate the spec', () => {
    const t = tool(() => 'x');
    expect(Object.isFrozen(t)).toBe(true);
  });
});

describe('isDeferredTool', () => {
  it('returns false for plain functions', () => {
    expect(isDeferredTool(() => undefined)).toBe(false);
  });

  it('returns false for plain objects', () => {
    expect(isDeferredTool({ name: 'x', run: () => undefined })).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isDeferredTool(null)).toBe(false);
    expect(isDeferredTool(undefined)).toBe(false);
  });
});
