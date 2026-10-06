import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { logger } from '../utils/logger.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { ToolDefinition } from './types.js';
import { finaliseToolExport } from './finalise.js';
import { bundleAndImport, resolveToolCacheDir, signatureOf } from './reload.js';

/** A loaded tool, with the absolute path it came from for error reporting. */
export interface RegisteredTool {
  definition: ToolDefinition;
  filePath: string;
}

/** Result of importing one tool file: its tools (by name), or an import error. */
interface FileLoad {
  tools: Map<string, RegisteredTool>;
  /** Set when the file threw on import — confined to refs naming this file. */
  error?: string;
  /**
   * Reload mode only: content signature of the files this load was built from
   * (the bundle's input set — entry + relative helpers), used by `resolve` to
   * detect an edit and re-import. `undefined` for the direct-import path (the
   * CLI / programmatic catalogues), where loads are never invalidated.
   */
  signature?: string;
  /** Reload mode only: the absolute input paths `signature` was taken over. */
  inputs?: string[];
}

/** Options for `ToolCatalogue` / `loadToolCatalogue`. */
export interface ToolCatalogueOptions {
  /**
   * Re-import a tool file when it (or a bundled helper) changes on disk,
   * instead of loading once and caching for the process lifetime. Needed by
   * the long-lived server so tool edits take effect without a restart (issue
   * 033); left off for the one-shot CLI, which is unaffected by the caches.
   */
  reload?: boolean;
  /**
   * The directory `loadToolCatalogue` scanned. Stored so `refreshIndex` can
   * re-walk it; `undefined` for a directly-constructed catalogue (which has
   * no scanned dir and whose `refreshIndex` is a no-op).
   */
  scannedDir?: string;
  /** Where reload writes temp tool modules (see `resolveToolCacheDir`). */
  cacheDir?: string | undefined;
}

export interface LoadToolCatalogueOptions extends ToolCatalogueOptions {
  /**
   * The directory `tests.toolsDir` resolves to when the project leaves it at
   * its default — see `defaultToolsDir`. When `dir` is this directory and is
   * missing, the load logs at debug instead of warning: the project simply has
   * no tools yet. Omit it and a missing directory always warns.
   */
  defaultDir?: string;
}

/**
 * Diagnostic state attached to a `ToolCatalogue` so error messages can name
 * the directory the framework actually scanned and tell the author exactly
 * how to register a missing tool. The HTML report renders the `hint` block
 * when a `[tool: ...]` step fails because the catalogue couldn't find the
 * named tool — turns "not found in catalogue" from a dead end into an
 * actionable instruction.
 */
export interface CatalogueDiagnostics {
  /** The absolute path the catalogue tried to load tools from. */
  toolsDir: string;
  /** True when the directory didn't exist on disk (still loads to an empty catalogue). */
  toolsDirMissing: boolean;
  /** Number of tool files discovered (including any that produced 0 exports). */
  filesScanned: number;
}

export class ToolCatalogue {
  private readonly tools = new Map<string, RegisteredTool>();
  /**
   * Index of tool files discovered by `loadToolCatalogue`, keyed by the path
   * relative to `toolsDir` with the extension stripped and separators
   * normalised to `/` (e.g. `auth`, `integrations/stripe/refund`). Values are
   * absolute file paths. Built without importing anything — files are imported
   * lazily on first `resolve`.
   */
  private readonly fileIndex = new Map<string, string>();
  /**
   * Outcome of importing each tool file, keyed by absolute path. Tools are
   * stored *per file* (not in one flat name map) so two files may each define a
   * tool with the same short name — `auth/login` and `auth/login/login` both
   * expose `login` — without colliding. `error` is set when the file threw on
   * import (a missing package, an illegal filename, an in-file duplicate); the
   * failure is confined to references that name this file.
   */
  private readonly byFile = new Map<string, FileLoad>();
  /** Set by `loadToolCatalogue` after the scan; not used by direct constructor users. */
  diagnostics?: CatalogueDiagnostics;

