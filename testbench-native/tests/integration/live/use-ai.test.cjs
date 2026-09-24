/**
 * Live end-to-end test for the `[use ai]` step (stories/use-ai-step.md,
 * Tests → Live): a step whose text goes to the model with no page, whose reply
 * is stored as a variable, and which is asked again on EVERY run.
 *
 * The fixture (templates/init/tests/use-ai-live.md) runs twice with the step
 * cache ON. What only a live run can say, with the real model behind it:
 *
 *  - a value named in the author's prose ("…and store it in random_name") and
 *    one pinned by `[store as: days_from_now]` both reach later steps: a `Set`
 *    joins them, a page step types the result into the sign-in page's Email
 *    address field, and a read brings it back unchanged;
 *  - the two values reach the client as `capture` events with
 *    `source: 'generated'`, and the report shows them in each row's ◆ Captured
 *    box;
 *  - the second run asks the model again. The `[use ai]` lines paint a plain
 *    ✓ both times, never ⚡ (`pass-cached`) or </> (`pass-code-behind`), their
 *    report rows carry a fresh `use-ai` model call, and no cache file is ever
 *    written for them. The control is what makes that mean anything: the
 *    navigate step and the closing title check DO replay ⚡ on the second run,
 *    so the cache really was on;
 *  - a `[use ai]` step with a `{{placeholder}}` nothing set fails before any
 *    model call (no turn in its report row), its `otherwise continue` tail
 *    makes the failure amber, and the run carries on to a green end.
 *
 * The model's values are checked by SHAPE only (`AUTO` + four digits, eight
 * digits). A wrong date from correct inputs is the model's arithmetic, not a
 * framework defect, so whether `days_from_now` is 20260927 is logged, not
 * asserted.
 *
 * Why live: the vitest layer drives the shared runner with a fake AiClient and
 * the server at the HTTP seam, which proves the wiring but not that a real
 * model's reply lands in a real variable that a real browser then types, nor
 * that two real runs through TestBench's cache switch behave as the story
 * promises.
 *
 * Prereq: the API server on $LIVE_SERVER_URL (the parallel runner starts one
 * per shard and points that shard's templates/.env at it) and the fixture app
 * on :8787 (runLiveTest.cjs boots it; this file starts it if nothing is there).
 *
 * Run it alone with:
 *   cd testbench-native
 *   npm run test:live -- --files=use-ai.test.cjs --shards=2
 *
 * If your shell drops the bare `--` (the PowerShell tool does), build and call
 * the runner directly: `npm run build`, then
 * `node tests/integration/runLiveTest.cjs --files=use-ai.test.cjs --shards=2`.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'pkent.testbench-native';
const TEST_APP_PORT = 8787;
const FIXTURE = 'use-ai-live.md';

// templates/init/tests/use-ai-live.md. Line numbers are hardcoded — the tracker,
// the capture events, the run log and the cache files are all keyed on LINE, not
// step number — and PINNED to the file by `pinFixture` below, which is the only
// reason hardcoding is safe here. (failure-outcomes.test.cjs's convention.)
const STEPS = [
  { n: 1, line: 31, text: '1. Navigate to the baseUrl' },
  {
    n: 2,
    line: 32,
    text:
      '2. [use ai] Create a name starting with "AUTO" and ending with a random 4 ' +
      'digit number and store it in random_name',
  },
  {
    n: 3,
    line: 33,
    text:
      '3. [use ai] Today is {{today}}. Give the date 3 days later formatted as ' +
      'yyyymmdd [store as: days_from_now]',
  },
  { n: 4, line: 34, text: '4. Set {{login_name}} to "{{random_name}}-{{days_from_now}}@example.com"' },
  { n: 5, line: 35, text: '5. Enter {{login_name}} in the Email address field' },
  { n: 6, line: 36, text: '6. Read the value of the Email address field [store as: typed_back]' },
  {
    n: 7,
    line: 42,
    text:
      '7. [use ai] Greet {{nobody_set_this}} and store it in greeting otherwise ' +
      'continue with warning "no greeting"',
  },
  { n: 8, line: 43, text: '8. Verify the page title contains "Sign In"' },
];

/** The line a 1-based step number sits on. */
const lineOf = (n) => STEPS[n - 1].line;

/** The two `[use ai]` steps that must ask the model and store a value. */
const GENERATED = [
  { n: 2, name: 'random_name', shape: /^AUTO\d{4}$/, rowFragment: 'starting with "AUTO"' },
  { n: 3, name: 'days_from_now', shape: /^\d{8}$/, rowFragment: 'formatted as yyyymmdd' },
];
/** The `[use ai]` step with a placeholder nothing sets. */
const UNRESOLVED = { n: 7, ref: 'nobody_set_this', prose: 'greeting', rowFragment: 'Greet' };
const TOLERATED_WARNING = 'no greeting';
/** Every `[use ai]` line — none may ever have a cache file. */
const USE_AI_STEPS = [2, 3, 7];
/** Ordinary page steps: the model plans them on run 1, the cache may serve run 2. */
const PAGE_STEPS = [1, 5, 6, 8];
/**
 * The cache control. Constant text, no placeholders, the same two shapes
 * cache-replay.test.cjs proves replay (a navigate and a verify), so a ⚡ on
 * both is what shows the cache was ON for run 2 — without it a plain ✓ on the
 * `[use ai]` lines proves nothing. Step 8 also sits AFTER every `[use ai]`
 * step, so its ⚡ says they did not disturb the cache for their neighbours.
 */
