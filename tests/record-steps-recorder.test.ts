/**
 * Record Steps — the page script and the recorder, against a real Chromium
 * (stories/steptix-record-steps.md §Tests, "The page script against the
 * fixture app").
 *
 * Real, because every claim here is a browser behaviour: which events a trusted
 * click raises and in what order, whether `preventDefault` on pointerdown stops
 * the page's own handler, what reaches a binding and what does not. The input
 * is Playwright's (trusted events, as a person's are), the pages are served by
 * a tiny local server so every navigation makes a NEW document — which is what
 * the init script has to survive — and the assertions on secrets are made on
 * every raw message the binding received, not on what the recorder kept.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import Jimp from 'jimp';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PageTracker, type BrowserSession } from '../src/browser/manager.js';
import { StepRecorder, classifyHistoryMove, historyBehind, type KnownSecret } from '../src/recorder/step-recorder.js';
import type { Box, RecordedAction } from '../src/recorder/types.js';
import { addLogCallback } from '../src/utils/logger.js';

const PAGES: Record<string, string> = {
  '/board.html': `<!doctype html><html><head><title>Board</title></head><body>
    <section aria-label="To do" id="todo"><h2>To do</h2>
      <div id="card" draggable="true" style="width:120px;height:30px">Invoice 1043</div></section>
    <section aria-label="Paid" id="paid" style="min-height:80px"><h2>Paid</h2></section>
    <ul id="list" style="list-style:none;padding:0;user-select:none">
      <li id="one" style="height:40px">One</li><li id="two" style="height:40px">Two</li><li id="three" style="height:40px">Three</li>
    </ul>
    <p id="prose">Some words to select across</p><p id="prose2">and some more words</p>
    <script>
      const card = document.getElementById('card');
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'));
      const paid = document.getElementById('paid');
      paid.addEventListener('dragover', (e) => e.preventDefault());
      paid.addEventListener('drop', (e) => { e.preventDefault(); paid.appendChild(card); });
      let dragging = null;
      document.getElementById('list').addEventListener('pointerdown', (e) => { dragging = e.target.closest('li'); });
      document.addEventListener('pointerup', (e) => {
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('li');
        if (dragging && over && over !== dragging) over.after(dragging);
        dragging = null;
      });
    </script></body></html>`,
  '/spa.html': `<!doctype html><html><head><title>SPA</title></head><body>
    <button id="push" onclick="history.pushState({v:2}, '', '?view=2')">Show view 2</button>
    <button id="script-back" onclick="history.back()">In-page back</button>
    </body></html>`,
  '/form.html': `<!doctype html><html><head><title>Form</title></head><body>
    <nav aria-label="Main menu"><a href="/other.html" id="to-other">Reports</a>
      <a href="/other.html" target="_blank" id="new-tab">Open in new tab</a></nav>
    <main>
      <h1>Sign in</h1>
      <form id="login" onsubmit="event.preventDefault(); window.submitted = true;">
        <label for="email">Email</label><input id="email" name="email" type="email">
        <label for="pw">Password</label><input id="pw" name="pw" type="password">
        <input id="token" name="api_token" type="text" placeholder="API token">
        <input id="search" type="search" aria-label="Search accounts">
        <label>Frequency <select id="freq"><option>Weekly</option><option>Monthly</option></select></label>
        <input type="checkbox" id="cash"><label for="cash">Cash</label>
        <button type="submit" id="signin">Sign in</button>
      </form>
      <section aria-labelledby="pm-h"><h2 id="pm-h">Payment method</h2>
        <p id="pm-text">Paid in cash</p>
        <button id="panel-button" onclick="window.panelClicked = true">Change</button>
      </section>
      <table><thead><tr><th>Account</th><th>Action</th></tr></thead>
        <tbody><tr><td>Everyday</td><td><button class="icon-trash" aria-label="Delete"><svg width="10" height="10"></svg></button></td></tr></tbody>
      </table>
      <iframe id="pay-frame" name="pay" title="Payment" src="/frame.html"></iframe>
    </main></body></html>`,
  '/other.html': `<!doctype html><html><head><title>Other</title></head><body>
    <h1>Other page</h1><button id="other-button">Continue</button></body></html>`,
  '/frame.html': `<!doctype html><html><body><label for="card">Card number</label><input id="card" name="card"></body></html>`,
  // A password box whose LABEL does not say password, behind a "show" eye —
  // so only the recorder's memory of its type can keep it secret.
  '/eye.html': `<!doctype html><html><head><title>Eye</title></head><body>
    <form onsubmit="event.preventDefault()">
      <label for="mw">Memorable word</label><input id="mw" type="password">
      <button type="button" id="eye" onclick="const f = document.getElementById('mw'); f.type = f.type === 'password' ? 'text' : 'password'">Show</button>
      <label for="pw-text">Password</label><input id="pw-text" type="text">
      <input id="plain" name="nickname">
      <p id="note">A note</p>
    </form></body></html>`,
  // Fields in solid colours beside a button, so a crop can be read for them.
  '/paint.html': `<!doctype html><html><head><title>Paint</title></head><body style="margin:0;background:#fff">
    <div style="padding:20px">
      <label for="mw2" style="display:block">Memorable word</label>
      <input id="mw2" type="password" style="display:block;width:180px;height:30px;border:0;background:#00ff00;color:#00ff00">
      <button type="button" id="eye2" style="display:block" onclick="const f = document.getElementById('mw2'); f.type = f.type === 'password' ? 'text' : 'password'">Show</button>
      <input id="tok2" name="reference" style="display:block;width:180px;height:30px;border:0;background:#0000ff;color:#0000ff">
      <button type="button" id="near" style="display:block">Near</button>
    </div></body></html>`,
  '/actions.html': `<!doctype html><html><head><title>Actions</title></head><body>
    <form onsubmit="event.preventDefault()">
      <label for="up" id="up-label" style="display:inline-block;padding:10px;border:1px solid">Upload statement</label>
      <input id="up" type="file" style="display:none">
      <input id="sel" value="some text here to select" style="width:260px">
      <button type="button" id="beside" style="margin-left:40px">Beside</button>
    </form>
    <div id="editor" contenteditable="true" style="min-height:60px;border:1px solid" aria-label="Message"></div>
    <nav aria-label="Main navigation"><a href="#tx" id="tx-link">💳 Transactions</a> <a href="#next" id="next-link">Next ›</a></nav>
    <p id="long"></p>
    <button id="elsewhere">Elsewhere</button>
    </body></html>`,
  '/shadow.html': `<!doctype html><html><head><title>Shadow</title></head><body>
    <div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<label>Plan <select id="plan"><option>Basic</option><option>Premium</option></select></label>'
        + '<label>Nickname <input id="nick"></label>';
    </script></body></html>`,
  '/nav.html': `<!doctype html><html><head><title>Nav</title></head><body>
    <a id="nocontent" href="/204">No content</a>
    <a id="slow" href="/slow">Slow report</a>
    <button id="later-replace" onclick="setTimeout(() => history.replaceState({}, '', '?view=' + Date.now()), 400)">Load more</button>
    </body></html>`,
  // A "show" toggle that REPLACES the password box with a new text box (Vue
  // v-if/v-else, Angular *ngIf), a "reveal" that shows the value in a span,
  // and page text holding a secret the server knows — each in its own solid
  // colour, so a crop can be read for them.
  '/swap.html': `<!doctype html><html><head><title>Swap</title></head><body style="margin:0;background:#fff">
    <div style="padding:20px">
      <label for="mw3" style="display:block">Memorable word</label>
      <input id="mw3" type="password" style="display:block;width:180px;height:30px;border:0;background:#00ff00;color:#00ff00">
      <button type="button" id="swap" style="display:block" onclick="
        const old = document.getElementById('mw3'); const n = document.createElement('input');
        n.id = 'mw3'; n.type = old.type === 'password' ? 'text' : 'password'; n.value = old.value;
        n.setAttribute('style', old.getAttribute('style')); old.replaceWith(n);">Show</button>
      <button type="button" id="reveal" style="display:block" onclick="document.getElementById('shown').textContent = document.getElementById('mw3').value">Reveal</button>
      <p>Your word: <span id="shown" style="background:#0000ff;color:#0000ff;font-size:20px"></span></p>
      <p>Key on file: <span id="known-shown" style="background:#ff00ff;color:#ff00ff;font-size:20px">known-TEXT-42</span></p>
      <button type="button" id="near3" style="display:block">Near</button>
    </div></body></html>`,
  // A password box inside an iframe with a thick border and padding.
  '/framed.html': `<!doctype html><html><head><title>Framed</title></head><body style="margin:0;background:#fff">
    <button id="near4" style="margin:10px">Near</button><br>
    <iframe id="bordered" src="/framed-inner.html" style="border:24px solid #ccc;padding:16px;width:400px;height:120px"></iframe>
    </body></html>`,
  '/framed-inner.html': `<!doctype html><html><body style="margin:8px;background:#fff">
    <input id="fpw" type="password" style="width:200px;height:30px;border:0;background:#00ff00;color:#00ff00">
    <button id="feye" onclick="fpw.type = fpw.type === 'password' ? 'text' : 'password'">Show</button>
    </body></html>`,
  // A chat composer: Enter sends the message and empties the box.
  '/chat.html': `<!doctype html><html><head><title>Chat</title></head><body>
    <ul id="log"></ul>
    <div id="composer" contenteditable="true" role="textbox" aria-label="Message" style="min-height:40px;border:1px solid"></div>
    <button id="other">Other</button>
    <script>
      const composer = document.getElementById('composer');
      composer.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        const li = document.createElement('li');
        li.textContent = composer.innerText;
        document.getElementById('log').appendChild(li);
        composer.innerHTML = '';
      });
    </script></body></html>`,
  '/labels.html': `<!doctype html><html><head><title>Labels</title></head><body>
    <label for="bp">Boarding pass number</label><input id="bp">
    <label for="er">Email for password reset</label><input id="er">
    <label for="otc">One-time code</label><input id="otc">
    <label for="pcode">Passcode</label><input id="pcode">
    <input id="dots" name="memo" style="-webkit-text-security: disc">
    <label for="save" id="lab-save">Save changes</label>
    <button id="save" onclick="window.saves = (window.saves || 0) + 1">Save</button>
    <a id="enc" href="/other.html?token=p%40ss%20w%2Frd%2B1" onclick="event.preventDefault()">Open report</a>
    <input id="phrase" name="note">
    <pre id="pre">key: open  sesame</pre>
    <input id="kw" aria-label="Search by keyword">
    <h2 id="results">Results for shoes</h2>
    </body></html>`,
};

let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let session: BrowserSession;
let actions: RecordedAction[];
let picks: boolean[];
let raw: unknown[];
let recorder: StepRecorder;
let known: KnownSecret[];

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]!;
    // A link that goes nowhere: the page asked, and nothing ever commits.
    if (route === '/204') {
      res.statusCode = 204;
      res.end();
      return;
    }
    // A link whose answer takes a while: long enough to be cut short.
    if (route === '/slow') {
      const timer = setTimeout(() => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>Slow</title><h1>Slow</h1>');
      }, 3_000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const body = PAGES[route];
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  // A `/slow` answer the browser walked away from may still hold its socket.
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function newRecorder(
  opts: { sendScreenshots?: boolean; typedNavigationWindowMs?: number; historyCausedWindowMs?: number } = {},
): StepRecorder {
  return new StepRecorder({
    browser: session,
    sendScreenshots: opts.sendScreenshots ?? false,
    knownSecrets: () => known,
    onAction: (a) => actions.push(a),
    onPick: (armed) => picks.push(armed),
    tap: (m) => raw.push(m),
    ...(opts.typedNavigationWindowMs !== undefined && { typedNavigationWindowMs: opts.typedNavigationWindowMs }),
    ...(opts.historyCausedWindowMs !== undefined && { historyCausedWindowMs: opts.historyCausedWindowMs }),
  });
}

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  page = await context.newPage();
  const pageTracker = new PageTracker(page);
  context.on('page', (p) => pageTracker.addPage(p));
  session = { browser, context, page, pageTracker };
  actions = [];
  picks = [];
  raw = [];
  known = [];
  await page.goto(`${origin}/form.html`);
});

afterEach(async () => {
  await recorder?.cancel().catch(() => {});
  await context?.close().catch(() => {});
});

/** Wait until `n` actions have been recorded (they arrive asynchronously). */
async function actionsReach(n: number, timeoutMs = 5_000): Promise<RecordedAction[]> {
  const until = Date.now() + timeoutMs;
  while (actions.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  return actions;
}

describe('the page script — one described action per gesture', () => {
  it('describes a click on a link by role, name and the landmark it sits in', async () => {
    recorder = newRecorder();
    await recorder.start();
    // A click that does not navigate: prevent it in the page.
    await page.evaluate(`document.getElementById('to-other').addEventListener('click', (e) => e.preventDefault())`);
    await page.click('#to-other');
    const [click] = await actionsReach(1);
    expect(click).toMatchObject({ id: 'a1', kind: 'click', tab: 'main' });
    expect(click!.target).toMatchObject({ tag: 'a', role: 'link', name: 'Reports' });
    expect(click!.target!.context?.landmark).toBe('navigation "Main menu"');
    expect(click!.target!.selector).toBe('#to-other');
    expect(click!.summary).toBe('Clicked link "Reports"');
  }, 30_000);

  it('turns keystrokes into ONE type action per field, with the final value', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.type('#email', 'demo@securebank.com');
    await page.click('#search'); // moving on finishes the email field
    await page.fill('#search', 'Everyday');
    const done = await recorder.stop();
    const typed = done.filter((a) => a.kind === 'type');
    expect(typed.map((a) => [a.target?.name, a.value])).toEqual([
      ['Email', 'demo@securebank.com'],
      ['Search accounts', 'Everyday'],
    ]);
    // The click into the search box is reported as focus only — the model drops it.
    expect(done.find((a) => a.kind === 'click')).toMatchObject({ focusOnly: true });
  }, 30_000);

  it('never lets a secret field\'s value reach the binding — by type, and by name', async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.type('#pw', 'hunter2-SECRET');
    await page.fill('#token', 'tok-ABCDEF-123');
    await page.click('#signin');
    const done = await recorder.stop();
    const everything = JSON.stringify(raw);
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('tok-ABCDEF');
    const typed = done.filter((a) => a.kind === 'type');
    expect(typed).toHaveLength(2);
    for (const a of typed) {
      expect(a.secret).toBe(true);
      expect(a.value).toBeUndefined();
      expect(a.summary).toContain('***');
    }
    // The name-detected token box shows its value in clear, so it gets no crop.
    expect(typed.find((a) => a.target?.nameAttr === 'api_token')?.crop).toBeUndefined();
  }, 30_000);

  it('withholds a typed value that equals a secret the run already knows', async () => {
    known = [{ name: 'password', value: 'demo-pass-1' }];
    recorder = newRecorder();
    await recorder.start();
    await page.fill('#email', 'demo-pass-1');
    const done = await recorder.stop();
    expect(done[0]).toMatchObject({ kind: 'type', secret: true, knownSecret: 'password' });
    expect(done[0]!.value).toBeUndefined();
  }, 30_000);

  it('a click on a checkbox or its label is the ACTION; what it did is an event that follows', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.selectOption('#freq', { label: 'Monthly' }); // no pointer: the choice alone
    await page.check('#cash');
    await page.click('label[for="cash"]'); // unticks through the label
    await page.click('label[for="cash"]'); // and ticks again
    const done = await actionsReach(7);
    expect(done.map((a) => [a.kind, a.action])).toEqual([
      ['select', false],
      ['click', true], ['tick', false],
      ['click', true], ['untick', false],
      ['click', true], ['tick', false],
    ]);
    expect(done[0]).toMatchObject({ options: ['Monthly'] });
    expect(done[0]!.target?.name).toBe('Frequency');
    expect(done[1]!.target).toMatchObject({ role: 'checkbox', name: 'Cash' });
    expect(done[2]!.target).toMatchObject({ role: 'checkbox', name: 'Cash' });
    // The label was clicked — once: the click the browser passes on to the
    // checkbox is not a second action.
    expect(done[5]!.target).toMatchObject({ tag: 'label', name: 'Cash' });
    expect(done[6]!.viaLabel).toMatchObject({ tag: 'label', name: 'Cash' });
  }, 30_000);

  it('Escape is not recorded; Tab and Enter are actions, typing is an event', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.click('#email');
    await page.keyboard.type('a@b.test');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    const done = await actionsReach(3);
    await new Promise((r) => setTimeout(r, 400));
    expect(actions.map((a) => [a.kind, a.action])).toEqual([['click', true], ['type', false], ['key', true]]);
    expect(actions[2]).toMatchObject({ key: 'Tab' });
    expect(done).toHaveLength(3);
  }, 30_000);

  it("a script-dispatched click is not the author's and is not recorded", async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.evaluate('document.getElementById("signin").click()');
    await page.evaluate(`document.getElementById('to-other').addEventListener('click', (e) => e.preventDefault())`);
    await page.click('#to-other');
    await actionsReach(1);
    expect(actions.map((a) => a.target?.name)).toEqual(['Reports']);
  }, 30_000);

  it('records Enter after typing as the typing, then the key', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.click('#search');
    await page.keyboard.type('Everyday');
    await page.keyboard.press('Enter');
    const done = await actionsReach(3);
    await new Promise((r) => setTimeout(r, 200));
    // The browser's implicit-submission click on Sign in IS the Enter: one
    // action, not two.
    expect(done.map((a) => a.kind)).toEqual(['click', 'type', 'key']);
    expect(done[2]).toMatchObject({ key: 'Enter' });
    expect(await page.evaluate('window.submitted === true')).toBe(true);
  }, 30_000);

  it('names an icon-only button by its label and the row it sits in', async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.click('button.icon-trash');
    const [click] = await actionsReach(1);
    expect(click!.target).toMatchObject({ role: 'button', name: 'Delete' });
    expect(click!.target!.context).toMatchObject({ row: 'Everyday', column: 'Action' });
    // Decision 6: a crop of the neighbourhood, with the box stated.
    expect(click!.crop?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(click!.crop!.boxInCrop.width).toBeGreaterThan(0);
  }, 30_000);

  it('describes an action inside an iframe with the frame it happened in', async () => {
    recorder = newRecorder();
    await recorder.start();
    const frame = page.frame({ name: 'pay' })!;
    await frame.fill('#card', '4111');
    const done = await recorder.stop();
    expect(done[0]).toMatchObject({ kind: 'type', value: '4111' });
    expect(done[0]!.target).toMatchObject({ name: 'Card number', inFrame: true });
    expect(done[0]!.frame).toMatchObject({ name: 'pay', element: { id: 'pay-frame', title: 'Payment' } });
  }, 30_000);
});

