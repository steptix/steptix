/**
 * Playwright's own launch error for a browser build it expects but cannot
 * find (`registry/index.js`, `executablePathOrDie`) starts with this and then
 * tells the user to run `npx playwright install` — the wrong command for a
 * Steptix user, who has no Playwright project to run it in.
 *
 * It happens on a fresh install that never downloaded the build, after a
 * Steptix update that moved Playwright to a version expecting a newer one, or
 * after someone removed the build by hand (issue #109).
 */
const MISSING_EXECUTABLE = "Executable doesn't exist";

const ENGINE_NAMES = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
} as const;

export type PlaywrightEngine = keyof typeof ENGINE_NAMES;

/**
 * Steptix's own error for a launch that failed because Playwright's build of
 * `engine` is missing, or `null` when `err` is some other failure. The
 * original error is kept as `cause`, and the path Playwright looked at is
 * quoted, so nothing in Playwright's message is lost.
 */
export function explainMissingBuild(err: unknown, engine: PlaywrightEngine): Error | null {
  const message = err instanceof Error ? err.message : String(err);
  const at = message.indexOf(MISSING_EXECUTABLE);
  if (at === -1) return null;
  // The first line names the path; the boxed advice after it is the part
  // being replaced.
  const missing = message.slice(at).split('\n')[0]!.trim();
  return new Error(
    `Steptix needs a ${ENGINE_NAMES[engine]} build that is not downloaded yet. ` +
      `Run: steptix browsers install ${engine}\n` +
      `(Playwright: ${missing})`,
    { cause: err },
  );
}
