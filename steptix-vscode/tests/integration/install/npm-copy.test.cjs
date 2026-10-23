/**
 * `npm i -g steptix` done, no `steptix` command ever run, then the extension:
 * it sets up npm's own copy, downloads nothing and asks nothing
 * (docs/specs/SPEC-install.md §5.3). With STEPTIX_INSTALL_TEST_OFFLINE the
 * copy is the offline file's and npm's registry is unreachable (§5.6).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');
const { VERSION, health, hooks, installRecord, installed, required, stopServer, stubPrompts, waitFor } = require('./helpers.cjs');

describe("npm's copy of steptix, never run", function () {
  this.timeout(20 * 60_000);
  const prompts = stubPrompts();
  after(stopServer);

  it('is set up when the extension starts, with nothing downloaded and nothing asked', async () => {
    await (await hooks()).serverStartupChecks();
    await waitFor(`runtimes/${VERSION()}`, () => installed().includes(VERSION()), 120_000);
    const offline = process.env.STEPTIX_INSTALL_TEST_OFFLINE === '1';
    assert.equal(installRecord(VERSION()).source, offline ? 'offline file' : 'npm');
    assert.deepEqual(prompts.matching(/needs its local server/), [], 'it asked to install');
    const cache = required('NPM_CONFIG_CACHE');
    assert.equal(fs.existsSync(cache) && fs.readdirSync(cache).length > 0, false, `npm downloaded into ${cache}`);
  });

  it('runs it', async () => {
    await vscode.commands.executeCommand('steptix.startServer');
    await waitFor('the server to answer', async () => (await health()) !== null, 120_000);
    assert.equal((await health()).version, VERSION());
  });
});
