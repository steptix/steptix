/**
 * Unit tests for `src/browser/aria-snapshot.ts` and `ref` execution in
 * `src/browser/actions.ts` against a real headless Chromium browser.
 *
 * Covers SPEC-aria-ref-snapshots.md §3.1–§3.4, §5.1, §7.1:
 *  - `html`-rooted capture (siblings of `<body>`) & CSS `::before` accessible names
 *  - Mandatory secret & password-field masking without corrupting normal text
 *  - Supplementary `[ref=sN]` targets (hidden file inputs, hidden checkboxes,
 *    `pointer-events: none` controls, closed Shadow DOM custom elements,
 *    and `[data-steptix-row]` stamped table rows)
 *  - Main-frame `eN`, single-iframe `f1eN`, and nested-iframe `f2eN` resolution
 *    and permanent CSS selector measurement
 *  - Fast `StaleRefError` failure for unknown, removed, and post-navigation refs
 *  - `expandAriaSubtree` (main frame & iframe) with `sN` stamping and
 *    `updateRegistry: false` read-only captures
 *  - `drag` with `ref` + `targetRef` + `position: 'below'`
 *  - `domSnapshotCharLimit` truncation and `ariaSnapshotWasClipped`
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  ARIA_SNAPSHOT_TRUNCATION_MARKER,
  StaleRefError,
  ariaSnapshotWasClipped,
  captureAriaPageSnapshot,
  expandAriaSubtree,
  isSnapshotRefString,
  resolveRefTarget,
} from '../src/browser/aria-snapshot.js';
import { executeAction } from '../src/browser/actions.js';
import { listenFetchable } from './listen-fetchable.cjs';

function extractRef(snapshot: string, lineMatcher: RegExp): string {
  const line = snapshot.split('\n').find((l) => lineMatcher.test(l));
  expect(
    line,
    `expected snapshot line matching ${lineMatcher}\n--- snapshot ---\n${snapshot}`,
  ).toBeDefined();
  const match = /\[ref=((?:f\d+)?e\d+|s\d+)\]/.exec(line!);
  expect(match, `expected [ref=...] on line: ${line}`).not.toBeNull();
  return match![1]!;
}

async function startHtmlServer(
  routes: Record<string, string>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = routes[pathname];
    if (body === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  const port = await listenFetchable(server, '127.0.0.1');
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let browser: Browser;
let context: BrowserContext;
let tempDir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-aria-test-'));
}, 60_000);

afterAll(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

describe('isSnapshotRefString', () => {
  it('accepts main-frame, iframe, and supplementary ref forms and rejects non-refs', () => {
    expect(isSnapshotRefString('e1')).toBe(true);
    expect(isSnapshotRefString('e42')).toBe(true);
    expect(isSnapshotRefString('f1e4')).toBe(true);
    expect(isSnapshotRefString('f12e300')).toBe(true);
    expect(isSnapshotRefString('s1')).toBe(true);
    expect(isSnapshotRefString('aria-ref=e15')).toBe(true);
    expect(isSnapshotRefString('  aria-ref=f2e9  ')).toBe(true);
    expect(isSnapshotRefString('aria-ref=s7')).toBe(true);

    expect(isSnapshotRefString('')).toBe(false);
    expect(isSnapshotRefString('#submit')).toBe(false);
    expect(isSnapshotRefString('z2l9e43l3')).toBe(false);
    expect(isSnapshotRefString('e')).toBe(false);
    expect(isSnapshotRefString('f1s2')).toBe(false);
    expect(isSnapshotRefString('button "Save"')).toBe(false);
  });
});

describe('html-root capture & CSS ::before accessible name (§3.1)', () => {
  it('captures a dialog mounted directly on <html> as a sibling of <body> and clicks its ::before button by ref', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      #ack-btn::before { content: "✓ "; }
      #html-banner {
        position: fixed;
        top: 16px;
        left: 16px;
        padding: 12px;
        background: #fff;
        border: 1px solid #333;
      }
    </style>
  </head>
  <body>
    <main><h1>Workspace</h1><p id="ack-status">pending</p></main>
    <script>
      const dialog = document.createElement('div');
      dialog.id = 'html-banner';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'Policy Notice');
      dialog.innerHTML = '<p>Please review the notice.</p><button id="ack-btn" type="button">Acknowledge</button>';
      document.documentElement.appendChild(dialog);
      document.getElementById('ack-btn').addEventListener('click', () => {
        window.__acked = true;
        document.getElementById('ack-status').textContent = 'acknowledged';
      });
    </script>
  </body>
</html>`);

      // Confirm the dialog is genuinely a sibling of <body> directly under <html>.
      const isSiblingOfBody = await page.evaluate(() => {
        const el = document.getElementById('html-banner');
        return el !== null && el.parentElement === document.documentElement && el !== document.body;
      });
      expect(isSiblingOfBody).toBe(true);

      const snapshot = await captureAriaPageSnapshot(page);
      expect(snapshot).toContain('Policy Notice');
      expect(snapshot).toContain('Please review the notice.');

      const ackRef = extractRef(snapshot, /button "✓ Acknowledge"/);
      expect(ackRef).toMatch(/^e\d+$/);

      const result = await executeAction(page, {
        action: 'click',
        ref: ackRef,
        description: 'Click Acknowledge',
      });
      expect(result.success).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __acked?: boolean }).__acked)).toBe(true);
      expect(await page.locator('#ack-status').textContent()).toBe('acknowledged');
    });
  });
});

describe('mandatory secret & password-field masking (§3.2)', () => {
  it('masks all secret-field shapes and run secrets without masking non-secret fields or corrupting "on"', async () => {
    await withPage(async (page) => {
      const secrets = {
        password: 'aria-snapshot-test-password-val',
        pwd: 'aria-snapshot-test-pwd-val',
        autocomplete: 'aria-snapshot-test-autocomplete-val',
        token: 'aria-snapshot-test-token-val',
        textSecurity: 'aria-snapshot-test-textsec-val',
        notes: 'aria-snapshot-test-notes-val',
        runSecret: 'aria-snapshot-test-run-secret',
      };
      const nonSecrets = {
        passenger: 'Ada Lovelace',
        keyword: 'quarterly summary',
        prose: 'Click the button on the top bar for confirmation of your option.',
      };

      await page.setContent(`<!doctype html>
<html>
  <body>
    <p id="prose">${nonSecrets.prose}</p>
    <p id="run-secret-echo">Run tag: ${secrets.runSecret}</p>
    <form id="auth-form">
      <input id="f-password" type="password" aria-label="Account password">
      <input id="f-pwd" type="text" name="pwd" aria-label="Toggled pwd">
      <input id="f-autocomplete" type="text" autocomplete="current-password" aria-label="Current pass">
      <input id="f-token" type="text" aria-label="API token">
      <input id="f-textsec" type="text" style="-webkit-text-security: disc" aria-label="Masked entry">
      <textarea id="f-notes" name="secret_notes" aria-label="Secret notes"></textarea>

      <input id="f-passenger" type="text" name="passenger1_name" aria-label="Passenger name">
      <input data-testid="search-box" type="text" placeholder="Search by keyword">
      <label>
        <input id="f-show-pw" type="checkbox" name="show_password">
        Show password
      </label>
    </form>
  </body>
</html>`);

      await page.fill('#f-password', secrets.password);
      await page.fill('#f-pwd', secrets.pwd);
      await page.fill('#f-autocomplete', secrets.autocomplete);
      await page.fill('#f-token', secrets.token);
      await page.fill('#f-textsec', secrets.textSecurity);
      await page.fill('#f-notes', secrets.notes);
      await page.fill('#f-passenger', nonSecrets.passenger);
      await page.fill('[data-testid="search-box"]', nonSecrets.keyword);
      await page.check('#f-show-pw');

      // Confirm the browser's default checkbox `.value` is literally "on".
      const checkboxValue = await page.evaluate(
        () => (document.getElementById('f-show-pw') as HTMLInputElement).value,
      );
      expect(checkboxValue).toBe('on');

      const snapshot = await captureAriaPageSnapshot(page, {
        secrets: [secrets.runSecret],
      });

      for (const [label, secretVal] of Object.entries(secrets)) {
        expect(snapshot, `secret "${label}" leaked into snapshot`).not.toContain(secretVal);
      }
      expect(snapshot).toContain('***');
      expect(snapshot).toContain(nonSecrets.passenger);
      expect(snapshot).toContain(nonSecrets.keyword);
      expect(snapshot).toContain(nonSecrets.prose);
    });
  });

  it('masks short 1-char secret field values without corrupting [ref=eN] tokens or normal prose', async () => {
    await withPage(async (page) => {
      const prose = 'Step 1: enter every detail before continuing.';
      await page.setContent(`<!doctype html>
<html>
  <body>
    <button id="first-btn" type="button">Continue</button>
    <p id="prose">${prose}</p>
    <form>
      <input id="f-pin1" type="text" name="pin1" aria-label="PIN digit 1">
      <input id="f-keywords" type="text" name="keywords" aria-label="Keyword filter">
    </form>
  </body>
</html>`);

      await page.fill('#f-pin1', '1');
      await page.fill('#f-keywords', 'e');

      const snapshot = await captureAriaPageSnapshot(page);

      // Normal prose holding both "1" and "e" must survive intact.
      expect(snapshot).toContain(prose);

      // No [ref=...] token may be corrupted by masking "1" or "e".
      expect(snapshot).not.toMatch(/\[ref=[^\]]*\*/);
      const btnRef = extractRef(snapshot, /button "Continue"/);
      expect(btnRef).toMatch(/^e\d+$/);

      const pinLine = snapshot.split('\n').find((l) => /textbox "PIN digit 1"/.test(l));
      const kwLine = snapshot.split('\n').find((l) => /textbox "Keyword filter"/.test(l));
      expect(pinLine, `expected PIN digit 1 line in:\n${snapshot}`).toBeDefined();
      expect(kwLine, `expected Keyword filter line in:\n${snapshot}`).toBeDefined();
      expect(extractRef(snapshot, /textbox "PIN digit 1"/)).toMatch(/^e\d+$/);
      expect(extractRef(snapshot, /textbox "Keyword filter"/)).toMatch(/^e\d+$/);
      expect(pinLine).toMatch(/\[ref=e\d+\](?:\s+\[[^\]]+\])*:\s*(?:"\*\*\*"|\*\*\*)$/);
      expect(kwLine).toMatch(/\[ref=e\d+\](?:\s+\[[^\]]+\])*:\s*(?:"\*\*\*"|\*\*\*)$/);
      expect(pinLine).not.toMatch(/:\s*"?1"?$/);
      expect(kwLine).not.toMatch(/:\s*"?e"?$/);
    });
  });
});

