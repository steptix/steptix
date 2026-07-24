import { describe, it, expect, beforeEach } from 'vitest';
import {
  withSession,
  withSingleFlightStart,
  lastStartFailure,
  recordStartFailure,
  clearStartFailure,
  resetRegistry,
} from '../src/mcp/registry.js';

const URL_A = 'http://127.0.0.1:3100';

beforeEach(() => {
  resetRegistry();
});

/** Resolvable-from-outside promise, so a test can hold work open and control
 *  the interleaving rather than racing timers. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withSession', () => {
  it('runs calls on one session one at a time', async () => {
    // The server already queues per session, so without this the second call
    // would not fail — it would run against the first run's mutated page and
    // variable scope, which looks like success. That is the failure this
    // serialisation exists to prevent, so the test asserts ordering, not
    // rejection.
    const order: string[] = [];
    const first = deferred();

    const a = withSession(URL_A, 's1', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = withSession(URL_A, 's1', async () => {
      order.push('b:start');
    });

    await Promise.resolve();
    expect(order).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('does not serialise different sessions', async () => {
    const order: string[] = [];
    const held = deferred();

    const a = withSession(URL_A, 's1', async () => {
      order.push('a:start');
      await held.promise;
    });
    const b = withSession(URL_A, 's2', async () => {
      order.push('b:start');
    });

    await b;
    expect(order).toEqual(['a:start', 'b:start']);
    held.resolve();
    await a;
  });

  it('treats localhost and 127.0.0.1 as the same session', async () => {
    // Two mutexes for one session would also mean two "this is the first
    // call" beliefs, and the second one re-sends `config` to a session that
    // already exists — which the server refuses.
    const order: string[] = [];
    const held = deferred();

    const a = withSession('http://localhost:3100', 's1', async () => {
      order.push('a:start');
      await held.promise;
      order.push('a:end');
    });
    const b = withSession('http://127.0.0.1:3100', 's1', async () => {
      order.push('b:start');
    });

    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    held.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('keeps the session usable after a call throws', async () => {
    // One failed run must not wedge the session for the life of the process.
    await expect(
      withSession(URL_A, 's1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(withSession(URL_A, 's1', async () => 'ok')).resolves.toBe('ok');
  });

  it('reports how long a call waited', async () => {
    const held = deferred();
    const a = withSession(URL_A, 's1', async () => {
      await held.promise;
    });
    let waited = -1;
    const b = withSession(URL_A, 's1', async ({ queuedForMs }) => {
      waited = queuedForMs;
    });

    setTimeout(() => held.resolve(), 20);
    await Promise.all([a, b]);
    expect(waited).toBeGreaterThanOrEqual(10);
  });

  it('reports isFirstCall only until a call marks the session configured', async () => {
    // Read AND set inside the critical section: read outside it and two
    // serialised calls both believe they are first.
    const seen: boolean[] = [];
    await withSession(URL_A, 's1', async ({ isFirstCall, markConfigured }) => {
      seen.push(isFirstCall);
      markConfigured();
    });
    await withSession(URL_A, 's1', async ({ isFirstCall }) => {
      seen.push(isFirstCall);
    });
    expect(seen).toEqual([true, false]);
  });

  it('still reports isFirstCall when a call declines to mark it', async () => {
    // A connect failure must not burn the flag, or the retry-without-config
    // path fires on a session that was never created.
    const seen: boolean[] = [];
    await withSession(URL_A, 's1', async ({ isFirstCall }) => {
      seen.push(isFirstCall);
    });
    await withSession(URL_A, 's1', async ({ isFirstCall }) => {
      seen.push(isFirstCall);
    });
    expect(seen).toEqual([true, true]);
  });
});

describe('withSingleFlightStart', () => {
  it('starts once for concurrent callers', async () => {
    // Auto-start happens before the session mutex, so nothing else stops two
    // parallel tool calls from both spawning a server on the same port.
    let starts = 0;
    const held = deferred();
    const start = async () => {
      starts++;
      await held.promise;
    };

    const a = withSingleFlightStart(URL_A, undefined, start);
    const b = withSingleFlightStart(URL_A, undefined, start);
    held.resolve();
    await Promise.all([a, b]);

    expect(starts).toBe(1);
  });

  it('lets a cancelled caller walk away without failing the others', async () => {
    // The shared spawn runs under a controller the registry owns. If it ran
    // under a caller's signal, one cancellation would abort the spawn for
    // everyone — and because an aborted health probe reads as "server down",
    // the survivors would be told the start failed.
    let observedSignalAborted = false;
    const held = deferred();
    const controller = new AbortController();

    const start = async (signal: AbortSignal) => {
      await held.promise;
      observedSignalAborted = signal.aborted;
    };

    const cancelled = withSingleFlightStart(URL_A, controller.signal, start);
    const survivor = withSingleFlightStart(URL_A, undefined, start);

    controller.abort(new Error('caller gave up'));
    await expect(cancelled).rejects.toThrow('caller gave up');

    held.resolve();
    await expect(survivor).resolves.toBeUndefined();
    expect(observedSignalAborted).toBe(false);
  });

  it('rejects immediately for a caller whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    await expect(
      withSingleFlightStart(URL_A, controller.signal, async () => {}),
    ).rejects.toThrow('already gone');
  });

  it('does not remember a failed start', async () => {
    // A retained rejection would poison the URL for the life of the process
    // and silently override the 60s backoff, which is meant to be the only
    // suppression mechanism.
    let starts = 0;
    const start = async () => {
      starts++;
      throw new Error('spawn failed');
    };

    await expect(withSingleFlightStart(URL_A, undefined, start)).rejects.toThrow('spawn failed');
    await expect(withSingleFlightStart(URL_A, undefined, start)).rejects.toThrow('spawn failed');
    expect(starts).toBe(2);
  });

  it('does not remember a successful start either', async () => {
    let starts = 0;
    const start = async () => {
      starts++;
    };
    await withSingleFlightStart(URL_A, undefined, start);
    await withSingleFlightStart(URL_A, undefined, start);
    expect(starts).toBe(2);
  });
});

describe('start-failure backoff', () => {
  it('records and clears per canonical URL', () => {
    expect(lastStartFailure(URL_A)).toBeUndefined();
    recordStartFailure('http://localhost:3100', 1234);
    expect(lastStartFailure(URL_A)).toBe(1234);
    clearStartFailure('HTTP://LOCALHOST:3100/');
    expect(lastStartFailure(URL_A)).toBeUndefined();
  });
});
