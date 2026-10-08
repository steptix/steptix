import type { Server } from 'node:net';

/** The Fetch standard's bad ports, which `fetch` and Chromium refuse. */
export declare const FETCH_BAD_PORTS: ReadonlySet<number>;

export declare function isFetchBadPort(port: number): boolean;

export interface PortBinder {
  /** Bind (or probe) port 0 and resolve with the port the OS assigned. */
  bind(): Promise<number>;
  /** Release the binding from the last `bind`, so `bind` can run again. */
  unbind(): Promise<void>;
}

/** Calls `bind` until it gives a port `fetch` accepts, `unbind`ing each that
 *  it does not; rejects after `maxAttempts` (default 10). `isBlocked`
 *  (default `isFetchBadPort`) is for tests. */
export declare function bindFetchablePort(
  binder: PortBinder,
  maxAttempts?: number,
  isBlocked?: (port: number) => boolean,
): Promise<number>;

export interface ListenFetchableOptions {
  /** Replaces the bad-port check, for tests only: the OS cannot be made to
   *  hand out a bad port, so a test marks a real one as blocked. */
  isBlocked?: (port: number) => boolean;
}

/** `server.listen(0, host)` until the port is one `fetch` accepts; resolves
 *  with it. Omit `host` to listen on every interface. */
export declare function listenFetchable(
  server: Server,
  host?: string,
  options?: ListenFetchableOptions,
): Promise<number>;

/** A port nothing listens on right now that `fetch` accepts, for handing to
 *  another process. Races like any closed port; prefer `listenFetchable`. */
export declare function freeFetchablePort(host?: string): Promise<number>;
