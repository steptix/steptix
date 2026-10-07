/**
 * The framework fixes the web survey found (docs/specs/SPEC-web-survey-fixes.md).
 *
 * Each `describe` is one section of that spec, and each executor test drives a
 * real Chromium page built to fail the way the survey's site did: a filter that
 * listens for `keyup`, a list a filter hides rather than removes, a drag
 * library that ignores a single jump, a checkbox whose `<input>` is hidden, an
 * ad over a button, a prompt dialog.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { executeAction, normaliseColour, normaliseKeyName, scrollToFitBoth, waitForThreshold } from '../src/browser/actions.js';
import { parseAIResponse, parseAssertionCode } from '../src/ai/action-parser.js';
import { installDialogGuard, isAdRequest } from '../src/browser/manager.js';
import { dialogRecords, disarmDialog } from '../src/browser/dialogs.js';
import { installNoticeRecorder } from '../src/browser/notices.js';
import { captureDomSnapshot, findInDom, formatFindResults } from '../src/browser/dom-cleaner.js';
import { describeWhereExpectedIs, expectedFragments } from '../src/browser/locate-text.js';
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

  it('clamps a range value to the slider\'s own ends, and reads max and min as words', async () => {
    const page = await pageWith(`<input id="r" type="range" min="0" max="10" value="5">`);
    expect((await executeAction(page, act({ action: 'type', selector: '#r', value: '100' }))).success).toBe(true);
    expect(await page.inputValue('#r')).toBe('10');
    expect((await executeAction(page, act({ action: 'type', selector: '#r', value: 'minimum' }))).success).toBe(true);
    expect(await page.inputValue('#r')).toBe('0');
    expect((await executeAction(page, act({ action: 'type', selector: '#r', value: 'max' }))).success).toBe(true);
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

describe('§2.14 assertion replies in the wrong shape', () => {
  it('takes the code from a {"code"} reply, from inside an actions reply, or from a js fence', () => {
    const code = '(() => ({ pass: true, actual: "22" }))()';
    expect(parseAssertionCode(JSON.stringify({ code }))).toBe(code);
    expect(parseAssertionCode(JSON.stringify({ actions: [{ action: 'assert', code }], reasoning: 'x' }))).toBe(code);
    expect(parseAssertionCode('Here it is:\n```js\n' + code + '\n```')).toBe(code);
  });

  it('still refuses a reply with no code anywhere', () => {
    expect(() => parseAssertionCode(JSON.stringify({ actions: [{ action: 'assert', condition: 'x' }] })))
      .toThrow('missing "code" field');
    expect(() => parseAssertionCode('no json and no fence')).toThrow('Assertion code response is not valid JSON');
  });
});

describe('§2.18 textless elements keep a readable class', () => {
  it('names empty draggables and an empty toggle by class, and drops hashed classes', async () => {
    const page = await pageWith(`
      <div id="source"><div draggable="true" class="red"></div><div draggable="true" class="green sc-bdVaJa2"></div></div>
      <div role="treeitem"><span class="rc-tree-switcher rc-tree-switcher_close"></span><span>Home</span></div>
      <p class="lead">Has text, so no class is needed</p>`);
    const snapshot = await captureDomSnapshot(page);
    expect(snapshot).toContain('<div draggable="true" class="red">');
    expect(snapshot).toContain('<div draggable="true" class="green">');
    expect(snapshot).not.toContain('sc-bdVaJa2');
    expect(snapshot).toContain('class="rc-tree-switcher rc-tree-switcher_close"');
    expect(snapshot).not.toContain('class="lead"');
    await page.close();
  });
});

describe('§2.19 a drag whose target starts below the screen', () => {
  it('centres the two boxes when they fit together, and gives up when they do not', () => {
    const viewport = { width: 800, height: 600 };
    expect(scrollToFitBoth(
      { x: 300, y: 570, width: 60, height: 60 },
      { x: 200, y: 560, width: 120, height: 200 },
      viewport,
    )).toEqual({ dx: -120, dy: 360 });
    // Already centred: nothing to do.
    expect(scrollToFitBoth({ x: 370, y: 270, width: 60, height: 60 }, { x: 370, y: 270, width: 60, height: 60 }, viewport))
      .toBeNull();
    // Further apart than one screen: no scroll shows both.
    expect(scrollToFitBoth({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 900, width: 10, height: 10 }, viewport))
      .toBeNull();
  });

  // A headed launch and every CDP page have no pinned viewport, so
  // `viewportSize()` is null there — the case the survey's run actually hit.
  it.each([
    ['a pinned viewport', { width: 800, height: 600 }],
    ['no pinned viewport', null],
  ] as const)('drops an HTML5 draggable onto a target that was off-screen when the drag began, with %s', async (_, viewport) => {
    const own = await browser.newContext({ viewport });
    const page = await own.newPage();
    await page.setContent(`<!doctype html><html><body>
      <div style="height: 520px"></div>
      <div id="source"><div id="red" draggable="true" style="width: 60px; height: 60px; background: red"></div></div>
      <div id="target" style="width: 120px; height: 200px; border: 3px solid #333"></div>
      <div style="height: 1200px"></div>
      <script>
        document.querySelector('#red').addEventListener('dragstart', (e) => e.dataTransfer.setData('text', 'red'));
        const target = document.querySelector('#target');
        target.addEventListener('dragover', (e) => e.preventDefault());
        target.addEventListener('drop', (e) => {
          e.preventDefault();
          target.appendChild(document.getElementById(e.dataTransfer.getData('text')));
        });
      </script></body></html>`);
    try {
      const height = await page.evaluate(() => innerHeight);
      // Start the source just inside the bottom edge, with the target below it.
      await page.evaluate((h) => { document.body.firstElementChild!.setAttribute('style', `height: ${h - 80}px`); }, height);
      const result = await executeAction(page, act({ action: 'drag', selector: '#red', target: '#target' }));
      expect(result.success).toBe(true);
      expect(await page.locator('#target #red').count()).toBe(1);
    } finally {
      await own.close();
    }
  });
});

describe('§2.20 typing into a field something covers', () => {
  it('scrolls the field clear first, so a page that checks keeps the text', async () => {
    // The shape of uitestingplayground.com/overlapped: a field in a short
    // scrolling box, half under a panel, and an input handler that empties the
    // field when anything covers its centre.
    const page = await pageWith(`
      <div style="position: relative">
        <div style="overflow-y: scroll; height: 100px">
          <input id="id" placeholder="Id"><br><br>
          <input id="name" placeholder="Name"><br><br>
          <input id="subject" placeholder="Subject">
        </div>
        <div style="position: absolute; width: 300px; height: 50px; background: #ccc; top: 67px"></div>
      </div>
      <script>
        const name = document.querySelector('#name');
        name.addEventListener('input', () => {
          const r = name.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit !== name) name.value = '';
        });
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'type', selector: '#name', value: 'Survey' }));
      expect(result.success).toBe(true);
      expect(await page.inputValue('#name')).toBe('Survey');
    } finally {
      await page.close();
    }
  });
});

describe('§2.21 a threshold wait keeps going while the value moves', () => {
  // A fake clock: `sleep` advances it, and the reader computes the value from
  // it, so no test waits on real time.
  function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  }

  it('waits past its timeout for a bar that is still climbing, and stops when it passes', async () => {
    const c = clock();
    // 1% every 300 ms: 75% at 22.5 s, more than twice the 10 s timeout.
    const read = async (): Promise<number> => Math.floor(c.now() / 300);
    await waitForThreshold({ read, op: '>=', limit: 75, idleMs: 10_000, maxMs: 600_000, what: 'bar', ...c });
    expect(await read()).toBe(75);
  });

  it('fails after the timeout when the value stands still, naming how far it got', async () => {
    const c = clock();
    await expect(waitForThreshold({
      read: async () => 42, op: '>=', limit: 75, idleMs: 10_000, maxMs: 600_000, what: 'bar', ...c,
    })).rejects.toThrow(/no further than 42.*10000ms/);
    expect(c.now()).toBe(10_000);
  });

  it('does not count movement away from the limit as progress', async () => {
    const c = clock();
    await expect(waitForThreshold({
      read: async () => 50 - Math.floor(c.now() / 300), op: '>=', limit: 75, idleMs: 10_000, maxMs: 600_000, what: 'bar', ...c,
    })).rejects.toThrow(/no further than 50/);
    expect(c.now()).toBe(10_000);
  });

  it('stops at the ceiling however steadily the value moves', async () => {
    const c = clock();
    await expect(waitForThreshold({
      read: async () => c.now() / 1000, op: '>=', limit: 1e9, idleMs: 10_000, maxMs: 60_000, what: 'bar', ...c,
    })).rejects.toThrow(/Timeout/);
    expect(c.now()).toBe(60_000);
  });

  it('waits for a value to fall below a limit, and for an element that is not there yet', async () => {
    const c = clock();
    await waitForThreshold({
      read: async () => (c.now() < 2_000 ? null : 100 - Math.floor(c.now() / 200)),
      op: '<', limit: 10, idleMs: 10_000, maxMs: 600_000, what: 'countdown', ...c,
    });
    expect(100 - Math.floor(c.now() / 200)).toBeLessThan(10);
  });
});

describe('§2.22 a drag whose source an ad covers', () => {
  it('hides the ad and drags, rather than pressing on the ad', async () => {
    const page = await pageWith(`
      <div id="red" draggable="true" style="width: 60px; height: 60px; background: red"></div>
      <div id="target" style="width: 120px; height: 120px; border: 3px solid #333; margin-top: 40px"></div>
      <iframe id="aswift_1" title="Advertisement" style="position: fixed; left: 0; top: 0; width: 200px; height: 80px; border: 0"></iframe>
      <script>
        document.querySelector('#red').addEventListener('dragstart', (e) => e.dataTransfer.setData('text', 'red'));
        const target = document.querySelector('#target');
        target.addEventListener('dragover', (e) => e.preventDefault());
        target.addEventListener('drop', (e) => {
          e.preventDefault();
          target.appendChild(document.getElementById(e.dataTransfer.getData('text')));
        });
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'drag', selector: '#red', target: '#target' }));
      expect(result.success).toBe(true);
      expect(await page.locator('#target #red').count()).toBe(1);
      expect(await page.locator('#aswift_1').isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });
});

describe('§2.24 press and hold', () => {
  it('reads a long press as a click held down, 2 s unless the model says how long', () => {
    expect(one({ action: 'longPress', selector: '#b' })).toMatchObject({ action: 'click', holdMs: 2000 });
    expect(one({ action: 'press_and_hold', selector: '#b' })).toMatchObject({ action: 'click', holdMs: 2000 });
    expect(one({ action: 'clickAndHold', selector: '#b', holdMs: 3500 })).toMatchObject({ action: 'click', holdMs: 3500 });
    expect(one({ action: 'click', selector: '#b', holdMs: 1500 })).toMatchObject({ action: 'click', holdMs: 1500 });
    // A hold no person would make is clamped, and nonsense is dropped.
    expect(one({ action: 'click', selector: '#b', holdMs: 600_000 }).holdMs).toBe(30_000);
    expect(one({ action: 'click', selector: '#b', holdMs: 'long' }).holdMs).toBeUndefined();
    // Only a click holds.
    expect(one({ action: 'hover', selector: '#b', holdMs: 1500 }).holdMs).toBeUndefined();
  });

  it('keeps the button down for the hold before releasing', async () => {
    // The page times the press itself; the only claim is a lower bound, which a
    // slow machine can only make longer.
    const page = await pageWith(`
      <button id="hold">Hold!</button><p id="out"></p>
      <script>
        let down = 0;
        const b = document.getElementById('hold');
        b.addEventListener('mousedown', () => { down = performance.now(); });
        b.addEventListener('mouseup', () => {
          document.getElementById('out').textContent = performance.now() - down >= 1000 ? 'held' : 'tapped';
        });
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: '#hold', holdMs: 1200 }));
      expect(result.success).toBe(true);
      expect(await page.textContent('#out')).toBe('held');
    } finally {
      await page.close();
    }
  });
});

describe('§2.25 a failed check says where the expected text is', () => {
  it('splits an expected value into the pieces worth looking for', () => {
    expect(expectedFragments('username: survey; comments: Steptix survey')).toEqual([
      'username: survey; comments: Steptix survey',
      'survey',
      'Steptix survey',
      'username: survey',
      'comments: Steptix survey',
    ].slice(0, 4));
    expect(expectedFragments('true')).toEqual([]);
    expect(expectedFragments(undefined)).toEqual([]);
    expect(expectedFragments('"Red" and "Green"')).toEqual(['"Red" and "Green"', 'Red', 'Green']);
  });

  it('points at the results, not at the empty copy of the form above them', async () => {
    // The shape of testpages.eviltester.com's form results page.
    const page = await pageWith(`
      <form><textarea name="comments">Comments...</textarea><input name="username"></form>
      <div id="_username"><p><strong>username</strong></p><ul><li id="_valueusername">survey</li></ul></div>
      <div id="_comments"><p><strong>comments</strong></p><ul><li id="_valuecomments">Steptix survey</li></ul></div>
      <div style="display: none"><span>Steptix survey</span></div>`);
    try {
      const where = await describeWhereExpectedIs(page, 'survey; Steptix survey');
      expect(where).toContain('"Steptix survey" at li#_valuecomments');
      expect(where).toContain('li#_valueusername');
      // A hidden copy is not somewhere the step could mean.
      expect(where).not.toContain('span');
      expect(await describeWhereExpectedIs(page, 'Nowhere to be found')).toBe('');
    } finally {
      await page.close();
    }
  });
});

describe('§2.26 open shadow roots are in the snapshot', () => {
  it('shows a field inside an open root, marks where the root is, and leaves a closed one out', async () => {
    const page = await pageWith(`
      <div id="open-shadow"></div>
      <closed-thing></closed-thing>
      <iframe id="light" srcdoc="<p>light frame</p>"></iframe>
      <script>
        document.getElementById('open-shadow').attachShadow({ mode: 'open' }).innerHTML =
          '<label for="fname">First name</label><input id="fname"><iframe srcdoc="<p>shadow frame</p>"></iframe>';
        document.querySelector('closed-thing').attachShadow({ mode: 'closed' }).innerHTML = '<input id="lname">';
      </script>`);
    try {
      await page.waitForFunction(() => document.querySelectorAll('iframe').length === 1);
      await page.frameLocator('#light').locator('p').waitFor();
      const snap = await captureDomSnapshot(page);
      expect(snap).toMatch(/<div id="open-shadow">\s*<!-- shadow-root \(open\) -->[\s\S]*<input id="fname">[\s\S]*<!-- \/shadow-root -->/);
      expect(snap).not.toContain('lname');
      // The frame inside the root is shown, not expanded; the light-DOM frame
      // still gets its own content, so the frame indices did not shift.
      expect(snap).toContain('inside a shadow root: contents not captured');
      expect(snap).toContain('light frame');
      expect(snap).not.toContain('shadow frame');
      // And the selector the snapshot suggests works as an action selector.
      const result = await executeAction(page, act({ action: 'type', selector: '#fname', value: 'Survey' }));
      expect(result.success).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('§2.27 typing where fill cannot', () => {
  it('clicks a custom element and types into the field in its closed shadow root', async () => {
    const page = await pageWith(`
      <my-web-component style="display: block; width: 300px"></my-web-component>
      <script>
        const root = document.querySelector('my-web-component').attachShadow({ mode: 'closed' });
        root.innerHTML = '<input id="lname" style="width: 290px">';
        window.__lname = () => root.getElementById('lname').value;
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'type', selector: 'my-web-component', value: 'Tester' }));
      expect(result.success).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __lname: () => string }).__lname())).toBe('Tester');
    } finally {
      await page.close();
    }
  });

  it('types text into whatever has focus with keyboard "text"', async () => {
    expect(one({ action: 'keyboard', text: 'Tester' })).toMatchObject({ action: 'keyboard', text: 'Tester' });
    const page = await pageWith('<input id="f">');
    try {
      await page.focus('#f');
      const result = await executeAction(page, act({ action: 'keyboard', text: 'Tester' }));
      expect(result.success).toBe(true);
      expect(await page.inputValue('#f')).toBe('Tester');
    } finally {
      await page.close();
    }
  });
});

describe('§2.28 find says which collapsed sections hide a match', () => {
  it('names the sections to open, outermost first, and says nothing for a visible match', async () => {
    // The shape of a Docsy sidebar: LI > label + a folded UL, two levels deep.
    const page = await pageWith(`
      <ul>
        <li><label>Challenges</label>
          <ul style="display: none">
            <li><label>Synchronization</label>
              <ul style="display: none"><li><a href="/dyn1">Dynamic Buttons 01</a></li></ul>
            </li>
          </ul>
        </li>
      </ul>
      <p>Dynamic Buttons 01 is a challenge</p>`);
    try {
      const out = formatFindResults(await findInDom(page, 'Dynamic Buttons 01'), 'Dynamic Buttons 01');
      expect(out).toContain('hidden — inside collapsed: Challenges › Synchronization');
      const [hiddenLine, visibleLine] = out.split(/\n(?=\d+\. )/).slice(1);
      expect(hiddenLine).toContain('<a href="/dyn1">');
      expect(visibleLine).toContain('<p>');
      expect(visibleLine).not.toContain('hidden');
    } finally {
      await page.close();
    }
  });
});

describe('§2.29 a text wait inside a frame', () => {
  it('waits for the text in the frame the action names', async () => {
    const page = await pageWith(`<iframe id="demo" srcdoc="<p id='s'>Downloading...</p>"></iframe>`);
    try {
      await page.frameLocator('#demo').locator('#s').waitFor();
      // The frame says it only after the wait has begun.
      const waiting = executeAction(page, act({ action: 'wait', waitType: 'text', condition: 'Complete!', frame: '#demo' }));
      await page.frameLocator('#demo').locator('#s').evaluate((el) => { el.textContent = 'Complete!'; });
      expect((await waiting).success).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('§2.31 a check inside an iframe', () => {
  it('runs the check\'s code in the frame the assert names', async () => {
    const { executeStep } = await import('../src/runner/step-executor.js');
    const { DEFAULT_BROWSER_DIMENSIONS } = await import('../src/config/browser-dimensions.js');
    const page = await pageWith(`<iframe id="myFrame3" srcdoc="<input type='checkbox' id='cb' checked>"></iframe>`);
    try {
      await page.frameLocator('#myFrame3').locator('#cb').waitFor();
      const stepReply = JSON.stringify({
        actions: [{ action: 'assert', frame: '#myFrame3', condition: 'the checkbox is ticked', expected: 'checked', description: 'Checkbox in the frame is ticked' }],
        reasoning: 'Check the box inside the frame.',
      });
      // Plain document.querySelector: it finds #cb only when run inside the frame.
      const codeReply = JSON.stringify({ code: "(() => { const el = document.querySelector('#cb'); return el ? { pass: el.checked, actual: el.checked ? 'checked' : 'unchecked' } : { pass: false, actual: 'element not found: #cb' }; })()" });
      let call = 0;
      const aiClient = { complete: vi.fn(() => Promise.resolve({ text: call++ % 2 === 0 ? stepReply : codeReply, model: 'test' })) };
      const result = await executeStep(1, 1, 'Verify the checkbox inside the iframe is ticked', {
        page,
        config: {
          ai: { gatewayUrl: '', model: 'test', maxInputTokens: 1000, streamResponses: false },
          browser: { headed: false, viewport: { ...DEFAULT_BROWSER_DIMENSIONS }, windowSize: { ...DEFAULT_BROWSER_DIMENSIONS }, slowMo: 0, browser: 'chromium', fullPageScreenshots: false },
          tests: { dir: '.', contextDir: '.', pattern: '**/*.md' },
          execution: { timeout: 30000, retries: 0, screenshotOnFailure: false, promptOnAmbiguity: false, maxTurns: 3 },
          reports: { outputDir: '.', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: true },
          api: { specsDir: '.', requestTimeout: 5000, redactSensitive: false },
        } as never,
        aiClient: aiClient as never,
        contextContent: '',
        testName: 'test',
        conversationHistory: [],
        csrfTokens: {},
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('passed');
    } finally {
      await page.close();
    }
  });
});

