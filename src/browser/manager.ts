import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

// Apply stealth plugin to avoid bot detection
stealthChromium.use(StealthPlugin());

export interface TrackedPage {
  page: Page;
  label: string;
  openedAt: number;
}

export interface PageInfo {
  label: string;
  url: string;
  title: string;
  isActive: boolean;
}

export class PageTracker {
  private pages: TrackedPage[] = [];
  private activeIndex = 0;

  constructor(initialPage: Page) {
    this.pages.push({ page: initialPage, label: 'main', openedAt: Date.now() });
  }

  /** Register a newly opened page (called from context.on('page') handler). */
  addPage(page: Page): string {
    const label = `page:${this.pages.length + 1}`;
    this.pages.push({ page, label, openedAt: Date.now() });
    logger.info(`New page detected: ${label} (${page.url()})`);

    page.on('close', () => {
      const idx = this.pages.findIndex((p) => p.page === page);
      if (idx === -1) return;
      const closedLabel = this.pages[idx]!.label;
      const wasActive = this.activeIndex === idx;
      this.pages.splice(idx, 1);
      logger.info(`Page closed: ${closedLabel}`);
      if (wasActive) {
        // Active page was closed — fall back to main
        this.activeIndex = 0;
      } else if (this.activeIndex > idx) {
        // A page before the active one was removed — shift index down
        this.activeIndex--;
      }
    });

    return label;
  }

  /** Get the currently active page. */
  getActive(): Page {
    return this.pages[this.activeIndex]?.page ?? this.pages[0]!.page;
  }

  /**
   * Switch to a page by label, URL substring, or title substring.
   * Returns the page if found, or null if no match.
   */
  switchTo(identifier: string): Page | null {
    // 1. Exact label match
    const byLabel = this.pages.findIndex((p) => p.label === identifier);
    if (byLabel !== -1) {
      this.activeIndex = byLabel;
      return this.pages[byLabel]!.page;
    }

    // 2. URL substring match
    const byUrl = this.pages.findIndex((p) => p.page.url().includes(identifier));
    if (byUrl !== -1) {
      this.activeIndex = byUrl;
      return this.pages[byUrl]!.page;
    }

    // 3. Title substring match (synchronous — uses last known title)
    const byTitle = this.pages.findIndex((p) => {
      try { return p.page.url() !== 'about:blank'; } catch { return false; }
    });
    // Try title() which returns a promise — but we need a sync fallback.
    // For now, URL and label matching covers the primary use cases.
    // Title matching is attempted via a loop with try/catch on the page reference.
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i]!;
      try {
        // Playwright's page doesn't have a sync title accessor, but we can
        // check if the identifier looks like it could match common patterns
        if (p.page.url().toLowerCase().includes(identifier.toLowerCase())) {
          this.activeIndex = i;
          return p.page;
        }
      } catch { /* page may be closed */ }
    }

    return null;
  }

  /**
   * Switch to a page by label, URL substring, or title.
   * Async variant that also checks page titles.
   */
  async switchToAsync(identifier: string): Promise<Page | null> {
    // 1. Exact label match
    const byLabel = this.pages.findIndex((p) => p.label === identifier);
    if (byLabel !== -1) {
      this.activeIndex = byLabel;
      return this.pages[byLabel]!.page;
    }

    // 2. URL substring match (case-insensitive)
    const byUrl = this.pages.findIndex((p) =>
      p.page.url().toLowerCase().includes(identifier.toLowerCase()),
    );
    if (byUrl !== -1) {
      this.activeIndex = byUrl;
      return this.pages[byUrl]!.page;
    }

    // 3. Title substring match
    for (let i = 0; i < this.pages.length; i++) {
      try {
        const title = await this.pages[i]!.page.title();
        if (title.toLowerCase().includes(identifier.toLowerCase())) {
          this.activeIndex = i;
          return this.pages[i]!.page;
        }
      } catch { /* page may be closed */ }
    }

    return null;
  }

  /** Get metadata for all open pages. */
  getPageList(): PageInfo[] {
    return this.pages.map((p, i) => ({
      label: p.label,
      url: p.page.url(),
      title: '', // title requires async — populated by caller if needed
      isActive: i === this.activeIndex,
    }));
  }

  /** Async version of getPageList that includes page titles. */
  async getPageListWithTitles(): Promise<PageInfo[]> {
    const result: PageInfo[] = [];
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i]!;
      let title = '';
      try { title = await p.page.title(); } catch { /* closed */ }
      result.push({
        label: p.label,
        url: p.page.url(),
        title,
        isActive: i === this.activeIndex,
      });
    }
    return result;
  }

  /** Number of tracked pages. */
  get count(): number {
    return this.pages.length;
  }
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  pageTracker: PageTracker;
}

/**
 * Launch a Playwright browser and create a new page with the given configuration.
 * Chromium uses playwright-extra with stealth plugin to avoid bot detection.
 */
export async function launchBrowser(config: BrowserConfig): Promise<BrowserSession> {
  const browserType = config.browser;
  logger.info(
    `Launching ${browserType} browser (${config.headed ? 'headed' : 'headless'})`,
  );

  const { width, height } = config.viewport ?? { width: 1280, height: 720 };
  const launchOptions = {
    headless: !config.headed,
    slowMo: config.slowMo,
    args: [`--window-size=${width},${height}`],
  };

  let browser: Browser;
  switch (browserType) {
    case 'firefox':
      browser = await firefox.launch(launchOptions);
      break;
    case 'webkit':
      browser = await webkit.launch(launchOptions);
      break;
    case 'chromium':
    default:
      // Use stealth chromium to bypass bot detection
      browser = await stealthChromium.launch(launchOptions) as unknown as Browser;
  }

  const context = await browser.newContext({
    viewport: config.viewport,
    // Accept all permissions by default
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  const page = await context.newPage();
  const pageTracker = new PageTracker(page);

  // Auto-register new pages (popups, new tabs) as they open
  context.on('page', async (newPage) => {
    const label = pageTracker.addPage(newPage);
    try {
      await newPage.waitForLoadState('domcontentloaded');
      logger.info(`Page ${label} loaded: ${newPage.url()}`);
    } catch {
      logger.debug(`Page ${label} closed before load completed`);
    }
  });

  logger.debug(`Browser launched: ${browserType} ${browser.version()}`);

  return { browser, context, page, pageTracker };
}

/**
 * Close the browser session and release all resources.
 */
export async function closeBrowser(session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
    await session.browser.close();
    logger.debug('Browser session closed');
  } catch (err) {
    logger.warn(`Error closing browser: ${String(err)}`);
  }
}

/**
 * Get the currently active page from the page tracker.
 */
export function getActivePage(session: BrowserSession): Page {
  return session.pageTracker.getActive();
}
