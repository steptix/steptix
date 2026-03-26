import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import type { BrowserConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Launch a Playwright browser and create a new page with the given configuration.
 */
export async function launchBrowser(config: BrowserConfig): Promise<BrowserSession> {
  const browserType = config.browser;
  logger.info(
    `Launching ${browserType} browser (${config.headed ? 'headed' : 'headless'})`,
  );

  const launchOptions = {
    headless: !config.headed,
    slowMo: config.slowMo,
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
      browser = await chromium.launch(launchOptions);
  }

  const context = await browser.newContext({
    viewport: config.viewport,
    // Accept all permissions by default
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  const page = await context.newPage();

  logger.debug(`Browser launched: ${browserType} ${browser.version()}`);

  return { browser, context, page };
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
 * Get the currently active page (handles popups by returning the most recent page).
 */
export async function getActivePage(session: BrowserSession): Promise<Page> {
  const pages = session.context.pages();
  // Return the last opened page (handles popup windows)
  return pages[pages.length - 1] ?? session.page;
}