const CACHE_CONTROL = [
  { n: 1, rowFragment: 'Navigate to the baseUrl' },
  { n: 8, rowFragment: 'page title contains "Sign In"' },
];
/** The date step 3 asks for, given `today: 2026-09-24`. Logged, never asserted. */
const EXPECTED_DATE = '20260927';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Say what was observed, into the shard's own log as well as stdout — the parallel
 *  runner discards a passing launch's stdout, so only the tee survives the run.
 *  (Borrowed verbatim from failure-outcomes.test.cjs / control-flow.test.cjs.) */
function say(line) {
  console.log(`[live] ${line}`);
  const file = process.env.TESTBENCH_LIVE_LOG;
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
  throw new Error(
    `timeout waiting for: ${label}${last ? ` (last error: ${last.message})` : ''}`,
  );
}

/** Any flavour of pass — for the page steps, whose flavour is not the claim
 *  (except where CACHE_CONTROL says it is). The `[use ai]` lines are held to
 *  exactly `'pass'` instead. */
const PASSED = new Set(['pass', 'pass-cached', 'pass-code-behind', 'pass-stale']);
const passed = (status) => PASSED.has(status);

async function up(url) {
  try {
    const res = await fetch(url);
    return res.status > 0;
  } catch {
    return false;
  }
}

/** The extension's output channel, teed to a file by the live runner. */
function readLiveLog() {
  const file = process.env.TESTBENCH_LIVE_LOG;
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function decodeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every .html in the workspace's reports dir. */
function reportsIn(workspaceRoot) {
  const dir = path.resolve(workspaceRoot, 'init', 'reports');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
}

/** The report header's summary bar, as `{ Steps, Passed, Failed, Tolerated, … }`.
 *  `Tolerated` is `{{#if}}`-guarded, so an ABSENT key means the count was zero
 *  or never set. Token counts are `toLocaleString()`ed, hence the commas. */
function reportStats(html) {
  /** @type {Record<string, number>} */
  const out = {};
  const re = /<span class="number[^"]*">([\d,]+)<\/span>\s*<span class="label">([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) out[m[2].trim()] = Number(m[1].replace(/,/g, ''));
  return out;
}

/**
 * Every rendered step row, header AND body, from one `step-number` to the next:
 *
 *  - `instruction` as the report prints it (SUBSTITUTED), so rows are matched
 *    below on fragments that survive substitution, never on a placeholder;
 *  - `status`, the last badge before the chevron (failure-outcomes.test.cjs);
 *  - `origin`, the ⚡ / </> / ⚠ badge when the step avoided or healed the model;
 *  - `captures`, the ◆ Captured box's name → value pairs (src/report/generator.ts,
 *    `capturesHtml`);
 *  - `turns`, how many `<div class="turn">` the row renders — zero means the step
 *    made no model call and performed no action;
 *  - `aiPurposes`, the `AI — <purpose>` summaries of its model calls;
 *  - `requests`, the first model call's request messages, when the report
 *    carries them.
 */
