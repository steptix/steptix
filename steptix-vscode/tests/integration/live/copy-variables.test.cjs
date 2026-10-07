/**
 * Live end-to-end test for copying and exporting variables — what an author
 * most often does with them: pause at a breakpoint, look at what the run
 * captured, copy a value out, or export the lot.
 *
 * The fast suite (suite/variables.test.cjs) pins the commands against a fake
 * server's made-up scope. What only a live run can say is whether the REAL
 * values survive the chain intact:
 *
 *   real model reading a real table -> a JSON array in the variable map
 *     -> frame:scope -> the Variables view and the Test Runner panel
 *       -> the clipboard / a CSV file
 *
 * `templates/init/tests/copy-variables.md` gives the four kinds an author
 * meets: a masked password parameter, a whole table in one variable, a single
 * captured value, and a `Set` step's. The claims:
 *
 *  - paused at a breakpoint, the Variables view lists all four, the password
 *    masked, and Copy Value / Copy Unmasked Value put the real values on the
 *    clipboard — the table as JSON that parses back to the five rows;
 *  - Export as CSV writes them with the password still masked;
 *  - the panel holds the same values, and copying from it gives the same text;
 *  - after the run ends, the panel still offers them to copy, and the
 *    Variables view, like a debugger's, clears.
 *
 * Before this test, the view showed "No active run" for the whole pause: a
 * breakpoint ends the run's request, and the view only read a RUNNING
 * controller.
 *
 * Prereq: the API server on $LIVE_STEPTIX_SERVER_URL (the parallel runner starts
 * one per shard) and the fixture app on :8787 (runLiveTest.cjs boots it).
 *
 * Run just this file:
 *   cd steptix-vscode
 *   npm run test:live -- --files=copy-variables.test.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURE = 'copy-variables.md';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Say what was observed, into the shard's log as well as stdout (the
 *  parallel runner discards a passing launch's stdout). */
