/**
 * Naming why a navigation timed out (SPEC-web-survey-fixes.md §2.37).
 *
 * `page.goto` that never gets a response reports only "Timeout 30000ms
 * exceeded", which reads the same whether the site is down or the site is up
 * and something between Chromium and it stalls. Those want opposite fixes —
 * wait, or change how the browser connects — so on a timeout we ask the site
 * once from outside the browser and say which one it is.
 *
 * Measured on the-internet.herokuapp.com: curl and Firefox got a 200 in under
 * a second while Chromium and Edge hung on every attempt, and
 * `--disable-http2` made Chromium load it in five.
 */
import type { Page, Response } from 'playwright';

/** What asking the URL from outside the browser found. */
export type ProbeResult =
  | { ok: true; status: number; ms: number }
  | { ok: false; reason: string };

export type UrlProbe = (url: string) => Promise<ProbeResult>;

const PROBE_TIMEOUT_MS = 10_000;

/** GET the URL from Node, following redirects, with its own ceiling. */
export const fetchProbe: UrlProbe = async (url) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    // The body is not wanted, only that the server answered.
    await res.body?.cancel().catch(() => undefined);
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const name = (err as Error).name;
    const reason = name === 'TimeoutError' ? `no answer in ${PROBE_TIMEOUT_MS / 1000} s` : cause ?? (err as Error).message;
    return { ok: false, reason };
  }
};

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(err.message));
}

/**
 * The sentence to append to a navigation timeout, or null when there is
 * nothing to add (not a timeout, or not a URL Node can ask).
 */
export async function diagnoseNavigationTimeout(
  url: string,
  err: unknown,
  probe: UrlProbe = fetchProbe,
): Promise<string | null> {
  if (!isTimeout(err) || !/^https?:\/\//i.test(url)) return null;
  const found = await probe(url);
  if (found.ok) {
    return (
      `The site answers outside the browser (HTTP ${found.status} in ${found.ms} ms) but the browser got no page, ` +
      'so something between the browser and this site is stalling rather than the site being down. ' +
      'If it is HTTP/2, adding "launchArgs": ["--disable-http2"] under "browser" in steptix.config.json makes Chromium connect over HTTP/1.1.'
    );
  }
  return `The site does not answer outside the browser either (${found.reason}), so it is down or unreachable from this machine.`;
}

/**
 * `page.goto`, with a timeout's message extended by
 * {@link diagnoseNavigationTimeout}. Any other failure is rethrown untouched.
 */
export async function gotoWithDiagnosis(
  page: Page,
  url: string,
  options: Parameters<Page['goto']>[1],
  probe: UrlProbe = fetchProbe,
): Promise<Response | null> {
  try {
    return await page.goto(url, options);
  } catch (err) {
    const note = await diagnoseNavigationTimeout(url, err, probe);
    if (note && err instanceof Error) err.message = `${err.message.trimEnd()}\n${note}`;
    throw err;
  }
}
