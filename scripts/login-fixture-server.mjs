// A standalone sign-in page for testing the credential broker (SPEC 29).
//
//   node scripts/login-fixture-server.mjs
//
// Separate from `try-login-broker.mjs` because a fleet agent needs the page to
// outlive any one script: the agent navigates to it, reads it, calls
// log_into_site, and reads it again.
//
// Deliberately a real HTTP origin on localhost rather than a file:// page —
// the broker refuses non-http URLs outright, and a fixture that dodged that
// rule would be testing a path no real site takes.

import { createServer } from 'node:http';

const PORT = Number(process.env.FIXTURE_PORT ?? 8899);

const PAGE = `<!DOCTYPE html><html><head><title>Broker canary — sign in</title>
<style>body{font:16px system-ui;margin:60px auto;max-width:440px}
label{display:block;margin:14px 0 4px}input{width:100%;padding:8px;font-size:15px}
button{margin-top:18px;padding:10px 18px;font-size:15px}
#out{margin-top:24px;padding:12px;background:#eef;border-radius:6px}</style></head><body>
<h1>Broker canary</h1>
<p>A throwaway sign-in form for testing the credential broker.</p>
<form>
  <label for="u">Email</label><input id="u" name="email" type="text" autocomplete="username">
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button type="submit" id="go">Sign in</button>
</form>
<div id="out">Not submitted yet.</div>
<script>
  document.getElementById('go').addEventListener('click', function (e) {
    e.preventDefault();
    // Reports LENGTHS, never values. An agent reads this page after signing in,
    // and a fixture that echoed the password back into the page would put it
    // straight into the model's context — manufacturing the exact leak the
    // canary is here to detect, and blaming the broker for it.
    document.getElementById('out').textContent =
      'Signed in. username length=' + document.getElementById('u').value.length +
      ', password length=' + document.getElementById('p').value.length;
    document.title = 'SIGNED IN';
  });
</script></body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(PAGE);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Login fixture on http://localhost:${PORT}/login`);
  console.log('Vault item URI should be:  http://localhost:' + PORT);
  console.log('Ctrl+C to stop.');
});
