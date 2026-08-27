import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ErrorPayload, RunEvent } from 'ai-ui-automation-runner-core';
import type { TestDiscovery, DiscoveredTest, DiscoveryEvent } from './test-discovery.js';
import type { RunController } from './run-controller.js';
import { getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';

/** Subset of RunControllerRegistry that the test controller needs. Batch
 *  (flask) runs go through a DETACHED, headless controller so they never touch
 *  the editor surface (decorations, webview, the running context key, the Call
 *  Stack / Variables views) — see RunControllerRegistry.getBatchController.
 *  Concurrent flask runs are serialized into a FIFO queue inside the test
 *  controller itself, so no registry-level "is a batch running" guard is needed. */
export interface TestControllerRegistry {
  getBatchController(document: vscode.TextDocument): RunController | undefined;
}

/** Hook so the test controller can drive the sidebar webview banner. */
export interface BatchBannerSink {
  set(state: { running: number; total: number } | null): void;
}

/**
 * Owns VS Code's TestController for TestBench. Mirrors the
 * TestDiscovery cache as TestItems and implements the run handler that
 * executes a multi-test batch sequentially.
 *
 * - One TestItem per eligible `.md` file.
 * - Label: `# Heading (filename.md)` when the file has a top-level
 *   heading, else just the filename. Description set to the workspace-
 *   relative path so hovers / "show description" disambiguate when two
 *   tests share the same heading.
 * - Frontmatter `tags: [...]` surface as TestItem.tags so VS Code's
 *   built-in "Run with tag…" filter works.
 *
 * Run flow: see testbench/stories/specs/test-runner.md §5.
 */
export class TestBenchTestController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly profile: vscode.TestRunProfile;
  private readonly items = new Map<string, vscode.TestItem>();
  /**
   * Tag identity is reference-based in VS Code's TestController API, so we
   * cache one TestTag per unique tag string and reuse it across TestItems.
   * The cache only ever grows by the number of UNIQUE tag strings in the
   * workspace — bounded by user authoring habits in practice (typically
   * single digits, e.g. `smoke`, `slow`, `needs-network`). Not pruned on
   * tag removal: stale entries are harmless reference holders.
   */
  private readonly tagCache = new Map<string, vscode.TestTag>();
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Counters from the most recent batch run to FINISH. Test-only readback via
   * __testHooks. Safe to be plain mutable state because batch runs are
   * serialized through `runChain` — at most one `executeBatch` writes _lastRun
   * at a time. (Concurrent callers that need their own counts get them from
   * `enqueueRun`'s return value instead of reading this.)
   */
  private _lastRun: { passed: number; failed: number; skipped: number } | null = null;
  /** Test-only mirror of the lines streamed to the active run's Test Results
   *  output via `run.appendOutput`. Reset at the start of each test's runOne and
   *  appended live as events arrive, so the integration suite can prove output
   *  is emitted DURING the run rather than buffered until it finishes. */
  private _liveOutput: string[] = [];

  constructor(
    private readonly discovery: TestDiscovery,
    private readonly registry: TestControllerRegistry,
    private readonly banner: BatchBannerSink,
  ) {
    this.controller = vscode.tests.createTestController('testbench-native', 'TestBench (Native)');
    this.controller.refreshHandler = () => discovery.refresh();
    this.controller.resolveHandler = async (item) => {
      // VS Code calls this with `undefined` to populate the root of the
      // test tree. Wait for the initial discovery scan to finish, then
      // sync EVERY eligible test into this.items synchronously before
      // returning — if we leave it to the discovery.onChange events to
      // populate items later, VS Code's tree snapshot can capture an
      // empty state and show only whatever happens to land before its
      // first render. File-level only — no children to resolve.
      if (item) return;
      await discovery.ready();
      for (const test of discovery.eligibleTests()) {
        this.addOrUpdate(test);
      }
    };

    this.profile = this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runHandler(request, token),
      /* isDefault */ true,
    );
    this.profile.configureHandler = () => {
      // Re-use the single-file env picker so there's one source of truth
      // for "active env" across single-file and batch runs.
      void vscode.commands.executeCommand('testbench-native.selectEnv');
    };

    // Seed from anything discovery already knows about, then subscribe.
    for (const test of this.discovery.eligibleTests()) {
      this.addOrUpdate(test);
    }
    this.disposables.push(
      this.discovery.onChange((event) => this.handleDiscoveryEvent(event)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.controller.dispose();
  }

  /** Test-only readback of the most recent batch run's outcome counts. */
  get lastRun(): { passed: number; failed: number; skipped: number } | null {
    return this._lastRun;
  }

  /** Test-only readback of the output lines streamed so far for the in-flight
   *  (or most recent) test — see `_liveOutput`. */
  get liveOutput(): string[] {
    return this._liveOutput;
  }

  /**
   * Test-only readback of the IDs currently inside
   * `vscode.TestController.items`. The discovery cache and this collection
   * must stay in sync — when they diverge the user sees missing tests in
   * the explorer (see the resolveHandler bug from 0.3.3). Asserted on by
   * the batch-mode test suite.
   */
  controllerItemIds(): string[] {
    const out: string[] = [];
    this.controller.items.forEach((it) => out.push(it.id));
    return out;
  }

  /**
   * Test-only: drive VS Code's `resolveHandler` for the root the same way
   * the Test Explorer's first render does. Used to verify items land in
   * `controller.items` after a resolve cycle.
   */
  async triggerInitialResolve(): Promise<void> {
    const handler = this.controller.resolveHandler;
    if (handler) await handler(undefined);
  }

  /**
   * Test-only readback of the rendered metadata for a single TestItem.
   * Lets tests assert on label / description / tags as they actually
   * appear in the explorer, not just on the discovery cache inputs.
   */
  itemMetadata(uri: vscode.Uri): { label: string; description: string; tags: string[] } | undefined {
    const item = this.items.get(uri.toString());
    if (!item) return undefined;
    return {
      label: item.label,
      description: typeof item.description === 'string' ? item.description : '',
      tags: item.tags.map((t) => t.id),
    };
  }

  /**
   * Test-only entry point: run a batch identified by file URIs.
   * Constructs a TestRunRequest pointing at the corresponding TestItems
   * and invokes the same code path the explorer's Run button takes.
   * Returns once `run.end()` has been called.
   */
  async runByUris(uris: vscode.Uri[]): Promise<{ passed: number; failed: number; skipped: number }> {
    await this.discovery.ready();
    const include: vscode.TestItem[] = [];
    for (const uri of uris) {
      const item = this.items.get(uri.toString());
      if (item) include.push(item);
    }
    const request = new vscode.TestRunRequest(include, undefined, this.profile);
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      // Go through enqueueRun (not runHandler) so this run's OWN counts come
      // back — important when several runs are queued concurrently and `_lastRun`
      // reflects whichever finished last.
      return await this.enqueueRun(request, tokenSource.token);
    } finally {
      tokenSource.dispose();
    }
  }

  // ---------- Discovery → TestItem sync ----------

  private handleDiscoveryEvent(event: DiscoveryEvent): void {
    switch (event.kind) {
      case 'added':
      case 'changed':
        this.addOrUpdate(event.test);
        return;
      case 'removed':
        this.remove(event.uri);
        return;
    }
  }

  private addOrUpdate(test: DiscoveredTest): void {
    const id = test.uri.toString();
    let item = this.items.get(id);
    if (!item) {
      item = this.controller.createTestItem(id, this.labelFor(test), test.uri);
      this.items.set(id, item);
      this.controller.items.add(item);
    } else {
      item.label = this.labelFor(test);
    }
    item.description = this.descriptionFor(test);
    item.tags = this.tagsFor(test);
  }

  private remove(uri: vscode.Uri): void {
    const id = uri.toString();
    this.items.delete(id);
    this.controller.items.delete(id);
  }

  private labelFor(test: DiscoveredTest): string {
    const filename = path.basename(test.uri.fsPath);
    if (test.title) return `${test.title} (${filename})`;
    return filename;
  }

  private descriptionFor(test: DiscoveredTest): string {
    const folder = vscode.workspace.getWorkspaceFolder(test.uri);
    if (!folder) return test.uri.fsPath;
    return path.relative(folder.uri.fsPath, test.uri.fsPath).split(path.sep).join('/');
  }

  private tagsFor(test: DiscoveredTest): vscode.TestTag[] {
    const tagNames = test.frontmatter.tags ?? [];
    return tagNames.map((name) => this.getOrCreateTag(name));
  }

  private getOrCreateTag(id: string): vscode.TestTag {
    let tag = this.tagCache.get(id);
    if (!tag) {
      tag = new vscode.TestTag(id);
      this.tagCache.set(id, tag);
    }
    return tag;
  }

  // ---------- Run handler ----------

  /** Serializes batch runs into a FIFO queue. A run requested while another
   *  batch is in flight is CHAINED onto this promise (not refused), so the user
   *  can stack up runs from the Test Explorer and they execute one after
   *  another. Each link swallows its own error so a failed/cancelled run never
   *  breaks the queue for the runs behind it. */
  private runChain: Promise<void> = Promise.resolve();
  /** True while a batch is actually executing (vs. merely queued). Lets a
   *  newly-requested run tell the user it was queued rather than started. */
  private batchRunning = false;

  private runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // VS Code's run handler is fire-and-forget from our side; the per-run
    // counts only matter to the test hook, which calls enqueueRun directly.
    return this.enqueueRun(request, token).then(() => undefined);
  }

  /**
   * Build a TestRun for `request` and QUEUE it behind any in-flight/queued
   * batch (FIFO), resolving with this run's own outcome counts once it has
   * fully executed (or been skipped). The run's tests are marked `enqueued`
   * immediately, so a queued run shows as pending in the Test Explorer while it
   * waits its turn. The env is pinned now (at request time) so a later
   * env-setting change can't retroactively alter a waiting run.
   */
  private enqueueRun(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<{ passed: number; failed: number; skipped: number }> {
    const items = this.resolveRequestItems(request);
    const run = this.controller.createTestRun(request);
    for (const item of items) run.enqueued(item);
    const batchEnv = EnvSelector.activeEnv();

    if (this.batchRunning) {
      vscode.window.setStatusBarMessage(
        'TestBench: queued — will run after the current batch finishes',
        3000,
      );
    }

    const prior = this.runChain;
    const mine = (async () => {
      await prior.catch(() => undefined); // wait our turn; ignore prior's outcome
      return this.executeBatch(run, items, batchEnv, token);
    })();
    // Advance the chain to this link; swallow its result/error so one run can
    // never poison the queue for the runs behind it.
    this.runChain = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

  /** Execute one already-created TestRun's items sequentially and report its
   *  outcome counts. Runs serialized via {@link enqueueRun}, so at most one
   *  executeBatch touches `batchRunning` / `_lastRun` / the banner at a time. */
  private async executeBatch(
    run: vscode.TestRun,
    items: vscode.TestItem[],
    batchEnv: string | null,
    token: vscode.CancellationToken,
  ): Promise<{ passed: number; failed: number; skipped: number }> {
    const log = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);
    const counts = { passed: 0, failed: 0, skipped: 0 };
    this.batchRunning = true;
    log.appendLine(
      `[${ts()}] [batch] starting ${items.length} test(s) with env=${batchEnv ?? '(none)'}`,
    );

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (token.isCancellationRequested) {
          for (let j = i; j < items.length; j++) {
            run.skipped(items[j]!);
            counts.skipped += 1;
          }
          break;
        }
        this.banner.set({ running: i + 1, total: items.length });
        const outcome = await this.runOne(run, item, batchEnv, token);
        counts[outcome] += 1;
        // Per-test session teardown (close + video finalise) is owned by
        // runLines' finally (see RunController). Nothing to do here.
      }
    } finally {
      this.batchRunning = false;
      this.banner.set(null);
      run.end();
      this._lastRun = counts;
      log.appendLine(
        `[${ts()}] [batch] done: ${counts.passed} passed / ${counts.failed} failed / ${counts.skipped} skipped`,
      );
    }
    return counts;
  }

  /** Resolve the user's TestRunRequest into an ordered list of leaf TestItems
   *  to actually execute. Excludes anything in request.exclude. When
   *  request.include is undefined the whole tree runs. */
  private resolveRequestItems(request: vscode.TestRunRequest): vscode.TestItem[] {
    const exclude = new Set((request.exclude ?? []).map((it) => it.id));
    const out: vscode.TestItem[] = [];
    const seen = new Set<string>();
    const visit = (it: vscode.TestItem): void => {
      if (exclude.has(it.id)) return;
      if (seen.has(it.id)) return;
      seen.add(it.id);
      if (it.children.size === 0) {
        out.push(it);
        return;
      }
      // file-as-test today — every TestItem is a leaf, but defensively
      // recurse so we cope if step-level children appear later.
      it.children.forEach(visit);
    };

    if (request.include) {
      for (const it of request.include) visit(it);
    } else {
      this.controller.items.forEach(visit);
    }

    // Stable order: by file path. VS Code may return them in tree order
    // already but we want deterministic results regardless of insertion.
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  private async runOne(
    run: vscode.TestRun,
    item: vscode.TestItem,
    batchEnv: string | null,
    token: vscode.CancellationToken,
  ): Promise<'passed' | 'failed' | 'skipped'> {
    if (!item.uri) {
      run.errored(item, new vscode.TestMessage('TestItem has no associated file'));
      return 'failed';
    }

    run.started(item);
    const start = Date.now();
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(item.uri);
    } catch (err) {
      run.errored(
        item,
        new vscode.TestMessage(
          `Failed to read test file: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return 'failed';
    }

    // DETACHED, headless controller: a flask run must not drive the editor's
    // decorations / webview / Pause-Stop buttons, and must be able to run
    // independently of (even concurrently with) an interactive run of the same
    // file. See RunControllerRegistry.getBatchController.
    const controller = this.registry.getBatchController(doc);
    if (!controller) {
      run.errored(
        item,
        new vscode.TestMessage('Test file is not inside a workspace folder.'),
      );
      return 'failed';
    }

    // Frontmatter env override wins over the batch env.
    const cached = this.discovery.get(item.uri);
    const envForThisTest = cached?.frontmatter.env ?? batchEnv;

    // Stream output to the Test Results panel LIVE as events arrive, rather
    // than buffering every line and flushing once at the end (which made the
    // whole log appear only after the test had already finished). VS Code's
    // appendOutput needs CRLF line breaks; passing the test item ties the
    // output to this test in the results tree.
    const filename = item.uri ? path.basename(item.uri.fsPath) : item.label;
    run.appendOutput(`─── ${filename} ───\r\n`, undefined, item);
    this._liveOutput = []; // test-only mirror of streamed lines (see `liveOutput`)
    const emit = (line: string): void => {
      this._liveOutput.push(line);
      run.appendOutput(`${line}\r\n`, undefined, item);
    };

    // Collect step:fail events so we can attach TestMessages on failure.
    const failures: Array<{ line: number; error: string }> = [];
    // Collect server-level error output (kind 'error', e.g. "Server error: …")
    // so a failure with no step:fail still gets a meaningful TestMessage rather
    // than the generic "no specific step failure recorded".
    const serverErrors: string[] = [];
    const onEvent = (event: RunEvent): void => {
      switch (event.type) {
        case 'step:start':
          emit(`▶ step on line ${event.line}`);
          break;
        case 'step:pass':
          // Same vocabulary as the interactive run log, so the two surfaces
          // never disagree about how a step passed.
          if (event.codeBehindStale) {
            emit(
              `⚠ step on line ${event.line} passed under AI — code-behind failed: ` +
                event.codeBehindStale.error,
            );
          } else {
            emit(
              `✓ step on line ${event.line} passed` +
                (event.fromCodeBehind ? '  (code-behind)' : event.fromCache ? '  (cached)' : ''),
            );
          }
          if (event.output) emit(`  ${event.output}`);
          break;
        case 'step:fail': {
          // Fold the code-behind context into the one string both surfaces
          // share — the streamed line and the TestMessage the failure peek
          // shows. Without it a broken entry's crash never reaches Test
          // Explorer at all when the AI attempt failed too.
          const detail = event.codeBehindStale
            ? `${event.error} (its code-behind threw first: ${event.codeBehindStale.error})`
            : event.fromCodeBehind
              ? `Code-behind failed: ${event.error}`
              : event.error;
          emit(`✗ step on line ${event.line} failed — ${detail}`);
          failures.push({ line: event.line, error: detail });
          break;
        }
        case 'output':
          emit(`[${event.kind}] ${event.msg}`);
          if (event.kind === 'error') serverErrors.push(event.msg);
          break;
        case 'done':
          // Status comes from runLines' return value; nothing to log here.
          break;
      }
    };

    // Wire cancellation. token.isCancellationRequested can flip mid-test.
    const cancelListener = token.onCancellationRequested(() => {
      controller.stop();
    });

    let outcome: { ok: boolean; error?: ErrorPayload };
    try {
      outcome = await controller.runLines([], {
        breakpoints: new Set(), // batch ignores breakpoints by design
        batchMode: true,
        // No forceFreshSession: batch isolation comes from the UNIQUE per-run
        // session id (`<path>::run-N`, issue 032), not the interactive
        // pre-close — which runLines skips entirely when batchMode is true.
        envOverride: envForThisTest ?? null,
        onEvent,
      });
    } finally {
      cancelListener.dispose();
    }

    const duration = Date.now() - start;
    // Trailing blank line separates this test's live output from the next one.
    run.appendOutput('\r\n', undefined, item);

    if (token.isCancellationRequested) {
      // User cancelled mid-test. Skipped is more truthful than failed —
      // we don't know what the result *would* have been.
      run.skipped(item);
      // No explicit close here: runLines closes the batch run's own unique
      // session in its finally (which fires on the abort too), so the cancelled
      // test's session is already torn down.
      return 'skipped';
    }

    if (!outcome.ok || failures.length > 0 || outcome.error) {
      const messages: vscode.TestMessage[] = [];
      for (const f of failures) {
        const msg = new vscode.TestMessage(f.error);
        msg.location = new vscode.Location(item.uri, new vscode.Position(f.line - 1, 0));
        messages.push(msg);
      }
      if (outcome.error) {
        const payload = outcome.error;
        const text = `${payload.code}: ${payload.diagnosis}${payload.fix ? `\n\nFix: ${payload.fix}` : ''}`;
        messages.push(new vscode.TestMessage(text));
      }
      // A server-level error (e.g. invalid baseUrl) arrives as output:error
      // with no step:fail and no outcome.error — surface it so the failure is
      // explained rather than generic. De-dupe (the server's log bridge can
      // emit the same error twice) and cap so a noisy run doesn't produce a
      // wall of redundant messages.
      if (messages.length === 0 && serverErrors.length > 0) {
        for (const e of [...new Set(serverErrors)].slice(0, 5)) {
          messages.push(new vscode.TestMessage(e));
        }
      }
      if (messages.length === 0) {
        messages.push(new vscode.TestMessage('Test failed (no specific step failure recorded).'));
      }
      run.failed(item, messages, duration);
      return 'failed';
    }

    run.passed(item, duration);
    return 'passed';
  }
}
