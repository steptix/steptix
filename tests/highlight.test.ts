/**
 * The interaction highlight in a real browser
 * (docs/specs/SPEC-interaction-highlight.md §10.1 cases 2–8).
 *
 *  2. `executeAction` marks exactly what each action acts on or reads, through
 *     a recording sink, and no probe marks anything.
 *  3. A sink that never settles cannot hold an action up.
 *  4. The in-page controller (scripts/highlight.js), read through its
 *     registry handle — the only way into rings a closed shadow root keeps
 *     from `document.getAnimations()`.
 *  5. It draws under a strict Content-Security-Policy.
 *  6. Steptix's own readers do not see it.
 *  7. A screenshot that goes to a model does not show it.
 *  8. Cases 4 and 5 again in Firefox and WebKit, where they are installed.
 *     CI installs Chromium only, so those two engines run on a developer's
 *     machine and are skipped in CI: a change to highlight.js should be run
 *     here locally with all three installed (`npx playwright install`).
 *
 * Nothing here waits on the clock: rings are ended with `finishAll()`, a
 * removed element is checked two animation frames later inside the page (a
 * condition), and "drawn recently" runs on an injected `now`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { chromium, firefox, webkit, type Browser, type BrowserType, type Frame, type Locator, type Page } from 'playwright';
import Jimp from 'jimp';
import { executeAction } from '../src/browser/actions.js';
import {
  HIGHLIGHT_DEFAULTS,
  HIGHLIGHT_REGISTRY_KEY,
  HIGHLIGHT_TAG,
  createHighlighter,
  drawRings,
  type HighlightKind,
  type HighlightSink,
  type ResolvedHighlight,
} from '../src/browser/highlight.js';
import { captureDomSnapshot, findInDom } from '../src/browser/dom-cleaner.js';
import { locateTexts } from '../src/browser/locate-text.js';
import { capturePageSignal, diagnosePageState } from '../src/browser/page-state.js';
import { captureScreenshot } from '../src/browser/screenshot.js';
import type { AIAction } from '../src/ai/types.js';
import { listenFetchable } from './listen-fetchable.cjs';

/** Long enough that no ring ends by itself while a test looks at it. */
const LONG: ResolvedHighlight = { durationMs: 10_000, colors: { ...HIGHLIGHT_DEFAULTS.colors }, inScreenshots: true };

function act(action: Omit<AIAction, 'description'>): AIAction {
  return { description: `${action.action} under test`, ...action } as AIAction;
}

interface RingInfo {
  kind: HighlightKind;
  box: { left: number; top: number; width: number; height: number } | null;
  onScreen: boolean;
  hidden: boolean;
  borderWidth: string;
  animates: string[];
  envelope: { target: string; animates: string[] } | null;
  glow: { target: string; animates: string[] } | null;
}

