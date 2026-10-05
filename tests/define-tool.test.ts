import { describe, it, expect } from 'vitest';
import { defineTool } from '../src/tools/define-tool.js';

describe('defineTool — happy path', () => {
  it('returns the same definition object passed in', () => {
    // Identity, not a copy: the generic types of `parameters` and `outputs`
    // ride on this object, and a copy would be free to drop or reshape them.
    const input = {
      name: 'add',
      parameters: { a: { type: 'number' as const }, b: { type: 'number' as const } },
      outputs: { sum: { type: 'number' as const } },
      run: () => undefined,
    };
    expect(defineTool(input)).toBe(input);
  });

  it('accepts hyphens and underscores in tool names', () => {
    expect(() =>
      defineTool({
        name: 'my-tool',
        parameters: {},
        outputs: {},
        run: () => undefined,
      }),
    ).not.toThrow();
    expect(() =>
      defineTool({
        name: 'my_tool',
        parameters: {},
        outputs: {},
        run: () => undefined,
      }),
    ).not.toThrow();
  });
});

describe('defineTool — validation', () => {
  it('throws when `name` is missing', () => {
    expect(() =>
      defineTool({
        // @ts-expect-error testing runtime guard
        name: undefined,
        parameters: {},
        outputs: {},
        run: () => undefined,
      }),
    ).toThrow(/`name` is required/);
  });

  it('throws when name has illegal characters', () => {
    expect(() =>
      defineTool({
        name: 'bad name',
        parameters: {},
        outputs: {},
        run: () => undefined,
      }),
    ).toThrow(/must match/);
  });

  it('throws when `run` is not a function', () => {
    expect(() =>
      defineTool({
        name: 'broken',
        parameters: {},
        outputs: {},
        // @ts-expect-error testing runtime guard
        run: 'not-a-function',
      }),
    ).toThrow(/must define a `run` function/);
  });

  it('throws when a parameter declaration is missing `type`', () => {
    expect(() =>
      defineTool({
        name: 'broken',
        // @ts-expect-error testing runtime guard
        parameters: { foo: {} },
        outputs: {},
        run: () => undefined,
      }),
    ).toThrow(/parameter "foo" must declare a `type`/);
  });

  it('throws when an output declaration is missing `type`', () => {
    expect(() =>
      defineTool({
        name: 'broken',
        parameters: {},
        // @ts-expect-error testing runtime guard
        outputs: { result: {} },
        run: () => undefined,
      }),
    ).toThrow(/output "result" must declare a `type`/);
  });
});
