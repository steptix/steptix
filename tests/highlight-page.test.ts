/**
 * The highlighting page wrapper for code-behind entries and fixture tools
 * (src/browser/highlight-page.ts; docs/specs/SPEC-interaction-highlight.md
 * §2.3, phase 3).
 *
 * Generated code is written the way these cases are — `page.locator(…).click()`,
 * `getByRole(…).fill()`, `.first().textContent()`, `dragTo(target)`,
 * `{ has: locator }` — so each case drives a real Chromium page through the
 * proxy and asserts two things: the marks are exactly the elements touched,
 * and Playwright still does what the call says. The second half is the risk a
 * proxy carries: Playwright reads `_frame` and `_selector` off the locators it
 * is handed, and a wrapper that broke that would fail entries that used to
 * pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { highlightingApi, highlightingPage, unwrapHighlighted } from '../src/browser/highlight-page.js';
import { HIGHLIGHT_DEFAULTS, createHighlighter, type HighlightKind, type HighlightSink } from '../src/browser/highlight.js';
import { runCodeBehindEntry } from '../src/codebehind/execute.js';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolCatalogue } from '../src/tools/registry.js';
import { executeToolStep } from '../src/tools/executor.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

const PAGE = `<!doctype html><html><body>
  <button id="go">Go</button>
  <label for="name">Name</label><input id="name">
  <p class="row" id="r1">One</p><p class="row" id="r2">Two</p>
  <div id="card-a" class="card"><span id="inner">Ada</span></div>
  <div id="card-b" class="card"><span>Bob</span></div>
  <div id="item" style="width:60px;height:30px;background:#ddd">Item</div>
  <div id="host" style="width:120px;height:60px;margin-top:40px;background:#eee">Host</div>
  <script>
    window.clicks = 0;
    document.getElementById('go').addEventListener('click', () => { window.clicks++; });
    window.dropped = null;
    document.addEventListener('mouseup', (e) => { window.dropped = e.target.id; });
  </script>
</body></html>`;

async function fresh(): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(PAGE);
  return page;
}

interface Recorded { locator: Locator; kind: HighlightKind; max: number | undefined }

function recordingSink(): { sink: HighlightSink; marks: Recorded[] } {
  const marks: Recorded[] = [];
  return { sink: { mark: (locator, kind, max) => { marks.push({ locator, kind, max }); } }, marks };
}

async function resolved(marks: Recorded[]): Promise<Array<{ kind: HighlightKind; max: number | undefined; ids: string[] }>> {
  return Promise.all(marks.map(async (m) => ({
    kind: m.kind,
    max: m.max,
    ids: await m.locator.evaluateAll((els) => els.map((e) => e.id)),
  })));
}

describe('a compiled-style entry through the wrapper', () => {
  it('marks what each call acts on or reads, and every call still works', async () => {
    const raw = await fresh();
    try {
      const { sink, marks } = recordingSink();
      const page = highlightingPage(raw, sink);

      await page.locator('#go').click();
      await page.getByRole('textbox', { name: 'Name' }).fill('Ada');
      const first = await page.locator('.row').first().textContent();
      const cards = await page.locator('.card', { has: page.locator('#inner') }).count();

      expect(await raw.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
      expect(await raw.inputValue('#name')).toBe('Ada');
      expect(first).toBe('One');
      expect(cards).toBe(1);
      expect(await resolved(marks)).toEqual([
        { kind: 'act', max: undefined, ids: ['go'] },
        { kind: 'act', max: undefined, ids: ['name'] },
        { kind: 'read', max: undefined, ids: ['r1'] },
        { kind: 'read', max: 20, ids: ['card-a'] },
      ]);
    } finally {
      await raw.close();
    }
  });

  it('dragTo takes a proxied target, marks both ends, and drops where it says', async () => {
    const raw = await fresh();
    try {
      const { sink, marks } = recordingSink();
      const page = highlightingPage(raw, sink);
      await page.locator('#item').dragTo(page.locator('#host'));
      expect(await raw.evaluate(() => (window as unknown as { dropped: string }).dropped)).toBe('host');
      expect(await resolved(marks)).toEqual([
        { kind: 'act', max: undefined, ids: ['item'] },
        { kind: 'act', max: undefined, ids: ['host'] },
      ]);
    } finally {
      await raw.close();
    }
  });

  it('and() / or() take proxied locators, and marks only at the act', async () => {
    const raw = await fresh();
    try {
      const { sink, marks } = recordingSink();
      const page = highlightingPage(raw, sink);
      const both = page.locator('.card').and(page.locator('#card-b'));
      const either = page.locator('#go').or(page.locator('#name'));
      expect(marks).toEqual([]);
      expect(await both.textContent()).toBe('Bob');
      expect(await either.count()).toBe(2);
      expect(await resolved(marks)).toEqual([
        { kind: 'read', max: undefined, ids: ['card-b'] },
        { kind: 'read', max: 20, ids: ['go', 'name'] },
      ]);
    } finally {
      await raw.close();
    }
  });

  it('marks the selector-taking page shorthands, on the first match', async () => {
    const raw = await fresh();
    try {
      const { sink, marks } = recordingSink();
      const page = highlightingPage(raw, sink);
      await page.click('#go');
      await page.fill('#name', 'Bob');
      expect(await page.textContent('.row')).toBe('One');
      expect(await resolved(marks)).toEqual([
        { kind: 'act', max: undefined, ids: ['go'] },
        { kind: 'act', max: undefined, ids: ['name'] },
        { kind: 'read', max: undefined, ids: ['r1'] },
      ]);
    } finally {
      await raw.close();
    }
  });

  it('leaves what has no element unmarked: evaluate, the keyboard, navigation', async () => {
    const raw = await fresh();
    try {
      const { sink, marks } = recordingSink();
      const page = highlightingPage(raw, sink);
      await page.evaluate(() => 1);
      await page.focus('#name');
      await page.keyboard.type('x');
      await page.locator('#go').isVisible();
      expect(marks).toEqual([]);
    } finally {
      await raw.close();
    }
  });
});

describe('identity and instanceof', () => {
  it('keeps the prototype, and hands out one proxy per object', async () => {
    const raw = await fresh();
    try {
      const { sink } = recordingSink();
      const page = highlightingPage(raw, sink);
      const rawLocator = raw.locator('#go');
      const locator = page.locator('#go');

      expect(page instanceof (raw.constructor as new () => unknown)).toBe(true);
      expect(locator instanceof (rawLocator.constructor as new () => unknown)).toBe(true);
      expect(page).not.toBe(raw);
      expect(highlightingPage(raw, sink)).toBe(page);
      expect(page.mainFrame()).toBe(page.mainFrame());
      expect(locator.page()).toBe(page);
      expect(page.click).toBe(page.click);
      expect(unwrapHighlighted(page, sink)).toBe(raw);
      // Playwright's own comparison reads through the proxy to its target.
      expect(page.mainFrame().url()).toBe(raw.mainFrame().url());
    } finally {
      await raw.close();
    }
  });

  it('wraps the pages the tab API hands back as the same proxy as ctx.page', async () => {
    const raw = await fresh();
    try {
      const { sink } = recordingSink();
      const tabs = highlightingApi({ active: () => raw, switchTo: async (_label: string) => raw }, sink);
      const page = highlightingPage(raw, sink);
      expect(tabs.active()).toBe(page);
      expect(await tabs.switchTo('main')).toBe(page);
    } finally {
      await raw.close();
    }
  });

  it('draws real rings without recursing through itself', async () => {
    const raw = await fresh();
    try {
      let marks = 0;
      const real = createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 });
      const sink: HighlightSink = {
        mark(locator, kind, max) {
          marks++;
          real.mark(locator, kind, max);
        },
      };
      const page = highlightingPage(raw, sink);
      await page.locator('#go').click();
      await page.locator('.row').allTextContents();
      expect(marks).toBe(2);
      await raw.waitForFunction(() => document.documentElement.querySelector(':scope > steptix-highlight') !== null);
    } finally {
      await raw.close();
    }
  });
});

describe('where the wrapper is handed out', () => {
  it('a code-behind entry gets the wrapped page with the highlight on, the real one with it off', async () => {
    const raw = await fresh();
    try {
      const { sink, marks } = recordingSink();
      let seen: Page | undefined;
      const binding = (run: (ctx: { page: Page }) => Promise<void>) => ({
        file: path.join(os.tmpdir(), 'x.steps.ts'),
        source: 'Click Go',
        occurrence: 0,
        scope: { renames: {}, inputs: {} },
        entry: { source: 'Click Go', run },
      });
      const base = { page: raw, context: raw.context(), browser, resolvedParameters: {}, label: 'test' };

      const on = await runCodeBehindEntry({
        ...base,
        binding: binding(async ({ page }) => { seen = page; await page.locator('#go').click(); }),
        highlight: sink,
      });
      expect(on.status).toBe('passed');
      expect(seen).not.toBe(raw);
      expect(await resolved(marks)).toEqual([{ kind: 'act', max: undefined, ids: ['go'] }]);

      const off = await runCodeBehindEntry({
        ...base,
        binding: binding(async ({ page }) => { seen = page; await page.locator('#go').click(); }),
      });
      expect(off.status).toBe('passed');
      expect(seen).toBe(raw);
      expect(marks).toHaveLength(1);
    } finally {
      await raw.close();
    }
  });

  it('a fixture tool gets the wrapped page with the highlight on', async () => {
    const raw = await fresh();
    try {
      const { sink, marks } = recordingSink();
      const catalogue = new ToolCatalogue();
      catalogue.register({
        definition: defineTool({
          name: 'press_go',
          parameters: {},
          outputs: {},
          async run(_args, { page }) {
            await page.getByRole('button', { name: 'Go' }).click();
          },
        }) as never,
        filePath: '/virtual/press-go.ts',
      });
      const outcome = await executeToolStep(
        { name: 'press_go', args: {}, outputAliases: {} },
        { page: raw, context: raw.context(), browser, resolvedParameters: {}, catalogue, highlight: sink },
      );
      expect(outcome.status).toBe('passed');
      expect(await raw.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
      expect(await resolved(marks)).toEqual([{ kind: 'act', max: undefined, ids: ['go'] }]);
    } finally {
      await raw.close();
    }
  });
});