function reportRows(html) {
  const starts = [...html.matchAll(/<span class="step-number">/g)].map((m) => m.index);
  return starts.map((start, i) => {
    const chunk = html.slice(start, starts[i + 1] ?? html.length);
    const head =
      /^<span class="step-number">([^<]*)<\/span>\s*<span class="step-instruction">([^<]*)<\/span>([\s\S]*?)<span class="step-chevron">/.exec(
        chunk,
      );
    if (!head) {
      return { number: '(unparsed)', instruction: '', status: '(unparsed)', origin: null, captures: {}, turns: 0, aiPurposes: [], requests: [] };
    }
    const badges = [
      ...head[3].matchAll(/<span class="badge ([a-z][\w -]*?)"[^>]*>([^<]*)<\/span>/g),
    ].map((b) => ({ classes: b[1].trim().split(/\s+/), text: decodeHtml(b[2]) }));
    const statusBadge = badges[badges.length - 1];
    const originBadge = badges.find((b) =>
      b.classes.some((c) => c === 'badge-cached' || c === 'badge-codebehind' || c === 'badge-codebehind-stale'),
    );
    const body = chunk.slice(head[0].length);

    /** @type {Record<string, string>} */
    const captures = {};
    const at = body.indexOf('<div class="captures-block">');
    if (at >= 0) {
      // Each row closes `</span></div>` and the list closes right after the last
      // one, so the first `</div></div>` ends the box.
      const end = body.indexOf('</div></div>', at);
      const box = body.slice(at, end < 0 ? undefined : end);
      for (const kv of box.matchAll(
        /<span class="tool-kv-key">([^<]*)<\/span><span class="tool-kv-value">([^<]*)<\/span>/g,
      )) {
        captures[decodeHtml(kv[1])] = decodeHtml(kv[2]);
      }
    }

    const aiPurposes = [...body.matchAll(/<summary>AI — ([^<]*)/g)].map((m) => decodeHtml(m[1]).trim());
    const firstCall = body.indexOf('<details class="ai-response">');
    const nextCall = firstCall < 0 ? -1 : body.indexOf('<details class="ai-response">', firstCall + 1);
    const firstCallHtml = firstCall < 0 ? '' : body.slice(firstCall, nextCall < 0 ? undefined : nextCall);
    const requests = [
      ...firstCallHtml.matchAll(
        /<div class="ai-request-role">\s*<span>([^<]*)<\/span>[\s\S]*?<pre class="ai-request-content">([\s\S]*?)<\/pre>/g,
      ),
    ].map((m) => ({ role: decodeHtml(m[1]).trim(), content: decodeHtml(m[2]) }));

    return {
      number: decodeHtml(head[1]),
      instruction: decodeHtml(head[2]),
      // `✓ PASSED` / `✗ TOLERATED` / `✗ FAILED` -> the word.
      status: statusBadge ? statusBadge.text.replace(/[^A-Z]/g, '') : '(no status badge)',
      origin: originBadge ? originBadge.text : null,
      captures,
      turns: (body.match(/<div class="turn">/g) ?? []).length,
      aiPurposes,
      requests,
    };
  });
}

/** The one report row whose instruction contains `fragment`. */
function rowFor(rows, fragment, label) {
  const found = rows.filter((r) => r.instruction.includes(fragment));
  assert.equal(
    found.length,
    1,
    `${label}: the report must carry exactly one row containing ${JSON.stringify(fragment)}; ` +
      `found ${found.length}. Rows: ${JSON.stringify(rows.map((r) => r.instruction))}`,
  );
  return found[0];
}

/** Pin the constants above to the fixture on disk. Exact equality, not a fragment
 *  match: a reworded step fails HERE, by name, rather than drifting onto its
 *  neighbour and quietly passing. */
function pinFixture(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const s of STEPS) {
    assert.equal(
      lines[s.line - 1],
      s.text,
      `${FIXTURE} line ${s.line} should be step ${s.n} — expected "${s.text}", found ` +
        `"${lines[s.line - 1]}". The line numbers in this test are what the tracker, ` +
        `the capture events and the cache files are keyed by; if the fixture moved, ` +
        `move them deliberately.`,
    );
  }
}

/**
 * This fixture's step-cache directories: `<project>/.cache/<env>/use-ai-live-<hash>`
 * (`cacheDirName` + `envCacheSegment`, src/cache/step-cache.ts). Globbed over the
 * env segment rather than assuming `default`, so a run under a named env is still
 * found.
 */
function fixtureCacheDirs(projectRoot) {
  const base = path.join(projectRoot, '.cache');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const env of fs.readdirSync(base, { withFileTypes: true })) {
    if (!env.isDirectory()) continue;
    const envDir = path.join(base, env.name);
    for (const d of fs.readdirSync(envDir, { withFileTypes: true })) {
      if (d.isDirectory() && d.name.startsWith('use-ai-live-')) out.push(path.join(envDir, d.name));
    }
  }
  return out;
}

/** Every file in this fixture's cache directories, as `<dir-name>/<file>`. */
function fixtureCacheFiles(projectRoot) {
  return fixtureCacheDirs(projectRoot).flatMap((dir) =>
    fs.readdirSync(dir).map((f) => `${path.basename(dir)}/${f}`),
  );
}

/**
 * Cache files keyed to a line that is not a page step. An inline step's entry is
 * `step-<line>.json` (plus `step-<line>-asserts.json` for a verify), per
 * `frameScopedStepKey` in session-manager.ts — so an ALLOW-list of the page
 * steps' lines catches a `[use ai]` entry (or a `Set` one) under any key.
 */
function nonPageCacheFiles(files) {
  const allowed = new Set(PAGE_STEPS.map(lineOf));
  return files.filter((f) => {
    const m = /\/step-(\d+)(?:-asserts)?\.json$/.exec(f);
    return m !== null && !allowed.has(Number(m[1]));
  });
}

/**
 * Collect the run's events as the panel was told them. `capture` events are
 * not written to the run log with their `source` (run-controller.ts logs them as
 * `event capture line=N`), so the host→webview messages are the one place in the
 * harness where the source is observable. Drained on a timer because the host
 * retains only the last 2000 messages. (control-flow.test.cjs's tap.)
 */