describe('pick mode (Add check)', () => {
  it('swallows the click — the page\'s own handler never runs — and reports a check', async () => {
    recorder = newRecorder();
    await recorder.start();
    expect(recorder.armPick()).toBe(true);
    await page.click('#pm-text');
    const [check] = await actionsReach(1);
    expect(check).toMatchObject({ kind: 'check' });
    expect(check!.check).toMatchObject({ text: 'Paid in cash' });
    expect(check!.check!.container).toMatchObject({ name: 'Payment method' });
    expect(picks).toEqual([true, false]);

    // The next click is an ordinary one again — and a picked BUTTON never ran.
    recorder.armPick();
    await page.click('#panel-button');
    await actionsReach(2);
    expect(await page.evaluate('window.panelClicked === true')).toBe(false);
    await page.click('#panel-button');
    await actionsReach(3);
    expect(await page.evaluate('window.panelClicked === true')).toBe(true);
    expect(actions.map((a) => a.kind)).toEqual(['check', 'check', 'click']);
  }, 30_000);
});

describe('tabs and navigation', () => {
  it('records a new tab, and the actions in it carry its label', async () => {
    recorder = newRecorder();
    await recorder.start();
    const popupPromise = context.waitForEvent('page');
    await page.click('#new-tab');
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    await popup.click('#other-button');
    const done = await actionsReach(3);
    expect(done.map((a) => a.kind)).toEqual(['click', 'tab', 'click']);
    expect(done[1]).toMatchObject({ tabEvent: 'opened', tab: 'page:2', url: `${origin}/other.html` });
    expect(done[2]).toMatchObject({ tab: 'page:2' });
    // Following the author: the session's active tab is where they are.
    expect(session.pageTracker.getActive()).toBe(popup);
    // The popup's own first load is part of the click, not a typed navigation.
    expect(done.some((a) => a.kind === 'navigate')).toBe(false);
  }, 30_000);

  it('records a navigation nothing on the page asked for, and not one a link click made', async () => {
    recorder = newRecorder({ typedNavigationWindowMs: 200 });
    await recorder.start();
    await page.click('#to-other'); // a link: the page asked for this one
    await page.waitForURL(/other\.html$/);
    await new Promise((r) => setTimeout(r, 400));
    await page.goto(`${origin}/form.html`); // browser-initiated, like the address bar
    await page.waitForLoadState('domcontentloaded');
    const done = await actionsReach(2);
    expect(done.map((a) => a.kind)).toEqual(['click', 'navigate']);
    expect(done[1]).toMatchObject({ url: `${origin}/form.html` });
  }, 30_000);
});

