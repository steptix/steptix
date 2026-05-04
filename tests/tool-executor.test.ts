import { describe, it, expect, beforeEach } from 'vitest';
import type { Page, BrowserContext, Browser } from 'playwright';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import type { ToolCall } from '../src/tools/types.js';

const fakePage = { __kind: 'page' } as unknown as Page;
const fakeContext = { __kind: 'context' } as unknown as BrowserContext;
const fakeBrowser = { __kind: 'browser' } as unknown as Browser;

let catalogue: ToolCatalogue;
let resolvedParameters: Record<string, string>;

function register(def: ReturnType<typeof defineTool<never, never>> | unknown, file = '/virtual/tool.ts'): void {
  catalogue.register({
    definition: def as ReturnType<typeof defineTool<never, never>>,
    filePath: file,
  });
}

beforeEach(() => {
  catalogue = new ToolCatalogue();
  resolvedParameters = {};
});

describe('executeToolStep — happy path', () => {
  it('calls run with typed args and writes outputs into resolvedParameters', async () => {
    const calls: Array<{ args: unknown }> = [];
    register(
      defineTool({
        name: 'greet',
        parameters: { name: { type: 'string' } },
        outputs: { greeting: { type: 'string' } },
        run(args, { step }) {
          calls.push({ args });
          step.setVar('greeting', `Hello, ${args.name}!`);
        },
      }),
    );
    const call: ToolCall = { name: 'greet', args: { name: 'Ada' }, outputAliases: {} };
    const outcome = await executeToolStep(call, {
      page: fakePage,
      context: fakeContext,
      browser: fakeBrowser,
      resolvedParameters,
      catalogue,
    });
    expect(outcome.status).toBe('passed');
    expect(calls).toEqual([{ args: { name: 'Ada' } }]);
    expect(resolvedParameters['greeting']).toBe('Hello, Ada!');
    expect(outcome.outputs).toEqual({ greeting: 'Hello, Ada!' });
  });

  it('interpolates {{placeholders}} in args against resolvedParameters', async () => {
    const seen: string[] = [];
    register(
      defineTool({
        name: 'echo',
        parameters: { msg: { type: 'string' } },
        outputs: {},
        run(args) {
          seen.push(args.msg);
        },
      }),
    );
    resolvedParameters['user'] = 'Grace';
    const call: ToolCall = {
      name: 'echo',
      args: { msg: 'hello {{user}}' },
      outputAliases: {},
    };
    const outcome = await executeToolStep(call, {
      page: fakePage,
      context: fakeContext,
      browser: fakeBrowser,
      resolvedParameters,
      catalogue,
    });
    expect(outcome.status).toBe('passed');
    expect(seen).toEqual(['hello Grace']);
  });

  it('coerces number and boolean parameter values', async () => {
    const seen: Array<{ count: unknown; flag: unknown }> = [];
    register(
      defineTool({
        name: 'mathish',
        parameters: {
          count: { type: 'number' },
          flag: { type: 'boolean' },
        },
        outputs: {},
        run(args) {
          seen.push({ count: args.count, flag: args.flag });
        },
      }),
    );
    const call: ToolCall = {
      name: 'mathish',
      args: { count: '42', flag: 'true' },
      outputAliases: {},
    };
    const outcome = await executeToolStep(call, {
      page: fakePage,
      context: fakeContext,
      browser: fakeBrowser,
      resolvedParameters,
      catalogue,
    });
    expect(outcome.status).toBe('passed');
    expect(seen).toEqual([{ count: 42, flag: true }]);
  });

  it('applies caller-supplied output aliases', async () => {
    register(
      defineTool({
        name: 'producer',
        parameters: {},
        outputs: { token: { type: 'string' } },
        run(_args, { step }) {
          step.setVar('token', 'abc123');
        },
      }),
    );
    const call: ToolCall = {
      name: 'producer',
      args: {},
      outputAliases: { token: 'my_token' },
    };
    const outcome = await executeToolStep(call, {
      page: fakePage,
      context: fakeContext,
      browser: fakeBrowser,
      resolvedParameters,
      catalogue,
    });
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['my_token']).toBe('abc123');
    expect(resolvedParameters['token']).toBeUndefined();
  });

  it('uses a parameter default when caller omits the arg', async () => {
    const seen: number[] = [];
    register(
      defineTool({
        name: 'with_default',
        parameters: { count: { type: 'number', default: 7 } },
        outputs: {},
        run(args) {
          seen.push(args.count);
        },
      }),
    );
    const outcome = await executeToolStep(
      { name: 'with_default', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(seen).toEqual([7]);
  });

  it('exposes context, page, and browser by reference', async () => {
    let observed: { p: unknown; c: unknown; b: unknown } | null = null;
    register(
      defineTool({
        name: 'capture_ctx',
        parameters: {},
        outputs: {},
        run(_args, ctx) {
          observed = { p: ctx.page, c: ctx.context, b: ctx.browser };
        },
      }),
    );
    await executeToolStep(
      { name: 'capture_ctx', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(observed).toEqual({ p: fakePage, c: fakeContext, b: fakeBrowser });
  });

  it('records info/warn/error logs in the outcome', async () => {
    register(
      defineTool({
        name: 'noisy',
        parameters: {},
        outputs: {},
        run(_args, { log }) {
          log.info('starting');
          log.warn('careful');
          log.error('oops');
        },
      }),
    );
    const outcome = await executeToolStep(
      { name: 'noisy', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.logs).toEqual([
      { level: 'info', message: 'starting' },
      { level: 'warn', message: 'careful' },
      { level: 'error', message: 'oops' },
    ]);
  });
});

describe('executeToolStep — failure modes', () => {
  it('returns failed outcome when the tool name is not registered', async () => {
    const outcome = await executeToolStep(
      { name: 'missing', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/Tool "missing" not found/);
  });

  it('returns failed outcome when a required parameter is missing', async () => {
    register(
      defineTool({
        name: 'needs_arg',
        parameters: { who: { type: 'string' } },
        outputs: {},
        run: () => undefined,
      }),
    );
    const outcome = await executeToolStep(
      { name: 'needs_arg', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/requires parameter "who"/);
  });

  it('returns failed outcome when caller supplies an unknown parameter', async () => {
    register(
      defineTool({
        name: 'strict',
        parameters: {},
        outputs: {},
        run: () => undefined,
      }),
    );
    const outcome = await executeToolStep(
      { name: 'strict', args: { stray: 'x' }, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/unknown parameter "stray"/);
  });

  it('returns failed outcome when caller aliases an undeclared output', async () => {
    register(
      defineTool({
        name: 'no_outputs',
        parameters: {},
        outputs: {},
        run: () => undefined,
      }),
    );
    const outcome = await executeToolStep(
      { name: 'no_outputs', args: {}, outputAliases: { mystery: 'x' } },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/no declared output "mystery"/);
  });

  it('returns failed outcome when run throws', async () => {
    register(
      defineTool({
        name: 'angry',
        parameters: {},
        outputs: {},
        run() {
          throw new Error('boom');
        },
      }),
    );
    const outcome = await executeToolStep(
      { name: 'angry', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('boom');
  });

  it('returns failed outcome when run tries to setVar on an undeclared output', async () => {
    register(
      defineTool({
        name: 'sneaky',
        parameters: {},
        outputs: { allowed: { type: 'string' } },
        run(_args, { step }) {
          // @ts-expect-error testing runtime guard
          step.setVar('not_allowed', 'oops');
        },
      }),
    );
    const outcome = await executeToolStep(
      { name: 'sneaky', args: {}, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/undeclared output "not_allowed"/);
  });

  it('returns failed outcome when a number parameter cannot be coerced', async () => {
    register(
      defineTool({
        name: 'num',
        parameters: { n: { type: 'number' } },
        outputs: {},
        run: () => undefined,
      }),
    );
    const outcome = await executeToolStep(
      { name: 'num', args: { n: 'not-a-number' }, outputAliases: {} },
      { page: fakePage, context: fakeContext, browser: fakeBrowser, resolvedParameters, catalogue },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/expected a number/);
  });
});
