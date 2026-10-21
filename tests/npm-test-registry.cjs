// A private npm registry for the install and release tests
// (docs/specs/SPEC-install.md §10.1): Verdaccio, fetched with npx, serving the
// `steptix` packages a test publishes to it and passing every other package
// through to npmjs.org, as a company registry would.
//
// Used by scripts/release-test.mjs and
// steptix-vscode/tests/integration/runInstallTest.cjs. It needs the network.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// Verdaccio takes its port as a flag, so it cannot bind 0 and report back:
// the one case freeFetchablePort is for.
const { freeFetchablePort } = require('./listen-fetchable.cjs');

/** Pinned, like the VS Code the tests run. */
const VERDACCIO = 'verdaccio@6.1.6';

/**
 * Start a registry with its storage and log under `dir`. Resolves once it
 * answers. `npmrc` is a user config pointing npm at it, with a token named
 * after the test so it is never mistaken for a real one.
 */
async function startTestRegistry(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const port = await freeFetchablePort();
  const url = `http://127.0.0.1:${port}/`;
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    [
      'storage: ./storage',
      'uplinks:',
      '  npmjs:',
      '    url: https://registry.npmjs.org/',
      'packages:',
      "  'steptix':",
      '    access: $all',
      '    publish: $all',
      "  '**':",
      '    access: $all',
      '    proxy: npmjs',
      'log: { type: stdout, format: pretty, level: warn }',
      '',
    ].join('\n'),
  );
  const npmrc = path.join(dir, 'npmrc');
  fs.writeFileSync(npmrc, `registry=${url}\n//127.0.0.1:${port}/:_authToken=npm-test-registry-token\n`);
  const log = fs.openSync(path.join(dir, 'registry.log'), 'a');
  const child = cp.spawn('npx', ['-y', VERDACCIO, '--config', './config.yaml', '--listen', `127.0.0.1:${port}`], {
    cwd: dir,
    shell: process.platform === 'win32',
    stdio: ['ignore', log, log],
  });

  const stop = () => {
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill();
    }
  };

  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`${url}-/ping`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) {
        return {
          url,
          npmrc,
          stop,
          /** Publish a packed `.tgz` to the registry. */
          publish(tarball) {
            const result = cp.spawnSync('npm', ['publish', tarball, '--registry', url], {
              encoding: 'utf8',
              shell: process.platform === 'win32',
              env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc },
            });
            if (result.status !== 0) throw new Error(`npm publish ${tarball} failed:\n${result.stdout}\n${result.stderr}`);
          },
        };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`the registry did not start at ${url}; see ${path.join(dir, 'registry.log')}`);
}

module.exports = { startTestRegistry };
