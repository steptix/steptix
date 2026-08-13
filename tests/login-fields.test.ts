// The login-form scanner, in a real browser.
//
// A real Chromium rather than a DOM fake, deliberately. The rules that carry
// the most weight here — a honeypot field parked off-screen, a field hidden by
// an ANCESTOR's `display:none`, a form inside an open shadow root — are all
// decided by computed style and layout, which is exactly what a fake supplies
// from a lookup table and gets wrong. A scanner tested against jsdom would
// report green while filling every honeypot on the web.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { isRealPasswordField, scanForLogin } from '../src/credentials/login-fields.js';

/**
 * Vitest's per-test default is 5 seconds, and this file drives a real browser
 * inside a 120-file parallel run. That budget is not about how long a scan
 * takes — it is about how long this process waits for a CPU slice when every
 * other suite is also running. Failures from it report as "about 5000ms",
 * which is indistinguishable at a glance from a Playwright action timeout.
 */
const BROWSER_TEST_TIMEOUT_MS = 30_000;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** Load markup as a real document. */
async function load(html: string): Promise<void> {
  await page.setContent(`<!DOCTYPE html><html><body>${html}</body></html>`, { waitUntil: 'load' });
}

describe('scanForLogin — the ordinary shapes', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('reads a classic username + password form', async () => {
    await load(`
      <form>
        <label for="u">Email</label><input id="u" name="email" type="text">
        <label for="p">Password</label><input id="p" name="password" type="password">
        <button type="submit">Sign in</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('login-form');
    expect(scan.username?.selector).toBe('#u');
    expect(scan.password?.selector).toBe('#p');
    expect(scan.submit?.text).toBe('Sign in');
  });

  it('prefers autocomplete over position when the two disagree', async () => {
    // The nickname box comes first in document order, so a position-only rule
    // would pick it. `autocomplete="username"` is the web platform's own answer
    // and has to win.
    await load(`
      <form>
        <input id="nickname" name="nickname" type="text" placeholder="Display name">
        <input id="real" name="q17" type="text" autocomplete="username">
        <input id="p" type="password" autocomplete="current-password">
        <button type="submit">Go</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.username?.selector).toBe('#real');
    expect(scan.usernameWhy).toBe('autocomplete="username"');
  });

  it('finds a username field with no helpful attributes by position', async () => {
    await load(`
      <form>
        <input id="a" type="text">
        <input id="b" type="password">
        <button type="submit">Log in</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('login-form');
    expect(scan.username?.selector).toBe('#a');
  });

  it('reports a username-only page as the first of several steps', async () => {
    await load(`
      <form>
        <input id="email" type="email" autocomplete="username">
        <button type="submit">Next</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('username-only');
    expect(scan.password).toBeNull();
  });

  it('reports a one-time-code page as its own thing', async () => {
    await load(`
      <form>
        <label for="c">Verification code</label>
        <input id="c" autocomplete="one-time-code" inputmode="numeric" maxlength="6">
        <button type="submit">Verify</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('otp-only');
    expect(scan.otp?.selector).toBe('#c');
    // The code box must not also be offered as the username, or a 2FA page
    // gets an email address typed into it.
    expect(scan.username).toBeNull();
  });
});

describe('scanForLogin — the rules that stop it doing damage', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('declines a registration form with two password fields', async () => {
    await load(`
      <form>
        <input id="u" type="text" autocomplete="username">
        <input id="p1" type="password">
        <input id="p2" type="password">
        <button type="submit">Create account</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('registration-form');
    expect(scan.password).toBeNull();
  });

  it('declines a change-password form marked new-password', async () => {
    // The dangerous one: a single password box, so the two-field rule does not
    // catch it. Filling this with the CURRENT password and submitting would
    // change the account's password to itself at best.
    await load(`
      <form>
        <input id="u" type="text" autocomplete="username">
        <input id="p" type="password" autocomplete="new-password">
        <button type="submit">Set password</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('registration-form');
    expect(scan.password).toBeNull();
  });

  it('ignores a honeypot password field hidden off-screen', async () => {
    await load(`
      <form>
        <input id="u" type="text" autocomplete="username">
        <input id="trap" type="password" style="position:absolute;left:-9999px;top:-9999px">
        <input id="real" type="password" autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    // Two password boxes exist in the DOM. Only one is visible, so this must
    // read as an ordinary login form and pick the real field — not as a
    // registration form, and never as the trap.
    expect(scan.status).toBe('login-form');
    expect(scan.password?.selector).toBe('#real');
  });

  it('ignores a field hidden by an ancestor rather than by itself', async () => {
    await load(`
      <form>
        <div style="display:none">
          <input id="trap" type="password">
        </div>
        <input id="u" type="text" autocomplete="username">
        <input id="real" type="password">
        <button type="submit">Sign in</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('login-form');
    expect(scan.password?.selector).toBe('#real');
  });

  it('ignores a zero-opacity trap', async () => {
    await load(`
      <form>
        <input id="u" type="text" autocomplete="username">
        <input id="trap" type="password" style="opacity:0">
        <input id="real" type="password">
        <button type="submit">Sign in</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.password?.selector).toBe('#real');
  });

  it('does not mistake a search box for a username field', async () => {
    await load(`
      <input id="q" type="text" name="search" placeholder="Search the site">
      <form>
        <input id="user" type="text" name="login">
        <input id="p" type="password">
        <button type="submit">Sign in</button>
      </form>
    `);
    const scan = await scanForLogin(page);
    expect(scan.username?.selector).toBe('#user');
  });

  it('reports no form on a page that has none', async () => {
    await load(`<article><h1>A news story</h1><p>Words.</p></article>`);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('no-form');
    expect(scan.password).toBeNull();
    expect(scan.username).toBeNull();
  });
});

describe('scanForLogin — places forms hide', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('finds a form inside an open shadow root', async () => {
    await load(`
      <div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        root.innerHTML =
          '<form>' +
          '<input id="su" type="text" autocomplete="username">' +
          '<input id="sp" type="password" autocomplete="current-password">' +
          '<button type="submit">Sign in</button>' +
          '</form>';
      </script>
    `);
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('login-form');
    expect(scan.password?.inShadow).toBe(true);
    // Playwright's CSS engine pierces open shadow roots, so the selector the
    // scan hands back must actually resolve from the frame.
    expect(await page.locator(scan.password!.selector).count()).toBe(1);
  });

  it('finds a form inside an iframe and reports the frame url', async () => {
    await page.setContent(
      `<!DOCTYPE html><html><body><h1>Host page</h1>
       <iframe id="f" src="data:text/html,${encodeURIComponent(
         '<form><input id="fu" type="text" autocomplete="username"><input id="fp" type="password"><button type="submit">Sign in</button></form>',
       )}"></iframe></body></html>`,
      { waitUntil: 'load' },
    );
    const scan = await scanForLogin(page);
    expect(scan.status).toBe('login-form');
    // The winning frame is the iframe, and its own url is what the domain rule
    // will be applied to — not the host page's.
    expect(scan.url).not.toBe(scan.topUrl);
  });

  it('lets the main frame win a tie against an advert frame', async () => {
    await page.setContent(
      `<!DOCTYPE html><html><body>
       <form><input id="mainu" type="text" autocomplete="username"><input id="mainp" type="password"><button type="submit">Sign in</button></form>
       <iframe id="ad" src="data:text/html,${encodeURIComponent(
         '<form><input id="adu" type="text" autocomplete="username"><input id="adp" type="password"><button>Go</button></form>',
       )}"></iframe></body></html>`,
      { waitUntil: 'load' },
    );
    const scan = await scanForLogin(page);
    expect(scan.password?.selector).toBe('#mainp');
    expect(scan.url).toBe(scan.topUrl);
  });
});

describe('isRealPasswordField — the check no hint can bypass', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('accepts a genuine visible password box', async () => {
    await load(`<input id="p" type="password">`);
    expect(await isRealPasswordField(page.mainFrame(), '#p')).toBe(true);
  });

  it('refuses a text box, however it was pointed at', async () => {
    await load(`<input id="u" type="text"><input id="p" type="password">`);
    // This is the whole safety story for the agent-supplied field hint: the
    // agent may point, but only ever at a password box.
    expect(await isRealPasswordField(page.mainFrame(), '#u')).toBe(false);
  });

  it('refuses a hidden input even when its type says password', async () => {
    await load(`<input id="p" type="password" style="display:none">`);
    expect(await isRealPasswordField(page.mainFrame(), '#p')).toBe(false);
  });

  it('refuses a selector that matches nothing', async () => {
    await load(`<input id="p" type="password">`);
    expect(await isRealPasswordField(page.mainFrame(), '#gone')).toBe(false);
  });

  it('refuses a disabled password box', async () => {
    await load(`<input id="p" type="password" disabled>`);
    expect(await isRealPasswordField(page.mainFrame(), '#p')).toBe(false);
  });

  it('refuses a box whose show-password toggle is currently switched on', async () => {
    // `type` is a reflected attribute: flipping the property rewrites the
    // attribute, so there is no surviving record that this was once a password
    // box, and no check could accept it while refusing a genuine text input.
    // Refusing is also the right direction on its own terms — the field is
    // rendering its contents in plain sight, which is not where a stored
    // password belongs. The user toggles it back and the login proceeds.
    await load(`<input id="p" type="password">`);
    await page.evaluate(`document.getElementById('p').type = 'text'`);
    expect(await page.evaluate(`document.getElementById('p').getAttribute('type')`)).toBe('text');
    expect(await isRealPasswordField(page.mainFrame(), '#p')).toBe(false);
  });
});
