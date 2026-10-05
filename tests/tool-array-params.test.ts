/**
 * Tests for array-typed tool parameters and outputs.
 *
 *  - Whole-arg `{{var}}` reference whose stored value is a JSON array
 *    decodes back to a typed string[] / number[] / boolean[].
 *  - Inline `urls=["a","b"]` literal works as an alternative source.
 *  - `setVar(name, [...])` JSON-encodes into the parameter map and the
 *    captured outputs.
 *  - Coercion errors are labelled (which arg, which index, what type).
 */
import { describe, it, expect } from 'vitest';
import { executeToolStep } from '../src/tools/executor.js';
import type { ToolDefinition } from '../src/tools/types.js';
import type { ToolCall } from '../src/tools/types.js';

function makeCatalogue(def: ToolDefinition): {
  resolve: (name: string) => Promise<{ definition: ToolDefinition }>;
  require: (name: string) => { definition: ToolDefinition };
  has: (name: string) => boolean;
} {
  return {
    async resolve(name) {
      if (name !== def.name) throw new Error(`unknown tool ${name}`);
      return { definition: def };
    },
    require(name) {
      if (name !== def.name) throw new Error(`unknown tool ${name}`);
      return { definition: def };
    },
    has(name) {
      return name === def.name;
    },
  };
}

const stubCtx = {
  page: {} as never,
  context: {} as never,
  browser: {} as never,
};

describe('executeToolStep — array-typed parameters', () => {
  it('decodes a JSON array stored in resolvedParameters into a typed string[]', async () => {
    let received: string[] | undefined;
    const def: ToolDefinition = {
      name: 'visit-each',
      parameters: { urls: { type: 'string[]' } },
      outputs: {},
      run: (args) => {
        received = (args as { urls: string[] }).urls;
      },
    };
    const call: ToolCall = {
      name: 'visit-each',
      args: { urls: '{{links}}' },
      outputAliases: {},
    };
    const params: Record<string, string> = {
      links: JSON.stringify(['/foo', '/bar', '/baz']),
    };

    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: params,
      catalogue: makeCatalogue(def) as never,
    });

    expect(outcome.status).toBe('passed');
    expect(received).toEqual(['/foo', '/bar', '/baz']);
    expect(Array.isArray(received)).toBe(true);
  });

  it('decodes an inline `urls=["a","b"]` literal into a typed string[]', async () => {
    let received: string[] | undefined;
    const def: ToolDefinition = {
      name: 'archive',
      parameters: { urls: { type: 'string[]' } },
      outputs: {},
      run: (args) => {
        received = (args as { urls: string[] }).urls;
      },
    };
    const call: ToolCall = {
      name: 'archive',
      args: { urls: '["https://a","https://b"]' },
      outputAliases: {},
    };

    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });

    expect(outcome.status).toBe('passed');
    expect(received).toEqual(['https://a', 'https://b']);
  });

  it('coerces a number[] parameter element-by-element', async () => {
    let received: number[] | undefined;
    const def: ToolDefinition = {
      name: 'sum-each',
      parameters: { values: { type: 'number[]' } },
      outputs: {},
      run: (args) => {
        received = (args as { values: number[] }).values;
      },
    };
    const call: ToolCall = {
      name: 'sum-each',
      args: { values: '{{nums}}' },
      outputAliases: {},
    };
    const params = { nums: JSON.stringify([1, 2, 3]) };

    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: params,
      catalogue: makeCatalogue(def) as never,
    });

    expect(outcome.status).toBe('passed');
    expect(received).toEqual([1, 2, 3]);
  });

  it('coerces a boolean[] parameter element-by-element', async () => {
    let received: boolean[] | undefined;
    const def: ToolDefinition = {
      name: 'all-true',
      parameters: { flags: { type: 'boolean[]' } },
      outputs: {},
      run: (args) => {
        received = (args as { flags: boolean[] }).flags;
      },
    };
    const call: ToolCall = {
      name: 'all-true',
      args: { flags: '["true","false","true"]' },
      outputAliases: {},
    };

    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });

    expect(outcome.status).toBe('passed');
    expect(received).toEqual([true, false, true]);
  });

  it('reports a labelled error when an array element is the wrong type', async () => {
    const def: ToolDefinition = {
      name: 'sum-each',
      parameters: { values: { type: 'number[]' } },
      outputs: {},
      run: () => undefined,
    };
    const call: ToolCall = {
      name: 'sum-each',
      args: { values: '["1","not-a-number","3"]' },
      outputAliases: {},
    };

    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/parameter "values\[1\]".*expected a number/);
  });

  it('reports a labelled error when the value is not a JSON array', async () => {
    const def: ToolDefinition = {
      name: 'visit-each',
      parameters: { urls: { type: 'string[]' } },
      outputs: {},
      run: () => undefined,
    };
    const call: ToolCall = {
      name: 'visit-each',
      args: { urls: 'not-json' },
      outputAliases: {},
    };

    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/parameter "urls".*expected a string\[\]/);
  });
});

