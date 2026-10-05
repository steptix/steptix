import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { parseTestFile } from '../src/parser/markdown.js';
import type { ToolCall } from '../src/tools/types.js';

/**
 * The example tools in fixtures/tools/src that never touch the page, run
 * through the real catalogue and executor the runners use. They are shipped
 * for projects to copy, so their semantics are worth pinning — but not behind
 * a fixture server and a Chromium launch they do not use. `page`, `context`
 * and `browser` are absent, as they are for a tool step on a computer-mode
 * run. The tools that DO need the live app (check_health, read_page_title,
 * fetch_csrf_token) are in tool-end-to-end.test.ts; save_json has its own file.
 */

const repoRoot = path.resolve(__dirname, '..');
const toolsDir = path.join(repoRoot, 'fixtures', 'tools', 'src');

let catalogue: ToolCatalogue;

beforeAll(async () => {
  catalogue = await loadToolCatalogue(toolsDir);
});

function run(call: ToolCall, resolvedParameters: Record<string, string> = {}) {
  return executeToolStep(call, {
    page: undefined as unknown as Page,
    context: undefined as unknown as BrowserContext,
    browser: undefined as unknown as Browser,
    resolvedParameters,
    catalogue,
  });
}

describe('the fixture tool catalogue', () => {
  it('indexes the fixture tools from disk and resolves them lazily by name', async () => {
    expect(catalogue.indexedCount).toBeGreaterThanOrEqual(2);
    expect((await catalogue.resolve('fetch_csrf_token')).definition.name).toBe('fetch_csrf_token');
    expect((await catalogue.resolve('read_page_title')).definition.name).toBe('read_page_title');
  });

  it('resolves rung-1 (bare function), rung-2 (tool() helper), and named-export tools', async () => {
    expect((await catalogue.resolve('uuid')).definition.name).toBe('uuid');                  // rung 1
    expect((await catalogue.resolve('check_health')).definition.name).toBe('check_health');  // rung 2
    // Named exports live in a multi-tool file — referenced as `<file>/<tool>`.
    expect((await catalogue.resolve('strings/slugify')).definition.name).toBe('slugify');
    expect((await catalogue.resolve('strings/upper')).definition.name).toBe('upper');
  });

  it('isolates a broken tool file — healthy tools run, the broken one fails only when invoked', async () => {
    // `broken_tool.ts` (imports a missing package) is indexed alongside the
    // healthy tools. A tool we don't reference is unaffected by its presence:
    expect((await catalogue.resolve('uuid')).definition.name).toBe('uuid');
    // …and the broken tool fails as a single failed step, with the real error,
    // only because this step referenced it.
    const outcome = await run({ name: 'broken_tool', args: {}, outputAliases: {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/could not be loaded/);
  });

  it('runs a rung-1 bare-function tool — return value lands in scope under the tool name', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await run({ name: 'uuid', args: {}, outputAliases: {} }, resolvedParameters);
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['uuid']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('runs a multi-tool-file named export via file/tool — caller arg destructured from scope', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await run(
      { name: 'strings/slugify', args: { s: 'Hello, World! 2026' }, outputAliases: {} },
      resolvedParameters,
    );
    expect(outcome.status).toBe('passed');
    // Output lands under the tool's own name, not the path-qualified ref.
    expect(resolvedParameters['slugify']).toBe('hello-world-2026');
  });
});

// ── regex_extract (issue 020 — slice a substring out of a read value) ──────
// Pure string tool: ignores page/context, so these exercise the extraction
// semantics directly. The motivating case is a `read` capturing an element's
// whole textContent when the test only wants a fragment of it.
describe('regex_extract fixture tool', () => {
  function extract(args: Record<string, string>, resolvedParameters: Record<string, string> = {}) {
    return run({ name: 'regex_extract', args, outputAliases: {} }, resolvedParameters);
  }

  it('stores the first capture group', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await extract(
      {
        text: 'Account number: 1234 1234 1234 OIN:12345678',
        pattern: 'Account number:\\s*(\\d{4} \\d{4} \\d{4})',
      },
      resolvedParameters,
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['match']).toBe('1234 1234 1234');
  });

  it('falls back to the whole match when the pattern has no group', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await extract({ text: 'DE89 3704 0044 0532', pattern: '^[A-Z]{2}' }, resolvedParameters);
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['match']).toBe('DE');
  });

  it('honours flags and an explicit capture-group index', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await extract(
      { text: 'X-abc-Y', pattern: '(a)(B)(c)', flags: 'i', group: '2' },
      resolvedParameters,
    );
    expect(outcome.status).toBe('passed');
    expect(resolvedParameters['match']).toBe('b'); // group 2, matched case-insensitively
  });

  it('FAILS HARD when the pattern matches nothing', async () => {
    const resolvedParameters: Record<string, string> = {};
    const outcome = await extract({ text: 'no digits anywhere', pattern: '(\\d{4})' }, resolvedParameters);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/matched nothing/);
    expect(resolvedParameters['match']).toBeUndefined();
  });

  it('FAILS HARD on an invalid pattern', async () => {
    const outcome = await extract({ text: 'whatever', pattern: '(' });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/invalid pattern/);
  });

  it('the demo file\'s three calls store what its own Assert steps expect', async () => {
    // fixtures/tests/regex-extract-demo.md is the tool's documentation, linked
    // from issues/020. Running its calls, rather than only parsing them, keeps
    // its patterns and out.match names honest against the tool.
    const parsed = await parseTestFile(path.join(repoRoot, 'fixtures', 'tests', 'regex-extract-demo.md'));
    const calls = parsed.toolCalls.filter((c): c is ToolCall => c !== null);
    expect(calls.map((c) => c.name)).toEqual(['regex_extract', 'regex_extract', 'regex_extract']);

    const scope: Record<string, string> = {};
    for (const call of calls) {
      expect((await run(call, scope)).status).toBe('passed');
    }
    expect(scope).toEqual({
      account_number: '1234 1234 1234',
      iban_country: 'DE',
      order_id: 'O-1007',
    });
  });
});
