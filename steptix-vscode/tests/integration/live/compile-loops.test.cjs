/**
 * Live end-to-end test for compiling loops and conditions
 * (stories/codebehind-loops-and-conditions.md).
 *
 * Run & Compile a file that decides and loops, apply the proposal, run it
 * again — and the second run must make every decision in code: the `If`, the
 * `While` and the `Repeat … until` lines paint the code mark, the loops still
 * run exactly as many passes as the page allows, and the report of that run
 * holds no condition-judge call at all.
 *
 * Everything below this layer stops short of it:
 *
 *  - the vitest suites answer the generation prompt with a canned entry, so
 *    they prove the plumbing and never that a real model writes a `condition`
 *    that answers correctly on a real page;
 *  - the fast mocha suite scripts `fromCodeBehind` onto a guard's `step:pass`
 *    through `FakeApiClient`, so it proves the gutter and nothing about when
 *    the server sends it.
 *
 * The fixtures are the control-flow story's own
 * (`templates/init/tests/control-flow.md` and `-otherwise.md`, against
 * `fixtures/test-app/control-flow.html` on :8787). The page resets on load and
 * every loop's pass count is fixed by the page — Next disables on page 4,
 * Load more removes itself on its third click, three accounts are listed — so
 * a compiled condition that answers wrongly shows up as a wrong count, not as
 * a flake.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.steptix-vscode';
const TEST_APP_PORT = 8787;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Into the shard's own log as well as stdout — a passing launch's stdout is discarded. */
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

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

const PASSED = new Set(['pass', 'pass-code-behind', 'pass-stale']);
const passed = (status) => PASSED.has(status);

/**
 * The `defineSteps` entry block whose `source:` line contains `needle`, or
 * null. Split on `source:` rather than parsed: the point is WHICH entry holds
 * what, and a whole-file match would be satisfied by an entry bound elsewhere.
 * The first line of each block is the source literal.
 */
function entriesFor(content, needle) {
  const blocks = content.split(/\n\s*source:/).slice(1);
  // `trimStart` first: Prettier breaks a long `source:` value onto the next
  // line, and the literal is then the first NON-empty line of the block.
  return blocks.filter((b) => (b.trimStart().split('\n')[0] ?? '').includes(needle));
}

/**
 * The fixture's own line numbers, each pinned to a fragment of its text, so a
 * reworded step fails here by name instead of drifting onto its neighbour
 * (control-flow.test.cjs's `resolveFixture`, reduced to what this file reads).
 */
function resolveSteps(testFile, expected) {
  const lines = fs.readFileSync(testFile, 'utf8').split(/\r?\n/);
  const stepsHeading = lines.findIndex((l) => /^##\s+Steps\s*$/.test(l));
  assert.ok(stepsHeading >= 0, `${path.basename(testFile)} has no "## Steps" heading`);
  /** @type {Record<string, number>} */
  const line = {};
  /** @type {Record<string, string>} */
  const text = {};
  let section = null;
  for (let i = stepsHeading + 1; i < lines.length; i++) {
    const heading = /^###\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (/^##\s+/.test(lines[i])) break;
    const numbered = /^(\d+)\.\s+(.*)$/.exec(lines[i]);
    if (!numbered) continue;
    for (const [key, where, fragment] of expected) {
      if (line[key] !== undefined) continue;
      if ((where ?? null) !== section) continue;
      if (numbered[2].includes(fragment)) {
        line[key] = i + 1;
        text[key] = numbered[2].trim();
      }
    }
  }
  for (const [key, where, fragment] of expected) {
    assert.ok(
      line[key] !== undefined,
      `${path.basename(testFile)}: no step containing '${fragment}'` +
        `${where ? ` in "### ${where}"` : ' in the main flow'}`,
    );
  }
  return { line, text };
}

/** How many condition-judge model calls a rendered report holds. */
function judgeCallsIn(html) {
  return (html.match(/condition-judge/g) ?? []).length;
}

/** `<label> — iteration <n> of <m>` bands, as { label, index, count }. */
function reportBands(html) {
  const out = [];
  const re = /<span class="loop-band-lead">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const lead = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const parsed = /^(.*) — iteration (\d+) of (\S+)$/.exec(lead);
    if (parsed) out.push({ label: parsed[1], index: Number(parsed[2]), count: parsed[3] });
  }
  return out;
}

