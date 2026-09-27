/**
 * Record Steps — the toolbar in the recorded page, against a real Chromium
 * (stories/testbench-record-toolbar.md; docs/specs/SPEC-record-steps.md §3.3).
 *
 * The recorder here is driven the way `RecordStepsRun` drives it — a toolbar
 * block to show, and the commands it hands back through `onToolbar` — so each
 * test can assert on what crossed from the page. The toolbar sits in a closed
 * shadow root: tests read it and click it through DevTools
 * (./record-toolbar-cdp.ts), with Playwright's trusted mouse and keyboard.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import Jimp from 'jimp';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PageTracker, type BrowserSession } from '../src/browser/manager.js';
import { StepRecorder, type ToolbarCommand } from '../src/recorder/step-recorder.js';
import type { RecordedAction } from '../src/recorder/types.js';
import { clickToolbar, readToolbar, stepBoxValue, toolbarButtonAt, until } from './record-toolbar-cdp.js';

/** Every page listens to everything it can, the way apps with keyboard
 *  shortcuts and "click outside to close" do — registered by the PAGE, after
 *  the recorder's init script. */
const LISTENERS = `<script>
  window.heard = [];
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'click', 'pointerdown', 'mousedown', 'focusin']) {
    window.addEventListener(type, (e) => window.heard.push(type + ':' + (e.key || '')), true);
    document.addEventListener(type, (e) => window.heard.push('doc-' + type + ':' + (e.key || '')));
  }
</script>`;

const PAGES: Record<string, string> = {
  '/app.html': `<!doctype html><html><head><title>App</title></head><body style="margin:0">
    <nav aria-label="Main menu"><a href="/other.html" id="to-other">Reports</a>
      <a href="/other.html" target="_blank" id="new-tab">Open in new tab</a></nav>
    <main><h1>Sign in</h1>
      <label for="email">Email</label><input id="email">
      <label for="pw">Password</label><input id="pw" type="password">
      <button id="go" onclick="window.went = (window.went || 0) + 1">Go</button>
      <button id="oauth" onclick="window.open('/login-popup.html', 'oauth', 'width=420,height=360')">Sign in with Example</button>
      <iframe id="frame" title="Payment" src="/frame.html" style="width:300px;height:80px"></iframe>
    </main>${LISTENERS}</body></html>`,
  // An OAuth-style sign-in popup: Enter signs in and the window closes itself.
  '/login-popup.html': `<!doctype html><html><head><title>Sign in</title></head><body>
    <form id="f"><label for="pop-pw">Password</label><input id="pop-pw" type="password"><button>Sign in</button></form>
    <script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.close(); });</script>
    </body></html>`,
  '/autofocus.html': `<!doctype html><html><head><title>Autofocus</title></head><body>
    <label for="email">Email</label><input id="email">
    <label for="pw">Password</label><input id="pw" type="password" autofocus></body></html>`,
  // A document whose own scripts keep it busy while it loads: the recorder's
  // claim waits behind them.
  '/busy.html': `<!doctype html><html><head><title>Busy</title>
    <script>var t0 = Date.now(); while (Date.now() - t0 < 3500) {}</script></head>
    <body><button id="b">Continue</button></body></html>`,
  // A page that goes for the recorder's control object before anything else.
  '/claims.html': `<!doctype html><html><head><title>Claims</title><script>
    var ctl = window.__aiuiRecordStepsCtl;
    window.claimed = ctl ? ctl.claim('x') : 'no control';
    window.pushed = ctl ? ctl.setState({ recording: true, bar: true, toolbar: { phase: 'done', endText: 'Fake' } }) : 'no control';
    window.flushed = ctl ? JSON.stringify(ctl.flush()) : 'no control';
    </script></head><body><button id="b">Continue</button></body></html>`,
  '/other.html': `<!doctype html><html><head><title>Other</title></head><body>
    <h1>Other page</h1><button id="other-button">Continue</button></body></html>`,
  '/frame.html': `<!doctype html><html><body><label for="card">Card number</label><input id="card">
    <label for="cvc">Security code</label><input id="cvc" type="password"></body></html>`,
  '/dialog.html': `<!doctype html><html><head><title>Dialog</title></head><body>
    <button id="open" onclick="document.getElementById('dlg').showModal()">Open</button>
    <dialog id="dlg"><p>Are you sure?</p><button id="yes">Yes</button></dialog></body></html>`,
  '/menu.html': `<!doctype html><html><head><title>Menu</title></head><body>
    <button id="menu-button" popovertarget="menu">Account</button>
    <div id="menu" popover><button id="settings">Settings</button><button id="sign-out">Sign out</button></div>
    </body></html>`,
  // A button across the whole bottom of the viewport: the toolbar (docked
  // bottom centre) sits over part of it, and the crop around it takes in the bar.
  '/wide.html': `<!doctype html><html><head><title>Wide</title></head><body style="margin:0;background:#ffffff">
    <p>Top</p>
    <button id="wide" onclick="window.wideClicks = (window.wideClicks || 0) + 1"
      style="position:fixed;left:0;right:0;bottom:0;height:150px;border:0;background:#00ff00">Wide</button>
    </body></html>`,
};

