/**
 * The pattern scripts/check-listen-fetchable.mjs looks for. The check itself
 * reads the whole repo, so it runs from `npm run lint` and its own CI step,
 * not here; this only pins what it counts as a bare port-0 bind.
 */
import { describe, expect, it } from 'vitest';
import { BARE_LISTEN, isCommentLine } from '../scripts/check-listen-fetchable.mjs';

describe('check-listen-fetchable', () => {
  it('catches each spelling of a bind to an OS-picked port', () => {
    for (const line of [
      "server.listen(0, '127.0.0.1', () => resolve());",
      'srv.listen(0)',
      'this.server!.listen( 0 , host, cb)',
      'server.listen();',
      'server.listen({ host: "127.0.0.1", port: 0 })',
    ]) {
      expect(BARE_LISTEN.test(line), line).toBe(true);
    }
  });

  it('leaves alone a bind that names its port', () => {
    for (const line of [
      "await listenFetchable(server, '127.0.0.1');",
      'server.listen(port, host)',
      'server.listen(PORT, () => {})',
      'server.listen(3000)',
      'server.listen({ port: 8787 })',
      'server.listen(10080, "127.0.0.1")',
    ]) {
      expect(BARE_LISTEN.test(line), line).toBe(false);
    }
  });

  it('skips comments that explain the pattern, not code that uses it', () => {
    expect(isCommentLine('  // never server.listen(0) here')).toBe(true);
    expect(isCommentLine(' * `listen(0)` SUCCEEDS — the OS grants a port')).toBe(true);
    expect(isCommentLine('/* listen(0) */')).toBe(true);
    expect(isCommentLine("  server.listen(0, '127.0.0.1'); // bare")).toBe(false);
  });
});
