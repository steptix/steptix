import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  bindFetchablePort,
  freeFetchablePort,
  isFetchBadPort,
  listenFetchable,
  type PortBinder,
} from './listen-fetchable.cjs';

/** A binder that hands out `ports` in order and records what was done. */
function fakeBinder(ports: number[]): PortBinder & { calls: string[] } {
  const queue = [...ports];
  const calls: string[] = [];
  return {
    calls,
    async bind() {
      const port = queue.shift();
      if (port === undefined) throw new Error('fake binder ran out of ports');
      calls.push(`bind ${port}`);
      return port;
    },
    async unbind() {
      calls.push('unbind');
    },
  };
}

describe('isFetchBadPort', () => {
  it('blocks the ports undici and Chromium refuse', () => {
    for (const port of [10080, 6000, 6665, 6669, 5060, 5061, 4190, 6697]) {
      expect(isFetchBadPort(port)).toBe(true);
    }
  });

  it('allows ordinary ephemeral ports', () => {
    for (const port of [3100, 8787, 49152, 50000, 60999, 65535]) {
      expect(isFetchBadPort(port)).toBe(false);
    }
  });
});

describe('bindFetchablePort', () => {
  it('keeps the first port when it is not blocked', async () => {
    const binder = fakeBinder([50123]);
    expect(await bindFetchablePort(binder)).toBe(50123);
    expect(binder.calls).toEqual(['bind 50123']);
  });

  it('releases a blocked port and binds again in the same process', async () => {
    const binder = fakeBinder([10080, 50123]);
    expect(await bindFetchablePort(binder)).toBe(50123);
    expect(binder.calls).toEqual(['bind 10080', 'unbind', 'bind 50123']);
  });

  it('gives up after the cap, naming every port it was handed', async () => {
    const binder = fakeBinder([10080, 6000, 6666]);
    await expect(bindFetchablePort(binder, 3)).rejects.toThrow(
      'the OS gave only fetch-blocked ports in 3 tries: 10080, 6000, 6666',
    );
    expect(binder.calls).toEqual(['bind 10080', 'unbind', 'bind 6000', 'unbind', 'bind 6666', 'unbind']);
  });
});

describe('listenFetchable', () => {
  // The case this helper exists for, on real sockets. The OS cannot be made to
  // hand out a bad port, so the first port it does hand out is declared bad.
  it('closes a blocked port and binds the same server again, which then serves fetch', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    const events: string[] = [];
    server.on('listening', () => events.push(`listening ${(server.address() as { port: number }).port}`));
    server.on('close', () => events.push('close'));
    const drawn: number[] = [];
    try {
      const port = await listenFetchable(server, '127.0.0.1', {
        isBlocked: (p) => {
          drawn.push(p);
          return drawn.length === 1;
        },
      });

      // Two real binds with a real close between them, and the port it kept is
      // the second one. (The OS may hand the same number back; that is fine.)
      expect(drawn).toHaveLength(2);
      expect(port).toBe(drawn[1]);
      expect(events).toEqual([`listening ${drawn[0]}`, 'close', `listening ${drawn[1]}`]);
      expect(server.address()).toMatchObject({ port });
      expect(server.listenerCount('error')).toBe(0);

      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('leaves a real server listening on the port it reports, reachable by fetch', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    try {
      const port = await listenFetchable(server, '127.0.0.1');
      expect(isFetchBadPort(port)).toBe(false);
      expect(server.address()).toMatchObject({ port });
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects when the bind itself fails, leaving no listener behind', async () => {
    const server = createServer();
    try {
      // Not an address on this machine (TEST-NET-1), so listen emits 'error'.
      await expect(listenFetchable(server, '192.0.2.1')).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
      expect(server.listenerCount('error')).toBe(0);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rethrows a synchronous listen error and takes its listeners off', async () => {
    const server = createServer();
    try {
      await listenFetchable(server, '127.0.0.1');
      const before = server.listenerCount('listening');
      await expect(listenFetchable(server, '127.0.0.1')).rejects.toMatchObject({ code: 'ERR_SERVER_ALREADY_LISTEN' });
      expect(server.listenerCount('error')).toBe(0);
      expect(server.listenerCount('listening')).toBe(before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('freeFetchablePort', () => {
  // Not re-bound here to prove it free: between the probe's close and a bind,
  // another worker can be handed the same port, which is the race this helper
  // documents. What it adds over a plain probe is the check below.
  it('hands back a port fetch accepts', async () => {
    expect(isFetchBadPort(await freeFetchablePort())).toBe(false);
  });
});
