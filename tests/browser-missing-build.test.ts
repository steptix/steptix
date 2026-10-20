/**
 * A launch that fails because Playwright's build of the engine is missing
 * names `steptix browsers install <engine>`, not Playwright's
 * `npx playwright install` (issue #109).
 *
 * The end-to-end cases run real Playwright in a child process with
 * PLAYWRIGHT_BROWSERS_PATH pointed at an empty temp folder. A child, because
 * Playwright reads that variable once, when its registry module loads, so
 * setting it in this process would depend on whether some earlier test had
 * already loaded Playwright. The child's environment is its own, so this
 * process's is never changed. Playwright checks for the executable before it
 * starts anything, so no browser is ever launched or downloaded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { explainMissingBuild } from '../src/browser/missing-build.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('explainMissingBuild', () => {
  // Constructed: the shape of Playwright 1.59's message (registry/index.js),
  // shortened.
  const playwrightError = new Error(
    "browserType.launch: Executable doesn't exist at /browsers/firefox-1511/firefox/firefox\n" +
      '╔═══════════════════════════════════╗\n' +
      '║ Please run the following command: ║\n' +
      '║     npx playwright install        ║\n' +
      '╚═══════════════════════════════════╝',
  );

  it('names the steptix command and the engine', () => {
    const explained = explainMissingBuild(playwrightError, 'firefox');
    expect(explained?.message).toBe(
      'Steptix needs a Firefox build that is not downloaded yet. Run: steptix browsers install firefox\n' +
        "(Playwright: Executable doesn't exist at /browsers/firefox-1511/firefox/firefox)",
    );
  });

  it("keeps Playwright's error as the cause", () => {
    expect(explainMissingBuild(playwrightError, 'webkit')?.cause).toBe(playwrightError);
  });

  it.each([
    ['chromium', 'Chromium'],
    ['firefox', 'Firefox'],
    ['webkit', 'WebKit'],
  ] as const)('names %s as %s', (engine, name) => {
    expect(explainMissingBuild(playwrightError, engine)?.message).toContain(
      `Steptix needs a ${name} build that is not downloaded yet. Run: steptix browsers install ${engine}`,
    );
  });

  it('leaves any other launch failure alone', () => {
    expect(explainMissingBuild(new Error('browserType.launch: Target page, context or browser has been closed'), 'firefox')).toBeNull();
    expect(explainMissingBuild('a thrown string', 'firefox')).toBeNull();
  });
});

describe('launchBrowser with no downloaded build', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-missing-build-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Launch `engine` from the built `dist/` in a child with an empty browsers folder. */
  function launchInChild(engine: string): { message: string; cause: string } {
    const browsers = path.join(tmp, 'browsers');
    fs.mkdirSync(browsers);
    const manager = pathToFileURL(path.join(REPO_ROOT, 'dist', 'browser', 'manager.js')).href;
    const defaults = pathToFileURL(path.join(REPO_ROOT, 'dist', 'config', 'defaults.js')).href;
    const script = `
      const { launchBrowser } = await import(${JSON.stringify(manager)});
      const { DEFAULT_CONFIG } = await import(${JSON.stringify(defaults)});
      let out;
      try {
        await launchBrowser({ ...DEFAULT_CONFIG.browser, browser: ${JSON.stringify(engine)}, headed: false });
        out = { message: 'launched', cause: '' };
      } catch (err) {
        out = { message: err.message, cause: err.cause instanceof Error ? err.cause.message : '' };
      }
      process.stderr.write('RESULT ' + JSON.stringify(out) + '\\n');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmp,
      env: {
        ...process.env,
        LOCALAPPDATA: tmp,
        XDG_CONFIG_HOME: tmp,
        PLAYWRIGHT_BROWSERS_PATH: browsers,
      },
      encoding: 'utf8',
      windowsHide: true,
    });
    const line = result.stderr.split('\n').find((l) => l.startsWith('RESULT '));
    if (!line) throw new Error(`child printed no result (status ${result.status}):\n${result.stderr}\n${result.stdout}`);
    // Nothing was downloaded into the folder.
    expect(fs.readdirSync(browsers)).toEqual([]);
    return JSON.parse(line.slice('RESULT '.length)) as { message: string; cause: string };
  }

  it.each([
    ['firefox', 'Firefox'],
    ['webkit', 'WebKit'],
  ])('%s fails with the steptix command, keeping Playwright\'s error as the cause', (engine, name) => {
    const { message, cause } = launchInChild(engine);
    expect(message).toContain(
      `Steptix needs a ${name} build that is not downloaded yet. Run: steptix browsers install ${engine}`,
    );
    expect(message).toContain(path.join(tmp, 'browsers'));
    expect(message).not.toContain('npx playwright');
    expect(cause).toContain("Executable doesn't exist");
    expect(cause).toContain('npx playwright install');
  });
});
