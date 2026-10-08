/**
 * Ports from the OS that `fetch` and Chromium will actually connect to.
 *
 * `listen(0)` can be handed a port on the Fetch standard's "bad port" list —
 * 10080, 6000, 6665-6669, 5060 and the rest below. undici (Node's global
 * `fetch`) refuses those with `TypeError: fetch failed ... Error: bad port`,
 * and Chromium refuses them with `net::ERR_UNSAFE_PORT`, so a whole suite goes
 * red on a run that drew one and green on the rerun. Only a machine whose
 * dynamic port range starts low can draw one (the defaults on Windows, Linux
 * and macOS hold none), but 1024-65535 is a legitimate setting. See #22.
 *
 * CommonJS, with types in listen-fetchable.d.cts, so that every test in the
 * repo can load the one list: the root vitest suites and fixtures/test-app
 * (TypeScript), flick-vscode's esbuild-bundled tests, the .cjs suites that run
 * inside VS Code, steptix-vscode's node:test files, and plain-Node scripts.
 */
'use strict';

/**
 * https://fetch.spec.whatwg.org/#port-blocking, copied 2026-10-08 from the
 * standard last updated 2026-10-06. undici exports nothing public for this.
 * Chromium refuses these ports too (net/base/port_util.cc).
 */
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

function isFetchBadPort(port) {
  return FETCH_BAD_PORTS.has(port);
}

/** Tries before giving up. Each draw is from thousands of ephemeral ports of
 *  which a handful are bad, and the longest run of consecutive bad ones is
 *  five (6665-6669), so needing a second is already rare. */
const MAX_ATTEMPTS = 10;

/** The retry loop on its own, so a test can drive it with a fake binder.
 *  `isBlocked` exists for tests too: the OS cannot be made to hand out a
 *  bad port, so a test marks a real one as blocked to run the real retry. */
async function bindFetchablePort(binder, maxAttempts = MAX_ATTEMPTS, isBlocked = isFetchBadPort) {
  const refused = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = await binder.bind();
    if (!isBlocked(port)) return port;
    refused.push(port);
    await binder.unbind();
  }
  throw new Error(`the OS gave only fetch-blocked ports in ${maxAttempts} tries: ${refused.join(', ')}`);
}

/**
 * `server.listen(0, host)` until the port is one `fetch` accepts. Resolves with
 * that port; `server.address()` reports it too, as after a plain `listen`.
 * Omit `host` to listen on every interface, as `listen(0)` does. A blocked
 * port is closed and port 0 bound again in this same process — never released
 * and handed to someone else, who may lose it to another worker.
 * `options.isBlocked` replaces the bad-port check, for tests only.
 */
function listenFetchable(server, host, options = {}) {
  return bindFetchablePort({
    bind: () =>
      new Promise((resolve, reject) => {
        // Each outcome takes the other's listener off, so neither is left on
        // the server to swallow a later 'error' or answer a later 'listening'.
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (typeof address === 'object' && address !== null) resolve(address.port);
          else reject(new Error(`listen(0) bound no TCP port: ${String(address)}`));
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
          if (host === undefined) server.listen(0);
          else server.listen(0, host);
        } catch (err) {
          // Thrown rather than emitted, e.g. ERR_SERVER_ALREADY_LISTEN.
          server.off('error', onError);
          server.off('listening', onListening);
          throw err;
        }
      }),
    unbind: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }, MAX_ATTEMPTS, options.isBlocked);
}

/**
 * A port nothing is listening on right now, and one `fetch` accepts: bind 0,
 * read the number, close. For a test that must hand a number to another
 * process (a setting, a CLI flag), so it races — another listener can take the
 * port before that process binds it. Prefer `listenFetchable` whenever the
 * server is in this process.
 */
function freeFetchablePort(host = '127.0.0.1') {
  const net = require('node:net');
  return bindFetchablePort({
    bind: () =>
      new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.once('error', reject);
        probe.listen(0, host, () => {
          const { port } = probe.address();
          probe.close(() => resolve(port));
        });
      }),
    // The probe is already closed; nothing to release.
    unbind: async () => {},
  });
}

module.exports = { FETCH_BAD_PORTS, isFetchBadPort, bindFetchablePort, listenFetchable, freeFetchablePort };