describe('supplementary [ref=sN] targets (§3.3)', () => {
  it('surfaces a hidden <input type="file"> and uploads through it via ref (via: "input")', async () => {
    const sampleFile = path.join(tempDir, 'aria-upload-sample.txt');
    await fs.writeFile(sampleFile, 'aria snapshot upload fixture', 'utf8');

    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <label for="hidden-doc">Attach invoice</label>
    <input id="hidden-doc" type="file" accept=".txt,.pdf" multiple style="display: none">
    <p id="uploaded-name">none</p>
    <script>
      document.getElementById('hidden-doc').addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []).map((f) => f.name);
        document.getElementById('uploaded-name').textContent = files.join(',');
      });
    </script>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      expect(snapshot).toContain('# File Inputs (hidden native upload targets)');
      const fileRef = extractRef(
        snapshot,
        /^- file-input "Attach invoice" \[accept="\.txt,\.pdf"\] \[multiple\] \[ref=s\d+\]$/,
      );

      const result = await executeAction(page, {
        action: 'upload',
        ref: fileRef,
        filePath: sampleFile,
        description: 'Upload file',
      });
      expect(result.success).toBe(true);
      expect(result.upload?.via).toBe('input');
      expect(await page.locator('#uploaded-name').textContent()).toBe('aria-upload-sample.txt');
    });
  });

  it('surfaces hidden checkboxes with visible label or wrapper stand-ins and toggles them recording targeting.standIn', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <div>
      <input id="terms-cb" type="checkbox" style="display: none">
      <label id="terms-label" for="terms-cb" style="display: inline-block; padding: 6px 12px;">Accept terms</label>
    </div>
    <div id="alerts-box" style="display: inline-flex; align-items: center; width: 160px; height: 32px; cursor: pointer;">
      <input id="alerts-cb" type="checkbox" aria-label="Email alerts"
        style="opacity: 0; width: 0; height: 0; margin: 0; padding: 0; border: 0; position: absolute;">
      <span>Email alerts</span>
    </div>
    <script>
      document.getElementById('alerts-box').addEventListener('click', () => {
        const cb = document.getElementById('alerts-cb');
        cb.checked = !cb.checked;
      });
    </script>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      expect(snapshot).toContain('# Supplementary Controls');

      const labelCbRef = extractRef(snapshot, /^- checkbox "Accept terms" \[checked=false\] \[ref=s\d+\]$/);
      const boxCbRef = extractRef(snapshot, /^- checkbox "Email alerts" \[checked=false\] \[ref=s\d+\]$/);

      const labelClick = await executeAction(
        page,
        { action: 'click', ref: labelCbRef, description: 'Toggle terms checkbox' },
        undefined,
        undefined,
        { measure: true },
      );
      expect(labelClick.success).toBe(true);
      expect(labelClick.targeting?.standIn).toBe('label');
      expect(labelClick.targeting?.resolvedSelector).toBe('#terms-label');
      expect(await page.locator('#terms-cb').isChecked()).toBe(true);

      const boxClick = await executeAction(
        page,
        { action: 'click', ref: boxCbRef, description: 'Toggle alerts checkbox' },
        undefined,
        undefined,
        { measure: true },
      );
      expect(boxClick.success).toBe(true);
      expect(boxClick.targeting?.standIn).toBe('box');
      expect(boxClick.targeting?.resolvedSelector).toBe('#alerts-box');
      expect(await page.locator('#alerts-cb').isChecked()).toBe(true);
    });
  });

  it('surfaces a 1px x 1px opacity: 0 pointer-events: none checkbox (.sr-only-toggle) and toggles it via its stand-in', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      .sr-only-toggle {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
        pointer-events: none;
      }
      .toggle-row {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border: 1px solid #888;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <div id="digest-box" class="toggle-row">
      <input id="digest-cb" type="checkbox" class="sr-only-toggle" aria-label="Weekly digest">
      <span>Weekly digest</span>
    </div>
    <script>
      document.getElementById('digest-box').addEventListener('click', () => {
        const cb = document.getElementById('digest-cb');
        cb.checked = !cb.checked;
      });
    </script>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      expect(snapshot).toContain('# Supplementary Controls');
      const srRef = extractRef(snapshot, /^- checkbox "Weekly digest" \[checked=false\] \[ref=s\d+\]$/);

      const clickRes = await executeAction(
        page,
        { action: 'click', ref: srRef, description: 'Toggle sr-only checkbox' },
        undefined,
        undefined,
        { measure: true },
      );
      expect(clickRes.success, clickRes.error).toBe(true);
      expect(clickRes.targeting?.standIn).toBe('box');
      expect(clickRes.targeting?.resolvedSelector).toBe('#digest-box');
      expect(await page.locator('#digest-cb').isChecked()).toBe(true);
    });
  });

  it('surfaces visible pointer-events: none controls under # Supplementary Controls', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <button id="blocked-btn" type="button" style="pointer-events: none; width: 140px; height: 32px;">
      Blocked Action
    </button>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      expect(snapshot).toContain('# Supplementary Controls');
      const blockedRef = extractRef(snapshot, /^- button "Blocked Action" \[ref=s\d+\]$/);
      const resolved = await resolveRefTarget(page, blockedRef);
      expect(await resolved.locator.getAttribute('id')).toBe('blocked-btn');
    });
  });

  it('surfaces a closed Shadow DOM custom element and types into its internal input via ref', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <custom-serial-box id="serial-host" aria-label="Device serial"
      style="display: inline-block; width: 220px; height: 36px; border: 1px solid #333;"></custom-serial-box>
    <p id="serial-echo"></p>
    <script>
      class CustomSerialBox extends HTMLElement {
        constructor() {
          super();
          const shadow = this.attachShadow({ mode: 'closed', delegatesFocus: true });
          const input = document.createElement('input');
          input.type = 'text';
          input.style.cssText = 'width: 100%; height: 100%; box-sizing: border-box;';
          input.addEventListener('input', () => {
            window.__closedSerialValue = input.value;
            document.getElementById('serial-echo').textContent = input.value;
          });
          shadow.appendChild(input);
          this.addEventListener('click', () => input.focus());
        }
      }
      customElements.define('custom-serial-box', CustomSerialBox);
    </script>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      expect(snapshot).toContain('# Supplementary Controls');
      const hostRef = extractRef(
        snapshot,
        /^- custom-element "Device serial" \(<custom-serial-box>\) \[ref=s\d+\]$/,
      );

      const result = await executeAction(page, {
        action: 'type',
        ref: hostRef,
        value: 'SN-42',
        description: 'Type serial',
      });
      expect(result.success).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { __closedSerialValue?: string }).__closedSerialValue),
      ).toBe('SN-42');
      expect(await page.locator('#serial-echo').textContent()).toBe('SN-42');
    });
  });

  it('surfaces [data-steptix-row] stamped rows for pre-stamped tables and resolves row sN refs', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <table id="invoices-table">
      <caption>Invoices</caption>
      <tbody>
        <tr data-steptix-row="1"><td>INV-1</td><td>Paid</td></tr>
        <tr data-steptix-row="2"><td>INV-2</td><td>Pending</td></tr>
      </tbody>
    </table>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const invoicesLine = snapshot
        .split('\n')
        .find((l) => l.startsWith('# Stamped Table Rows: table "Invoices" -> '));
      expect(invoicesLine).toBeDefined();
      expect(invoicesLine).toMatch(/row 1 \[ref=s\d+\], row 2 \[ref=s\d+\]/);

      const row2Match = /row 2 \[ref=(s\d+)\]/.exec(invoicesLine!);
      expect(row2Match).not.toBeNull();
      const row2Read = await executeAction(page, {
        action: 'read',
        ref: row2Match![1]!,
        as: 'second_invoice',
        description: 'Read row 2 text',
      });
      expect(row2Read.success).toBe(true);
      expect(row2Read.capturedValue).toContain('INV-2');
      expect(row2Read.capturedValue).toContain('Pending');
    });
  });

  it('executes readTable by aria ref (eN) and surfaces its newly stamped [data-steptix-row] rows', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <table id="orders-table" aria-label="Orders">
      <thead>
        <tr><th>Order</th><th>Status</th></tr>
      </thead>
      <tbody>
        <tr><td>ORD-101</td><td>Open</td></tr>
        <tr><td>ORD-102</td><td>Shipped</td></tr>
      </tbody>
    </table>
  </body>
</html>`);

      const snap1 = await captureAriaPageSnapshot(page);
      const tableRef = extractRef(snap1, /table "Orders"/);
      const readTableRes = await executeAction(
        page,
        {
          action: 'readTable',
          ref: tableRef,
          columns: [
            { header: 'Order', key: 'order' },
            { header: 'Status', key: 'status' },
          ],
          as: 'orders',
          description: 'Read orders',
        },
        undefined,
        undefined,
        { measure: true },
      );
      expect(readTableRes.success, readTableRes.error).toBe(true);
      expect(readTableRes.capturedRecords).toEqual([
        { _row: '1', order: 'ORD-101', status: 'Open' },
        { _row: '2', order: 'ORD-102', status: 'Shipped' },
      ]);
      expect(readTableRes.targeting?.resolvedSelector).toBe('#orders-table');

      const snap2 = await captureAriaPageSnapshot(page);
      const ordersLine = snap2
        .split('\n')
        .find((l) => l.startsWith('# Stamped Table Rows: table "Orders" -> '));
      expect(ordersLine).toBeDefined();
      expect(ordersLine).toMatch(/row 1 \[ref=s\d+\], row 2 \[ref=s\d+\]/);

      const row2Match = /row 2 \[ref=(s\d+)\]/.exec(ordersLine!);
      expect(row2Match).not.toBeNull();
      const row2Read = await executeAction(page, {
        action: 'read',
        ref: row2Match![1]!,
        as: 'second_row',
        description: 'Read row 2 text',
      });
      expect(row2Read.success).toBe(true);
      expect(row2Read.capturedValue).toContain('ORD-102');
      expect(row2Read.capturedValue).toContain('Shipped');
    });
  });
});

describe('main-frame eN, single-iframe f1eN, and nested-iframe f2eN resolution & measurement (§3.4, §7.1)', () => {
  it('resolves and executes actions across main frame, single iframe, and nested iframe with permanent CSS selectors', async () => {
    const server = await startHtmlServer({
      '/': `<!doctype html>
<html>
  <body>
    <button id="main-btn" type="button">Main Action</button>
    <p id="main-status">idle</p>
    <iframe id="outer-frame" src="/outer" width="700" height="420"></iframe>
    <script>
      document.getElementById('main-btn').addEventListener('click', () => {
        document.getElementById('main-status').textContent = 'main-clicked';
      });
    </script>
  </body>
</html>`,
      '/outer': `<!doctype html>
<html>
  <body>
    <button id="outer-btn" type="button">Outer Action</button>
    <p id="outer-status">idle</p>
    <iframe id="inner-frame" src="/inner" width="560" height="260"></iframe>
    <script>
      document.getElementById('outer-btn').addEventListener('click', () => {
        document.getElementById('outer-status').textContent = 'outer-clicked';
      });
    </script>
  </body>
</html>`,
      '/inner': `<!doctype html>
<html>
  <body>
    <input data-testid="nested-input" aria-label="Nested code" type="text">
    <button id="nested-btn" type="button">Nested Submit</button>
    <p id="nested-output">empty</p>
    <script>
      document.getElementById('nested-btn').addEventListener('click', () => {
        const val = document.querySelector('[data-testid="nested-input"]').value;
        document.getElementById('nested-output').textContent = 'submitted:' + val;
      });
    </script>
  </body>
</html>`,
    });

    try {
      await withPage(async (page) => {
        await page.goto(`${server.baseUrl}/`);
        const innerFrameLoc = page.frameLocator('#outer-frame').frameLocator('#inner-frame');
        await innerFrameLoc.locator('#nested-btn').waitFor({ state: 'visible' });

        const snapshot = await captureAriaPageSnapshot(page);
        const mainBtnRef = extractRef(snapshot, /button "Main Action"/);
        const outerBtnRef = extractRef(snapshot, /button "Outer Action"/);
        const nestedInputRef = extractRef(snapshot, /textbox "Nested code"/);
        const nestedBtnRef = extractRef(snapshot, /button "Nested Submit"/);

        expect(mainBtnRef).toMatch(/^e\d+$/);
        expect(outerBtnRef).toMatch(/^f\d+e\d+$/);
        expect(nestedInputRef).toMatch(/^f\d+e\d+$/);
        expect(nestedBtnRef).toMatch(/^f\d+e\d+$/);
        expect(nestedBtnRef.split('e')[0]).not.toBe(outerBtnRef.split('e')[0]);

        const mainRes = await executeAction(
          page,
          { action: 'click', ref: mainBtnRef, description: 'Click Main Action' },
          undefined,
          undefined,
          { measure: true },
        );
        expect(mainRes.success).toBe(true);
        expect(mainRes.resolvedFrame).toBeUndefined();
        expect(mainRes.targeting?.resolvedSelector).toBe('#main-btn');
        expect(await page.locator('#main-status').textContent()).toBe('main-clicked');

        const outerRes = await executeAction(
          page,
          { action: 'click', ref: outerBtnRef, description: 'Click Outer Action' },
          undefined,
          undefined,
          { measure: true },
        );
        expect(outerRes.success).toBe(true);
        expect(outerRes.resolvedFrame).toBe('#outer-frame');
        expect(outerRes.targeting?.resolvedSelector).toBe('#outer-btn');
        expect(outerRes.targeting?.resolvedSelector).not.toContain('aria-ref=');
        expect(await page.frameLocator('#outer-frame').locator('#outer-status').textContent()).toBe(
          'outer-clicked',
        );

        const nestedTypeRes = await executeAction(
          page,
          { action: 'type', ref: nestedInputRef, value: 'NEST-9', description: 'Type nested code' },
          undefined,
          undefined,
          { measure: true },
        );
        expect(nestedTypeRes.success).toBe(true);
        expect(nestedTypeRes.resolvedFrame).toBe('#outer-frame >> #inner-frame');
        expect(nestedTypeRes.targeting?.resolvedSelector).toBe('[data-testid="nested-input"]');
        expect(nestedTypeRes.targeting?.resolvedSelector).not.toContain('aria-ref=');

        const nestedClickRes = await executeAction(
          page,
          { action: 'click', ref: nestedBtnRef, description: 'Click Nested Submit' },
          undefined,
          undefined,
          { measure: true },
        );
        expect(nestedClickRes.success).toBe(true);
        expect(nestedClickRes.resolvedFrame).toBe('#outer-frame >> #inner-frame');
        expect(nestedClickRes.targeting?.resolvedSelector).toBe('#nested-btn');
        expect(nestedClickRes.targeting?.resolvedSelector).not.toContain('aria-ref=');
        expect(await innerFrameLoc.locator('#nested-output').textContent()).toBe('submitted:NEST-9');
      });
    } finally {
      await server.close();
    }
  });

  it('handles iframe selectors with spaces in quoted attributes (iframe[title="Payment Form"]) across f1eN, sN, and expandAriaSubtree', async () => {
    const voucherFile = path.join(tempDir, 'voucher-sample.txt');
    await fs.writeFile(voucherFile, 'voucher fixture payload', 'utf8');

    const server = await startHtmlServer({
      '/': `<!doctype html>
<html>
  <body>
    <iframe title="Payment Form" src="/payment" width="600" height="320"></iframe>
  </body>
</html>`,
      '/payment': `<!doctype html>
<html>
  <body>
    <button id="pay-btn" type="button">Submit Payment</button>
    <p id="pay-status">pending</p>
    <label for="pay-doc">Attach voucher</label>
    <input id="pay-doc" type="file" style="display: none">
    <p id="pay-file">none</p>
    <article id="pay-card" aria-label="Payment details">
      <p>Voucher: <span class="voucher-code">VCH-88</span></p>
    </article>
    <script>
      document.getElementById('pay-btn').addEventListener('click', () => {
        document.getElementById('pay-status').textContent = 'paid';
      });
      document.getElementById('pay-doc').addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []).map((f) => f.name);
        document.getElementById('pay-file').textContent = files.join(',');
      });
    </script>
  </body>