describe('Steptix live — compile loops and the conditions that drive them', function () {
  // Two runs of a 13-step file with three loops, plus the compile's tail.
  this.timeout(1_800_000);

  /** @type {any} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let startedApp = false;
  let workspaceRoot;
  /** Every `.steps.ts` / cache dir this file created, removed in `after`. */
  const created = [];

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks missing — activation may have failed');

    const serverUrl = process.env.LIVE_STEPTIX_SERVER_URL || 'http://localhost:3100';
    try {
      const res = await fetch(`${serverUrl}/sessions/healthcheck/steps`, { method: 'OPTIONS' });
      assert.ok(res.status === 204 || res.status === 200, `Server at ${serverUrl} not responding`);
    } catch (err) {
      throw new Error(
        `Live test requires the API server running at ${serverUrl}. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const appUrl = `http://localhost:${TEST_APP_PORT}/`;
    if (!(await up(appUrl))) {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      testApp = cp.spawn('npx tsx fixtures/test-app/server.ts', [], {
        cwd: repoRoot,
        env: { ...process.env, PORT: String(TEST_APP_PORT) },
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: true,
      });
      startedApp = true;
      await waitFor('fixtures/test-app listening', () => up(appUrl), 60_000);
    }
    // An older worktree's fixture app has no control-flow page.
    const page = await fetch(`${appUrl}control-flow.html`);
    assert.equal(page.status, 200, 'the fixture app on :8787 must serve control-flow.html');

    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
  });

  after(async () => {
    // The compiled file is this test's output, not a fixture: left behind, it
    // would turn control-flow.test.cjs's AI run into a replay.
    for (const p of created) fs.rmSync(p, { recursive: true, force: true });
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  async function open(name) {
    const file = path.resolve(workspaceRoot, 'init', 'tests', name);
    assert.ok(fs.existsSync(file), `${name} not found at ${file}`);
    const stepsFile = file.replace(/\.md$/, '.steps.ts');
    const cacheDir = path.join(path.dirname(file), '.steptix-codebehind-cache');
    created.push(stepsFile, cacheDir);
    fs.rmSync(stepsFile, { force: true });
    const uri = vscode.Uri.file(file);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      `${name} becomes the active editor`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor('Steptix recognises the test file', () => hooks.tracker.snapshot().isTestFile);
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    return { file, uri, stepsFile };
  }

  /** Run & Compile, return the proposal's content, apply it. */
  async function compileAndApply({ file, uri, stepsFile }) {
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
    say(`Run & Compile ${path.basename(file)}`);
    void vscode.commands.executeCommand('steptix.runAndCompile');
    await waitFor(
      'the compile proposes files for THIS test',
      () => hooks.pendingCodeBehind()?.testFilePath.toLowerCase() === file.toLowerCase(),
      1_200_000,
    );
    assert.equal(hooks.lastCompileError(), null, `the compile failed: ${hooks.lastCompileError()}`);
    const proposal = hooks.pendingCodeBehind();
    const entries = Object.entries(proposal.files);
    assert.equal(entries.length, 1, `one .steps.ts expected, got ${entries.map(([p]) => p)}`);
    const [proposedPath, content] = entries[0];
    assert.equal(path.resolve(proposedPath).toLowerCase(), stepsFile.toLowerCase());
    say(`proposed ${path.basename(stepsFile)}:\n${content}`);

    await vscode.commands.executeCommand('steptix.applyCodeBehind');
    await waitFor('Apply writes the .steps.ts', () => fs.existsSync(stepsFile), 15_000);
    await waitFor(
      'focus returns to the test file after Apply',
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    return content;
  }

  /** Run the applied file; return its statuses and its report's HTML. */
  async function replay({ file, uri }) {
    await vscode.commands.executeCommand('steptix.restartSession');
    await sleep(1_000);
    say(`replaying ${path.basename(file)}`);
    void vscode.commands.executeCommand('steptix.runAll');
    await waitFor('the proving run starts', () => hooks.isRunning(), 60_000);
    await waitFor('the proving run finishes', () => !hooks.isRunning(), 1_200_000);
    const snap = hooks.tracker.snapshotFor(uri);
    const statuses = Object.fromEntries(snap ? snap.statuses : []);
    say(`replay statuses: ${JSON.stringify(statuses)}`);
    const reportPath = hooks.lastReportPath();
    assert.ok(reportPath && fs.existsSync(reportPath), `report must exist: ${reportPath}`);
    return { statuses, html: fs.readFileSync(reportPath, 'utf8'), reportPath };
  }

  it('control-flow.md: the If, the While and the Repeat compile to conditions, and the replay decides every one in code', async () => {
    const target = await open('control-flow.md');
    const { line, text } = resolveSteps(target.file, [
      ['navigate', null, 'Navigate to control-flow.html'],
      ['ifCash', null, 'If the Cash checkbox is ticked'],
      ['otherwise', null, 'Otherwise, Pay by card'],
      ['whileNext', null, 'While the Next button is enabled'],
      ['repeatLoad', null, 'Repeat Click Load more until'],
      ['forEach', null, 'For each {{account}} in {{accounts}}'],
      ['readAccounts', null, 'Read the name of every account'],
      ['nextBody', 'Go to the next page', 'Click the Next button'],
      ['accountBody', 'Check the account', '{{account}}'],
    ]);

    const content = await compileAndApply(target);

    // ── The conditions ──────────────────────────────────────────────────
    // One `condition` entry per condition line, bound by the whole authored
    // line, never a `run`: a `run` on a guard would replace a decision with
    // code that acts.
    for (const key of ['ifCash', 'whileNext', 'repeatLoad']) {
      const blocks = entriesFor(content, text[key]);
      assert.equal(blocks.length, 1, `exactly one entry for "${text[key]}", got ${blocks.length}`);
      assert.match(blocks[0], /\bcondition\s*\(/, `"${text[key]}" must compile to a condition:\n${blocks[0]}`);
      assert.doesNotMatch(blocks[0], /\brun\s*\(/, `"${text[key]}" must not carry a run function`);
    }
    // Nothing to compile on these two lines — no condition, and a list that
    // never asked a model.
    for (const key of ['otherwise', 'forEach']) {
      assert.equal(
        entriesFor(content, text[key]).length,
        0,
        `"${text[key]}" has nothing to compile and must have no entry`,
      );
    }

    // ── The loop bodies: ONE entry per authored line ─────────────────────
    // The While's body ran three times and the Repeat's tail three times; a
    // compile that generated per pass would write three.
    assert.equal(entriesFor(content, text.nextBody).length, 1, 'one entry for the While body line');
    assert.equal(
      entriesFor(content, "'Click Load more'").length + entriesFor(content, '"Click Load more"').length,
      1,
      'one entry for the Repeat tail',
    );
    // The read the For each walks only reads, so it is written from the
    // recording (§6.6): `step.read` with the AI's own fields, not a model's code.
    const readBlocks = entriesFor(content, text.readAccounts);
    assert.equal(readBlocks.length, 1, `exactly one entry for "${text.readAccounts}", got ${readBlocks.length}`);
    assert.match(readBlocks[0], /fromRecording:\s*true/, `"${text.readAccounts}" must be written from the recording:\n${readBlocks[0]}`);
    assert.match(readBlocks[0], /step\.read\(\{[\s\S]*multiple:\s*true[\s\S]*as:\s*'accounts'/, `"${text.readAccounts}" must read every match into {{accounts}}:\n${readBlocks[0]}`);

    // The For each body reads the item per pass — or, if the placeholder rule
    // declined it, says so. What it must never do is carry pass 1's value.
    const accountEntry = entriesFor(content, text.accountBody)[0];
    assert.ok(accountEntry, `no entry for "${text.accountBody}"`);
    if (/ai:\s*true/.test(accountEntry)) {
      say(`the For each body was kept as AI: ${accountEntry.split('\n').slice(0, 3).join(' ')}`);
    } else {
      assert.match(accountEntry, /getVar\(\s*['"`]account['"`]\s*\)/, 'the body must read {{account}} per pass');
      for (const name of ['Everyday', 'Savings', 'Travel']) {
        assert.ok(!accountEntry.includes(name), `the body entry inlined the pass value "${name}"`);
      }
    }

    // ── The replay ──────────────────────────────────────────────────────
    const { statuses, html, reportPath } = await replay(target);
    assert.equal(hooks.lastDoneStatus(), 'passed', 'the compiled run must pass');
    assert.ok(passed(statuses[line.navigate]), 'step 1 ran');

    // THE assertion. The guard line's final mark is its LAST visit's, and a
    // heal discards the entry for the rest of the run — so a code mark on a
    // loop line means every visit was decided in code. The If's section tail
    // pops on the same line afterwards; its ✓ must not paint over the mark.
    for (const key of ['ifCash', 'whileNext', 'repeatLoad']) {
      assert.equal(
        statuses[line[key]],
        'pass-code-behind',
        `"${text[key]}" must be decided by its condition entry on the replay, got ` +
          `"${statuses[line[key]]}" (plain "pass" = the model decided; "pass-stale" = the code threw)`,
      );
    }
    assert.equal(statuses[line.otherwise], 'skip', 'the untaken Otherwise stays ◌');

    // No model was asked to decide anything.
    const judgeCalls = judgeCallsIn(html);
    say(`report ${reportPath}: ${judgeCalls} condition-judge call(s)`);
    assert.equal(judgeCalls, 0, 'the replay report must hold no condition-judge call');

    // And the loops ran exactly as often as the page allows — a condition that
    // answered wrongly shows up here as a wrong count. These two counts are
    // decided by the compiled `While` and `Repeat` conditions, which is what
    // this file exists to prove, so they stay strict.
    const bands = reportBands(html);
    say(`bands: ${JSON.stringify(bands)}`);
    const passesOf = (label) => bands.filter((b) => b.label === label).map((b) => `${b.index}/${b.count}`);
    for (const label of ['Go to the next page', 'Click Load more']) {
      assert.deepEqual(passesOf(label), ['1/3', '2/3', '3/3'], `"${label}" must run exactly three passes on the replay`);
    }
    // The `For each`'s count is not decided by any condition: it is the length
    // of the list the compiled READ stored (step 11, "Read the name of every
    // account … [store as: accounts]"). That count used to be a warning,
    // because it measured a model's selector — one compile read each row's
    // spans and stored nine values. That step only reads, so its entry is now
    // written from the recording with no model
    // (docs/specs/SPEC-codebehind-robustness.md §6.6): the AI's own read, run
    // again, which on the same page stores the same three names. So it is an
    // assertion.
    const readEntry = entriesFor(content, text.readAccounts)[0] ?? '(no entry was proposed for it)';
    assert.deepEqual(
      passesOf('Check the account'),
      ['1/3', '2/3', '3/3'],
      `"For each {{account}} in {{accounts}}" must run three passes on the replay. The list came from ` +
        `step 11 ("${text.readAccounts}"), whose entry was:\n  source:${readEntry}`,
    );
  });

  it('control-flow-otherwise.md: an If and an Else if that both answer false in code fall through to Otherwise', async () => {
    const target = await open('control-flow-otherwise.md');
    const { line, text } = resolveSteps(target.file, [
      ['ifCash', null, 'If the Cash checkbox is ticked'],
      ['elseIf', null, 'Else if the Pay now button is enabled'],
      ['otherwise', null, 'Otherwise, Pay by card'],
      ['verify', null, 'Verify the Payment method panel says "Paid by card"'],
    ]);

    const content = await compileAndApply(target);
    for (const key of ['ifCash', 'elseIf']) {
      const blocks = entriesFor(content, text[key]);
      assert.equal(blocks.length, 1, `exactly one entry for "${text[key]}"`);
      assert.match(blocks[0], /\bcondition\s*\(/, `"${text[key]}" must compile to a condition`);
    }
    assert.equal(entriesFor(content, text.otherwise).length, 0, 'Otherwise has nothing to compile');

    const { statuses, html } = await replay(target);
    assert.equal(hooks.lastDoneStatus(), 'passed', 'the compiled run must pass');
    assert.equal(statuses[line.ifCash], 'skip', 'the If did not hold');
    assert.equal(statuses[line.elseIf], 'skip', 'the Else if did not hold');
    assert.equal(
      statuses[line.otherwise],
      'pass-code-behind',
      `the chain fell through to Otherwise on code's answers — its line must wear the code mark, got "${statuses[line.otherwise]}"`,
    );
    assert.ok(passed(statuses[line.verify]), 'the card branch really ran');
    assert.equal(judgeCallsIn(html), 0, 'the replay report must hold no condition-judge call');

    await vscode.commands.executeCommand('steptix.restartSession');
  });
});
