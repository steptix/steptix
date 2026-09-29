/**
 * End-to-end tests for the Test Explorer batch run path. Each test drives
 * runBatchByUris via __testHooks (same code path as the VS Code Run
 * button in the Testing sidebar) with a FakeApiClient providing scripted
 * server responses.
 *
 * Fixture .md files are written once in `before` so they're picked up by
 * the initial discovery scan — avoids FileSystemWatcher timing flakes on
 * Windows for files created mid-test.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { FakeApiClient } = require('../fakes/fake-api-client.cjs');

const EXT_ID = 'pkent.steptix-vscode';
const FIXTURES_DIR =
  process.env.STEPTIX_FIXTURES_DIR ||
  path.resolve(__dirname, '..', 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await predicate()) return; } catch { /* retry */ }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

// Fixture file contents. Lines are 1-based for clarity:
//
//   line 1: '# <heading>'
//   line 2: ''
//   line 3: '## Steps'
//   line 4: '1. <instruction>'
//   line 5: ''
//
// → the single step is on line 4.

const PASS_FIXTURE = ['# Pass test', '', '## Steps', '1. Navigate to https://example.com', ''].join('\n');
const FAIL_FIXTURE = ['# Fail test', '', '## Steps', '1. Do something that fails', ''].join('\n');
const A_FIXTURE = ['# Test A', '', '## Steps', '1. step a', ''].join('\n');
const B_FIXTURE = ['# Test B', '', '## Steps', '1. step b', ''].join('\n');
const INTERACTIVE_FIXTURE = [
  '# Interactive in batch',
  '',
  '## Steps',
  '1. Navigate to https://example.com',
  '2. [interactive]',
  '3. Verify something',
  '',
].join('\n');
const SKILL_FIXTURE = ['---', 'type: skill', '---', '# Skill', '', '## Steps', '1. do skill thing', ''].join('\n');
const DISABLED_FIXTURE = ['---', 'disabled: true', '---', '# Disabled', '', '## Steps', '1. nothing', ''].join('\n');
const TAGGED_FIXTURE = [
  '---',
  'tags: [Smoke, slow]',
  '---',
  '# Tagged test',
  '',
  '## Steps',
  '1. just a step',
  '',
].join('\n');
const NO_HEADING_FIXTURE = ['## Steps', '1. step without title', ''].join('\n');

// A data-driven test: the table under `## Steps` makes the Explorer's ONE
// item run its step once per row. Lines: 3 the heading, 4 the table header,
// 5 the delimiter, 6/7 the rows, 9 the step.
const ROWS_FIXTURE = [
  '# Batch rows',
  '',
  '## Steps',
  '| email |',
  '|-------|',
  '| a@b.c |',
  '| d@e.f |',
  '',
  '1. Enter {{email}}',
  '',
].join('\n');

/** All tmp fixtures the suite writes. Cleaned up in `after`. */
const FIXTURES = {
  'batch-pass.tmp.md': PASS_FIXTURE,
  'batch-fail.tmp.md': FAIL_FIXTURE,
  'batch-a.tmp.md': A_FIXTURE,
  'batch-b.tmp.md': B_FIXTURE,
  'batch-interactive.tmp.md': INTERACTIVE_FIXTURE,
  'skill-fixture.tmp.md': SKILL_FIXTURE,
  'disabled-fixture.tmp.md': DISABLED_FIXTURE,
  'tagged-fixture.tmp.md': TAGGED_FIXTURE,
  'no-heading-fixture.tmp.md': NO_HEADING_FIXTURE,
  'batch-rows.tmp.md': ROWS_FIXTURE,
};

const fixtureUri = (name) => vscode.Uri.file(path.resolve(FIXTURES_DIR, name));

/**
 * Run a batch with pre-scripted stream events. Each entry in
 * `streamScripts` is called when its stream opens (no polling races).
 */
async function runBatchWithScript(hooks, fake, uris, streamScripts) {
  fake.streamScripts = streamScripts;
  return hooks.runBatchByUris(uris);
}