describe('after Stop the script is inert', () => {
  it('sends nothing but a hello from a new document, and records nothing', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.click('#cash');
    await actionsReach(1);
    await recorder.stop();
    const before = actions.length;
    raw.length = 0;

    await page.goto(`${origin}/other.html`); // a NEW document runs the init script again
    await page.click('#other-button');
    await page.goBack();
    await page.fill('#email', 'after@stop.test');
    await page.click('#signin');
    await new Promise((r) => setTimeout(r, 300));

    expect(actions.length).toBe(before);
    expect(raw.every((m) => (m as { type?: string }).type === 'hello')).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('after@stop.test');
  }, 30_000);

  it('a second recording on the same context works (the binding is reused, not re-exposed)', async () => {
    recorder = newRecorder();
    await recorder.start();
    await recorder.stop();
    recorder = newRecorder();
    await recorder.start();
    await page.fill('#email', 'second@run.test');
    const done = await recorder.stop();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: 'a1', value: 'second@run.test' });
  }, 30_000);
});

describe('drag (decision 4: a click or a DRAG is an action)', () => {
  beforeEach(async () => {
    await page.goto(`${origin}/board.html`);
  });

  it('an HTML drag-and-drop is ONE drag action: what was dragged, and what it was dropped on', async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.locator('#card').dragTo(page.locator('#paid'));
    const [drag] = await actionsReach(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(actions).toHaveLength(1);
    expect(drag).toMatchObject({ kind: 'drag', action: true });
    expect(drag!.target).toMatchObject({ text: 'Invoice 1043' });
    expect(drag!.dropTarget?.context?.landmark ?? drag!.dropTarget?.name).toMatch(/Paid/);
    expect(drag!.summary).toMatch(/^Dragged .*Invoice 1043.* onto /);
    // Two pictures: where it was picked up, and where it went.
    expect(drag!.crop?.dataUrl).toMatch(/^data:image\/png/);
    expect(drag!.dropCrop?.dataUrl).toMatch(/^data:image\/png/);
    expect(await page.evaluate('document.getElementById("card").parentElement.id')).toBe('paid');
  }, 30_000);

  it('a pointer drag onto another element is a drag — and not also a click', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.locator('#one').dragTo(page.locator('#three'));
    await actionsReach(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.map((a) => a.kind)).toEqual(['drag']);
    expect(actions[0]!.target?.text).toBe('One');
    expect(actions[0]!.dropTarget?.text).toBe('Three');
    expect(await page.evaluate('[...document.querySelectorAll("li")].map((l) => l.id).join()')).toBe('two,three,one');
  }, 30_000);

  it('press, move and release on the SAME element is not a drag; dragging across text is not either', async () => {
    recorder = newRecorder();
    await recorder.start();
    const box = (await page.locator('#two').boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 20, { steps: 5 });
    await page.mouse.up();
    // Selecting text across two paragraphs.
    const a = (await page.locator('#prose').boundingBox())!;
    const b = (await page.locator('#prose2').boundingBox())!;
    await page.mouse.move(a.x + 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 400));
    expect(actions.some((x) => x.kind === 'drag')).toBe(false);
  }, 30_000);
});

