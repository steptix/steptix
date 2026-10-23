/**
 * Developer settings keep working (docs/specs/SPEC-install.md §4.12). The
 * runner writes the User settings for each launch:
 *
 *   launch 1: `steptix.serverAutoStart.command` runs npm's `steptix serve`.
 *             No install offer, and Start Server runs that command.
 *   launch 2: no command, `steptix.serverAutoStart.useInstalledRuntime` off.
 *             No install offer, and nothing is started.
 */
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { VERSION, health, hooks, installed, required, stopServer, stubPrompts, waitFor } = require('./helpers.cjs');

const OFFER = /needs its local server/;
const launch = () => required('STEPTIX_INSTALL_TEST_LAUNCH');

describe('developer settings', function () {
  this.timeout(10 * 60_000);
  const prompts = stubPrompts();
  after(async () => {
    if ((await health()) !== null) await stopServer();
  });

  it('with a command set, nothing is offered and Start Server runs the command', async function () {
    if (launch() !== '1') this.skip();
    await (await hooks()).serverStartupChecks();
    await vscode.commands.executeCommand('steptix.startServer');
    await waitFor('the configured server to answer', async () => (await health()) !== null, 120_000).catch((err) => {
      throw new Error(`${err.message}; it said: ${JSON.stringify(prompts.prompts)}`);
    });
    assert.equal((await health()).version, VERSION());
    assert.deepEqual(prompts.matching(OFFER), [], 'offered to install');
    assert.deepEqual(installed().filter((v) => v !== VERSION()), [], 'installed a server of its own');
  });

  it('with useInstalledRuntime off, nothing is offered and nothing starts', async function () {
    if (launch() !== '2') this.skip();
    await (await hooks()).serverStartupChecks();
    await vscode.commands.executeCommand('steptix.startServer');
    assert.equal(await health(), null, 'a server was started');
    assert.deepEqual(prompts.matching(OFFER), [], 'offered to install');
  });
});