/** A page under a strict Content-Security-Policy — no inline style, no script. */
const STRICT_CSP = "default-src 'none'; style-src 'none'; script-src 'none'";
const STRICT_CSP_TT = `${STRICT_CSP}; require-trusted-types-for 'script'; trusted-types 'none'`;
const STRICT_PAGE = `<!doctype html><html><head><title>Strict</title>
  <style>body { background: rgb(255, 0, 0); }</style></head>
  <body style="margin:0">
    <div id="inline" style="width:300px;height:40px;background:rgb(0,0,255)">Inline styled</div>
    <button id="strict-button">Continue</button>
    <script>document.title = 'script ran';</script>
  </body></html>`;

let server: Server;
let origin: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let session: BrowserSession;
let actions: RecordedAction[];
let picks: boolean[];
let commands: ToolbarCommand[];
let recorder: StepRecorder;

const VIEW = {
  phase: 'recording',
  actions: 0,
  steps: [] as unknown[],
  updating: false,
  dock: 'bc',
  minimised: false,
  boxText: '',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]!;
    if (route === '/strict.html' || route === '/strict-tt.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', route === '/strict.html' ? STRICT_CSP : STRICT_CSP_TT);
      res.end(STRICT_PAGE);
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
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function newRecorder(
  opts: { toolbar?: boolean; sendScreenshots?: boolean; checkInMs?: number; windows?: number } = {},
): StepRecorder {
  return new StepRecorder({
    browser: session,
    sendScreenshots: opts.sendScreenshots ?? false,
    knownSecrets: () => [],
    onAction: (a) => actions.push(a),
    onPick: (armed) => picks.push(armed),
    toolbar: opts.toolbar === false ? null : { ...VIEW },
    onToolbar: (c) => commands.push(c),
    ...(opts.checkInMs !== undefined && { checkInMs: opts.checkInMs }),
    ...(opts.windows !== undefined && { typedNavigationWindowMs: opts.windows, historyCausedWindowMs: opts.windows }),
  });
}

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  page = await context.newPage();
  const pageTracker = new PageTracker(page);
  context.on('page', (p) => pageTracker.addPage(p));
  session = { browser, context, page, pageTracker };
  actions = [];
  picks = [];
  commands = [];
  await page.goto(`${origin}/app.html`);
});

