// The domain rule and the gate order (SPEC 29 §6, §9).
//
// Two things are being pinned here, and neither is "the happy path works":
//
//  1. **The gates fire in order, and the expensive ones do not fire early.**
//     Every test that expects a refusal also asserts that the vault was never
//     asked and the user was never prompted. A broker that looked up the vault
//     first and refused afterwards would pass a naive assertion on the outcome
//     string while leaking which sites the user has accounts on.
//  2. **A wrong-domain page is refused.** The mutation to fear is someone
//     "simplifying" `itemsCoveringHost` away on the grounds that `bw` already
//     matched. `describe('the domain rule')` fails if they do.
//
// The pages are served over real HTTP from 127.0.0.1 rather than `setContent`,
// because half of what is under test is what the URL is and whether the scheme
// is allowed — and `about:blank` would make those assertions vacuous.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { LoginBroker, GRANT_TTL_MS } from '../src/credentials/broker.js';
import { itemsCoveringHost, pageIsFillable, uriCoversHost } from '../src/credentials/domain-match.js';
import { VaultError, type ApprovalProvider, type VaultItem, type VaultProvider } from '../src/credentials/types.js';

/**
 * Vitest's per-test default is 5 seconds, and the gate-order suites below each
 * drive a real browser through one or two complete sign-in journeys inside a
 * 120-file parallel run. The budget is not about how long a login takes — it is
 * about how long this process waits for a CPU slice while every other suite
 * runs. Applied file-wide rather than per-test because a failure from it
 * reports as "about 5000ms", which reads exactly like a Playwright action
 * timeout and sends you tuning the wrong number.
 */
const BROWSER_TEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------

describe('the domain rule', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('matches a page on the host the item names', () => {
    expect(uriCoversHost('https://facebook.com', 'facebook.com')).toBe(true);
  });

  it('matches a subdomain of the item host', () => {
    expect(uriCoversHost('https://facebook.com', 'www.facebook.com')).toBe(true);
    expect(uriCoversHost('https://facebook.com', 'm.facebook.com')).toBe(true);
  });

  it('matches upward, from a page on the base domain to an item stored with www', () => {
    expect(uriCoversHost('https://www.facebook.com', 'facebook.com')).toBe(true);
  });

  it('REFUSES a lookalike that merely ends with the same letters', () => {
    // The whole reason the rule is suffix-with-a-dot-boundary rather than
    // endsWith. A plain endsWith matches this, and this is what a phishing
    // domain is built to be.
    expect(uriCoversHost('https://facebook.com', 'evil-facebook.com')).toBe(false);
    expect(uriCoversHost('https://facebook.com', 'notfacebook.com')).toBe(false);
  });

  it('REFUSES a domain that merely contains the item host as a prefix', () => {
    expect(uriCoversHost('https://facebook.com', 'facebook.com.evil.io')).toBe(false);
  });

  it('refuses a bare TLD, however it was recorded', () => {
    expect(uriCoversHost('com', 'facebook.com')).toBe(false);
    expect(uriCoversHost('https://com', 'facebook.com')).toBe(false);
  });

  it('reads a vault uri that was stored without a scheme', () => {
    expect(uriCoversHost('facebook.com', 'www.facebook.com')).toBe(true);
    expect(uriCoversHost('facebook.com/login', 'facebook.com')).toBe(true);
  });

  it('never matches a non-web uri', () => {
    // Bitwarden stores Android and iOS app entries alongside web ones.
    expect(uriCoversHost('androidapp://com.facebook.katana', 'facebook.com')).toBe(false);
  });

  it('filters a mixed item list down to the covering ones', () => {
    const items = [
      { name: 'Facebook', uris: ['https://facebook.com'] },
      { name: 'Evil', uris: ['https://evil.io'] },
      { name: 'Work', uris: ['https://intranet.corp.example'] },
    ];
    expect(itemsCoveringHost(items, 'www.facebook.com').map((i) => i.name)).toEqual(['Facebook']);
  });
});

