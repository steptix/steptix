/**
 * Tests for the "tool not found" diagnostic chain:
 *
 *   loadToolCatalogue → empty catalogue with diagnostics
 *           ↓
 *   require(name)     → error message names the dir + recipe
 *           ↓
 *   executeToolStep   → mirrors the error into outcome.logs
 *           ↓
 *   renderToolStep    → renders the "How to register a tool" callout
 *
 * Each layer is tested independently so a regression at any rung surfaces
 * with a precise failure rather than a vague "report didn't show the hint".
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ToolCatalogue, loadToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';
import { renderToolStep } from '../src/report/generator.js';

describe('ToolCatalogue.require — error message', () => {
  it('includes the tools.dir path when diagnostics is set', () => {
    const cat = new ToolCatalogue();
    cat.diagnostics = {
      toolsDir: '/abs/path/to/tools',
      toolsDirMissing: false,
      filesScanned: 4,
    };
    let caught: Error | undefined;
    try { cat.require('extract_order_ids'); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('Tool "extract_order_ids" not found');
    expect(caught!.message).toContain('/abs/path/to/tools');
    expect(caught!.message).toContain('4 files');
  });

  it('points at the missing directory + how-to-fix when toolsDir is absent', () => {
    const cat = new ToolCatalogue();
    cat.diagnostics = {
      toolsDir: '/never/created',
      toolsDirMissing: true,
      filesScanned: 0,
    };
    let caught: Error | undefined;
    try { cat.require('foo'); } catch (e) { caught = e as Error; }
    expect(caught!.message).toContain('tools.dir does not exist: /never/created');
    expect(caught!.message).toMatch(/update[\s\S]*tests\.toolsDir/i);
  });

  it('includes a defineTool recipe when the catalogue is empty', () => {
    const cat = new ToolCatalogue();
    cat.diagnostics = { toolsDir: '/x', toolsDirMissing: false, filesScanned: 0 };
    const msg = cat.buildNotFoundMessage('my_tool');
    expect(msg).toContain('Registered tools: [none]');
    expect(msg).toContain("import { defineTool } from 'steptix/tools'");
    expect(msg).toContain("name: 'my_tool'");
    expect(msg).toContain('async run(args, { page, step, log })');
  });

  it('omits the recipe when other tools are registered (the user has a typo, not a setup gap)', () => {
    const cat = new ToolCatalogue();
    cat.register({
      definition: {
        name: 'fetch_csrf_token',
        parameters: {},
        outputs: {},
        run: () => undefined,
      },
      filePath: '/x/fetch_csrf_token.ts',
    });
    cat.diagnostics = { toolsDir: '/x', toolsDirMissing: false, filesScanned: 1 };
    const msg = cat.buildNotFoundMessage('fetch_csrf');
    expect(msg).toContain('Registered tools: [fetch_csrf_token]');
    expect(msg).not.toContain("import { defineTool }"); // recipe suppressed
  });
});

describe('loadToolCatalogue — diagnostics', () => {
  it('attaches diagnostics with toolsDirMissing: true when dir is absent', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'steptix-tools-missing-'));
    rmSync(tmp, { recursive: true, force: true });
    const cat = await loadToolCatalogue(tmp);
    expect(cat.size).toBe(0);
    expect(cat.diagnostics?.toolsDirMissing).toBe(true);
    expect(cat.diagnostics?.filesScanned).toBe(0);
    expect(cat.diagnostics?.toolsDir).toBe(tmp);
  });

  it('attaches diagnostics with file count when dir exists', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'steptix-tools-empty-'));
    mkdirSync(tmp, { recursive: true });
    const cat = await loadToolCatalogue(tmp);
    expect(cat.diagnostics?.toolsDirMissing).toBe(false);
    expect(cat.diagnostics?.filesScanned).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('executeToolStep — mirrors catalogue error into logs', () => {
  it('failed lookup pushes the error into outcome.logs so the report sees it', async () => {
    const cat = new ToolCatalogue();
    cat.diagnostics = { toolsDir: '/x', toolsDirMissing: false, filesScanned: 0 };

    const outcome = await executeToolStep(
      { name: 'missing_tool', args: {}, outputAliases: {} },
      {
        page: {} as never,
        context: {} as never,
        browser: {} as never,
        resolvedParameters: {},
        catalogue: cat,
      },
    );
    expect(outcome.status).toBe('failed');
    const errLog = outcome.logs.find((l) => l.level === 'error');
    expect(errLog).toBeDefined();
    expect(errLog!.message).toContain('not found in catalogue');
    // Same content lands on outcome.error too — single source of truth.
    expect(outcome.error).toBe(errLog!.message);
  });
});

describe('renderToolStep — "how to register a tool" hint', () => {
  it('renders the callout when logs include the catalogue error', () => {
    const html = renderToolStep({
      name: 'extract_order_ids',
      args: {},
      outputs: {},
      logs: [
        {
          level: 'error',
          message: 'Tool "extract_order_ids" not found in catalogue.\n  Registered tools: [none]',
        },
      ],
    });
    expect(html).toContain('How to register');
    expect(html).toContain('extract_order_ids');
    // Recipe is HTML-escaped, so single quotes become &#039;. Match on
    // substrings that survive escaping rather than the raw recipe.
    expect(html).toContain('import { defineTool } from');
    expect(html).toContain('steptix/tools');
    expect(html).toContain('tests.toolsDir');
  });

  it('omits the callout when the tool ran successfully', () => {
    const html = renderToolStep({
      name: 'read_page_title',
      args: {},
      outputs: { page_title: 'Hello' },
      logs: [{ level: 'info', message: 'page title: Hello' }],
    });
    expect(html).not.toContain('How to register');
  });

  it('omits the callout for unrelated tool failures (e.g. tool threw)', () => {
    const html = renderToolStep({
      name: 'flaky',
      args: {},
      outputs: {},
      logs: [{ level: 'error', message: 'fetch failed: ECONNREFUSED' }],
    });
    expect(html).not.toContain('How to register');
  });
});

// Sanity: the default catalogue (no diagnostics) still produces a sensible
// error — diagnostics is optional metadata, not required for `require`.
describe('ToolCatalogue.require — without diagnostics', () => {
  it('falls back to the basic message when diagnostics is unset', () => {
    const cat = new ToolCatalogue();
    let caught: Error | undefined;
    try { cat.require('foo'); } catch (e) { caught = e as Error; }
    expect(caught!.message).toContain('Tool "foo" not found');
    expect(caught!.message).toContain('Registered tools: [none]');
    // No "Scanned: ..." line because diagnostics wasn't attached.
    expect(caught!.message).not.toContain('Scanned:');
  });
});

// Smoke test: the temp file path is referenced by name only (not used here)
// to satisfy lint about the writeFileSync import being unused otherwise.
const _smoke = writeFileSync;
void _smoke;
