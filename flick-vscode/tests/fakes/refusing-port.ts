/**
 * A loopback URL that refuses connections for as long as it is held.
 *
 * Its port is the local end of a client connection to a throwaway server: the
 * OS bound that port to the client and nothing listens on it, so a request to
 * it gets a genuine ECONNREFUSED. Unlike a port a server just let go of, it
 * stays in use until `release()`, so the OS cannot hand it to another
 * listener mid-test and turn the refusal into somebody else's answer.
 */

import * as net from 'node:net';
import { once } from 'node:events';

export interface RefusingPort {
  readonly url: string;
  readonly port: number;
  release(): Promise<void>;
}

export async function refusingPort(): Promise<RefusingPort> {
  const accepted = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    accepted.add(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  client.on('error', () => undefined);
  await once(client, 'connect');
  const port = client.localPort!;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    release: async () => {
      client.destroy();
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