describe('which pages may be filled at all', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('allows https', () => {
    expect(pageIsFillable('https://facebook.com/login')).toBeNull();
  });

  it('allows http only on loopback, where there is no wire to read', () => {
    expect(pageIsFillable('http://127.0.0.1:8787/login')).toBeNull();
    expect(pageIsFillable('http://localhost:8787/login')).toBeNull();
  });

  it('refuses plain http on a real host', () => {
    expect(pageIsFillable('http://facebook.com/login')).toBe('insecure');
  });

  it('refuses a page that is not a web page', () => {
    // `data:` in particular is attacker-supplied markup wearing a URL, and is
    // exactly what an injected instruction would try to get a fill onto.
    expect(pageIsFillable('data:text/html,<input type=password>')).toBe('not-http');
    expect(pageIsFillable('about:blank')).toBe('not-http');
    expect(pageIsFillable('file:///C:/tmp/login.html')).toBe('not-http');
  });
});

// ---------------------------------------------------------------------------
// The gate order, against a real page
// ---------------------------------------------------------------------------

const LOGIN_PAGE = `<!DOCTYPE html><html><body>
  <form>
    <input id="u" type="text" autocomplete="username">
    <input id="p" type="password" autocomplete="current-password">
    <button type="submit" id="go">Sign in</button>
  </form>
  <script>
    document.getElementById('go').addEventListener('click', function (e) {
      e.preventDefault();
      document.title = 'submitted';
    });
  </script>
</body></html>`;

const ARTICLE_PAGE = `<!DOCTYPE html><html><body><article><h1>News</h1><p>Words.</p></article></body></html>`;

const REGISTER_PAGE = `<!DOCTYPE html><html><body><form>
  <input id="u" type="text" autocomplete="username">
  <input id="p1" type="password">
  <input id="p2" type="password">
  <button type="submit">Create account</button>
</form></body></html>`;

const USERNAME_ONLY_PAGE = `<!DOCTYPE html><html><body><form>
  <input id="u" type="email" autocomplete="username">
  <button type="submit" id="go">Next</button>
</form>
<script>document.getElementById('go').addEventListener('click', function (e) { e.preventDefault(); });</script>
</body></html>`;

const PAGES: Record<string, string> = {
  '/login': LOGIN_PAGE,
  '/article': ARTICLE_PAGE,
  '/register': REGISTER_PAGE,
  '/step-one': USERNAME_ONLY_PAGE,
};

let server: Server;
let origin: string;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[(req.url ?? '/').split('?')[0] ?? '/'] ?? '<!DOCTYPE html><html><body>nothing</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const SECRET_PASSWORD = 'correct-horse-battery-staple-9931';
const SECRET_USERNAME = 'paul@example.com';

/** A vault holding one item that covers 127.0.0.1, so the local page matches. */
function fakeVault(overrides: Partial<VaultProvider> & { items?: VaultItem[] } = {}) {
  const items = overrides.items ?? [
    { id: 'item-1', name: 'Test Site', uris: ['http://127.0.0.1'], hasTotp: false },
  ];
  const vault = {
    itemsForUrl: vi.fn(async () => items),
    secretFor: vi.fn(async () => ({ username: SECRET_USERNAME, password: SECRET_PASSWORD })),
    totpFor: vi.fn(async () => null),
    ...overrides,
  };
  return vault as VaultProvider & typeof vault;
}

function approver(allowed: boolean, chosen = 0) {
  return { ask: vi.fn(async () => ({ allowed, chosen })) } as ApprovalProvider & { ask: ReturnType<typeof vi.fn> };
}