describe('the browser\'s Back, Forward and Refresh (Chromium: read off the tab\'s own history)', () => {
  /**
   * Driven with `page.goBack()` / `goForward()` / `reload()`. Those are
   * Playwright calls, not the toolbar — but over CDP they are the same
   * browser-initiated navigations the toolbar makes (`Page.navigateToHistoryEntry`,
   * `Page.reload`): nothing in the page asks for them, so no
   * `frameRequestedNavigation` fires, and the tab's navigation history moves
   * exactly as it does for a person. That history is what the recorder reads.
   */
  it('records back, forward and reload — and not one of them as a typed navigation', async () => {
    recorder = newRecorder({ typedNavigationWindowMs: 100, historyCausedWindowMs: 100 });
    await recorder.start();
    await page.click('#to-other'); // a link: the page's own navigation
    await page.waitForURL(/other\.html$/);
    await new Promise((r) => setTimeout(r, 250));
    await page.goBack();
    await actionsReach(2);
    await new Promise((r) => setTimeout(r, 250));
    await page.goForward();
    await actionsReach(3);
    await new Promise((r) => setTimeout(r, 250));
    await page.reload();
    await actionsReach(4);
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.map((a) => [a.kind, a.action])).toEqual([
      ['click', true], ['back', true], ['forward', true], ['reload', true],
    ]);
    expect(actions[1]).toMatchObject({ url: `${origin}/form.html`, summary: `Went back to ${origin}/form.html` });
    expect(actions[2]).toMatchObject({ url: `${origin}/other.html` });
    expect(actions[3]).toMatchObject({ url: `${origin}/other.html`, summary: `Reloaded the page — ${origin}/other.html` });
  }, 30_000);

  /**
   * `Page.frameNavigated` can arrive before the browser has put the
   * navigation in the history the recorder reads. Seen under load: a link
   * click's first read still showed the page it left, and the Back after it
   * was recorded as a Reload. Here every commit's first read is made to lag
   * that way, on purpose — the recorder must read again until it catches up.
   */
  it('a history read that lags its commit is read again: link, Back, Forward, Reload and the same address again stay what they were', async () => {
    const realSession = context.newCDPSession.bind(context);
    context.newCDPSession = (async (target: Page) => {
      const cdp = await realSession(target);
      const send = cdp.send.bind(cdp) as (method: string, params?: object) => Promise<unknown>;
      let lastRead: unknown = null;
      let lagNext = false;
      cdp.on('Page.frameNavigated', (e: { frame: { parentId?: string } }) => {
        if (!e.frame.parentId) lagNext = true;
      });
      cdp.on('Page.navigatedWithinDocument', () => (lagNext = true));
      (cdp as { send: unknown }).send = async (method: string, params?: object) => {
        if (method !== 'Page.getNavigationHistory') return send(method, params);
        if (lagNext && lastRead) {
          lagNext = false;
          return lastRead;
        }
        lastRead = await send(method, params);
        return lastRead;
      };
      return cdp;
    }) as typeof context.newCDPSession;

    recorder = newRecorder({ typedNavigationWindowMs: 100, historyCausedWindowMs: 100 });
    await recorder.start();
    await page.click('#to-other'); // a link: the page's own navigation
    await page.waitForURL(/other\.html$/);
    await new Promise((r) => setTimeout(r, 250));
    await page.goBack();
    await actionsReach(2);
    await new Promise((r) => setTimeout(r, 250));
    await page.goForward();
    await actionsReach(3);
    await new Promise((r) => setTimeout(r, 250));
    await page.reload();
    await actionsReach(4);
    await new Promise((r) => setTimeout(r, 250));
    await page.goto(`${origin}/other.html`); // the address it is already at
    await new Promise((r) => setTimeout(r, 500));
    expect(actions.map((a) => a.kind)).toEqual(['click', 'back', 'forward', 'reload']);
  }, 30_000);

  it('a same-document Back (a pushState entry) is a back too', async () => {
    await page.goto(`${origin}/spa.html`);
    recorder = newRecorder({ typedNavigationWindowMs: 100, historyCausedWindowMs: 100 });
    await recorder.start();
    await page.click('#push');
    await new Promise((r) => setTimeout(r, 250));
    await page.goBack();
    await actionsReach(2);
    await new Promise((r) => setTimeout(r, 200));
    expect(actions.map((a) => a.kind)).toEqual(['click', 'back']);
  }, 30_000);

  it('a Back the PAGE did — history.back() in a click handler — is the click, not a back', async () => {
    await page.goto(`${origin}/spa.html`);
    recorder = newRecorder({ typedNavigationWindowMs: 100 }); // the real history window
    await recorder.start();
    await page.click('#push');
    await new Promise((r) => setTimeout(r, 1_200));
    await page.click('#script-back');
    await page.waitForURL(/spa\.html$/);
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.map((a) => a.kind)).toEqual(['click', 'click']);
  }, 30_000);
});