</html>`,
    });

    try {
      await withPage(async (page) => {
        await page.goto(`${server.baseUrl}/`);
        const frameLoc = page.frameLocator('iframe[title="Payment Form"]');
        await frameLoc.locator('#pay-btn').waitFor({ state: 'visible' });

        const snapshot = await captureAriaPageSnapshot(page);
        expect(snapshot).toContain('# Iframes');

        const payBtnRef = extractRef(snapshot, /button "Submit Payment"/);
        expect(payBtnRef).toMatch(/^f\d+e\d+$/);
        const clickRes = await executeAction(
          page,
          { action: 'click', ref: payBtnRef, description: 'Click Submit Payment in Payment Form iframe' },
          undefined,
          undefined,
          { measure: true },
        );
        expect(clickRes.success, clickRes.error).toBe(true);
        expect(clickRes.resolvedFrame).toBe('iframe[title="Payment Form"]');
        expect(clickRes.targeting?.resolvedSelector).toBe('#pay-btn');
        expect(await frameLoc.locator('#pay-status').textContent()).toBe('paid');

        const fileRef = extractRef(snapshot, /^- file-input "Attach voucher".*\[ref=s\d+\]$/);
        const uploadRes = await executeAction(page, {
          action: 'upload',
          ref: fileRef,
          filePath: voucherFile,
          description: 'Upload voucher in Payment Form iframe',
        });
        expect(uploadRes.success, uploadRes.error).toBe(true);
        expect(uploadRes.resolvedFrame).toBe('iframe[title="Payment Form"]');
        expect(uploadRes.upload?.via).toBe('input');
        expect(await frameLoc.locator('#pay-file').textContent()).toBe('voucher-sample.txt');

        const cardRef = extractRef(snapshot, /article "Payment details"/);
        expect(cardRef).toMatch(/^f\d+e\d+$/);
        const expanded = await expandAriaSubtree(page, { ref: cardRef });
        expect(expanded.content).toContain('VCH-88');

        const spanMatch = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*VCH-88/.exec(expanded.content);
        expect(spanMatch, `expected stamped span in iframe expand output:\n${expanded.content}`).not.toBeNull();
        const innerSRef = spanMatch![1]!;

        const readRes = await executeAction(
          page,
          { action: 'read', ref: innerSRef, as: 'voucher', description: 'Read voucher code in Payment Form iframe' },
          undefined,
          undefined,
          { measure: true },
        );
        expect(readRes.success, readRes.error).toBe(true);
        expect(readRes.capturedValue).toBe('VCH-88');
        expect(readRes.resolvedFrame).toBe('iframe[title="Payment Form"]');
      });
    } finally {
      await server.close();
    }
  });
});

describe('stale ref fast failure (§3.4)', () => {
  it('fails immediately with StaleRefError for unknown refs (e999, s999) and before any snapshot', async () => {
    await withPage(async (page) => {
      await page.setContent('<!doctype html><html><body><button id="ok">OK</button></body></html>');

      // Before any snapshot has populated the page registry.
      await expect(resolveRefTarget(page, 'e1')).rejects.toBeInstanceOf(StaleRefError);

      await captureAriaPageSnapshot(page);

      for (const unknownRef of ['e999', 's999']) {
        await expect(resolveRefTarget(page, unknownRef)).rejects.toBeInstanceOf(StaleRefError);

        const result = await executeAction(page, {
          action: 'click',
          ref: unknownRef,
          description: `Click ${unknownRef}`,
        });
        expect(result.success).toBe(false);
        expect(result.matchCount).toBe(0);
        expect(result.failedSelector).toBe(`aria-ref=${unknownRef}`);
        expect(result.error).toContain('is no longer in the current page snapshot');
        expect(result.error).not.toMatch(/Timeout \d+ms exceeded/i);
      }
    });
  });

  it('fails immediately when the target element (eN or sN) is removed from the DOM or drag targetRef is stale', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <button id="temp-btn" type="button">Temporary</button>
    <input id="temp-file" type="file" style="display: none">
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const btnRef = extractRef(snapshot, /button "Temporary"/);
      const fileRef = extractRef(snapshot, /file-input.*\[ref=s\d+\]/);

      await page.evaluate(() => {
        document.getElementById('temp-btn')?.remove();
        document.getElementById('temp-file')?.remove();
      });

      await expect(resolveRefTarget(page, btnRef)).rejects.toBeInstanceOf(StaleRefError);
      await expect(resolveRefTarget(page, fileRef)).rejects.toBeInstanceOf(StaleRefError);

      const clickRes = await executeAction(page, {
        action: 'click',
        ref: btnRef,
        description: 'Click removed button',
      });
      expect(clickRes.success).toBe(false);
      expect(clickRes.matchCount).toBe(0);
      expect(clickRes.failedSelector).toBe(`aria-ref=${btnRef}`);
      expect(clickRes.error).toContain('is no longer in the current page snapshot');
      expect(clickRes.error).not.toMatch(/Timeout \d+ms exceeded/i);

      // Re-add a valid source to test stale `targetRef` on drag.
      await page.setContent('<!doctype html><html><body><button id="src">Source</button></body></html>');
      const freshSnap = await captureAriaPageSnapshot(page);
      const srcRef = extractRef(freshSnap, /button "Source"/);
      const dragRes = await executeAction(page, {
        action: 'drag',
        ref: srcRef,
        targetRef: 'e999',
        description: 'Drag onto stale targetRef',
      });
      expect(dragRes.success).toBe(false);
      expect(dragRes.matchCount).toBe(0);
      expect(dragRes.failedSelector).toBe('aria-ref=e999');
      expect(dragRes.error).toContain('is no longer in the current page snapshot');
      expect(dragRes.error).not.toMatch(/Timeout \d+ms exceeded/i);
    });
  });

  it('invalidates refs immediately after a main-frame navigation', async () => {
    const server = await startHtmlServer({
      '/page1': '<!doctype html><html><body><button id="nav-btn">First Page Button</button></body></html>',
      '/page2': '<!doctype html><html><body><p>Second Page</p></body></html>',
    });

    try {
      await withPage(async (page) => {
        await page.goto(`${server.baseUrl}/page1`);
        const snapshot = await captureAriaPageSnapshot(page);
        const btnRef = extractRef(snapshot, /button "First Page Button"/);

        // Sanity check: valid before navigation.
        const beforeNav = await resolveRefTarget(page, btnRef);
        expect(await beforeNav.locator.count()).toBe(1);

        await page.goto(`${server.baseUrl}/page2`);

        await expect(resolveRefTarget(page, btnRef)).rejects.toBeInstanceOf(StaleRefError);

        const result = await executeAction(page, {
          action: 'click',
          ref: btnRef,
          description: 'Click ref from previous page',
        });
        expect(result.success).toBe(false);
        expect(result.matchCount).toBe(0);
        expect(result.failedSelector).toBe(`aria-ref=${btnRef}`);
        expect(result.error).toContain('is no longer in the current page snapshot');
        expect(result.error).not.toMatch(/Timeout \d+ms exceeded/i);
      });
    } finally {
      await server.close();
    }
  });
});

describe('expandAriaSubtree & updateRegistry: false', () => {
  it('stamps data-steptix-ref="s..." inside an expanded card, reads it with permanent CSS targeting, and preserves refs across updateRegistry: false', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <article id="order-card" aria-label="Order summary">
      <h2>Order summary</h2>
      <p>Confirmation: <span class="code">ORD-77</span></p>
    </article>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const cardRef = extractRef(snapshot, /article "Order summary"/);

      const expanded = await expandAriaSubtree(page, { ref: cardRef });
      expect(expanded.label).toBe(cardRef);
      expect(expanded.content).toContain('ORD-77');

      const spanMatch = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*ORD-77/.exec(expanded.content);
      expect(spanMatch, `expected stamped span in expand output:\n${expanded.content}`).not.toBeNull();
      const innerSRef = spanMatch![1]!;

      const readRes = await executeAction(
        page,
        { action: 'read', ref: innerSRef, as: 'code', description: 'Read code' },
        undefined,
        undefined,
        { measure: true },
      );
      expect(readRes.success).toBe(true);
      expect(readRes.capturedValue).toBe('ORD-77');
      expect(readRes.targeting?.resolvedSelector).toBeDefined();
      expect(readRes.targeting?.resolvedSelector).not.toContain('aria-ref=');
      expect(readRes.targeting?.resolvedSelector).not.toContain('data-steptix-ref');
      expect(await page.locator(readRes.targeting!.resolvedSelector!).textContent()).toBe('ORD-77');

      // Read-only diagnostic capture must NOT clear or replace the active registry or DOM stamps.
      const readOnlySnap = await captureAriaPageSnapshot(page, { updateRegistry: false });
      expect(readOnlySnap).toContain('Order summary');

      const stillValid = await resolveRefTarget(page, innerSRef);
      expect(await stillValid.locator.textContent()).toBe('ORD-77');

      const readAgain = await executeAction(page, {
        action: 'read',
        ref: innerSRef,
        as: 'code_again',
        description: 'Read code after read-only snapshot',
      });
      expect(readAgain.success).toBe(true);
      expect(readAgain.capturedValue).toBe('ORD-77');

      // Expanding a stale ref returns an in-band message instead of hanging.
      const staleExpand = await expandAriaSubtree(page, { ref: 'e999' });
      expect(staleExpand.label).toBe('e999');
      expect(staleExpand.content).toContain('[expand]');
      expect(staleExpand.content).toContain('is no longer in the current page snapshot');
    });
  });

  it('expands an element inside an iframe by f<seq>e<n> ref and reads its stamped inner sN ref with resolvedFrame', async () => {
    const server = await startHtmlServer({
      '/': `<!doctype html>
