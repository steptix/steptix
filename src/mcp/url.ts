/**
 * URL helpers shared by the registry (W1) and auto-start (W4).
 *
 * They live together because they are one rule seen from two angles: the key
 * a server is filed under, and the host its child process binds to. Splitting
 * them is how `localhost` and `127.0.0.1` end up meaning the same server in
 * one map and different servers in another.
 */
import { normalizeBaseUrl } from '../server/health.js';

/** Hosts we will auto-start a server on. Deliberately not `0.0.0.0` (that is
 *  a bind wildcard, not a loopback address) and not the rest of `127/8`. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `new URL('http://[::1]:3100').hostname` keeps the brackets, which
 *  `server.listen()` rejects. Strip them before anything else looks. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(bareHost(hostname).toLowerCase());
}

/**
 * The host to hand `serve --host`.
 *
 * Collapsing `localhost` to `127.0.0.1` is not cosmetic. `serve` passes the
 * value to `server.listen()`, which resolves it via `dns.lookup` — and on a
 * dual-stack Windows box `localhost` resolves to `::1` first, so the child
 * binds IPv6 loopback *only*. Our own `fetch` still reaches it (happy
 * eyeballs), so nothing looks wrong — but `aiui status` and `aiui stop`
 * derive their target from `aiui.config.json`, typically `127.0.0.1`, and
 * report "not running" against a server that is running. The result is a
 * server you can neither see nor stop from the CLI.
 *
 * This repo triggers exactly that: `.env` says `SERVER_URL=http://localhost:3100`
 * while `aiui.config.json` says `"host": "127.0.0.1"`.
 */
export function normalizeSpawnHost(hostname: string): string {
  const bare = bareHost(hostname).toLowerCase();
  if (bare === 'localhost' || bare === '127.0.0.1') return '127.0.0.1';
  if (bare === '::1') return '::1';
  return bare;
}

/**
 * The single key a server URL is filed under — by the session mutex, the
 * "config already sent" bookkeeping, the auto-start single-flight and the
 * auto-start backoff alike.
 *
 * One function rather than four call sites doing their own thing, because
 * the failure is silent and asymmetric: if the mutex and the config
 * bookkeeping disagree about whether `http://localhost:3100` and
 * `http://127.0.0.1:3100` are the same server, one session gets two mutexes
 * and two "this is the first call" beliefs — and the second belief re-sends
 * `config` to a session that already exists, which the server refuses.
 *
 * Lowercasing alone would not do it: that folds `HTTP://LOCALHOST:3100` onto
 * `http://localhost:3100` but still leaves `localhost` and `127.0.0.1` apart.
 */
export function canonicalServerKey(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    // Not our job to validate here — auto-start reports a bad SERVER_URL with
    // a message that names it. Fall back to a stable string so callers still
    // agree with each other.
    return normalizeBaseUrl(serverUrl).toLowerCase();
  }
  parsed.hostname = normalizeSpawnHost(parsed.hostname);
  return normalizeBaseUrl(parsed.toString()).toLowerCase();
}
