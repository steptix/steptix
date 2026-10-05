/**
 * The credentials a live test needs, found where the extension finds them.
 *
 * `STEPTIX_SERVER_API_KEY` lives in one machine-wide file now
 * (stories/machine-key.md): `serve` generates it in
 * `%LOCALAPPDATA%\steptix\.env` (`$XDG_CONFIG_HOME/steptix/.env` or
 * `~/.steptix/.env` elsewhere) on first start, and no project `.env` carries
 * it. A test that reads only `templates/.env` therefore sends an empty key and
 * gets a 401. So every lookup here takes the extension's own order — the
 * project `.env`, then the environment, then the machine file — and reads the
 * machine file through `steptix-runner-core`, the code the extension runs,
 * rather than a copy of it.
 *
 * Not a `*.test.cjs`, so `index.cjs` does not load it as a suite.
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv, readMachineKey, userRootEnvPath } = require('steptix-runner-core');

/** One trimmed value from an env file, or '' when the file or the key is absent. */
function readEnvValue(envPath, key) {
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return '';
  }
  return (parseEnv(text)[key] ?? '').trim();
}

/**
 * `key` resolved the way the framework resolves a credential: the project
 * `.env`, then the environment, then the machine-wide `.env`. '' when none of
 * them has it.
 */
function resolveCredential(projectEnvPath, key) {
  return (
    readEnvValue(projectEnvPath, key) ||
    (process.env[key] ?? '').trim() ||
    readEnvValue(userRootEnvPath(), key)
  );
}

/**
 * The Sessions API key for the server a workspace's runs go to — the same
 * chain as the extension's `resolveApiKey` (src/extension/run-controller.ts).
 * Throws, naming every place it looked, when there is none: an empty key would
 * only come back as a 401 several steps later.
 */
function serverApiKey(workspaceRoot) {
  const projectEnv = path.join(workspaceRoot, '.env');
  const key =
    readEnvValue(projectEnv, 'STEPTIX_SERVER_API_KEY') ||
    (process.env.STEPTIX_SERVER_API_KEY ?? '').trim() ||
    readMachineKey() ||
    '';
  if (!key) {
    throw new Error(
      `No STEPTIX_SERVER_API_KEY in ${projectEnv}, the environment, or the machine file ` +
        `${userRootEnvPath()}. \`steptix serve\` generates one there on first start — ` +
        'the live runner starts its servers before any test runs, so this means the ' +
        'server and this test disagree about where the machine file is.',
    );
  }
  return key;
}

module.exports = { readEnvValue, resolveCredential, serverApiKey, userRootEnvPath };