afterEach(async () => {
  await recorder?.cancel().catch(() => {});
  await context?.close().catch(() => {});
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hostState(p: Page): Promise<{ present: boolean; topLayer: boolean; width: number; height: number; parent: string }> {
  return p.evaluate(() => {
    const host = document.querySelector('aiui-recorder');
    if (!host) return { present: false, topLayer: false, width: 0, height: 0, parent: '' };
    const r = host.getBoundingClientRect();
    return {
      present: true,
      topLayer: host.matches(':popover-open'),
      width: Math.round(r.width),
      height: Math.round(r.height),
      parent: host.parentElement ? host.parentElement.tagName : '',
    };
  });
}

async function heard(p: Page = page): Promise<string[]> {
  return (await p.evaluate('window.heard || []')) as string[];
}

/** What the page heard, without Alt and Shift pressed on their own: the page
 *  cannot be kept from those — nothing says a chord is coming. */
async function heardBesidesModifiers(p: Page = page): Promise<string[]> {
  return (await heard(p)).filter((h) => !/:(Alt|Shift)$/.test(h));
}

/**
 * Start recording, then load `path`: a document loaded DURING the recording
 * runs the recorder's script first, before any of its own, so the toolbar's
 * gate is the first listener on its window — the case for every page after
 * the one open when Record was pressed (that one's own window capture-phase
 * listeners, registered earlier, still hear first; see the story).
 */
async function startOn(path: string, opts: Parameters<typeof newRecorder>[0] = {}): Promise<void> {
  recorder = newRecorder(opts);
  await recorder.start();
  await page.goto(`${origin}${path}`);
  await until(() => hostState(page), (s) => s.present && s.width > 0, 'the toolbar');
}

describe('the toolbar is in the page', () => {
  it('in the top layer, in a closed shadow root on <html>, styled; back after a navigation; in a new tab; not in frames', async () => {
    recorder = newRecorder();
    await recorder.start();
    const first = await until(() => hostState(page), (s) => s.present && s.width > 0, 'the toolbar');
    expect(first).toMatchObject({ present: true, topLayer: true, parent: 'HTML' });
    // Styled: a bar hundreds of pixels wide, a few rows tall — an unstyled
    // host would be a line of loose text.
    expect(first.width).toBeGreaterThan(500);
    expect(first.height).toBeGreaterThan(30);
    expect(first.height).toBeLessThan(120);
    const bar = await readToolbar(page);
    expect(bar?.shadowType).toBe('closed');
    expect(bar?.status).toMatch(/^REC 00:0\d · 0 actions$/);
    expect(bar?.sub).toContain('No steps yet');
    // The page cannot look in.
    expect(await page.evaluate(() => document.querySelector('aiui-recorder')!.shadowRoot)).toBeNull();
    // Only in the top document: a frame gets none.
    const frame = page.frames().find((f) => f.url().endsWith('/frame.html'))!;
    expect(await frame.evaluate(() => document.querySelector('aiui-recorder') === null)).toBe(true);

    // A full navigation: a new document, and the bar is back.
    await page.goto(`${origin}/other.html`);
    await until(() => hostState(page), (s) => s.present && s.topLayer && s.width > 500, 'the toolbar after a navigation');

    // A new tab gets it too.
    await page.goto(`${origin}/app.html`);
    const popupPromise = context.waitForEvent('page');
    await page.click('#new-tab');
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    await until(() => hostState(popup), (s) => s.present && s.topLayer && s.width > 500, 'the toolbar in a new tab');
  }, 45_000);

  it('is not put in the page at all when the recording has no toolbar', async () => {
    recorder = newRecorder({ toolbar: false });
    await recorder.start();
    await page.click('#go');
    await until(async () => actions.length, (n) => n === 1, 'the click');
    await page.goto(`${origin}/other.html`);
    await sleep(400);
    expect((await hostState(page)).present).toBe(false);
    // …and no shortcut is taken from the page.
    await page.goto(`${origin}/app.html`);
    await sleep(300);
    await page.keyboard.press('Alt+Shift+P');
    await sleep(200);
    expect(recorder.isPaused).toBe(false);
    expect(await heard()).toContain('keydown:P');
  }, 30_000);

  it('leaves the page when the recording ends, after its last word', async () => {
    recorder = newRecorder();
    await recorder.start();
    await until(() => hostState(page), (s) => s.present, 'the toolbar');
    recorder.setToolbar({ ...VIEW, phase: 'done', endKind: 'done', endText: 'Done · 2 steps written to t.md' });
    await recorder.stop();
    await recorder.flushToolbar();
    const last = await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Done'), 'the done state');
    expect(last!.sub).toContain('Done · 2 steps written to t.md');
    expect(last!.status).toMatch(/^DONE/);
    // A new document after the end gets no toolbar.
    await page.goto(`${origin}/other.html`);
    await sleep(300);
    expect((await hostState(page)).present).toBe(false);
  }, 30_000);
});

describe('the toolbar is kept out of the recording', () => {
  it("its clicks are never actions, and the page's listeners never hear them", async () => {
    await startOn('/app.html');
    await until(() => toolbarButtonAt(page, 'undo'), (at) => at !== null, 'the Undo button');
    await page.evaluate('window.heard = []');
    await clickToolbar(page, 'undo');
    await clickToolbar(page, 'drawer');
    await sleep(300);
    expect(commands).toEqual([{ kind: 'undo' }]);
    expect(actions).toEqual([]);
    expect(await heard()).toEqual([]);
    // The drawer opened: read-only, and says so.
    expect((await readToolbar(page))!.all).toContain('Read-only here.');
    // The control: the page itself is still recorded, and still hears its own.
    await page.click('#go');
    await until(async () => actions.length, (n) => n === 1, 'the click on Go');
    expect(actions[0]!.target?.name).toBe('Go');
    expect(await heard()).toContain('click:');
  }, 30_000);

  it('typing in the step box and Enter are never recorded or heard; Enter adds the step exactly as typed', async () => {
    await startOn('/app.html');
    // Typing in the page first: pointing at the toolbar finishes it, and it is
    // reported before anything the bar does.
    await page.click('#email');
    await page.keyboard.type('a@b.test');
    await page.evaluate('window.heard = []');
    await page.keyboard.press('Alt+Shift+S');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Enter to add'), 'the step box');
    await page.keyboard.type('Verify the total is "$10"');
    await page.keyboard.press('Enter');
    await until(async () => commands.length, (n) => n >= 1, 'the step');
    await sleep(300);
    expect(commands).toEqual([{ kind: 'step', text: 'Verify the total is "$10"' }]);
    // The click into the field and its typing are recorded — the typing
    // reported as focus left the field for the box — and no key of the box is.
    expect(actions.map((a) => [a.kind, a.value])).toEqual([['click', undefined], ['type', 'a@b.test']]);
    // Not one keystroke of the box reached the page — not the shortcut's
    // either. (Focus coming BACK to the field is the page's own, and heard.)
    expect((await heardBesidesModifiers()).filter((h) => !/focusin/.test(h))).toEqual([]);
    // The box closed, and focus went back to the field.
    expect((await readToolbar(page))!.sub).not.toContain('Enter to add');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('email');
  }, 30_000);

  it('Esc closes the step box and keeps the text; Esc cancels pick mode without reaching the page', async () => {
    await startOn('/app.html');
    await page.keyboard.press('Alt+Shift+S');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Enter to add'), 'the step box');
    await page.keyboard.type('Half a thought');
    await page.keyboard.press('Escape');
    await until(() => readToolbar(page), (t) => t !== null && !t.sub.includes('Enter to add'), 'the box closed');
    expect(commands.filter((c) => c.kind === 'step')).toEqual([]);
    await page.keyboard.press('Alt+Shift+S');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Enter to add'), 'the step box again');
    expect(await stepBoxValue(page)).toBe('Half a thought');
    await page.keyboard.press('Escape');

    // Pick mode: armed, then Esc — the recorder's, not the page's.
    await page.evaluate('window.heard = []');
    recorder.armPick();
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Click what to check'), 'pick mode');
    await page.keyboard.press('Escape');
    await until(async () => picks, (p) => p.length >= 2, 'pick disarmed');
    expect(picks).toEqual([true, false]);
    expect((await heard()).filter((h) => h.includes('Escape'))).toEqual([]);
    // The control: with nothing armed, Escape is the page's.
    await page.keyboard.press('Escape');
    expect(await heard()).toContain('keydown:Escape');
    expect(actions).toEqual([]);
  }, 30_000);

  it("the shortcuts work — from a frame too — and do not reach the page's listeners", async () => {
    await startOn('/app.html');
    await page.evaluate('window.heard = []');
    await page.keyboard.press('Alt+Shift+P');
    await until(async () => recorder.isPaused, (p) => p, 'paused');
    await until(() => readToolbar(page), (t) => t !== null && t.status.startsWith('PAUSED'), 'PAUSED shown');
    expect((await readToolbar(page))!.sub).toContain('Paused. Nothing you do is recorded.');
    await page.keyboard.press('Alt+Shift+P');
    await until(async () => recorder.isPaused, (p) => !p, 'resumed');
    await page.keyboard.press('Alt+Shift+C');
    await until(async () => picks, (p) => p.length === 1, 'armed');
    await page.keyboard.press('Alt+Shift+C');
    await until(async () => picks, (p) => p.length === 2, 'disarmed');
    await page.keyboard.press('Alt+Shift+Z');
    await page.keyboard.press('Alt+Shift+M');
    await until(async () => commands.length, (n) => n >= 4, 'undo and minimise');
    expect(commands).toEqual([
      { kind: 'paused', paused: true },
      { kind: 'paused', paused: false },
      { kind: 'undo' },
      { kind: 'minimise', minimised: true },
    ]);
    expect(picks).toEqual([true, false]);
    expect(await heardBesidesModifiers()).toEqual([]);

    // From inside a frame: the frame's own script takes the chord.
    const frame = page.frames().find((f) => f.url().endsWith('/frame.html'))!;
    await frame.focus('#card');
    commands.length = 0;
    await page.keyboard.press('Alt+Shift+Z');
    await until(async () => commands.length, (n) => n === 1, 'undo from the frame');
    expect(commands).toEqual([{ kind: 'undo' }]);
    // Add step from a frame opens the box in the top document.
    await page.keyboard.press('Alt+Shift+S');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Enter to add'), 'the box, opened from a frame');
    expect(actions).toEqual([]);
  }, 30_000);
});

describe('screenshots paint the toolbar out', () => {
  /** How many pixels of an image are within `tolerance` of a colour. */
  async function pixelsNear(png: Buffer, rgb: [number, number, number], tolerance: number): Promise<number> {
    const image = await Jimp.read(png);
    let n = 0;
    const d = image.bitmap.data;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i]! - rgb[0]) + Math.abs(d[i + 1]! - rgb[1]) + Math.abs(d[i + 2]! - rgb[2]) <= tolerance) n++;
    }
    return n;
  }
  const GRAPHITE: [number, number, number] = [0x1b, 0x1e, 0x23];
  const STOP_WHITE: [number, number, number] = [0xe9, 0xec, 0xef];

  it('a crop taken while the bar overlaps the target has the bar painted out', async () => {
    await page.goto(`${origin}/wide.html`);
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    await until(() => hostState(page), (s) => s.present && s.width > 500, 'the toolbar');
    // The control: on screen, the bar is there, over the button.
    const shot = await page.screenshot({ type: 'png' });
    expect(await pixelsNear(shot, GRAPHITE, 6)).toBeGreaterThan(2_000);
    expect(await pixelsNear(shot, STOP_WHITE, 6)).toBeGreaterThan(100);
    // Click the button beside the bar, not under it.
    await page.mouse.click(40, 700 - 40);
    const [click] = await until(async () => actions, (a) => a.length === 1 && a[0]!.crop !== undefined, 'the click with its crop');
    const crop = Buffer.from(click!.crop!.dataUrl.split(',')[1]!, 'base64');
    // The crop takes in the whole width of the button — the bar's place too —
    // and none of the bar's own colours are in it.
    expect(click!.crop!.pageBox.width).toBeGreaterThan(900);
    expect(await pixelsNear(crop, GRAPHITE, 6)).toBe(0);
    expect(await pixelsNear(crop, STOP_WHITE, 6)).toBe(0);
    // The button's own green is: the crop is of the page.
    expect(await pixelsNear(crop, [0, 255, 0], 30)).toBeGreaterThan(1_000);
  }, 30_000);

  it('the pick outline and label are never in the crop of what was picked', async () => {
    await page.goto(`${origin}/wide.html`);
    recorder = newRecorder({ sendScreenshots: true });
    await recorder.start();
    recorder.armPick();
    await page.mouse.move(40, 660);
    // The outline is drawn — blue, round the green button.
    await sleep(300);
    const shot = await page.screenshot({ type: 'png' });
    expect(await pixelsNear(shot, [0x2e, 0x9b, 0xff], 20)).toBeGreaterThan(50);
    await page.mouse.down();
    await page.mouse.up();
    const [check] = await until(async () => actions, (a) => a.length === 1 && a[0]!.crop !== undefined, 'the check with its crop');
    expect(check!.kind).toBe('check');
    const crop = Buffer.from(check!.crop!.dataUrl.split(',')[1]!, 'base64');
    expect(await pixelsNear(crop, [0x2e, 0x9b, 0xff], 20)).toBe(0);
    // Nor its label's graphite.
    expect(await pixelsNear(crop, GRAPHITE, 6)).toBe(0);
  }, 30_000);
});