  /** True when an edited tool file should be re-imported (see `ToolCatalogueOptions.reload`). */
  private readonly reloadEnabled: boolean;
  /** The scanned dir, for `refreshIndex` to re-walk. Undefined ⇒ refresh no-ops. */
  private readonly scannedDir: string | undefined;
  /** Where reload writes temp tool modules. Undefined ⇒ fall back to direct import. */
  private readonly cacheDir: string | undefined;

  constructor(options: ToolCatalogueOptions = {}) {
    this.reloadEnabled = options.reload ?? false;
    this.scannedDir = options.scannedDir;
    this.cacheDir = options.cacheDir;
  }

  /**
   * Reload is active only when enabled *and* a cache dir was resolved. Gating
   * both `resolve`'s staleness check and `loadFile`'s branch on this keeps them
   * in lockstep: a `{ reload: true }` catalogue built without a cacheDir (only
   * reachable by direct construction, never via `loadToolCatalogue`) degrades
   * cleanly to load-once instead of re-importing on every resolve.
   */
  private get canReload(): boolean {
    return this.reloadEnabled && this.cacheDir !== undefined;
  }

  /** Number of tools available — directly-registered plus lazily-loaded so far. */
  get size(): number {
    let n = this.tools.size;
    for (const fl of this.byFile.values()) n += fl.tools.size;
    return n;
  }

  /**
   * Number of tool files discovered during the scan. Unlike `size` (which
   * counts *loaded* tools and is 0 until something resolves), this reflects the
   * directory contents and is the right "is this catalogue empty?" signal for
   * the server's reload gate.
   */
  get indexedCount(): number {
    return this.fileIndex.size;
  }

  /** Record a discovered tool file in the index without importing it. */
  indexFile(relPath: string, absPath: string): void {
    this.fileIndex.set(relPath, absPath);
  }

  /**
   * Re-walk the scanned directory and reconcile the file index with disk
   * (issue 033 Part 2): index newly-added files, drop files that disappeared
   * (evicting any loaded `byFile` entry so a later reference gives the clean
   * "not found" diagnostic rather than a stale hit, and a delete-then-recreate
   * re-imports fresh). Surviving files keep their `byFile` entry — `resolve`'s
   * per-file change check handles their edits. **Import-free**: only `readdir`,
   * never `import`, so the lazy invariant holds.
   *
   * No-op when the catalogue wasn't built from a scan (a directly-constructed +
   * `register`ed catalogue has no dir to re-walk). Mirrors `loadToolCatalogue`'s
   * missing / not-a-directory handling, so a dir deleted mid-session degrades to
   * an empty catalogue (with diagnostics) rather than throwing.
   */
  async refreshIndex(): Promise<void> {
    const dir = this.scannedDir;
    if (dir === undefined) return;

    let exists = true;
    try {
      const stat = await fs.stat(dir);
      // A dir replaced by a *file* mid-session degrades like a missing dir
      // (below) rather than throwing: refreshIndex is a best-effort
      // reconcile, not the hard config check loadToolCatalogue makes on a
      // full load.
      if (!stat.isDirectory()) exists = false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        exists = false;
      } else {
        throw err;
      }
    }

    if (!exists) {
      // The dir was removed/replaced mid-session: empty the index and the
      // loaded tools, and flip diagnostics back to "missing" so the not-found
      // hint matches reality.
      this.fileIndex.clear();
      this.byFile.clear();
      this.diagnostics = { toolsDir: dir, toolsDirMissing: true, filesScanned: 0 };
      return;
    }

    const files = await listToolFiles(dir);
    const next = new Map<string, string>();
    for (const abs of files) next.set(relKey(dir, abs), abs);

    // Evict loaded entries whose backing file is gone (a delete drops the
    // stale load; a recreate then re-imports fresh). Survivors are untouched.
    const surviving = new Set(next.values());
    for (const abs of [...this.byFile.keys()]) {
      if (!surviving.has(abs)) this.byFile.delete(abs);
    }

