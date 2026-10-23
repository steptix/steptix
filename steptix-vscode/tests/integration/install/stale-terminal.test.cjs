/**
 * The terminal falls behind VS Code (docs/specs/SPEC-install.md §6.8). npm's
 * `steptix` is on PATH; the runner sets its version for each launch:
 *
 *   launch 1: an older major.minor. The notice appears, naming both, and not
 *             again when the extension starts again.
 *   launch 2: the extension's major.minor, another patch. No notice.
 *
 * "Starts again" is the startup checks run a second time in the same window:
 * VS Code keeps an extension's state in memory while it runs extension tests,
 * so a second launch would remember nothing (see ask-once.test.cjs).
 *
 * STEPTIX_INSTALL_TEST_TERMINAL names npm's version for the launch.
 */
const assert = require('node:assert/strict');
const { EXTENSION_VERSION, hooks, required, stubPrompts, waitFor } = require('./helpers.cjs');

const NOTICE = /^The steptix command in your terminal is /;
const launch = () => required('STEPTIX_INSTALL_TEST_LAUNCH');
const majorMinor = (v) => v.split('.').slice(0, 2).join('.');

/** Long enough for the check, which the startup checks start without
 *  waiting for, to have looked at npm's copy and decided. */
const NOTICE_SETTLE_MS = 30_000;

describe('the terminal on another major.minor', function () {
  this.timeout(10 * 60_000);
  const prompts = stubPrompts();

  it('is said once, naming both versions and the command that updates it', async function () {
    if (launch() !== '1') this.skip();
    await (await hooks()).serverStartupChecks();
    await waitFor('the notice', () => prompts.matching(NOTICE).length > 0, 120_000);
    const [notice] = prompts.matching(NOTICE);
    assert.equal(
      notice.message,
      `The steptix command in your terminal is ${majorMinor(required('STEPTIX_INSTALL_TEST_TERMINAL'))}. ` +
        `VS Code is on ${majorMinor(EXTENSION_VERSION())}. Update it so both work on your projects the same way: npm i -g steptix`,
    );
    assert.deepEqual(notice.items, ['Copy command', "Don't show again"]);

    await (await hooks()).serverStartupChecks();
    await new Promise((r) => setTimeout(r, NOTICE_SETTLE_MS));
    assert.equal(prompts.matching(NOTICE).length, 1, `said again: ${JSON.stringify(prompts.matching(NOTICE))}`);
  });

  it('is not said for a patch difference', async function () {
    if (launch() !== '2') this.skip();
    await (await hooks()).serverStartupChecks();
    await new Promise((r) => setTimeout(r, NOTICE_SETTLE_MS));
    assert.deepEqual(prompts.matching(NOTICE), [], `said it: ${JSON.stringify(prompts.matching(NOTICE))}`);
  });
});
