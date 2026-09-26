/**
 * One secret-field rule, three readers (src/browser/scripts/secret-field.js).
 *
 * The whole-page snapshot (capture-dom.js), the `expand` walk
 * (`expandDomSubtree`) and the step recorder (record-steps.js) each used to —
 * or, for the recorder, would have had to — carry their own copy of
 * `isSecretField`. They now splice in the same text. This asks all three the
 * same questions against a real Chromium and requires them to agree with the
 * rule itself, field by field: a secret field's value is `***` in both
 * captures and never reaches the recorder's binding; any other field's value
 * shows in all three.
 *
 * The cases are the ones the rule's own comments were written about — the
 * show/hide toggle's `type="text"`, `pwd`, the `pass` fence, `pin` tokens, a
 * placeholder that names a password and one that only says "keyword".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureDomSnapshot, expandDomSubtree, loadSecretFieldRule } from '../src/browser/dom-cleaner.js';
import { PageTracker } from '../src/browser/manager.js';
import { StepRecorder } from '../src/recorder/step-recorder.js';
import type { RecordedAction } from '../src/recorder/types.js';

const CASES: Array<{ id: string; html: string; secret: boolean }> = [
  { id: 'type-password', html: '<input type="password">', secret: true },
  { id: 'toggled-pwd', html: '<input type="text" name="pwd">', secret: true },
  { id: 'autocomplete', html: '<input type="text" autocomplete="current-password">', secret: true },
  { id: 'aria-token', html: '<input type="text" aria-label="API token">', secret: true },
  { id: 'placeholder-pw', html: '<input type="text" placeholder="Password">', secret: true },
  { id: 'pin-code', html: '<input type="text" name="pin_code">', secret: true },
  { id: 'user-key', html: '<input type="text" id="user_key">', secret: true },
  { id: 'secret-notes', html: '<textarea name="secret_notes"></textarea>', secret: true },
  { id: 'passenger', html: '<input type="text" name="passenger1_name">', secret: false },
  { id: 'keyword', html: '<input type="text" placeholder="Search by keyword">', secret: false },
  { id: 'shipping', html: '<input type="text" name="shipping_address">', secret: false },
  { id: 'email', html: '<input type="email" name="email">', secret: false },
];

/** The value typed into each case — unique, so a leak names its field. */
const valueFor = (id: string): string => `v4lue-${id}-xyz`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  const fields = CASES.map((c) =>
    c.html.replace(/^<(input|textarea)/, `<$1 data-testid="${c.id}"`),
  ).join('\n');
  await page.setContent(`<!doctype html><html><body><form id="f">${fields}</form></body></html>`);
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
});

describe('isSecretField — the snapshot, expand and the recorder agree with the one rule', () => {
  it('the rule itself answers as the cases say', async () => {
    const answers = (await page.evaluate(`(() => {
      ${loadSecretFieldRule()}
      return Array.from(document.querySelectorAll('[data-testid]')).map(
        (el) => [el.getAttribute('data-testid'), isSecretField(el)]);
    })()`)) as Array<[string, boolean]>;
    expect(Object.fromEntries(answers)).toEqual(Object.fromEntries(CASES.map((c) => [c.id, c.secret])));
  });

  it('the recorder withholds exactly the fields the rule calls secret', async () => {
    const context = page.context();
    const pageTracker = new PageTracker(page);
    const raw: unknown[] = [];
    const recorder = new StepRecorder({
      browser: { browser, context, page, pageTracker },
      sendScreenshots: false,
      knownSecrets: () => [],
      onAction: () => {},
      onPick: () => {},
      tap: (m) => raw.push(m),
    });
    await recorder.start();
    for (const c of CASES) await page.fill(`[data-testid="${c.id}"]`, valueFor(c.id));
    const done = (await recorder.stop()).filter((a): a is RecordedAction => a.kind === 'type');
    const byId = new Map(done.map((a) => [a.target?.testId, a]));
    const wire = JSON.stringify(raw);
    for (const c of CASES) {
      const a = byId.get(c.id);
      expect(a, c.id).toBeDefined();
      expect(a!.secret === true, c.id).toBe(c.secret);
      if (c.secret) {
        expect(a!.value, c.id).toBeUndefined();
        expect(wire, `${c.id} crossed the binding`).not.toContain(valueFor(c.id));
      } else {
        expect(a!.value, c.id).toBe(valueFor(c.id));
      }
    }
  }, 30_000);

  it('the whole-page snapshot and the expand walk mask exactly those fields', async () => {
    // Values are already filled by the test above; fill again so this test
    // stands alone when run by name.
    for (const c of CASES) await page.fill(`[data-testid="${c.id}"]`, valueFor(c.id));
    const snapshot = await captureDomSnapshot(page);
    const expanded = await expandDomSubtree(page, '#f');
    for (const [label, text] of [['snapshot', snapshot], ['expand', expanded]] as const) {
      for (const c of CASES) {
        const line = text.split('\n').find((l) => l.includes(`data-testid="${c.id}"`));
        expect(line, `${label}: ${c.id}`).toBeDefined();
        if (c.secret) {
          expect(line, `${label}: ${c.id}`).toContain('value="***"');
          expect(text, `${label}: ${c.id}`).not.toContain(valueFor(c.id));
        } else {
          expect(line, `${label}: ${c.id}`).toContain(`value="${valueFor(c.id)}"`);
        }
      }
    }
  }, 30_000);
});
