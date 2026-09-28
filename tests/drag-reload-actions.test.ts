/**
 * `drag` and `reload` in the RUNTIME (docs/specs/SPEC-record-steps.md §4:
 * "the runtime must be able to perform what is recorded").
 *
 * Built the way `back` / `forward` were (docs/specs/SPEC-browser-history.md),
 * and tested the way their review said they had to be: three of that feature's
 * tests did not bite until they were mutation-checked — the VALID_ACTION_TYPES
 * entry (an unknown type was KEPT and ran as a no-op that reported success, so
 * nothing else noticed the list losing one; `executeAction` now refuses it —
 * tests/unknown-action-type.test.ts), a code-generation rule asserted as
 * if it were conditional while it was emitted on every compile, and the claim
 * that the actions are not on the compile's refusal list. Each is pinned here
 * with its control.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAction } from '../src/browser/actions.js';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { buildSystemPrompt, buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { conditionEntryComplaint } from '../src/codebehind/generate.js';
import { parseComputerActions } from '../src/desktop/action-parser.js';
import { logger } from '../src/utils/logger.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('drag and reload — the parser', () => {
  it('are known action types, so the parser does not warn about them (with the control)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      parseAIResponse(JSON.stringify({ action: 'reload', description: 'Reload' }));
      parseAIResponse(JSON.stringify({ action: 'drag', selector: '#a', target: '#b', description: 'Drag' }));
      const unknown = (): string[] =>
        warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Unknown action type'));
      expect(unknown()).toEqual([]);
      parseAIResponse(JSON.stringify({ action: 'teleport', description: 'x' }));
      expect(unknown()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('normalises the spellings a model reaches for — each would otherwise cost a failed attempt', () => {
    for (const [raw, canonical] of [
      ['refresh', 'reload'], ['reloadPage', 'reload'], ['browserRefresh', 'reload'],
      ['dragTo', 'drag'], ['dragAndDrop', 'drag'], ['drag_and_drop', 'drag'], ['dragDrop', 'drag'],
    ] as const) {
      expect(parseAIResponse(JSON.stringify({ action: raw, description: 'x' })).actions[0]!.action, raw).toBe(canonical);
    }
  });

  it('keeps a drag\'s target — and reads it from the other names a model uses, for a drag only', () => {
    const one = (obj: Record<string, unknown>) => parseAIResponse(JSON.stringify({ description: 'x', ...obj })).actions[0]!;
    expect(one({ action: 'drag', selector: '#card', target: '#paid' })).toMatchObject({ selector: '#card', target: '#paid' });
    expect(one({ action: 'drag', selector: '#card', dropTarget: '#paid' }).target).toBe('#paid');
    expect(one({ action: 'drag', selector: '#card', to: '#paid' }).target).toBe('#paid');
    expect(one({ action: 'dragTo', source: '#card', targetSelector: '#paid' })).toMatchObject({
      action: 'drag', selector: '#card', target: '#paid',
    });
    // `to` stays a scroll's field, and `source` an extract_csrf's, elsewhere.
    expect(one({ action: 'scroll', to: 'bottom' })).toMatchObject({ to: 'bottom' });
    expect(one({ action: 'scroll', to: 'bottom' }).target).toBeUndefined();
    expect(one({ action: 'extract_csrf', source: 'meta[name=csrf]' }).selector).toBeUndefined();
  });

  it('reload needs nothing but a description', () => {
    const only = parseAIResponse(JSON.stringify({ action: 'reload', description: 'Reload the page' })).actions[0]!;
    expect(only).toEqual({ action: 'reload', description: 'Reload the page' });
  });
});

describe('drag and reload — the executor (mocked page)', () => {
  function mockPage() {
    const reload = vi.fn().mockResolvedValue({});
    const page = {
      reload,
      frameLocator: vi.fn(() => ({ locator: () => ({ count: async () => 1 }) })),
      locator: vi.fn(() => ({ count: async () => 1 })),
      url: () => 'https://app.test/',
    } as unknown as Page;
    return { page, reload };
  }

  it('reload calls page.reload with navigate\'s arrival rule, on the page even inside a frame', async () => {
    const { page, reload } = mockPage();
    const result = await executeAction(page, { action: 'reload', frame: 'iframe#pay', description: 'Reload' });
    expect(result.success).toBe(true);
    expect(reload).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  });

  it('a reload that failed is not retryable — as back and forward are not (review, finding 14)', async () => {
    const { page, reload } = mockPage();
    reload.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));
    const result = await executeAction(page, { action: 'reload', description: 'Reload the page' });
    expect(result.success).toBe(false);
    // A re-plan cannot make the page reload; it can only hand the model a
    // failure to satisfy with a `navigate` or a `noop`.
    expect(result.retryable).toBe(false);
    // The control: a failed click stays retryable.
    const click = await executeAction(
      { ...page, locator: vi.fn(() => ({ count: async () => 0 })) } as unknown as Page,
      { action: 'click', selector: '#nothing', description: 'Click nothing' },
    );
    expect(click.success).toBe(false);
    expect(click.retryable).not.toBe(false);
  });

  it('a drag with no target fails, naming the missing field', async () => {
    const { page } = mockPage();
    const result = await executeAction(page, { action: 'drag', selector: '#card', description: 'Drag' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/drag action requires a "target"/);
  });
});

describe('drag and reload — the settle, the prompts, the compile', () => {
  it('are mutating actions, so a post-action settle runs', () => {
    const source = readFileSync(path.join(repoRoot, 'src', 'runner', 'step-executor.ts'), 'utf8');
    const block = /const MUTATING_ACTIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
    expect(block).not.toBeNull();
    expect(block![1]).toContain("'reload'");
    expect(block![1]).toContain("'drag'");
  });

  it('the run\'s system prompt names both, with a drag\'s target and the keypress negative', () => {
    const text = contentBlocksToText(buildSystemPrompt(''));
    expect(text).toContain('{ "action": "reload" }');
    expect(text).toContain('{ "action": "drag", "selector": "<the element dragged>", "target": "<the element it is dropped on>" }');
    expect(text).toMatch(/Reload the page", "Refresh"/);
    expect(text).toContain('A drag is ONE action');
  });

  it('the code generator is told page.reload() — only for a transcript that reloaded', () => {
    const prompt = (actions: Parameters<typeof buildStepCodePrompt>[0]['actions']): string =>
      contentBlocksToText(buildStepCodePrompt({ rawStepText: 'x', parameters: [], actions }).content);
    expect(prompt([{ action: 'reload', description: 'Reload' }])).toContain('await page.reload()');
    // The control: without it the assertion above holds on a constant.
    expect(prompt([{ action: 'click', selector: '#a', description: 'Click' }])).not.toContain('page.reload()');
  });

  it('the code generator is told dragTo — only for a transcript that dragged', () => {
    const prompt = (actions: Parameters<typeof buildStepCodePrompt>[0]['actions']): string =>
      contentBlocksToText(buildStepCodePrompt({ rawStepText: 'x', parameters: [], actions }).content);
    expect(prompt([{ action: 'drag', selector: '#card', target: '#paid', description: 'Drag' }])).toContain('.dragTo(');
    expect(prompt([{ action: 'click', selector: '#a', description: 'Click' }])).not.toContain('.dragTo(');
  });

  it('are not on the compile\'s refusal list — both become one line of Playwright', () => {
    const source = readFileSync(path.join(repoRoot, 'src', 'codebehind', 'generate.ts'), 'utf8');
    const at = source.indexOf('const FRAMEWORK_ACTIONS');
    expect(at).toBeGreaterThan(-1);
    const line = source.slice(at, source.indexOf('\n', at));
    expect(line).toContain("'prompt'"); // the control: this IS the list
    expect(line).not.toContain('reload');
    expect(line).not.toContain('drag');
  });

  it('a condition entry may do neither: both are refused by the static backstop', () => {
    const entry = (body: string) =>
      `{\n  source: 'While the Next button is enabled, Go to the next page',\n  async condition({ page, step }) {\n${body}\n  },\n}`;
    expect(conditionEntryComplaint(entry(`    await page.reload();\n    return true;`))).toMatch(/\.reload\(/);
    expect(
      conditionEntryComplaint(entry(`    await page.locator('#a').dragTo(page.locator('#b'));\n    return true;`)),
    ).toMatch(/dragTo/);
  });

  it('computer mode refuses the page spellings with the page-action message', () => {
    for (const name of ['reload', 'refresh', 'dragTo', 'dragAndDrop']) {
      const parsed = parseComputerActions(`{"action":"${name}","selector":"#x"}`);
      expect(parsed.actions, name).toEqual([]);
      expect(parsed.refused[0]!.reason, name).toContain('is a page action');
    }
  });
});

/**
 * Against a real Chromium, because both actions are browser behaviour a mock
 * cannot answer for: whether `dragTo` drives an HTML5 drop and a pointer-event
 * sortable, and whether a reload makes a new document.
 */