<html>
  <body>
    <iframe id="receipt-frame" src="/receipt" width="600" height="300"></iframe>
  </body>
</html>`,
      '/receipt': `<!doctype html>
<html>
  <body>
    <article id="receipt-card" aria-label="Receipt details">
      <p>Reference: <span class="receipt-code">RCP-99</span></p>
    </article>
  </body>
</html>`,
    });

    try {
      await withPage(async (page) => {
        await page.goto(`${server.baseUrl}/`);
        await page.frameLocator('#receipt-frame').locator('#receipt-card').waitFor({ state: 'visible' });

        const snapshot = await captureAriaPageSnapshot(page);
        const frameCardRef = extractRef(snapshot, /article "Receipt details"/);
        expect(frameCardRef).toMatch(/^f\d+e\d+$/);

        const expanded = await expandAriaSubtree(page, { ref: frameCardRef });
        expect(expanded.label).toBe(frameCardRef);
        expect(expanded.content).toContain('RCP-99');

        const spanMatch = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*RCP-99/.exec(expanded.content);
        expect(spanMatch, `expected stamped iframe span in:\n${expanded.content}`).not.toBeNull();
        const innerSRef = spanMatch![1]!;

        const readRes = await executeAction(
          page,
          { action: 'read', ref: innerSRef, as: 'receipt_code', description: 'Read iframe receipt code' },
          undefined,
          undefined,
          { measure: true },
        );
        expect(readRes.success).toBe(true);
        expect(readRes.capturedValue).toBe('RCP-99');
        expect(readRes.resolvedFrame).toBe('#receipt-frame');
        expect(readRes.targeting?.resolvedSelector).toBeDefined();
        expect(readRes.targeting?.resolvedSelector).not.toContain('aria-ref=');
        expect(readRes.targeting?.resolvedSelector).not.toContain('data-steptix-ref');
      });
    } finally {
      await server.close();
    }
  });

  it('preserves expand-stamped sN refs across a Turn 2 captureAriaPageSnapshot without colliding with hidden file-input sN refs', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <label for="hidden-attach">Upload attachment</label>
    <input id="hidden-attach" type="file" style="display: none">
    <article id="shipment-card" aria-label="Shipment summary">
      <h2>Shipment summary</h2>
      <p>Tracking: <span class="tracking-code">SHP-505</span></p>
    </article>
  </body>
</html>`);

      // Turn 1: capture snapshot (stamps hidden file input as s1).
      const snap1 = await captureAriaPageSnapshot(page);
      const fileRef1 = extractRef(snap1, /^- file-input "Upload attachment" \[ref=s\d+\]$/);
      const cardRef = extractRef(snap1, /article "Shipment summary"/);

      // Turn 1: expand the card subtree, stamping inner elements with fresh sN refs.
      const expanded = await expandAriaSubtree(page, { ref: cardRef });
      const spanMatch = /<span[^>]*data-steptix-ref="(s\d+)"[^>]*>\s*SHP-505/.exec(expanded.content);
      expect(spanMatch, `expected stamped span in expand output:\n${expanded.content}`).not.toBeNull();
      const expandedSRef = spanMatch![1]!;
      expect(expandedSRef).not.toBe(fileRef1);

      // Turn 2: fresh snapshot capture re-stamps the hidden file input, but MUST
      // preserve Turn 1's expand-stamped sN ref without ref-number collision.
      const snap2 = await captureAriaPageSnapshot(page);
      const fileRef2 = extractRef(snap2, /^- file-input "Upload attachment" \[ref=s\d+\]$/);
      expect(fileRef2).not.toBe(expandedSRef);

      const readRes = await executeAction(
        page,
        { action: 'read', ref: expandedSRef, as: 'tracking', description: 'Read expanded span on Turn 2' },
        undefined,
        undefined,
        { measure: true },
      );
      expect(readRes.success, readRes.error).toBe(true);
      expect(readRes.capturedValue).toBe('SHP-505');

      const resolvedFile = await resolveRefTarget(page, fileRef2);
      expect(await resolvedFile.locator.getAttribute('id')).toBe('hidden-attach');
    });
  });
});

