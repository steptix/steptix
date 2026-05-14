import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ErrorPayload, RunEvent } from 'ai-ui-automation-runner-core';
import type { TestDiscovery, DiscoveredTest, DiscoveryEvent } from './test-discovery.js';
import type { RunController } from './run-controller.js';
import { getOutputChannel } from './output-channel.js';
import { EnvSelector } from './env-selector.js';

/** Subset of RunControllerRegistry that the test controller needs. */
export interface TestControllerRegistry {
  get(document: vscode.TextDocument): RunController | undefined;
  anyRunning(): boolean;
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
   * Counters from the most recent batch run. Test-only readback via
   * __testHooks. Safe to be plain mutable state because runHandler
   * refuses concurrent invocations (registry.anyRunning() check at
   * entry) — at most one batch ever writes _lastRun at a time.
   */
  private _lastRun: { passed: number; failed: number; skipped: number } | null = null;

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
      await this.runHandler(request, tokenSource.token);
    } finally {
      tokenSource.dispose();
    }
    return this._lastRun ?? { passed: 0, failed: 0, skipped: 0 };
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

  private async runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const log = getOutputChannel();
    const ts = () => new Date().toISOString().slice(11, 23);

    if (this.registry.anyRunning()) {
      vscode.window.setStatusBarMessage(
        'TestBench: a run is already in flight — wait for it to finish',
        3000,
      );
      return;
    }

    const items = this.resolveRequestItems(request);
    const run = this.controller.createTestRun(request);
    const counts = { passed: 0, failed: 0, skipped: 0 };

    // Pin the batch env at run start so a mid-batch env-setting change
    // can never split results.
    const batchEnv = EnvSelector.activeEnv();
    log.appendLine(
      `[${ts()}] [batch] starting ${items.length} test(s) with env=${batchEnv ?? '(none)'}`,
    );

    try {
      for (const item of items) run.enqueued(item);

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
      }
    } finally {
      this.banner.set(null);
      run.end();
      this._lastRun = counts;
      log.appendLine(
        `[${ts()}] [batch] done: ${counts.passed} passed / ${counts.failed} failed / ${counts.skipped} skipped`,
      );
    }
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

    const controller = this.registry.get(doc);
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

    // Collect step:fail events so we can attach TestMessages on failure.
    const failures: Array<{ line: number; error: string }> = [];
    const outputs: string[] = [];
    const onEvent = (event: RunEvent): void => {
      switch (event.type) {
        case 'step:start':
          outputs.push(`▶ step on line ${event.line}`);
          break;
        case 'step:pass':
          outputs.push(`✓ step on line ${event.line} passed`);
          if (event.output) outputs.push(`  ${event.output}`);
          break;
        case 'step:fail':
          outputs.push(`✗ step on line ${event.line} failed — ${event.error}`);
          failures.push({ line: event.line, error: event.error });
          break;
        case 'output':
          outputs.push(`[${event.kind}] ${event.msg}`);
          break;
        case 'done':
          // Status is reported via the return value of runLines; nothing
          // extra to log here.
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
        forceFreshSession: true,
        envOverride: envForThisTest ?? null,
        onEvent,
      });
    } finally {
      cancelListener.dispose();
    }

    const duration = Date.now() - start;
    appendRunOutput(run, item, outputs);

    if (token.isCancellationRequested) {
      // User cancelled mid-test. Skipped is more truthful than failed —
      // we don't know what the result *would* have been.
      run.skipped(item);
      // Best-effort browser-session cleanup so the next batch starts fresh.
      void controller.closeSession().catch(() => undefined);
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

function appendRunOutput(run: vscode.TestRun, item: vscode.TestItem, lines: string[]): void {
  if (lines.length === 0) return;
  const filename = item.uri ? path.basename(item.uri.fsPath) : item.label;
  const header = `─── ${filename} ───`;
  run.appendOutput(`${header}\r\n${lines.join('\r\n')}\r\n\r\n`, undefined, item);
}
