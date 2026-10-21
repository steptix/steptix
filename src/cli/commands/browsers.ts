import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Command } from 'commander';

/**
 * `steptix browsers` — downloads the browser builds Steptix drives through
 * Playwright (Firefox, WebKit, Playwright's own Chromium) by handing the
 * arguments to Playwright's own CLI. Google Chrome, the default, is the copy
 * the user installed and needs nothing from here.
 *
 * Only these subcommands are allowed; anything else is refused before
 * Playwright sees it, so `steptix browsers` cannot become a back door to the
 * rest of Playwright's CLI (`test`, `codegen`, ...).
 */
export const BROWSERS_SUBCOMMANDS: readonly string[] = ['install', 'install-deps', '--help'];

export const BROWSERS_USAGE = [
  'Usage: steptix browsers install [chromium|firefox|webkit]',
  '       steptix browsers install-deps [chromium|firefox|webkit]',
  '       steptix browsers --help',
].join('\n');

/** Whether `args` (everything after `browsers`) may go to Playwright's CLI. */
export function isAllowedBrowsersArgs(args: readonly string[]): boolean {
  return args.length > 0 && BROWSERS_SUBCOMMANDS.includes(args[0]!);
}

/**
 * Absolute path of Playwright's CLI script, resolved from Steptix's own
 * package — never from the user's project or the working directory, so the
 * builds it downloads are the ones this Steptix's Playwright launches.
 *
 * `playwright/cli.js` is not in Playwright's `exports`, so it cannot be
 * resolved directly; `playwright/package.json` is, and its `bin` names the
 * script.
 *
 * `from` is the module the resolution starts at; tests pass a fake package.
 */
export function resolvePlaywrightCli(from: string | URL = import.meta.url): string {
  const pkgPath = createRequire(from).resolve('playwright/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['playwright'];
  if (!bin) throw new Error(`${pkgPath} names no playwright CLI in "bin"`);
  return path.resolve(path.dirname(pkgPath), bin);
}

export interface BrowsersDeps {
  spawn?: typeof nodeSpawn;
  /** Resolves Playwright's CLI script; called only once the arguments pass. */
  resolveCli?: () => string;
}

export function registerBrowsersCommand(program: Command): void {
  program
    .command('browsers')
    .description(
      'Download the Firefox, WebKit or Chromium build Steptix drives (Google Chrome, the default, needs none)',
    )
    .argument('[args...]', 'install [chromium|firefox|webkit], install-deps, or --help')
    // Everything after `browsers` is Playwright's to parse — `--help`
    // included — so commander must not
    // claim any of it: no help option here, and the program's own options
    // are positional (src/cli/index.ts), so they stop at the command name.
    .helpOption(false)
    .passThroughOptions()
    .allowUnknownOption()
    .action(async (args: string[]) => {
      process.exit(await browsersCommand(args));
    });
}

/**
 * Returns Playwright's exit code (1 on refusal or a failed start) instead of
 * exiting, so the checks are testable without downloading anything.
 *
 * The child keeps the caller's working directory and environment, so a
 * `PLAYWRIGHT_BROWSERS_PATH` the user set decides where builds land, the same
 * as it decides where the server looks for them.
 */
export async function browsersCommand(args: readonly string[], deps: BrowsersDeps = {}): Promise<number> {
  if (!isAllowedBrowsersArgs(args)) {
    console.error(BROWSERS_USAGE);
    return 1;
  }
  let cli: string;
  try {
    cli = (deps.resolveCli ?? resolvePlaywrightCli)();
  } catch (err) {
    console.error(`Could not find Playwright's CLI in this Steptix install: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (err) => {
      console.error(err.message);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
