/**
 * What the model can SEE of an uploader — stories/upload-action.md §7.
 *
 * A styled uploader hides its `<input type="file">` behind a button. The
 * snapshot collapses hidden elements to bare tag placeholders with every
 * attribute dropped, which left the model looking at a button with nothing to
 * upload to. One narrow carve-out fixes that: a hidden file input keeps enough
 * to be named and told apart from the next field.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { captureDomSnapshot, expandDomSubtree } from '../src/browser/dom-cleaner.js';

let browser: Browser;
let page: Page;

const PAGE = `
  <div id="uploader">
    <button id="choose">Choose file</button>
    <input type="file" id="identity-file" name="proof" accept=".pdf,.png" multiple style="display:none">
  </div>
  <input type="file" id="visible-file" name="statement" accept=".pdf">
  <input type="text" id="hidden-text" name="secret" style="display:none">
  <div id="wrapper" style="display:none">
    <input type="file" id="buried" name="buried">
  </div>
`;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(PAGE);
}, 60_000);

afterAll(async () => {
  // Defensive: a teardown throw here fails the whole file even when every
  // test passed.
  try { await browser?.close(); } catch { /* noop */ }
}, 15_000);

describe('the DOM snapshot', () => {
  it('keeps a hidden file input nameable, with the attributes that matter', async () => {
    const snapshot = await captureDomSnapshot(page);
    const line = snapshot.split('\n').find((l) => l.includes('identity-file'));

    expect(line, 'the hidden file input should still appear').toBeDefined();
    expect(line).toContain('hidden: display:none');
    expect(line).toContain('id="identity-file"');
    expect(line).toContain('type="file"');
    expect(line).toContain('name="proof"');
    // `accept` and `multiple` are what let the model tell a single-file field
    // from a multi-file one, and pick the right field for the right file.
    expect(line).toContain('accept=".pdf,.png"');
    expect(line).toContain('multiple');
  }, 30_000);

  it('still strips a hidden NON-file input bare', async () => {
    // The carve-out is one tag wide on purpose. A hidden text input is not a
    // target, and its attributes are the noise the placeholder rule exists for.
    const snapshot = await captureDomSnapshot(page);
    const line = snapshot.split('\n').find((l) => l.includes('hidden: display:none') && !l.includes('type="file"'));

    expect(line).toBeDefined();
    expect(line).not.toContain('hidden-text');
    expect(line).not.toContain('secret');
  }, 30_000);

  it('keeps accept and multiple on a VISIBLE file input too', async () => {
    const snapshot = await captureDomSnapshot(page);
    const line = snapshot.split('\n').find((l) => l.includes('visible-file'));

    expect(line).toBeDefined();
    expect(line).toContain('accept=".pdf"');
  }, 30_000);

  it('leaves a file input inside a hidden ANCESTOR collapsed with it', async () => {
    // Stated limit, not an oversight: the placeholder rule still applies to the
    // wrapper, and the opener route covers that layout.
    const snapshot = await captureDomSnapshot(page);
    expect(snapshot).not.toContain('buried');
  }, 30_000);

  it('shows the hidden input when the model expands the uploader', async () => {
    // `expand` uses a second walker, which dropped hidden elements outright —
    // so expanding an uploader card showed the button and no input at all.
    const expanded = await expandDomSubtree(page, '#uploader');
    expect(expanded).toContain('identity-file');
  }, 30_000);
});
