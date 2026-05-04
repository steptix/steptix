import { describe, it, expect, beforeEach } from 'vitest';
import type { Page, BrowserContext, Browser } from 'playwright';
import { finaliseToolExport } from '../src/tools/finalise.js';
import { tool } from '../src/tools/tool-helper.js';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';

const fakePage = { __k: 'page' } as unknown as Page;
const fakeContext = { __k: 'context' } as unknown as BrowserContext;
const fakeBrowser = { __k: 'browser' } as unknown as Browser;

const baseHints = { filename: 'my_tool', filePath: '/v/my_tool.ts' };

describe('finaliseToolExport — rung 3 (already a ToolDefinition)', () => {
  it('passes a defineTool result through unchanged', () => {
    const def = defineTool({
      name: 'untouched',
      parameters: {},
      outputs: {},
      run: () => undefined,
    });
    const out = finaliseToolExport(def, baseHints);
    expect(out).toBe(def);
  });
});

describe('finaliseToolExport — rung 2 (DeferredTool from tool())', () => {
  it('uses explicit name when provided', () => {
    const out = finaliseToolExport(tool('explicit_name', () => 'x'), baseHints);
    expect(out?.name).toBe('explicit_name');
  });

  it('falls back to export key when no explicit name', () => {
    const out = finaliseToolExport(tool(() => 'x'), {
      ...baseHints,
      exportKey: 'from_export_key',
    });
    expect(out?.name).toBe('from_export_key');
  });

  it('falls back to filename when no explicit name and no export key (default export)', () => {
    const out = finaliseToolExport(tool(() => 'x'), baseHints);
    expect(out?.name).toBe('my_tool');
  });

  it('declares a single output named after the tool', () => {
    const out = finaliseToolExport(tool(() => 'x'), baseHints);
    expect(out?.outputs).toEqual({ my_tool: { type: 'string' } });
  });

  it('throws when explicit name has illegal chars', () => {
    expect(() =>
      finaliseToolExport(tool('bad name!', () => 'x'), baseHints),
    ).toThrow(/Invalid tool name/);
  });

  it('throws when filename has illegal chars (no other source)', () => {
    expect(() =>
      finaliseToolExport(tool(() => 'x'), {
        filename: 'bad name',
        filePath: '/v/bad name.ts',
      }),
    ).toThrow(/filename "bad name"/);
  });
});

describe('finaliseToolExport — rung 1 (bare function)', () => {
  it('treats a bare function as a deferred tool', () => {
    const out = finaliseToolExport(() => 'hello', baseHints);
    expect(out?.name).toBe('my_tool');
    expect(out?.outputs).toEqual({ my_tool: { type: 'string' } });
  });

  it('uses export key when bare function is a named export', () => {
    const out = finaliseToolExport(() => 'hello', {
      ...baseHints,
      exportKey: 'helper',
    });
    expect(out?.name).toBe('helper');
  });
});

describe('finaliseToolExport — non-tools', () => {
  it('returns null for plain objects', () => {
    expect(finaliseToolExport({ random: 'data' }, baseHints)).toBeNull();
  });

  it('returns null for primitives', () => {
    expect(finaliseToolExport(42, baseHints)).toBeNull();
    expect(finaliseToolExport('a string', baseHints)).toBeNull();
    expect(finaliseToolExport(null, baseHints)).toBeNull();
    expect(finaliseToolExport(undefined, baseHints)).toBeNull();
  });
});

describe('finaliseToolExport — return-value-to-output convention (executed end-to-end)', () => {
  let catalogue: ToolCatalogue;
  let resolvedParameters: Record<string, string>;

  beforeEach(() => {
    catalogue = new ToolCatalogue();
    resolvedParameters = {};
  });

  function register(t: unknown): string {
    const def = finaliseToolExport(t, baseHints);
    if (!def) throw new Error('not a tool');
    catalogue.register({ definition: def, filePath: baseHints.filePath });
    return def.name;
  }

  it('writes the return value as the single output (string)', async () => {
    register(tool(() => 'returned'));
    const outcome = await executeToolStep(
      { name: 'my_tool', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['my_tool']).toBe('returned');
  });

  it('coerces a number return value to string', async () => {
    register(tool(() => 42));
    const outcome = await executeToolStep(
      { name: 'my_tool', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['my_tool']).toBe('42');
  });

  it('coerces a boolean return value to string', async () => {
    register(tool(() => true));
    await executeToolStep(
      { name: 'my_tool', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(resolvedParameters['my_tool']).toBe('true');
  });

  it('JSON-stringifies an object return value', async () => {
    register(tool(() => ({ a: 1, b: 'x' })));
    await executeToolStep(
      { name: 'my_tool', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(resolvedParameters['my_tool']).toBe('{"a":1,"b":"x"}');
  });

  it('writes nothing when the function returns undefined', async () => {
    register(tool(() => undefined));
    await executeToolStep(
      { name: 'my_tool', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(resolvedParameters['my_tool']).toBeUndefined();
  });

  it('respects caller out.<name>="alias" aliasing', async () => {
    register(tool(() => 'val'));
    await executeToolStep(
      { name: 'my_tool', args: {}, outputAliases: { my_tool: 'aliased' } },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(resolvedParameters['aliased']).toBe('val');
    expect(resolvedParameters['my_tool']).toBeUndefined();
  });
});

describe('finaliseToolExport — ToolScope semantics', () => {
  let catalogue: ToolCatalogue;
  let resolvedParameters: Record<string, string>;

  beforeEach(() => {
    catalogue = new ToolCatalogue();
    resolvedParameters = {};
  });

  it('spreads caller args to the top level of scope so destructuring works', async () => {
    let captured: { baseUrl?: unknown; n?: unknown } = {};
    const def = finaliseToolExport(
      tool((scope: { baseUrl?: unknown; n?: unknown }) => {
        captured = { baseUrl: scope.baseUrl, n: scope.n };
      }),
      baseHints,
    );
    catalogue.register({ definition: def!, filePath: baseHints.filePath });
    await executeToolStep(
      { name: 'my_tool', args: { baseUrl: 'http://x', n: '7' }, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(captured).toEqual({ baseUrl: 'http://x', n: '7' });
  });

  it('exposes the full args bag at scope.args', async () => {
    let observed: Record<string, unknown> | null = null;
    const def = finaliseToolExport(
      tool((scope: { args: Record<string, unknown> }) => {
        observed = scope.args;
      }),
      baseHints,
    );
    catalogue.register({ definition: def!, filePath: baseHints.filePath });
    await executeToolStep(
      { name: 'my_tool', args: { x: '1', y: '2' }, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(observed).toEqual({ x: '1', y: '2' });
  });

  it('framework values (page/context/etc) shadow caller args of the same name', async () => {
    let observedPage: unknown = null;
    const def = finaliseToolExport(
      tool((scope: { page: unknown }) => {
        observedPage = scope.page;
      }),
      baseHints,
    );
    catalogue.register({ definition: def!, filePath: baseHints.filePath });
    await executeToolStep(
      // Caller deliberately tries to pass `page` — should be shadowed.
      { name: 'my_tool', args: { page: 'caller-supplied' }, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(observedPage).toBe(fakePage);
  });
});
