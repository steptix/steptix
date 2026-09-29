/**
 * Live end-to-end: Record New Test, from nothing to a test that passes
 * (docs/specs/SPEC-record-steps.md §7.2, §5; stories/steptix-record-toolbar.md).
 *
 * The most common use of Record Steps, driven the way a person drives it:
 * Steptix's Record New Test, then in the recording browser — reached over
 * DevTools (record-steps-live.cjs) with trusted mouse and keyboard — reject
 * the cookie banner, type the email, Tab, type the password, Enter, click a
 * menu link, Add check (Alt+Shift+C) on the page heading, and Stop from the
 * toolbar in the page. Then the recorded file is run and must pass.
 *
 * What nothing below this layer proves:
 *
 *  - the server suites answer the draft prompt with a stub, so they never
 *    show that a real model turns these actions into steps a run can follow;
 *  - the fast mocha suite plays the server with FakeApiClient, so it never
 *    shows the real frames landing in a real file;
 *  - nothing else checks that the literal password stays out of every
 *    surface — the file, the output channel and the panel state — through a
 *    whole real recording, and that the `$VAR` parameter the recording wrote
 *    is the one the run then resolves from `.env`.
 *
 * The model writes the words, so the assertions are strict about structure,
 * order, parameters and secrets and tolerant about wording.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const L = require('./record-steps-live.cjs');

const EMAIL = 'demo@securebank.com';
const SECRET = 'password123';
const NEW_NAME = 'signin-recorded';

const SEED = `# Seed

## Config
- baseUrl: ${L.APP}/

## Steps
1. Navigate to the baseUrl
`;

describe('Steptix live — Record New Test, end to end', function () {
  this.timeout(1_200_000);

  let hooks;
  let workspaceRoot;
  let project;
  let browser = null;

  before(async () => {
    ({ hooks, workspaceRoot } = await L.setUp());
    project = L.makeProject(workspaceRoot, 'record-live-new', {
      cdpPort: await L.freePort(),
      files: { 'seed.md': SEED },
    });
    L.say(`project ${project.dir}, recording browser DevTools on :${project.cdpPort}`);
  });

  after(async () => {
    if (hooks?.recordingState()) await vscode.commands.executeCommand('steptix.cancelRecording');
    await browser?.close().catch(() => {});
    try {
      await vscode.commands.executeCommand('steptix.restartSession');
    } catch {
      /* best effort */
    }
    if (project) fs.rmSync(project.dir, { recursive: true, force: true });
  });

  it('records sign-in, a menu click and a check into a new file, keeps the password out of everything, and the file runs green', async () => {
    // Record New Test takes its project from the active editor: the seed file
    // is what puts this project (and its baseUrl) in front.
    await L.openTest(hooks, path.join(project.testsDir, 'seed.md'));
    const logBefore = L.readLiveLog().length;
    const markBefore = hooks.hostMessageCount();

    L.say(`Record New Test "${NEW_NAME}"`);
    void vscode.commands.executeCommand('steptix.recordNewTest', { name: NEW_NAME });
    const file = path.join(project.testsDir, `${NEW_NAME}.md`);
    await L.waitFor(
      'the recording starts (record:started)',
      () => hooks.recordingState()?.phase === 'recording',
      120_000,
      () => JSON.stringify({ state: hooks.recordingState()?.phase, refusal: hooks.recordingRefusal(), report: hooks.recordingReport() }),
    );
    assert.ok(fs.existsSync(file), `Record New Test must create ${file}`);
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(),
      file.toLowerCase(),
      'the new file is the one open and recording',
    );
    const uri = vscode.Uri.file(file);

    browser = await L.connectBrowser(project.cdpPort);
    const page = await L.pageAt(browser, L.APP);
    await L.waitFor('the toolbar is in the page', async () => (await L.readToolbar(page))?.status.startsWith('REC'));
    L.say(`recording ${page.url()}`);

    // ── Sign in, as a person does ──────────────────────────────────────────
    await L.clickOn(page, '#cookie-reject');
    await L.clickOn(page, '#email');
    await page.keyboard.type(EMAIL);
    await page.keyboard.press('Tab');
    await page.keyboard.type(SECRET);
    await page.keyboard.press('Enter');
    await page.waitForURL(/dashboard\.html/, { timeout: 30_000 });
    await L.draftSettled(hooks, 'after sign-in');

    // ── A menu link ────────────────────────────────────────────────────────
    await L.clickOn(page, 'nav a[href="transactions.html"]');
    await page.waitForURL(/transactions\.html/, { timeout: 30_000 });

    // ── Add check on the heading ───────────────────────────────────────────
    await page.keyboard.press('Alt+Shift+C');
    await L.waitFor('pick mode armed', () => hooks.recordingState()?.pickArmed === true, 15_000);
    await L.clickOn(page, 'h1');
    await L.waitFor(
      'the check is recorded',
      () => (hooks.recordingState()?.actions ?? []).some((a) => a.kind === 'check'),
      15_000,
      () => JSON.stringify(hooks.recordingState()?.actions),
    );
    await L.draftSettled(hooks, 'after the check');

    // The panel state as the author saw it at the end, before Stop.
    const panelAtEnd = L.stateText(hooks);
    L.say(`actions: ${JSON.stringify(L.actionRows(hooks).map((a) => `${a.kind}: ${a.summary}`))}`);

    // ── Stop, from the toolbar in the page ────────────────────────────────
    await L.clickToolbar(page, 'stop');
    await L.waitFor(
      'the recording ends and its steps are written',
      () => hooks.recordingState() === null && hooks.recordingReport() !== null,
      180_000,
      () => JSON.stringify({ phase: hooks.recordingState()?.phase, report: hooks.recordingReport() }),
    );
    const report = hooks.recordingReport();
    L.say(`report: ${JSON.stringify(report)}`);
    assert.equal(report.status, 'inserted', `Stop must write the steps; got ${JSON.stringify(report)}`);

    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    L.say(`recorded file:\n${text}`);

    // ── Structure: numbered in order, reading as the actions did ──────────
    const steps = L.stepsOf(text);
    assert.ok(steps.length >= 4, `expected at least 4 steps, got ${steps.length}:\n${text}`);
    steps.forEach((s, i) => assert.equal(s.n, i + 1, `steps are numbered 1..n in order:\n${text}`));

    const params = L.parametersOf(text);
    const email = params.find((p) => p.value === EMAIL);
    assert.ok(email, `## Parameters holds the typed email as a literal: ${JSON.stringify(params)}`);
    assert.match(email.name, /email/i, `the email parameter is named from its field: ${email.name}`);
    const secret = params.find((p) => /^\$[A-Z][A-Z0-9_]*$/.test(p.value));
    assert.ok(secret, `## Parameters holds the password as a $VAR, never its value: ${JSON.stringify(params)}`);
    assert.match(secret.name, /password/i, `the secret parameter is named from its field: ${secret.name}`);
    const envVar = secret.value.slice(1);

    const idx = (re) => steps.findIndex((s) => re.test(s.text));
    const cookies = idx(/cookie|reject/i);
    const typedEmail = idx(new RegExp(`\\{\\{${email.name}\\}\\}`));
    const typedSecret = idx(new RegExp(`\\{\\{${secret.name}\\}\\}`));
    const menu = idx(/transaction/i);
    const verify = steps.findIndex((s) => /^verify\b/i.test(s.text));
    for (const [what, at] of Object.entries({ cookies, typedEmail, typedSecret, menu, verify })) {
      assert.ok(at >= 0, `no step for ${what}:\n${text}`);
    }
    assert.ok(cookies < typedEmail, `the banner is dismissed before the email is typed:\n${text}`);
    assert.ok(typedEmail < typedSecret, `email before password:\n${text}`);
    assert.ok(typedSecret < menu, `sign in before the menu click:\n${text}`);
    assert.ok(menu <= verify, `the check comes last, after the menu click:\n${text}`);
    assert.match(steps[verify].text, /transaction history/i, `the Verify names what was checked: ${steps[verify].text}`);
    assert.equal(
      steps.filter((s) => /^verify\b/i.test(s.text)).length,
      1,
      `exactly one Verify — the recorder writes one only from an explicit check:\n${text}`,
    );

    // ── The password is nowhere ──────────────────────────────────────────
    assert.ok(!text.includes(SECRET), 'the literal password must not be in the recorded file');
    const logThisRecording = L.readLiveLog().slice(logBefore);
    assert.ok(logThisRecording.length > 0, 'the output channel must be teed for this check to mean anything');
    assert.ok(!logThisRecording.includes(SECRET), 'the literal password must not be in the output channel');
    assert.ok(!panelAtEnd.includes(SECRET), 'the literal password must not be in the panel state');
    const toPanel = JSON.stringify(hooks.hostMessagesSince(markBefore));
    assert.ok(!toPanel.includes(SECRET), 'the literal password must not be in any message sent to the panel');

    // ── The recorded test runs green ─────────────────────────────────────
    await browser.close().catch(() => {});
    browser = null;
    L.writeEnv(workspaceRoot, project.dir, { [envVar]: SECRET });
    await doc.save();
    await L.openTest(hooks, file);
    await vscode.commands.executeCommand('steptix.restartSession');
    await L.sleep(1_500);
    L.say(`running ${NEW_NAME}.md with ${envVar} from .env`);
    await L.runAllToRest(hooks, 'the recorded test');
    const statuses = Object.fromEntries(hooks.tracker.snapshotFor(uri)?.statuses ?? hooks.tracker.snapshot().statuses);
    L.say(`run: done=${hooks.lastDoneStatus()} statuses=${JSON.stringify(statuses)} error=${JSON.stringify(hooks.lastRunError())}`);
    assert.equal(hooks.lastDoneStatus(), 'passed', `the recorded test must pass as written:\n${text}\nerror: ${JSON.stringify(hooks.lastRunError())}`);
    for (const s of steps) {
      assert.ok(
        typeof statuses[s.line] === 'string' && statuses[s.line].startsWith('pass'),
        `step ${s.n} (line ${s.line}) "${s.text}" must pass; got ${statuses[s.line]}`,
      );
    }
  });
});
