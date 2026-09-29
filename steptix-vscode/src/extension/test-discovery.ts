import * as vscode from 'vscode';
import {
  isTestFile,
  parseFrontmatter,
  parseTitleHeading,
  type TestFrontmatter,
} from 'steptix-runner-core';
import { getOutputChannel } from './output-channel.js';

const SETTING_KEY = 'testsGlob';
const DEFAULT_GLOB = '**/*.md';

/**
 * Metadata extracted from a candidate file's content. `eligible` is true
 * iff the file should appear as a test in the explorer.
 */
export interface DiscoveredTest {
  uri: vscode.Uri;
  eligible: boolean;
  reason?: 'not-test-file' | 'is-skill' | 'disabled';
  frontmatter: TestFrontmatter;
  title: string | null;
}

export type DiscoveryEvent =
  | { kind: 'added'; test: DiscoveredTest }
  | { kind: 'changed'; test: DiscoveredTest }
  | { kind: 'removed'; uri: vscode.Uri };

/**
 * Scans the workspace for Steptix tests and maintains a live cache.
 *
 * A file is a test when:
 *  1. Its path matches `steptix.testsGlob`.
 *  2. It contains a `## Steps` heading.
 *  3. Frontmatter does NOT declare `type: skill`.
 *  4. Frontmatter does NOT declare `disabled: true`.
 *
 * The cache is keyed by URI string. Consumers subscribe to `onChange` and
 * receive add / change / remove events as the workspace evolves.
 *
 * Discovery runs once on construction and re-runs whenever the configured
 * glob changes or the user explicitly invokes refresh(). A FileSystemWatcher
 * tracks individual file events between refreshes.
 */
export class TestDiscovery implements vscode.Disposable {
  private readonly cache = new Map<string, DiscoveredTest>();
  private readonly emitter = new vscode.EventEmitter<DiscoveryEvent>();
  /** Long-lived disposables (config + workspace-folders listeners) that
   *  survive every rebuild. */
  private readonly disposables: vscode.Disposable[] = [];
  /** Per-watcher disposables — re-created on every rebuild() and disposed
   *  in full before the next batch is registered. Without this group the
   *  old onDidCreate / onDidChange / onDidDelete subscribers would leak
   *  into `disposables` forever (the underlying watcher is disposed so
   *  they no-op, but they accumulate). */
  private watcherDisposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private currentGlob = DEFAULT_GLOB;
  private initialScanPromise: Promise<void> | undefined;

  readonly onChange = this.emitter.event;

