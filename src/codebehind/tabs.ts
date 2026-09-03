import type { Page } from 'playwright';
import type { BrowserSession, PageTracker, BrowserTracker, LaunchOverrides } from '../browser/manager.js';
import { logger } from '../utils/logger.js';
import type {
  CodeBehindBrowserApi,
  CodeBehindBrowserInfo,
  CodeBehindTabApi,
  CodeBehindTabInfo,
} from './types.js';

/**
 * Tab and browser control for code-behind entries
 * (stories/codebehind-framework-actions.md).
 *
 * Six AI actions — `openPage`, `switchPage`, `closePage`, `openBrowser`,
 * `switchBrowser`, `closeBrowser` — used to be the reason a step could never
 * be compiled: a `run(ctx)` body had the live page but no way to say "the
 * active page is that one now". These are that way.
 *
 * Every method here routes to the SAME tracker method the corresponding AI
 * action routes to. One implementation of "switch the active page", not two:
 * the AI path and the compiled path have to agree about which tab the next
 * step runs in, and two copies would only have to disagree once.
 */

/** How long `openedBy` waits for the page the trigger opens. */
const DEFAULT_OPENED_BY_TIMEOUT_MS = 15_000;
/** Matches the AI `openPage` handler's own navigation budget. */
const OPEN_NAVIGATION_TIMEOUT_MS = 30_000;
/** How long to wait for `context.on('page')` to register a tab we just made. */
const TRACKING_REGISTRATION_TIMEOUT_MS = 2_000;

/**
 * What a tab or browser call needs from the run around it.
 *
 * `focus` is the step executor's `showTab`: the AI path raises the tab it
 * switches to, so a headed run stays watchable, and a compiled step that
 * skipped it would drive an invisible tab while the wrong one sat on screen.
 */
export interface CodeBehindTrackerHooks {
  focus?: ((page: Page) => Promise<void>) | undefined;
}

/** Launch a browser session the way the run itself would — a closure over the
 *  run's `BrowserConfig`, so an entry cannot pick a different one. */
export type CodeBehindLauncher = (overrides: LaunchOverrides) => Promise<BrowserSession>;

/**
 * Thrown when an entry reaches for tab or browser control on a run that has
 * none. A real throw, never a silent no-op: broken code heals to AI and is
 * flagged stale, which is the honest outcome, whereas a `switchTo` that did
 * nothing would leave every following step on the wrong tab and green.
 */
