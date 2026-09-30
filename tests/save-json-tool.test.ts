import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { loadToolCatalogue, type ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { parseTestFile } from '../src/parser/markdown.js';
import type { ToolCall } from '../src/tools/types.js';

/**
 * The `save_json` fixture tool (fixtures/tools/src/save_json.ts), run through
 * the real catalogue and executor the runners use. It never touches the page,
 * so no browser is launched: `page`, `context` and `browser` are absent, as
 * they are for a tool step on a computer-mode run.
 */

const repoRoot = path.resolve(__dirname, '..');
const toolsDir = path.join(repoRoot, 'fixtures', 'tools', 'src');
const demoTestPath = path.join(repoRoot, 'fixtures', 'tests', 'save-json-demo.md');

let catalogue: ToolCatalogue;
let dir: string;

beforeAll(async () => {
  catalogue = await loadToolCatalogue(toolsDir);
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-json-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function save(args: Record<string, string>, resolvedParameters: Record<string, string> = {}) {
  const call: ToolCall = { name: 'save_json', args, outputAliases: {} };
  return executeToolStep(call, {
    page: undefined as unknown as Page,
    context: undefined as unknown as BrowserContext,
    browser: undefined as unknown as Browser,
    resolvedParameters,
    catalogue,
  });
}

async function linesOf(file: string): Promise<unknown[]> {
  const text = await fs.readFile(file, 'utf8');
  return text.trimEnd().split('\n').map((l) => JSON.parse(l));
}

describe('save_json fixture tool', () => {
  it('appends one line per call when no key is given', async () => {
    const file = path.join(dir, 'out.jsonl');
    expect((await save({ file, a: '1' })).status).toBe('passed');
    expect((await save({ file, a: '1' })).status).toBe('passed');
    expect(await linesOf(file)).toEqual([{ a: '1' }, { a: '1' }]);
  });

  it('replaces the line holding the same key in place, keeping the order', async () => {
    const file = path.join(dir, 'out.jsonl');
    for (const id of ['C-1', 'C-2', 'C-3']) {
      await save({ file, key: 'id', id, name: `old ${id}` });
    }
    const outcome = await save({ file, key: 'id', id: 'C-2', name: 'new' });
    expect(outcome.status).toBe('passed');
    expect(await linesOf(file)).toEqual([
      { id: 'C-1', name: 'old C-1' },
      { id: 'C-2', name: 'new' },
      { id: 'C-3', name: 'old C-3' },
    ]);
    expect(outcome.logs.map((l) => l.message).join('\n')).toMatch(/Replaced id=C-2/);
  });

  it('round-trips values holding quotes, backslashes and newlines', async () => {
    const file = path.join(dir, 'out.jsonl');
    const awkward = 'Ana "AJ" O\'Brien \\ C:\\temp\nline two';
    await save({ file, name: '{{name}}' }, { name: awkward });
    expect(await linesOf(file)).toEqual([{ name: awkward }]);
  });

  it('fails without writing when a variable was never captured', async () => {
    const file = path.join(dir, 'out.jsonl');
    const outcome = await save(
      { file, firstname: '{{firstname}}', phone: '{{phone}}' },
      { firstname: 'Jane' },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('Never captured, so not saved: phone');
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('writes an empty string, which is a captured value', async () => {
    const file = path.join(dir, 'out.jsonl');
    await save({ file, phone: '{{phone}}' }, { phone: '' });
    expect(await linesOf(file)).toEqual([{ phone: '' }]);
  });

  it('fails when file is missing, or key names no field', async () => {
    expect((await save({ a: '1' })).error).toBe('save_json needs file="…"');
    const outcome = await save({ file: path.join(dir, 'out.jsonl'), key: 'id', a: '1' });
    expect(outcome.error).toBe('key="id" is not one of the fields: a');
  });

  it('resolves a relative file against the nearest steptix.config.json above the tool', async () => {
    // For fixtures/tools/src that is the repo root. `reports/` is gitignored.
    const rel = `reports/save-json-test-${path.basename(dir)}/out.jsonl`;
    try {
      await save({ file: rel, a: '1' });
      expect(await linesOf(path.join(repoRoot, rel))).toEqual([{ a: '1' }]);
    } finally {
      await fs.rm(path.join(repoRoot, path.dirname(rel)), { recursive: true, force: true });
    }
  });

  it('runs the demo file\'s call once per row: three lines, and a re-run still three', async () => {
    const parsed = await parseTestFile(demoTestPath);
    const call = parsed.toolCalls.find((c) => c?.name === 'save_json');
    expect(call).toBeDefined();
    // The bare names parsed into placeholders the executor fills per row.
    expect(call!.args).toMatchObject({
      key: 'customer_id',
      customer_id: '{{customer_id}}',
      email: '{{email}}',
    });

    const file = path.join(dir, 'customers.jsonl');
    const rows = [
      { customer_id: 'C-1001', firstname: 'Jane', lastname: "O'Brien" },
      { customer_id: 'C-1002', firstname: 'Ravi', lastname: 'Patel' },
      { customer_id: 'C-1003', firstname: 'Ana', lastname: 'Costa' },
    ];
    for (let run = 0; run < 2; run++) {
      for (const row of rows) {
        const scope = { ...row, email: `${row.firstname}@example.test` };
        const outcome = await executeToolStep(
          { ...call!, args: { ...call!.args, file } },
          {
            page: undefined as unknown as Page,
            context: undefined as unknown as BrowserContext,
            browser: undefined as unknown as Browser,
            resolvedParameters: scope,
            catalogue,
          },
        );
        expect(outcome.status).toBe('passed');
      }
    }
    expect(await linesOf(file)).toEqual(
      rows.map((r) => ({ ...r, email: `${r.firstname}@example.test` })),
    );
  });
});