describe('gate order — a wrong call costs nothing', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('reports a non-login page WITHOUT touching the vault or the user', async () => {
    await page.goto(`${origin}/article`);
    const vault = fakeVault();
    const approval = approver(true);
    const broker = new LoginBroker({ vault, approval });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('not-a-login-page');
    // The point of the whole ordering: nothing was unlocked, nothing was read,
    // nobody was interrupted.
    expect(vault.itemsForUrl).not.toHaveBeenCalled();
    expect(approval.ask).not.toHaveBeenCalled();
  });

  it('declines a registration form before any vault lookup', async () => {
    await page.goto(`${origin}/register`);
    const vault = fakeVault();
    const approval = approver(true);
    const broker = new LoginBroker({ vault, approval });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('stuck');
    expect(res.detail).toMatch(/sign-up or change-password/i);
    expect(vault.itemsForUrl).not.toHaveBeenCalled();
    expect(approval.ask).not.toHaveBeenCalled();
  });

  it('asks the vault with the URL THE BROWSER reported', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault();
    const broker = new LoginBroker({ vault, approval: approver(false) });

    await broker.attemptLogin(page);

    // Not a URL the caller passed in — `log_into_site` takes no site argument
    // at all, and this is the assertion that keeps it that way.
    expect(vault.itemsForUrl).toHaveBeenCalledWith(`${origin}/login`);
  });

  it('refuses when no vault item covers this host, without prompting', async () => {
    await page.goto(`${origin}/login`);
    // A vault that answers with a Facebook item for a 127.0.0.1 page — which is
    // what a mis-configured per-item match mode in Bitwarden actually produces.
    const vault = fakeVault({
      items: [{ id: 'fb', name: 'Facebook', uris: ['https://facebook.com'], hasTotp: false }],
    });
    const approval = approver(true);
    const broker = new LoginBroker({ vault, approval });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('no-credential-for-this-site');
    // THE mutation guard: delete `itemsCoveringHost` from the broker and this
    // becomes a prompt to type a Facebook password into 127.0.0.1.
    expect(approval.ask).not.toHaveBeenCalled();
    expect(vault.secretFor).not.toHaveBeenCalled();
  });

  it('never fetches a secret when the user denies', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault();
    const approval = approver(false);
    const broker = new LoginBroker({ vault, approval });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('denied');
    expect(approval.ask).toHaveBeenCalledTimes(1);
    expect(vault.secretFor).not.toHaveBeenCalled();
    expect(await page.locator('#p').inputValue()).toBe('');
  });

  it('refuses when the prompt cannot be shown at all', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault();
    const broker = new LoginBroker({
      vault,
      approval: { ask: async () => ({ allowed: false, chosen: 0, unavailable: 'no display' }) },
    });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('denied');
    expect(res.detail).toContain('no display');
    expect(vault.secretFor).not.toHaveBeenCalled();
  });
});

describe('filling, once every gate has passed', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('types both fields with real keystrokes and submits', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault();
    const broker = new LoginBroker({ vault, approval: approver(true) });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('logged-in');
    expect(await page.locator('#u').inputValue()).toBe(SECRET_USERNAME);
    expect(await page.locator('#p').inputValue()).toBe(SECRET_PASSWORD);
    // The submit control was actually clicked, not merely located.
    expect(await page.title()).toBe('submitted');
  });

  it('enters the username and stops on the first page of a two-page login', async () => {
    await page.goto(`${origin}/step-one`);
    const vault = fakeVault();
    const broker = new LoginBroker({ vault, approval: approver(true) });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('username-entered-continue');
    expect(res.continues).toBe(true);
    expect(await page.locator('#u').inputValue()).toBe(SECRET_USERNAME);
  });

  it('refuses to type the password into a field that is not a password box', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault();
    const broker = new LoginBroker({ vault, approval: approver(true) });

    // The agent points at the username box and calls it the password field.
    // This is the hint path, and the answer must be no.
    const res = await broker.attemptLogin(page, { password: '#u' });

    expect(res.outcome).toBe('stuck');
    expect(res.detail).toMatch(/not a password box/i);
    expect(vault.secretFor).not.toHaveBeenCalled();
    expect(await page.locator('#u').inputValue()).toBe('');
  });
});