    this.fileIndex.clear();
    for (const [rel, abs] of next) this.fileIndex.set(rel, abs);

    // Maintain ALL diagnostics — crucially clear `toolsDirMissing` so a dir
    // that was absent at first scan and has since been created stops rendering
    // the "tools.dir does not exist" hint.
    this.diagnostics = { toolsDir: dir, toolsDirMissing: false, filesScanned: files.length };
  }

  // NOTE: `has`/`get`/`names`/`require` below report only *directly-registered*
  // tools (via `register`), NOT lazily-indexed disk tools — those are reached
  // through the async `resolve`, which imports on demand and stores them
  // per-file. Don't use `has`/`get` as a cheap "is this a known tool?" gate for
  // a disk catalogue; they will answer `false` until (and unless) the file is
  // imported. `resolve` is the single entry point for invocation.

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Throwing accessor for runtime call sites that have already validated the
   * name. The error message is deliberately verbose: when a tool isn't found,
   * the most likely cause is a missing/wrong `tests.toolsDir`, so we name the
   * directory we scanned, the file count we saw, and a one-line `defineTool`
   * recipe — turns the failure into an actionable hint rather than a dead end.
   */
  require(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(this.buildNotFoundMessage(name));
    }
    return tool;
  }

  /**
   * Lazily resolve a (possibly path-qualified) tool reference, importing the
   * one file it names if not already loaded. This is the entry point used at
   * invocation time, so a file that fails to load fails only the step that
   * referenced it — unrelated tools and tests are untouched.
   *
   * Resolution (see `parseToolRef`):
   *   - `name`              → file `name.ts`, tool named `name` (sugar)
   *   - `dir/.../file/tool` → file `dir/.../file.ts`, tool named `tool`
   *
   * Falls back to a directly-registered tool of the matching name when the ref
   * names no indexed file — this keeps programmatic registration (and the
   * pre-loaded path) working.
   */
  async resolve(ref: string): Promise<RegisteredTool> {
    const { file, tool } = parseToolRef(ref);
    const abs = this.fileIndex.get(file);

    if (abs !== undefined) {
      const cached = this.byFile.get(abs);
      // Load when unseen, or — in reload mode — when the file (or a bundled
      // helper) changed since the cached load. Steady state is one signature
      // check plus a map hit; a rebundle (~20 ms) happens only on an actual
      // edit. Direct-import catalogues never re-load (the `canReload`
      // short-circuit keeps the CLI's load-once behaviour).
      if (cached === undefined || (this.canReload && (await this.isStale(cached)))) {
        await this.loadFile(abs);
      }
      const fl = this.byFile.get(abs)!;
      if (fl.error !== undefined) {
        throw new Error(`Tool "${ref}" could not be loaded from ${abs}: ${fl.error}`);
      }
      const got = fl.tools.get(tool);
      if (got) return got;
      throw new Error(this.buildToolNotInFileMessage(ref, tool, abs, [...fl.tools.keys()]));
    }

    // No indexed file for this ref — fall back to a directly-registered tool.
    const existing = this.tools.get(tool);
    if (existing) return existing;
    throw new Error(this.buildNotFoundMessage(ref));
  }

  /** Has a bundled tool's input set changed since it was loaded? (reload mode) */
  private async isStale(fl: FileLoad): Promise<boolean> {
    // Always retry a failed load. A bundle failure (e.g. a missing/edited-away
    // helper) yields no esbuild metafile, so we don't know the full input set
    // to watch — recording only the entry would leave the tool stuck-broken
    // after a *helper* is fixed/recreated without touching the entry. Re-running
    // the (fast-failing) bundle each reference makes recovery instant for any
    // fix; healthy tools keep the signature short-circuit below.
    if (fl.error !== undefined) return true;
    // Defensive: a load with no recorded signature (shouldn't happen for a
    // successful reload-mode load) is treated as stale rather than trusted.
    if (fl.signature === undefined || fl.inputs === undefined) return true;
    return (await signatureOf(fl.inputs)) !== fl.signature;
  }

  /**
   * Import one tool file, isolating any failure into its `FileLoad.error`. In
   * reload mode the file is bundled to a fresh temp module (defeating tsx's
   * transpile cache) and its change signature recorded; otherwise it's
   * imported directly once (the CLI / programmatic path).
   */
  private async loadFile(absPath: string): Promise<void> {
    // Read into a local so TS narrows `cacheDir` to string; the condition is
    // exactly `canReload` (kept inline here for that narrowing).
    const { cacheDir } = this;
    if (this.reloadEnabled && cacheDir !== undefined) {
      await this.loadFileWithReload(absPath, cacheDir);
    } else {
      await this.loadFileDirect(absPath);
    }
  }

  /** Load-once path: import the file as-is, no change tracking. */
  private async loadFileDirect(absPath: string): Promise<void> {
    try {
      const defs = await importToolFile(absPath);
      this.byFile.set(absPath, { tools: this.buildToolMap(defs, absPath) });
    } catch (err) {
      this.byFile.set(absPath, { tools: new Map(), error: errorMessage(err) });
    }
  }

  /** Reload path: esbuild-bundle to a fresh module and record a change signature. */
  private async loadFileWithReload(absPath: string, cacheDir: string): Promise<void> {
    try {
      const { module, inputs } = await bundleAndImport(absPath, cacheDir);
      const defs = finaliseModule(module, absPath);
      const tools = this.buildToolMap(defs, absPath);
      this.byFile.set(absPath, { tools, inputs, signature: await signatureOf(inputs) });
    } catch (err) {
      // Record just the error (no signature): a failed bundle has no reliable
      // input set, and `isStale` always retries an errored load, so any
      // subsequent fix — to the entry *or* a helper — recovers on the next
      // reference without a restart.
      this.byFile.set(absPath, { tools: new Map(), error: errorMessage(err) });
    }
  }

  /** Turn finalised tool defs into a name→tool map (dup check + empty warning). */
  private buildToolMap(defs: RegisteredTool[], absPath: string): Map<string, RegisteredTool> {
    const tools = new Map<string, RegisteredTool>();
    for (const rt of defs) {
      if (tools.has(rt.definition.name)) {
        throw new Error(
          `Duplicate tool name "${rt.definition.name}" — defined twice in ${absPath}`,
        );
      }
      tools.set(rt.definition.name, rt);
    }
    if (defs.length === 0) {
      logger.warn(
        `Skipping ${absPath}: no tool exports found (expected a defineTool/tool default export, a bare function, or named tool exports)`,
      );
    }
    return tools;
  }

  /** Error for "the file loaded, but has no tool by that name". */
  private buildToolNotInFileMessage(
    ref: string,
    tool: string,
    absPath: string,
    names: string[],
  ): string {
    const lines = [`Tool "${tool}" not found in ${absPath} (referenced as "${ref}").`];
    if (names.length > 0) {
      // Build the example from the file portion of the ref so a sugar ref
      // (`unrelated`) suggests `unrelated/preferred`, not the bare `preferred`.
      const { file } = parseToolRef(ref);
      lines.push(`  That file registers: [${names.join(', ')}].`);
      lines.push(`  Reference one as "<file>/<name>", e.g. "${file}/${names[0]!}".`);
    } else {
      lines.push(`  That file registers no tools.`);
    }
    return lines.join('\n');
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  register(tool: RegisteredTool): void {
    const existing = this.tools.get(tool.definition.name);
    if (existing) {
      throw new Error(
        `Duplicate tool name "${tool.definition.name}" — defined in ${existing.filePath} and ${tool.filePath}`,
      );
    }
    this.tools.set(tool.definition.name, tool);
  }

  /** Compose the user-facing error for `require(name)` when the tool is absent. */
  buildNotFoundMessage(name: string): string {
    const registered = [...this.tools.keys()];
    const lines: string[] = [`Tool "${name}" not found in catalogue.`];

    if (this.diagnostics) {
      const { toolsDir, toolsDirMissing, filesScanned } = this.diagnostics;
      if (toolsDirMissing) {
        lines.push(
          `  tools.dir does not exist: ${toolsDir}`,
          `  Either create the directory and add tool files there, or update`,
          `  \`tests.toolsDir\` in your steptix.config.json to point at where your tools live.`,
        );
      } else {
        lines.push(`  Scanned: ${toolsDir} (${filesScanned} file${filesScanned === 1 ? '' : 's'})`);
      }
    }

    lines.push(
      registered.length === 0
        ? `  Registered tools: [none]`
        : `  Registered tools: [${registered.join(', ')}]`,
    );

    if (registered.length === 0) {
      lines.push(
        '',
        `To register a tool, drop a TypeScript file in your tools.dir whose default export is a defineTool(...) result:`,
        '',
        `    // tools/${name}.ts`,
        `    import { defineTool } from 'steptix/tools';`,
        ``,
        `    export default defineTool({`,
        `      name: '${name}',`,
        `      parameters: { /* ... */ },`,
        `      outputs:    { /* ... */ },`,
        `      async run(args, { page, step, log }) { /* ... */ },`,
        `    });`,
      );
    }

    return lines.join('\n');
  }
}

