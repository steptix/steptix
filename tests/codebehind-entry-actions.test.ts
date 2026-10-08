import { describe, it, expect } from 'vitest';
import { actingCalls, entryActs, entryFunctionActs, settlesAfterLastAction } from '../src/codebehind/entry-actions.js';

/**
 * `entryActs` — does a code-behind entry act on the page, or only read it?
 * (docs/specs/SPEC-codebehind-robustness.md §6.3)
 *
 * Three things turn on the answer: generation's unwaited-read check, the wait
 * after an acting entry (§6.4), and whether a failed `step.check` heals
 * (§6.5). The last is why every doubt must come out as "acts": a heal re-runs
 * the step under AI, and after a click that can submit twice.
 */

/** An entry whose `run` body is `body`. */
const entry = (body: string): string =>
  `{\n  source: 'x',\n  async run({ page, context, step, log, tabs, browsers }) {\n${body}\n  },\n}`;

describe('entryActs — the calls that act', () => {
  const PAGE_ACTIONS = [
    'click', 'dblclick', 'tap', 'hover', 'fill', 'clear', 'press', 'pressSequentially', 'type',
    'check', 'uncheck', 'setChecked', 'selectOption', 'setInputFiles', 'dragTo', 'dispatchEvent',
    'focus',
  ];
  for (const name of PAGE_ACTIONS) {
    it(`counts locator.${name}()`, () => {
      const code = entry(`    await page.locator('#target').${name}('x');`);
      expect(entryActs(code)).toBe(true);
      expect(actingCalls(code)[0]).toMatchObject({ call: `.${name}(`, kind: 'action' });
    });
  }

  for (const name of ['goto', 'reload', 'goBack', 'goForward']) {
    it(`counts page.${name}() as navigation`, () => {
      expect(actingCalls(entry(`    await page.${name}();`))[0]).toMatchObject({ kind: 'navigation' });
    });
  }

  it('counts anything through the keyboard, the mouse or the touchscreen', () => {
    for (const call of ["page.keyboard.press('Enter')", 'page.mouse.move(10, 20)', 'page.mouse.wheel(0, 300)', 'page.touchscreen.tap(5, 5)']) {
      const found = actingCalls(entry(`    await ${call};`));
      expect(found[0]?.kind, call).toBe('input');
    }
    expect(actingCalls(entry("    await page.keyboard.press('Enter');"))[0]!.call).toBe('keyboard.press(');
  });

  it('counts the tab and browser calls that open, switch or close — and not the ones that read', () => {
    for (const call of [
      "tabs.open('https://x.test')", 'tabs.openedBy(() => undefined)', "tabs.switchTo('docs')",
      "tabs.close('docs')", "browsers.open('second')", "browsers.switchTo('default')",
      "browsers.close('second')",
    ]) {
      expect(actingCalls(entry(`    await ${call};`))[0]?.kind, call).toBe('tabs');
    }
    expect(entryActs(entry('    step.expect(tabs.list().length === 2 && tabs.active() !== undefined);'))).toBe(false);
    expect(entryActs(entry("    step.expect(browsers.list().length === 1 && browsers.activeLabel() === 'default');"))).toBe(false);
  });

  it('counts page.request and context.request calls', () => {
    for (const call of ["page.request.get('/api/x')", "page.request.post('/api/x', { data: {} })", "context.request.fetch('/api/x')"]) {
      expect(actingCalls(entry(`    await ${call};`))[0]?.kind, call).toBe('request');
    }
  });

  it('counts evaluate and its kin, which can change the page', () => {
    for (const call of [
      'page.evaluate(() => 1)', 'page.evaluateHandle(() => document.body)',
      "page.locator('#a').evaluate((el) => el.id)", "page.addScriptTag({ content: '1' })",
      "page.$eval('#a', (el) => el.id)",
    ]) {
      expect(actingCalls(entry(`    await ${call};`))[0]?.kind, call).toBe('evaluate');
    }
  });

  it('counts a call to a helper — the entry\'s, its file\'s, or an imported one', () => {
    expect(actingCalls(entry("    await signIn(page, step.getVar('username'));"))[0]).toMatchObject({
      call: 'signIn(',
      kind: 'unknown',
    });
    expect(actingCalls(entry('    await helpers.signIn(page);'))[0]).toMatchObject({
      call: '.signIn(',
      kind: 'unknown',
    });
    expect(entryActs(entry('    const login = new LoginPage(page);'))).toBe(true);
  });

  it('counts a call hidden in a template literal expression', () => {
    expect(entryActs(entry("    log.info(`clicked: ${await page.locator('#a').click()}`);"))).toBe(true);
  });

  it('counts the DOM mutators inside a page function', () => {
    expect(entryActs(entry("    await page.waitForFunction(() => { document.querySelector('#a').click(); return true; });"))).toBe(true);
  });
});

