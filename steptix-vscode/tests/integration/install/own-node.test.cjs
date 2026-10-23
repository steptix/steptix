/**
 * Node.js 22.21 or later already on PATH: Install Server downloads only the
 * server, and the server runs on the user's Node.js
 * (docs/specs/SPEC-install.md §5.2, §4.6). The runner leaves this machine's
 * Node.js on PATH and names it in STEPTIX_INSTALL_TEST_NODE.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { ROOT, VERSION, binVersion, health, installRecord, required, stopServer, stubPrompts, waitFor } = require('./helpers.cjs');

describe('with Node.js on PATH', function () {
  this.timeout(20 * 60_000);
  const prompts = stubPrompts();
  after(stopServer);

  it('Install Server downloads only the server', async () => {
    await vscode.commands.executeCommand('steptix.installServer');
    assert.equal(installRecord(VERSION()).source, 'extension');
    assert.equal(fs.existsSync(path.join(ROOT(), 'node')), false, 'no Node.js was downloaded');
    assert.ok(prompts.matching(/^Steptix server .* is ready\.$/).length === 1, JSON.stringify(prompts.prompts));
  });

  it("runs it on the user's Node.js", async () => {
    const node = required('STEPTIX_INSTALL_TEST_NODE');
    const script = fs.readFileSync(path.join(ROOT(), 'bin', process.platform === 'win32' ? 'steptix.cmd' : 'steptix'), 'utf8');
    assert.ok(script.includes(node), `the steptix command runs ${node}:\n${script}`);
    assert.match(binVersion(), new RegExp(`^Server: ${VERSION().replace(/\./g, '\\.')}\\b`, 'm'));
    await vscode.commands.executeCommand('steptix.startServer');
    await waitFor('the server to answer', async () => (await health()) !== null, 120_000);
    assert.equal((await health()).version, VERSION());
  });
});