describe('classifyHistoryMove', () => {
  const at = (index: number, ids: number[]) => ({ index, ids });
  it('tells back, forward and reload from a new navigation by entry id', () => {
    expect(classifyHistoryMove(at(2, [1, 2, 3]), at(1, [1, 2, 3]))).toBe('back');
    expect(classifyHistoryMove(at(0, [1, 2, 3]), at(2, [1, 2, 3]))).toBe('forward');
    expect(classifyHistoryMove(at(1, [1, 2]), at(1, [1, 2]))).toBe('reload');
    // A link or a typed address from the middle: a NEW entry at the next index.
    expect(classifyHistoryMove(at(0, [1, 2, 3]), at(1, [1, 9]))).toBe('new');
    // location.replace: same index, new id.
    expect(classifyHistoryMove(at(1, [1, 2]), at(1, [1, 7]))).toBe('new');
    // The newest entry reached by a new navigation is not "forward".
    expect(classifyHistoryMove(at(1, [1, 2]), at(2, [1, 2, 3]))).toBe('new');
    expect(classifyHistoryMove(null, at(0, [1]))).toBe('new');
  });
});

describe('historyBehind', () => {
  const h = (index: number, ids: number[], urls: string[]) => ({ index, ids, urls });
  const before = h(1, [1, 2], ['https://a.test/form', 'https://a.test/other']);

  it('a read identical to the history before is behind — unless the navigation was a Reload', () => {
    const same = h(1, [1, 2], ['https://a.test/form', 'https://a.test/other']);
    for (const type of ['differentDocument', 'historyDifferentDocument', 'historySameDocument']) {
      expect(historyBehind(before, same, 'https://a.test/other', type)).toBe(true);
    }
    expect(historyBehind(before, same, 'https://a.test/other', 'reload')).toBe(false);
    expect(historyBehind(before, same, 'https://a.test/other', 'reloadBypassingCache')).toBe(false);
  });

  it('without the browser\'s word for it: behind only when the address moved and the history did not', () => {
    const same = h(1, [1, 2], ['https://a.test/form', 'https://a.test/other']);
    expect(historyBehind(before, same, 'https://a.test/elsewhere', undefined)).toBe(true);
    expect(historyBehind(before, same, 'https://a.test/other', undefined)).toBe(false);
  });

  it('a read that moved at all has caught up', () => {
    // A new entry; the same address loaded again (a new id); Back.
    expect(historyBehind(before, h(2, [1, 2, 3], ['', '', 'https://a.test/x']), 'https://a.test/x', 'differentDocument')).toBe(false);
    expect(historyBehind(before, h(1, [1, 5], ['https://a.test/form', 'https://a.test/other']), 'https://a.test/other', 'differentDocument')).toBe(false);
    expect(historyBehind(before, h(0, [1, 2], ['https://a.test/form', 'https://a.test/other']), 'https://a.test/form', 'historyDifferentDocument')).toBe(false);
    // replaceState: same entry, new address.
    expect(historyBehind(before, h(1, [1, 2], ['https://a.test/form', 'https://a.test/other?x']), 'https://a.test/other?x', undefined)).toBe(false);
    expect(historyBehind(null, before, 'https://a.test/other', 'differentDocument')).toBe(false);
  });
});

// ── The fix round (review of the server half) ─────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('a secret field stays secret for the life of the document (review, finding 1)', () => {
  beforeEach(async () => {
    await page.goto(`${origin}/eye.html`);
  });

  it('a password box its eye flipped to text: typed after the flip, edited after it, and picked — never read', async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    // Flipped BEFORE the author touched the field, and named only by a label
    // that does not say password: its type's OLD value is all that is left.
    await page.click('#eye');
    await page.click('#mw');
    await page.keyboard.type('hunter2-EYE');
    await page.keyboard.press('Tab');
    // Back into it, one more character: the box has shown text for a while.
    await page.click('#mw');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Tab');
    // And an Add check on it.
    recorder.armPick();
    await sleep(100);
    await page.click('#mw');
    await actionsReach(8);
    const done = await recorder.stop();
    const typed = done.filter((a) => a.kind === 'type');
    expect(typed).toHaveLength(2);
    for (const a of typed) {
      expect(a.secret).toBe(true);
      expect(a.value).toBeUndefined();
      // Showing its value in clear: no picture of it.
      expect(a.crop).toBeUndefined();
    }
    const check = done.find((a) => a.kind === 'check');
    expect(check?.check).toMatchObject({ secret: true });
    expect(check?.check?.value).toBeUndefined();
    expect(check?.crop).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain('hunter2');
  }, 30_000);

  it('a text box LABELLED Password is secret though no password type was ever seen (flipped before Record)', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.fill('#pw-text', 'label-says-SECRET');
    await page.fill('#plain', 'Nick');
    const done = await recorder.stop();
    expect(done.map((a) => [a.target?.name ?? a.target?.nameAttr, a.secret === true, a.value])).toEqual([
      ['Password', true, undefined],
      ['nickname', false, 'Nick'],
    ]);
    expect(JSON.stringify(raw)).not.toContain('label-says-SECRET');
  }, 30_000);
});

/** How many pixels of a crop are within `tolerance` of a colour. */
async function pixelsNear(dataUrl: string, rgb: [number, number, number], tolerance = 40): Promise<number> {
  const image = await Jimp.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
  let n = 0;
  const d = image.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i]! - rgb[0]) + Math.abs(d[i + 1]! - rgb[1]) + Math.abs(d[i + 2]! - rgb[2]) <= tolerance) n++;
  }
  return n;
}
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const MAGENTA: [number, number, number] = [255, 0, 255];