describe('pause and resume', () => {
  it('records nothing while paused — not a click, not typing, not an address or a Back — and the next action says so', async () => {
    await startOn('/app.html', { windows: 100 });
    await page.evaluate(`document.getElementById('to-other').addEventListener('click', (e) => e.preventDefault())`);
    await page.click('#to-other');
    await until(async () => actions.length, (n) => n === 1, 'the first click');
    await page.click('#email');
    await page.keyboard.type('typed-before');
    // Pause from the toolbar itself: the typing before it is reported first.
    await clickToolbar(page, 'pause');
    await until(async () => recorder.isPaused, (p) => p, 'paused');
    await until(async () => actions.length, (n) => n === 3, 'the typing before the pause');
    expect(actions.map((a) => a.kind)).toEqual(['click', 'click', 'type']);
    const beforePause = actions[2]!.atMs;

    // Everything here is the author's own business.
    await page.click('#go');
    expect(await page.evaluate('window.went || 0')).toBe(1); // the page itself worked
    await page.fill('#email', 'typed-while-paused');
    await page.goto(`${origin}/other.html`);
    await page.click('#other-button');
    await page.goBack();
    await sleep(1_300);
    expect(actions).toHaveLength(3);

    await clickToolbar(page, 'pause'); // Resume
    await until(async () => recorder.isPaused, (p) => !p, 'resumed');
    await sleep(250);
    await page.click('#go');
    await until(async () => actions.length, (n) => n === 4, 'the click after resume');
    const after = actions[3]!;
    expect(after).toMatchObject({ kind: 'click', afterPause: true });
    // The paused time is not in the clock: the gap is well under the 1.3 s+ paused.
    expect(after.atMs - beforePause).toBeLessThan(1_000);
    // The history was re-read at resume: a Forward now is a forward.
    await sleep(250);
    await page.goForward();
    await until(async () => actions.length, (n) => n === 5, 'the forward');
    expect(actions[4]).toMatchObject({ kind: 'forward', url: `${origin}/other.html` });
    expect(actions[4]!.afterPause).toBeUndefined();
    expect(actions.map((a) => a.kind)).toEqual(['click', 'click', 'type', 'click', 'forward']);
    expect(JSON.stringify(actions)).not.toContain('typed-while-paused');
    expect(commands).toEqual([{ kind: 'paused', paused: true }, { kind: 'paused', paused: false }]);
  }, 45_000);

  it('Add check cannot be armed while paused', async () => {
    recorder = newRecorder();
    await recorder.start();
    expect(recorder.pause()).toBe(true);
    expect(recorder.armPick()).toBe(false);
    await page.keyboard.press('Alt+Shift+C');
    await sleep(200);
    expect(picks).toEqual([]);
  }, 30_000);
});

