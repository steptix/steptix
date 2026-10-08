/**
 * `browser.blockAds`: the domains a project stops its browser reaching
 * (docs/specs/SPEC-web-survey-fixes.md §2.51). The project supplies the list;
 * the framework holds none of its own.
 *
 * Each entry is a bare host name such as `doubleclick.net`, and blocks that
 * host and every subdomain of it. Nothing else is accepted, because the names
 * go into Chromium's `--host-resolver-rules` switch: a comma or a space there
 * would start a rule of the author's own making, and `MAP * 127.0.0.1` would
 * send every request on the page somewhere else.
 */

/** Letters, digits and hyphens, in dot-separated labels, no leading dot. */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/** Is `value` a host name `browser.blockAds` can hold? */
export function isBlockableHost(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && HOST_NAME.test(value);
}

/** Is `url` served by one of `hosts` or a subdomain of one? */
export function isBlockedHost(url: string, hosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => {
    const blocked = h.toLowerCase();
    return host === blocked || host.endsWith(`.${blocked}`);
  });
}

/**
 * The Chromium switch that makes every name in `hosts`, and its subdomains,
 * fail to resolve (SPEC-web-survey-fixes.md §2.30). Chromium's own resolver
 * refuses them, so no request is intercepted: routing every request through
 * Playwright, even one that blocks nothing, delayed the scripts on one survey
 * page enough to lose a race in its own start-up. Anything that is not a host
 * name is left out, so the switch only ever holds `MAP <host> ~NOTFOUND` rules.
 */
export function hostResolverRule(hosts: readonly string[]): string {
  return '--host-resolver-rules='
    + hosts.filter(isBlockableHost).flatMap((h) => [`MAP ${h} ~NOTFOUND`, `MAP *.${h} ~NOTFOUND`]).join(', ');
}
