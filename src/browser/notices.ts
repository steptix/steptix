/**
 * Notifications that close by themselves kept long enough to be checked
 * (docs/specs/SPEC-web-survey-fixes.md §2.33, §2.50).
 *
 * One model turn takes several seconds, and a notification in the web survey
 * closed after six: "Verify a message confirms the Ajax checkbox was checked"
 * read the page after the message had gone, and failed a step whose click had
 * worked. A person glancing at the screen would have seen it. So the page
 * records the text of every notification as it appears, the snapshot lists
 * the ones that have since closed, and assertion code can read the list.
 *
 * A notification is what the page itself declares to be one, in the terms
 * WAI-ARIA gives every page for "announce this to the user": a live region.
 * That is `role="alert"`, `role="status"` or `role="log"`, an `aria-live`
 * other than "off", or an `<output>` element, whose implicit role is status.
 * Class names are not read: each library names its own, and a list of them
 * only suits the sites it was taken from. A page that shows a message without
 * marking it does not announce it to a screen reader either; a test can still
 * check such a message while it is on screen.
 *
 * Read-only: an observer and an array, nothing on the page is changed.
 */
import type { BrowserContext, Page } from 'playwright';

/** How long a closed notification stays worth mentioning. */
export const NOTICE_MEMORY_MS = 60_000;

/**
 * Installs `window.__steptixNotices`: up to 20 `{ text, at }` records, newest
 * last, each holding a WeakRef to its element so a reader can tell whether it
 * is still on screen.
 */
export const NOTICE_RECORDER_SCRIPT = `(() => {
  if (window.__steptixNotices) return;
  var list = [];
  Object.defineProperty(window, '__steptixNotices', { value: list });
  // WAI-ARIA live regions: the roles that are live by definition, an explicit
  // aria-live, and <output> (implicit role status). No class names.
  var SEL = '[role~="alert"],[role~="status"],[role~="log"],'
    + '[aria-live]:not([aria-live="off" i]),output';
  function record(el) {
    var text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 300) return;
    for (var i = list.length - 1; i >= 0 && i >= list.length - 5; i--) {
      if (list[i].text === text && Date.now() - list[i].at < 3000) return;
    }
    list.push({ text: text, at: Date.now(), ref: typeof WeakRef === 'function' ? new WeakRef(el) : null });
    if (list.length > 20) list.shift();
  }
  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches(SEL)) record(node);
    if (node.querySelectorAll) node.querySelectorAll(SEL).forEach(record);
  }
  new MutationObserver(function (muts) {
    for (var m = 0; m < muts.length; m++) {
      var mut = muts[m];
      for (var a = 0; a < mut.addedNodes.length; a++) scan(mut.addedNodes[a]);
      var t = mut.target && mut.target.nodeType === 1 ? mut.target : mut.target && mut.target.parentElement;
      var host = t && t.closest ? t.closest(SEL) : null;
      if (host) record(host);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
})();`;

/** Record notifications in every page of `context`, current and future. */
export async function installNoticeRecorder(context: BrowserContext): Promise<void> {
  try {
    await context.addInitScript(NOTICE_RECORDER_SCRIPT);
    for (const page of context.pages()) {
      await page.evaluate(NOTICE_RECORDER_SCRIPT).catch(() => {});
    }
  } catch {
    // Best effort: without it, a closed notification is simply not mentioned.
  }
}

/**
 * The notifications recorded in the last {@link NOTICE_MEMORY_MS} that are no
 * longer on screen, as `{ text, ageSeconds }`, oldest first. Ones still shown
 * are in the snapshot already. Empty when nothing was recorded or the page
 * cannot be read.
 */
export async function closedNotices(page: Page): Promise<Array<{ text: string; ageSeconds: number }>> {
  try {
    const found: unknown = await page.evaluate((memoryMs: number) => {
      const g = globalThis as any;
      const list: any[] = g.__steptixNotices ?? [];
      const now = Date.now();
      return list
        .filter((n) => now - n.at < memoryMs)
        .filter((n) => {
          const el = n.ref && typeof n.ref.deref === 'function' ? n.ref.deref() : null;
          if (!el || !el.isConnected) return true;
          const shown = typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null;
          if (!shown) return true;
          // Still shown, but saying something else now: the old text closed.
          return !String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').includes(n.text);
        })
        .map((n) => ({ text: String(n.text), ageSeconds: Math.round((now - n.at) / 1000) }));
    }, NOTICE_MEMORY_MS);
    return Array.isArray(found) ? (found as Array<{ text: string; ageSeconds: number }>) : [];
  } catch {
    return [];
  }
}

/** The snapshot comment listing closed notifications, or '' when there are none. */
export async function noticeNote(page: Page): Promise<string> {
  const closed = await closedNotices(page);
  if (closed.length === 0) return '';
  const lines = closed.map((n) => `- "${n.text.replace(/-->/g, '--&gt;')}" (${n.ageSeconds} s ago)`);
  return '\n<!-- Notifications that appeared and have since closed (alerts and status messages). Each is also '
    + 'readable in the page as window.__steptixNotices (text, at). A check about a message that '
    + 'may already have gone can read it there.\n'
    + `${lines.join('\n')}\n-->`;
}
