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

const EXT_ID = 'pkent.testbench';
const FIXTURES_DIR =
  process.env.TESTBENCH_FIXTURES_DIR ||
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

describe('TestBench batch-run mode', function () {
  this.timeout(30_000);

  /** @type {FakeApiClient} */
  let fake;
  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
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

  it('forceFreshSession: closeSession fires before EVERY test in a batch (not just the first)', async () => {
    await runBatchWithScript(
      hooks,
      fake,
      [fixtureUri('batch-a.tmp.md'), fixtureUri('batch-b.tmp.md')],
      [
        async (f) => { f.push({ type: 'step:start', line: 4 }); f.push({ type: 'step:pass', line: 4 }); f.end(); },
        async (f) => { f.push({ type: 'step:start', line: 4 }); f.push({ type: 'step:pass', line: 4 }); f.end(); },
      ],
    );

    assert.equal(
      fake.closeSessionCalls,
      2,
      `closeSession should fire once per batch test. Got ${fake.closeSessionCalls}.`,
    );
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
});
