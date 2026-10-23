/**
 * What the first `steptix` command says after it sets Steptix up
 * (docs/specs/SPEC-install.md §5.1 step 3, §7.5): whether Google Chrome, the
 * browser Steptix runs tests in by default, was found, and, when no AI is
 * chosen yet, how to choose one.
 *
 * Part of the launcher, so it imports only Node built-ins and reads `.env`
 * files with a line match rather than the framework's loader.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where Google Chrome's stable channel installs, as Playwright's `chrome`
 *  channel looks for it. */
export function chromePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']]
      .filter((dir): dir is string => typeof dir === 'string' && dir !== '')
      .map((dir) => path.win32.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}

/** The value of `key` in a `.env` file's text, or undefined. */
function envValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(text);
  return m?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Has an AI been chosen for a command run in `cwd`: an `AI_API_KEY` in the
 * environment, the project's `.env` (the nearest one up to its
 * steptix.config.json) or the machine `.env`? Copilot's setup writes one too.
 */
export function aiChosen(cwd: string, machineEnv: string, env: NodeJS.ProcessEnv): boolean {
  if (env['AI_API_KEY']?.trim()) return true;
  const files = [machineEnv];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    files.push(path.join(dir, '.env'));
    if (fs.existsSync(path.join(dir, 'steptix.config.json')) || path.dirname(dir) === dir) break;
  }
  return files.some((file) => (envValue(read(file), 'AI_API_KEY') ?? '') !== '');
}

/** The lines to print, in order. */
export function firstRunLines(args: {
  cwd: string;
  machineEnv: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists?: (file: string) => boolean;
}): string[] {
  const exists = args.exists ?? fs.existsSync;
  const lines = [
    chromePaths(args.platform, args.env).some((p) => exists(p))
      ? 'Google Chrome found.'
      : 'Google Chrome was not found. Steptix runs tests in it by default: get it from https://www.google.com/chrome/',
  ];
  if (!aiChosen(args.cwd, args.machineEnv, args.env)) lines.push('No AI chosen yet. Run steptix ai to choose one.');
  return lines;
}
