/**
 * Record Steps — the page script and the recorder, against a real Chromium
 * (stories/testbench-record-steps.md §Tests, "The page script against the
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
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PageTracker, type BrowserSession } from '../src/browser/manager.js';
import { StepRecorder, type KnownSecret } from '../src/recorder/step-recorder.js';
import type { RecordedAction } from '../src/recorder/types.js';

const PAGES: Record<string, string> = {
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
    const body = PAGES[(req.url ?? '/').split('?')[0]!];
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function newRecorder(opts: { sendScreenshots?: boolean; typedNavigationWindowMs?: number } = {}): StepRecorder {
  return new StepRecorder({
    browser: session,
    sendScreenshots: opts.sendScreenshots ?? false,
    knownSecrets: () => known,
    onAction: (a) => actions.push(a),
    onPick: (armed) => picks.push(armed),
    tap: (m) => raw.push(m),
    ...(opts.typedNavigationWindowMs !== undefined && { typedNavigationWindowMs: opts.typedNavigationWindowMs }),
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

  it('reports a select, a tick (direct and by label) and an untick by outcome', async () => {
    recorder = newRecorder();
    await recorder.start();
    await page.selectOption('#freq', { label: 'Monthly' });
    await page.check('#cash');
    await page.click('label[for="cash"]'); // unticks through the label
    await page.click('label[for="cash"]'); // and ticks again
    const done = await actionsReach(4);
    expect(done.map((a) => a.kind)).toEqual(['select', 'tick', 'untick', 'tick']);
    expect(done[0]).toMatchObject({ options: ['Monthly'] });
    expect(done[0]!.target?.name).toBe('Frequency');
    expect(done[1]!.target).toMatchObject({ role: 'checkbox', name: 'Cash' });
    expect(done[3]!.viaLabel).toMatchObject({ tag: 'label', name: 'Cash' });
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