const TOOL_FILE_EXTS = new Set(['.ts', '.mts', '.js', '.mjs']);

/**
 * Split a tool reference into the file path and tool name it addresses.
 *
 * The **last** `/`-separated segment is the tool name; everything before it is
 * the file path (relative to `toolsDir`, no extension). A lone segment is sugar
 * for "the tool named after the file":
 *
 *   parseToolRef('check_health')   → { file: 'check_health',          tool: 'check_health' }
 *   parseToolRef('auth/login')     → { file: 'auth',                  tool: 'login' }
 *   parseToolRef('a/b/c/run')      → { file: 'a/b/c',                 tool: 'run' }
 *
 * Throws on malformed refs (empty segments, leading/trailing slash) so the
 * caller surfaces a clear parse error rather than a confusing "not found".
 */
export function parseToolRef(ref: string): { file: string; tool: string } {
  const segments = ref.split('/');
  if (segments.some((s) => s.length === 0)) {
    throw new Error(
      `Invalid tool reference "${ref}": empty path segment (no leading/trailing or doubled '/').`,
    );
  }
  if (segments.length === 1) {
    return { file: ref, tool: ref };
  }
  return { file: segments.slice(0, -1).join('/'), tool: segments[segments.length - 1]! };
}

/**
 * Scan `dir` (recursively) and build a *lazy* tool catalogue: every `.ts` /
 * `.js` file is recorded in the file index, but **none are imported**. Tools
 * are imported on first `resolve`, so one broken file can't abort the scan and
 * a project with thousands of tools pays nothing at load time.
 *
 * Returns an empty catalogue if `dir` is missing — projects that don't use
 * tools shouldn't be forced to create the directory.
 */
