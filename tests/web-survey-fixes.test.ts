/**
 * The framework fixes the web survey found (docs/specs/SPEC-web-survey-fixes.md).
 *
 * Each `describe` is one section of that spec, and each executor test drives a
 * real Chromium page built to fail the way the survey's site did: a filter that
 * listens for `keyup`, a list a filter hides rather than removes, a drag
 * library that ignores a single jump, a checkbox whose `<input>` is hidden, an
 * ad over a button, a prompt dialog.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { executeAction, normaliseColour, normaliseKeyName } from '../src/browser/actions.js';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { installDialogGuard, isAdRequest } from '../src/browser/manager.js';
import { dialogRecords, disarmDialog } from '../src/browser/dialogs.js';
import { captureDomSnapshot } from '../src/browser/dom-cleaner.js';
import type { AIAction } from '../src/ai/types.js';

let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  installDialogGuard(context);
});

afterAll(async () => {
  await browser.close();
});

async function pageWith(html: string): Promise<Page> {
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  return page;
}

function act(action: Omit<AIAction, 'description'>): AIAction {
  return { description: `${action.action} under test`, ...action } as AIAction;
}

const one = (obj: Record<string, unknown>): AIAction =>
  parseAIResponse(JSON.stringify({ description: 'x', ...obj })).actions[0]!;

describe('§2.2 double-click and right-click — the parser', () => {
  it('maps the names a model sends onto click with the field that makes them mean it', () => {
    expect(one({ action: 'doubleClick', selector: '#b' })).toMatchObject({ action: 'click', clickCount: 2 });
    expect(one({ action: 'dblclick', selector: '#b' })).toMatchObject({ action: 'click', clickCount: 2 });
    expect(one({ action: 'double_click', selector: '#b' })).toMatchObject({ action: 'click', clickCount: 2 });
    expect(one({ action: 'rightClick', selector: '#b' })).toMatchObject({ action: 'click', button: 'right' });
    expect(one({ action: 'context_click', selector: '#b' })).toMatchObject({ action: 'click', button: 'right' });
  });

  it('keeps clickCount and button on a click, and nowhere else', () => {
    expect(one({ action: 'click', selector: '#b', clickCount: 2, button: 'right' }))
      .toMatchObject({ clickCount: 2, button: 'right' });
    const hover = one({ action: 'hover', selector: '#b', clickCount: 2, button: 'right' });
    expect(hover.clickCount).toBeUndefined();
    expect(hover.button).toBeUndefined();
    // A plain click carries neither, so it is exactly the action it always was.
    expect(one({ action: 'click', selector: '#b' })).toEqual({ action: 'click', selector: '#b', description: 'x' });
  });
});

describe('§2.2 double-click and right-click — the executor', () => {
  it('double-clicks, and right-clicks, and a plain click is still one left click', async () => {
    const page = await pageWith(`
      <button id="b">B</button><p id="out"></p>
      <script>
        const b = document.getElementById('b'), out = document.getElementById('out');
        b.addEventListener('click', () => out.textContent += 'click;');
        b.addEventListener('dblclick', () => out.textContent += 'dbl;');
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); out.textContent += 'menu;'; });
      </script>`);
    expect((await executeAction(page, act({ action: 'click', selector: '#b', clickCount: 2 }))).success).toBe(true);
    expect(await page.textContent('#out')).toContain('dbl;');
    await page.evaluate(() => { document.getElementById('out')!.textContent = ''; });
    expect((await executeAction(page, act({ action: 'click', selector: '#b', button: 'right' }))).success).toBe(true);
    expect(await page.textContent('#out')).toBe('menu;');
    await page.evaluate(() => { document.getElementById('out')!.textContent = ''; });
    expect((await executeAction(page, act({ action: 'click', selector: '#b' }))).success).toBe(true);
    expect(await page.textContent('#out')).toBe('click;');
    await page.close();
  });
});

describe('§2.3 typing fires key events', () => {
  it('a filter that listens for keyup sees the typed text', async () => {
    const page = await pageWith(`
      <input id="filter"><ul><li>Testing</li><li>Development</li><li>Content</li></ul>
      <script>
        document.getElementById('filter').addEventListener('keyup', (e) => {
          const q = e.target.value.toLowerCase();
          for (const li of document.querySelectorAll('li')) li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      </script>`);
    expect((await executeAction(page, act({ action: 'type', selector: '#filter', value: 'test' }))).success).toBe(true);
    expect(await page.inputValue('#filter')).toBe('test');
    expect(await page.locator('li:visible').count()).toBe(1);
    await page.close();
  });
});

describe('§2.4 count counts what is shown', () => {
  it('counts visible matches, every match with includeHidden, and every option of a closed select', async () => {
    const page = await pageWith(`
      <ul><li>a</li><li style="display:none">b</li><li>c</li></ul>
      <select id="s"><option>1</option><option>2</option><option>3</option></select>`);
    const visible = await executeAction(page, act({ action: 'count', selector: 'li', as: 'n' }));
    expect(visible.capturedValue).toBe('2');
    const all = await executeAction(page, act({ action: 'count', selector: 'li', as: 'n', includeHidden: true }));
    expect(all.capturedValue).toBe('3');
    const options = await executeAction(page, act({ action: 'count', selector: '#s option', as: 'n' }));
    expect(options.capturedValue).toBe('3');
    await page.close();
  });

  it('parses includeHidden on a count only', () => {
    expect(one({ action: 'count', selector: 'li', as: 'n', includeHidden: true }).includeHidden).toBe(true);
    expect(one({ action: 'read', selector: 'li', as: 'n', includeHidden: true }).includeHidden).toBeUndefined();
  });
});

describe('§2.5 ads that block clicks', () => {
  it('hides an ad sitting over the target and clicks again', async () => {
    const page = await pageWith(`
      <button id="go" style="position:absolute;top:40px;left:40px;width:200px;height:40px">Register</button>
      <p id="out"></p>
      <ins class="adsbygoogle" style="position:fixed;top:0;left:0;width:100%;height:200px;display:block;z-index:9">
        <iframe id="aswift_1" title="Advertisement" style="width:100%;height:200px;border:0"></iframe>
      </ins>
      <script>document.getElementById('go').onclick = () => document.getElementById('out').textContent = 'clicked';</script>`);
    const result = await executeAction(page, act({ action: 'click', selector: '#go' }), undefined, undefined);
    expect(result.success).toBe(true);
    expect(await page.textContent('#out')).toBe('clicked');
    await page.close();
  }, 30_000);

  it('still fails a click blocked by something that is not an ad', async () => {
    const page = await pageWith(`
      <button id="go" style="position:absolute;top:40px;left:40px">Register</button>
      <div id="modal" style="position:fixed;inset:0;z-index:9;background:#0003"></div>`);
    const result = await executeAction(page, act({ action: 'click', selector: '#go' }));
    expect(result.success).toBe(false);
    expect(await page.locator('#modal').isVisible()).toBe(true);
    await page.close();
  }, 30_000);

  it('recognises ad hosts by suffix, and nothing else', () => {
    expect(isAdRequest('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')).toBe(true);
    expect(isAdRequest('https://securepubads.g.doubleclick.net/tag/js/gpt.js')).toBe(true);
    expect(isAdRequest('https://www.google.com/search?q=doubleclick.net')).toBe(false);
    expect(isAdRequest('https://notdoubleclick.net/')).toBe(false);
    expect(isAdRequest('not a url')).toBe(false);
  });
});

describe('§2.6 key names', () => {
  it('maps what a step or a model writes to Playwright\'s spelling', () => {
    expect(normaliseKeyName('END')).toBe('End');
    expect(normaliseKeyName('end')).toBe('End');
    expect(normaliseKeyName('CTRL+A')).toBe('Control+A');
    expect(normaliseKeyName('ctrl+shift+tab')).toBe('Control+Shift+Tab');
    expect(normaliseKeyName('Control+a')).toBe('Control+a');
    expect(normaliseKeyName('esc')).toBe('Escape');
    expect(normaliseKeyName('f5')).toBe('F5');
    expect(normaliseKeyName('PgDn')).toBe('PageDown');
    expect(normaliseKeyName('Control++')).toBe('Control++');
    expect(normaliseKeyName('a')).toBe('a');
    expect(normaliseKeyName('A')).toBe('A');
    // Unknown keys are kept, so Playwright names them in its own error.
    expect(normaliseKeyName('Banana')).toBe('Banana');
  });

  it('presses END and CTRL+A, which Playwright refuses as written', async () => {
    const page = await pageWith(`<input id="i" value="hello world">`);
    await page.focus('#i');
    expect((await executeAction(page, act({ action: 'keyboard', key: 'CTRL+A' }))).success).toBe(true);
    expect((await executeAction(page, act({ action: 'keypress', key: 'END' }))).success).toBe(true);
    await page.close();
  });
});

describe('§2.7 inputs that cannot be cleared', () => {
  it('normalises colour values', () => {
    expect(normaliseColour('#00FF00')).toBe('#00ff00');
    expect(normaliseColour('f00')).toBe('#ff0000');
    expect(normaliseColour('red')).toBe('red');
  });

  it('types into colour and range inputs', async () => {
    const page = await pageWith(`<input id="c" type="color" value="#563d7c"><input id="r" type="range" min="0" max="10" value="5">`);
    expect((await executeAction(page, act({ action: 'type', selector: '#c', value: '#00FF00' }))).success).toBe(true);
    expect(await page.inputValue('#c')).toBe('#00ff00');
    expect((await executeAction(page, act({ action: 'type', selector: '#r', value: '10' }))).success).toBe(true);
    expect(await page.inputValue('#r')).toBe('10');
    await page.close();
  });
});

describe('§2.8 multi-selects', () => {
  it('selects several options by label or value, from values or from a comma list', async () => {
    const page = await pageWith(`
      <select id="m" multiple><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option></select>
      <select id="s"><option>Washington, DC</option><option>Other</option></select>`);
    const selected = () => page.$eval('#m', (el) => Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.value));
    expect((await executeAction(page, act({ action: 'select', selector: '#m', values: ['Red', 'Green'] }))).success).toBe(true);
    expect(await selected()).toEqual(['red', 'green']);
    expect((await executeAction(page, act({ action: 'select', selector: '#m', value: 'blue, Red' }))).success).toBe(true);
    expect(await selected()).toEqual(['red', 'blue']);
    // A single select is never split on its comma.
    expect((await executeAction(page, act({ action: 'select', selector: '#s', value: 'Washington, DC' }))).success).toBe(true);
    expect(await page.inputValue('#s')).toBe('Washington, DC');
    const missing = await executeAction(page, act({ action: 'select', selector: '#m', values: ['Red', 'Purple'] }));
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('"Purple"');
    await page.close();
  });

  it('parses values on a select only', () => {
    expect(one({ action: 'select', selector: '#m', values: ['Red', '', 'Green', 3] }).values).toEqual(['Red', 'Green']);
    expect(one({ action: 'type', selector: '#m', values: ['Red'] }).values).toBeUndefined();
  });
});

describe('§2.9 stepped drag', () => {
  it('drives a drag library that needs the pointer to travel, not jump', async () => {
    const page = await pageWith(`
      <div id="card" style="position:absolute;top:20px;left:20px;width:60px;height:40px;background:#ccc">card</div>
      <div id="bin" style="position:absolute;top:20px;left:400px;width:100px;height:100px;border:1px solid">bin</div>
      <p id="out" style="position:absolute;top:200px"></p>
      <script>
        // Like jQuery UI: a drag starts only after the pointer has moved, and
        // the drop is judged from where the moves ended.
        let down = false, moves = 0, x = 0;
        const card = document.getElementById('card');
        card.addEventListener('mousedown', () => { down = true; moves = 0; });
        document.addEventListener('mousemove', (e) => { if (down) { moves++; x = e.clientX; } });
        document.addEventListener('mouseup', () => {
          if (down && moves > 3 && x > 400) document.getElementById('out').textContent = 'dropped';
          down = false;
        });
      </script>`);
    const result = await executeAction(page, act({ action: 'drag', selector: '#card', target: '#bin' }));
    expect(result.success).toBe(true);
    expect(await page.textContent('#out')).toBe('dropped');
    await page.close();
  });
});

describe('§2.10 styled checkboxes and radios', () => {
  it('clicks the label of a hidden checkbox', async () => {
    const page = await pageWith(`
      <input type="checkbox" id="ajax" aria-label="Ajax" style="display:none">
      <label for="ajax">Ajax</label>`);
    const result = await executeAction(page, act({ action: 'click', selector: '[aria-label="Ajax"]' }));
    expect(result.success).toBe(true);
    expect(await page.isChecked('#ajax')).toBe(true);
    await page.close();
  });

  it('clicks the visible box around a hidden checkbox that has no label', async () => {
    const page = await pageWith(`
      <div class="ui-chkbox" id="box" style="width:20px;height:20px;border:1px solid">
        <div style="display:none"><input type="checkbox" id="basic" aria-label="Basic"></div>
      </div>
      <script>document.getElementById('box').onclick = () => { const c = document.getElementById('basic'); c.checked = !c.checked; };</script>`);
    const result = await executeAction(page, act({ action: 'click', selector: '[aria-label="Basic"]' }));
    expect(result.success).toBe(true);
    expect(await page.isChecked('#basic')).toBe(true);
    await page.close();
  });
});

describe('§2.11 text reads skip script source', () => {
  it('reads a container without its script', async () => {
    const page = await pageWith(`<div id="creds">Username: demo_user<script>var key = 'SECRET';</script> Password: pass</div>`);
    const result = await executeAction(page, act({ action: 'read', selector: '#creds', as: 'creds' }));
    expect(result.capturedValue).toBe('Username: demo_user Password: pass');
    await page.close();
  });
});

describe('§2.13 numeric attribute waits', () => {
  it('waits until a moving value passes a threshold it never equals', async () => {
    const page = await pageWith(`
      <div id="bar" role="progressbar" aria-valuenow="25"></div>
      <script>
        let v = 25;
        const t = setInterval(() => { v += 7; document.getElementById('bar').setAttribute('aria-valuenow', String(v)); if (v > 90) clearInterval(t); }, 50);
      </script>`);
    const result = await executeAction(
      page,
      act({ action: 'wait', waitType: 'attribute', selector: '#bar', expected: 'aria-valuenow>=75', timeout: 5000 }),
    );
    expect(result.success).toBe(true);
    const now = Number(await page.getAttribute('#bar', 'aria-valuenow'));
    expect(now).toBeGreaterThanOrEqual(75);
    await page.close();
  });
});

describe('§2.1 browser dialogs', () => {
  it('parses every spelling of "answer the dialog" into one action', () => {
    expect(one({ action: 'accept_dialog' })).toMatchObject({ action: 'dialog', value: 'accept' });
    expect(one({ action: 'acceptAlert' })).toMatchObject({ action: 'dialog', value: 'accept' });
    expect(one({ action: 'dismissDialog' })).toMatchObject({ action: 'dialog', value: 'dismiss' });
    expect(one({ action: 'handleDialog', value: 'cancel' })).toMatchObject({ action: 'dialog', value: 'dismiss' });
    expect(one({ action: 'dialog', value: 'accept', promptText: 'Steptix' })).toMatchObject({ action: 'dialog', value: 'accept', text: 'Steptix' });
    expect(one({ action: 'dialog' })).toMatchObject({ value: 'accept' });
    // `text` is a dialog's field only.
    expect(one({ action: 'click', selector: '#b', text: 'x' }).text).toBeUndefined();
  });

  const DIALOGS = `
    <button id="prompt">prompt</button><button id="confirm">confirm</button><p id="out"></p>
    <script>
      const out = document.getElementById('out');
      document.getElementById('prompt').onclick = () => { out.textContent = 'prompt:' + prompt('Your name?'); };
      document.getElementById('confirm').onclick = () => { out.textContent = 'confirm:' + confirm('Sure?'); };
    </script>`;

  it('answers the next dialog as armed: a prompt with text, and the default after that', async () => {
    const page = await pageWith(DIALOGS);
    expect((await executeAction(page, act({ action: 'dialog', value: 'accept', text: 'Steptix' }))).success).toBe(true);
    await executeAction(page, act({ action: 'click', selector: '#prompt' }));
    await expect.poll(() => page.textContent('#out')).toBe('prompt:Steptix');
    // Used once: the next prompt gets the default, which dismisses it.
    await executeAction(page, act({ action: 'click', selector: '#prompt' }));
    await expect.poll(() => page.textContent('#out')).toBe('prompt:null');
    await page.close();
  });

  it('accepts a confirm when armed, and records what every dialog said', async () => {
    const page = await pageWith(DIALOGS);
    await executeAction(page, act({ action: 'dialog', value: 'accept' }));
    await executeAction(page, act({ action: 'click', selector: '#confirm' }));
    await expect.poll(() => page.textContent('#out')).toBe('confirm:true');
    const last = dialogRecords(context).at(-1)!;
    expect(last).toMatchObject({ type: 'confirm', message: 'Sure?', answer: 'accepted', armed: true });
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __steptixDialogs?: Array<{ message: string }> })
      .__steptixDialogs?.at(-1)?.message)).toBe('Sure?');
    await page.close();
  });

  it('says so when the dialog was already answered the other way, then answers the next one as asked', async () => {
    const page = await pageWith(DIALOGS);
    await executeAction(page, act({ action: 'click', selector: '#confirm' }));
    await expect.poll(() => page.textContent('#out')).toBe('confirm:false');
    const late = await executeAction(page, act({ action: 'dialog', value: 'accept' }));
    expect(late.success).toBe(false);
    expect(late.error).toContain('already answered');
    // The answer is set anyway, so opening it again now works…
    await executeAction(page, act({ action: 'click', selector: '#confirm' }));
    await expect.poll(() => page.textContent('#out')).toBe('confirm:true');
    // …and the old dialog is not reported twice.
    await executeAction(page, act({ action: 'click', selector: '#confirm' }));
    await expect.poll(() => page.textContent('#out')).toBe('confirm:false');
    disarmDialog(context);
    await page.close();
  });

  it('shows the dialogs in the next snapshot, once', async () => {
    const page = await pageWith(DIALOGS);
    await captureDomSnapshot(page); // drain anything earlier tests left
    await executeAction(page, act({ action: 'click', selector: '#confirm' }));
    await expect.poll(() => page.textContent('#out')).toBe('confirm:false');
    const first = await captureDomSnapshot(page);
    expect(first).toContain('[confirm] "Sure?" — dismissed by default');
    const second = await captureDomSnapshot(page);
    expect(second).not.toContain('Browser dialogs');
    await page.close();
  });
});
