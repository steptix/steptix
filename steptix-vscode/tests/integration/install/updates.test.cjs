/**
 * Updates and which server an extension runs (docs/specs/SPEC-install.md
 * §6.2, §4.2), over six launches on one machine. The runner publishes the
 * next patch and the next minor between launches, and sets the extension's
 * own version for each (STEPTIX_INSTALL_TEST_EXPECT names what a launch
 * should end up running, or "none"):
 *
 *   1. The extension at the release's version installs its server.
 *   2. The next server patch is published, with no new extension: the
 *      extension fetches it when it starts, without asking.
 *   3. The extension moves to the next minor, whose server is published: it
 *      fetches the matching server when it starts, without asking, before any
 *      Run, and the steptix command in VS Code's terminals runs it too.
 *   4. The newest extension patch of the first minor runs that minor's
 *      newest server, never the next minor's,
 *   5. and so does its oldest patch.
 *   6. An extension of a minor nobody published runs no server of another
 *      major.minor, newer or older: Start Server finds none to fetch, says
 *      so, and starts nothing.
 */
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { EXTENSION_VERSION, binVersion, health, hooks, installed, required, stopServer, stubPrompts, waitFor } = require('./helpers.cjs');

const QUESTION = /needs its local server/;
const launch = () => Number(required('STEPTIX_INSTALL_TEST_LAUNCH'));
const expected = () => required('STEPTIX_INSTALL_TEST_EXPECT');

describe(`updates (launch ${process.env.STEPTIX_INSTALL_TEST_LAUNCH})`, function () {
  this.timeout(20 * 60_000);
  const prompts = stubPrompts();
  after(async () => {
    if ((await health()) !== null) await stopServer();
  });

  it('installs the server the extension needs', async function () {
    if (launch() !== 1) this.skip();
    await vscode.commands.executeCommand('steptix.installServer');
    assert.deepEqual(installed(), [expected()]);
  });

  it('fetches a newer patch, or the next minor, when it starts, without asking', async function () {
    if (launch() !== 2 && launch() !== 3) this.skip();
    await (await hooks()).serverStartupChecks();
    await waitFor(`runtimes/${expected()}`, () => installed().includes(expected()), 10 * 60_000);
    assert.deepEqual(prompts.matching(QUESTION), [], 'it asked');
    await waitFor('the steptix command to run it', () => binVersion().includes(`Server: ${expected()}`), 120_000);
  });

  it(`runs the newest server of its own major.minor (${process.env.STEPTIX_INSTALL_TEST_EXPECT})`, async function () {
    if (launch() < 2 || launch() > 5) this.skip();
    await vscode.commands.executeCommand('steptix.startServer');
    await waitFor('the server to answer', async () => (await health()) !== null, 10 * 60_000);
    assert.equal((await health()).version, expected(), `extension ${EXTENSION_VERSION()} runs the wrong server`);
  });

  it('runs no server of another major.minor', async function () {
    if (launch() !== 6) this.skip();
    const before = installed();
    await vscode.commands.executeCommand('steptix.startServer');
    // A server is on the machine, so it looks for its own without asking
    // (§4.5), finds none published, and says so.
    assert.equal(await health(), null, `extension ${EXTENSION_VERSION()} started a server of another major.minor`);
    assert.deepEqual(installed(), before, 'it installed something');
    assert.ok(prompts.prompts.some((p) => p.kind === 'showErrorMessage'), `it did not say it found none: ${JSON.stringify(prompts.prompts)}`);
  });
});