/** The live rings in this document, or null when it has no host. */
function ringsIn(target: Page | Frame): Promise<RingInfo[] | null> {
  return target.evaluate(({ tag, key }) => {
    const host = document.documentElement.querySelector(`:scope > ${tag}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return host ? (host as any)[Symbol.for(key)].rings() : null;
  }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
}

/** `finishAll()`, awaited in the page: resolves once the rings are gone. */
async function finishAll(target: Page | Frame): Promise<void> {
  await target.evaluate(async ({ tag, key }) => {
    const host = document.documentElement.querySelector(`:scope > ${tag}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (host) await (host as any)[Symbol.for(key)].finishAll();
  }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
}

function hostIn(target: Page | Frame): Promise<boolean> {
  return target.evaluate((tag) => document.documentElement.querySelector(`:scope > ${tag}`) !== null, HIGHLIGHT_TAG);
}

function rectOf(locator: Locator): Promise<{ left: number; top: number; width: number; height: number }> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

function contains(
  box: { left: number; top: number; width: number; height: number },
  rect: { left: number; top: number; width: number; height: number },
): boolean {
  return box.left <= rect.left && box.top <= rect.top
    && box.left + box.width >= rect.left + rect.width
    && box.top + box.height >= rect.top + rect.height;
}

// ── 2 and 3: what executeAction marks ────────────────────────────────────────

describe('executeAction marks at the act (§2.2)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  async function pageWith(html: string): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    return page;
  }

  interface Recorded { locator: Locator; kind: HighlightKind; max: number | undefined }

  /** A sink that draws nothing and remembers every mark. */
  function recordingSink(): { sink: HighlightSink; marks: Recorded[] } {
    const marks: Recorded[] = [];
    return { sink: { mark: (locator, kind, max) => { marks.push({ locator, kind, max }); } }, marks };
  }

  /** Each mark as the elements its locator matches now: their ids, and
   *  whether they are in a frame. */
  async function resolved(marks: Recorded[]): Promise<Array<{ kind: HighlightKind; max: number | undefined; ids: string[] }>> {
    return Promise.all(marks.map(async (m) => ({
      kind: m.kind,
      max: m.max,
      ids: await m.locator.evaluateAll((els) =>
        els.map((e) => `${e.id}${e.ownerDocument.defaultView !== e.ownerDocument.defaultView?.top ? '@frame' : ''}`)),
    })));
  }

  async function marksOf(html: string, action: AIAction, options: Record<string, unknown> = {}) {
    const page = await pageWith(html);
    try {
      const { sink, marks } = recordingSink();
      const result = await executeAction(page, action, undefined, undefined, { highlight: sink, ...options });
      return { result, marks: await resolved(marks) };
    } finally {
      await page.close();
    }
  }

  it('click: one act, on the element clicked', async () => {
    const { result, marks } = await marksOf('<button id="go">Go</button>', act({ action: 'click', selector: '#go' }));
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['go'] }]);
  });

  it('a hidden checkbox marks the label clicked in its place, not the input', async () => {
    const { result, marks } = await marksOf(
      '<input type="checkbox" id="agree" aria-label="Agree" style="display:none"><label for="agree" id="agree-label">Agree</label>',
      act({ action: 'click', selector: '[aria-label="Agree"]' }),
    );
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['agree-label'] }]);
  });

  it('type: one act on the field', async () => {
    const { result, marks } = await marksOf('<input id="name">', act({ action: 'type', selector: '#name', value: 'Ada' }));
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['name'] }]);
  });

  it('type key by key (`sequential`): one act on the field, on the key-by-key route', async () => {
    const { result, marks } = await marksOf(
      '<input id="name">',
      act({ action: 'type', selector: '#name', value: 'Ada', sequential: true }),
    );
    expect(result.success).toBe(true);
    expect(result.typed).toEqual({ by: 'keys' }); // pressSequentially, not fill
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['name'] }]);
  });

  it('type into something fill refuses: still one act, through the click-and-keyboard fallback', async () => {
    const { result, marks } = await marksOf(
      '<div id="wrap" contenteditable="false" tabindex="0">field</div>',
      act({ action: 'type', selector: '#wrap', value: 'Ada' }),
    );
    // The fallback refuses to type where the focus took no text; what matters
    // here is that the field was marked once, before it.
    expect(result.success).toBe(false);
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['wrap'] }]);
  });

  it('select and hover: one act each', async () => {
    const html = '<select id="pick"><option>Ada</option><option>Bob</option></select><button id="host">Host</button>';
    const selected = await marksOf(html, act({ action: 'select', selector: '#pick', value: 'Bob' }));
    expect(selected.result.success).toBe(true);
    expect(selected.marks).toEqual([{ kind: 'act', max: undefined, ids: ['pick'] }]);
    const hovered = await marksOf(html, act({ action: 'hover', selector: '#host' }));
    expect(hovered.result.success).toBe(true);
    expect(hovered.marks).toEqual([{ kind: 'act', max: undefined, ids: ['host'] }]);
  });

  const rows = '<p class="row" id="r1">One</p><p class="row" id="r2">Two</p><p class="row" id="r3" hidden>Three</p>';

  it('read: one read, of the match read', async () => {
    const { result, marks } = await marksOf(rows, act({ action: 'read', selector: '.row', as: 'first' }));
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'read', max: undefined, ids: ['r1'] }]);
  });

  it('read of every match: one read over every match, capped at 20', async () => {
    const { result, marks } = await marksOf(rows, act({ action: 'read', selector: '.row', multiple: true, as: 'all' }));
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'read', max: 20, ids: ['r1', 'r2', 'r3'] }]);
  });

  it('count: one read over what was counted, capped at 20; a count of 0 marks nothing', async () => {
    const counted = await marksOf(rows, act({ action: 'count', selector: '.row', as: 'n' }));
    expect(counted.result.capturedValue).toBe('2');
    expect(counted.marks).toEqual([{ kind: 'read', max: 20, ids: ['r1', 'r2'] }]);
    const none = await marksOf(rows, act({ action: 'count', selector: '.missing', as: 'n' }));
    expect(none.result.capturedValue).toBe('0');
    expect(none.marks).toEqual([]);
  });

  it('measuring and the hoisted wait mark nothing of their own', async () => {
    const { result, marks } = await marksOf(
      '<button id="go">Go</button>',
      act({ action: 'click', selector: '#go' }),
      { measure: true, ambiguousTarget: 'fail' },
    );
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['go'] }]);
  });

  it('probes mark nothing: an ambiguity refusal marks zero elements', async () => {
    const { result, marks } = await marksOf(
      '<button class="dup">A</button><button class="dup">B</button>',
      act({ action: 'click', selector: '.dup' }),
      { ambiguousTarget: 'fail' },
    );
    expect(result.success).toBe(false);
    expect(result.matchCount).toBe(2);
    expect(marks).toEqual([]);
  });

  it('iframe promotion marks the element in the frame, never the iframe', async () => {
    const { result, marks } = await marksOf(
      `<iframe id="f" srcdoc="<button id='inner'>Inner</button>"></iframe>`,
      act({ action: 'click', selector: '#f #inner' }),
    );
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['inner@frame'] }]);
  });

  it('a sink that throws cannot fail the action', async () => {
    const page = await pageWith('<button id="go">Go</button>');
    try {
      const sink: HighlightSink = { mark: () => { throw new Error('sink broke'); } };
      const result = await executeAction(page, act({ action: 'click', selector: '#go' }), undefined, undefined, { highlight: sink });
      expect(result.success).toBe(true);
    } finally {
      await page.close();
    }
  });

  // What this catches, and what it cannot: `executeAction` passing the
  // sink's return value back through an `await` (or otherwise waiting on the
  // sink) hangs here, and the test fails on its timeout. It cannot catch an
  // `await` added in front of `mark(...)` inside a handler: the handlers'
  // `mark` adapter returns undefined by construction, so that `await` would
  // resolve at once. The real sink cannot block either way — `createHighlighter`
  // never returns its draw — and tests/highlight-paths.test.ts's late-element
  // case shows the act finishing before a ring that has not been drawn yet.
  it('never awaits the sink: the action settles while the mark never does (§5.1)', async () => {
    const page = await pageWith('<button id="go">Go</button>');
    try {
      let started = 0;
      let settled = false;
      const sink: HighlightSink = {
        mark: () => {
          started++;
          // What an awaited mark would hang on. Returned through a cast,
          // because a sink that returned a promise is exactly what must not
          // be waited for.
          const never = new Promise<void>(() => {}).finally(() => { settled = true; });
          return never as unknown as void;
        },
      };
      const result = await executeAction(page, act({ action: 'click', selector: '#go' }), undefined, undefined, { highlight: sink });
      expect(result.success).toBe(true);
      expect(started).toBe(1);
      expect(settled).toBe(false);
    } finally {
      await page.close();
    }
  });
});

