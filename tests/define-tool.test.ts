import { describe, it, expect } from 'vitest';
import { defineTool } from '../src/tools/define-tool.js';

describe('defineTool — happy path', () => {
  it('returns the same definition object passed in', () => {
    const def = defineTool({
      name: 'noop',
      parameters: {},
      outputs: {},
      run: () => undefined,
    });
    expect(def.name).toBe('noop');
    expect(typeof def.run).toBe('function');
  });

  it('preserves parameter and output schema verbatim', () => {
    const def = defineTool({
      name: 'add',
      parameters: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      outputs: {
        sum: { type: 'number' },
      },
      run: () => undefined,
    });
    expect(def.parameters).toEqual({
      a: { type: 'number' },
      b: { type: 'number' },
    });
    expect(def.outputs).toEqual({ sum: { type: 'number' } });
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