describe('crops have secrets painted out (review, finding 6)', () => {

  it('a flipped password box and a field holding a known secret are covered in every crop', async () => {
    await page.goto(`${origin}/paint.html`);
    known = [{ name: 'api_token', value: 'known-VALUE-1' }];
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.fill('#mw2', 'typed-while-hidden');
    await page.click('#eye2'); // the box now shows its value, in clear
    await page.fill('#tok2', 'known-VALUE-1');
    await page.click('#near');
    const done = await recorder.stop();

    // The control: the first crop was taken while the blue field was empty —
    // an ordinary field, left alone — so the counter does see the colours.
    const first = done.find((a) => a.kind === 'type' && a.target?.id === 'mw2');
    expect(first?.crop?.dataUrl).toMatch(/^data:image\/png/);
    expect(await pixelsNear(first!.crop!.dataUrl, BLUE)).toBeGreaterThan(500);
    expect(await pixelsNear(first!.crop!.dataUrl, GREEN)).toBe(0);

    const near = done.find((a) => a.kind === 'click' && a.target?.name === 'Near');
    expect(near?.crop?.dataUrl).toMatch(/^data:image\/png/);
    expect(await pixelsNear(near!.crop!.dataUrl, GREEN)).toBe(0);
    expect(await pixelsNear(near!.crop!.dataUrl, BLUE)).toBe(0);
  }, 30_000);
});

describe('what is not an action (review, finding 9)', () => {
  beforeEach(async () => {
    await page.goto(`${origin}/actions.html`);
  });

  it('a label for a hidden file input is ONE click — the click it passes on to the input is not another', async () => {
    recorder = newRecorder();
    await recorder.start();
    const chooser = page.waitForEvent('filechooser');
    await page.click('#up-label');
    await (await chooser).setFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await actionsReach(2);
    await sleep(300);
    expect(actions.map((a) => [a.kind, a.target?.name])).toEqual([
      ['click', 'Upload statement'],
      ['upload', 'Upload statement'],
    ]);
    expect(actions[1]!.files).toEqual(['statement.pdf']);
  }, 30_000);

  it("selecting a field's text by dragging is not a drag, wherever the pointer is released", async () => {
    recorder = newRecorder();
    await recorder.start();
    const field = (await page.locator('#sel').boundingBox())!;
    const beside = (await page.locator('#beside').boundingBox())!;
    await page.mouse.move(field.x + 5, field.y + field.height / 2);
    await page.mouse.down();
    await page.mouse.move(field.x + field.width - 5, field.y + field.height / 2, { steps: 5 });
    await page.mouse.move(beside.x + beside.width / 2, beside.y + beside.height / 2, { steps: 5 });
    await page.mouse.up();
    await sleep(400);
    expect(actions.some((a) => a.kind === 'drag')).toBe(false);
    // What it did do was put the caret in the field.
    expect(actions.filter((a) => a.kind === 'click').every((a) => a.focusOnly === true)).toBe(true);
  }, 30_000);

  it('Enter in a contenteditable is part of the typing, not a key action', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.click('#editor');
    await page.keyboard.type('line one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('line two');
    await page.click('#elsewhere');
    await actionsReach(3);
    await sleep(300);
    expect(actions.map((a) => a.kind)).toEqual(['click', 'type', 'click']);
    expect(actions[1]!.value).toMatch(/line one\s+line two/);
  }, 30_000);
});

describe('Add check reports the typing before it (review, finding 11)', () => {
  it('a field still being typed into is reported BEFORE the check that follows', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.focus('#email');
    await page.keyboard.type('a@b.test');
    recorder.armPick();
    await sleep(100);
    await page.click('#pm-text');
    await actionsReach(2);
    expect(actions.map((a) => a.kind)).toEqual(['type', 'check']);
    expect(actions[0]!.value).toBe('a@b.test');
  }, 30_000);
});

describe('open shadow roots (review, finding 13)', () => {
  it('a choice inside an open shadow root is recorded — its change event never leaves the root', async () => {
    await page.goto(`${origin}/shadow.html`);
    recorder = newRecorder();
    await recorder.start();
    await page.focus('#plan'); // Playwright's CSS pierces open shadow roots
    await page.selectOption('#plan', { label: 'Premium' });
    await page.fill('#nick', 'Robin');
    const done = await recorder.stop();
    expect(done.map((a) => [a.kind, a.options ?? a.value])).toEqual([
      ['select', ['Premium']],
      ['type', 'Robin'],
    ]);
  }, 30_000);
});

describe('Cancel leaves nothing behind (review, finding 10)', () => {
  it('work still in flight at cancel reports nothing afterwards', async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    // Each gesture's crop is still being taken when cancel lands.
    await page.click('#panel-button', { noWaitAfter: true });
    recorder.armPick();
    await sleep(50);
    await page.click('#pm-text', { noWaitAfter: true });
    await recorder.cancel();
    const atCancel = actions.length;
    const picksAtCancel = picks.length;
    await sleep(1_500);
    expect(actions.length).toBe(atCancel);
    expect(picks.length).toBe(picksAtCancel);
  }, 30_000);
});

describe('history moves the author did not make — and ones they did (review, findings 4 and 5)', () => {
  beforeEach(async () => {
    await page.goto(`${origin}/nav.html`);
  });

  it('a replaceState the page makes a while after a click is not a Reload', async () => {
    recorder = newRecorder({ typedNavigationWindowMs: 100, historyCausedWindowMs: 100 });
    await recorder.start();
    await page.click('#later-replace');
    await page.waitForURL(/\?view=/);
    await sleep(400);
    expect(actions.map((a) => a.kind)).toEqual(['click']);
  }, 30_000);

  it("after a link that never committed (a 204), the author's Reload is still a Reload", async () => {
    recorder = newRecorder({ typedNavigationWindowMs: 100, historyCausedWindowMs: 100 });
    await recorder.start();
    await page.click('#nocontent');
    await sleep(400);
    await page.reload();
    await actionsReach(2);
    await sleep(300);
    expect(actions.map((a) => a.kind)).toEqual(['click', 'reload']);
  }, 30_000);

  it("a Reload that cuts a slow page navigation short is the author's Reload", async () => {
    recorder = newRecorder({ typedNavigationWindowMs: 100, historyCausedWindowMs: 100 });
    await recorder.start();
    await page.click('#slow', { noWaitAfter: true });
    await sleep(400);
    // Playwright may report the cut-short navigation's abort as the reload's.
    await page.reload().catch(() => {});
    await actionsReach(2);
    await sleep(300);
    expect(actions.map((a) => a.kind)).toEqual(['click', 'reload']);
    expect(actions[1]!.url).toBe(`${origin}/nav.html`);
  }, 30_000);
});

describe('masked, then clipped (review, finding 8)', () => {
  it("a known secret across the page's length limit leaves no prefix behind", async () => {
    await page.goto(`${origin}/actions.html`);
    const secret = 'sk_live_ABCDEFGHIJ1234567890';
    known = [{ name: 'api_key', value: secret }];
    await page.evaluate((s) => {
      document.getElementById('long')!.textContent = `${'x '.repeat(145)}${s} tail`;
    }, secret);
    recorder = newRecorder();
    await recorder.start();
    recorder.armPick();
    await sleep(100);
    await page.click('#long');
    const [check] = await actionsReach(1);
    expect(check!.kind).toBe('check');
    expect(JSON.stringify(check)).not.toContain(secret.slice(0, 6));
    expect(check!.check!.text).toContain('***');
  }, 30_000);
});

describe('decoration is not a name (review, finding 16)', () => {
  it("a link's emoji and a trailing chevron are left out of its name, and kept in rawName", async () => {
    await page.goto(`${origin}/actions.html`);
    recorder = newRecorder();
    await recorder.start();
    await page.click('#tx-link');
    await page.click('#next-link');
    await actionsReach(2);
    expect(actions[0]!.target).toMatchObject({ name: 'Transactions', rawName: '💳 Transactions' });
    expect(actions[0]!.summary).toBe('Clicked link "Transactions"');
    expect(actions[1]!.target).toMatchObject({ name: 'Next', rawName: 'Next ›' });
  }, 30_000);
});