function startRunTap(hooks, uri) {
  let mark = hooks.hostMessageCount();
  /** @type {any[]} */
  const events = [];
  const drain = () => {
    const msgs = hooks.hostMessagesSince(mark);
    mark += msgs.length;
    for (const m of msgs) {
      if (m.type !== 'runEvent' || !m.event) continue;
      if (m.uri && m.uri !== uri.toString()) continue;
      events.push(m.event);
    }
  };
  const timer = setInterval(drain, 250);
  return {
    events,
    stop() {
      clearInterval(timer);
      drain();
    },
  };
}

/** The last `capture` event for `name`, or undefined. */
const lastCapture = (obs, name) => [...obs.captures].reverse().find((c) => c.name === name);

describe('TestBench live — [use ai]: generated values reach later steps and are never cached', function () {
  // Two runs. Run 1 is five page-model turns plus two `[use ai]` calls; run 2
  // should be two `[use ai]` calls and cache replays.
  this.timeout(1_200_000);

  /** @type {import('../../../dist/extension/extension').TestBenchTestHooks} */
  let hooks;
  /** @type {import('node:child_process').ChildProcess | null} */
  let testApp = null;
  let startedApp = false;
  let workspaceRoot;
  let projectRoot;
  let testFile;
  let uri;

  before(async function () {
    this.timeout(120_000);

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
          `Start it with \`node dist/index.js serve -p <port>\`. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // The target site. `runLiveTest.cjs` boots it for every shard, so this is
    // normally an adoption; nothing already serving :8787 is killed either way.
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
      say(`started fixtures/test-app on ${appUrl}`);
    } else {
      say(`reusing the fixtures/test-app already on ${appUrl}`);
    }

    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'no workspace folder — the live runner must pass templates/');
    // templates/init/aiui.config.json is the project marker, so the server keeps
    // this fixture's cache under templates/init/.cache.
    projectRoot = path.resolve(workspaceRoot, 'init');
    testFile = path.resolve(projectRoot, 'tests', FIXTURE);
    assert.ok(fs.existsSync(testFile), `${FIXTURE} not found at ${testFile}`);
    pinFixture(testFile);

    // A code-behind file beside the fixture would make the PAGE steps paint
    // </>, and the cache control below would then read as a cache failure.
    // (Whether a `.steps.ts` entry for a `[use ai]` text is ignored is a unit
    // test's job — stories/use-ai-step.md, Tests → Cache and compile.)
    const codeBehind = testFile.replace(/\.md$/, '.steps.ts');
    assert.ok(
      !fs.existsSync(codeBehind),
      `${codeBehind} exists — delete it: this test needs every page step to run under ` +
        `the model on run 1 and from the cache on run 2`,
    );

    // A cold cache for THIS fixture only, so the ⚡ on run 2 can only have come
    // from run 1. A parallel shard's workspace copy has no cache at all; this
    // matters for `--shards=1`, which runs in the real templates/.
    for (const dir of fixtureCacheDirs(projectRoot)) {
      fs.rmSync(dir, { recursive: true, force: true });
      say(`cleared ${dir}`);
    }
  });

  after(async () => {
    try {
      await vscode.commands.executeCommand('testbench-native.stop');
      await vscode.commands.executeCommand('testbench-native.restartSession');
    } catch {
      /* teardown is best-effort */
    }
    if (startedApp && testApp) {
      try {
        cp.execSync(`taskkill /pid ${testApp.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        testApp.kill();
      }
    }
  });

  /**
   * One Run All of the fixture, from a fresh browser and a blank gutter, and
   * everything observable about it. Blank matters: a ✓ left on a `[use ai]`
   * line by run 1 must not be readable as run 2's.
   */
  async function runFixture(label) {
    // Shown, not just opened: `vscode.open` can return before the editor has
    // focus, and `clearStatuses` acts on the ACTIVE editor.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      preview: false,
    });
    await waitFor(
      `${label}: ${FIXTURE} becomes the active editor`,
      () => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(),
      15_000,
    );
    await waitFor(
      `${label}: tracker recognises the test file`,
      () => hooks.tracker.snapshot().isTestFile === true,
      15_000,
    );
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
    }
    await vscode.commands.executeCommand('testbench-native.clearStatuses');
    hooks.clearRunError?.();
    // A fresh browser, as a user re-running would have (cache-replay.test.cjs).
    await vscode.commands.executeCommand('testbench-native.restartSession');
    await sleep(1_000);

    const reportsBefore = new Set(reportsIn(workspaceRoot));
    const logBefore = readLiveLog()?.length ?? 0;
    const tap = startRunTap(hooks, uri);

    say(`${label}: Run All on ${FIXTURE}`);
    void vscode.commands.executeCommand('testbench-native.runAll');
    await waitFor(`${label}: run started`, () => hooks.isRunning(), 60_000);
    await waitFor(`${label}: run finished`, () => hooks.isRunning() === false, 500_000);
    tap.stop();

    const snapshot = hooks.tracker.snapshotFor(uri) ?? hooks.tracker.snapshot();
    const statuses = Object.fromEntries(snapshot.statuses);
    const failures = Object.fromEntries(snapshot.failures);
    const captures = tap.events.filter((e) => e.type === 'capture');
    /** @type {Record<number, any>} */
    const passes = {};
    /** @type {Record<number, any>} */
    const fails = {};
    for (const e of tap.events) {
      if (e.type === 'step:pass') passes[e.line] = e;
      if (e.type === 'step:fail') fails[e.line] = e;
    }

    const written = reportsIn(workspaceRoot).filter((f) => !reportsBefore.has(f));
    const reportPath = hooks.lastReportPath();
    const html = reportPath && fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : null;
    const rows = html ? reportRows(html) : [];
    const stats = html ? reportStats(html) : {};
    const log = readLiveLog();

    const obs = {
      label,
      statuses,
      failures,
      captures,
      passes,
      fails,
      done: hooks.lastDoneStatus(),
      runError: hooks.lastRunError?.() ?? null,
      written,
      reportPath,
      html,
      rows,
      stats,
      logSlice: log === null ? null : log.slice(logBefore),
    };

    // Everything observed, by name, so a PASSING run also leaves the evidence.
    for (const s of STEPS) {
      const p = passes[s.line];
      say(
        `${label}: step ${s.n} (line ${s.line}) -> ${statuses[s.line] ?? '(no status)'}` +
          (p ? `  [pass event: fromCache=${!!p.fromCache} fromCodeBehind=${!!p.fromCodeBehind}]` : '') +
          (failures[s.line] ? `  error: ${JSON.stringify(failures[s.line].error)}` : ''),
      );
    }
    say(`${label}: done status: ${obs.done}`);
    say(`${label}: run error: ${JSON.stringify(obs.runError)}`);
    say(
      `${label}: capture events (${captures.length}):\n` +
        captures
          .map((c) => `  line ${c.line} ${c.name} = ${JSON.stringify(c.value)} (source: ${c.source ?? '(absent)'})`)
          .join('\n'),
    );
    say(`${label}: report: ${reportPath} (new this run: ${JSON.stringify(written)})`);
    say(`${label}: report header: ${JSON.stringify(stats)}`);
    say(
      `${label}: report rows (${rows.length}):\n` +
        rows
          .map(
            (r) =>
              `  ${r.number} [${r.status}]${r.origin ? ` <${r.origin}>` : ''} turns=${r.turns} ` +
              `ai=${JSON.stringify(r.aiPurposes)} captured=${JSON.stringify(r.captures)} ${r.instruction}`,
          )
          .join('\n'),
    );
    say(`${label}: cache files now: ${JSON.stringify(fixtureCacheFiles(projectRoot))}`);
    return obs;
  }

  /**
   * What must hold on EVERY run — run 1 and run 2 alike, because "asked again
   * every time" means the second run is not a special case for these lines.
   * Returns the two generated values so the caller can compare runs.
   */
  function assertEveryRun(obs) {
    const { label, statuses, passes, fails } = obs;

    // ── The run ends green: the only failure is tolerated ───────────────
    assert.equal(
      obs.done,
      'passed',
      `${label}: the run must end passed — step 7's failure is tolerated by its tail and ` +
        `nothing else may fail. Statuses: ${JSON.stringify(statuses)}; run error: ` +
        `${JSON.stringify(obs.runError)}`,
    );

    // ── The page steps and the Set ran ───────────────────────────────────
    for (const n of [...PAGE_STEPS, 4]) {
      assert.ok(
        passed(statuses[lineOf(n)]),
        `${label}: step ${n} (line ${lineOf(n)}) must pass; got "${statuses[lineOf(n)]}". ` +
          (n === 8
            ? `Step 8 runs only if the run CONTINUED past the tolerated failure on step 7.`
            : `Statuses: ${JSON.stringify(statuses)}`),
      );
    }

    // ── THE claim: the `[use ai]` steps are a plain ✓, never ⚡ or </> ──
    //
    // Exactly 'pass'. `pass-cached` would mean the step cache served a model reply
    // (decision 1), `pass-code-behind` that compiled code ran instead of the model.
    // The pass event's own flags are checked too, so a failure says which side lied.
    for (const g of GENERATED) {
      const line = lineOf(g.n);
      assert.equal(
        statuses[line],
        'pass',
        `${label}: [use ai] step ${g.n} (line ${line}) must paint a PLAIN pass — the model ` +
          `is asked on every run and the step is never cached or compiled. Got ` +
          `"${statuses[line]}".`,
      );
      assert.ok(
        passes[line] && !passes[line].fromCache && !passes[line].fromCodeBehind && !passes[line].codeBehindStale,
        `${label}: the step:pass event for line ${line} must carry no fromCache / ` +
          `fromCodeBehind / codeBehindStale; got ${JSON.stringify(passes[line] ?? null)}`,
      );
    }

    // ── The generated values: captured, from the right step, labelled generated ──
    /** @type {Record<string, string>} */
    const values = {};
    for (const g of GENERATED) {
      const c = lastCapture(obs, g.name);
      assert.ok(
        c,
        `${label}: no capture event for "${g.name}" — the [use ai] step on line ${lineOf(g.n)} ` +
          `stored nothing the panel was told about. Captures: ${JSON.stringify(obs.captures)}`,
      );
      assert.equal(
        c.source,
        'generated',
        `${label}: the capture event for "${g.name}" must carry source 'generated' ` +
          `(stories/use-ai-step.md, decision 9); got ${JSON.stringify(c.source)}. ` +
          `'assignment' or 'capture' here would label a model's answer as something the ` +
          `author wrote or the page showed.`,
      );
      assert.equal(
        c.line,
        lineOf(g.n),
        `${label}: the capture event for "${g.name}" must name the [use ai] step's own line ` +
          `(${lineOf(g.n)}); got ${c.line}`,
      );
      assert.match(
        c.value,
        g.shape,
        `${label}: "${g.name}" must match ${g.shape}; got ${JSON.stringify(c.value)}. ` +
          `Leading or trailing text here (quotes, "Sure, here is…") is conversational ` +
          `text the framework stored as the value.`,
      );
      values[g.name] = c.value;
    }
    say(
      `${label}: days_from_now = ${JSON.stringify(values.days_from_now)} — ` +
        (values.days_from_now === EXPECTED_DATE
          ? `equals ${EXPECTED_DATE}`
          : `NOT ${EXPECTED_DATE} (the model's arithmetic; logged, not asserted)`),
    );

    // ── Both values reached a later step: the Set, then the page ─────────
    const loginName = lastCapture(obs, 'login_name');
    const expectedLogin = `${values.random_name}-${values.days_from_now}@example.com`;
    assert.ok(loginName, `${label}: no capture event for "login_name" — the Set on step 4 stored nothing`);
    assert.equal(
      loginName.value,
      expectedLogin,
      `${label}: step 4's Set must join BOTH generated values — the prose-named one and ` +
        `the [store as:] one — so {{login_name}} must be "${expectedLogin}"; got ` +
        `${JSON.stringify(loginName.value)}`,
    );
    assert.equal(
      loginName.source,
      'assignment',
      `${label}: login_name was written by a Set, so its source is 'assignment'; got ` +
        `${JSON.stringify(loginName.source)}`,
    );
    const typedBack = lastCapture(obs, 'typed_back');
    assert.ok(typedBack, `${label}: no capture event for "typed_back" — step 6's read stored nothing`);
    assert.equal(
      typedBack.value.trim(),
      expectedLogin,
      `${label}: the Email address field must read back exactly what step 5 typed — the ` +
        `generated values, through a Set, into a real page field. Got ` +
        `${JSON.stringify(typedBack.value)}.`,
    );

    // ── The unresolved placeholder: failed before the model, tolerated ───
    const unresolvedLine = lineOf(UNRESOLVED.n);
    assert.equal(
      statuses[unresolvedLine],
      'fail-tolerated',
      `${label}: step 7 (line ${unresolvedLine}) references {{${UNRESOLVED.ref}}}, which ` +
        `nothing sets, so it MUST fail — and its \`otherwise continue\` tail must make ` +
        `that amber, not red. Got "${statuses[unresolvedLine]}".`,
    );
    const fail = fails[unresolvedLine];
    assert.ok(fail, `${label}: no step:fail event for line ${unresolvedLine}`);
    assert.equal(fail.tolerated, true, `${label}: step 7's step:fail must carry tolerated: true`);
    assert.equal(
      fail.warning,
      TOLERATED_WARNING,
      `${label}: step 7's step:fail must carry the author's warning; got ${JSON.stringify(fail.warning)}`,
    );
    assert.ok(
      fail.error.includes(`{{${UNRESOLVED.ref}}}`),
      `${label}: step 7's error must name the reference it could not resolve, ` +
        `{{${UNRESOLVED.ref}}}; got ${JSON.stringify(fail.error)}`,
    );
    assert.match(
      fail.error,
      /not a parameter or captured variable/,
      `${label}: step 7's error must say it in the words Set uses (verification rule 5); ` +
        `got ${JSON.stringify(fail.error)}`,
    );
    for (const name of [UNRESOLVED.prose, UNRESOLVED.ref]) {
      assert.ok(
        !obs.captures.some((c) => c.name === name),
        `${label}: a failed [use ai] step stores nothing, but a capture event for "${name}" ` +
          `arrived: ${JSON.stringify(obs.captures.filter((c) => c.name === name))}`,
      );
    }

    // ── The report ───────────────────────────────────────────────────────
    assert.equal(
      obs.written.length,
      1,
      `${label}: the run must write exactly one report; got ${JSON.stringify(obs.written)}`,
    );
    assert.ok(
      obs.html && path.basename(obs.reportPath) === obs.written[0],
      `${label}: lastReportPath must be the report this run wrote (${obs.written[0]}); ` +
        `got ${JSON.stringify(obs.reportPath)}`,
    );
    assert.equal(
      obs.stats.Passed,
      7,
      `${label}: the report header must count 7 passes — steps 1-6 and 8, the two ` +
        `[use ai] passes among them. Got ${obs.stats.Passed}.`,
    );
    assert.equal(obs.stats.Failed, 0, `${label}: no failure may count as a failure; got ${obs.stats.Failed}`);
    assert.equal(
      obs.stats.Tolerated,
      1,
      `${label}: the header must show 1 Tolerated (step 7); got ${obs.stats.Tolerated}`,
    );

    for (const g of GENERATED) {
      const row = rowFor(obs.rows, g.rowFragment, label);
      assert.equal(row.status, 'PASSED', `${label}: step ${g.n}'s row must read PASSED; got ${row.status}`);
      // The ◆ Captured box: the durable copy of the value, beside the step that made it.
      assert.equal(
        row.captures[g.name],
        values[g.name],
        `${label}: step ${g.n}'s ◆ Captured box must show ${g.name} = ` +
          `${JSON.stringify(values[g.name])}, the value the capture event carried; the box ` +
          `holds ${JSON.stringify(row.captures)}`,
      );
      // The model call is in the row: that is what "asked again" looks like in the
      // one surface that survives the run (decision 11's `purpose: 'use-ai'`).
      assert.ok(
        row.aiPurposes.includes('use-ai'),
        `${label}: step ${g.n}'s row must carry its model call, rendered "AI — use-ai"; ` +
          `its AI summaries are ${JSON.stringify(row.aiPurposes)} over ${row.turns} turn(s)`,
      );
      // A replayed turn renders `AI — action-plan (cached)` under a ⚡ badge
      // (measured on a cache-replay report), so both are ruled out.
      assert.ok(
        row.origin === null && !row.aiPurposes.some((p) => p.includes('(cached)')),
        `${label}: step ${g.n}'s row must wear no ⚡ / </> / ⚠ origin badge and no cached ` +
          `model call; origin ${JSON.stringify(row.origin)}, AI summaries ${JSON.stringify(row.aiPurposes)}`,
      );

      // Verification rule 1, where the report carries the request: one system and
      // one user message, the user message being the step text alone with its
      // placeholders filled in. Logged either way; asserted only when rendered.
      if (row.requests.length === 0) {
        say(`${label}: step ${g.n}'s model call carries no request messages in the report — rule 1 not observable here`);
      } else {
        say(`${label}: step ${g.n}'s request: ${JSON.stringify(row.requests)}`);
        assert.deepEqual(
          row.requests.map((m) => m.role),
          ['system', 'user'],
          `${label}: step ${g.n}'s model call must send exactly one system and one user message`,
        );
        const user = row.requests[1].content;
        for (const banned of ['[use ai]', '[store as', '## Values', '{{']) {
          assert.ok(
            !user.includes(banned),
            `${label}: step ${g.n}'s user message must be the resolved step text alone — it ` +
              `contains ${JSON.stringify(banned)}: ${JSON.stringify(user)}`,
          );
        }
        if (g.n === 3) {
          assert.ok(
            user.includes('Today is 2026-09-24.'),
            `${label}: step 3's user message must carry {{today}} filled in; got ${JSON.stringify(user)}`,
          );
        }
      }
    }

    const unresolvedRow = rowFor(obs.rows, UNRESOLVED.rowFragment, label);
    assert.equal(
      unresolvedRow.status,
      'TOLERATED',
      `${label}: step 7's row must wear the amber TOLERATED badge; got ${unresolvedRow.status}`,
    );
    assert.equal(
      unresolvedRow.turns,
      0,
      `${label}: step 7 must fail BEFORE any model call (decision 4) — its row renders ` +
        `${unresolvedRow.turns} turn(s) and AI summaries ${JSON.stringify(unresolvedRow.aiPurposes)}`,
    );
    assert.deepEqual(
      unresolvedRow.aiPurposes,
      [],
      `${label}: step 7's row must carry no model call; got ${JSON.stringify(unresolvedRow.aiPurposes)}`,
    );
    assert.deepEqual(
      unresolvedRow.captures,
      {},
      `${label}: step 7's row must capture nothing; got ${JSON.stringify(unresolvedRow.captures)}`,
    );

    // ── The run log says the same, in words ──────────────────────────────
    if (obs.logSlice !== null) {
      for (const g of GENERATED) {
        const line = lineOf(g.n);
        assert.match(
          obs.logSlice,
          new RegExp(`✓ step ${line} passed[ \\t]*\\r?$`, 'm'),
          `${label}: the run log must say line ${line} passed with no (cached) / (code-behind) ` +
            `suffix; got:\n${obs.logSlice}`,
        );
      }
      assert.match(
        obs.logSlice,
        new RegExp(
          `⚠ step ${unresolvedLine} failed — continuing: ${escapeRegExp(TOLERATED_WARNING)} \\(\\S`,
        ),
        `${label}: the run log's tolerated line must lead with the author's warning; got:\n${obs.logSlice}`,
      );
    }

    return values;
  }

  it('asks the model on both runs, stores what it says, and never caches it', async function () {
    this.timeout(1_200_000);
    uri = vscode.Uri.file(testFile);

    // ===== Run 1: cold cache =====
    const run1 = await runFixture('run 1');
    const values1 = assertEveryRun(run1);

    // The cache was cold, so nothing can have replayed. This is what makes run 2's
    // ⚡ on the control steps evidence that run 1 wrote them.
    for (const n of PAGE_STEPS) {
      assert.equal(
        run1.statuses[lineOf(n)],
        'pass',
        `run 1: page step ${n} (line ${lineOf(n)}) must be a plain pass on a cold cache; ` +
          `got "${run1.statuses[lineOf(n)]}"`,
      );
    }

    // The cache is on for this file, and it holds the page steps — never a
    // `[use ai]` step (decision 1: "never reads or writes the step cache").
    const files1 = fixtureCacheFiles(projectRoot);
    assert.ok(
      files1.some((f) => f.endsWith(`/step-${lineOf(1)}.json`)),
      `run 1 must write a cache entry for the navigate step (step-${lineOf(1)}.json) — ` +
        `without one, \`## Config: cache: on\` did not reach the server and nothing below ` +
        `about the cache means anything. Cache files: ${JSON.stringify(files1)}`,
    );
    assert.deepEqual(
      nonPageCacheFiles(files1),
      [],
      `run 1 wrote cache files for lines that are not page steps — the [use ai] steps are ` +
        `lines ${USE_AI_STEPS.map(lineOf).join(', ')}, and none of them may ever have one. ` +
        `All cache files: ${JSON.stringify(files1)}`,
    );

    // ===== Run 2: warm cache =====
    const run2 = await runFixture('run 2');
    const values2 = assertEveryRun(run2);

    // The control. Without it a plain ✓ on the `[use ai]` lines would be equally
    // well explained by the cache being off.
    for (const c of CACHE_CONTROL) {
      assert.equal(
        run2.statuses[lineOf(c.n)],
        'pass-cached',
        `run 2: control step ${c.n} (line ${lineOf(c.n)}) must replay from the cache (⚡) — ` +
          `it is what proves the cache was ON for this run. Got "${run2.statuses[lineOf(c.n)]}". ` +
          `If this fails, the [use ai] assertions above prove nothing about caching.`,
      );
      const row = rowFor(run2.rows, c.rowFragment, 'run 2');
      assert.ok(
        row.origin && row.origin.includes('cached'),
        `run 2: control step ${c.n}'s report row must wear the ⚡ cached badge; got ${JSON.stringify(row.origin)}`,
      );
    }
    // The other page steps carry the generated values, so whether they replay is
    // reported rather than asserted: the cache templates a typed value back into
    // {{login_name}}, and that is the cache's claim, not this story's.
    for (const n of [5, 6]) {
      say(`run 2: page step ${n} (line ${lineOf(n)}) -> ${run2.statuses[lineOf(n)]}`);
    }

    // The model really was asked, and paid for. A fully replayed run reports
    // Total Tokens 0 (measured on a cache-replay report), so with the page steps
    // replaying, the `[use ai]` calls are what this run spent tokens on. Weaker if
    // steps 5-6 missed the cache (they then spend too), never wrong.
    say(`run 2: report Total Tokens = ${run2.stats['Total Tokens']}`);
    assert.ok(
      run2.stats['Total Tokens'] > 0,
      `run 2: the report must count tokens for the two [use ai] model calls — a 0 on a ` +
        `run whose page steps replayed means the calls were not made or not accounted ` +
        `(decision 11). Header: ${JSON.stringify(run2.stats)}`,
    );

    // Still no cache file for any `[use ai]` line after a run that READ the cache.
    const files2 = fixtureCacheFiles(projectRoot);
    assert.deepEqual(
      nonPageCacheFiles(files2),
      [],
      `run 2 left cache files for lines that are not page steps (the [use ai] steps are ` +
        `lines ${USE_AI_STEPS.map(lineOf).join(', ')}). All cache files: ${JSON.stringify(files2)}`,
    );

    // Models are poor random-number generators, so the same value coming back is
    // not a failure (the story says so). Logged so a reader can see it happen.
    for (const g of GENERATED) {
      say(
        `${g.name}: run 1 ${JSON.stringify(values1[g.name])}, run 2 ${JSON.stringify(values2[g.name])}` +
          (values1[g.name] === values2[g.name] ? ' (same value both runs)' : ''),
      );
    }
  });
});
