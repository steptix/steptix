/**
 * The `## Config: viewport:` value, resolved (stories/per-test-viewport.md §1).
 *
 * ONE validator with ONE error message, deliberately (§3). The raw spec string
 * is what travels the wire — Steptix forwards whatever the file says, like it
 * does `baseUrl` — so the CLI and the server must refuse the same values with
 * the same words, or a test that runs from the terminal and a test that runs
 * from the editor disagree about what `390` means.
 *
 * Pure and browser-free on purpose: both call sites resolve BEFORE any browser
 * launches (§3, §6), which is the only way an invalid value can fail a run with
 * no side effects to clean up.
 */

/** A resolved page size in CSS pixels. Structurally the same shape as
 *  `BrowserConfig.fixedViewport` / `viewport` / `windowSize`. */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * The named sizes from §1. Phone/tablet/desktop sides of the breakpoints most
 * CSS frameworks ship with — the point of a preset is that an author writing
 * `viewport: mobile` does not have to pick, and that two tests written a month
 * apart mean the same thing by it.
 *
 * `desktop` is today's default spelled out (`DEFAULT_BROWSER_DIMENSIONS` is the
 * same 1440×900), so a test can say "I am the desktop half of this pair"
 * explicitly rather than by omission.
 */
export const VIEWPORT_PRESETS: Readonly<Record<string, ViewportSize>> = Object.freeze({
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
});

/** §1 bounds, inclusive. Below the floor no real device exists and Chromium
 *  starts clamping; above the ceiling the page is bigger than any screen and a
 *  headed run becomes unwatchable. Both ends are far outside anything a real
 *  breakpoint test needs, so they only ever catch a typo. */
export const MIN_VIEWPORT_DIMENSION = 100;
export const MAX_VIEWPORT_DIMENSION = 10_000;

/** `<width>x<height>`, ASCII `x` only. The multiplication sign `×` is NOT
 *  accepted even though the log line prints one: it is a character no keyboard
 *  types by accident, so admitting it would only ever mean a copy-paste of our
 *  own output, and `390×844` failing loudly is better than two spellings of the
 *  same key. Matched against the lower-cased value so `390X844` works (§1). */
const EXPLICIT_SPEC = /^(\d+)x(\d+)$/;

/**
 * The §1 refusal, verbatim, for anything unparseable.
 *
 * Always names the offending value and lists the accepted forms — the value is
 * the half an author needs to find the line, and the forms are the half they
 * need to fix it. Written as `'## Config: viewport: <raw>'` regardless of which
 * layer threw, because that IS where the author typed it: the wire field and
 * the tool argument both carry the file's text through unchanged (§3, §7).
 */
export function viewportSpecError(raw: string): string {
  return (
    `Invalid '## Config: viewport: ${raw}' — expected a preset ` +
    `(${Object.keys(VIEWPORT_PRESETS).join(' | ')}) or \`<width>x<height>\` ` +
    `(e.g. \`390x844\`).`
  );
}

/**
 * The same refusal with the bounds spelled out.
 *
 * A small deviation from §1, which asks for one message for every failure: for
 * `50x50` the base message alone is actively confusing, because `50x50` *is*
 * `<width>x<height>`. The base sentence is kept byte-identical and the range is
 * appended, so the story's requirement — name the value, list the accepted
 * forms — still holds and the author also learns why a well-formed value was
 * refused.
 */
export function viewportBoundsError(raw: string): string {
  return (
    `${viewportSpecError(raw)} Each dimension must be between ` +
    `${MIN_VIEWPORT_DIMENSION} and ${MAX_VIEWPORT_DIMENSION}.`
  );
}

/**
 * `viewport:` and `cdp:` in one file (§1).
 *
 * An error rather than a warning, at every layer: the whole test was authored
 * around a size, and the user's own running Chrome is a window we cannot resize
 * out from under them. Silently ignoring the key would leave the test passing
 * at the wrong size, which is the one outcome worse than refusing to start.
 */
export function viewportCdpConflictError(rawViewport: string, rawCdp: string): string {
  return (
    `'## Config: viewport: ${rawViewport}' cannot be combined with ` +
    `'## Config: cdp: ${rawCdp}' — a viewport cannot be imposed on a browser ` +
    `attached to over CDP, which the user started and sized themselves. ` +
    `Remove one of the two.`
  );
}

/**
 * Resolve a raw `viewport:` spec to a page size, or `undefined` when the key is
 * absent.
 *
 * Absent-means-undefined (rather than a separate presence check at each call
 * site) mirrors `parseCdpOptionsFromTestConfig`: one call, one line, and the
 * "no viewport" path stays byte-for-byte today's behaviour (§2). A key present
 * but blank is treated as absent for the same reason `cdp:` does — an empty
 * value is a half-written line, not a request for a 0×0 page.
 *
 * Interpolation has already happened by the time this runs: `$VAR` (Steptix)
 * and `${env.X}` (server/CLI) are resolved against the Config block before the
 * value reaches here, so validation always sees the string the run will use
 * (§1).
 *
 * @throws the §1 error, naming the offending value.
 */
export function resolveViewportSpec(raw: string | undefined): ViewportSize | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();

  const preset = VIEWPORT_PRESETS[lower];
  if (preset) return { ...preset };

  const match = EXPLICIT_SPEC.exec(lower);
  if (!match) throw new Error(viewportSpecError(trimmed));

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!inBounds(width) || !inBounds(height)) {
    throw new Error(viewportBoundsError(trimmed));
  }
  return { width, height };
}

function inBounds(value: number): boolean {
  return value >= MIN_VIEWPORT_DIMENSION && value <= MAX_VIEWPORT_DIMENSION;
}

/** `390×844` — the log spelling (§4). The `×` is display-only; the parser
 *  accepts ASCII `x` alone, see EXPLICIT_SPEC. */
export function formatViewport(size: ViewportSize): string {
  return `${size.width}×${size.height}`;
}

/**
 * The parenthetical in §4's launch line: `(mobile, from test config)`.
 *
 * The size alone is not enough for the line to do its job — "so the size in
 * effect is never a guess" means saying WHICH of the two possible authors
 * chose it, since a project-wide `browser.fixedViewport` (§8) and a test's own
 * `viewport:` produce identical dimensions and very different expectations.
 */
export function describeViewportSource(rawSpec: string | undefined): string {
  const trimmed = rawSpec?.trim();
  return trimmed ? `${trimmed}, from test config` : 'from project config';
}
