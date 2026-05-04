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

export class ToolCatalogue {
  private readonly tools = new Map<string, RegisteredTool>();

  get size(): number {
    return this.tools.size;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Throwing accessor for runtime call sites that have already validated the name. */
  require(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(
        `Tool "${name}" not found in catalogue. Registered tools: [${[...this.tools.keys()].join(', ') || 'none'}]`,
      );
    }
    return tool;
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
}

const TOOL_FILE_EXTS = new Set(['.ts', '.mts', '.js', '.mjs']);

/**
 * Walk `dir` (recursively) and import every `.ts` / `.js` file as a tool.
 *
 * Each file's default export must be the result of `defineTool`. Files that
 * don't export a tool are skipped with a warning. Name collisions abort.
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
    logger.debug(`tools.dir "${dir}" does not exist — no tools registered`);
    return catalogue;
  }

  const files = await listToolFiles(dir);
  for (const file of files) {
    await loadOne(file, catalogue);
  }

  logger.debug(`Loaded ${catalogue.size} tool(s) from ${dir}`);
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

async function loadOne(filePath: string, catalogue: ToolCatalogue): Promise<void> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load tool file ${filePath}: ${(err as Error).message}`);
  }

  const filename = path.basename(filePath, path.extname(filePath));
  let registeredFromThisFile = 0;

  // Default export — may be a fully-formed ToolDefinition (rung 3), a
  // DeferredTool from `tool(...)` (rung 2), or a bare function (rung 1).
  if (mod.default !== undefined) {
    const defaultDef = finaliseToolExport(mod.default, { filename, filePath });
    if (defaultDef) {
      catalogue.register({ definition: defaultDef, filePath });
      registeredFromThisFile += 1;
    }
  }

  // Named exports — multi-tool files. Each export key serves as the tool name
  // when the export itself doesn't declare one. Non-tool exports are silently
  // ignored so authors can keep helper types/constants alongside their tools.
  for (const [exportKey, value] of Object.entries(mod)) {
    if (exportKey === 'default') continue;
    const namedDef = finaliseToolExport(value, {
      filename,
      filePath,
      exportKey,
    });
    if (namedDef) {
      catalogue.register({ definition: namedDef, filePath });
      registeredFromThisFile += 1;
    }
  }

  if (registeredFromThisFile === 0) {
    logger.warn(
      `Skipping ${filePath}: no tool exports found (expected a defineTool/tool default export, a bare function, or named tool exports)`,
    );
  }
}