  constructor() {
    this.currentGlob = readGlob();
    this.rebuild();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`steptix.${SETTING_KEY}`)) {
          const next = readGlob();
          if (next !== this.currentGlob) {
            this.currentGlob = next;
            this.rebuild();
          }
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild()),
    );
  }

  dispose(): void {
    for (const d of this.watcherDisposables) d.dispose();
    this.watcherDisposables = [];
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }

  /** Current cache of every test we know about. Eligible only. */
  eligibleTests(): DiscoveredTest[] {
    return [...this.cache.values()].filter((t) => t.eligible);
  }

  /** All known files (including ineligible). */
  allKnown(): DiscoveredTest[] {
    return [...this.cache.values()];
  }

  /**
   * O(1) lookup of the cached classification for a single URI. Returns
   * undefined when discovery hasn't seen the file (e.g. it's outside the
   * configured glob, or was just created and the watcher hasn't fired
   * yet). Used by the batch runner to look up per-test frontmatter without
   * walking the whole cache once per test.
   */
  get(uri: vscode.Uri): DiscoveredTest | undefined {
    return this.cache.get(uri.toString());
  }

  /** Wait for the initial scan to finish — useful for tests. */
  async ready(): Promise<void> {
    if (this.initialScanPromise) await this.initialScanPromise;
  }

  /**
   * Force a full re-scan of the workspace. Additive: new files are
   * classified and added; deleted files are removed; existing eligible
   * tests are not re-emitted unless their visible state changed. The
   * watcher remains in place — refresh is a top-up, not a teardown.
   *
   * Reserved for the user's "Refresh" button in the explorer + tests that
   * can't rely on FileSystemWatcher fire-and-forget timing.
   */
  async refresh(): Promise<void> {
    const out = getOutputChannel();
    const started = Date.now();
    const seen = new Set<string>();
    try {
      const matches = await vscode.workspace.findFiles(this.currentGlob);
      for (const uri of matches) {
        seen.add(uri.toString());
        await this.handleFileChange(uri);
      }
      // Anything that disappeared since the last scan: emit removed.
      for (const key of [...this.cache.keys()]) {
        if (!seen.has(key)) {
          this.handleFileRemove(vscode.Uri.parse(key));
        }
      }
    } catch (err) {
      out.appendLine(
        `[test-discovery] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    out.appendLine(
      `[test-discovery] refresh: ${seen.size} file(s) scanned in ${Date.now() - started}ms`,
    );
  }

  /**
   * Re-classify a single file. Public so callers (e.g. when a file is saved
   * via the editor) can opt out of waiting for the FileSystemWatcher debounce.
   */
  async refreshFile(uri: vscode.Uri): Promise<void> {
    await this.handleFileChange(uri);
  }

  private rebuild(): void {
    // Tear down the previous watcher and its subscribers cleanly. The
    // sub-listeners go in `watcherDisposables` (not the long-lived
    // `disposables` array) so each rebuild starts with a clean slate
    // instead of accumulating dead listeners.
    for (const d of this.watcherDisposables) d.dispose();
    this.watcherDisposables = [];
    this.watcher?.dispose();
    this.watcher = undefined;

    // Tell consumers to drop every eligible TestItem we currently track.
    // Skip the ineligible cache entries — consumers never saw `added`
    // for them, so `removed` would be a phantom event.
    for (const [key, entry] of this.cache) {
      if (entry.eligible) {
        this.emitter.fire({ kind: 'removed', uri: vscode.Uri.parse(key) });
      }
    }
    this.cache.clear();

    // Recreate the watcher for the new glob, then run the initial scan.
    this.watcher = vscode.workspace.createFileSystemWatcher(this.currentGlob);
    this.watcherDisposables.push(
      this.watcher.onDidCreate((uri) => void this.handleFileChange(uri)),
      this.watcher.onDidChange((uri) => void this.handleFileChange(uri)),
      this.watcher.onDidDelete((uri) => this.handleFileRemove(uri)),
    );
    this.initialScanPromise = this.initialScan();
  }

  private async initialScan(): Promise<void> {
    const out = getOutputChannel();
    const started = Date.now();
    let count = 0;
    try {
      const matches = await vscode.workspace.findFiles(this.currentGlob);
      for (const uri of matches) {
        await this.handleFileChange(uri);
        count += 1;
      }
    } catch (err) {
      out.appendLine(
        `[test-discovery] initial scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    out.appendLine(
      `[test-discovery] scanned ${count} file(s) in ${Date.now() - started}ms, ${this.eligibleTests().length} eligible`,
    );
  }

  private async handleFileChange(uri: vscode.Uri): Promise<void> {
    try {
      // Read straight from disk via the FS API rather than
      // `openTextDocument`, which can serve a cached document whose
      // contents lag behind the on-disk state (a fixture flipped to
      // `disabled: true` would still appear eligible because we'd read
      // the pre-edit cached text). FileSystemWatcher events that triggered
      // this call already imply a disk-level change — go to the source.
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      const entry = classify(uri, text);
      const previous = this.cache.get(uri.toString());
      this.cache.set(uri.toString(), entry);

      if (!previous) {
        if (entry.eligible) this.emitter.fire({ kind: 'added', test: entry });
        return;
      }

      if (previous.eligible && !entry.eligible) {
        this.emitter.fire({ kind: 'removed', uri });
        return;
      }
      if (!previous.eligible && entry.eligible) {
        this.emitter.fire({ kind: 'added', test: entry });
        return;
      }
      if (entry.eligible) {
        // Both eligible — emit changed if anything visible changed.
        if (!sameVisible(previous, entry)) {
          this.emitter.fire({ kind: 'changed', test: entry });
        }
      }
    } catch (err) {
      getOutputChannel().appendLine(
        `[test-discovery] failed to read ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private handleFileRemove(uri: vscode.Uri): void {
    const previous = this.cache.get(uri.toString());
    if (!previous) return;
    this.cache.delete(uri.toString());
    if (previous.eligible) {
      this.emitter.fire({ kind: 'removed', uri });
    }
  }
}

function readGlob(): string {
  const cfg = vscode.workspace.getConfiguration('steptix');
  const v = cfg.get<string>(SETTING_KEY)?.trim();
  return v && v.length > 0 ? v : DEFAULT_GLOB;
}

/** Run the eligibility rules; returns metadata regardless of eligibility. */
export function classify(uri: vscode.Uri, text: string): DiscoveredTest {
  const frontmatter = parseFrontmatter(text);
  const title = parseTitleHeading(text);

  // `type` comparison is case-insensitive — users routinely write
  // `type: Skill` or `type: SKILL` and intent is the same. Same forgiving
  // policy as VS Code's own settings keys.
  if (frontmatter.type?.toLowerCase() === 'skill') {
    return { uri, eligible: false, reason: 'is-skill', frontmatter, title };
  }
  if (frontmatter.disabled === true) {
    return { uri, eligible: false, reason: 'disabled', frontmatter, title };
  }
  if (!isTestFile(text)) {
    return { uri, eligible: false, reason: 'not-test-file', frontmatter, title };
  }
  return { uri, eligible: true, frontmatter, title };
}

function sameVisible(a: DiscoveredTest, b: DiscoveredTest): boolean {
  if (a.title !== b.title) return false;
  if ((a.frontmatter.env ?? '') !== (b.frontmatter.env ?? '')) return false;
  const aTags = (a.frontmatter.tags ?? []).join('|');
  const bTags = (b.frontmatter.tags ?? []).join('|');
  return aTags === bTags;
}