export async function loadToolCatalogue(
  dir: string,
  options: LoadToolCatalogueOptions = {},
): Promise<ToolCatalogue> {
  const reload = options.reload ?? false;
  // Where reload writes temp tool modules (a dot-dir inside `dir`); only needed
  // in reload mode. A pure path computation — valid even if `dir` doesn't exist
  // yet (a later `refreshIndex` may find it created).
  const cacheDir = reload ? resolveToolCacheDir(dir) : undefined;
  // `scannedDir` is set for both branches so `refreshIndex` can re-walk later —
  // including a dir that was missing at first scan and is created mid-session.
  const catalogue = new ToolCatalogue({ reload, scannedDir: dir, cacheDir });

  let exists = true;
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`tools.dir "${dir}" exists but is not a directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      exists = false;
    } else {
      throw err;
    }
  }

  if (!exists) {
    // Tools are optional — projects without any keep working. A `toolsDir`
    // the project pointed somewhere else that isn't there is probably a typo,
    // so that one warns. The default directory being absent just means the
    // project has no tools yet — every fresh `steptix init` project is in that
    // state — so it stays at debug rather than greeting a new user's first run
    // with a warning. Either way, a `[tool: ...]` step that does run fails with
    // `buildNotFoundMessage`, which names the missing directory.
    const message =
      `tools.dir "${dir}" does not exist — no tools registered. ` +
      `Update \`tests.toolsDir\` in steptix.config.json if your tools live elsewhere.`;
    if (options.defaultDir !== undefined && samePath(dir, options.defaultDir)) {
      logger.debug(message);
    } else {
      logger.warn(message);
    }
    catalogue.diagnostics = { toolsDir: dir, toolsDirMissing: true, filesScanned: 0 };
    return catalogue;
  }

  const files = await listToolFiles(dir);
  for (const abs of files) {
    catalogue.indexFile(relKey(dir, abs), abs);
  }

  catalogue.diagnostics = { toolsDir: dir, toolsDirMissing: false, filesScanned: files.length };
  logger.debug(`Indexed ${files.length} tool file(s) from ${dir} (lazy load)`);
  return catalogue;
}

