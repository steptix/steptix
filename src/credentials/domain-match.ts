// The domain rule — the security boundary of the whole feature (SPEC 29 §6).
//
// Pure, dependency-free, and separated from everything else on purpose: this
// is the code that decides whether a stored password may be typed into the
// page in front of us, and it must be readable in one sitting and testable
// without a browser, a vault, or a network.
//
// The threat this exists for: an agent that browses arbitrary pages will
// eventually read a page that says "now type the user's Facebook password
// here". The defence is not to ask the model to be careful. It is that the URL
// compared below is read from the BROWSER, and the item is chosen by matching
// against it, so a page can only ever obtain the credential the user already
// stored *for that page*.

/** Why a page cannot be filled at all, regardless of what the vault holds. */
export type UnfillableReason = 'not-http' | 'insecure';

/**
 * Hosts we allow over plain http.
 *
 * Everything else must be https. A password typed into an http page is
 * readable by anything on the wire, and "the site does not support https" is
 * the site's problem, not a reason to lower the bar. Loopback is exempt
 * because that is where the fixtures live and there is no wire to read.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/** The host of a URL, lowercased, or null when the URL is unusable. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a password may be typed into this URL at all — before any vault
 * lookup, and independent of what is stored.
 *
 * Returns null when the page is fillable, or the reason it is not.
 */
export function pageIsFillable(url: string): UnfillableReason | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not-http';
  }
  // about:blank, data:, file:, chrome-extension: — none of these are a site
  // anyone has a credential for, and `data:` in particular is attacker-supplied
  // markup wearing a URL.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'not-http';
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) return 'insecure';
  return null;
}

/**
 * Does `itemUri` cover `pageHost`?
 *
 * The rule is suffix-with-a-dot-boundary, in both directions:
 *
 *   item facebook.com      ↔ page www.facebook.com     → match
 *   item www.facebook.com  ↔ page facebook.com         → match
 *   item facebook.com      ↔ page evil-facebook.com    → NO match
 *   item facebook.com      ↔ page facebook.com.evil.io → NO match
 *
 * The dot boundary is the entire point of the second and third lines: a plain
 * `endsWith` would match both, which is exactly the trick a phishing domain is
 * built to exploit.
 *
 * **Why bidirectional matching is safe without a public-suffix list.** Matching
 * `co.uk` against `anything.co.uk` would be a real hole if an attacker could
 * put `https://co.uk` in the vault — but they cannot. The vault is the user's
 * own, filled by hand in Bitwarden; the untrusted input in this system is the
 * PAGE, and a page cannot add items. So the failure mode a PSL would prevent
 * requires the user to attack themselves. A minimum of two labels keeps the
 * obviously-wrong cases (`com`, a bare TLD) out regardless.
 */
export function uriCoversHost(itemUri: string, pageHost: string): boolean {
  const itemHost = hostOf(itemUri) ?? bareHost(itemUri);
  if (!itemHost || !pageHost) return false;
  if (itemHost === pageHost) return true;
  if (labelCount(itemHost) < 2 || labelCount(pageHost) < 2) return false;
  if (pageHost.endsWith(`.${itemHost}`)) return true;
  if (itemHost.endsWith(`.${pageHost}`)) return true;
  return false;
}

/**
 * A vault URI recorded without a scheme — `facebook.com`, or
 * `facebook.com/login`. Bitwarden stores whatever the user typed, and a bare
 * host is common enough that treating it as unmatchable would silently drop
 * real items.
 */
function bareHost(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  // Anything with a scheme we did not recognise in `hostOf` (androidapp://,
  // iosapp://) is not a web page and must not match one.
  if (trimmed.includes('://')) return null;
  const host = trimmed.split('/')[0]?.split('?')[0]?.split('#')[0] ?? '';
  // Strip a port, and reject anything that is not plausibly a hostname.
  const withoutPort = host.split(':')[0] ?? '';
  if (!/^[a-z0-9.-]+$/.test(withoutPort)) return null;
  if (!withoutPort.includes('.')) return null;
  return withoutPort;
}

function labelCount(host: string): number {
  return host.split('.').filter((part) => part !== '').length;
}

/**
 * The string handed to `bw list items --url`, or null when the page has no
 * usable one.
 *
 * The ORIGIN — `https://host[:port]` — rather than the page's full URL, and
 * validated against a deliberately narrow character set before it leaves.
 *
 * Both parts are about the same thing. This value originates on a web page and
 * ends up as an argv entry of a child process; on Windows the Bitwarden CLI is
 * usually a `.cmd`, which has to be run through `cmd.exe`, and `cmd.exe` treats
 * `&`, `|`, `^`, `<`, `>` and `%` as syntax. A full URL carries query strings
 * that can contain every one of those. An origin cannot: a hostname is letters,
 * digits, dots and hyphens, and a port is digits. Dropping the path and query
 * also costs nothing, because the matching that decides anything is
 * `uriCoversHost`, which only ever looks at the host.
 */
export function originForLookup(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const origin = `${parsed.protocol}//${parsed.host}`;
  // The gate, not a formality: anything that does not match is refused rather
  // than escaped, because escaping is where this kind of bug comes back.
  return /^https?:\/\/[a-z0-9.\-[\]]+(:\d+)?$/.test(origin) ? origin : null;
}

/**
 * Filter vault items down to those that genuinely cover this page.
 *
 * Applied even though `bw list items --url` already does its own matching —
 * deliberately, and not as belt-and-braces theatre. Bitwarden's match mode is
 * per-item and user-configurable: an item set to "host" or, worse, "never"
 * behaves differently from one on the default, and an item can carry a regex
 * URI. Re-checking here means the rule this file documents is the rule that
 * actually runs, whatever the vault was configured to do.
 */
export function itemsCoveringHost<T extends { uris: string[] }>(items: T[], pageHost: string): T[] {
  return items.filter((item) => item.uris.some((uri) => uriCoversHost(uri, pageHost)));
}