// ── 4, 5 and 8: the controller, per engine ───────────────────────────────────

const ENGINES: Array<{ name: string; type: BrowserType; installed: boolean }> = [
  { name: 'chromium', type: chromium, installed: true },
  { name: 'firefox', type: firefox, installed: existsSync(firefox.executablePath()) },
  { name: 'webkit', type: webkit, installed: existsSync(webkit.executablePath()) },
];

/** `default-src 'none'; script-src 'self'; style-src 'none'`, with a page
 *  script that records every violation (§10.1 case 5). `img-src 'self'`
 *  because Firefox fetches /favicon.ico on its own and reports the refusal
 *  as an img-src violation, which says nothing about the overlay. */
const CSP = "default-src 'none'; script-src 'self'; style-src 'none'; img-src 'self'";
const CSP_PAGE = '<!doctype html><html><head><script src="/app.js"></script></head>'
  + '<body><button id="item">Item</button></body></html>';
const CSP_APP = "window.__violations = [];\n"
  + "document.addEventListener('securitypolicyviolation', function (e) { window.__violations.push(e.violatedDirective); });\n";

for (const engine of ENGINES) {
  describe.skipIf(!engine.installed)(`the in-page controller — ${engine.name} (§3.3)`, () => {
    let browser: Browser;
    let server: http.Server;
    let origin: string;

    beforeAll(async () => {
      browser = await engine.type.launch({ headless: true });
      server = http.createServer((req, res) => {
        const send = (type: string, body: string): void => {
          res.writeHead(200, { 'content-type': type, 'content-security-policy': CSP });
          res.end(body);
        };
        if (req.url === '/app.js') send('text/javascript', CSP_APP);
        else if (req.url === '/') send('text/html', CSP_PAGE);
        else {
          res.writeHead(404, { 'content-security-policy': CSP });
          res.end();
        }
      });
      const port = await listenFetchable(server, '127.0.0.1');
      origin = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    });

    async function pageWith(html: string): Promise<Page> {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
      return page;
    }

    it('one mark draws one ring around the element', async () => {
      const page = await pageWith('<button id="item" style="margin:40px">Item</button>');
      try {
        expect(await drawRings(page.locator('#item'), 'act', LONG)).toBe(1);
        const rings = await ringsIn(page);
        expect(rings).toHaveLength(1);
        expect(rings![0]!.kind).toBe('act');
        expect(rings![0]!.onScreen).toBe(true);
        expect(contains(rings![0]!.box!, await rectOf(page.locator('#item')))).toBe(true);
      } finally {
        await page.close();
      }
    });

    it('one ring per element: marking it again restarts it, a second element gets its own', async () => {
      const page = await pageWith('<button id="item">Item</button><button id="host">Host</button>');
      try {
        await drawRings(page.locator('#item'), 'act', LONG);
        await drawRings(page.locator('#item'), 'read', LONG);
        const once = await ringsIn(page);
        expect(once).toHaveLength(1);
        expect(once![0]!.kind).toBe('read');
        await drawRings(page.locator('#host'), 'act', LONG);
        expect(await ringsIn(page)).toHaveLength(2);
      } finally {
        await page.close();
      }
    });

    it('`max` rings only the first matches', async () => {
      const page = await pageWith('<p class="row">1</p><p class="row">2</p><p class="row">3</p>');
      try {
        expect(await drawRings(page.locator('.row'), 'read', LONG, 2)).toBe(2);
        expect(await ringsIn(page)).toHaveLength(2);
      } finally {
        await page.close();
      }
    });

    it('the 33rd ring finishes the oldest', async () => {
      const buttons = Array.from({ length: 33 }, (_, i) =>
        `<button id="b${i}" style="position:absolute;left:${(i % 11) * 60 + 10}px;top:${Math.floor(i / 11) * 50 + 10}px;width:40px;height:30px">${i}</button>`).join('');
      const page = await pageWith(buttons);
      try {
        for (let i = 0; i < 33; i++) await drawRings(page.locator(`#b${i}`), 'act', LONG);
        const rings = (await ringsIn(page))!;
        expect(rings).toHaveLength(32);
        const lefts = rings.map((r) => `${Math.round(r.box!.left + 3)},${Math.round(r.box!.top + 3)}`);
        const at = async (i: number): Promise<string> => {
          const r = await rectOf(page.locator(`#b${i}`));
          return `${Math.round(r.left)},${Math.round(r.top)}`;
        };
        expect(lefts).not.toContain(await at(0));
        expect(lefts).toContain(await at(1));
        expect(lefts).toContain(await at(32));
      } finally {
        await page.close();
      }
    });

    it('finishAll() ends every ring and removes the host', async () => {
      const page = await pageWith('<button id="item">Item</button><button id="host">Host</button>');
      try {
        await drawRings(page.locator('button'), 'act', LONG);
        expect(await hostIn(page)).toBe(true);
        await finishAll(page);
        expect(await hostIn(page)).toBe(false);
      } finally {
        await page.close();
      }
    });

    it('a ring whose element is removed is gone two animation frames later', async () => {
      const page = await pageWith('<button id="item">Item</button>');
      try {
        await drawRings(page.locator('#item'), 'act', LONG);
        const after = await page.evaluate(async ({ tag, key }) => {
          const host = document.documentElement.querySelector(`:scope > ${tag}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handle = (host as any)[Symbol.for(key)];
          document.getElementById('item')!.remove();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { rings: handle.rings().length, host: host!.isConnected };
        }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
        expect(after).toEqual({ rings: 0, host: false });
      } finally {
        await page.close();
      }
    });

    it('an iframe target is ringed in the iframe\'s own document', async () => {
      const page = await pageWith(`<iframe id="f" srcdoc="<button id='inner'>Inner</button>"></iframe>`);
      try {
        expect(await drawRings(page.frameLocator('#f').locator('#inner'), 'act', LONG)).toBe(1);
        const frame = page.frames().find((f) => f !== page.mainFrame())!;
        expect(await ringsIn(frame)).toHaveLength(1);
        expect(await hostIn(page)).toBe(false);
      } finally {
        await page.close();
      }
    });

    it('an open-shadow target is ringed', async () => {
      const page = await pageWith('<div id="host"></div>');
      try {
        await page.evaluate(() => {
          const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
          const b = document.createElement('button');
          b.id = 'shadowed';
          b.textContent = 'Shadowed';
          root.appendChild(b);
        });
        expect(await drawRings(page.locator('#shadowed'), 'act', LONG)).toBe(1);
        const rings = await ringsIn(page);
        expect(rings).toHaveLength(1);
        expect(contains(rings![0]!.box!, await rectOf(page.locator('#shadowed')))).toBe(true);
      } finally {
        await page.close();
      }
    });

    it('a zero-size target draws nothing, and adds no host', async () => {
      const page = await pageWith('<input type="file" id="file" style="display:none">');
      try {
        expect(await drawRings(page.locator('#file'), 'act', LONG)).toBe(0);
        expect(await hostIn(page)).toBe(false);
      } finally {
        await page.close();
      }
    });

    it('moves (scale) normally, and only fades under reduced motion (§5.4)', async () => {
      const page = await pageWith('<button id="item">Item</button>');
      try {
        await drawRings(page.locator('#item'), 'act', LONG);
        expect((await ringsIn(page))![0]!.animates).toContain('transform');
        await finishAll(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await drawRings(page.locator('#item'), 'act', LONG);
        expect((await ringsIn(page))![0]!.animates).toEqual(['opacity']);
      } finally {
        await page.close();
      }
    });

    it('the ring\'s visibility moves only opacity and transform, on the outer element; the glow is the inner one\'s (§16.9)', async () => {
      // What lets the compositor run the fade while the page's main thread is
      // blocked: an animation that also moved box-shadow would be main-thread
      // as a whole, and freeze at full strength with the page.
      const page = await pageWith('<button id="item">Item</button>');
      try {
        await drawRings(page.locator('#item'), 'act', LONG);
        const [ring] = (await ringsIn(page))!;
        expect(ring!.envelope).toEqual({ target: 'ring', animates: ['opacity', 'transform'] });
        expect(ring!.glow).toEqual({ target: 'glow', animates: ['boxShadow'] });
        expect(ring!.borderWidth).toBe('2px');
        await finishAll(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await drawRings(page.locator('#item'), 'act', LONG);
        const [still] = (await ringsIn(page))!;
        expect(still!.envelope).toEqual({ target: 'ring', animates: ['opacity'] });
        expect(still!.glow).toBeNull();
      } finally {
        await page.close();
      }
    });

    it('draws under a strict CSP with no violation, while the page\'s own style attribute is refused (§10.1 case 5)', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}/`);
        expect(await drawRings(page.locator('#item'), 'act', LONG)).toBe(1);
        const rings = await ringsIn(page);
        expect(rings).toHaveLength(1);
        // The adopted sheet applied: its border, not a default.
        expect(rings![0]!.borderWidth).toBe('2px');
        // The control, after the mark: CSP really is on. A violation event is
        // queued as a task, so once the control's has arrived, any the mark
        // caused before it has too.
        const refused = await page.evaluate(() => {
          const d = document.createElement('div');
          d.setAttribute('style', 'color: rgb(1, 2, 3)');
          document.body.appendChild(d);
          const color = getComputedStyle(d).color;
          d.remove();
          return color !== 'rgb(1, 2, 3)';
        });
        expect(refused).toBe(true);
        await page.waitForFunction(() => (window as unknown as { __violations: string[] }).__violations.length > 0);
        const violations = await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
        expect(violations).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
  });
}

// ── 6 and 7: Steptix's readers, and the model's screenshots ──────────────────

describe('what Steptix reads while a ring is live', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  const PAGE = '<!doctype html><html><body style="margin:0;background:#ffffff">'
    + '<button id="go" style="position:absolute;left:100px;top:100px;width:80px;height:30px">Go</button>'
    + '<p id="note" style="position:absolute;left:100px;top:200px">Order 12 was placed.</p>'
    + '<script>window.clicks = 0; document.getElementById("go").addEventListener("click", () => { window.clicks++; });</script>'
    + '</body></html>';

  it('leaves the DOM snapshot, find, locateTexts, diagnosis and the fingerprint unchanged (§10.1 case 6)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      const before = {
        snapshot: await captureDomSnapshot(page),
        find: await findInDom(page, 'Go'),
        texts: await locateTexts(page, ['Order 12 was placed.']),
        diagnosis: await diagnosePageState(page),
        signal: await capturePageSignal(page),
      };
      await drawRings(page.locator('#go'), 'act', LONG);
      // The ring is live and its host is in the DOM, so the comparisons below
      // are about a page that really carries it.
      expect(await ringsIn(page)).toHaveLength(1);
      expect(await page.content()).toContain(`<${HIGHLIGHT_TAG}`);
      const after = {
        snapshot: await captureDomSnapshot(page),
        find: await findInDom(page, 'Go'),
        texts: await locateTexts(page, ['Order 12 was placed.']),
        diagnosis: await diagnosePageState(page),
        signal: await capturePageSignal(page),
      };
      expect(after.snapshot).not.toContain(HIGHLIGHT_TAG);
      expect(after).toEqual(before);
    } finally {
      await page.close();
    }
  });

  it('leaves the ringed element clickable, and the element under its centre', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      await drawRings(page.locator('#go'), 'act', LONG);
      expect(await page.evaluate(() => document.elementFromPoint(140, 115)?.id)).toBe('go');
      const result = await executeAction(page, act({ action: 'click', selector: '#go' }));
      expect(result.success).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('hides the ring from a model\'s screenshot, shows it in the report\'s, and puts it back (§10.1 case 7)', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(PAGE);
      // A static ring at full strength: no scale, no pulse, ten seconds.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      let clock = 1_000;
      const highlighter = createHighlighter(LONG, { now: () => clock });
      highlighter.mark(page.locator('#go'), 'act');
      await page.waitForFunction(({ tag, key }) => {
        const host = document.documentElement.querySelector(`:scope > ${tag}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return host !== null && (host as any)[Symbol.for(key)].rings().length === 1;
      }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });

      // The ring's 2px border runs from x = 97 (the button's left, outset 3)
      // to 99; the middle of its left edge is (98, 115).
      const pixelAt = async (base64: string | undefined): Promise<{ r: number; g: number; b: number }> => {
        const image = await Jimp.read(Buffer.from(base64!, 'base64'));
        const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(98, 115));
        return { r, g, b };
      };
      const near = (actual: { r: number; g: number; b: number }, expected: [number, number, number]): boolean =>
        Math.abs(actual.r - expected[0]) <= 12 && Math.abs(actual.g - expected[1]) <= 12 && Math.abs(actual.b - expected[2]) <= 12;
      const RING: [number, number, number] = [0x3b, 0x82, 0xf6];
      const BACKGROUND: [number, number, number] = [255, 255, 255];

      const frames = page.frames();
      const spies = frames.map((f) => vi.spyOn(f, 'evaluate'));
      try {
        const report = await captureScreenshot(page);
        expect(near(await pixelAt(report?.base64), RING)).toBe(true);

        const model = await highlighter.hiddenFor(page, () => captureScreenshot(page));
        expect(near(await pixelAt(model?.base64), BACKGROUND)).toBe(true);
        expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true);

        // restore() put it back for the person watching.
        const again = await captureScreenshot(page);
        expect(near(await pixelAt(again?.base64), RING)).toBe(true);

        // No ring drawn within its duration on this clock: straight through,
        // with no round trip to any frame. "Within its duration" counts from
        // when the draw landed and adds a margin for the frames between the
        // page and the clock (review round 1, finding 7), so the clock moves
        // a whole second ring's life on, well past both.
        //
        // The first capture after the lifetime still asks the frame that drew
        // the ring, once: its entry goes only when the frame itself answers
        // that no Steptix host is left (§16.10), so the ring is ended here
        // first, as its own retire would end it. From then on, straight
        // through.
        await finishAll(page);
        clock += 2 * LONG.durationMs;
        await highlighter.hiddenFor(page, () => captureScreenshot(page));
        for (const s of spies) s.mockClear();
        const untouched = await highlighter.hiddenFor(page, () => captureScreenshot(page));
        expect(untouched).not.toBeNull();
        for (const s of spies) expect(s).not.toHaveBeenCalled();
      } finally {
        for (const s of spies) s.mockRestore();
      }
    } finally {
      await page.close();
    }
  });
});