// ── The second fix round (review 2 of the server half) ────────────────────

describe('a secret typed on the page is remembered by its VALUE (review 2, finding 1)', () => {
  beforeEach(async () => {
    await page.goto(`${origin}/swap.html`);
  });

  it('a show toggle that REPLACES the box: the new text box is secret — typed, and in every crop', async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.click('#mw3');
    await page.keyboard.type('hunter2-SWAP');
    await page.click('#swap'); // a new <input type="text"> holding the value
    expect(await page.$eval('#mw3', (e) => (e as HTMLInputElement).type)).toBe('text');
    await page.click('#mw3');
    await page.keyboard.press('End');
    await page.keyboard.type('!!');
    await page.click('#near3');
    const done = await recorder.stop();
    const typed = done.filter((a) => a.kind === 'type');
    expect(typed).toHaveLength(2);
    for (const a of typed) {
      expect(a.secret).toBe(true);
      expect(a.value).toBeUndefined();
      expect(a.summary).toContain('***');
    }
    expect(JSON.stringify(raw)).not.toContain('hunter2');
    // The click on Near was photographed with the new box on screen,
    // showing its value in clear: painted out.
    const near = done.find((a) => a.kind === 'click' && a.target?.name === 'Near');
    expect(near?.crop?.dataUrl).toMatch(/^data:image\/png/);
    expect(await pixelsNear(near!.crop!.dataUrl, GREEN)).toBe(0);
  }, 30_000);

  it('a value revealed into a <span> is painted out of the crops and masked out of a check', async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.click('#mw3');
    await page.keyboard.type('hunter2-REVEAL');
    await page.click('#reveal');
    expect(await page.textContent('#shown')).toBe('hunter2-REVEAL');
    await page.click('#near3');
    recorder.armPick();
    await sleep(100);
    await page.click('#shown');
    await actionsReach(5);
    const done = await recorder.stop();
    const near = done.find((a) => a.kind === 'click' && a.target?.name === 'Near');
    expect(near?.crop?.dataUrl).toMatch(/^data:image\/png/);
    expect(await pixelsNear(near!.crop!.dataUrl, BLUE)).toBe(0);
    const check = done.find((a) => a.kind === 'check');
    expect(check?.check?.text).toBe('***');
    expect(JSON.stringify(raw)).not.toContain('hunter2');
  }, 30_000);

  it('page text holding a secret the SERVER knows is painted out too — the secret never goes into the page (finding 8)', async () => {
    known = [{ name: 'api_token', value: 'known-TEXT-42' }];
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.click('#near3');
    const [click] = await actionsReach(1);
    expect(click?.crop?.dataUrl).toMatch(/^data:image\/png/);
    expect(await pixelsNear(click!.crop!.dataUrl, MAGENTA)).toBe(0);
    // The control: without the secret known, the same text is left alone.
    known = [];
    actions.length = 0;
    await page.click('#near3');
    const [again] = await actionsReach(1);
    expect(await pixelsNear(again!.crop!.dataUrl, MAGENTA)).toBeGreaterThan(100);
  }, 30_000);
});

describe('value memory stays with real secrets (review 2, finding 1 — the composition)', () => {
  it("a search box the shared rule calls secret by the word `keyword` withholds its term — and the results page still says it", async () => {
    await page.goto(`${origin}/labels.html`);
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await page.fill('#kw', 'shoes');
    recorder.armPick();
    await sleep(100);
    await page.click('#results');
    await actionsReach(2);
    const done = await recorder.stop();
    // The shared rule's over-match, unchanged: the typed term is withheld.
    expect(done[0]).toMatchObject({ kind: 'type', secret: true });
    // But a search term is not a credential: not remembered, not masked.
    const check = done.find((a) => a.kind === 'check');
    expect(check?.check?.text).toBe('Results for shoes');
  }, 30_000);
});

describe('an iframe with a border and padding (review 2, finding 4)', () => {
  beforeEach(async () => {
    await page.goto(`${origin}/framed.html`);
  });

  it("paints the field where it is on screen — inside the frame's border and padding", async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    const frame = page.frames().find((f) => f.url().endsWith('/framed-inner.html'))!;
    await frame.fill('#fpw', 'framed-SECRET');
    await frame.click('#feye'); // now type="text", showing its value
    await page.click('#near4');
    const done = await recorder.stop();
    const near = done.find((a) => a.kind === 'click' && a.target?.name === 'Near');
    expect(near?.crop?.dataUrl).toMatch(/^data:image\/png/);
    expect(await pixelsNear(near!.crop!.dataUrl, GREEN)).toBe(0);
  }, 30_000);

  it("outlines an in-frame target where it is: the crop's page box is the element's", async () => {
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    const frame = page.frames().find((f) => f.url().endsWith('/framed-inner.html'))!;
    await frame.click('#feye');
    const [click] = await actionsReach(1);
    const actual = await page.evaluate(() => {
      const f = document.getElementById('bordered') as HTMLIFrameElement;
      const fr = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      const r = f.contentDocument!.getElementById('feye')!.getBoundingClientRect();
      return {
        x: Math.round(fr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + r.left),
        y: Math.round(fr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) + r.top),
      };
    });
    expect(click?.crop?.pageBox).toBeDefined();
    expect(Math.abs(click!.crop!.pageBox.x - actual.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(click!.crop!.pageBox.y - actual.y)).toBeLessThanOrEqual(1);
  }, 30_000);
});

describe('Enter in a contenteditable, by what it did (review 2, finding 3)', () => {
  it('a chat composer where Enter sends and empties the box: the message, then the key', async () => {
    await page.goto(`${origin}/chat.html`);
    recorder = newRecorder();
    await recorder.start();
    await page.click('#composer');
    await page.keyboard.type('Hello team');
    await page.keyboard.press('Enter');
    await sleep(250);
    await page.click('#other');
    await actionsReach(4);
    await sleep(200);
    expect(await page.$$eval('#log li', (l) => l.map((x) => x.textContent))).toEqual(['Hello team']);
    expect(actions.map((a) => [a.kind, a.action])).toEqual([
      ['click', true], ['type', false], ['key', true], ['click', true],
    ]);
    expect(actions[1]!.value).toBe('Hello team');
    expect(actions[2]).toMatchObject({ key: 'Enter' });
    expect(actions[2]!.target?.name).toBe('Message');
  }, 30_000);

  it('an Enter still being judged at Stop is decided then — the message and the key come back', async () => {
    await page.goto(`${origin}/chat.html`);
    recorder = newRecorder();
    await recorder.start();
    await page.click('#composer');
    await page.keyboard.type('Last words');
    await page.keyboard.press('Enter');
    const done = await recorder.stop();
    expect(done.map((a) => a.kind)).toEqual(['click', 'type', 'key']);
    expect(done[1]!.value).toBe('Last words');
  }, 30_000);
});

