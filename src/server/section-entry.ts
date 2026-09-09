/**
 * The `sections` map entry validator — the one rule set that decides whether
 * a section payload is well formed.
 *
 * Its own module, and pure (one import, `matchText`), so a test on the CLIENT
 * side can run a payload it just built through the exact code the server
 * would 400 it with. The alternative is a mirror of the rules in the fast
 * suite, which is the failure mode this whole contract exists to avoid: the
 * copy passes, the server refuses, and the run dies minutes later against a
 * message nobody was asserting on.
 *
 * See stories/test-script-sections-contract.md §3.2 for the frozen shape.
 */

import { matchText } from '../parser/section-match.js';

/**
 * Validate one entry of the `sections` map, returning an error message or
 * null. Contract §3.2's table, one condition per row.
 *
 * Deliberately strict about the `steps`/`stepLines` arity: they are parallel
 * arrays, and a skew means the server would attribute a body step to the
 * wrong source line — a wrong gutter, a wrong breakpoint, a wrong re-run
 * anchor. Cheaper to refuse the request than to debug that later.
 */
export function validateSectionEntry(key: string, raw: unknown): string | null {
  const where = `sections["${key}"]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${where} must be an object`;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.name !== 'string') return `${where}.name must be a string`;
  if (typeof entry.headingLine !== 'number' || !Number.isFinite(entry.headingLine)) {
    return `${where}.headingLine must be a number`;
  }
  if (!Array.isArray(entry.steps) || !entry.steps.every((s) => typeof s === 'string')) {
    return `${where}.steps must be an array of strings`;
  }
  // A looped section's rows (stories/data-driven-rows.md, part B). Refused
  // rather than ignored: a malformed `rows` would silently run the body once
  // instead of N times, which is the failure the whole feature is about.
  if (entry.rows !== undefined) {
    if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
      return `${where}.rows must be a non-empty array when present`;
    }
    for (const row of entry.rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        Array.isArray(row) ||
        !Object.values(row as Record<string, unknown>).every((v) => typeof v === 'string')
      ) {
        return `${where}.rows entries must be objects of string values`;
      }
    }
  }
  // The row NUMBERING of a narrowed section loop
  // (stories/data-row-progress-and-selection.md, decision 1). A client that
  // ships only some of the table's rows says where each one sits in the
  // authored table, so the iteration keeps its table number everywhere.
  //
  // Refused rather than repaired, and refused as a PAIR: a `rowNumbers` with
  // no `rowCount` would number iterations 2 and 3 "of 2", and a `rowCount`
  // with no `rowNumbers` would say "of 3" while numbering from 1 — both are
  // wrong in a way that only shows up as an off-by-one in a badge, days later.
  const hasRowNumbers = entry.rowNumbers !== undefined;
  const hasRowCount = entry.rowCount !== undefined;
  if (hasRowNumbers !== hasRowCount) {
    return (
      `${where}.rowNumbers and ${where}.rowCount must be sent together or not at all ` +
      `(got ${hasRowNumbers ? 'rowNumbers' : 'rowCount'} alone)`
    );
  }
  if (hasRowNumbers) {
    const rowNumbers = entry.rowNumbers;
    if (
      !Array.isArray(rowNumbers) ||
      !rowNumbers.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1)
    ) {
      return `${where}.rowNumbers must be an array of positive integers`;
    }
    const rows = entry.rows;
    if (!Array.isArray(rows)) {
      return `${where}.rowNumbers requires ${where}.rows — it numbers them`;
    }
    if (rowNumbers.length !== rows.length) {
      return (
        `${where}.rowNumbers and ${where}.rows must be the same length ` +
        `(got ${rowNumbers.length} and ${rows.length}) — they are parallel arrays`
      );
    }
    // Strictly ascending, which rules out a duplicate in the same test: rows
    // run in table order, and a list that says otherwise means the client
    // built it from something other than the table.
    for (let i = 1; i < rowNumbers.length; i++) {
      if ((rowNumbers[i] as number) <= (rowNumbers[i - 1] as number)) {
        return (
          `${where}.rowNumbers must be strictly ascending ` +
          `(got ${rowNumbers[i - 1]} then ${rowNumbers[i]})`
        );
      }
    }
    const rowCount = entry.rowCount;
    if (typeof rowCount !== 'number' || !Number.isInteger(rowCount) || rowCount < 1) {
      return `${where}.rowCount must be a positive integer`;
    }
    if (rowCount < rows.length) {
      return (
        `${where}.rowCount is ${rowCount} but ${where}.rows holds ${rows.length} rows — ` +
        `the count is the whole table's, so it can never be smaller`
      );
    }
    const last = rowNumbers[rowNumbers.length - 1] as number;
    if (last > rowCount) {
      return (
        `${where}.rowNumbers must all be <= ${where}.rowCount ` +
        `(got ${last} with a rowCount of ${rowCount})`
      );
    }
  }
  // Which BODY STEPS of the section this run executes, when a selection
  // narrowed them (stories/data-row-progress-and-selection.md, decision 3).
  // 0-based indices into `steps` — the same axis `rowNumbers` is for rows.
  //
  // Refused rather than repaired, for the reason `rows` is: a list the server
  // quietly cleaned up would run a body step the author excluded, or skip one
  // they picked, and neither says anything at the time. Ascending and unique
  // because a body runs in document order — a list that says otherwise was
  // built from something other than the body.
  if (entry.runSteps !== undefined) {
    const runSteps = entry.runSteps;
    if (
      !Array.isArray(runSteps) ||
      runSteps.length === 0 ||
      !runSteps.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    ) {
      return `${where}.runSteps must be a non-empty array of 0-based step indices`;
    }
    for (let i = 1; i < runSteps.length; i++) {
      if ((runSteps[i] as number) <= (runSteps[i - 1] as number)) {
        return (
          `${where}.runSteps must be strictly ascending ` +
          `(got ${runSteps[i - 1]} then ${runSteps[i]})`
        );
      }
    }
    const last = runSteps[runSteps.length - 1] as number;
    if (last >= entry.steps.length) {
      return (
        `${where}.runSteps must all be < ${where}.steps.length ` +
        `(got ${last} with ${entry.steps.length} step${entry.steps.length === 1 ? '' : 's'})`
      );
    }
  }
  if (
    !Array.isArray(entry.stepLines) ||
    !entry.stepLines.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return `${where}.stepLines must be an array of numbers`;
  }
  if (entry.steps.length !== entry.stepLines.length) {
    return (
      `${where}.steps and ${where}.stepLines must be the same length ` +
      `(got ${entry.steps.length} and ${entry.stepLines.length}) — they are parallel arrays`
    );
  }
  // The map is keyed by `matchText(name)` and the server uses the incoming
  // keys VERBATIM (contract §3.2 forbids re-deriving them for use). Nothing
  // stops a client sending a key that isn't the normalized name, and the
  // result is a section that can never be called: every lookup derives its
  // key from the step text, so it misses, and the bare name ships to the AI.
  //
  // §3.2 forbids re-deriving the key for use. It does not forbid VALIDATING
  // it, and this is the one invariant that makes the whole map addressable.
  const expected = matchText(entry.name);
  if (key !== expected) {
    return (
      `${where} is keyed "${key}" but its name normalizes to "${expected}". ` +
      `Section maps are keyed by matchText(name); a mismatched key can never be called.`
    );
  }
  // An empty name is refused at parse time by all three implementations
  // (contract §2.5) and never enters an index, so it cannot arrive here from
  // a well-behaved client — and if it did, it would be uncallable.
  if (expected === '') return `${where} has an empty name`;
  return null;
}
