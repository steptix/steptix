import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

// Apply stealth plugin to avoid bot detection. Gated per-run via
// BrowserConfig.stealth so sites incompatible with stealth's monkey-patching
// (e.g. Polymer 1 stacks) can opt out.
let stealthApplied = false;
function ensureStealth(): void {
  if (stealthApplied) return;
  stealthChromium.use(StealthPlugin());
  stealthApplied = true;
}

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
  /** Pages we should not track. CDP mode pre-populates this with tabs that
   *  existed in the user's Chrome before the test attached. */
  private ignored: Set<Page>;

  constructor(initialPage: Page, ignoredPages?: Set<Page>) {
    this.pages.push({ page: initialPage, label: 'main', openedAt: Date.now() });
    this.ignored = ignoredPages ?? new Set();
  }

  /**
   * Register a newly opened page. Returns the assigned label, or `null` when
   * the page is on the ignore list (CDP mode: pre-existing user tabs) and
   * should not be tracked or surfaced to the AI.
   */
  addPage(page: Page): string | null {
    if (this.ignored.has(page)) return null;
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

  /**
   * Close a page by label, URL substring, or title.
   * Cannot close the main page. Returns the new active page after closing,
   * or null if the page was not found or is the main page.
   */
  async closePage(identifier: string): Promise<{ closed: boolean; activePage: Page; error?: string }> {
    // Find the target page (reuse switchToAsync matching logic)
    let targetIdx = -1;

    // 1. Exact label match
    targetIdx = this.pages.findIndex((p) => p.label === identifier);

    // 2. URL substring match (case-insensitive)
    if (targetIdx === -1) {
      targetIdx = this.pages.findIndex((p) =>
        p.page.url().toLowerCase().includes(identifier.toLowerCase()),
      );
    }

    // 3. Title substring match
    if (targetIdx === -1) {
      for (let i = 0; i < this.pages.length; i++) {
        try {
          const title = await this.pages[i]!.page.title();
          if (title.toLowerCase().includes(identifier.toLowerCase())) {
            targetIdx = i;
            break;
          }
        } catch { /* page may be closed */ }
      }
    }

    if (targetIdx === -1) {
      return { closed: false, activePage: this.getActive(), error: `no page matching "${identifier}"` };
    }

    if (targetIdx === 0) {
      return { closed: false, activePage: this.getActive(), error: 'cannot close the main page' };
    }

    const targetPage = this.pages[targetIdx]!.page;
    try {
      await targetPage.close();
    } catch {
      // Page may already be closed — the 'close' event handler will clean up
    }

    // The 'close' event handler (registered in addPage) removes the page from
    // the array and adjusts activeIndex, so just return the new active page.
    return { closed: true, activePage: this.getActive() };
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
  /** True when the session was created via `connectOverCDP` rather than a
   *  fresh launch. Drives different teardown semantics (don't kill user's
   *  Chrome, only close the tab we opened). */
  cdp?: boolean;
  /** Set to true when CDP mode opened a new tab for the test. The teardown
   *  closes only this tab; if `cdpTab` selected an existing tab, this is
   *  false and the tab is left open. */
  cdpTabOpenedByUs?: boolean;
}

// ---------------------------------------------------------------------------
// CDP support
// ---------------------------------------------------------------------------

/** Parsed `cdpTab` selector. `invalid` carries a reason for clear errors. */
export type CdpTabSpec =
  | { kind: 'new' }
  | { kind: 'active' }
  | { kind: 'index'; index: number }
  | { kind: 'urlSubstring'; value: string }
  | { kind: 'titleSubstring'; value: string }
  | { kind: 'invalid'; reason: string };

/**
 * Parse the raw `cdpTab` string from a test's `## Config` section into a
 * structured selector. Pure / synchronous — unit-testable without a browser.
 */
export function parseCdpTabSpec(raw: string | undefined): CdpTabSpec {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { kind: 'new' };
  const lower = trimmed.toLowerCase();
  if (lower === 'new') return { kind: 'new' };
  if (lower === 'active') return { kind: 'active' };

  // Integer index
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n < 0) return { kind: 'invalid', reason: `cdpTab index must be >= 0, got ${trimmed}` };
    return { kind: 'index', index: n };
  }

  if (lower.startsWith('url~')) {
    const value = trimmed.slice(4).trim();
    if (!value) return { kind: 'invalid', reason: `cdpTab url~ requires a substring, got "${trimmed}"` };
    return { kind: 'urlSubstring', value };
  }

  if (lower.startsWith('title~')) {
    const value = trimmed.slice(6).trim();
    if (!value) return { kind: 'invalid', reason: `cdpTab title~ requires a substring, got "${trimmed}"` };
    return { kind: 'titleSubstring', value };
  }

  return {
    kind: 'invalid',
    reason: `cdpTab "${trimmed}" is not recognised — expected: new, active, <integer>, url~<substr>, or title~<substr>`,
  };
}