describe('drag with ref + targetRef + position: "below"', () => {
  it('reorders a 3-item HTML5 draggable list placing the first item below the third', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      #sortable { list-style: none; padding: 0; margin: 16px; width: 240px; }
      #sortable li {
        height: 44px;
        line-height: 44px;
        padding: 0 12px;
        margin-bottom: 6px;
        border: 1px solid #444;
        cursor: grab;
        user-select: none;
      }
    </style>
  </head>
  <body>
    <ul id="sortable">
      <li id="item-1" draggable="true">Alpha</li>
      <li id="item-2" draggable="true">Beta</li>
      <li id="item-3" draggable="true">Gamma</li>
    </ul>
    <script>
      let draggedId = null;
      const list = document.getElementById('sortable');
      for (const item of list.querySelectorAll('li')) {
        item.addEventListener('dragstart', (e) => {
          draggedId = item.id;
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        });
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          const dragged = document.getElementById(draggedId);
          if (!dragged || dragged === item) return;
          const rect = item.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          list.insertBefore(dragged, after ? item.nextSibling : item);
        });
      }
    </script>
  </body>
</html>`);

      const snapshot = await captureAriaPageSnapshot(page);
      const alphaRef = extractRef(snapshot, /listitem.*Alpha/);
      const gammaRef = extractRef(snapshot, /listitem.*Gamma/);

      const result = await executeAction(page, {
        action: 'drag',
        ref: alphaRef,
        targetRef: gammaRef,
        position: 'below',
        description: 'Drag Alpha below Gamma',
      });
      expect(result.success).toBe(true);

      const order = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#sortable li')).map((el) => el.id),
      );
      expect(order).toEqual(['item-2', 'item-3', 'item-1']);
    });
  });

  it('refuses cross-frame drag immediately instead of timing out', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <div id="main-card" draggable="true">Main card</div>
    <iframe id="drop-frame" srcdoc='<!doctype html><html><body><div id="frame-slot" role="region" aria-label="Drop zone" style="width:120px;height:60px;">Drop here</div></body></html>'></iframe>
  </body>
</html>`);
      const snapshot = await captureAriaPageSnapshot(page);
      const sourceRef = extractRef(snapshot, /Main card/);
      const targetRef = extractRef(snapshot, /Drop zone/);

      const result = await executeAction(page, {
        action: 'drag',
        ref: sourceRef,
        targetRef,
        description: 'Attempt cross-frame drag',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('same frame');
      expect(result.failedSelector).toBe(`aria-ref=${targetRef}`);
    });
  });
});

