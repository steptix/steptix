/**
 * Tests for bare numeric/boolean literal arguments in `[tool: ...]` and
 * `[skill: ...]` invocations. Authors can now write:
 *
 *   [tool: extract_orders sinceDays=30 includeRefunds=true]
 *
 * instead of the previously-required:
 *
 *   [tool: extract_orders sinceDays="30" includeRefunds="true"]
 *
 * The parser captures the bare token as a string; the tool bridge's
 * existing `coerce` step converts it to the declared schema type at call
 * time. So these tests cover BOTH the parse-time capture (bare value lands
 * in `args` as the string form) AND the round-trip through `executeToolStep`
 * to verify the bridge produces a correctly-typed runtime value.
 */
import { describe, it, expect } from 'vitest';
import { parseToolCall, ToolCallSyntaxError } from '../src/tools/tool-call-parser.js';
import { executeToolStep } from '../src/tools/executor.js';
import type { ToolCall, ToolDefinition } from '../src/tools/types.js';

const stubCtx = {
  page: {} as never,
  context: {} as never,
  browser: {} as never,
};

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

// ─── Parser-level: bare literal lands in args as string form ────────────────

describe('parseToolCall — bare numeric literals', () => {
  it('captures a positive integer', () => {
    const call = parseToolCall('[tool: x count=30]');
    expect(call?.args['count']).toBe('30');
  });

  it('captures a negative integer', () => {
    const call = parseToolCall('[tool: x offset=-5]');
    expect(call?.args['offset']).toBe('-5');
  });

  it('captures a positive float', () => {
    const call = parseToolCall('[tool: x weight=3.14]');
    expect(call?.args['weight']).toBe('3.14');
  });

  it('captures a negative float', () => {
    const call = parseToolCall('[tool: x delta=-0.5]');
    expect(call?.args['delta']).toBe('-0.5');
  });

  it('captures a leading-decimal float', () => {
    const call = parseToolCall('[tool: x ratio=.75]');
    expect(call?.args['ratio']).toBe('.75');
  });

  it('captures explicit positive sign', () => {
    const call = parseToolCall('[tool: x temp=+5]');
    expect(call?.args['temp']).toBe('+5');
  });
});

describe('parseToolCall — bare boolean literals', () => {
  it('captures `true`', () => {
    const call = parseToolCall('[tool: x enabled=true]');
    expect(call?.args['enabled']).toBe('true');
  });

  it('captures `false`', () => {
    const call = parseToolCall('[tool: x dryRun=false]');
    expect(call?.args['dryRun']).toBe('false');
  });
});

describe('parseToolCall — mixed bare and quoted args in one invocation', () => {
  it('mixes bare numbers, booleans, and quoted strings', () => {
    const call = parseToolCall(
      '[tool: x label="run-1" count=12 weight=3.14 enabled=true tags=["a","b"]]',
    );
    expect(call?.args['label']).toBe('run-1');
    expect(call?.args['count']).toBe('12');
    expect(call?.args['weight']).toBe('3.14');
    expect(call?.args['enabled']).toBe('true');
    expect(call?.args['tags']).toBe('["a","b"]');
  });
});

describe('parseToolCall — rejection rules', () => {
  it('rejects an unrecognised bare token (e.g. unquoted identifier)', () => {
    let caught: ToolCallSyntaxError | undefined;
    try {
      parseToolCall('[tool: x mode=loop]');
    } catch (e) {
      caught = e as ToolCallSyntaxError;
    }
    // `loop` starts with `l` which isn't a valid bare-literal-start char,
    // so the parser falls through to the dispatcher error rather than
    // capturing it as a string. The message should suggest quoting.
    expect(caught).toBeDefined();
    expect(caught!.reason).toMatch(/expected.*number.*true\/false.*for argument 'mode'/);
  });

  it("rejects a near-miss boolean (e.g. `truely`) because it starts with 't' but isn't true/false", () => {
    let caught: ToolCallSyntaxError | undefined;
    try {
      parseToolCall('[tool: x flag=truely]');
    } catch (e) {
      caught = e as ToolCallSyntaxError;
    }
    expect(caught).toBeDefined();
    expect(caught!.reason).toMatch(/invalid bare value 'truely'/);
    expect(caught!.reason).toMatch(/expected a number, true\/false, or a quoted string/);
  });

  it('rejects an alphanumeric token starting with a digit (e.g. `5x`)', () => {
    expect(() => parseToolCall('[tool: x count=5x]')).toThrow(
      /invalid bare value '5x'/,
    );
  });

  it('rejects an output alias with a bare value (aliases must be strings)', () => {
    expect(() => parseToolCall('[tool: x out.count=5]')).toThrow(
      /output alias 'count' must be a quoted string, not a bare literal/,
    );
  });

  it('still allows a string with the same content via quoting (escape hatch)', () => {
    const call = parseToolCall('[tool: x mode="loop"]');
    expect(call?.args['mode']).toBe('loop');
  });
});