/**
 * Resolve a `CdpTabSpec` against a list of pages to a specific Page (or null
 * for `new`, meaning the caller should open a fresh tab). Throws with a clear
 * error listing open tabs when nothing matches.
 */
export async function resolveCdpTab(
  pages: ReadonlyArray<Page>,
  spec: CdpTabSpec,
): Promise<Page | null> {
  if (spec.kind === 'invalid') throw new Error(spec.reason);
  if (spec.kind === 'new') return null;

  if (spec.kind === 'index') {
    const p = pages[spec.index];
    if (!p) {
      throw new Error(
        `CDP: no tab at index ${spec.index}. ${await formatTabList(pages)}`,
      );
    }
    return p;
  }

  if (spec.kind === 'urlSubstring') {
    const needle = spec.value.toLowerCase();
    const match = pages.find((p) => p.url().toLowerCase().includes(needle));
    if (!match) {
      throw new Error(
        `CDP: no tab matches url substring "${spec.value}". ${await formatTabList(pages)}`,
      );
    }
    return match;
  }

  if (spec.kind === 'titleSubstring') {
    const needle = spec.value.toLowerCase();
    for (const p of pages) {
      let title = '';
      try { title = await p.title(); } catch { /* tab may have closed */ }
      if (title.toLowerCase().includes(needle)) return p;
    }
    throw new Error(
      `CDP: no tab matches title substring "${spec.value}". ${await formatTabList(pages)}`,
    );
  }

  // 'active' — best effort: pick the first non-DevTools page. Real
  // most-recently-focused detection requires CDP Target.getTargets, which we
  // can wire later via CDPSession.send. For now this is good enough for the
  // common case of a single user-facing tab.
  if (spec.kind === 'active') {
    const candidate = pages.find((p) => !p.url().startsWith('devtools://'));
    if (!candidate) {
      throw new Error(`CDP: no active tab found. ${await formatTabList(pages)}`);
    }
    return candidate;
  }

  // Exhaustiveness — TypeScript should make this unreachable.
  throw new Error(`CDP: unhandled tab spec`);
}

