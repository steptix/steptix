import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
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
 * read_xlsx reads a workbook this file writes by hand.
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

describe('read_xlsx fixture tool', () => {
  /** A zip written by hand: stored or deflated entries, no CRC (the reader checks none). */
  function zipOf(entries: Record<string, string>, deflate = true): Buffer {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
      const raw = Buffer.from(text, 'utf8');
      const data = deflate ? zlib.deflateRawSync(raw) : raw;
      const nameBytes = Buffer.from(name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(deflate ? 8 : 0, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0);
      dir.writeUInt16LE(deflate ? 8 : 0, 10);
      dir.writeUInt32LE(data.length, 20);
      dir.writeUInt32LE(raw.length, 24);
      dir.writeUInt16LE(nameBytes.length, 28);
      dir.writeUInt32LE(offset, 42);
      locals.push(local, nameBytes, data);
      central.push(dir, nameBytes);
      offset += local.length + nameBytes.length + data.length;
    }
    const dirBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(dirBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dirBytes, end]);
  }

  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>Ada &amp; Co</t></is></c><c r="B2"><v>12.5</v></c></row>' +
    '<row r="3"><c r="B3" t="str"><v>only B</v></c></row>' +
    '</sheetData></worksheet>';
  const strings = '<sst><si><t>Name</t></si><si><r><t>To</t></r><r><t>tal</t></r></si></sst>';

  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-xlsx-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  function readXlsx(args: Record<string, string>, resolvedParameters: Record<string, string> = {}) {
    return run({ name: 'read_xlsx', args, outputAliases: {} }, resolvedParameters);
  }

  for (const deflate of [true, false]) {
    it(`reads shared, rich, inline and plain cells, gaps kept (${deflate ? 'deflated' : 'stored'})`, async () => {
      const file = path.join(dir, `book-${deflate}.xlsx`);
      fs.writeFileSync(file, zipOf({ 'xl/sharedStrings.xml': strings, 'xl/worksheets/sheet1.xml': sheet }, deflate));
      const vars: Record<string, string> = {};
      const outcome = await readXlsx({ path: file, header: 'Name, Total' }, vars);
      expect(outcome.status).toBe('passed');
      expect(vars['xlsx_rows']).toBe('Name | Total\nAda & Co | 12.5\n | only B');
      expect(String(vars['xlsx_row_count'])).toBe('3');
    });
  }

  it('fails when the first row is not the header asked for', async () => {
    const file = path.join(dir, 'header.xlsx');
    fs.writeFileSync(file, zipOf({ 'xl/sharedStrings.xml': strings, 'xl/worksheets/sheet1.xml': sheet }));
    const outcome = await readXlsx({ path: file, header: 'Name,Amount' });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/first row is "Name, Total", not "Name, Amount"/);
  });

  it('fails on a file that is not a workbook, and on a missing one', async () => {
    const file = path.join(dir, 'not.xlsx');
    fs.writeFileSync(file, 'Name,Total\nAda,12.5\n');
    expect((await readXlsx({ path: file })).error).toMatch(/is not a zip/);
    expect((await readXlsx({ path: path.join(dir, 'missing.xlsx') })).error).toMatch(/cannot read/);
    const noSheet = path.join(dir, 'no-sheet.xlsx');
    fs.writeFileSync(noSheet, zipOf({ 'xl/workbook.xml': '<workbook/>' }));
    expect((await readXlsx({ path: noSheet })).error).toMatch(/has no worksheet/);
  });
});