function say(line) {
  console.log(`[live] ${line}`);
  const file = process.env.STEPTIX_LIVE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `[live] ${line}\n`);
  } catch {
    /* best effort */
  }
}

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}${last ? ` (last error: ${last.message})` : ''}`);
}

const serverUrl = () => process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';

/** RFC 4180, enough to read back what the export writes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += c;
  }
  return rows;
}

describe('Steptix live — copy and export the variables a real run captured', function () {
  this.timeout(360_000);

  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;
  let uri;
  let stepFiveLine;
  /** The fixture's `password` parameter — SecureBank's demo login — read from
   *  its `## Parameters` so this file holds no credential of its own. */
  let fixturePassword;
  let savedClipboard;
  let exportDir;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');
    try {
      const res = await fetch(`${serverUrl()}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(res.status === 204 || res.status === 200, `Server at ${serverUrl()} not responding (status=${res.status})`);
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl()}. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    savedClipboard = await vscode.env.clipboard.readText();
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steptix-live-vars-'));

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');
    const file = path.resolve(workspaceRoot, 'init', 'tests', FIXTURE);
    assert.ok(fs.existsSync(file), `${FIXTURE} not found at ${file}`);
    uri = vscode.Uri.file(file);
    // The line of step 5, read from the file so an edit above it cannot
    // move the breakpoint somewhere else.
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    stepFiveLine = lines.findIndex((l) => l.startsWith('5. ')) + 1;
    assert.ok(stepFiveLine > 0, 'step 5 not found in the fixture');
    fixturePassword = lines.map((l) => /^- password: (.+)$/.exec(l)?.[1]).find(Boolean);
    assert.ok(fixturePassword, 'the fixture declares a password parameter');
  });

  after(async () => {
    hooks?.setVariablesExportPicker(null);
    if (savedClipboard !== undefined) await vscode.env.clipboard.writeText(savedClipboard);
    if (exportDir) fs.rmSync(exportDir, { recursive: true, force: true, maxRetries: 5 });
    if (vscode.debug.breakpoints.length > 0) vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    try { await vscode.commands.executeCommand('steptix.restartSession'); } catch { /* best effort */ }
  });

  it('paused at a breakpoint: copy and export from the Variables view and the panel; after the run, the panel', async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    await waitFor(`${FIXTURE} becomes the active editor`, () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString());
    await waitFor('steptix detects the test file', () => hooks.tracker.snapshot().isTestFile === true, 15_000);
    if (vscode.debug.breakpoints.length > 0) vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(stepFiveLine - 1, 0)), true),
    ]);
    vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);

    say(`run ${FIXTURE}, breakpoint on line ${stepFiveLine}`);
    void vscode.commands.executeCommand('steptix.runSelected');
    await waitFor('the run starts', () => hooks.isRunning(), 30_000);
    await waitFor(`paused at line ${stepFiveLine}`, () => hooks.tracker.snapshot().breakpointStop === stepFiveLine, 240_000);
    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    say(`paused; statuses ${JSON.stringify(statuses)}`);

    // --- What the run captured, as the panel holds it ---------------------
    await waitFor(
      'the panel holds every captured variable',
      () => {
        const v = hooks.webviewRuntimeVariables();
        return v.payments && v.first_payee && v.greeting;
      },
      30_000,
    );
    const panel = hooks.webviewRuntimeVariables();
    say(`panel: ${Object.keys(panel).sort().join(', ')}; payments is ${panel.payments.length} chars`);
    const payments = JSON.parse(panel.payments);
    assert.equal(payments.length, 5, `five records, got ${panel.payments}`);
    assert.match(payments[0].payee, /Origin Energy/);
    assert.match(panel.first_payee, /Origin Energy/);
    assert.equal(panel.greeting, 'Hello demo@securebank.com');

    // --- The Variables view, paused --------------------------------------
    const items = hooks.variablesViewItems();
    say(`Variables view while paused: ${JSON.stringify(items.map((i) => [i.name, i.contextValue]))}`);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    for (const name of ['payments', 'first_payee', 'greeting', 'username', 'password']) {
      assert.ok(byName[name], `the Variables view lists ${name} while paused at a breakpoint; it lists ${Object.keys(byName).join(', ') || 'nothing'}`);
    }
    assert.equal(byName.password.contextValue, 'steptixVariable.masked');
    assert.notEqual(byName.password.description, fixturePassword);

    const copied = async (command, node) => {
      await vscode.env.clipboard.writeText('untouched');
      await vscode.commands.executeCommand(command, node);
      return vscode.env.clipboard.readText();
    };
    const tableText = await copied('steptix.copyVariableValue', byName.payments.node);
    assert.equal(tableText, panel.payments, 'the whole table, not the one line the view shows');
    assert.deepEqual(JSON.parse(tableText), payments);
    assert.equal(await copied('steptix.copyVariableValue', byName.first_payee.node), panel.first_payee);
    assert.equal(await copied('steptix.copyVariableUnmaskedValue', byName.password.node), fixturePassword);
    assert.equal(await copied('steptix.copyVariablePlaceholder', byName.payments.node), '{{payments}}');

    hooks.setVariablesExportPicker(async () => vscode.Uri.file(path.join(exportDir, 'paused.csv')));
    await vscode.commands.executeCommand('steptix.exportVariablesCsv');
    const csv = fs.readFileSync(path.join(exportDir, 'paused.csv'), 'utf8');
    const exported = Object.fromEntries(parseCsv(csv.replace(/^﻿/, '')).slice(1));
    say(`exported while paused: ${Object.keys(exported).join(', ')}`);
    assert.deepEqual(JSON.parse(exported.payments), payments, 'the table round-trips through the CSV');
    assert.equal(exported.first_payee, panel.first_payee);
    assert.equal(exported.password, byName.password.description, 'the password exports masked, as shown');
    assert.ok(!csv.includes(fixturePassword), 'the password never reaches the file');

    // --- The panel's copy path, with the value the panel holds ------------
    await hooks.dispatchWebviewMessage({ type: 'copyVariable', kind: 'value', name: 'payments', value: panel.payments });
    assert.equal(await vscode.env.clipboard.readText(), panel.payments);

    // --- Continue to the end; the panel keeps the values ------------------
    void vscode.commands.executeCommand('steptix.continueRun');
    await waitFor('the run resumes', () => hooks.isRunning(), 15_000);
    await waitFor('the run ends', () => !hooks.isRunning(), 180_000);
    const finalStatus = Object.fromEntries(hooks.tracker.snapshot().statuses)[stepFiveLine];
    say(`run ended; step 5 ${finalStatus}`);

    const afterRun = hooks.webviewRuntimeVariables();
    assert.equal(afterRun.payments, panel.payments, 'the panel still holds the table after the run');
    await vscode.env.clipboard.writeText('untouched');
    await hooks.dispatchWebviewMessage({ type: 'copyVariable', kind: 'value', name: 'first_payee', value: afterRun.first_payee });
    assert.equal(await vscode.env.clipboard.readText(), panel.first_payee);
    // The view follows the debugger's rule: a finished run has nothing to
    // inspect. The panel is where a finished run's values stay.
    assert.deepEqual(hooks.variablesViewItems().map((i) => i.name), [], 'the Variables view clears when the run ends');
  });
});
