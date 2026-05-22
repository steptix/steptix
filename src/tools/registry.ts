import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { logger } from '../utils/logger.js';
import type { ToolDefinition } from './types.js';
import { finaliseToolExport } from './finalise.js';

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
      if (!this.byFile.has(abs)) {
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

  /** Import one tool file, isolating any failure into its `FileLoad.error`. */
  private async loadFile(absPath: string): Promise<void> {
    try {
      const defs = await importToolFile(absPath);
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
      this.byFile.set(absPath, { tools });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.byFile.set(absPath, { tools: new Map(), error: message });
    }
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
          `  \`tests.toolsDir\` in your aiui.config.json to point at where your tools live.`,
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
        `    import { defineTool } from 'ai-ui-automation/tools';`,
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
export async function loadToolCatalogue(dir: string): Promise<ToolCatalogue> {
  const catalogue = new ToolCatalogue();

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
    // Tools are optional — projects without any keep working — but emit a
    // warning rather than a debug line so a misconfigured `tests.toolsDir`
    // surfaces loudly the first time a `[tool:...]` step is invoked.
    logger.warn(
      `tools.dir "${dir}" does not exist — no tools registered. ` +
      `Update \`tests.toolsDir\` in aiui.config.json if your tools live elsewhere.`,
    );
    catalogue.diagnostics = { toolsDir: dir, toolsDirMissing: true, filesScanned: 0 };
    return catalogue;
  }

  const files = await listToolFiles(dir);
  for (const abs of files) {
    // Key by path relative to the tools dir, extension stripped, `/`-normalised.
    const rel = path
      .relative(dir, abs)
      .replace(/\\/g, '/')
      .replace(/\.[^./]+$/, '');
    catalogue.indexFile(rel, abs);
  }

  catalogue.diagnostics = { toolsDir: dir, toolsDirMissing: false, filesScanned: files.length };
  logger.debug(`Indexed ${files.length} tool file(s) from ${dir} (lazy load)`);
  return catalogue;
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
 * Import one tool file and finalise every tool it exports. Returns the parsed
 * `RegisteredTool`s without registering them — the caller (`loadFile`) stores
 * them in a per-file map. Throws on an import failure or an illegal filename.
 */
async function importToolFile(filePath: string): Promise<RegisteredTool[]> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load tool file ${filePath}: ${(err as Error).message}`);
  }

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