async function formatTabList(pages: ReadonlyArray<Page>): Promise<string> {
  if (pages.length === 0) return 'No tabs are open.';
  const lines: string[] = [`Open tabs (${pages.length}):`];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    let title = '';
    try { title = await p.title(); } catch { /* ignore */ }
    lines.push(`  [${i}] ${p.url()}${title ? `  (${title})` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Verify Chrome is reachable on the given CDP port before attempting to
 * connect. Throws an actionable error telling the user how to start Chrome
 * if it isn't. The optional `fetchFn` parameter exists for unit testing.
 */
export async function preflightCdpPort(
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = `http://localhost:${port}/json/version`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await fetchFn(url, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(
        `Cannot connect to Chrome on port ${port}: HTTP ${res.status} from ${url}. ` +
        `Is Chrome running with --remote-debugging-port=${port}?`,
      );
    }
  } catch (err) {
    // Re-throw our own errors as-is; wrap network errors.
    if (err instanceof Error && err.message.startsWith('Cannot connect to Chrome')) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot connect to Chrome on port ${port}. Start Chrome with:\n` +
      `  chrome --remote-debugging-port=${port} --user-data-dir=<some-dir>\n` +
      `and try again. (underlying: ${detail})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface CdpLaunchOptions {
  /** Port Chrome was started with (`--remote-debugging-port=<port>`). */
  port: number;
  /** Raw `cdpTab` string from the test config (parsed internally). */
  tab?: string | undefined;
}

/**
 * Launch a Playwright browser and create a new page with the given configuration.
 * When `cdp` is provided, attaches to a running Chrome over CDP instead of
 * launching a fresh browser. Chromium (non-CDP) uses playwright-extra with
 * stealth plugin to avoid bot detection.
 */
export async function launchBrowser(
  config: BrowserConfig,
  cdp?: CdpLaunchOptions,
): Promise<BrowserSession> {
  if (cdp) {
    return connectOverCdpSession(config, cdp);
  }

  const browserType = config.browser;
  logger.info(
    `Launching ${browserType} browser (${config.headed ? 'headed' : 'headless'})`,
  );

  const { width, height } = config.headed ? config.windowSize : config.viewport;
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
    default: {
      // Prefer the installed Google Chrome ("chrome" channel) over bundled
      // Chromium — bundled Chromium has a fingerprintable codec/component list
      // that sites like Akamai/Imperva flag as automation.
      const chromeOpts = { ...launchOptions, channel: 'chrome' };
      if (config.stealth !== false) {
        ensureStealth();
        browser = await stealthChromium.launch(chromeOpts) as unknown as Browser;
      } else {
        browser = await chromium.launch(chromeOpts);
      }
    }
  }

  const context = await browser.newContext({
    viewport: config.headed ? null : config.viewport,
    // Accept all permissions by default
    permissions: ['clipboard-read', 'clipboard-write'],
    // Do not override userAgent — on the `chrome` channel, the real Chrome UA
    // is already realistic, and hardcoding a mismatched version trips
    // user-agent sniffing on some banking sites (Polymer/browserDetection.js).
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    extraHTTPHeaders: {
      'Accept-Language': 'en-AU,en;q=0.9',
    },
    bypassCSP: config.bypassCSP === true,
  });

  const page = await context.newPage();
  const pageTracker = new PageTracker(page);

  // Auto-register new pages (popups, new tabs) as they open
  context.on('page', async (newPage) => {
    const label = pageTracker.addPage(newPage);
    if (label === null) return; // ignored (CDP pre-existing tab — shouldn't happen here)
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
 * Connect to a running Chrome over CDP and produce a BrowserSession. The
 * `config` is mostly advisory in this mode — see "Limitations" in the
 * cdp-connection story for what is and isn't honoured.
 */
async function connectOverCdpSession(
  config: BrowserConfig,
  cdp: CdpLaunchOptions,
): Promise<BrowserSession> {
  // Warn loudly about config that won't apply, so the user isn't left wondering
  // why their viewport / stealth / bypassCSP setting did nothing.
  warnOnIncompatibleConfigForCdp(config);

  const tabSpec = parseCdpTabSpec(cdp.tab);
  if (tabSpec.kind === 'invalid') {
    throw new Error(tabSpec.reason);
  }

  await preflightCdpPort(cdp.port);

  logger.info(`Connecting to Chrome over CDP on port ${cdp.port}`);
  const browser = await chromium.connectOverCDP(`http://localhost:${cdp.port}`);

  // The default context exposes the user's profile (cookies, extensions, etc.)
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(
      `CDP: connected to Chrome on port ${cdp.port} but it has no contexts. ` +
      `This is unexpected — try restarting Chrome.`,
    );
  }

  const preExistingPages = new Set<Page>(context.pages());
  let page: Page;
  let openedByUs = false;

  if (tabSpec.kind === 'new') {
    page = await context.newPage();
    openedByUs = true;
    logger.info(`CDP: opened new tab`);
  } else {
    const existing = context.pages();
    const resolved = await resolveCdpTab(existing, tabSpec);
    if (!resolved) {
      // Should be impossible — non-`new` specs return a Page or throw.
      throw new Error(`CDP: tab resolution returned null for spec ${tabSpec.kind}`);
    }
    page = resolved;
    // Don't ignore the resolved tab — it's our main page. Anything else
    // pre-existing should be ignored.
    preExistingPages.delete(page);
    logger.info(`CDP: attached to existing tab (${page.url()})`);
  }

  const pageTracker = new PageTracker(page, preExistingPages);

  context.on('page', async (newPage) => {
    const label = pageTracker.addPage(newPage);
    if (label === null) return;
    try {
      await newPage.waitForLoadState('domcontentloaded');
      logger.info(`Page ${label} loaded: ${newPage.url()}`);
    } catch {
      logger.debug(`Page ${label} closed before load completed`);
    }
  });

  logger.debug(`CDP browser version: ${browser.version()}`);

  return {
    browser,
    context,
    page,
    pageTracker,
    cdp: true,
    cdpTabOpenedByUs: openedByUs,
  };
}

function warnOnIncompatibleConfigForCdp(config: BrowserConfig): void {
  const ignored: string[] = [];
  if (config.headed === false) ignored.push('headed=false (headless)');
  if (config.stealth === true) ignored.push('stealth=true');
  if (config.bypassCSP === true) ignored.push('bypassCSP=true');
  if (config.slowMo && config.slowMo > 0) ignored.push(`slowMo=${config.slowMo}`);
  if (ignored.length > 0) {
    logger.warn(
      `CDP mode ignores these browser config values (the user's running Chrome ` +
      `controls them): ${ignored.join(', ')}`,
    );
  }
}

/**
 * Close the browser session and release all resources. In CDP mode this only
 * closes the tab the harness opened (if any) and severs the WebSocket — it
 * does not kill the user's Chrome process.
 */
export async function closeBrowser(session: BrowserSession): Promise<void> {
  try {
    if (session.cdp) {
      if (session.cdpTabOpenedByUs) {
        try { await session.page.close(); } catch { /* tab may already be gone */ }
      }
      // Severs the CDP WebSocket without killing the user's Chrome.
      await session.browser.close().catch(() => {});
      logger.debug('CDP browser session detached');
      return;
    }
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