describe('Steptix batch-run mode', function () {
  this.timeout(30_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').SteptixTestHooks} */
  let hooks;

  before(async () => {
    // Write every fixture before extension activation so the initial
    // discovery scan picks them all up — no FileSystemWatcher race.
    for (const [name, content] of Object.entries(FIXTURES)) {
      fs.writeFileSync(path.resolve(FIXTURES_DIR, name), content);
    }

    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `${EXT_ID} not loaded`);
    if (!ext.isActive) await ext.activate();
    hooks = ext.exports?.__testHooks;
    assert.ok(hooks, '__testHooks not exposed');
    await hooks.discoveryReady();
    // The discovery in tests/integration/fixtures sees a global initial
    // scan; force a refresh in case some fixtures were written too late
    // to be in that pass.
    await hooks.discoveryRefresh();
  });

  after(() => {
    for (const name of Object.keys(FIXTURES)) {
      try { fs.unlinkSync(path.resolve(FIXTURES_DIR, name)); } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    fake = new FakeApiClient();
    hooks.setApiClientFactory(() => fake);
  });

  it('discovery: files with ## Steps are eligible; plain markdown is not', () => {
    const tests = hooks.discoveredTests();
    const filenames = tests.map((t) => t.uri.split('/').pop());
    assert.ok(filenames.includes('test-with-steps.md'), `expected test-with-steps.md in ${filenames.join(', ')}`);
    assert.ok(!filenames.includes('plain.md'), 'plain.md has no ## Steps — must not appear');
    assert.ok(filenames.includes('batch-pass.tmp.md'), 'pass fixture must be discovered');
    assert.ok(filenames.includes('batch-fail.tmp.md'), 'fail fixture must be discovered');
  });

  it('discovery: type: skill and disabled: true are excluded', () => {
    const filenames = hooks.discoveredTests().map((t) => t.uri.split('/').pop());
    assert.ok(!filenames.includes('skill-fixture.tmp.md'), 'skill must be excluded');
    assert.ok(!filenames.includes('disabled-fixture.tmp.md'), 'disabled must be excluded');
  });

  it('TestController.items matches discovery cache after resolveHandler runs', async () => {
    // Guards the 0.3.3 bug: discovery had every test in the cache but the
    // VS Code TestController.items collection only had the one that
    // happened to land before VS Code's first render, because the
    // resolveHandler returned without adding anything synchronously. The
    // user saw only one test in the Test Explorer.
    //
    // Contract: after the resolveHandler completes, the controller's
    // items collection (what the explorer renders) must match the
    // discovery cache 1:1 for eligible tests.
    await hooks.triggerInitialResolve();
    const discovered = new Set(hooks.discoveredTests().map((t) => t.uri));
    const inTree = new Set(hooks.controllerItemIds());
    assert.deepEqual(
      inTree,
      discovered,
      `controller.items diverged from discovery cache.\n  in tree: ${[...inTree].join(', ')}\n  discovered: ${[...discovered].join(', ')}`,
    );
    // Sanity: more than one — the regression scenario was that exactly one
    // file showed up.
    assert.ok(
      inTree.size > 1,
      `expected multiple tests in the tree; got ${inTree.size}`,
    );
  });

  it('TestItem label includes "# Heading (filename.md)" when the file has a top-level heading', () => {
    const uri = fixtureUri('tagged-fixture.tmp.md');
    const meta = hooks.testItemMetadata(uri);
    assert.ok(meta, 'tagged fixture must have a TestItem');
    assert.equal(meta.label, 'Tagged test (tagged-fixture.tmp.md)');
  });

  it('TestItem label falls back to filename when no top-level heading is present', () => {
    const uri = fixtureUri('no-heading-fixture.tmp.md');
    const meta = hooks.testItemMetadata(uri);
    assert.ok(meta, 'no-heading fixture must have a TestItem');
    assert.equal(meta.label, 'no-heading-fixture.tmp.md');
  });

  it('TestItem description shows workspace-relative path for disambiguation', () => {
    const uri = fixtureUri('batch-pass.tmp.md');
    const meta = hooks.testItemMetadata(uri);
    assert.ok(meta, 'batch-pass fixture must have a TestItem');
    assert.ok(
      meta.description.endsWith('batch-pass.tmp.md'),
      `expected workspace-relative path ending in batch-pass.tmp.md, got ${meta.description}`,
    );
    // Should NOT be an absolute path with a drive letter / leading slash.
    assert.ok(
      !/^[A-Za-z]:|^\//.test(meta.description),
      `description should be relative, got ${meta.description}`,
    );
  });

  it('TestItem tags are populated from frontmatter and lowercased', () => {
    const uri = fixtureUri('tagged-fixture.tmp.md');
    const meta = hooks.testItemMetadata(uri);
    assert.ok(meta, 'tagged fixture must have a TestItem');
    // Frontmatter `tags: [Smoke, slow]` → normalized lowercase, both
    // present, order-insensitive.
    assert.deepEqual(
      new Set(meta.tags),
      new Set(['smoke', 'slow']),
      `expected tags [smoke, slow] on TestItem, got [${meta.tags.join(', ')}]`,
    );
  });

  it('TestItem disappears from controller.items when frontmatter flips to disabled', async () => {
    const uri = fixtureUri('batch-pass.tmp.md');
    const originalContent = fs.readFileSync(uri.fsPath, 'utf8');

    try {
      // Sanity: present before the edit.
      assert.ok(
        hooks.controllerItemIds().includes(uri.toString()),
        'batch-pass fixture must be in the tree to start',
      );

      // Flip it to disabled and refresh discovery.
      fs.writeFileSync(
        uri.fsPath,
        '---\ndisabled: true\n---\n' + originalContent,
      );
      await hooks.discoveryRefresh();

      assert.ok(
        !hooks.controllerItemIds().includes(uri.toString()),
        'batch-pass fixture must be removed from the tree once disabled',
      );
    } finally {
      fs.writeFileSync(uri.fsPath, originalContent);
      await hooks.discoveryRefresh();
    }
  });

  it('batch run reports pass + fail counts and continues after a failure', async () => {
    const passUri = fixtureUri('batch-pass.tmp.md');
    const failUri = fixtureUri('batch-fail.tmp.md');

    // Sanity: the discovery cache must have both fixtures with the IDs we
    // expect. If runByUris finds 0 items, the batch silently runs 0 tests
    // and our driver hangs forever.
    const known = hooks.discoveredTests().map((t) => t.uri);
    assert.ok(
      known.includes(passUri.toString()),
      `discovery missing pass fixture. Known: ${known.join('\n  ')}`,
    );
    assert.ok(
      known.includes(failUri.toString()),
      `discovery missing fail fixture. Known: ${known.join('\n  ')}`,
    );

    const counts = await runBatchWithScript(
      hooks,
      fake,
      [passUri, failUri],
      [
        async (f) => {
          f.push({ type: 'step:start', line: 4 });
          f.push({ type: 'step:pass', line: 4 });
          f.end();
        },
        async (f) => {
          f.push({ type: 'step:start', line: 4 });
          f.push({ type: 'step:fail', line: 4, error: 'simulated failure' });
          f.end();
        },
      ],
    );

    assert.equal(
      fake.streamCallCount,
      2,
      `streamSteps must be called once per batch test. requests=${JSON.stringify(fake.requests.map((r) => r.sourceLines))}`,
    );
    assert.equal(counts.passed, 1, `one test should pass. Got ${JSON.stringify(counts)}`);
    assert.equal(counts.failed, 1, 'one test should fail');
    assert.equal(counts.skipped, 0, 'none should be skipped');
  });

  it('each batch test runs in a unique per-run session, closed after it finishes', async () => {
    await runBatchWithScript(
      hooks,
      fake,
      [fixtureUri('batch-a.tmp.md'), fixtureUri('batch-b.tmp.md')],
      [
        async (f) => { f.push({ type: 'step:start', line: 4 }); f.push({ type: 'step:pass', line: 4 }); f.end(); },
        async (f) => { f.push({ type: 'step:start', line: 4 }); f.push({ type: 'step:pass', line: 4 }); f.end(); },
      ],
    );

    // Batch runs use a unique per-run session id (`<path>::run-N`), so each test
    // is its own server session — and two runs of the SAME file would be two
    // sessions too (Case 2). No interactive-style pre-close fires for batch.
    assert.equal(fake.streamSessionIds.length, 2, 'expected one run per test');
    for (const sid of fake.streamSessionIds) {
      assert.match(sid, /::run-\d+$/, `batch run session id should be unique-per-run, got ${sid}`);
    }
    assert.notEqual(
      fake.streamSessionIds[0],
      fake.streamSessionIds[1],
      'the two batch tests must use DISTINCT session ids',
    );

    // One close per test — the post-run close (finalises video, frees browser),
    // targeting that test's exact unique session id. No pre-close for batch.
    assert.equal(
      fake.closeSessionCalls,
      2,
      `closeSession should fire once per batch test (post-run only). Got ${fake.closeSessionCalls}.`,
    );
    assert.deepEqual(
      [...fake.closeSessionIds].sort(),
      [...fake.streamSessionIds].sort(),
      'each run session must be closed by its own id',
    );
  });

  it('two batch runs of the SAME file are two distinct sessions (Case 2)', async () => {
    // The whole point of the unique per-run id: running ONE file twice must
    // produce TWO sessions (e.g. a future data-driven / repeat-N batch). Here
    // the same uri is batched twice; the monotonic `::run-N` suffix is the only
    // thing distinguishing the two ids (same file path), so this is what proves
    // the generation suffix actually does the work — not just different paths.
    const uri = fixtureUri('batch-a.tmp.md');
    const pass = async (f) => {
      f.push({ type: 'step:start', line: 4 });
      f.push({ type: 'step:pass', line: 4 });
      f.end();
    };
    // One script per run — the fake indexes streamScripts by call count, which
    // accumulates across the two runBatchByUris calls.
    fake.streamScripts = [pass, pass];
    await hooks.runBatchByUris([uri]); // run #1
    await hooks.runBatchByUris([uri]); // run #2

    assert.equal(fake.streamSessionIds.length, 2, 'the same file ran twice');
    for (const sid of fake.streamSessionIds) {
      assert.match(sid, /::run-\d+$/, `expected a unique-per-run batch id, got ${sid}`);
    }
    assert.notEqual(
      fake.streamSessionIds[0],
      fake.streamSessionIds[1],
      'two batch runs of the SAME file must be two DISTINCT sessions (Case 2)',
    );
  });

  it('a flask run does NOT touch the editor surface (no decorations, no stuck Pause/Stop)', async () => {
    // Regression: the flask runner used to reuse the EDITOR's RunController, so
    // a batch run painted gutter statuses on the open file AND pinned the
    // `steptix.running` context key TRUE — the key is only refreshed on
    // the `done` event, which fires while the controller's `active` is still set
    // (inside runLines' try-block), so it latched true and nothing in the batch
    // path ever flipped it back. The visible symptom was the editor title-bar
    // Pause/Stop buttons staying enabled after a flask run. The batch runner now
    // uses a DETACHED, headless controller (getBatchController), so a flask run
    // drives none of the editor surface.
    const uri = fixtureUri('batch-pass.tmp.md');

    // Precondition: nothing running, the editor "running" key is false.
    assert.equal(
      hooks.runningContextValue(),
      false,
      'precondition: running context key should be false before the run',
    );

    const counts = await runBatchWithScript(
      hooks,
      fake,
      [uri],
      [
        async (f) => {
          f.push({ type: 'step:start', line: 4 });
          f.push({ type: 'step:pass', line: 4 });
          f.end();
        },
      ],
    );

    // The run still produces a result through the Test Explorer channel.
    assert.equal(counts.passed, 1, `the flask run should still pass. Got ${JSON.stringify(counts)}`);

    // The editor "running" context key gates the title-bar Pause/Stop buttons
    // (package.json `when: steptix.running`). A flask run must leave it
    // false — with the old shared-controller path this latched TRUE and stuck.
    assert.equal(
      hooks.runningContextValue(),
      false,
      'a flask run must NOT pin the running context key (else Pause/Stop stay enabled)',
    );

    // And it must paint no gutter decorations: the tracker has no per-URI run
    // state for the file (snapshotFor returns null when nothing was painted).
    assert.equal(
      hooks.tracker.snapshotFor(uri),
      null,
      'a flask run must NOT paint gutter decorations on the editor',
    );
  });

  it('a second flask run QUEUES behind the first instead of being refused', async () => {
    // A run requested while another batch is in flight used to be refused (a
    // status-bar "a run is already in flight" and nothing ran). It now QUEUES:
    // both runs execute, one after another. We fire two runs WITHOUT awaiting
    // the first, so the second arrives mid-flight, then await both.
    const uriA = fixtureUri('batch-a.tmp.md');
    const uriB = fixtureUri('batch-b.tmp.md');
    const pass = async (f) => {
      f.push({ type: 'step:start', line: 4 });
      f.push({ type: 'step:pass', line: 4 });
      f.end();
    };
    // One script per run, indexed by the fake's global stream-call count.
    fake.streamScripts = [pass, pass];

    const p1 = hooks.runBatchByUris([uriA]);
    const p2 = hooks.runBatchByUris([uriB]); // arrives while run #1 is in flight
    const [c1, c2] = await Promise.all([p1, p2]);

    // BOTH ran (the old behavior would have refused the second → 0 tests / no
    // second stream). Each reports its own pass.
    assert.equal(c1.passed, 1, `first queued run should pass. Got ${JSON.stringify(c1)}`);
    assert.equal(c2.passed, 1, `second queued run must ALSO run (not be refused) and pass. Got ${JSON.stringify(c2)}`);
    assert.equal(
      fake.streamCallCount,
      2,
      `both runs must execute — proves queueing, not refusal. Got ${fake.streamCallCount} stream(s).`,
    );

    // Serialized, never overlapping: each run opened+closed its own unique
    // session. (If they had run concurrently they'd have clobbered the fake's
    // single activeStream and the pass events would have gone to the wrong run.)
    assert.equal(fake.closeSessionCalls, 2, 'each queued run closes its own session');
    assert.equal(
      new Set(fake.streamSessionIds).size,
      2,
      `the two queued runs must use distinct sessions. Got ${JSON.stringify(fake.streamSessionIds)}`,
    );
  });

  it('streams step output to Test Results LIVE during the run (not buffered until the end)', async () => {
    // Regression: output used to be buffered into an array and flushed via a
    // single run.appendOutput AFTER runLines resolved, so the Test Results
    // panel stayed empty until the test finished. Now each line streams as its
    // event arrives. We prove it by snapshotting the streamed output WHILE the
    // stream is still open — if the step lines are already there, they were
    // emitted mid-run, not flushed at the end.
    const uri = fixtureUri('batch-pass.tmp.md');
    let midRunOutput = null;
    fake.streamScripts = [
      async (f) => {
        f.push({ type: 'step:start', line: 4 });
        f.push({ type: 'step:pass', line: 4 });
        // Wait for the extension to process those events and stream their
        // output, THEN capture it — all while the stream is still open.
        await waitFor('step output streamed mid-run', () =>
          hooks.batchOutput().some((l) => l.includes('step on line 4')),
        );
        midRunOutput = hooks.batchOutput();
        f.end();
      },
    ];

    const counts = await hooks.runBatchByUris([uri]);

    assert.equal(counts.passed, 1, `the run should pass. Got ${JSON.stringify(counts)}`);
    assert.ok(midRunOutput, 'output must have been captured while the run was still in flight');
    assert.ok(
      midRunOutput.some((l) => l.includes('▶ step on line 4')),
      `live output must include the step:start line BEFORE the stream ended. Got ${JSON.stringify(midRunOutput)}`,
    );
    assert.ok(
      midRunOutput.some((l) => l.includes('✓ step on line 4 passed')),
      `live output must include the step:pass line mid-run. Got ${JSON.stringify(midRunOutput)}`,
    );
  });

  // ── Where a failure is anchored ─────────────────────────────────────────
  //
  // A run that descends into a `[skill: ...]` reports its body steps with
  // lines in the SKILL's file. Test Explorer anchored every TestMessage on
  // the test file's URI, so an in-skill failure pointed at that line number
  // in the test — prose, an unrelated step, or (as below) past the end of a
  // shorter file. The line is only meaningful together with its frame.
  it('anchors an in-skill failure at the SKILL file, not that line of the test', async () => {
    const uri = fixtureUri('batch-fail.tmp.md');
    // The path the SERVER would send (a plain fsPath from Node), and the same
    // path as VS Code canonicalises it. They differ on Windows — `Uri.file`
    // lowercases the drive letter — so the assertion compares the canonical
    // form, which is what "same file" actually means here.
    const skillPath = path.resolve(FIXTURES_DIR, 'skill-fixture.tmp.md');
    const skillCanonical = vscode.Uri.file(skillPath).fsPath;
    // The test fixture is 5 lines; the skill's step is on line 7. Anchoring
    // line 7 on the test file would land past its end — which is exactly the
    // bug, and why this fixture pairing is the one to assert on.
    const counts = await runBatchWithScript(hooks, fake, [uri], [
      async (f) => {
        f.push({
          type: 'step:fail',
          line: 7,
          error: 'no such button',
          frame: { id: 'f1', parentId: null, kind: 'skill', uri: skillPath, line: 4, skillName: 'skill-fixture' },
        });
        f.end();
      },
    ]);

    assert.equal(counts.failed, 1, `the test should fail. Got ${JSON.stringify(counts)}`);
    const messages = hooks.batchFailureMessages();
    const anchored = messages.find((m) => m.text.includes('no such button'));
    assert.ok(anchored, `the failure message must survive. Got ${JSON.stringify(messages)}`);
    assert.equal(
      anchored.file,
      skillCanonical,
      `the failure must peek at the skill file the line belongs to. ` +
        `actual=${anchored.file} expected=${skillCanonical}`,
    );
    assert.notEqual(
      anchored.file,
      uri.fsPath,
      'and must NOT be anchored on the test file — line 7 is past its end',
    );
    assert.equal(anchored.line, 7, 'and at the line the skill reported');

    // The streamed line has no gutter to disambiguate it, so it names the
    // file too — "line 7" alone is unreadable when it isn't this test's.
    assert.ok(
      hooks.batchOutput().some((l) => l.includes('line 7 of skill-fixture.tmp.md')),
      `output must name the skill file. Got ${JSON.stringify(hooks.batchOutput())}`,
    );
  });

  it('still anchors a plain failure on the test file itself', async () => {
    // The frame-less case (and the `kind: 'test'` case) must be untouched:
    // resolution only kicks in when the frame names a different file.
    const uri = fixtureUri('batch-fail.tmp.md');
    const counts = await runBatchWithScript(hooks, fake, [uri], [
      async (f) => {
        f.push({ type: 'step:fail', line: 4, error: 'simulated failure' });
        f.end();
      },
    ]);

    assert.equal(counts.failed, 1, `the test should fail. Got ${JSON.stringify(counts)}`);
    const anchored = hooks
      .batchFailureMessages()
      .find((m) => m.text.includes('simulated failure'));
    assert.ok(anchored, 'the failure message must survive');
    assert.equal(anchored.file, uri.fsPath, 'a frame-less failure stays on the test file');
    assert.equal(anchored.line, 4);
    // And no file qualifier, because there is nothing to disambiguate.
    assert.ok(
      hooks.batchOutput().some((l) => l.includes('✗ step on line 4 failed')),
      `Got ${JSON.stringify(hooks.batchOutput())}`,
    );
  });

  it('a server error (done: error with no step:fail) FAILS the test, not passes', async () => {
    // Regression: runStepBlock returned `!sawFail` and only set `sawFail` on a
    // step:fail event, ignoring the done event's status. A session-setup error
    // (e.g. an invalid baseUrl) arrives as output:error + done:'error' with NO
    // step:fail, so the block "passed" and the test was marked GREEN. It must
    // now fail.
    const uri = fixtureUri('batch-pass.tmp.md');
    const counts = await runBatchWithScript(
      hooks,
      fake,
      [uri],
      [
        async (f) => {
          f.push({
            type: 'output',
            kind: 'error',
            msg: 'Server error: page.goto: Cannot navigate to invalid URL "${env.BASE_URL}"',
          });
          f.push({ type: 'done', status: 'error' });
          f.end();
        },
      ],
    );

    assert.equal(counts.failed, 1, `a server error must FAIL the test. Got ${JSON.stringify(counts)}`);
    assert.equal(counts.passed, 0, 'the test must NOT be marked passed on a server error');
  });

  it('batch mode auto-fails [interactive] steps with file:line in the message', async () => {
    const counts = await runBatchWithScript(
      hooks,
      fake,
      [fixtureUri('batch-interactive.tmp.md')],
      [
        async (f) => {
          // Step 1 (line 4) passes; controller then walks into the
          // interactive step (line 5) which in batch mode auto-fails
          // without prompting.
          f.push({ type: 'step:start', line: 4 });
          f.push({ type: 'step:pass', line: 4 });
          f.end();
        },
      ],
    );

    assert.equal(counts.failed, 1, 'interactive in batch must fail the test');
    assert.equal(counts.passed, 0);
  });

  it('prefixes a failure with the row it happened on', async () => {
    // The Explorer keeps ONE item per file and runs every row, so five rows
    // failing step 6 read as five identical messages with nothing to tell
    // them apart (stories/data-row-progress-and-selection.md §What does not
    // change). The row comes off the controller: the events carry none.
    const counts = await runBatchWithScript(
      hooks,
      fake,
      [fixtureUri('batch-rows.tmp.md')],
      [
        async (f) => {
          f.push({ type: 'step:fail', line: 9, error: 'no such field' });
          f.end();
        },
        async (f) => {
          f.push({ type: 'step:fail', line: 9, error: 'no such field' });
          f.end();
        },
      ],
    );

    assert.equal(counts.failed, 1, 'one item, however many rows');
    const messages = hooks.batchFailureMessages().map((m) => m.text);
    assert.deepEqual(
      messages,
      ['(row 1) no such field', '(row 2) no such field'],
      `the two rows must be distinguishable. Got ${JSON.stringify(messages)}`,
    );
    // In the streamed line the row belongs with the WHERE, not with the why:
    // `✗ step on line 9 (row 1) failed — no such field` is one sentence, while
    // `failed — (row 1) no such field` reads as if the row were part of the
    // error text.
    const emitted = hooks.batchOutput().filter((l) => l.includes('step on line 9'));
    assert.ok(
      emitted.some((l) => l.includes('✗ step on line 9 (row 1) failed — no such field')),
      `the row names the location, not the error. Got ${JSON.stringify(emitted)}`,
    );
  });

  it('leaves a failure on a test with no table unprefixed', async () => {
    // The regression guard: `(row N)` appears only inside a row loop.
    await runBatchWithScript(hooks, fake, [fixtureUri('batch-fail.tmp.md')], [
      async (f) => {
        f.push({ type: 'step:fail', line: 4, error: 'simulated failure' });
        f.end();
      },
    ]);
    assert.deepEqual(
      hooks.batchFailureMessages().map((m) => m.text),
      ['simulated failure'],
    );
  });
});