describe('executeToolStep — array outputs via setVar', () => {
  it('JSON-encodes an array passed to setVar into resolvedParameters and outputs', async () => {
    const def: ToolDefinition = {
      name: 'collect-titles',
      parameters: {},
      outputs: { titles: { type: 'string[]' } },
      run: (_args, ctx) => {
        ctx.step.setVar('titles', ['Alpha', 'Beta', 'Gamma']);
      },
    };
    const call: ToolCall = { name: 'collect-titles', args: {}, outputAliases: {} };
    const params: Record<string, string> = {};

    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: params,
      catalogue: makeCatalogue(def) as never,
    });

    expect(outcome.status).toBe('passed');
    expect(params['titles']).toBe(JSON.stringify(['Alpha', 'Beta', 'Gamma']));
    expect(outcome.outputs['titles']).toBe(JSON.stringify(['Alpha', 'Beta', 'Gamma']));
  });

  it('preserves element types in storage when setVar receives a number[] / boolean[]', async () => {
    // Important: JSON.stringify keeps numbers/booleans as their JSON types
    // (not coerced to strings), so a downstream JSON.parse round-trips back
    // to the same shape. This matters for tools that read a stored value
    // via getVar() and parse it manually rather than going through the
    // typed-bridge coercion path.
    const def: ToolDefinition = {
      name: 'emit-typed',
      parameters: {},
      outputs: {
        counts: { type: 'number[]' },
        flags: { type: 'boolean[]' },
      },
      run: (_args, ctx) => {
        ctx.step.setVar('counts', [1, 2, 3]);
        ctx.step.setVar('flags', [true, false, true]);
      },
    };
    const params: Record<string, string> = {};
    const outcome = await executeToolStep(
      { name: 'emit-typed', args: {}, outputAliases: {} },
      { ...stubCtx, resolvedParameters: params, catalogue: makeCatalogue(def) as never },
    );
    expect(outcome.status).toBe('passed');
    // Stored as native JSON types, not stringified scalars.
    expect(params['counts']).toBe('[1,2,3]');
    expect(params['flags']).toBe('[true,false,true]');
    // Round-trip preserves types.
    expect(JSON.parse(params['counts']!)).toEqual([1, 2, 3]);
    expect(JSON.parse(params['flags']!)).toEqual([true, false, true]);
  });

  it('chains: tool A produces a list output, tool B consumes it as an array param', async () => {
    const collect: ToolDefinition = {
      name: 'collect',
      parameters: {},
      outputs: { ids: { type: 'string[]' } },
      run: (_args, ctx) => {
        ctx.step.setVar('ids', ['1', '2', '3']);
      },
    };
    const consume: ToolDefinition = {
      name: 'consume',
      parameters: { ids: { type: 'string[]' } },
      outputs: {},
      run: (args, ctx) => {
        const list = (args as { ids: string[] }).ids;
        ctx.log.info(`got ${list.length} ids`);
      },
    };
    const params: Record<string, string> = {};

    const a = await executeToolStep(
      { name: 'collect', args: {}, outputAliases: {} },
      { ...stubCtx, resolvedParameters: params, catalogue: makeCatalogue(collect) as never },
    );
    expect(a.status).toBe('passed');

    const b = await executeToolStep(
      { name: 'consume', args: { ids: '{{ids}}' }, outputAliases: {} },
      { ...stubCtx, resolvedParameters: params, catalogue: makeCatalogue(consume) as never },
    );
    expect(b.status).toBe('passed');
    expect(b.logs.find((l) => l.message === 'got 3 ids')).toBeDefined();
  });
});