describe('one approval covers one login journey', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('does not re-prompt for a second page within the window', async () => {
    const vault = fakeVault();
    const approval = approver(true);
    let clock = 1_000;
    const broker = new LoginBroker({ vault, approval, now: () => clock });

    await page.goto(`${origin}/step-one`);
    await broker.attemptLogin(page);
    clock += 30_000;
    await page.goto(`${origin}/login`);
    const second = await broker.attemptLogin(page);

    expect(second.outcome).toBe('logged-in');
    expect(approval.ask).toHaveBeenCalledTimes(1);
  });

  it('asks again once the window has lapsed', async () => {
    const vault = fakeVault();
    const approval = approver(true);
    let clock = 1_000;
    const broker = new LoginBroker({ vault, approval, now: () => clock });

    await page.goto(`${origin}/login`);
    await broker.attemptLogin(page);
    clock += GRANT_TTL_MS + 1;
    await page.goto(`${origin}/login`);
    await broker.attemptLogin(page);

    expect(approval.ask).toHaveBeenCalledTimes(2);
  });

  it('offers every matching item and uses the one chosen', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault({
      items: [
        { id: 'personal', name: 'Test Site (personal)', uris: ['http://127.0.0.1'], hasTotp: false },
        { id: 'work', name: 'Test Site (work)', uris: ['http://127.0.0.1'], hasTotp: false },
      ],
    });
    const approval = approver(true, 1);
    const broker = new LoginBroker({ vault, approval });

    const res = await broker.attemptLogin(page);

    expect(approval.ask).toHaveBeenCalledWith(
      expect.objectContaining({ items: ['Test Site (personal)', 'Test Site (work)'] }),
    );
    expect(vault.secretFor).toHaveBeenCalledWith('work');
    expect(res.item).toBe('Test Site (work)');
  });
});

describe('when the vault cannot answer', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('reports a missing CLI as its own outcome', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault({
      itemsForUrl: vi.fn(async () => {
        throw new VaultError('cli-missing', 'not installed');
      }),
    });
    const broker = new LoginBroker({ vault, approval: approver(true) });

    const res = await broker.attemptLogin(page);

    expect(res.outcome).toBe('vault-unavailable');
    expect(res.detail).toMatch(/not installed on this machine/i);
  });

  it('raises the unlock prompt when locked, and gives up if it is refused', async () => {
    await page.goto(`${origin}/login`);
    const vault = fakeVault();
    const unlockVault = vi.fn(async () => false);
    const broker = new LoginBroker({
      vault,
      approval: approver(true),
      vaultUnlocked: () => false,
      unlockVault,
    });

    const res = await broker.attemptLogin(page);

    expect(unlockVault).toHaveBeenCalledTimes(1);
    expect(res.outcome).toBe('vault-locked');
    expect(vault.itemsForUrl).not.toHaveBeenCalled();
  });
});

describe('nothing secret rides the result', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it('keeps the password and username out of every field of a successful result', async () => {
    await page.goto(`${origin}/login`);
    const broker = new LoginBroker({ vault: fakeVault(), approval: approver(true) });

    const res = await broker.attemptLogin(page);

    // The load-bearing assertion of the whole feature. This object is what
    // becomes the MCP tool result, which becomes model context, which becomes a
    // stored transcript. Serialised whole so a future field cannot smuggle one
    // through without failing here.
    const serialised = JSON.stringify(res);
    expect(res.outcome).toBe('logged-in');
    expect(serialised).not.toContain(SECRET_PASSWORD);
    expect(serialised).not.toContain(SECRET_USERNAME);
    // The item NAME is fine and useful — it is what the user chose.
    expect(serialised).toContain('Test Site');
  });
});