describe('entryActs — entries that only read', () => {
  it("reads failure B's capture entry as read-only", () => {
    const code =
      `{\n  source: 'Read the name of every account in the Your accounts panel [store as: accounts]',\n` +
      `  async run({ page, step, log }) {\n` +
      `    const accountRows = page.locator('#account-list [data-testid="account-row"]');\n` +
      `    const accountNames = page\n` +
      `      .locator('#account-list [data-testid="account-row"] > span > span')\n` +
      `      .filter({ hasNotText: '$' });\n` +
      `    await page.waitForFunction(() => {\n` +
      `      const rows = Array.from(\n` +
      `        document.querySelectorAll('#account-list [data-testid="account-row"]'),\n` +
      `      );\n` +
      `      return (\n` +
      `        rows.length > 0 &&\n` +
      `        rows.every((row) => {\n` +
      `          const name = Array.from(row.querySelectorAll(':scope > span > span')).find(\n` +
      `            (candidate) => !(candidate.textContent ?? '').includes('$'),\n` +
      `          );\n` +
      `          return (name?.textContent ?? '').trim().length > 0;\n` +
      `        })\n` +
      `      );\n` +
      `    });\n` +
      `\n` +
      `    const accounts = (await accountNames.allTextContents()).map((name) => name.trim());\n` +
      `    const rowCount = await accountRows.count();\n` +
      `    step.setVar('accounts', JSON.stringify(accounts));\n` +
      `    step.expect(\n` +
      `      accounts.length === rowCount && accounts.every((name) => name.length > 0),\n` +
      `      'Read all populated account names from the Your accounts panel',\n` +
      `    );\n` +
      `  },\n}`;
    expect(actingCalls(code)).toEqual([]);
  });

  it('reads the usual reads, waits and computations as read-only', () => {
    expect(
      entryActs(
        entry(
          `    const next = page.getByRole('button', { name: 'Next' });\n` +
          `    await next.waitFor({ state: 'attached' });\n` +
          `    const n = await page.locator('li').count();\n` +
          `    const label = (await next.getAttribute('aria-label')) ?? '';\n` +
          `    const visible = await next.isVisible();\n` +
          `    const title = await page.title();\n` +
          `    const items = (await page.locator('li').allTextContents()).map((t) => t.trim()).filter(Boolean);\n` +
          `    await new Promise((resolve) => setTimeout(resolve, 100));\n` +
          `    log.info('read', n, label, visible, title, items.join(', '));\n` +
          `    step.setVar('items', items);\n` +
          `    step.expect(Number(step.getVar('n') ?? '0') >= 0 && items.length > 0, 'items');`,
        ),
      ),
    ).toBe(false);
  });

  it('does not read a word inside a string, a comment or a regex as a call', () => {
    expect(
      entryActs(
        entry(
          `    // click the Next button, then fill the form\n` +
          `    const next = page.getByRole('button', { name: 'Click()' });\n` +
          `    log.info("fill(x) and press(Enter)");\n` +
          `    step.expect(/click\\(/.test(await next.innerText()), 'label');`,
        ),
      ),
    ).toBe(false);
  });

  it('does not count step.check — the self-check — but counts any other .check()', () => {
    expect(entryActs(entry("    step.check(await page.locator('li').count() === 3, 'three rows');"))).toBe(false);
    expect(entryActs(entry("    ctx.step.check(true, 'x');"))).toBe(false);
    expect(entryActs(entry("    await page.getByLabel('Cash').check();"))).toBe(true);
  });

  it('does not read the entry\'s own method definitions, or a helper\'s, as calls', () => {
    // Defined, never called: the definition itself changes nothing.
    expect(entryActs(`{\n  source: 'x',\n  async run({ page }): Promise<void> {\n    await page.title();\n  },\n}`)).toBe(false);
    expect(entryActs(`{\n  source: 'x',\n  async condition({ page }) {\n    return (await page.locator('li').count()) > 0;\n  },\n}`)).toBe(false);
    expect(entryActs(entry('    function trimmed(s) {\n      return s.trim();\n    }'))).toBe(false);
  });

  it('reads a spread of a safe call, and a comparison, as what they are', () => {
    expect(entryActs(entry("    const all = [...String(step.getVar('x')).split(',')];\n    if (all.length < 3 && all.length > (1)) step.setVar('n', all.length);"))).toBe(false);
  });

  it('classifies a bundled run function the same way, and remembers the answer', () => {
    // At run time the entry is `String(entry.run)`: the function's own text.
    async function readOnly({ page }: { page: { title(): Promise<string> } }): Promise<void> {
      await page.title();
    }
    async function clicks({ page }: { page: { click(s: string): Promise<void> } }): Promise<void> {
      await page.click('#a');
    }
    expect(entryFunctionActs(readOnly)).toBe(false);
    expect(entryFunctionActs(clicks)).toBe(true);
    expect(entryFunctionActs(clicks)).toBe(true);
  });
});

describe('settlesAfterLastAction — the entry waits for its own last action', () => {
  it('is true when step.settle() follows the last action', () => {
    expect(settlesAfterLastAction(`async run({ page, step }) { await page.click('#go'); await step.settle(); }`)).toBe(true);
    expect(
      settlesAfterLastAction(
        `async run({ page, step }) { await page.fill('#a', 'x'); await page.click('#go'); await step.settle(); ` +
          `step.expect((await page.title()) !== '', 'a title'); }`,
      ),
    ).toBe(true);
  });

  it('is false when an action follows the last settle, when there is no settle, and for an entry that does not act', () => {
    expect(
      settlesAfterLastAction(`async run({ page, step }) { await page.click('#go'); await step.settle(); await page.click('#next'); }`),
    ).toBe(false);
    expect(settlesAfterLastAction(`async run({ page }) { await page.click('#go'); }`)).toBe(false);
    expect(settlesAfterLastAction(`async run({ page, step }) { step.setVar('t', await page.title()); await step.settle(); }`)).toBe(false);
  });

  it('does not count a settle in a comment or a string', () => {
    expect(
      settlesAfterLastAction(`async run({ page, log }) { await page.click('#go'); // await step.settle()\n log.info('step.settle()'); }`),
    ).toBe(false);
  });
});