describe("a label's forwarded click, and only that one (review 2, finding 6)", () => {
  it("a later keyboard click on the label's control is the author's own", async () => {
    await page.goto(`${origin}/labels.html`);
    recorder = newRecorder();
    await recorder.start();
    await page.click('#lab-save'); // the label; the browser passes a click to Save
    await sleep(100);
    await page.focus('#save');
    await page.keyboard.press('Enter'); // a second save, from the keyboard
    await actionsReach(2);
    await sleep(200);
    expect(await page.evaluate('window.saves')).toBe(2);
    expect(actions.map((a) => [a.kind, a.target?.tag, a.keyboard === true])).toEqual([
      ['click', 'label', false],
      ['click', 'button', true],
    ]);
  }, 30_000);
});

describe('the label rule reads whole words (review 2, finding 7)', () => {
  it('"Boarding pass number" and "Email for password reset" are ordinary fields; a one-time code and a passcode are not', async () => {
    await page.goto(`${origin}/labels.html`);
    recorder = newRecorder();
    await recorder.start();
    await page.fill('#bp', 'BP-7781');
    await page.fill('#er', 'me@example.test');
    await page.fill('#otc', '918273');
    await page.fill('#pcode', 'pc-5521');
    const done = await recorder.stop();
    expect(done.map((a) => [a.target?.name, a.secret === true, a.value])).toEqual([
      ['Boarding pass number', false, 'BP-7781'],
      ['Email for password reset', false, 'me@example.test'],
      ['One-time code', true, undefined],
      ['Passcode', true, undefined],
    ]);
  }, 30_000);
});

describe('other spellings of a secret (review 2, finding 9)', () => {
  beforeEach(async () => {
    await page.goto(`${origin}/labels.html`);
  });

  it('a known secret percent-encoded in a link is masked', async () => {
    known = [{ name: 'api_token', value: 'p@ss w/rd+1' }];
    recorder = newRecorder();
    await recorder.start();
    await page.click('#enc');
    const [click] = await actionsReach(1);
    expect(click!.target?.href).toBe('/other.html?token=***');
    expect(JSON.stringify(click)).not.toContain('p%40ss');
  }, 30_000);

  it('a secret holding a double space is matched as sent — the page no longer folds it away', async () => {
    known = [{ name: 'passphrase', value: 'open  sesame' }];
    recorder = newRecorder();
    await recorder.start();
    await page.fill('#phrase', 'say open  sesame now');
    recorder.armPick();
    await sleep(100);
    await page.click('#phrase');
    await actionsReach(2);
    recorder.armPick();
    await sleep(100);
    await page.click('#pre');
    await actionsReach(3);
    const done = await recorder.stop();
    const typed = done.find((a) => a.kind === 'type');
    expect(typed).toMatchObject({ secret: true });
    expect(typed!.value).toBeUndefined();
    const checks = done.filter((a) => a.kind === 'check');
    // Holding it anywhere, a field's value is withheld whole, as typing is.
    expect(checks[0]!.check).toMatchObject({ secret: true });
    expect(checks[1]!.check!.text).toBe('key: ***');
    expect(JSON.stringify(done)).not.toContain('sesame');
  }, 30_000);

  it('a field styled to show dots (-webkit-text-security) is secret', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.fill('#dots', 'dotted-SECRET');
    const done = await recorder.stop();
    expect(done[0]).toMatchObject({ kind: 'type', secret: true });
    expect(JSON.stringify(raw)).not.toContain('dotted-SECRET');
  }, 30_000);
});

describe('a frame that cannot answer costs the crop (review 2, findings 5 and 10)', () => {
  /** A recorder over a stand-in page — enough of one for `secretBoxes` and
   *  `startCrop`, whose frames answer (or fail to) as each test needs. */
  function standIn(frames: Array<Record<string, unknown>>): {
    recorder: StepRecorder;
    fake: Record<string, unknown>;
    secretBoxes: () => Promise<unknown>;
  } {
    const main = frames[0]!;
    const fake: Record<string, unknown> = {
      frames: () => frames,
      mainFrame: () => main,
      screenshot: async () => (await new Jimp(400, 300, 0xffffffff)).getBufferAsync(Jimp.MIME_PNG),
    };
    const rec = new StepRecorder({
      browser: { context: {} } as unknown as BrowserSession,
      sendScreenshots: true,
      knownSecrets: () => [{ name: 'api_token', value: 'tok-FRAME-SECRET' }],
      onAction: () => {},
      onPick: () => {},
    });
    return {
      recorder: rec,
      fake,
      secretBoxes: () => (rec as unknown as { secretBoxes(p: unknown): Promise<unknown> }).secretBoxes(fake),
    };
  }
  const answering = (): Record<string, unknown> => ({
    url: () => 'https://app.test/',
    evaluate: async () => ({ secret: [], fields: [], texts: [] }),
  });
  const child = (over: Record<string, unknown>): Record<string, unknown> => ({
    url: () => 'https://pay.test/embed?token=tok-FRAME-SECRET',
    evaluate: async () => ({ secret: [], fields: [], texts: [] }),
    frameElement: async () => ({
      boundingBox: async () => ({ x: 10, y: 10, width: 100, height: 100 }),
      evaluate: async () => ({ x: 0, y: 0 }),
    }),
    ...over,
  });

  it('a frame whose evaluate REJECTS (mid-navigation), or that has no script, or is too big: no crop', async () => {
    for (const over of [
      { evaluate: () => Promise.reject(new Error('Execution context was destroyed')) },
      { evaluate: async () => null },
      { evaluate: async () => ({ secret: [], fields: [], truncated: true }) },
    ]) {
      await expect(standIn([answering(), child(over)]).secretBoxes()).rejects.toThrow();
    }
    // The control: every frame answering is a crop.
    await expect(standIn([answering(), child({})]).secretBoxes()).resolves.toEqual([]);
  }, 30_000);

  it('a frame element that cannot say where it is in time: no crop', async () => {
    const never = new Promise<never>(() => {});
    await expect(standIn([answering(), child({ frameElement: () => never })]).secretBoxes()).rejects.toThrow();
    const stuck = child({
      frameElement: async () => ({ boundingBox: () => never, evaluate: async () => ({ x: 0, y: 0 }) }),
    });
    await expect(standIn([answering(), stuck]).secretBoxes()).rejects.toThrow();
  }, 30_000);

  it("the crop it costs is null, and the line that says why has the frame's token masked", async () => {
    const lines: string[] = [];
    const remove = addLogCallback((_level, message) => lines.push(message));
    try {
      const main = answering();
      const s = standIn([main, child({ evaluate: () => Promise.reject(new Error('Frame was detached')) })]);
      const internals = s.recorder as unknown as {
        startCrop(source: unknown, mark: string, target: Box): void;
        crops: Map<string, Promise<unknown>>;
      };
      internals.startCrop({ context: {}, page: s.fake, frame: main }, 'm1', { x: 10, y: 10, width: 20, height: 20 });
      expect(await internals.crops.get('m1')).toBeNull();
    } finally {
      remove();
    }
    const said = lines.filter((l) => l.includes('no crop for m1'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('***');
    expect(lines.join('\n')).not.toContain('tok-FRAME-SECRET');
  }, 30_000);
});