describe('the page cannot drive the toolbar', () => {
  it('a page script calling the binding — with no token, a made-up one, or after its own hello — cannot add a step or stop', async () => {
    recorder = newRecorder();
    await recorder.start();
    await until(() => hostState(page), (s) => s.present, 'the toolbar');
    const answers = await page.evaluate(async () => {
      const bind = (window as unknown as Record<string, (m: unknown) => Promise<unknown>>)['__aiuiRecordSteps']!;
      const out: unknown[] = [];
      out.push(await bind({ type: 'step', text: 'Evil step' }));
      out.push(await bind({ type: 'toolbar', command: 'stop' }));
      out.push(await bind({ type: 'step', text: 'Evil step', token: 'guessed' }));
      // Its own hello: the answer carries no token, and the document's script
      // has one already, so the claim made for this hello is refused.
      const hello = (await bind({ type: 'hello' })) as Record<string, unknown>;
      out.push(Object.keys(hello).includes('token'));
      out.push(await bind({ type: 'toolbar', command: 'cancel', token: hello['token'] }));
      out.push(await bind({ type: 'checkin' }));
      const ctl = (window as unknown as Record<string, { claim(t: string): boolean }>)['__aiuiRecordStepsCtl']!;
      out.push(ctl.claim('mine'));
      return out;
    });
    await sleep(300);
    expect(answers).toEqual([null, null, null, false, null, null, false]);
    expect(commands).toEqual([]);
    expect(recorder.isActive).toBe(true);
    // The control: the real toolbar's Stop does reach the recording.
    await clickToolbar(page, 'stop');
    await until(async () => commands.length, (n) => n === 1, 'Stop');
    expect(commands).toEqual([{ kind: 'stop' }]);
  }, 30_000);
});