describe('parseToolCall — terminator handling', () => {
  it('a bare value adjacent to `]` (no whitespace) closes the invocation cleanly', () => {
    const call = parseToolCall('[tool: x count=5]');
    expect(call?.args['count']).toBe('5');
  });

  it('two bare values separated by whitespace both parse', () => {
    const call = parseToolCall('[tool: x a=1 b=2]');
    expect(call?.args['a']).toBe('1');
    expect(call?.args['b']).toBe('2');
  });

  it('bare value followed by tab + next arg', () => {
    const call = parseToolCall('[tool: x a=1\tb="two"]');
    expect(call?.args['a']).toBe('1');
    expect(call?.args['b']).toBe('two');
  });
});

// ─── Bridge-level: bare literals coerce to the declared schema type ─────────

describe('executeToolStep — bare literals coerce through the schema', () => {
  it('bare integer → tool receives a real number when type: number is declared', async () => {
    let received: number | undefined;
    const def: ToolDefinition = {
      name: 'use-count',
      parameters: { count: { type: 'number' } },
      outputs: {},
      run: (args) => {
        received = (args as { count: number }).count;
      },
    };
    const call: ToolCall = {
      name: 'use-count',
      args: { count: '30' },
      outputAliases: {},
    };
    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });
    expect(outcome.status).toBe('passed');
    expect(received).toBe(30);
    expect(typeof received).toBe('number');
  });

  it('bare boolean → tool receives a real boolean when type: boolean is declared', async () => {
    let received: boolean | undefined;
    const def: ToolDefinition = {
      name: 'use-flag',
      parameters: { enabled: { type: 'boolean' } },
      outputs: {},
      run: (args) => {
        received = (args as { enabled: boolean }).enabled;
      },
    };
    const call: ToolCall = {
      name: 'use-flag',
      args: { enabled: 'true' },
      outputAliases: {},
    };
    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });
    expect(outcome.status).toBe('passed');
    expect(received).toBe(true);
  });

  it('bare negative float → tool receives a real number', async () => {
    let received: number | undefined;
    const def: ToolDefinition = {
      name: 'use-delta',
      parameters: { delta: { type: 'number' } },
      outputs: {},
      run: (args) => {
        received = (args as { delta: number }).delta;
      },
    };
    const call: ToolCall = {
      name: 'use-delta',
      args: { delta: '-0.5' },
      outputAliases: {},
    };
    const outcome = await executeToolStep(call, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });
    expect(outcome.status).toBe('passed');
    expect(received).toBe(-0.5);
  });

  it('end-to-end: parseToolCall + executeToolStep with bare scalars', async () => {
    const call = parseToolCall('[tool: configure timeout=120 retry=true mode="strict"]');
    expect(call).not.toBeNull();

    let captured: { timeout: number; retry: boolean; mode: string } | undefined;
    const def: ToolDefinition = {
      name: 'configure',
      parameters: {
        timeout: { type: 'number' },
        retry: { type: 'boolean' },
        mode: { type: 'string' },
      },
      outputs: {},
      run: (args) => {
        captured = args as never;
      },
    };
    const outcome = await executeToolStep(call!, {
      ...stubCtx,
      resolvedParameters: {},
      catalogue: makeCatalogue(def) as never,
    });
    expect(outcome.status).toBe('passed');
    expect(captured).toEqual({ timeout: 120, retry: true, mode: 'strict' });
  });
});
