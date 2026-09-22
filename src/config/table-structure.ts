/**
 * The `## Config: tableStructure:` value and its project-wide twin
 * `tables.structure` in `aiui.config.json`
 * (docs/specs/SPEC-structured-table-reads.md §7.10, "Cost and control").
 *
 * One validator, three callers — the CLI's `runTest`, the server's
 * `SessionManager` and the MCP assembler — for the reason
 * `src/config/viewport.ts` has one: the value travels the wire as the RAW
 * string the author typed, so the sentence a bad value produces must be the
 * same wherever it is read.
 */
import { logger } from '../utils/logger.js';
import type { Config } from './types.js';

/** What the key accepts. `ask` is the default (`src/config/defaults.ts`). */
export const TABLE_STRUCTURE_MODES = ['ask', 'strict'] as const;

export type TableStructureMode = (typeof TABLE_STRUCTURE_MODES)[number];

/** Is this one of the two modes? */
export function isTableStructureMode(value: unknown): value is TableStructureMode {
  return value === 'ask' || value === 'strict';
}

/**
 * Resolve the mode a run uses: the test's `## Config: tableStructure:` when it
 * named one, else the project's `tables.structure`, else `ask`.
 *
 * An unrecognised value is WARNED about and ignored, exactly as
 * `consoleLogLevel:` treats one (src/runner/test-runner.ts): the key only
 * decides whether one model call may happen, so refusing the whole run over a
 * typo would cost more than it saves. A refusal would also have to be raised
 * identically on three paths to mean anything.
 */
export function resolveTableStructure(
  raw: string | undefined,
  projectDefault: TableStructureMode | undefined,
): TableStructureMode {
  const trimmed = raw?.trim();
  if (trimmed) {
    if (isTableStructureMode(trimmed)) return trimmed;
    logger.warn(
      `Ignoring invalid '## Config: tableStructure: ${trimmed}' — expected one of: `
      + `${TABLE_STRUCTURE_MODES.join(', ')}`,
    );
  }
  return isTableStructureMode(projectDefault) ? projectDefault : 'ask';
}

/**
 * The mode a `Config` in hand is in.
 *
 * Read through this rather than `config.tables.structure` directly: a great
 * many tests (and the odd in-process caller) build a `Config` by casting a
 * partial literal, so the section can be absent at runtime however required it
 * is in the type. Absent means `ask`, which is the default.
 */
export function tableStructureOf(config: Config): TableStructureMode {
  const value: unknown = config.tables?.structure;
  return isTableStructureMode(value) ? value : 'ask';
}

/**
 * Apply a test's `## Config: tableStructure:` to a `Config`, returning a FRESH
 * object when it changes anything.
 *
 * Never a mutation: `runTest` is called once per data row with the same
 * `Config` the caller holds, and the server rebuilds one per batch from its
 * own startup config, so writing through would leak one test's choice into the
 * next.
 */
export function withTableStructure(
  config: Config,
  raw: string | undefined,
): Config {
  const mode = resolveTableStructure(raw, tableStructureOf(config));
  if (mode === tableStructureOf(config)) return config;
  return { ...config, tables: { ...config.tables, structure: mode } };
}