describe('truncation (domSnapshotCharLimit)', () => {
  it('clips oversized snapshots, invokes onClipped, and marks output with ARIA_SNAPSHOT_TRUNCATION_MARKER', async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
<html>
  <body>
    <section aria-label="Controls">
      <button type="button">First catalog action button</button>
      <button type="button">Second catalog action button</button>
      <button type="button">Third catalog action button</button>
      <button type="button">Fourth catalog action button</button>
    </section>
  </body>
</html>`);

      const onNotClipped = vi.fn();
      const fullSnap = await captureAriaPageSnapshot(page, { onClipped: onNotClipped });
      expect(fullSnap.length).toBeGreaterThan(80);
      expect(onNotClipped).not.toHaveBeenCalled();
      expect(ariaSnapshotWasClipped(fullSnap)).toBe(false);
      expect(fullSnap).not.toContain(ARIA_SNAPSHOT_TRUNCATION_MARKER);

      const onClipped = vi.fn();
      const clippedSnap = await captureAriaPageSnapshot(page, {
        domSnapshotCharLimit: 80,
        onClipped,
      });
      expect(onClipped).toHaveBeenCalledTimes(1);
      expect(ariaSnapshotWasClipped(clippedSnap)).toBe(true);
      expect(clippedSnap).toContain(ARIA_SNAPSHOT_TRUNCATION_MARKER);
      const prefix = clippedSnap.slice(0, clippedSnap.indexOf(ARIA_SNAPSHOT_TRUNCATION_MARKER));
      expect(prefix.length).toBeLessThanOrEqual(80);
    });
  });
});
