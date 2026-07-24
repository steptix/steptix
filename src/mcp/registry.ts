/**
 * Process-wide bookkeeping for sessions and server startup.
 *
 * Module-level on purpose, not per-`McpServer`. A per-instance map would let
 * the seam tests pass — each test builds its own server — while production,
 * which has exactly one instance, silently shares nothing. The bug would only
 * appear under real concurrent tool calls.
 *
 * Everything here is keyed by `canonicalServerKey`, so `http://localhost:3100`
 * and `http://127.0.0.1:3100` are one server everywhere or nowhere.
 */
import { canonicalServerKey } from './url.js';

interface SessionEntry {
  /** Tail of the promise chain serialising calls on this session. */
  tail: Promise<unknown>;
  /** Whether this process has already sent `config` for this session. */
  configured: boolean;
}

/** Never deleted: `tail` is replaced per call, but `configured` must outlive
 *  every call for the life of the process. */
const sessions = new Map<string, SessionEntry>();

/** In-flight auto-starts, so parallel cold starts spawn one server. */
const startsInFlight = new Map<string, Promise<void>>();

/** `key → epoch ms of the last failed start`. The single suppression
 *  mechanism; the single-flight map deliberately does not double as one. */
const startFailures = new Map<string, number>();

export function sessionKey(serverUrl: string, sessionId: string): string {
  return `${canonicalServerKey(serverUrl)}::${sessionId}`;
}

function entryFor(key: string): SessionEntry {
  let entry = sessions.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), configured: false };
    sessions.set(key, entry);
  }
  return entry;
}

/**
 * Run `fn` with exclusive access to one session, reporting how long it waited.
 *
 * The server already serialises per session on its own queue, so without this
 * a second concurrent call would not fail — it would block, then run against
 * the first run's mutated page and variable scope, which is worse than an
 * error because it looks like it worked. Hosts do fan out parallel tool
 * calls, and `run_test_file`'s default session id is derived from the file
 * path, so two calls on one file collide by default.
 *
 * `fn` receives the wait so the tool can report `queuedForMs`, and a handle
 * for the config bookkeeping — which must be read *and* written inside the
 * critical section. Read outside it, two serialised calls both believe they
 * are first, and the second sends `config` to a session that now exists.
 */
export async function withSession<T>(
  serverUrl: string,
  sessionId: string,
  fn: (ctx: { queuedForMs: number; isFirstCall: boolean; markConfigured: () => void }) => Promise<T>,
): Promise<T> {
  const key = sessionKey(serverUrl, sessionId);
  const entry = entryFor(key);
  const startedWaiting = Date.now();

  const run = entry.tail.then(async () => {
    const queuedForMs = Date.now() - startedWaiting;
    return fn({
      queuedForMs,
      isFirstCall: !entry.configured,
      markConfigured: () => {
        entry.configured = true;
      },
    });
  });

  // Keep the chain alive even when this call rejects, or one failure would
  // wedge the session for the rest of the process.
  entry.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Auto-start coordination
// ---------------------------------------------------------------------------

/** Epoch ms of the last failed start for this URL, or undefined. */
export function lastStartFailure(serverUrl: string): number | undefined {
  return startFailures.get(canonicalServerKey(serverUrl));
}

export function recordStartFailure(serverUrl: string, at: number): void {
  startFailures.set(canonicalServerKey(serverUrl), at);
}

export function clearStartFailure(serverUrl: string): void {
  startFailures.delete(canonicalServerKey(serverUrl));
}

/**
 * Run `start` at most once per server URL at a time.
 *
 * Two things make this safe, and both are easy to get wrong:
 *
 * - **`start` gets a signal the registry owns, not the caller's.** Auto-start
 *   happens before the session mutex, so several tool calls can be waiting on
 *   one spawn. If the shared work ran under one caller's `AbortSignal`, that
 *   caller cancelling would fail every other waiter — and because an aborted
 *   probe reads as "server down", the survivors would be told the start
 *   failed. Instead each caller races the shared promise against its own
 *   signal: a cancelled caller walks away, the spawn continues, later callers
 *   find a ready server.
 *
 * - **The entry is deleted once settled, success or failure.** A retained
 *   rejection would poison the URL for the life of the process and quietly
 *   override the 60-second backoff, which is meant to be the only suppression.
 */
export async function withSingleFlightStart(
  serverUrl: string,
  callerSignal: AbortSignal | undefined,
  start: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const key = canonicalServerKey(serverUrl);
  let shared = startsInFlight.get(key);

  if (!shared) {
    const controller = new AbortController();
    shared = start(controller.signal).finally(() => {
      startsInFlight.delete(key);
    });
    startsInFlight.set(key, shared);
  }

  if (!callerSignal) return shared;

  // Don't let an unobserved rejection escape when this caller loses the race.
  shared.catch(() => undefined);

  return Promise.race([
    shared,
    new Promise<never>((_resolve, reject) => {
      if (callerSignal.aborted) {
        reject(callerSignal.reason as Error);
        return;
      }
      callerSignal.addEventListener(
        'abort',
        () => reject(callerSignal.reason as Error),
        { once: true },
      );
    }),
  ]);
}

/** Drop all process-wide state. Tests only — production has one process and
 *  wants these to persist for its whole life. */
export function resetRegistry(): void {
  sessions.clear();
  startsInFlight.clear();
  startFailures.clear();
}