describe('not connected', () => {
  it('two unanswered check-ins show "The recorder isn\'t answering"; it clears when answered again', async () => {
    recorder = newRecorder({ checkInMs: 150 });
    await recorder.start();
    await until(() => hostState(page), (s) => s.present, 'the toolbar');
    let stalled = true;
    const real = recorder.onMessage.bind(recorder);
    (recorder as unknown as { onMessage: typeof real }).onMessage = (source, message, token) =>
      stalled && (message as { type?: string })?.type === 'checkin' ? new Promise(() => {}) : real(source, message, token);
    const offline = await until(
      () => readToolbar(page),
      (t) => t !== null && t.sub.includes("The recorder isn't answering"),
      'not connected',
    );
    expect(offline!.sub).toBe("The recorder isn't answering. What you do now may not be recorded.");
    stalled = false;
    await until(() => readToolbar(page), (t) => t !== null && !t.sub.includes("isn't answering"), 'connected again', 10_000);
  }, 30_000);
});

describe('a strict Content-Security-Policy', () => {
  for (const [name, route] of [['no inline style or script', '/strict.html'], ['Trusted Types as well', '/strict-tt.html']] as const) {
    it(`the styled toolbar still shows (${name})`, async () => {
      await page.goto(`${origin}${route}`);
      // The control: the policy is in force — the page's own <style>, its
      // inline style attribute and its script are all refused.
      const page0 = await page.evaluate(() => ({
        title: document.title,
        body: getComputedStyle(document.body).backgroundColor,
        inlineWidth: Math.round(document.getElementById('inline')!.getBoundingClientRect().width),
      }));
      expect(page0.title).toBe('Strict');
      expect(page0.body).not.toBe('rgb(255, 0, 0)');
      expect(page0.inlineWidth).not.toBe(300);

      recorder = newRecorder();
      await recorder.start();
      const host = await until(() => hostState(page), (s) => s.present && s.width > 0, 'the toolbar');
      expect(host.topLayer).toBe(true);
      expect(host.width).toBeGreaterThan(500);
      expect(host.height).toBeGreaterThan(30);
      expect(host.height).toBeLessThan(120);
      // Its adopted sheet applied: the graphite surface is on screen.
      const shot = await page.screenshot({ type: 'png' });
      const image = await Jimp.read(shot);
      const box = await page.evaluate(() => {
        const r = document.querySelector('aiui-recorder')!.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      let graphite = 0;
      for (let y = Math.ceil(box.y); y < box.y + box.h; y++) {
        for (let x = Math.ceil(box.x); x < box.x + box.w; x++) {
          const c = Jimp.intToRGBA(image.getPixelColor(x, y));
          if (Math.abs(c.r - 0x1b) + Math.abs(c.g - 0x1e) + Math.abs(c.b - 0x23) <= 6) graphite++;
        }
      }
      expect(graphite / (box.w * box.h)).toBeGreaterThan(0.5);
      const bar = await readToolbar(page);
      expect(bar?.status).toMatch(/^REC/);
      // And it works: the step box opens and takes a step.
      await page.keyboard.press('Alt+Shift+S');
      await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Enter to add'), 'the step box');
      await page.keyboard.type('Click Continue');
      await page.keyboard.press('Enter');
      await until(async () => commands, (c) => c.some((x) => x.kind === 'step'), 'the step');
      expect(commands).toContainEqual({ kind: 'step', text: 'Click Continue' });
      console.log(
        `[strict CSP, ${name}] toolbar ${Math.round(box.w)}×${Math.round(box.h)} at (${Math.round(box.x)}, ${Math.round(box.y)}), ` +
          `top layer ${host.topLayer}, graphite ${(100 * graphite / (box.w * box.h)).toFixed(0)}% of its box; ` +
          `page body ${page0.body}, inline div width ${page0.inlineWidth}px`,
      );
    }, 30_000);
  }
});

describe('using the bar', () => {
  it('dragged by its grip, it docks to the nearest of six places — and says so', async () => {
    await startOn('/app.html');
    const grip = await until(() => toolbarButtonAt(page, 'grip'), (at) => at !== null, 'the grip');
    await page.mouse.move(grip!.x, grip!.y);
    await page.mouse.down();
    await page.mouse.move(grip!.x - 200, grip!.y - 300, { steps: 6 });
    await page.mouse.move(60, 40, { steps: 6 });
    await page.mouse.up();
    await until(async () => commands.length, (n) => n === 1, 'the dock');
    expect(commands).toEqual([{ kind: 'dock', dock: 'tl' }]);
    const at = await page.evaluate(() => {
      const r = document.querySelector('aiui-recorder')!.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    });
    expect(at).toEqual({ x: 16, y: 16 });
    // Neither the drag nor its release was the page's.
    expect(actions).toEqual([]);
  }, 30_000);

  it('Alt+Shift+R puts focus on the bar; arrows move along it; Enter presses; Esc gives focus back', async () => {
    await startOn('/app.html');
    await page.focus('#email');
    await page.keyboard.press('Alt+Shift+R');
    await until(async () => page.evaluate(() => document.activeElement?.tagName), (t) => t === 'AIUI-RECORDER', 'focus on the bar');
    // Pause is first: two to the right is Add step.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Enter to add'), 'the step box');
    await page.keyboard.press('Escape');
    await until(async () => page.evaluate(() => document.activeElement?.id), (id) => id === 'email', 'focus back');
    // From the bar again: Esc alone gives the focus back too.
    await page.keyboard.press('Alt+Shift+R');
    await page.keyboard.press('Escape');
    await until(async () => page.evaluate(() => document.activeElement?.id), (id) => id === 'email', 'focus back again');
    expect(actions).toEqual([]);
    expect(commands).toEqual([]);
  }, 30_000);

  it('"Typing hidden" shows while a secret field has focus — in the page or in a frame — and only a yes or no crosses', async () => {
    const raw: unknown[] = [];
    recorder = new StepRecorder({
      browser: session,
      sendScreenshots: false,
      knownSecrets: () => [],
      onAction: (a) => actions.push(a),
      onPick: (armed) => picks.push(armed),
      toolbar: { ...VIEW },
      onToolbar: (c) => commands.push(c),
      tap: (m) => raw.push(m),
    });
    await recorder.start();
    await page.goto(`${origin}/app.html`);
    await until(() => hostState(page), (s) => s.present, 'the toolbar');
    await page.focus('#pw');
    await page.keyboard.type('hunter2-HIDDEN');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Typing hidden'), 'Typing hidden');
    expect((await readToolbar(page))!.sub).toBe('Typing hidden The value stays in this browser.');
    await page.focus('#email');
    await until(() => readToolbar(page), (t) => t !== null && !t.sub.includes('Typing hidden'), 'not hidden');
    const frame = page.frames().find((f) => f.url().endsWith('/frame.html'))!;
    await frame.focus('#cvc');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Typing hidden'), 'Typing hidden from the frame');
    await frame.focus('#card');
    await until(() => readToolbar(page), (t) => t !== null && !t.sub.includes('Typing hidden'), 'not hidden again');
    const focus = raw.filter((m) => (m as { type?: string }).type === 'focus');
    expect(focus.map((m) => (m as { secret: boolean }).secret)).toEqual([true, false, true, false]);
    expect(JSON.stringify(raw)).not.toContain('hunter2');
  }, 30_000);

  it("a page's modal dialog: the bar goes back on top of it, and the shortcuts still work", async () => {
    await startOn('/dialog.html');
    await page.click('#open');
    expect(await page.evaluate(() => document.getElementById('dlg')!.matches(':modal'))).toBe(true);
    await sleep(300);
    expect((await hostState(page)).topLayer).toBe(true);
    await page.keyboard.press('Alt+Shift+P');
    await until(async () => recorder.isPaused, (p) => p, 'paused with the dialog open');
    expect(await page.evaluate(() => document.getElementById('dlg')!.open)).toBe(true);
  }, 30_000);
});

// ── The fix round (review of the toolbar's server half) ───────────────────

/** Answer the page's messages of one type as the recorder would not: with
 *  nothing (a refusal), or never. */
function interfere(type: string, how: () => 'refuse' | 'hang' | 'pass'): void {
  const real = recorder.onMessage.bind(recorder);
  (recorder as unknown as { onMessage: typeof real }).onMessage = (source, message, token) => {
    if ((message as { type?: string })?.type !== type) return real(source, message, token);
    const mode = how();
    if (mode === 'refuse') return null;
    if (mode === 'hang') return new Promise(() => {});
    return real(source, message, token);
  };
}

describe('a page busy at load (finding 2)', () => {
  it('its bar still works: the claim that landed after the recorder stopped waiting is honoured', async () => {
    await startOn('/busy.html');
    await page.keyboard.press('Alt+Shift+P');
    await until(async () => recorder.isPaused, (p) => p, 'paused');
    expect(commands).toEqual([{ kind: 'paused', paused: true }]);
    await until(() => readToolbar(page), (t) => t !== null && t.status.startsWith('PAUSED'), 'PAUSED shown');
  }, 45_000);

  it('a Pause the recorder refuses is taken back in the page, and so is one it never answers', async () => {
    await startOn('/app.html');
    let mode: 'refuse' | 'hang' | 'pass' = 'refuse';
    interfere('toolbar', () => mode);
    await page.keyboard.press('Alt+Shift+P');
    await sleep(400);
    expect(recorder.isPaused).toBe(false);
    expect((await readToolbar(page))!.status).toMatch(/^REC/);
    // …and the page records again: a click is an action.
    await page.click('#go');
    await until(async () => actions.length, (n) => n === 1, 'the click after the refused pause');

    mode = 'hang';
    await page.keyboard.press('Alt+Shift+P');
    await until(() => readToolbar(page), (t) => t !== null && t.status.startsWith('PAUSED'), 'PAUSED at once', 2_000);
    await until(() => readToolbar(page), (t) => t !== null && t.status.startsWith('REC'), 'taken back: no answer came', 8_000);
    expect(recorder.isPaused).toBe(false);
  }, 45_000);

  it('a check-in the recorder answers with a refusal counts as missed', async () => {
    recorder = newRecorder({ checkInMs: 150 });
    await recorder.start();
    await until(() => hostState(page), (s) => s.present, 'the toolbar');
    let refuse = true;
    interfere('checkin', () => (refuse ? 'refuse' : 'pass'));
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes("The recorder isn't answering"), 'not connected');
    refuse = false;
    await until(() => readToolbar(page), (t) => t !== null && !t.sub.includes("isn't answering"), 'connected again', 10_000);
  }, 30_000);
});

describe('"Typing hidden" (finding 4)', () => {
  it('goes when the popup whose password field had it closes', async () => {
    await startOn('/app.html');
    const popupPromise = context.waitForEvent('page');
    await page.click('#oauth');
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    await until(() => hostState(popup), (s) => s.present, 'the toolbar in the popup');
    await popup.focus('#pop-pw');
    await popup.keyboard.type('hunter2-HIDDEN');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Typing hidden'), 'Typing hidden, from the popup');
    const closed = popup.waitForEvent('close');
    // The window closes on the keydown: the keyup has nowhere to go.
    await popup.keyboard.press('Enter').catch(() => undefined);
    await closed;
    // Back in the main tab: an ordinary field, and a click.
    await page.click('#email');
    await page.keyboard.type('a@b.test');
    await page.click('#go');
    await until(() => readToolbar(page), (t) => t !== null && !t.sub.includes('Typing hidden'), 'the chip gone');
  }, 45_000);

  it('lights for a secret field that has focus as the page comes up, or when Record is pressed', async () => {
    await startOn('/autofocus.html');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('pw');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Typing hidden'), 'Typing hidden, autofocused');
    await recorder.stop();

    // Focus already in the password box when Record is pressed.
    await page.goto(`${origin}/app.html`);
    await page.focus('#pw');
    recorder = newRecorder();
    await recorder.start();
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Typing hidden'), 'Typing hidden, focused before Record');
  }, 45_000);

  it('a confirmation outranks it: Removed… Restore shows while a secret field has focus', async () => {
    await startOn('/app.html');
    await page.focus('#pw');
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Typing hidden'), 'Typing hidden');
    recorder.setToolbar({
      ...VIEW,
      notice: { kind: 'removed', text: 'Removed: Clicked button "Go"', seq: 1, remainingMs: 8_000, restore: true },
    });
    const shown = await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Removed:'), 'the notice');
    expect(shown!.sub).toBe('Removed: Clicked button "Go" Restore');
  }, 30_000);
});

describe('after the recording (finding 6)', () => {
  it('the bar lets clicks through to the page as soon as it is not recording — bar its Close button', async () => {
    await page.goto(`${origin}/wide.html`);
    recorder = newRecorder();
    await recorder.start();
    await until(() => hostState(page), (s) => s.present && s.width > 300, 'the toolbar');
    recorder.setToolbar({ ...VIEW, phase: 'done', endKind: 'done', endText: 'Done · 1 step written to t.md' });
    await recorder.stop();
    await recorder.flushToolbar();
    await until(() => readToolbar(page), (t) => t !== null && t.sub.includes('Done'), 'the done state');
    // The full-width button's middle is under the bar: clicked at once.
    await page.click('#wide', { timeout: 1_500 });
    expect(await page.evaluate('window.wideClicks')).toBe(1);
    expect((await hostState(page)).present).toBe(true);
    // Close still works.
    await clickToolbar(page, 'close');
    await until(() => hostState(page), (s) => !s.present, 'the bar closed');
  }, 30_000);
});

describe("a page's native popover menu (finding 8, documented)", () => {
  it('a click on a toolbar button light-dismisses it; Alt+Shift+C arms Add check with it still open', async () => {
    await startOn('/menu.html');
    const menuOpen = (): Promise<boolean> => page.evaluate(() => document.getElementById('menu')!.matches(':popover-open'));
    await page.evaluate(() => document.getElementById('menu')!.showPopover());
    expect(await menuOpen()).toBe(true);
    await page.keyboard.press('Alt+Shift+C');
    await until(async () => picks, (p) => p.length === 1, 'armed by the shortcut');
    expect(await menuOpen()).toBe(true);
    await page.keyboard.press('Alt+Shift+C');
    await until(async () => picks, (p) => p.length === 2, 'disarmed by the shortcut');
    expect(await menuOpen()).toBe(true);
    // The platform's light dismiss runs on the pointer going down, before any
    // listener: the bar's own button closes the menu.
    await clickToolbar(page, 'check');
    await until(async () => picks, (p) => p.length === 3, 'armed by the button');
    expect(await menuOpen()).toBe(false);
  }, 30_000);
});

describe('the control object (finding 11)', () => {
  it('a page script that calls it first can neither claim the document nor push state; the bar still works', async () => {
    await startOn('/claims.html');
    expect(await page.evaluate('[window.claimed, window.pushed, window.flushed]')).toEqual([false, false, '[]']);
    await page.keyboard.press('Alt+Shift+Z');
    await until(async () => commands.length, (n) => n === 1, 'Undo from the bar');
    expect(commands).toEqual([{ kind: 'undo' }]);
  }, 30_000);
});
