/**
 * Which port `steptix serve` listens on, and which URL a client falls back to
 * when no project names a server (stories/machine-server-url.md).
 *
 * Both sides read the same line — `STEPTIX_SERVER_URL` in the user root's `.env` —
 * which is what makes them agree without either telling the other: a bare
 * `serve` listens on that URL's port, and a client with no project `STEPTIX_SERVER_URL`
 * connects to that URL. With no line, both use {@link DEFAULT_SERVER_URL}.
 *
 * A project's own `.env` is deliberately not part of the server's order. It
 * says which server that project connects to; it never decides which port a
 * server starts on. A server for a non-default port is started with `-p`.
 */

import { readUserRootEnv, userRootEnvPath, type UserRootDeps } from './user-root.js';

export const DEFAULT_SERVER_PORT = 3100;

/** Loopback by address rather than `localhost`, so it names exactly what a
 *  default `serve` binds (`server.host` defaults to 127.0.0.1) whichever
 *  address family `localhost` resolves to first. */
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

export const SERVER_URL_VAR = 'STEPTIX_SERVER_URL';

/** `STEPTIX_SERVER_URL` from the user root's `.env`, trimmed, or null when absent or blank. */
export function readMachineServerUrl(deps?: UserRootDeps): string | null {
  const value = readUserRootEnv(deps)[SERVER_URL_VAR];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

/** The port `serve` will listen on, and where that number came from — the
 *  second half is what an "address in use" error names, so the user knows
 *  which line to change. */
export interface ServePort {
  port: number;
  source: string;
}

/** The user root's `STEPTIX_SERVER_URL` cannot give `serve` a port. */
export class ServePortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServePortError';
  }
}

/**
 * The port a `serve` listens on: `-p`, else the port of the user root's
 * `STEPTIX_SERVER_URL`, else {@link DEFAULT_SERVER_PORT}.
 *
 * Only the port is taken from that URL. Its host says where clients connect,
 * which is not necessarily an address this machine can bind; `serve` binds
 * `server.host` (or `-H`) as before.
 *
 * Throws {@link ServePortError} when the machine `STEPTIX_SERVER_URL` is set but names
 * no usable port. Falling back to 3100 there would start a server on a port no
 * client is looking at, and a URL without a port implies 80 or 443, which is
 * never what was meant.
 */
export function resolveServePort(cliPort: number | undefined, deps?: UserRootDeps): ServePort {
  if (cliPort !== undefined) return { port: cliPort, source: '-p' };

  const machineUrl = readMachineServerUrl(deps);
  if (machineUrl === null) return { port: DEFAULT_SERVER_PORT, source: 'the default' };

  const where = `STEPTIX_SERVER_URL in ${userRootEnvPath(deps)}`;
  let url: URL;
  try {
    url = new URL(machineUrl);
  } catch {
    throw new ServePortError(
      `${where} is not a valid URL: "${machineUrl}". ` +
        `Use a full URL like ${DEFAULT_SERVER_URL}, or pass -p.`,
    );
  }
  // `URL` drops a port that is the scheme's default, so `http://host:80`
  // reads as '' here too — refused alongside a missing one, since a Steptix
  // server on 80 is not something anyone means by leaving the port out.
  const port = Number(url.port);
  if (url.port === '' || port === 0) {
    throw new ServePortError(
      `${where} has no port: "${machineUrl}". ` +
        `Add one, like ${DEFAULT_SERVER_URL}, or pass -p.`,
    );
  }
  return { port, source: where };
}
