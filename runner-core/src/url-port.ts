/**
 * The port a server URL means. Its own module, with no Node imports, so the
 * error catalogue can use it without pulling `node:fs` in behind it.
 */

/** The port `url` names, else its scheme's default (443 for https, 80
 *  otherwise). Throws what `new URL` throws for one that does not parse. */
export function serverUrlPort(url: string): number {
  const parsed = new URL(url);
  if (parsed.port !== '') return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}