/**
 * Where `tests.toolsDir` points for a project rooted at `projectRoot` that
 * leaves it at its default (or spells the default out, as the `steptix init`
 * scaffold does). Pass it as `defaultDir` to `loadToolCatalogue`.
 */
export function defaultToolsDir(projectRoot: string): string {
  return path.resolve(projectRoot, DEFAULT_CONFIG.tests.toolsDir);
}

/** `path.relative` compares case-insensitively on Windows, as the filesystem does. */
function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/**
 * Index key for a tool file: its path relative to the tools dir, OS separators
 * normalised to `/`, extension stripped (e.g. `auth`, `integrations/stripe/refund`).
 */
function relKey(dir: string, abs: string): string {
  return path
    .relative(dir, abs)
    .replace(/\\/g, '/')
    .replace(/\.[^./]+$/, '');
}

async function listToolFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (TOOL_FILE_EXTS.has(ext)) {
          if (entry.name.endsWith('.d.ts')) continue;
          if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.js')) continue;
          out.push(full);
        }
      }
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

/**
 * Import one tool file directly (no re-transpile) and finalise every tool it
 * exports. Returns the parsed `RegisteredTool`s without registering them — the
 * caller (`loadFileDirect`) stores them in a per-file map. Throws on an import
 * failure or an illegal filename.
 */
async function importToolFile(filePath: string): Promise<RegisteredTool[]> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load tool file ${filePath}: ${(err as Error).message}`);
  }
  return finaliseModule(mod, filePath);
}

/**
 * Finalise every tool exported by an already-imported module. Shared by the
 * direct-import (`importToolFile`) and reload (`bundleAndImport`) paths so both
 * recognise the same export shapes. Throws on an illegal filename.
 */
function finaliseModule(mod: Record<string, unknown>, filePath: string): RegisteredTool[] {
  const filename = path.basename(filePath, path.extname(filePath));
  const out: RegisteredTool[] = [];

  // Default export — may be a fully-formed ToolDefinition (rung 3), a
  // DeferredTool from `tool(...)` (rung 2), or a bare function (rung 1).
  if (mod.default !== undefined) {
    const defaultDef = finaliseToolExport(mod.default, { filename, filePath });
    if (defaultDef) out.push({ definition: defaultDef, filePath });
  }

  // Named exports — multi-tool files. Each export key serves as the tool name
  // when the export itself doesn't declare one. Non-tool exports are silently
  // ignored so authors can keep helper types/constants alongside their tools.
  for (const [exportKey, value] of Object.entries(mod)) {
    if (exportKey === 'default') continue;
    const namedDef = finaliseToolExport(value, { filename, filePath, exportKey });
    if (namedDef) out.push({ definition: namedDef, filePath });
  }

  return out;
}

/** Normalise a thrown value to a message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
