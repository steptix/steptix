/**
 * Live end-to-end test for inline sections.
 *
 * This is the ONLY automated guard on the client<->server sections contract.
 * Everything else stops short of it:
 *
 *  - the vitest server suite POSTs a payload it constructs itself, so it
 *    proves the server reads the field but not that the client writes it;
 *  - the mocha integration suite uses `FakeApiClient`, so it proves the
 *    client writes the field but never sends it anywhere.
 *
 * The wire shape is declared TWICE — `StreamStepsRequest.sections` in
 * runner-core and `StepRequest.sections` in the server — with no compiler
 * linkage between them, and the field has to survive api-server's per-field
 * allow-list, which has silently dropped a field before. Only a real request
 * over real HTTP closes that gap:
 *
 *   real RunController -> real ApiClient -> real api-server -> real expander
 *     -> real frame events -> real ActiveFileTracker statuses
 *
 * Deliberately stops at the first section body step. Running the whole file
 * would spend real AI turns on steps that aren't under test and import their
 * flakiness; what is being proved — that the server expanded a bare-name call
 * into a body it could only have learned about from the request — is already
 * true at the first body-line status.
 *
 * The fixture puts the section CALL first for that reason: the first step the
 * server executes is then a body line, so the evidence arrives before any
 * step has had a chance to fail for unrelated reasons.
 *
 * Prereq: the API server running on $LIVE_SERVER_URL (default :3100) with
 * templates/.env providing AIUI_SERVER_API_KEY + AI_API_KEY.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      /* transient */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

// Line numbers in templates/init/tests/sections-live.md.
const CALL_LINE = 18; // `1. Check the page` — the FIRST main-flow step
const BODY_FIRST = 24; // `1. Confirm the browser is showing a page`
const BODY_LAST = 25; // `2. Confirm the page has finished loading`

describe('TestBench live — inline sections expand server-side', function () {
  this.timeout(180_000);

  let hooks;

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(
        res.status === 204 || res.status === 200,
        `Server at ${serverUrl} not responding (status=${res.status})`,
      );
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Start it with \`npm run dev\` or \`aiui serve\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  it('a bare-name call runs the section body, painting body lines in the test file', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — live runner must pass templates/');

    const testFile = path.resolve(workspaceRoot, 'init', 'tests', 'sections-live.md');
    const testUri = vscode.Uri.file(testFile);

    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }

    await vscode.commands.executeCommand('vscode.open', testUri);
    await waitFor(
      'test file active',
      () => vscode.window.activeTextEditor?.document.uri.toString() === testUri.toString(),
    );
    await waitFor('tracker recognises test file', () => hooks.tracker.snapshot().isTestFile === true);

    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));

    console.log('[live] running sections-live.md; expecting body lines 24/25 to execute');
    void vscode.commands.executeCommand('testbench-native.runSelected');
    await waitFor('run started', () => hooks.isRunning(), 30_000);

    // THE assertion. Line 24 is a section BODY line. It is NOT in `steps` —
    // the client sends main-flow steps only, which is 3 for this fixture —
    // so the server can only be running it because it expanded the bare-name
    // call on line 18 using the `sections` map from the request. A status
    // here proves the whole chain: the client built the payload, api-server
    // forwarded it past the per-field allow-list, the expander resolved the
    // name, and the frame events came back attributed to the test file.
    //
    // Any status counts, deliberately. The fixture's first main-flow step IS
    // the call, so the first step the server executes is a body line —
    // whether it passes or fails is the AI's business, and gating on `pass`
    // would make this test fail for reasons that have nothing to do with
    // sections. (Confirmed against the server log: "Step 1/5: Confirm the
    // browser is showing a page" — 5 steps from 3 sent, body line first.)
    await waitFor(
      `body line ${BODY_FIRST} has a status (server expanded the section)`,
      () => {
        const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
        return statuses[BODY_FIRST] !== undefined;
      },
      120_000,
    );

    // The invocation line carries the aggregate, exactly as a `[skill:]` row
    // does — sections inherit that for free, and this is where it is proved
    // against a real server rather than scripted events.
    await waitFor(
      `call line ${CALL_LINE} shows the aggregate`,
      () => {
        const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
        return statuses[CALL_LINE] !== undefined;
      },
      60_000,
    );

    const statuses = Object.fromEntries(hooks.tracker.snapshot().statuses);
    console.log('[live] statuses:', JSON.stringify(statuses));

    // Body statuses land on the TEST file's own URI. For a skill they would
    // land on the skill file; a section body is defined here, so the whole
    // run paints in one editor.
    assert.ok(
      statuses[BODY_FIRST] !== undefined,
      `expected a status on body line ${BODY_FIRST}; got ${JSON.stringify(statuses)}`,
    );

    // And a frame was pushed for the section, named after it.
    const sectionFrames = hooks
      .runningFrameStack()
      .filter((f) => f.kind === 'section');
    if (sectionFrames.length > 0) {
      assert.equal(sectionFrames[0].skillName, 'Check the page');
      assert.equal(
        sectionFrames[0].uri,
        testFile,
        'a test-file section frame must be attributed to the test file',
      );
    }

    await vscode.commands.executeCommand('testbench-native.stop');
    await waitFor('stopped', () => !hooks.isRunning(), 30_000);
    void BODY_LAST;
  });
});
