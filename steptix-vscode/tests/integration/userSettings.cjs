// User settings a test VS Code must start with, written into its profile
// before launch.
const fs = require('node:fs');
const path = require('node:path');

/**
 * The fast and live suites own their servers: the fast suite fakes them, the
 * live runner starts one per shard from this checkout's `dist/`. Neither may
 * have the extension start the runtime the developer installed under
 * %LOCALAPPDATA%\steptix\runtimes — in the fast suite every run's probe of the
 * fixture's dead port would spawn a real server, and in a live shard a crashed
 * server would be silently replaced by an older build. The installed-runtime
 * test (runRuntimeTest.cjs) is the one launch that wants it, and it starts
 * from an empty profile, the way a first-time user does.
 */
const SUITE_SETTINGS = {
  'steptix.serverAutoStart.useInstalledRuntime': false,
};

/**
 * Merge `settings` into `<userDataDir>/User/settings.json`, keeping whatever
 * else is there. A file that is not JSON (hand-edited, with comments) is
 * replaced: it is a test profile, and a launch that silently kept the default
 * would be the failure this exists to prevent.
 */
function pinUserSettings(userDataDir, settings = SUITE_SETTINGS) {
  const file = path.join(userDataDir, 'User', 'settings.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* absent or unparseable: start from nothing */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...current, ...settings }, null, 4));
}

module.exports = { pinUserSettings, SUITE_SETTINGS };
