/**
 * What this RUN has already learned about a region's structure
 * (docs/specs/SPEC-structured-table-reads.md §7.10: one question per
 * structure per run).
 *
 * A test that reads one table in step 2 and reads it again in step 10 — to
 * check the page after a click — would otherwise ask the model all over again.
 * Measured on `table-odd-shapes.md`: four shapes, five reads, five questions.
 *
 * The memo is alive for one run and keyed by the REGION and the columns asked
 * of it, so any later step reading the same thing reuses the answer. Nothing
 * carries it across runs.
 *
 * It is not trusted blind. A memo hit is applied through the extractor like
 * any other mapping and validated against the live page before a cell is read,
 * so a page that changed between step 2 and step 10 falls through to the
 * question rather than reading the wrong table.
 */
import type { AIAction, TableReadMapping } from '../ai/types.js';

/** One remembered structure. */
export interface StructureMemoEntry {
  /** The mapping, exactly as it was validated when it was first answered. */
  mapping: TableReadMapping;
  /** The step that established it, for the log line the reuse writes. Without
   *  it "structure reused" says nothing about where the answer came from, and
   *  the one thing a reader wants next is which read paid for it. */
  stepIndex: number;
}

/** The run's memo. Created once per run and threaded into every step. */
export type StructureMemo = Map<string, StructureMemoEntry>;

/** A fresh, empty memo. One per run — never per step, and never global. */
export function createStructureMemo(): StructureMemo {
  return new Map();
}

/**
 * What makes two reads "the same structure".
 *
 * The region (selector plus the frame it is in) and the COLUMNS asked of it.
 * The columns are part of the key because a mapping is only valid for the
 * request it was validated against: a `table` answer resolved every requested
 * header against the header row it named, and a `collection` answer carries
 * one field selector per requested key — so the same cards read for
 * `account, balance` and later for `account, owner` are two different
 * mappings, and reusing the first would read a column the model never chose a
 * selector for.
 *
 * Sorted, so the same columns in another order are one key: order changes the
 * record's property order and nothing about the structure.
 *
 * A column is keyed by BOTH its name (or position) and its output key: the
 * header is what the mapping resolved, and the key is what a collection's
 * `fields` is indexed by. `Payee → payee` and `Payee → who` want the same
 * table and different `fields`.
 */
export function structureMemoKey(action: AIAction): string {
  const columns = (action.columns ?? [])
    .map((c) => (c.index !== undefined ? `#${c.index}=${c.key}` : `${c.header ?? ''}=${c.key}`))
    .sort();
  return JSON.stringify([action.frame ?? '', action.selector ?? '', columns]);
}