export class CodeBehindTrackerUnavailableError extends Error {
  constructor(what: 'page' | 'browser', method: string) {
    super(
      `${method} is not available in this run: ${what} tracking is not enabled. ` +
        `The step will fall through to AI.`,
    );
    this.name = 'CodeBehindTrackerUnavailableError';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tabs
// ───────────────────────────────────────────────────────────────────────────

/** Tab control over a live `PageTracker`. */
export function makeTabApi(tracker: PageTracker, hooks: CodeBehindTrackerHooks = {}): CodeBehindTabApi {
  /**
   * The tracker's label for this exact `Page`, once `context.on('page')` has
   * registered it.
   *
   * By identity, never by URL. The AI `openPage` handler switches with
   * `switchToAsync(newPage.url())`, which is a URL SUBSTRING match — with two
   * tabs on one URL (a "open this report twice" test, or any `about:blank`
   * moment) it can promote the wrong one, and the caller cannot tell because
   * a `Page` did come back. Registration is event-driven, so the entry can
   * lag `newPage()` resolving by a tick; this polls briefly rather than
   * assuming either order.
   */
  const labelOf = async (page: Page): Promise<string> => {
    const deadline = Date.now() + TRACKING_REGISTRATION_TIMEOUT_MS;
    for (;;) {
      const entry = tracker.tabs().find((t) => t.page === page);
      if (entry) return entry.label;
      if (Date.now() >= deadline) {
        throw new Error(
          'the tab was opened but never registered with the run — on a CDP browser this ' +
            'means it is on the ignore list (a tab that existed before the test attached)',
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  /** Promote `page` to active by its own label, raise it on screen, return it. */
  const promote = async (page: Page): Promise<Page> => {
    const active = await tracker.switchToAsync(await labelOf(page));
    if (active !== page) {
      // Only reachable if the label moved between the two calls; the honest
      // answer is the tracker's, since that is what the next step reads.
      logger.debug('Code-behind tab promote resolved a different page than it opened');
    }
    await focus(active ?? page);
    return active ?? page;
  };

  const focus = async (page: Page): Promise<void> => {
    if (!hooks.focus) return;
    try {
      await hooks.focus(page);
    } catch {
      /* raising a tab is cosmetic — never fail a step for it */
    }
  };

  return {
    async open(url, options) {
      if (!url) throw new Error('tabs.open needs a URL');
      const page = await tracker.getActive().context().newPage();
      // Our own `newPage()` and another session's are indistinguishable from
      // the `context.on('page')` handler's side, so the tracker is told
      // explicitly that this tab is accounted for.
      tracker.markExpected(page);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: OPEN_NAVIGATION_TIMEOUT_MS });
        // `relabelPage` throws on an untracked page, and registration is
        // event-driven — wait for it the same way `promote` does.
        if (options?.as) {
          await labelOf(page);
          tracker.relabelPage(page, options.as);
        }
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
      logger.info(`Code-behind opened a tab → ${page.url()}${options?.as ? ` (as "${options.as}")` : ''}`);
      return promote(page);
    },

    async openedBy(trigger, options) {
      const context = tracker.getActive().context();
      // Armed BEFORE the trigger runs. A `waitForEvent` started afterwards
      // can miss a popup that opened synchronously on the click.
      const pending = context.waitForEvent('page', {
        timeout: options?.timeoutMs ?? DEFAULT_OPENED_BY_TIMEOUT_MS,
      });
      let page: Page;
      try {
        const [opened] = await Promise.all([pending, Promise.resolve(trigger())]);
        page = opened;
      } catch (err) {
        throw new Error(
          `tabs.openedBy: no new tab appeared within ` +
            `${options?.timeoutMs ?? DEFAULT_OPENED_BY_TIMEOUT_MS}ms — ${(err as Error).message}`,
        );
      }
      tracker.markExpected(page);
      // A popup is often still about:blank when the event fires; the label
      // and any later URL match need the real one.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (options?.as) {
        await labelOf(page);
        tracker.relabelPage(page, options.as);
      }
      logger.info(`Code-behind adopted a tab the page opened → ${page.url()}`);
      return promote(page);
    },

    async switchTo(identifier) {
      const page = await tracker.switchToAsync(identifier);
      if (!page) {
        throw new Error(
          `tabs.switchTo: no tab matching ${JSON.stringify(identifier)} — open tabs: ` +
            `${tracker.getPageList().map((p) => `${p.label} (${p.url})`).join(', ')}`,
        );
      }
      await focus(page);
      return page;
    },

    async close(identifier) {
      const result = await tracker.closePage(identifier);
      if (!result.closed) throw new Error(`tabs.close: ${result.error}`);
      await focus(result.activePage);
      return result.activePage;
    },

    list(): CodeBehindTabInfo[] {
      return tracker.getPageList().map((p) => ({
        label: p.label,
        url: p.url,
        isActive: p.isActive,
      }));
    },

    active() {
      return tracker.getActive();
    },
  };
}

/** The tab API for a run with no `PageTracker` — every method throws.
 *  The async members REJECT rather than throwing synchronously, so they fail
 *  the way the real ones do however the entry calls them (`await`, `.catch`,
 *  inside a `Promise.all`). */
export function unavailableTabApi(): CodeBehindTabApi {
  const fail = (method: string): never => {
    throw new CodeBehindTrackerUnavailableError('page', `tabs.${method}`);
  };
  return {
    open: async () => fail('open'),
    openedBy: async () => fail('openedBy'),
    switchTo: async () => fail('switchTo'),
    close: async () => fail('close'),
    list: () => fail('list'),
    active: () => fail('active'),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Browsers
// ───────────────────────────────────────────────────────────────────────────

/** Browser control over a live `BrowserTracker`. */
export function makeBrowserApi(
  tracker: BrowserTracker,
  launch: CodeBehindLauncher,
  hooks: CodeBehindTrackerHooks = {},
): CodeBehindBrowserApi {
  const focus = async (page: Page): Promise<void> => {
    if (!hooks.focus) return;
    try {
      await hooks.focus(page);
    } catch {
      /* cosmetic */
    }
  };

  return {
    async open(label, options) {
      if (!label) throw new Error('browsers.open needs a label');
      if (tracker.has(label)) throw new Error(`browsers.open: label "${label}" is already in use`);
      const overrides: LaunchOverrides = {};
      if (options?.engine) overrides.engine = options.engine;
      if (options?.channel) overrides.channel = options.channel;
      if (options?.headed !== undefined) overrides.headed = options.headed;
      // No `videoDir`, matching the `openBrowser` action: tier-1 video records
      // the main page only, and a secondary context would write stray .webm
      // files the report never links.
      const session = await launch(overrides);
      // `add` auto-promotes to active, which is the `openBrowser` precedent —
      // an author writing "open a second browser and sign in" should not need
      // a switch step in between.
      tracker.add(label, session);
      const page = tracker.getActivePage();
      logger.info(`Code-behind opened browser "${label}" — auto-switched to active`);
      await focus(page);
      return page;
    },

    async switchTo(label) {
      tracker.switchTo(label);
      const page = tracker.getActivePage();
      await focus(page);
      return page;
    },

    async close(label) {
      await tracker.close(label);
    },

    list(): CodeBehindBrowserInfo[] {
      return tracker.list().map((b) => ({
        label: b.label,
        engine: b.engine,
        channel: b.channel,
        activePageUrl: b.activePageUrl,
        isActive: b.isActive,
      }));
    },

    activeLabel() {
      return tracker.getActiveLabel();
    },
  };
}

/** The browser API for a run with no `BrowserTracker` — every method throws.
 *  Async members reject, for the same reason `unavailableTabApi`'s do. */
export function unavailableBrowserApi(): CodeBehindBrowserApi {
  const fail = (method: string): never => {
    throw new CodeBehindTrackerUnavailableError('browser', `browsers.${method}`);
  };
  return {
    open: async () => fail('open'),
    switchTo: async () => fail('switchTo'),
    close: async () => fail('close'),
    list: () => fail('list'),
    activeLabel: () => fail('activeLabel'),
  };
}