describe('drag and reload over a real page', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function pageWith(html: string): Promise<Page> {
    const page = await browser.newPage();
    // A real origin, not setContent: a reload of about:blank would lose the
    // content and prove nothing.
    await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto('http://drag.test/board');
    return page;
  }

  it('drag moves a card into another column through HTML5 drag-and-drop', async () => {
    const page = await pageWith(`<!doctype html><html><body>
      <div id="todo"><h2>To do</h2><div id="card" draggable="true">Invoice 1043</div></div>
      <div id="paid" style="min-height:80px"><h2>Paid</h2></div>
      <script>
        const card = document.getElementById('card');
        card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'));
        const paid = document.getElementById('paid');
        paid.addEventListener('dragover', (e) => e.preventDefault());
        paid.addEventListener('drop', (e) => { e.preventDefault(); paid.appendChild(card); });
      </script></body></html>`);
    const result = await executeAction(page, {
      action: 'drag', selector: '#card', target: '#paid', description: 'Drag the card onto Paid',
    });
    expect(result.success).toBe(true);
    expect(await page.evaluate('document.getElementById("card").parentElement.id')).toBe('paid');
    await page.close();
  }, 30_000);

  it('drag reorders a pointer-event sortable list', async () => {
    const page = await pageWith(`<!doctype html><html><body>
      <ul id="list" style="list-style:none;padding:0">
        <li id="one" style="height:40px">One</li><li id="two" style="height:40px">Two</li><li id="three" style="height:40px">Three</li>
      </ul>
      <script>
        let dragging = null;
        document.addEventListener('pointerdown', (e) => { dragging = e.target.closest('li'); });
        document.addEventListener('pointerup', (e) => {
          const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('li');
          if (dragging && over && over !== dragging) over.after(dragging);
          dragging = null;
        });
      </script></body></html>`);
    const result = await executeAction(page, {
      action: 'drag', selector: '#one', target: '#three', description: 'Drag One below Three',
    });
    expect(result.success).toBe(true);
    expect(await page.evaluate('[...document.querySelectorAll("li")].map((l) => l.id).join()')).toBe('two,three,one');
    await page.close();
  }, 30_000);

  it('reload makes a new document of the same address', async () => {
    const page = await pageWith('<!doctype html><html><body><h1>Board</h1></body></html>');
    await page.evaluate('window.marker = 42');
    const result = await executeAction(page, { action: 'reload', description: 'Reload the page' });
    expect(result.success).toBe(true);
    expect(await page.evaluate('window.marker')).toBeUndefined();
    expect(page.url()).toBe('http://drag.test/board');
    await page.close();
  }, 30_000);
});