describe('§2.32 a stand-in click skips the 1px wrapper', () => {
  it('clicks the toggle\'s visible container, not the clip wrapper around its input', async () => {
    // PrimeFaces' checkbox: the input sits in a 1×1 px clipped wrapper, and a
    // sibling box covering it is what takes the click.
    const page = await pageWith(`
      <div class="ui-chkbox" id="wrap" style="position: relative; display: inline-block; padding: 4px"
           onclick="const c = document.getElementById('cb'); c.checked = !c.checked">
        <div class="ui-helper-hidden-accessible" style="position: absolute; top: 12px; left: 12px; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">
          <input type="checkbox" id="cb" aria-label="Ajax" style="width: 0; height: 0; margin: 0; border: 0; padding: 0">
        </div>
        <div class="ui-chkbox-box" style="position: relative; z-index: 1; width: 20px; height: 20px; border: 1px solid #333; background: #fff"></div>
      </div>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'input[aria-label="Ajax"]' }));
      expect(result.success).toBe(true);
      expect(await page.isChecked('#cb')).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('§2.33 notifications that close are remembered', () => {
  it('names a toast that has closed in the next snapshot, and leaves out one still shown', async () => {
    const own = await browser.newContext();
    await installNoticeRecorder(own);
    const page = await own.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>
        <div role="status" id="still">Connected</div>
        <button id="b" onclick="
          const t = document.createElement('div');
          t.className = 'ui-growl-item';
          t.textContent = 'Checked';
          document.body.appendChild(t);
          setTimeout(() => t.remove(), 50);
        ">Tick</button></body></html>`);
      await page.click('#b');
      await page.waitForFunction(() => !document.querySelector('.ui-growl-item'));
      const snap = await captureDomSnapshot(page);
      expect(snap).toContain('Notifications that appeared and have since closed');
      expect(snap).toMatch(/- "Checked" \(\d+ s ago\)/);
      expect(snap).not.toMatch(/- "Connected"/);
      expect(await page.evaluate(() => (window as unknown as { __steptixNotices: Array<{ text: string }> })
        .__steptixNotices.map((n) => n.text))).toEqual(expect.arrayContaining(['Checked', 'Connected']));
    } finally {
      await own.close();
    }
  });
});

describe('§2.34 role names with an icon glyph', () => {
  it('clicks the button whose accessible name carries an icon font glyph, and not a longer name', async () => {
    const page = await pageWith(`
      <style>.pi-check::before { content: "\\2714"; }</style>
      <button id="all" onclick="document.body.dataset.hit = 'all'">Dismiss all</button>
      <button id="one" onclick="document.body.dataset.hit = 'one'"><span class="pi-check"></span><span>Dismiss</span></button>`);
    try {
      expect(await page.locator('role=button[name="Dismiss"]').count()).toBe(0);
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Dismiss"]' }));
      expect(result.success).toBe(true);
      expect(await page.evaluate(() => document.body.dataset['hit'])).toBe('one');
    } finally {
      await page.close();
    }
  });
});
