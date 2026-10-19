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
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { executeAction, explainEnclosedToggle, hiddenToggleOf, normaliseColour, normaliseKeyName, resolveRoleName, scrollToFitBoth, waitForThreshold } from '../src/browser/actions.js';
import { parseAIResponse, parseAssertionCode } from '../src/ai/action-parser.js';
import { buildStepCodePrompt, buildSystemPrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { buildRepairPrompt } from '../src/codebehind/repair.js';
import { classifyOutcome } from '../src/stats/classify.js';
import { addLogCallback } from '../src/utils/logger.js';
import { installDialogGuard } from '../src/browser/manager.js';
import { dialogRecords, disarmDialog } from '../src/browser/dialogs.js';
import { installNoticeRecorder } from '../src/browser/notices.js';
import { captureDomSnapshot, findInDom, formatFindResults } from '../src/browser/dom-cleaner.js';
import { describeWhereExpectedIs, expectedFragments } from '../src/browser/locate-text.js';
import type { AIAction } from '../src/ai/types.js';
import { listenFetchable } from './listen-fetchable.cjs';

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

describe('§2.3 typing presses only the keys the step asks for', () => {
  /** A filter that reacts to keyup and nothing else, as the survey's two
   *  sites did, beside a log of every key the field receives. */
  const filterPage = (): Promise<Page> => pageWith(`
      <input id="filter"><ul><li>Testing</li><li>Development</li><li>Content</li></ul>
      <script>
        window.keys = [];
        const filter = document.getElementById('filter');
        for (const name of ['keydown', 'keyup']) filter.addEventListener(name, (e) => window.keys.push(name + ' ' + e.key));
        filter.addEventListener('keyup', (e) => {
          const q = e.target.value.toLowerCase();
          for (const li of document.querySelectorAll('li')) li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      </script>`);
  const keysOf = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { keys: string[] }).keys);
  /** Playwright's `clear()` is `fill('')`, which presses Delete to empty the
   *  field. It runs before any fill and is outside steptix/steptix#90. */
  const clearKeys = ['keydown Delete', 'keyup Delete'];

  // Changed on purpose (steptix/steptix#90). This test used to require that a
  // plain type make a keyup-only filter react, which the End pressed after the
  // fill did. End also set a spinbutton date segment to its maximum, and no
  // list of input types can say what a key does to a field. A plain type now
  // fills and presses nothing after the value; a step that needs the filter
  // to react asks for its text one character at a time (the next test).
  it('a plain type fills and presses no key after the value, so a keyup-only filter keeps every row', async () => {
    const page = await filterPage();
    const result = await executeAction(page, act({ action: 'type', selector: '#filter', value: 'test' }));
    expect(result.success).toBe(true);
    expect(result.typed).toBeUndefined();
    expect(await page.inputValue('#filter')).toBe('test');
    expect(await page.locator('li:visible').count()).toBe(3);
    expect(await keysOf(page)).toEqual(clearKeys);
    await page.close();
  });

  it('a sequential type presses each character, and the keyup-only filter sees the text', async () => {
    const page = await filterPage();
    const result = await executeAction(page, act({ action: 'type', selector: '#filter', value: 'test', sequential: true }));
    expect(result.success).toBe(true);
    expect(result.typed).toEqual({ by: 'keys' });
    expect(await page.inputValue('#filter')).toBe('test');
    expect(await page.locator('li:visible').allTextContents()).toEqual(['Testing']);
    expect(await keysOf(page)).toEqual([
      ...clearKeys,
      'keydown t', 'keyup t', 'keydown e', 'keyup e', 'keydown s', 'keyup s', 'keydown t', 'keyup t',
    ]);
    await page.close();
  });

  it('fills a date, time, colour or range input even when sequential, and says so', async () => {
    const values: Record<string, string> = {
      date: '2027-03-14', time: '10:30', 'datetime-local': '2027-03-14T10:30', month: '2027-03', week: '2027-W11',
      color: '#00ff00', range: '7',
    };
    const page = await pageWith(Object.keys(values).map((t) => `<input id="${t}" type="${t}">`).join(''));
    try {
      for (const [inputType, value] of Object.entries(values)) {
        const result = await executeAction(page, act({ action: 'type', selector: `#${inputType}`, value, sequential: true }));
        expect(result.success, inputType).toBe(true);
        expect(result.typed, inputType).toEqual({ by: 'fill', inputType });
        expect(await page.inputValue(`#${inputType}`), inputType).toBe(value);
      }
    } finally {
      await page.close();
    }
  });

  it('decides by the field a label stands for: keys into a text input, a fill into a date input', async () => {
    const page = await pageWith(`
      <label for="who">Who</label><input id="who">
      <label for="when">When</label><input id="when" type="date">`);
    try {
      const who = await executeAction(page, act({ action: 'type', selector: 'label[for="who"]', value: 'Ada', sequential: true }));
      expect(who.typed).toEqual({ by: 'keys' });
      expect(await page.inputValue('#who')).toBe('Ada');
      const when = await executeAction(page, act({ action: 'type', selector: 'label[for="when"]', value: '2027-03-14', sequential: true }));
      expect(when.typed).toEqual({ by: 'fill', inputType: 'date' });
      expect(await page.inputValue('#when')).toBe('2027-03-14');
    } finally {
      await page.close();
    }
  });

  it('into an element fill cannot reach, types on the keyboard as before, and says so only when asked (§2.27)', async () => {
    const page = await pageWith(`
      <x-field style="display: block; width: 300px"></x-field>
      <script>
        const root = document.querySelector('x-field').attachShadow({ mode: 'closed' });
        root.innerHTML = '<input style="width: 290px">';
        window.__value = () => root.querySelector('input').value;
      </script>`);
    try {
      const plain = await executeAction(page, act({ action: 'type', selector: 'x-field', value: 'Ada' }));
      expect(plain.success).toBe(true);
      expect(plain.typed).toBeUndefined();
      const keyed = await executeAction(page, act({ action: 'type', selector: 'x-field', value: 'Lin', sequential: true }));
      expect(keyed.typed).toEqual({ by: 'keys' });
      expect(await page.evaluate(() => (window as unknown as { __value: () => string }).__value())).toBe('Lin');
    } finally {
      await page.close();
    }
  });

  it('a sequential clear has no keys to press, so it is a plain one', async () => {
    const page = await filterPage();
    try {
      await page.fill('#filter', 'old');
      const result = await executeAction(page, act({ action: 'type', selector: '#filter', value: '', sequential: true }));
      expect(result.success).toBe(true);
      expect(result.typed).toBeUndefined();
      expect(await page.inputValue('#filter')).toBe('');
    } finally {
      await page.close();
    }
  });

  it('parses sequential on a type only, and only when it is true', () => {
    expect(one({ action: 'type', selector: '#f', value: 'x', sequential: true }).sequential).toBe(true);
    expect(one({ action: 'type', selector: '#f', value: 'x', sequential: 'true' }).sequential).toBeUndefined();
    expect(one({ action: 'type', selector: '#f', value: 'x', sequential: false }).sequential).toBeUndefined();
    expect(one({ action: 'click', selector: '#f', sequential: true }).sequential).toBeUndefined();
    // A plain type carries nothing new, so it is exactly the action it always was.
    expect(one({ action: 'type', selector: '#f', value: 'x' })).toEqual({ action: 'type', selector: '#f', value: 'x', description: 'x' });
  });

  // The model decides from the step's words, so what is pinned here is what
  // it is told: the flag for a step that asks to type key by key, the same
  // action without it for a step that does not, and never for a page that
  // merely looks live. The live suites check a real model follows it
  // (templates/init/tests/securebank-schedule-transfer.md).
  it('rule 10 sets sequential for a step that asks for key by key, and not for one that does not', () => {
    const text = contentBlocksToText(buildSystemPrompt(''));
    const rule = text.slice(text.indexOf('\n10. '), text.indexOf('\n10a. '));
    for (const words of ['one character at a time', 'each character in sequence', 'key by key']) {
      expect(rule).toContain(`"${words}"`);
    }
    expect(rule).toContain('Step "Type Ada into the lookup box one character at a time" is { "action": "type", "selector": "#lookup", "value": "Ada", "sequential": true,');
    expect(rule).toContain('step "Type Ada into the lookup box" is the same action without "sequential"');
    expect(rule).toMatch(/The step's words decide, never the page: do NOT add "sequential" because the page looks live/);
  });

  describe('code generation types the way the run typed', () => {
    const prompt = (actions: Parameters<typeof buildStepCodePrompt>[0]['actions']): string =>
      contentBlocksToText(buildStepCodePrompt({ rawStepText: 'x', parameters: [], actions }).content);
    const plain = { action: 'type' as const, selector: '#lookup', value: 'Ada', description: 'Type Ada' };
    const keyed = { ...plain, sequential: true, typed: { by: 'keys' as const } };

    it('tells the model fill for a plain type, and clear then pressSequentially for a sequential one', () => {
      const text = prompt([keyed]);
      expect(text).toContain('"sequential": true');
      expect(text).toContain('`await page.locator(<selector>).fill(<value>)`');
      expect(text).toContain('`await <locator>.clear()` and then `await <locator>.pressSequentially(<value>)`');
      // A sequential type the run filled, into a date input, is filled again.
      expect(text).toContain('unless its `"typed"` says `"by": "fill"`');
      expect(prompt([plain])).toContain('.fill(<value>)');
    });

    it('forbids a key the transcript does not record, and never itself asks for End', () => {
      for (const actions of [[plain], [keyed], []]) {
        const text = prompt(actions);
        expect(text).not.toMatch(/press\(\s*['"]End['"]\s*\)/);
        if (actions.length > 0) expect(text).toContain('Never press a key the transcript does not record, such as End, Tab or Enter after the text');
      }
    });

    it('says nothing about typing to a step that typed nothing', () => {
      // The control: without it the assertions above hold on a constant.
      expect(prompt([{ action: 'click', selector: '#go', description: 'Click Go' }])).not.toContain('pressSequentially');
    });

    it('letters rule 7\'s additions once each, in order', () => {
      const text = prompt([
        { action: 'switchPage', page: 'page:2', description: 'Switch' },
        { action: 'reload', description: 'Reload' },
        { action: 'drag', selector: '#card', target: '#bin', description: 'Drag' },
        keyed,
      ]);
      const letters = [...text.matchAll(/^7([a-z])\. /gm)].map((m) => m[1]);
      expect(letters).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('a repair types the way the step asks', () => {
    const repair = (entryCode: string, rawStepText = 'Type Ada into the lookup box'): string =>
      contentBlocksToText(buildRepairPrompt({ rawStepText, stepIndex: 1, entryCode, error: 'x', parameters: [] }).content);
    const typing = `{ source: 'x', async run({ page }) { await page.locator('#lookup').fill('Ada'); } }`;

    it('carries the typing rule for an entry that types, without asking for End', () => {
      const text = repair(typing);
      expect(text).toContain('7. Type the way the step asks.');
      expect(text).toContain('`await <locator>.clear()` and then `await <locator>.pressSequentially(<value>)`');
      expect(text).toContain('Never press a key the step does not ask for, such as End, Tab or Enter after the text');
      expect(text).not.toMatch(/press\(\s*['"]End['"]\s*\)/);
    });

    it('leaves the prompt as it was for an entry that types nothing', () => {
      expect(repair(`{ source: 'x', async run({ page }) { await page.locator('#go').click(); } }`, 'Click Go'))
        .not.toContain('7. Type the way the step asks.');
    });
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
  // The framework hides nothing on its own (§2.47): an ad is the test's to
  // deal with, through its ## Context or a step. What it owes the author is a
  // failure that says what is in the way.
  it('fails a covered click, names what covers it, and leaves the page alone', async () => {
    const page = await pageWith(`
      <button id="go" style="position:absolute;top:40px;left:40px">Register</button>
      <div id="modal" style="position:fixed;inset:0;z-index:9;background:#0003"></div>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: '#go' }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/intercepts pointer events/);
      expect(result.error).toMatch(/modal/);
      expect(await page.locator('#modal').isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

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

  it('normalises a colour typed through its label, as the input the label stands for', async () => {
    const page = await pageWith(`<label for="c">Colour</label><input id="c" type="color" value="#563d7c">`);
    expect((await executeAction(page, act({ action: 'type', selector: 'label[for="c"]', value: '#F00' }))).success).toBe(true);
    expect(await page.inputValue('#c')).toBe('#ff0000');
    await page.close();
  });

  it('clamps a range value typed through its label to the range\'s own ends', async () => {
    const page = await pageWith(`<label for="r">Volume</label><input id="r" type="range" min="0" max="10" value="5">`);
    expect((await executeAction(page, act({ action: 'type', selector: 'label[for="r"]', value: '7' }))).success).toBe(true);
    expect(await page.inputValue('#r')).toBe('7');
    expect((await executeAction(page, act({ action: 'type', selector: 'label[for="r"]', value: 'max' }))).success).toBe(true);
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

  it('clicks nothing beside a checkbox hidden in a closed panel, and says to open the panel', async () => {
    // Issue 32. The label is hidden with the checkbox, so the stand-in used to
    // climb past the panel to the <section> and click its middle: the
    // heading, which opened the panel, and the click reported success. Like
    // any click on something hidden, this one waits out its 10 s first.
    const page = await pageWith(`
      <section>
        <h3 id="hdr" onclick="togglePanel()">Delivery options</h3>
        <div id="panel" style="display:none">
          <input type="checkbox" id="gift"> <label for="gift">Gift wrap</label>
        </div>
      </section>
      <script>
        function togglePanel() {
          const p = document.getElementById('panel');
          p.style.display = p.style.display === 'none' ? 'block' : 'none';
        }
        window.clicked = [];
        document.addEventListener('click', (e) => window.clicked.push(e.target.id || e.target.tagName), true);
      </script>`);
    try {
      const action = act({ action: 'click', selector: '#gift' });
      const result = await executeAction(page, action);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /^Timeout \d+ms exceeded waiting for "#gift" to show\n"#gift" is a checkbox inside collapsed: Delivery options\. Open it first, then click the checkbox;/,
      );
      // The first line is still the verdict, so the scoreboard files it as
      // the selector matching nothing visible, as it did the bare timeout.
      expect(classifyOutcome({ index: 1, action, durationMs: 0, error: result.error!, errorSource: 'playwright' }))
        .toBe('no-match');
      expect(await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked)).toEqual([]);
      expect(await page.isChecked('#gift')).toBe(false);
      expect(await page.isHidden('#panel')).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('clicks the label of a styled checkbox once the panel the click waits on opens', async () => {
    // The input is hidden on purpose and stays hidden, so the click cannot
    // wait for IT; it waits for its container, then decides again.
    const page = await pageWith(`
      <section>
        <h3>Delivery options</h3>
        <div id="panel" style="display:none">
          <input type="checkbox" id="gift" style="display:none"> <label for="gift">Gift wrap</label>
        </div>
      </section>`);
    // Open the panel once the click is waiting on it, as a step that opened
    // it a moment before would.
    const stop = addLogCallback((_level, message) => {
      if (message.includes('"#gift"') && message.includes('waiting for it to show')) {
        void page.evaluate(() => { document.getElementById('panel')!.style.display = 'block'; });
      }
    });
    try {
      const result = await executeAction(page, act({ action: 'click', selector: '#gift' }));
      expect(result.success).toBe(true);
      expect(await page.isChecked('#gift')).toBe(true);
    } finally {
      stop();
      await page.close();
    }
  });

  it('fails a click beside a lone hidden checkbox when the checkbox does not change', async () => {
    // No label, and nothing but the input in the closed panel: in the markup
    // that is a styled toggle's hidden wrapper. So the section is clicked,
    // and only the unchanged checkbox shows the click went elsewhere.
    const page = await pageWith(`
      <section>
        <h3 onclick="document.getElementById('panel').style.display = 'block'">Gift wrap</h3>
        <div id="panel" style="display:none"><input type="checkbox" id="gift" aria-label="Gift wrap"></div>
      </section>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: '#gift' }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^Clicked the visible element around the hidden checkbox "#gift", and the checkbox did not change/);
      expect(await page.isChecked('#gift')).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('passes a click beside a lone hidden checkbox that loads a new page, and not one that only reloads an ad', async () => {
    // A filter checkbox that reloads the page is ticked on the page that comes
    // next, so a navigation of the page excuses the unchanged box. Another
    // frame navigating says nothing about it.
    const http = await import('node:http');
    const section = (onclick: string): string => `
      <section id="gifts">
        <h3 onclick="${onclick}">Gift wrap</h3>
        <div style="display:none"><input type="checkbox" id="gift" aria-label="Gift wrap"></div>
      </section>`;
    const pages: Record<string, string> = {
      '/': section(`location.href = '/next'`),
      '/next': '<input type="checkbox" id="gift" aria-label="Gift wrap" checked>',
      '/framed': `${section(`document.getElementById('ad').src = '/ad?2'`)}<iframe id="ad" src="/ad?1"></iframe>`,
      '/ad': '<p>ad</p>',
    };
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html><body>${pages[(req.url ?? '/').split('?')[0]!] ?? ''}</body></html>`);
    });
    const port = await listenFetchable(server, '127.0.0.1');
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      const navigated = await executeAction(page, act({ action: 'click', selector: '#gift' }), undefined, undefined, { measure: true });
      expect(navigated.success).toBe(true);
      await page.waitForURL(/\/next$/);
      // Measured on the page the click was on, not the one it led to.
      expect(navigated.targeting).toMatchObject({ standIn: 'box', resolvedSelector: '#gifts' });

      await page.goto(`http://127.0.0.1:${port}/framed`);
      const adOnly = await executeAction(page, act({ action: 'click', selector: '#gift' }));
      expect(adOnly.success).toBe(false);
      expect(adOnly.error).toMatch(/and the checkbox did not change/);
    } finally {
      await page.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still clicks the label of a hidden checkbox when the run measures its actions, and records what it clicked', async () => {
    // Run & Compile measures every action, and the measurement waited for a
    // visible match before the stand-in ever ran. A compile has to know what
    // stood in, because nothing replays the stand-in.
    const page = await pageWith(`
      <input type="checkbox" id="ajax" aria-label="Ajax" style="display:none">
      <label for="ajax">Ajax</label>
      <div id="wrap" style="display:inline-block;padding:4px"
           onclick="const c = document.getElementById('basic'); c.checked = !c.checked">
        <div style="display:none"><input type="checkbox" id="basic" aria-label="Basic"></div>
        <span style="display:inline-block;width:20px;height:20px;border:1px solid"></span>
      </div>`);
    try {
      const measured = { measure: true };
      const label = await executeAction(page, act({ action: 'click', selector: '#ajax' }), undefined, undefined, measured);
      expect(label.success).toBe(true);
      expect(await page.isChecked('#ajax')).toBe(true);
      expect(label.targeting?.standIn).toBe('label');
      expect(await page.locator(label.targeting!.resolvedSelector!).textContent()).toBe('Ajax');

      const box = await executeAction(page, act({ action: 'click', selector: '#basic' }), undefined, undefined, measured);
      expect(box.success).toBe(true);
      expect(await page.isChecked('#basic')).toBe(true);
      expect(box.targeting?.standIn).toBe('box');
      expect(await page.locator(box.targeting!.resolvedSelector!).getAttribute('id')).toBe('wrap');
    } finally {
      await page.close();
    }
  });

  it('refuses several hidden matches under browser.ambiguousTarget "fail"', async () => {
    const page = await pageWith(`
      <input type="checkbox" id="a" style="display:none"><label for="a">A</label>
      <input type="checkbox" id="b" style="display:none"><label for="b">B</label>`);
    try {
      const result = await executeAction(
        page, act({ action: 'click', selector: 'input[type=checkbox]' }), undefined, undefined, { ambiguousTarget: 'fail' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^2 hidden elements matched "input\[type=checkbox\]" .*\(browser\.ambiguousTarget is "fail"\)$/);
      expect(result.matchCount).toBe(2);
      expect(await page.isChecked('#a')).toBe(false);
      expect(await page.isChecked('#b')).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('tells a toggle hidden with its container from one hidden alone', async () => {
    const page = await pageWith(`
      <details><summary>Delivery options</summary>
        <input type="checkbox" id="gift"> <label for="gift">Gift wrap</label>
      </details>
      <details><summary>Extras</summary><input type="checkbox" id="solo" aria-label="Insurance"></details>
      <section><div style="content-visibility:hidden"><h4>Extras</h4><input type="checkbox" id="cv" aria-label="Extras"></div></section>
      <div id="menu" hidden>
        <div class="chk"><div style="display:none"><input type="checkbox" id="red" aria-label="Red"></div><span class="box"></span><span>Red</span></div>
      </div>
      <div style="visibility:hidden">
        <ul><li><label><input type="checkbox" id="asc"> Ascending</label></li></ul>
      </div>
      <div hidden><h4>Extras</h4><x-check></x-check></div>
      <script>
        customElements.define('x-check', class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML = '<input type="checkbox" id="inner" style="display:none"><span>box</span>';
          }
        });
      </script>
      <div class="switch">
        <input type="checkbox" id="sw" style="display:none"><label for="sw" style="display:none">Notifications</label>
        <span style="display:inline-block;width:30px;height:16px;border:1px solid"></span>
      </div>
      <div class="chk" id="box" style="width:20px;height:20px;border:1px solid">
        <div style="display:none"><input type="checkbox" id="basic" aria-label="Basic"></div>
      </div>
      <input type="checkbox" id="ajax" style="display:none"><label for="ajax">Ajax</label>`);
    try {
      const enclosed = async (selector: string): Promise<boolean | undefined> =>
        (await hiddenToggleOf(page.locator(selector)))?.enclosed;
      // Its label is in the closed <details> with it.
      expect(await enclosed('#gift')).toBe(true);
      // No label, but the closed <details> holds its summary too.
      expect(await enclosed('#solo')).toBe(true);
      // `content-visibility: hidden` hides the heading beside it as well.
      expect(await enclosed('#cv')).toBe(true);
      // No label, but the hidden menu holds the drawn box and the text too.
      expect(await enclosed('#red')).toBe(true);
      // An enclosing label hidden by an ancestor's `visibility: hidden`.
      expect(await enclosed('#asc')).toBe(true);
      // Inside a web component, inside a hidden panel that holds more.
      expect(await enclosed('x-check >> input')).toBe(true);
      // Hidden alone: a label hidden by its own style, a wrapper holding
      // nothing but the input, or the input itself.
      expect(await enclosed('#sw')).toBe(false);
      expect(await enclosed('#basic')).toBe(false);
      expect(await enclosed('#ajax')).toBe(false);
      expect(await hiddenToggleOf(page.locator('#box'))).toBeNull();
      // The names are for a failure's message: a decision does without them.
      expect(await hiddenToggleOf(page.locator('#gift'))).toEqual({ type: 'checkbox', id: 'gift', enclosed: true });
    } finally {
      await page.close();
    }
  });

  it('names what to open the way a person reads the page', async () => {
    const page = await pageWith(`
      <details><summary>Delivery options</summary>
        <input type="checkbox" id="gift"> <label for="gift">Gift wrap</label>
      </details>
      <button aria-controls="menu">Filters</button>
      <div id="menu" hidden>
        <div class="chk"><div style="display:none"><input type="checkbox" id="red" aria-label="Red"></div><span>Red</span></div>
      </div>
      <div style="visibility:hidden" aria-label="Sort">
        <ul><li><label><input type="checkbox" id="asc"> Ascending</label></li></ul>
      </div>
      <button role="tab" id="tab-2">Wrapping</button>
      <div role="tabpanel" aria-labelledby="tab-2" hidden>
        <input type="radio" name="wrap" id="paper"> <label for="paper">Paper</label>
      </div>
      <section>
        <h3>Shipping</h3>
        <div hidden><p>Standard</p></div>
        <h3>Gifts</h3>
        <div hidden><input type="checkbox" id="note"> <label for="note">Add a note</label></div>
      </section>
      <section>
        <script>window.unused = 1;</script>
        <div hidden><input type="checkbox" id="card"> <label for="card">Add a card</label></div>
        <h3>Messages</h3>
      </section>`);
    try {
      const names = async (selector: string): Promise<string[] | undefined> =>
        (await hiddenToggleOf(page.locator(selector), { names: true }))?.collapsedUnder;
      expect(await names('#gift')).toEqual(['Delivery options']);
      // By the button that controls it; its own hidden wrapper is not named.
      expect(await names('#red')).toEqual(['Filters']);
      // `visibility: hidden` is inherited: named once, where it starts.
      expect(await names('#asc')).toEqual(['Sort']);
      // An inactive tab, by the tab that labels it.
      expect(await names('#paper')).toEqual(['Wrapping']);
      // The header just before the panel, not the first header in the section.
      expect(await names('#note')).toEqual(['Gifts']);
      // Never a script's source; the header after the panel when none is before.
      expect(await names('#card')).toEqual(['Messages']);
    } finally {
      await page.close();
    }
  });

  it('explains only a failure on an enclosed toggle, after the failure\'s first line', async () => {
    const page = await pageWith(`
      <button id="go" style="display:none">Go</button>
      <section>
        <h3>Extras</h3>
        <div style="display:none"><input type="checkbox" id="ins"> <label for="ins">Insurance</label></div>
      </section>`);
    try {
      const timeout = Object.assign(
        new Error('locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator'),
        { name: 'TimeoutError' },
      );
      expect(await explainEnclosedToggle('#go', page.locator('#go'), timeout)).toBe(timeout);
      const explained = await explainEnclosedToggle('#ins', page.locator('#ins'), timeout) as Error;
      expect(explained.name).toBe('TimeoutError');
      expect(explained.message.split('\n')).toEqual([
        'locator.click: Timeout 10000ms exceeded.',
        '"#ins" is a checkbox inside collapsed: Extras. Open it first, then click the checkbox; '
          + 'while it is hidden there is nothing on screen to click.',
        'Call log:',
        '  - waiting for locator',
      ]);
    } finally {
      await page.close();
    }
  });

  it('still clicks a visible label for a checkbox hidden with others', async () => {
    // A label sets its own input wherever that sits, so a visible one stands
    // in even when the input's hidden container holds more than it.
    const page = await pageWith(`
      <div hidden><input type="checkbox" id="a"><input type="checkbox" id="b"></div>
      <label for="a">Show the menu</label>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: '#a' }));
      expect(result.success).toBe(true);
      expect(await page.isChecked('#a')).toBe(true);
      expect(await page.isChecked('#b')).toBe(false);
    } finally {
      await page.close();
    }
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
    await captureDomSnapshot(page, { dialogReader: 'model' }); // drain anything earlier tests left
    await executeAction(page, act({ action: 'click', selector: '#confirm' }));
    await expect.poll(() => page.textContent('#out')).toBe('confirm:false');
    const first = await captureDomSnapshot(page, { dialogReader: 'model' });
    expect(first).toContain('[confirm] "Sure?" — dismissed by default');
    const second = await captureDomSnapshot(page, { dialogReader: 'model' });
    expect(second).not.toContain('Browser dialogs');
    await page.close();
  });

  // Issue 31: the report's capture after each action used up the note before
  // the model's next turn could read it.
  it('a capture that names no reader shows the note without using it up', async () => {
    const page = await pageWith(DIALOGS);
    await captureDomSnapshot(page, { dialogReader: 'model' }); // drain anything earlier tests left
    await executeAction(page, act({ action: 'click', selector: '#confirm' }));
    await expect.poll(() => page.textContent('#out')).toBe('confirm:false');
    expect(await captureDomSnapshot(page)).toContain('[confirm] "Sure?" — dismissed by default');
    expect(await captureDomSnapshot(page)).toContain('[confirm] "Sure?" — dismissed by default');
    // Each reader is told once, and one reader's read leaves the other's note.
    expect(await captureDomSnapshot(page, { dialogReader: 'api' })).toContain('[confirm] "Sure?"');
    expect(await captureDomSnapshot(page, { dialogReader: 'api' })).not.toContain('Browser dialogs');
    expect(await captureDomSnapshot(page, { dialogReader: 'model' })).toContain('[confirm] "Sure?"');
    expect(await captureDomSnapshot(page, { dialogReader: 'model' })).not.toContain('Browser dialogs');
    // Once the model has been told, an unnamed capture has nothing new to list.
    expect(await captureDomSnapshot(page)).not.toContain('Browser dialogs');
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

describe('§2.22 a drag whose source something covers', () => {
  it('does not press on the cover: it fails naming what is in the way', async () => {
    const page = await pageWith(`
      <div id="red" draggable="true" style="width: 60px; height: 60px; background: red"></div>
      <div id="target" style="width: 120px; height: 120px; border: 3px solid #333; margin-top: 40px"></div>
      <div id="banner" style="position: fixed; left: 0; top: 0; width: 200px; height: 80px; background: #eee"></div>
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
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/intercepts pointer events/);
      expect(await page.locator('#target #red').count()).toBe(0);
      expect(await page.locator('#banner').isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
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

  it('matches letter case: "Sign In" is not at a heading that says "Sign in" (steptix/steptix#67)', async () => {
    const page = await pageWith('<h1>Sign in</h1><button id="go">Sign In</button>');
    try {
      const where = await describeWhereExpectedIs(page, 'Sign In');
      expect(where).toContain('"Sign In" at button#go');
      expect(where).not.toContain('h1');
    } finally {
      await page.close();
    }
  });

  it('finds text in the case its markup has and in the case CSS shows it', async () => {
    const page = await pageWith('<h1>Parcel</h1><p id="state" style="text-transform: uppercase">Out for delivery</p>');
    try {
      expect(await describeWhereExpectedIs(page, 'OUT FOR DELIVERY')).toContain('"OUT FOR DELIVERY" at p#state');
      expect(await describeWhereExpectedIs(page, 'Out for delivery')).toContain('"Out for delivery" at p#state');
      // A third case is in neither.
      expect(await describeWhereExpectedIs(page, 'Out For Delivery')).toBe('');
    } finally {
      await page.close();
    }
  });

  it('never points at hidden text, in any case or as part of shown text', async () => {
    const page = await pageWith(`
      <form><span id="error" style="visibility: hidden">Email is required</span></form>
      <p id="status">Saved <span style="display: none">draft</span></p>
      <p id="note" style="text-transform: uppercase">Ready <span style="display: none">to ship</span></p>`);
    try {
      // A message not shown yet is not somewhere a check should read.
      expect(await describeWhereExpectedIs(page, 'Email is required')).toBe('');
      // Nor is shown text with a hidden part beside it.
      expect(await describeWhereExpectedIs(page, 'Saved draft')).toBe('');
      expect(await describeWhereExpectedIs(page, 'Ready to ship')).toBe('');
      // The markup's case still counts for the text that is shown.
      expect(await describeWhereExpectedIs(page, 'Ready')).toContain('"Ready" at p#note');
    } finally {
      await page.close();
    }
  });

  it('takes the markup\'s case only from text that is shown', async () => {
    // Shown in capitals; the markup's "Ready" is in a hidden span beside it.
    const page = await pageWith('<p id="tag" style="text-transform: uppercase">ready <span style="visibility: hidden">Ready</span></p>');
    try {
      expect(await describeWhereExpectedIs(page, 'Ready')).toBe('');
    } finally {
      await page.close();
    }
  });

  it('is not put off shown text by a hidden copy of it inside', async () => {
    const page = await pageWith(
      '<p id="msg">Order <b>12</b> was placed.<span style="display: none">Order 12 was placed.</span></p>',
    );
    try {
      expect(await describeWhereExpectedIs(page, 'Order 12 was placed.')).toContain('"Order 12 was placed." at p#msg');
    } finally {
      await page.close();
    }
  });

  it('never takes a closed select for an option it does not show', async () => {
    const page = await pageWith('<select id="payee"><option>Acme Plumbing</option><option>Harbour Glazing</option></select>');
    try {
      expect(await describeWhereExpectedIs(page, 'Harbour Glazing')).toBe('');
    } finally {
      await page.close();
    }
  });

  it('does not point at text whose smallest holder has no box of its own (a known gap)', async () => {
    // A closed select's current option, and text directly inside a
    // `display: contents` element: no hint rather than a wrong one.
    const page = await pageWith(
      '<select id="payee"><option selected>Harbour Glazing</option><option>Acme Plumbing</option></select>' +
        '<div id="msg"><span style="display: contents">Order 12 was placed.</span></div>',
    );
    try {
      expect(await describeWhereExpectedIs(page, 'Harbour Glazing')).toBe('');
      expect(await describeWhereExpectedIs(page, 'Order 12 was placed.')).toBe('');
    } finally {
      await page.close();
    }
  });

  it('points past a box-less wrapper to the element inside it', async () => {
    const page = await pageWith(
      '<main><header>Site</header><section style="display: contents"><h2 id="total">Total: $42.00</h2></section></main>',
    );
    try {
      const where = await describeWhereExpectedIs(page, 'Total: $42.00');
      expect(where).toContain('"Total: $42.00" at h2#total');
      expect(where).not.toContain('at main');
    } finally {
      await page.close();
    }
  });

  it('finds text whose capitals are longer than its markup ("ß" is shown "SS")', async () => {
    const page = await pageWith('<p id="street" style="text-transform: uppercase">Hauptstraße 5</p>');
    try {
      expect(await describeWhereExpectedIs(page, 'Hauptstraße 5')).toContain('"Hauptstraße 5" at p#street');
    } finally {
      await page.close();
    }
  });

  it('never takes text the page does not show as text for the markup of what it shows', async () => {
    // Each element has a box, so the text inside passes `checkVisibility`,
    // yet none of it is shown as text: a textarea's default value, the text
    // between an iframe's tags, and fallback content. Beside each, the same
    // words shown in capitals, so the markup around them is all that would
    // match in the case asked for.
    const page = await pageWith(`
      <section id="notes"><h2>DELIVERY NOTES</h2><textarea>Delivery notes</textarea></section>
      <figure id="chart"><figcaption>SALES BY MONTH</figcaption><canvas>Sales by month</canvas></figure>
      <div id="clip"><p>OPENING SCENE</p><video>Opening scene</video><audio controls>Opening scene</audio></div>
      <div id="map"><p>HARBOUR MAP</p><iframe>Harbour map</iframe></div>
      <div id="usage"><p>DISK USAGE</p><progress value="3" max="10">Disk usage</progress><meter value="0.3">Disk usage</meter></div>`);
    try {
      for (const text of ['Delivery notes', 'Sales by month', 'Opening scene', 'Harbour map', 'Disk usage']) {
        expect(await describeWhereExpectedIs(page, text), text).toBe('');
      }
      // The words shown are still found, where they are shown.
      expect(await describeWhereExpectedIs(page, 'DELIVERY NOTES')).toContain('"DELIVERY NOTES" at section#notes > h2');
    } finally {
      await page.close();
    }
  });

  it('finds an object\'s fallback text in the case it is shown in, but not in its markup\'s case', async () => {
    // An `<object>` that embeds nothing shows its fallback content, and its
    // `innerText` holds it, so that text is found as shown. Its markup is
    // left out all the same, so text CSS shows in another case is not found
    // in the case the markup writes it.
    const page = await pageWith(`
      <p><object id="report">Annual report</object></p>
      <p><object id="summary" style="text-transform: uppercase">Annual summary</object></p>`);
    try {
      expect(await describeWhereExpectedIs(page, 'Annual report')).toContain('"Annual report" at object#report');
      expect(await describeWhereExpectedIs(page, 'ANNUAL SUMMARY')).toContain('"ANNUAL SUMMARY" at object#summary');
      expect(await describeWhereExpectedIs(page, 'Annual summary')).toBe('');
    } finally {
      await page.close();
    }
  });

  it('compares the text shown with its whitespace collapsed, as a check does', async () => {
    const page = await pageWith('<p id="total">Total:&nbsp;$42.00</p><p id="state">Out for<br>delivery</p>');
    try {
      expect(await describeWhereExpectedIs(page, 'Total: $42.00')).toContain('"Total: $42.00" at p#total');
      expect(await describeWhereExpectedIs(page, 'Out for delivery')).toContain('"Out for delivery" at p#state');
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

  // A canvas editor draws the text itself and takes the keys in a hidden
  // field it focuses on mousedown — a light-DOM textarea here, a
  // contenteditable inside the editor's own shadow root below.
  it('types into the hidden textarea a canvas editor focuses when clicked', async () => {
    const page = await pageWith(`
      <canvas id="board" width="300" height="80"></canvas>
      <textarea id="sink" style="position: absolute; left: -1000px; width: 10px; height: 10px"></textarea>
      <script>
        document.getElementById('board').addEventListener('mousedown', (e) => {
          e.preventDefault();
          document.getElementById('sink').focus();
        });
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'type', selector: '#board', value: 'Tester' }));
      expect(result.success).toBe(true);
      expect(await page.inputValue('#sink')).toBe('Tester');
    } finally {
      await page.close();
    }
  });

  it('follows the focus into the shadow root of an editor that shows only as its host', async () => {
    const page = await pageWith(`
      <x-editor style="display: block; width: 300px"></x-editor>
      <script>
        const root = document.querySelector('x-editor').attachShadow({ mode: 'open' });
        root.innerHTML = '<canvas width="300" height="80"></canvas>'
          + '<div contenteditable style="position: absolute; left: -1000px; width: 10px; height: 10px"></div>';
        root.querySelector('canvas').addEventListener('mousedown', (e) => {
          e.preventDefault();
          root.querySelector('[contenteditable]').focus();
        });
        window.__typed = () => root.querySelector('[contenteditable]').textContent;
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'type', selector: 'x-editor', value: 'Tester' }));
      expect(result.success).toBe(true);
      // document.activeElement is <x-editor>, which takes no text itself.
      expect(await page.evaluate(() => (window as unknown as { __typed: () => string }).__typed())).toBe('Tester');
    } finally {
      await page.close();
    }
  });

  it('types into an editor surface that takes text through an EditContext', async () => {
    // Focusable by tabindex and not contenteditable, so only its EditContext
    // says it takes text.
    const page = await pageWith(`
      <div id="surface" tabindex="0" style="width: 300px; height: 80px"></div>
      <script>
        const context = new EditContext();
        document.getElementById('surface').editContext = context;
        window.__typed = () => context.text;
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'type', selector: '#surface', value: 'Tester' }));
      expect(result.success).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __typed: () => string }).__typed())).toBe('Tester');
    } finally {
      await page.close();
    }
  });

  // steptix/steptix#34. The model picked the wrapper, not the field. Clicking its
  // centre lands on the label text, so the focus stays on <body>: typing there
  // reached nothing, while Ctrl+A selected the page and every key reached the
  // page's shortcuts.
  const wrapped = `
    <div class="field-wrap" id="wrap" style="width: 300px">
      <span style="display: block; height: 200px">Email</span>
      <input id="email" type="email">
    </div>
    <script>
      window.__keydowns = 0;
      document.addEventListener('keydown', () => { window.__keydowns++; }, true);
    </script>`;
  const typedNothing = async (scope: Frame): Promise<{ keydowns: number; selected: string; email: string }> =>
    scope.evaluate(() => ({
      keydowns: (window as unknown as { __keydowns: number }).__keydowns,
      selected: String(window.getSelection()),
      email: (document.getElementById('email') as HTMLInputElement).value,
    }));

  it('fails and types nothing when the click leaves the focus on <body>', async () => {
    const page = await pageWith(wrapped);
    try {
      const result = await executeAction(page, act({ action: 'type', selector: '#wrap', value: 'ada@example.test' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Element is not an <input>, <textarea> or [contenteditable] element');
      expect(result.error).toContain('left the focus on <body>');
      expect(result.failedSelector).toBe('#wrap');
      expect(await typedNothing(page.mainFrame())).toEqual({ keydowns: 0, selected: '', email: '' });
    } finally {
      await page.close();
    }
  });

  it('checks the focus in the frame the action names', async () => {
    const page = await pageWith(`<iframe id="form" srcdoc="${wrapped.replace(/"/g, '&quot;')}"></iframe>`);
    try {
      await page.frameLocator('#form').locator('#email').waitFor();
      const result = await executeAction(page, act({ action: 'type', selector: '#wrap', value: 'ada@example.test', frame: '#form' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('left the focus on <body>');
      const frame = page.frames().find((f) => f !== page.mainFrame())!;
      expect(await typedNothing(frame)).toEqual({ keydowns: 0, selected: '', email: '' });
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
    const page = await pageWith(`<iframe id="iframeResults" srcdoc="<input type='checkbox' id='cb' checked>"></iframe>`);
    try {
      await page.frameLocator('#iframeResults').locator('#cb').waitFor();
      const stepReply = JSON.stringify({
        actions: [{ action: 'assert', frame: '#iframeResults', condition: 'the checkbox is ticked', expected: 'checked', description: 'Checkbox in the frame is ticked' }],
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
          t.className = 'pop';
          t.setAttribute('role', 'alert');
          t.textContent = 'Checked';
          document.body.appendChild(t);
          setTimeout(() => t.remove(), 50);
        ">Tick</button></body></html>`);
      await page.click('#b');
      await page.waitForFunction(() => !document.querySelector('.pop'));
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

  it('never names a message that was never shown as one that closed', async () => {
    const own = await browser.newContext();
    await installNoticeRecorder(own);
    const page = await own.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>
        <p role="status" style="display: none">Draft saved</p>
        <p>Nothing else</p></body></html>`);
      const snap = await captureDomSnapshot(page);
      expect(snap).not.toContain('Notifications that appeared and have since closed');
      expect(snap).not.toContain('Draft saved');
    } finally {
      await own.close();
    }
  });
});

describe('§2.50 notifications are what the page marks as live regions', () => {
  async function noticesAfter(body: string, act: string): Promise<string[]> {
    const own = await browser.newContext();
    await installNoticeRecorder(own);
    const page = await own.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
      await page.evaluate(act);
      await page.waitForFunction(() => document.body.dataset['done'] === '1');
      return await page.evaluate(() => (window as unknown as { __steptixNotices: Array<{ text: string }> })
        .__steptixNotices.map((n) => n.text));
    } finally {
      await own.close();
    }
  }

  it('records a message added to a container that is already a live region', async () => {
    const texts = await noticesAfter('<div id="box" aria-live="polite"></div>', `
      const m = document.createElement('div'); m.className = 'msg'; m.textContent = 'Order saved';
      document.getElementById('box').appendChild(m);
      requestAnimationFrame(() => { m.remove(); document.body.dataset.done = '1'; });`);
    expect(texts).toContain('Order saved');
  });

  it('records role="status", role="log" and <output>, and ignores aria-live="off"', async () => {
    const texts = await noticesAfter('', `
      for (const [tag, attr, val, text] of [['div', 'role', 'status', 'Uploaded'], ['div', 'role', 'log', 'Ada joined'],
          ['output', null, null, 'Total 12'], ['div', 'aria-live', 'off', 'Ticking clock']]) {
        const el = document.createElement(tag); if (attr) el.setAttribute(attr, val); el.textContent = text;
        document.body.appendChild(el);
      }
      requestAnimationFrame(() => { document.body.dataset.done = '1'; });`);
    expect(texts).toEqual(expect.arrayContaining(['Uploaded', 'Ada joined', 'Total 12']));
    expect(texts).not.toContain('Ticking clock');
  });

  it('records nothing a person never saw: a hidden region, text changed while hidden, a hidden child', async () => {
    const texts = await noticesAfter(`
      <p role="status" style="display: none">Hidden from the start</p>
      <div id="quiet" role="alert" style="visibility: hidden"></div>
      <div role="status"><span style="display: none">Only in a hidden child</span></div>`, `
      document.getElementById('quiet').textContent = 'Changed while hidden';
      requestAnimationFrame(() => { document.body.dataset.done = '1'; });`);
    expect(texts).toEqual([]);
  });

  it('records a region when it is shown, not before: added hidden, then shown by a class change', async () => {
    const own = await browser.newContext();
    await installNoticeRecorder(own);
    const page = await own.newPage();
    try {
      await page.setContent('<!doctype html><html><head><style>.off { display: none }</style></head><body></body></html>');
      // A frame later, the recorder's observer has seen every change before it.
      const textsAfterAFrame = () => page.evaluate(() => new Promise<string[]>((resolve) => requestAnimationFrame(() => resolve(
        (window as unknown as { __steptixNotices: Array<{ text: string }> }).__steptixNotices.map((n) => n.text)))));
      await page.evaluate(() => {
        const t = document.createElement('div');
        t.id = 'note'; t.setAttribute('role', 'alert'); t.className = 'off'; t.textContent = 'Saved at last';
        document.body.appendChild(t);
      });
      expect(await textsAfterAFrame()).toEqual([]);
      await page.evaluate(() => { document.getElementById('note')!.className = ''; });
      expect(await textsAfterAFrame()).toEqual(['Saved at last']);
    } finally {
      await own.close();
    }
  });

  it('waits for the page to load: a region its late stylesheet hides is not recorded', async () => {
    const http = await import('node:http');
    let releaseCss!: () => void;
    const cssArrives = new Promise<void>((resolve) => { releaseCss = resolve; });
    const server = http.createServer((req, res) => {
      if (req.url === '/late.css') {
        void cssArrives.then(() => {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end('.later { display: none }');
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><link rel="stylesheet" href="/late.css"></head>'
        + '<body><div role="alert" class="later">Hidden by a late stylesheet</div></body></html>');
    });
    const port = await listenFetchable(server, '127.0.0.1');
    const own = await browser.newContext();
    await installNoticeRecorder(own);
    const page = await own.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit' });
      // The parser has added the region while its stylesheet is still on the
      // way, so it looks shown for now. (Polled by interval: no frame is drawn
      // until the stylesheet arrives.)
      await page.waitForFunction(() => document.querySelector('[role="alert"]') !== null, undefined, { polling: 50 });
      releaseCss();
      await page.waitForLoadState('load');
      expect(await page.evaluate(() => (window as unknown as { __steptixNotices: Array<{ text: string }> })
        .__steptixNotices.map((n) => n.text))).toEqual([]);
    } finally {
      releaseCss();
      await own.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('records a shown region once, however long its style keeps changing', async () => {
    const texts = await noticesAfter('<div id="bar" role="status">Uploading</div>', `
      // Each change lands 4 s after the one before, past the 3 s in which the
      // same text is not recorded twice: only being shown again records it again.
      const start = Date.now(); let n = 0; Date.now = () => start + n * 4000;
      const bar = document.getElementById('bar');
      const tick = () => {
        n++; bar.style.opacity = String(0.5 + (n % 2) / 2);
        if (n < 10) requestAnimationFrame(tick); else requestAnimationFrame(() => { document.body.dataset.done = '1'; });
      };
      requestAnimationFrame(tick);`);
    expect(texts).toEqual(['Uploading']);
  });

  it('does not guess from class names: a message with no live-region marking is not recorded', async () => {
    const texts = await noticesAfter('', `
      for (const cls of ['toast', 'snackbar', 'notification', 'flash-message']) {
        const el = document.createElement('div'); el.className = cls; el.textContent = 'Saved by ' + cls;
        document.body.appendChild(el);
      }
      requestAnimationFrame(() => { document.body.dataset.done = '1'; });`);
    expect(texts).toEqual([]);
  });
});

describe('§2.34 role names match what a person sees', () => {
  const hit = (page: Page): Promise<string | undefined> => page.evaluate(() => document.body.dataset['hit']);

  it.each([
    ['an image', `<img alt="tick">`],
    ['an SVG with a title', `<svg width="10" height="10"><title>Close icon</title><rect width="10" height="10"/></svg>`],
    ['a glyph written into the DOM', `<span>✔</span>`],
  ])('clicks the button whose visible text is the name when %s adds to its accessible name', async (_what, icon) => {
    const page = await pageWith(`
      <button onclick="document.body.dataset.hit = 'all'">${icon} Dismiss all</button>
      <button onclick="document.body.dataset.hit = 'one'">${icon} Dismiss</button>`);
    try {
      expect(await page.locator('role=button[name="Dismiss"]').count()).toBe(0);
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Dismiss"]' }));
      expect(result.success).toBe(true);
      expect(await hit(page)).toBe('one');
    } finally {
      await page.close();
    }
  });

  it('clicks a button by the symbol it shows, and still by its label', async () => {
    const page = await pageWith(`
      <button aria-label="Close dialog" onclick="document.body.dataset.hit = (document.body.dataset.hit || '') + 'x'">×</button>`);
    try {
      expect((await executeAction(page, act({ action: 'click', selector: 'role=button[name="Close dialog"]' }))).success).toBe(true);
      expect((await executeAction(page, act({ action: 'click', selector: 'role=button[name="×"]' }))).success).toBe(true);
      expect(await hit(page)).toBe('xx');
    } finally {
      await page.close();
    }
  });

  it('finds a button CSS uppercases by the text the model wrote', async () => {
    const page = await pageWith(`
      <button style="text-transform: uppercase" onclick="document.body.dataset.hit = 'close'"><img alt="cross"> Close</button>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Close"]' }));
      expect(result.success).toBe(true);
      expect(await hit(page)).toBe('close');
    } finally {
      await page.close();
    }
  });

  it('refuses to guess between two buttons that read the same, and names both', async () => {
    const page = await pageWith(`
      <button onclick="document.body.dataset.hit = 'approve'"><img alt="approve"> Save</button>
      <button onclick="document.body.dataset.hit = 'discard'"><img alt="discard"> Save</button>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Save"]' }));
      expect(result.success).toBe(false);
      expect(result.matchCount).toBe(2);
      expect(result.error).toContain('no button is named exactly "Save", and 2 read "Save" on screen');
      expect(result.error).toContain('named "approve Save"');
      expect(result.error).toContain('named "discard Save"');
      expect(result.error).toContain('e.g. role=button[name="approve Save"]');
      expect(await hit(page)).toBeUndefined();
      // The name it suggests is one step 1 matches.
      expect((await executeAction(page, act({ action: 'click', selector: 'role=button[name="approve Save"]' }))).success).toBe(true);
      expect(await hit(page)).toBe('approve');
    } finally {
      await page.close();
    }
  });

  it('lists the buttons the page has when nothing reads the name, and clicks none', async () => {
    const page = await pageWith(`
      <button onclick="document.body.dataset.hit = 'badge'"><img alt="tick"> Dismiss <span class="badge">3</span></button>
      <button onclick="document.body.dataset.hit = 'cancel'">Cancel</button>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Dismiss"]' }));
      expect(result.success).toBe(false);
      expect(result.matchCount).toBe(0);
      expect(result.error).toContain('No button named "Dismiss" and none reads "Dismiss" on screen. Buttons on the page:');
      expect(result.error).toContain('  - named "tick Dismiss 3" (reads "Dismiss 3")');
      expect(result.error).toContain('  - named "Cancel"\n');
      expect(await hit(page)).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30_000);

  it('finds a field by its label, and an icon button by its aria-label, when the name is mis-cased or missing a mark', async () => {
    const page = await pageWith(`
      <label>Email *<input id="email"></label>
      <button aria-label="Close dialog" onclick="document.body.dataset.hit = 'close'">×</button>`);
    try {
      const typed = await executeAction(page, act({ action: 'type', selector: 'role=textbox[name="Email"]', value: 'ada@example.test' }));
      expect(typed.success).toBe(true);
      expect(await page.inputValue('#email')).toBe('ada@example.test');
      const clicked = await executeAction(page, act({ action: 'click', selector: 'role=button[name="close dialog"]' }));
      expect(clicked.success).toBe(true);
      expect(await hit(page)).toBe('close');
    } finally {
      await page.close();
    }
  });

  it('pins the element by its own text, so a button appearing before it does not move the target', async () => {
    const page = await pageWith(`
      <div id="bar"><button id="cancel">Cancel</button><button id="dismiss"><img alt="tick"> Dismiss</button></div>`);
    try {
      const { selector } = await resolveRoleName(page, 'role=button[name="Dismiss"]', { graceMs: 0 });
      expect(selector).toContain('internal:has-text=');
      expect(selector).not.toContain('nth=');
      await page.evaluate(() => {
        const b = document.createElement('button');
        b.textContent = 'Undo';
        document.getElementById('bar')!.prepend(b);
      });
      expect(await page.locator(selector).evaluateAll((els) => els.map((e) => e.id))).toEqual(['dismiss']);
    } finally {
      await page.close();
    }
  });

  it('pins by position only when its text cannot pick it out alone', async () => {
    // Playwright's text filter reads the hidden "3"; innerText does not.
    const page = await pageWith(`<button>Cancel</button><button><img alt="tick"><span style="display:none">3</span>Save</button>`);
    try {
      const { selector } = await resolveRoleName(page, 'role=button[name="Save"]', { graceMs: 0 });
      expect(selector).toBe('role=button >> visible=true >> nth=1');
    } finally {
      await page.close();
    }
  });

  it('counts every element that reads the name, rather than refusing a count', async () => {
    const page = await pageWith(`
      <button><img alt="cart"> Add to cart</button>
      <button><img alt="cart"> Add to cart</button>
      <button>Add to wishlist</button>`);
    try {
      const counted = await executeAction(page, act({ action: 'count', selector: 'role=button[name="Add to cart"]', as: 'n' }));
      expect(counted.success).toBe(true);
      expect(counted.capturedValue).toBe('2');
    } finally {
      await page.close();
    }
  });

  it('waits a moment for the named element before settling for one that only reads the same', async () => {
    // A row's "✖ Remove" is on screen; the dialog's own Remove arrives later.
    const page = await pageWith(`
      <button onclick="document.body.dataset.hit = 'row'">✖ Remove</button>
      <script>
        setTimeout(() => {
          const b = document.createElement('button');
          b.textContent = 'Remove';
          b.onclick = () => { document.body.dataset.hit = 'dialog'; };
          document.body.appendChild(b);
        }, 300);
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Remove"]' }));
      expect(result.success).toBe(true);
      expect(await hit(page)).toBe('dialog');
    } finally {
      await page.close();
    }
  });

  it('looks past an exact match nobody can see', async () => {
    const page = await pageWith(`
      <button style="width: 0; height: 0; padding: 0; border: 0; overflow: hidden">Dismiss</button>
      <button onclick="document.body.dataset.hit = 'seen'"><img alt="tick"> Dismiss</button>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Dismiss"]' }));
      expect(result.success).toBe(true);
      expect(await hit(page)).toBe('seen');
    } finally {
      await page.close();
    }
  });

  it('suggests a name with dollar signs in it exactly as the page has it', async () => {
    const page = await pageWith(`<button aria-label="Pay $$ now">Pay</button><button aria-label="Pay later">Pay</button>`);
    try {
      const { refusal } = await resolveRoleName(page, 'role=button[name="Pay"]', { graceMs: 0 });
      expect(refusal).toContain('e.g. role=button[name="Pay $$ now"].');
    } finally {
      await page.close();
    }
  });

  it('tells a compile what it acted on instead of the name as written', async () => {
    const page = await pageWith(`<button id="d"><img alt="tick"> Dismiss</button>`);
    try {
      const result = await executeAction(
        page,
        act({ action: 'click', selector: 'role=button[name="Dismiss"]' }),
        undefined,
        undefined,
        { measure: true },
      );
      expect(result.success).toBe(true);
      expect(result.targeting?.roleNameFallback).toContain('internal:has-text=');
    } finally {
      await page.close();
    }
  });

  it('never lets a shorter name reach a longer label', async () => {
    const page = await pageWith(`<button><img alt="tick"> Dismiss all</button>`);
    try {
      const resolution = await resolveRoleName(page, 'role=button[name="Dismiss"]', { graceMs: 0 });
      expect(resolution).toMatchObject({ selector: 'role=button[name="Dismiss"]' });
      expect(resolution.refusal).toBeUndefined();
      expect(await resolution.describeMiss!()).toContain('  - named "tick Dismiss all" (reads "Dismiss all")');
    } finally {
      await page.close();
    }
  });

  it('leaves a selector that matches as written alone', async () => {
    const page = await pageWith(`<button>Dismiss</button><button><img alt="tick"> Dismiss</button>`);
    try {
      expect(await resolveRoleName(page, 'role=button[name="Dismiss"]')).toEqual({ selector: 'role=button[name="Dismiss"]' });
    } finally {
      await page.close();
    }
  });

  it('waits as usual for a button that has not appeared yet', async () => {
    const page = await pageWith(`
      <script>
        setTimeout(() => {
          const b = document.createElement('button');
          b.textContent = 'Dismiss';
          b.onclick = () => { document.body.dataset.hit = 'late'; };
          document.body.appendChild(b);
        }, 300);
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'role=button[name="Dismiss"]' }));
      expect(result.success).toBe(true);
      expect(await hit(page)).toBe('late');
    } finally {
      await page.close();
    }
  });

  it('looks only inside the frame the action is scoped to', async () => {
    const inner = `<button onclick=&quot;parent.document.body.dataset.hit = 'inner'&quot;><img alt=&quot;tick&quot;> Dismiss</button>`;
    const page = await pageWith(`
      <button onclick="document.body.dataset.hit = 'outer'"><img alt="tick"> Dismiss</button>
      <iframe id="f" srcdoc="${inner}"></iframe>
      <iframe id="empty" srcdoc="<button>Cancel</button>"></iframe>`);
    try {
      await page.frameLocator('#f').locator('button').waitFor();
      await page.frameLocator('#empty').locator('button').waitFor();
      const result = await executeAction(page, act({ action: 'click', frame: '#f', selector: 'role=button[name="Dismiss"]' }));
      expect(result.success).toBe(true);
      expect(await hit(page)).toBe('inner');
      // The page's own Dismiss is not the empty frame's.
      const miss = await resolveRoleName(page.frameLocator('#empty'), 'role=button[name="Dismiss"]');
      expect(miss.selector).toBe('role=button[name="Dismiss"]');
      expect(await miss.describeMiss!()).toContain('  - named "Cancel"');
    } finally {
      await page.close();
    }
  });

  it('resolves the role-name segment of a scoped selector inside its scope', async () => {
    const page = await pageWith(`
      <button onclick="document.body.dataset.hit = 'page'"><img alt="tick"> Dismiss</button>
      <div role="dialog"><button onclick="document.body.dataset.hit = 'dialog'"><img alt="tick"> Dismiss</button></div>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: 'role=dialog >> role=button[name="Dismiss"]' }));
      expect(result.success).toBe(true);
      expect(await hit(page)).toBe('dialog');
    } finally {
      await page.close();
    }
  });

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

  it('keeps a name with an apostrophe parseable once the click adds its own filters', async () => {
    // DummyTicket's "I'm the only traveler" (survey run D, test 70).
    const page = await pageWith(`
      <style>.pi-check::before { content: "\\2714"; }</style>
      <button onclick="document.body.dataset.hit = 'solo'"><span class="pi-check"></span><span>I'm the only traveler</span></button>`);
    try {
      const result = await executeAction(page, act({ action: 'click', selector: `role=button[name="I'm the only traveler"]` }));
      expect(result.success).toBe(true);
      expect(await page.evaluate(() => document.body.dataset['hit'])).toBe('solo');
    } finally {
      await page.close();
    }
  });
});

describe('§2.35 a navigation that lands on an error page', () => {
  it('reports the HTTP status of the page it reached', async () => {
    const page = await context.newPage();
    try {
      await page.route('http://survey.test/**', (route) => route.fulfill({
        status: route.request().url().endsWith('/missing') ? 404 : 200,
        contentType: 'text/html',
        body: '<p>page</p>',
      }));
      const missing = await executeAction(page, act({ action: 'navigate', url: 'http://survey.test/missing' }));
      expect(missing.success).toBe(true);
      expect(missing.httpStatus).toBe(404);
      const found = await executeAction(page, act({ action: 'navigate', url: 'http://survey.test/input' }));
      expect(found.httpStatus).toBe(200);
    } finally {
      await page.close();
    }
  });

  it('treats an error page as the goal only when the step is about one', async () => {
    const { expectsErrorPage } = await import('../src/runner/step-executor.js');
    expect(expectsErrorPage('Navigate to input.xhtml')).toBe(false);
    expect(expectsErrorPage('Navigate to /status_codes/404')).toBe(true);
    expect(expectsErrorPage('Open the page and verify the Not Found message')).toBe(true);
    expect(expectsErrorPage('Go to the admin page and check it is forbidden')).toBe(true);
    expect(expectsErrorPage('Navigate to the 2024 report')).toBe(false);
  });
});

describe('§2.36 dropping on one side of the target', () => {
  it('reads the side from the model\'s words', () => {
    expect(one({ action: 'drag', selector: '#a', target: '#b', position: 'below' })).toMatchObject({ position: 'below' });
    expect(one({ action: 'drag', selector: '#a', target: '#b', dropPosition: 'after' })).toMatchObject({ position: 'below' });
    expect(one({ action: 'drag', selector: '#a', target: '#b', position: 'top' })).toMatchObject({ position: 'above' });
    expect(one({ action: 'drag', selector: '#a', target: '#b', position: 'somewhere' }).position).toBeUndefined();
    expect(one({ action: 'click', selector: '#a', position: 'below' }).position).toBeUndefined();
  });

  it('puts the item after the target in a list that sorts by which half the pointer is in', async () => {
    // A minimal pointer-driven sortable: on release, the dragged item goes
    // before or after the item under the pointer by which half it is in.
    const page = await pageWith(`
      <ul id="list" style="list-style: none; padding: 0; width: 200px">
        <li id="i1" style="height: 40px; border: 1px solid">Item 1</li>
        <li id="i2" style="height: 40px; border: 1px solid">Item 2</li>
        <li id="i3" style="height: 40px; border: 1px solid">Item 3</li>
      </ul>
      <script>
        let dragging = null;
        document.addEventListener('mousedown', (e) => { dragging = e.target.closest('li'); });
        document.addEventListener('mouseup', (e) => {
          const over = [...document.querySelectorAll('li')].find((li) => {
            const r = li.getBoundingClientRect();
            return li !== dragging && e.clientY >= r.top && e.clientY <= r.bottom;
          });
          if (dragging && over) {
            const r = over.getBoundingClientRect();
            over.parentNode.insertBefore(dragging, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
          }
          dragging = null;
        });
      </script>`);
    try {
      const result = await executeAction(page, act({ action: 'drag', selector: '#i1', target: '#i3', position: 'below' }));
      expect(result.success).toBe(true);
      expect(await page.evaluate(() => [...document.querySelectorAll('li')].map((li) => li.id))).toEqual(['i2', 'i3', 'i1']);
    } finally {
      await page.close();
    }
  });
});

describe('§2.37 a navigation that never gets a page says whether the site is up', () => {
  it('names a stall between the browser and a site that answers other clients', async () => {
    const http = await import('node:http');
    const { gotoWithDiagnosis } = await import('../src/browser/navigate-diagnosis.js');
    // Answers Node's fetch, never answers Chromium: the shape the survey's
    // herokuapp site had over HTTP/2.
    const server = http.createServer((req, res) => {
      if (/Chrome/.test(req.headers['user-agent'] ?? '')) return;
      res.end('<p>up</p>');
    });
    const port = await listenFetchable(server, '127.0.0.1');
    const page = await context.newPage();
    try {
      const err = await gotoWithDiagnosis(page, `http://127.0.0.1:${port}/`, { timeout: 2_000 }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Timeout 2000ms exceeded/);
      expect((err as Error).message).toMatch(/answers outside the browser \(HTTP 200 in \d+ ms\)/);
    } finally {
      await page.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('says the site is down when nothing answers it', async () => {
    const { diagnoseNavigationTimeout } = await import('../src/browser/navigate-diagnosis.js');
    const timeout = Object.assign(new Error('page.goto: Timeout 30000ms exceeded.'), { name: 'TimeoutError' });
    const note = await diagnoseNavigationTimeout('https://survey.test/', timeout, async () => ({ ok: false, reason: 'ECONNREFUSED' }));
    expect(note).toMatch(/does not answer outside the browser either \(ECONNREFUSED\)/);
  });

  it('adds nothing to other failures or to URLs it cannot ask', async () => {
    const { diagnoseNavigationTimeout } = await import('../src/browser/navigate-diagnosis.js');
    const probe = vi.fn(async () => ({ ok: true as const, status: 200, ms: 1 }));
    const timeout = Object.assign(new Error('page.goto: Timeout 30000ms exceeded.'), { name: 'TimeoutError' });
    expect(await diagnoseNavigationTimeout('https://survey.test/', new Error('net::ERR_NAME_NOT_RESOLVED'), probe)).toBeNull();
    expect(await diagnoseNavigationTimeout('about:blank', timeout, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('§2.38 "the page says" checks read by containment', () => {
  async function promptText(): Promise<string> {
    const { buildAssertionCodePrompt } = await import('../src/ai/prompts.js');
    const msg = buildAssertionCodePrompt('Confirm result', 'confirm explanation text', 'You clicked OK, confirm returned true.', '<p></p>', null);
    return typeof msg.content === 'string' ? msg.content : '';
  }

  it('tells the check writer to contain, and to read the element holding the whole text', async () => {
    const text = await promptText();
    expect(text).toMatch(/CONTAINS the expected text/);
    expect(text).toMatch(/exact equality only when the condition says "equals"/);
    expect(text).toMatch(/take the smallest element that shows it all, inside the part the condition names and nowhere else/);
    // It no longer searches every element on the page by `textContent`, which
    // holds script code and hidden text (SPEC-verify-checks.md, section 7).
    expect(text).not.toContain("querySelectorAll('body *')");
    expect(text).not.toContain('norm(el.textContent)');
  });

  it('tells the check writer to read only what a person sees, naming the reads that hold more', async () => {
    const text = await promptText();
    expect(text).toMatch(/Read only what a person sees there/);
    expect(text).toMatch(/`textContent` holds both/);
    expect(text).toMatch(/still hands back its text from `innerText`/);
    expect(text).toMatch(/hold every option, chosen or not/);
  });
});

describe('§2.39 a step that leaves the choice open is not a question', () => {
  it('tells the model to choose rather than ask', async () => {
    const { buildSystemPrompt, contentBlocksToText } = await import('../src/ai/prompts.js');
    const text = contentBlocksToText(buildSystemPrompt(''));
    expect(text).toMatch(/A step that leaves a choice OPEN is not unclear/);
    expect(text).toMatch(/tick two options/);
  });
});

describe('§2.40 a value from an unset environment variable is not typed', () => {
  const values = { bookstore_user: '$DEMOQA_USERNAME', price: '$5', site: 'demoqa' };
  const ctx = { known: new Set(Object.keys(values)), values };

  it('refuses a turn that names a placeholder still holding $NAME', async () => {
    const { checkTurnReferences } = await import('../src/runner/placeholder-substitution.js');
    const refusal = checkTurnReferences(
      [{ action: 'type', selector: '#userName', value: '{{bookstore_user}}', description: 'Enter the user name' }],
      ctx,
    );
    expect(refusal).toMatch(/still holds "\$DEMOQA_USERNAME"/);
    expect(refusal).toMatch(/Set DEMOQA_USERNAME in the project's \.env/);
  });

  it('refuses the literal too, and a check that expects it', async () => {
    const { checkTurnReferences } = await import('../src/runner/placeholder-substitution.js');
    expect(checkTurnReferences(
      [{ action: 'type', selector: '#userName', value: '$DEMOQA_USERNAME', description: 'Enter the user name' }],
      ctx,
    )).toMatch(/`\{\{bookstore_user\}\}`/);
    expect(checkTurnReferences(
      [{ action: 'assert', against: 'dom', condition: 'user name label', expected: '{{bookstore_user}}', description: 'User name shown' }],
      ctx,
    )).toMatch(/DEMOQA_USERNAME is not set/);
  });

  it('leaves resolved values and $-amounts alone', async () => {
    const { checkTurnReferences } = await import('../src/runner/placeholder-substitution.js');
    expect(checkTurnReferences(
      [
        { action: 'type', selector: '#q', value: '{{site}}', description: 'Search' },
        { action: 'type', selector: '#amount', value: '{{price}}', description: 'Enter the price' },
      ],
      ctx,
    )).toBeUndefined();
  });
});

describe('§2.41 clearing a field', () => {
  it('maps clear and its spellings onto type with an empty value', () => {
    expect(one({ action: 'clear', selector: '#name' })).toMatchObject({ action: 'type', value: '' });
    expect(one({ action: 'clearField', selector: '#name' })).toMatchObject({ action: 'type', value: '' });
    expect(one({ action: 'clear_input', selector: '#name' })).toMatchObject({ action: 'type', value: '' });
  });

  it('empties a field that holds text', async () => {
    const page = await pageWith('<input id="name" value="Koushik Chatterjee">');
    try {
      await executeAction(page, one({ action: 'clear', selector: '#name' }));
      expect(await page.inputValue('#name')).toBe('');
    } finally {
      await page.close();
    }
  });
});

describe('§2.43 label marks around a checked text', () => {
  it('tells the check writer that marks around a label are not part of it', async () => {
    const { buildAssertionCodePrompt } = await import('../src/ai/prompts.js');
    const msg = buildAssertionCodePrompt('Field shown', 'field label', 'Hull colour', '<label>Hull colour *</label>', null);
    const text = typeof msg.content === 'string' ? msg.content : '';
    expect(text).toMatch(/A mark around a label is not part of its text/);
    // Both directions of a check about the mark keep it, or the model strips
    // the `*` from "the asterisk is gone" and passes it.
    expect(text).toMatch(/The exception is a check about a mark or what it means/);
    expect(text).toMatch(/shown, gone or no longer there/);
    expect(text).toMatch(/Nothing overrides your verdict/);
  });

  /** Run one check step on a real page, with the check code the model "wrote". */
  async function runCheck(html: string, step: string, check: Record<string, unknown>, code: string) {
    const { executeStep } = await import('../src/runner/step-executor.js');
    const { DEFAULT_BROWSER_DIMENSIONS } = await import('../src/config/browser-dimensions.js');
    const page = await pageWith(html);
    try {
      const stepReply = JSON.stringify({ actions: [{ action: 'assert', against: 'dom', ...check }], reasoning: 'Check the text.' });
      const codeReply = JSON.stringify({ code });
      const isCodeRequest = (messages: Array<{ content: unknown }>) =>
        messages.some((m) => JSON.stringify(m.content).includes('evaluates the following assertion'));
      const aiClient = {
        complete: vi.fn((messages: Array<{ content: unknown }>) =>
          Promise.resolve({ text: isCodeRequest(messages) ? codeReply : stepReply, model: 'test' })),
      };
      return await executeStep(1, 1, step, {
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
    } finally {
      await page.close();
    }
  }

  /** Check code that compares the label's text exactly. */
  const exactLabel = (selector: string, want: string) =>
    `(() => { const t = document.querySelector('${selector}').textContent.replace(/\\s+/g, ' ').trim(); return { pass: t === '${want}', actual: t }; })()`;

  /** Check code that strips the marks around the label first, as the prompt asks. */
  const markFreeLabel = (selector: string, want: string) =>
    `(() => { const t = document.querySelector('${selector}').textContent.replace(/\\s+/g, ' ').trim(); const bare = t.replace(/^[\\s*:•·|]+|[\\s*:•·|]+$/g, ''); return { pass: bare === '${want}', actual: t }; })()`;

  /** A check that wants its text absent. */
  const absent = (selector: string, text: string) =>
    `(() => { const t = document.querySelector('${selector}').textContent.trim(); return { pass: !t.includes('${text}'), actual: t }; })()`;

  it('passes a label check whose code strips the marks, however the check is worded', async () => {
    for (const condition of ['return date field label', "label of the return date field, which can't be left blank"]) {
      const result = await runCheck(
        '<label for="ret">Return date *</label><input id="ret" required>',
        'Verify a return date field is shown',
        { condition, expected: 'Return date', description: 'Return date field is shown' },
        markFreeLabel('label', 'Return date'),
      );
      expect(result.error, condition).toBeUndefined();
      expect(result.status, condition).toBe('passed');
    }
  });

  // Every case is a check whose own code correctly said "fail", and the step
  // must fail with it. A rule after the check used to turn such failures into
  // passes when the page's text matched the expected text without its marks
  // (issue 35). The first row is the §2.43 situation with an exact comparison:
  // it fails now, because stripping the marks is the check code's job (see the
  // prompt test above), not something done to its verdict afterwards.
  const failing: Array<{ name: string; html: string; step: string; check: Record<string, unknown>; code: string; got: string }> = [
    {
      name: 'an exact comparison that read a mark',
      html: '<label for="ret">Return date *</label><input id="ret" required>',
      step: 'Verify a return date field is shown',
      check: { condition: 'return date field label', expected: 'Return date', description: 'Return date field is shown' },
      code: exactLabel('label', 'Return date'),
      got: 'Return date *',
    },
    {
      name: 'a check for the asterisk on a field that lost it (#35)',
      html: '<label for="email">Email</label><input id="email">',
      step: 'Verify the Email label shows the required asterisk',
      check: { condition: 'Email label shows the required asterisk', expected: 'Email *', description: 'Email label is marked required' },
      code: exactLabel('label', 'Email *'),
      got: 'Email',
    },
    {
      name: 'a check that the asterisk is gone, worded without "not" (#35)',
      html: '<label for="email">Email *</label><input id="email" required>',
      step: 'Verify the Email field is optional now',
      check: { condition: 'asterisk is gone from the Email label', expected: 'Email', description: 'Email label is plain' },
      code: exactLabel('label', 'Email'),
      got: 'Email *',
    },
    ...['Pending', '• Pending'].map((shown) => ({
      name: `"is not Pending" on ${shown} (#35)`,
      html: `<p id="status">${shown}</p>`,
      step: 'Verify the order status is not Pending',
      check: { condition: 'order status is not Pending', expected: 'Pending', description: 'Order status is not Pending' },
      code: absent('#status', 'Pending'),
      got: shown,
    })),
    {
      name: 'a negative check worded without "not" (#35)',
      html: '<p id="status">• Pending</p>',
      step: 'Verify the order status has moved on from Pending',
      check: { condition: 'order status has changed from Pending', expected: 'Pending', description: 'Order status changed' },
      code: absent('#status', 'Pending'),
      got: '• Pending',
    },
  ];

  it.each(failing)('keeps the check code\'s failure: $name', async ({ html, step, check, code, got }) => {
    const result = await runCheck(html, step, check, code);
    expect(result.status).toBe('failed');
    expect(result.error).toContain(`got "${got}"`);
  });
});

describe('§2.48 content added outside <body>', () => {
  it('reaches the snapshot, frames included, and can be clicked through its frame path', async () => {
    const page = await pageWith('<iframe id="inline" srcdoc="<button>Inside body frame</button>"></iframe><p>Page text</p>');
    try {
      // What a full-screen ad script does: a fixed overlay appended to <html>,
      // beside <body>, holding a frame with its own Close button.
      await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const ins = doc.createElement('ins');
        ins.id = 'overlay_host';
        ins.style.cssText = 'position:fixed;inset:0;display:block;background:#fff;z-index:9';
        const frame = doc.createElement('iframe');
        frame.id = 'overlay_frame';
        frame.style.cssText = 'width:600px;height:300px;border:0';
        frame.srcdoc = '<button id="dismiss" onclick="parent.document.getElementById(\'overlay_host\').remove()">Close</button>';
        ins.appendChild(frame);
        doc.documentElement.appendChild(ins);
      });
      await page.frameLocator('#overlay_frame').locator('#dismiss').waitFor();

      const snapshot = await captureDomSnapshot(page);
      expect(snapshot).toContain('Inside body frame');
      expect(snapshot).toContain('Page text');
      expect(snapshot).toMatch(/<iframe[^>]*id="overlay_frame"[^>]*> <!-- #overlay_frame -->/);
      expect(snapshot).toContain('Close');
      // Each frame's content sits under its own <iframe>, not swapped.
      expect(snapshot.indexOf('Inside body frame')).toBeLessThan(snapshot.indexOf('id="overlay_frame"'));
      expect(snapshot.indexOf('id="overlay_frame"')).toBeLessThan(snapshot.indexOf('Close'));

      const result = await executeAction(page, act({ action: 'click', selector: '#dismiss', frame: '#overlay_frame' }));
      expect(result.success).toBe(true);
      expect(await page.locator('#overlay_host').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
