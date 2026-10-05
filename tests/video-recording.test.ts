/**
 * Real-Playwright tests for video recording (mirrors tests/read-pattern.test.ts:
 * a headless chromium over a static `setContent` DOM, no test-app server).
 *
 * Exercises `finalizeMainPageVideo` against a genuinely-recording context — we
 * build the context with `recordVideo: { dir }` directly (the same way
 * read-pattern builds a real page) rather than mocking, because Playwright only
 * writes a real .webm on context.close, and what is under test is the rename or
 * delete of that file once the close has finished writing it.
 *
 * Closing a recording context flushes the .webm through Playwright's ffmpeg,
 * and under a whole-suite run that close is the slow step (tens of seconds has
 * been measured), so this file gets a 60 s budget per test. Each test's video
 * dir is removed in `afterEach`, with retries: on Windows the just-closed
 * file can still be held for a moment.
 *
 *  - mode 'on'                  → finalize returns a stable-named path; file exists
 *  - no recordVideo (off)       → page.video() is null → finalize returns undefined
 *  - 'retain-on-failure' + pass → finalize returns undefined; videoDir holds no .webm
 *  - 'retain-on-failure' + fail → finalize returns a path; file exists
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finalizeMainPageVideo } from '../src/browser/manager.js';

describe('finalizeMainPageVideo — real recording context', { timeout: 60_000 }, () => {
  let browser: Browser;
  /** This test's recording dir, for `afterEach` to remove. */
  let created: string | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  afterEach(async () => {
    if (created) await fsp.rm(created, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    created = undefined;
  });

  // Fresh recording dir per test so .webm-count assertions don't cross-talk.
  async function freshVideoDir(): Promise<string> {
    created = await fsp.mkdtemp(path.join(os.tmpdir(), 'steptix-rec-'));
    return created;
  }

  /** Create a recording context + a page that did some painting, so Playwright
   *  has frames to write. Returns the context (caller drives close via finalize). */
  async function recordingPage(dir: string): Promise<BrowserContext> {
    const context = await browser.newContext({ recordVideo: { dir } });
    const page = await context.newPage();
    await page.setContent('<html><body><h1 id="t">recording</h1></body></html>');
    // A trivial interaction so a frame or two is captured before close.
    await page.locator('#t').click();
    return context;
  }

  function webmsIn(dir: string): string[] {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.webm'));
  }

  it("mode 'on' saves a stable-named .webm and returns its path", async () => {
    const videoDir = await freshVideoDir();
    const context = await recordingPage(videoDir);
    const page = context.pages()[0]!;

    const saved = await finalizeMainPageVideo({
      page,
      mode: 'on',
      passed: true,
      videoDir,
      stableBaseName: '2026-06-02_10-15-03-checkout',
      closeContext: () => context.close(),
    });

    expect(saved).toBeDefined();
    expect(path.basename(saved!)).toBe('2026-06-02_10-15-03-checkout.webm');
    expect(fs.existsSync(saved!)).toBe(true);
    // The hash-named original is renamed, not copied — videoDir holds exactly
    // the one stable-named file.
    expect(webmsIn(videoDir)).toEqual(['2026-06-02_10-15-03-checkout.webm']);
  });

  it('mode off (no recordVideo) → video() null → returns undefined, writes nothing', async () => {
    const videoDir = await freshVideoDir();
    // A non-recording context: page.video() is null.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<html><body>no recording</body></html>');

    const saved = await finalizeMainPageVideo({
      page,
      mode: 'off',
      passed: false,
      videoDir,
      stableBaseName: 'whatever',
      closeContext: () => context.close(),
    });

    expect(saved).toBeUndefined();
    expect(webmsIn(videoDir)).toEqual([]);
  });

  it("'retain-on-failure' on a PASS → deletes the .webm, returns undefined", async () => {
    const videoDir = await freshVideoDir();
    const context = await recordingPage(videoDir);
    const page = context.pages()[0]!;

    const saved = await finalizeMainPageVideo({
      page,
      mode: 'retain-on-failure',
      passed: true,
      videoDir,
      stableBaseName: 'passing-run',
      closeContext: () => context.close(),
    });

    expect(saved).toBeUndefined();
    // Neither the stable file nor the deleted original remains.
    expect(webmsIn(videoDir)).toEqual([]);
  });

  it("'retain-on-failure' on a FAIL → keeps the .webm, returns its path", async () => {
    const videoDir = await freshVideoDir();
    const context = await recordingPage(videoDir);
    const page = context.pages()[0]!;

    const saved = await finalizeMainPageVideo({
      page,
      mode: 'retain-on-failure',
      passed: false,
      videoDir,
      stableBaseName: 'failing-run',
      closeContext: () => context.close(),
    });

    expect(saved).toBeDefined();
    expect(path.basename(saved!)).toBe('failing-run.webm');
    expect(fs.existsSync(saved!)).toBe(true);
    expect(webmsIn(videoDir)).toEqual(['failing-run.webm']);
  });
});
