// Manual test harness for the credential broker (SPEC 29).
//
//   node scripts/try-login-broker.mjs                 # local fixture page
//   node scripts/try-login-broker.mjs https://site/login
//
// Runs the REAL broker against the REAL vault, in a visible browser, and
// narrates each gate as it passes. Nothing here is a test double: the only
// thing this file adds is the fixture page and the commentary.
//
// It prints no secret, and neither does the broker — if a password ever shows
// up in this output, that is the bug the whole design exists to prevent.

import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createLoginBroker } from '../dist/credentials/index.js';
import { BitwardenVault } from '../dist/credentials/vault.js';

const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 8899);
const target = process.argv[2];

if (target !== undefined && !/^https?:\/\//i.test(target)) {
  console.log(
    'Usage:\n' +
      '  node scripts/try-login-broker.mjs                    test against a local fixture page\n' +
      '  node scripts/try-login-broker.mjs https://site/login test against a real sign-in page\n\n' +
      'The argument must be a full http(s) URL of a page that already shows a sign-in form.',
  );
  process.exit(target === '--help' || target === '-h' ? 0 : 1);
}

const FIXTURE = `<!DOCTYPE html><html><head><title>Broker test — sign in</title>
<style>body{font:16px system-ui;margin:60px auto;max-width:420px}
label{display:block;margin:14px 0 4px}input{width:100%;padding:8px;font-size:15px}
button{margin-top:18px;padding:10px 18px;font-size:15px}
#out{margin-top:24px;padding:12px;background:#eef;border-radius:6px}</style></head><body>
<h1>Broker test</h1>
<form>
  <label for="u">Email</label><input id="u" type="text" autocomplete="username">
  <label for="p">Password</label><input id="p" type="password" autocomplete="current-password">
  <button type="submit" id="go">Sign in</button>
</form>
<div id="out">Not submitted yet.</div>
<script>
  document.getElementById('go').addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('out').textContent =
      'Submitted. username=' + document.getElementById('u').value +
      ' / password length=' + document.getElementById('p').value.length;
    document.title = 'SUBMITTED';
  });
</script></body></html>`;

function banner(text) {
  console.log(`\n[1m${text}[0m`);
}

// ---------------------------------------------------------------------------
// Pre-flight: say what the vault looks like BEFORE touching a browser, because
// "locked" and "not installed" produce very different next steps.
// ---------------------------------------------------------------------------
banner('Vault');
const probe = new BitwardenVault();
const status = await probe.status();
console.log(`  bw status ......... ${status}`);
if (status === 'cli-missing') {
  console.log('  The Bitwarden CLI is not installed or not on PATH. Install it, then re-run.');
  process.exit(1);
}
if (status === 'unauthenticated') {
  console.log('  Signed out. Run:  bw login');
  process.exit(1);
}
console.log(
  process.env.BW_SESSION
    ? '  BW_SESSION ........ set (no unlock prompt will appear)'
    : '  BW_SESSION ........ not set (the broker will raise its own unlock prompt)',
);

let server;
let url = target;
if (!url) {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(FIXTURE_PORT, '127.0.0.1', r));
  url = `http://localhost:${FIXTURE_PORT}/login`;
  banner('Fixture');
  console.log(`  Serving a login page at ${url}`);
  console.log(`  For this to match, your vault needs an item whose URI is:`);
  console.log(`      http://localhost:${FIXTURE_PORT}`);
}

banner('Browser');
// Headed, and it stays open at the end: half of what you are checking here is
// what the page actually looks like after the fill.
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
console.log(`  Opened ${page.url()}`);

const broker = createLoginBroker();

banner('log_into_site');
console.log('  Watch for the approval prompt. Deny is the default button.');
const result = await broker.attemptLogin(page);

banner('Result');
console.log(`  outcome ........... ${result.outcome}`);
console.log(`  domain matched .... ${result.domain}`);
if (result.item) console.log(`  vault item ........ ${result.item}`);
if (result.framedBy) console.log(`  framed by ......... ${result.framedBy}`);
console.log(`  continues ......... ${result.continues}`);
console.log(`  detail ............ ${result.detail}`);

banner('What the page shows now');
for (const sel of ['#u', '#p']) {
  try {
    const value = await page.locator(sel).first().inputValue({ timeout: 1500 });
    // Length, not the value. This harness must not be the thing that prints it.
    console.log(`  ${sel} ................ ${value === '' ? '(empty)' : `filled, ${value.length} chars`}`);
  } catch {
    console.log(`  ${sel} ................ (not present on this page)`);
  }
}
console.log(`  title ............. ${await page.title()}`);

banner('Leak check');
const serialised = JSON.stringify(result);
console.log(`  The result object is what an agent would receive. Verbatim:`);
console.log(`  ${serialised}`);
console.log(`  Nothing above should be a username or a password.`);

if (result.continues) {
  banner('Multi-page');
  console.log('  This sign-in has more steps. In the real flow the agent would');
  console.log('  advance the page and call log_into_site again.');
}

banner('Done — the browser is still open. Press Enter to close it.');
await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once('data', resolve);
});
await browser.close();
if (server) await new Promise((r) => server.close(r));
process.exit(0);
