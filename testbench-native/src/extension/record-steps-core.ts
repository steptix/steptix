/**
 * Record Steps — where the recorded steps go, and the one edit that puts them
 * there (stories/testbench-record-steps.md, decisions 8 and 11). No `vscode`
 * import, so every rule is pinned under `node --test`.
 *
 * The server records and the model writes; TestBench does the editing. What
 * comes back is a list of step texts with no numbers and a list of
 * parameters, and this module turns that into range edits against the
 * document AS IT STANDS when the result arrives:
 *
 *  - the steps, numbered to follow the line the recording was anchored to,
 *    inserted after it in the same flow (the main flow, or one `### Section`
 *    body);
 *  - every step after them in that flow renumbered — by `computeRenumberEdits`,
 *    the Renumber Steps walk, not a second numbering rule;
 *  - each parameter the file does not already have, under `## Parameters`
 *    (created immediately above `## Steps` when there is none). An existing
 *    line is never changed, even when its value differs — that is reported.
 *
 * All of it is ONE list of non-overlapping edits in the original document's
 * coordinates, which the command applies through a single `editor.edit` so the
 * whole insertion is one undo step.
 *
 * What counts as a step is runner-core's `classifyLines`, with the fence
 * correction renumber-core makes: a numbered line inside a ``` fence is text.
 */
import * as path from 'node:path';
import {
  classifyLines,
  parseConfig,
  scanSectionItems,
  type ClassifiedLine,
  type RecordActionKind,
  type RecordingPanelState,
} from 'ai-ui-automation-runner-core';
// `.ts` specifiers: the vscode-free modules the `node --test` suite imports
// directly (see renumber-core.ts for why the extension is literal).
import { isFenceDelimiter } from './step-region-core.ts';
import { computeRenumberEdits } from './renumber-core.ts';

// ---------------------------------------------------------------------------
// Shared line model
// ---------------------------------------------------------------------------

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const LEADING_ORDINAL_RE = /^(\d+)\./;
/** Same grammar as runner-core's test-meta (`## Config` / `## Parameters`). */
const META_HEADING_RE = /^(#{2,})\s+(\S.*?)\s*$/;
const PARAMETER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface LineModel {
  lines: string[];
  classified: ClassifiedLine[];
  fenced: boolean[];
  /** 0-based index of the `## Steps` heading, or -1. */
  stepsIdx: number;
}

function modelOf(text: string): LineModel {
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(text);
  const fenced: boolean[] = new Array(lines.length);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    fenced[i] = open;
    if (isFenceDelimiter(lines[i] ?? '')) open = !open;
  }
  let stepsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (classified[i]?.kind === 'heading' && STEPS_HEADING_RE.test(lines[i] ?? '')) {
      stepsIdx = i;
      break;
    }
  }
  return { lines, classified, fenced, stepsIdx };
}

function kindAt(m: LineModel, idx: number): ClassifiedLine['kind'] | undefined {
  return m.fenced[idx] ? undefined : m.classified[idx]?.kind;
}

function isStepKind(kind: ClassifiedLine['kind'] | undefined): boolean {
  return kind === 'step' || kind === 'section-step';
}

/**
 * A line that continues the list item above it: Markdown folds a non-blank
 * paragraph line under a step into that step, so `1. Type the username` /
 * `   into the tenant field` is ONE step, and new steps must not land between
 * its halves. A table row is not folded here — a data table directly under a
 * step is its own block — and neither is a fence.
 */
function isContinuation(m: LineModel, idx: number): boolean {
  const raw = m.lines[idx] ?? '';
  return (
    !m.fenced[idx] &&
    m.classified[idx]?.kind === 'prose' &&
    raw.trim() !== '' &&
    !raw.trimStart().startsWith('|') &&
    !isFenceDelimiter(raw)
  );
}

/** The step a continuation line at `idx` belongs to, or null. */
function stepOwning(m: LineModel, idx: number): number | null {
  let j = idx;
  while (j >= 0 && isContinuation(m, j)) j--;
  return j >= 0 && isStepKind(kindAt(m, j)) ? j : null;
}

function sectionNameOf(raw: string): string {
  return raw.replace(/^#{3,}\s*/, '').trim();
}

/** The `### Section` whose body holds `idx`, or null for the main flow. */
function sectionOf(m: LineModel, idx: number): string | null {
  for (let j = idx; j >= 0; j--) {
    if (kindAt(m, j) === 'section-heading') return sectionNameOf(m.lines[j] ?? '');
    if (j === m.stepsIdx) return null;
  }
  return null;
}

/** 0-based index of the first section heading named `name`, or -1. */
function sectionHeadingIdx(m: LineModel, name: string): number {
  for (let i = 0; i < m.lines.length; i++) {
    if (kindAt(m, i) === 'section-heading' && sectionNameOf(m.lines[i] ?? '') === name) return i;
  }
  return -1;
}

/** Step lines (0-based) of one flow, in order. */
function flowSteps(m: LineModel, section: string | null): number[] {
  const out: number[] = [];
  if (section === null) {
    for (let i = 0; i < m.lines.length; i++) if (kindAt(m, i) === 'step') out.push(i);
    return out;
  }
  const heading = sectionHeadingIdx(m, section);
  if (heading < 0) return out;
  for (let i = heading + 1; i < m.lines.length; i++) {
    const kind = kindAt(m, i);
    if (kind === 'section-heading') break;
    if (kind === 'section-step') out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where the cursor puts the recording
// ---------------------------------------------------------------------------

/**
 * The line the recorded steps go after, remembered in a form that can be
 * found again if the author edits the file while recording.
 */
export interface RecordAnchor {
  /** 1-based line. */
  line: number;
  /** That line exactly as it read. */
  text: string;
  /**
   * `step` — a main-flow or section-body step: the steps follow it.
   * `heading` — `## Steps` or a `### Section` heading, reached from the blank
   * line under it: the steps open that flow, ahead of any step already in it.
   */
  kind: 'step' | 'heading';
  /** The `### Section` the steps join, as authored; null for the main flow. */
  section: string | null;
}

export type CursorResolution = { ok: true; anchor: RecordAnchor } | { ok: false; reason: string };

/**
 * The refusal sentence of docs/specs/SPEC-record-steps.md §10, verbatim, and
 * the cases that add why — a line that LOOKS like a step and is not one is
 * exactly where the bare sentence would puzzle.
 */
const NOT_IN_STEPS = 'Put the cursor on a step, or the blank line after one, under ## Steps.';

export const CURSOR_REFUSALS = {
  noSteps: `${NOT_IN_STEPS} This file has no ## Steps heading.`,
  notAStep: NOT_IN_STEPS,
  inFence: `${NOT_IN_STEPS} That line is inside a code block.`,
  inert: `${NOT_IN_STEPS} That numbered item sits under a #### heading, which the runner ignores.`,
  unnamedSection: `${NOT_IN_STEPS} That section heading has no name, which the runner refuses.`,
} as const;

/**
 * Resolve the author's cursor to an anchor (decision 11), or say why not.
 *
 * Accepted: a step line (main flow or section body), a line that continues a
 * wrapped step, and a blank line whose nearest non-blank line above is one of
 * those — or is the `## Steps` / `### Section` heading itself, which opens
 * that flow (an empty `## Steps`, as Record New Test leaves after a Cancel, is
 * the case that needs it). Refused: headings, prose, frontmatter, anything in
 * a fence, an item under a `####` heading, and everything outside `## Steps`.
 */
export function resolveRecordCursor(text: string, cursorLine: number): CursorResolution {
  const m = modelOf(text);
  if (m.stepsIdx < 0) return { ok: false, reason: CURSOR_REFUSALS.noSteps };
  const i = cursorLine - 1;
  if (i < 0 || i >= m.lines.length) return { ok: false, reason: CURSOR_REFUSALS.notAStep };
  if (m.fenced[i] || isFenceDelimiter(m.lines[i] ?? '')) {
    return { ok: false, reason: CURSOR_REFUSALS.inFence };
  }

  const atStep = (idx: number): CursorResolution => ({
    ok: true,
    anchor: {
      line: idx + 1,
      text: m.lines[idx] ?? '',
      kind: 'step',
      section: kindAt(m, idx) === 'section-step' ? sectionOf(m, idx) : null,
    },
  });

  const kind = m.classified[i]?.kind;
  if (isStepKind(kind)) return atStep(i);
  if (kind === 'inert-step') return { ok: false, reason: CURSOR_REFUSALS.inert };
  if (kind === 'prose') {
    const owner = stepOwning(m, i);
    return owner === null ? { ok: false, reason: CURSOR_REFUSALS.notAStep } : atStep(owner);
  }
  if (kind !== 'blank') return { ok: false, reason: CURSOR_REFUSALS.notAStep };

  // A blank line: it belongs to whatever is above it.
  let j = i - 1;
  while (j >= 0 && m.classified[j]?.kind === 'blank' && !m.fenced[j]) j--;
  if (j < 0 || m.fenced[j] || isFenceDelimiter(m.lines[j] ?? '')) {
    return { ok: false, reason: CURSOR_REFUSALS.notAStep };
  }
  const above = m.classified[j]?.kind;
  if (isStepKind(above)) return atStep(j);
  if (above === 'prose') {
    const owner = stepOwning(m, j);
    return owner === null ? { ok: false, reason: CURSOR_REFUSALS.notAStep } : atStep(owner);
  }
  if (j === m.stepsIdx) {
    return { ok: true, anchor: { line: j + 1, text: m.lines[j] ?? '', kind: 'heading', section: null } };
  }
  if (above === 'section-heading') {
    const name = sectionNameOf(m.lines[j] ?? '');
    if (name === '') return { ok: false, reason: CURSOR_REFUSALS.unnamedSection };
    return { ok: true, anchor: { line: j + 1, text: m.lines[j] ?? '', kind: 'heading', section: name } };
  }
  return { ok: false, reason: CURSOR_REFUSALS.notAStep };
}

// ---------------------------------------------------------------------------
// The one edit
// ---------------------------------------------------------------------------

/** A range replacement, 0-based, in the ORIGINAL document's coordinates. An
 *  insertion is a range whose start and end are the same point. */
export interface RecordEdit {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
}

export interface RecordedParameter {
  name: string;
  value: string;
}

export interface ParameterConflict {
  name: string;
  existing: string;
  recorded: string;
}

export interface RecordInsertionPlan {
  edits: RecordEdit[];
  /** 1-based lines the inserted steps occupy once the edits are applied. */
  insertedLines: number[];
  /** The flow the steps joined. */
  section: string | null;
  /** The anchor's line could not be found again, so the steps went at the end
   *  of their flow instead. */
  fellBack: boolean;
  parametersAdded: string[];
  parameterConflicts: ParameterConflict[];
  /** Sentences for the author: the fallback, conflicts, anything left out. */
  warnings: string[];
}

/**
 * One step text as it will be written: a single line, no leading ordinal.
 * The server sends texts without numbers; a model that numbered one anyway
 * must not produce `4. 1. Click …`.
 */
export function cleanStepText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d+\.\s+/, '')
    .trim();
}

/**
 * The edits that insert `steps` (and add `parameters`) into `text`.
 *
 * `anchor: null` is Record New Test (mode `new`): the steps go at the end of
 * the main flow — directly under `## Steps` in the file it just created.
 *
 * The anchor is looked for where it was and, failing that, by its text (the
 * author may have edited above it while recording). When neither finds it the
 * steps go at the end of the flow the anchor was in, and `fellBack` says so —
 * not literally the end of the `## Steps` span, which would put main-flow
 * steps inside the last section's body.
 */
export function planRecordInsertion(
  text: string,
  args: { anchor: RecordAnchor | null; steps: unknown[]; parameters: unknown[] },
): RecordInsertionPlan | { error: string } {
  const steps = (Array.isArray(args.steps) ? args.steps : []).map(cleanStepText).filter((s) => s !== '');
  if (steps.length === 0) return { error: 'The recording came back with no steps.' };
  const m = modelOf(text);
  if (m.stepsIdx < 0) return { error: CURSOR_REFUSALS.noSteps };
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const warnings: string[] = [];

  // ── Where ──────────────────────────────────────────────────────────────
  let fellBack = false;
  let section: string | null = args.anchor?.section ?? null;
  let anchorIdx: number;
  let anchorKind: 'step' | 'heading';
  const located = args.anchor === null ? null : locateAnchor(m, args.anchor);
  if (located !== null) {
    anchorIdx = located;
    anchorKind = args.anchor!.kind;
  } else {
    if (args.anchor !== null) {
      fellBack = true;
      if (section !== null && sectionHeadingIdx(m, section) < 0) section = null;
    }
    const end = endOfFlow(m, section);
    anchorIdx = end.idx;
    anchorKind = end.kind;
  }
  if (fellBack) {
    warnings.push(
      'The line you started recording from changed while you were recording, so the steps went at the end of ' +
        (section === null ? 'the main flow.' : `the "${section}" section.`),
    );
  }

  let insertAt: number;
  if (anchorKind === 'step') {
    insertAt = anchorIdx + 1;
    while (insertAt < m.lines.length && isContinuation(m, insertAt)) insertAt++;
  } else {
    // Ahead of the flow's first step, so the new steps take its place in the
    // list and share its spacing; directly under the heading when it has none.
    const first = flowSteps(m, section)[0];
    insertAt = first ?? anchorIdx + 1;
  }

  // ── Numbers ────────────────────────────────────────────────────────────
  const prev = anchorKind === 'step' ? writtenOrdinal(m, anchorIdx, section) : 0;
  const newLines = steps.map((s, k) => `${prev + 1 + k}. ${s}`);

  const edits: RecordEdit[] = [];
  if (insertAt < m.lines.length) {
    edits.push(point(insertAt, 0, newLines.map((l) => l + eol).join('')));
  } else {
    const last = m.lines.length - 1;
    edits.push(point(last, (m.lines[last] ?? '').length, newLines.map((l) => eol + l).join('')));
  }

  // The rest of the flow, renumbered by the Renumber Steps walk over the
  // document as it will read: the inserted steps are non-targets, so the walk
  // continues from their numbers exactly as it continues from any step written
  // above a selection.
  const simLines = [...m.lines.slice(0, insertAt), ...newLines, ...m.lines.slice(insertAt)];
  const sim = modelOf(simLines.join('\n'));
  const targets: number[] = [];
  for (let i = insertAt + newLines.length; i < sim.lines.length; i++) {
    const kind = kindAt(sim, i);
    if (kind === 'section-heading') break;
    if (kind === (section === null ? 'step' : 'section-step')) targets.push(i + 1);
  }
  if (targets.length > 0) {
    for (const edit of computeRenumberEdits(sim.lines.join('\n'), targets)) {
      const orig = edit.line - 1 - newLines.length;
      edits.push({ startLine: orig, startChar: 0, endLine: orig, endChar: edit.digits, text: String(edit.ordinal) });
    }
  }

  // ── Parameters ─────────────────────────────────────────────────────────
  const params = planParameters(text, m, args.parameters, eol);
  warnings.push(...params.warnings);
  let shift = 0;
  if (params.edit) {
    edits.push(params.edit);
    if (params.edit.startLine < insertAt) shift = params.lineCount;
  }

  return {
    edits,
    insertedLines: newLines.map((_, k) => insertAt + 1 + k + shift),
    section,
    fellBack,
    parametersAdded: params.added,
    parameterConflicts: params.conflicts,
    warnings,
  };
}

function point(line: number, char: number, text: string): RecordEdit {
  return { startLine: line, startChar: char, endLine: line, endChar: char, text };
}

/** Find the anchor again: where it was, else by its text when that is unique. */
function locateAnchor(m: LineModel, anchor: RecordAnchor): number | null {
  if (anchor.kind === 'heading') {
    if (anchor.section === null) return m.stepsIdx;
    const idx = sectionHeadingIdx(m, anchor.section);
    return idx < 0 ? null : idx;
  }
  const wanted = anchor.section === null ? 'step' : 'section-step';
  const matches = (idx: number): boolean =>
    m.lines[idx] === anchor.text &&
    kindAt(m, idx) === wanted &&
    (anchor.section === null || sectionOf(m, idx) === anchor.section);
  if (matches(anchor.line - 1)) return anchor.line - 1;
  const found: number[] = [];
  for (let i = 0; i < m.lines.length; i++) if (matches(i)) found.push(i);
  return found.length === 1 ? found[0]! : null;
}

/** The last step of a flow, or its heading when it has none. */
function endOfFlow(m: LineModel, section: string | null): { idx: number; kind: 'step' | 'heading' } {
  const steps = flowSteps(m, section);
  const last = steps[steps.length - 1];
  if (last !== undefined) return { idx: last, kind: 'step' };
  return { idx: section === null ? m.stepsIdx : sectionHeadingIdx(m, section), kind: 'heading' };
}

/**
 * The number the anchor step is written with — what the new steps continue
 * from, as the renumber walk continues from a non-target. An ordinal beyond
 * exact integer range (which the walk also refuses to count from) falls back
 * to the step's position in its flow.
 */
function writtenOrdinal(m: LineModel, idx: number, section: string | null): number {
  const match = LEADING_ORDINAL_RE.exec(m.lines[idx] ?? '');
  const n = match ? Number(match[1]) : NaN;
  if (Number.isSafeInteger(n)) return n;
  return flowSteps(m, section).indexOf(idx) + 1;
}

/**
 * The `## Parameters` half of the edit (decision 8): each recorded parameter
 * the file does not have is added; one it has with the same value is left;
 * one it has with a DIFFERENT value is left too, and reported, because the
 * author's line is theirs and the recorded steps now read its value.
 *
 * The section is found by runner-core's own rule — the first heading named
 * Parameters (any depth ≥ 2), ending at the next heading as deep or shallower
 * — so an added line lands where `parseParameters` will read it.
 */
function planParameters(
  text: string,
  m: LineModel,
  recorded: unknown[],
  eol: string,
): {
  edit?: RecordEdit;
  lineCount: number;
  added: string[];
  conflicts: ParameterConflict[];
  warnings: string[];
} {
  const items = scanSectionItems(text, 'Parameters');
  // Last one wins, as `parseSection` reads a duplicated key.
  const existing = new Map<string, string>();
  for (const item of items) existing.set(item.key, item.value);

  const added: string[] = [];
  const conflicts: ParameterConflict[] = [];
  const warnings: string[] = [];
  const toAdd: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(recorded) ? recorded : []) {
    const p = (raw ?? {}) as { name?: unknown; value?: unknown };
    const name = String(p.name ?? '').trim();
    const value = String(p.value ?? '').replace(/\s+/g, ' ').trim();
    if (!PARAMETER_NAME_RE.test(name)) {
      warnings.push(`Left out a parameter named "${name}": a parameter name is letters, digits and _.`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    if (value === '') {
      warnings.push(`Left out parameter "${name}": it came back with no value.`);
      continue;
    }
    const current = existing.get(name);
    if (current !== undefined) {
      if (current !== value) {
        const conflict = { name, existing: current, recorded: value };
        conflicts.push(conflict);
        warnings.push(parameterConflictWarning(conflict));
      }
      continue;
    }
    added.push(name);
    toAdd.push(`- ${name}: ${value}`);
  }
  if (toAdd.length === 0) return { lineCount: 0, added, conflicts, warnings };

  let headingIdx = -1;
  let depth = 0;
  for (let i = 0; i < m.lines.length; i++) {
    const h = META_HEADING_RE.exec(m.lines[i] ?? '');
    if (h && h[2]!.toLowerCase() === 'parameters') {
      headingIdx = i;
      depth = h[1]!.length;
      break;
    }
  }

  if (headingIdx < 0) {
    // No section: create one immediately above `## Steps`, at its depth.
    const hashes = /^#+/.exec(m.lines[m.stepsIdx] ?? '')?.[0] ?? '##';
    const blankBefore = m.stepsIdx > 0 && (m.lines[m.stepsIdx - 1] ?? '').trim() !== '';
    const block = [`${hashes} Parameters`, ...toAdd, ''];
    return {
      edit: point(m.stepsIdx, 0, (blankBefore ? eol : '') + block.map((l) => l + eol).join('')),
      lineCount: block.length + (blankBefore ? 1 : 0),
      added,
      conflicts,
      warnings,
    };
  }

  let end = m.lines.length;
  for (let i = headingIdx + 1; i < m.lines.length; i++) {
    const h = META_HEADING_RE.exec(m.lines[i] ?? '');
    if (h && h[1]!.length <= depth) {
      end = i;
      break;
    }
  }
  // After the section's last bullet; with none, after its last non-blank line
  // (the heading itself when the section is empty).
  let after = headingIdx;
  if (items.length > 0) {
    after = Math.max(...items.map((item) => item.line));
  } else {
    for (let i = end - 1; i > headingIdx; i--) {
      if ((m.lines[i] ?? '').trim() !== '') {
        after = i;
        break;
      }
    }
  }
  const at = after + 1;
  if (at >= m.lines.length) {
    const last = m.lines.length - 1;
    return {
      edit: point(last, (m.lines[last] ?? '').length, toAdd.map((l) => eol + l).join('')),
      lineCount: toAdd.length,
      added,
      conflicts,
      warnings,
    };
  }
  // A heading straight after the new bullets gets its blank line back.
  const headingNext = /^#/.test(m.lines[at] ?? '');
  const lines = headingNext ? [...toAdd, ''] : toAdd;
  return {
    edit: point(at, 0, lines.map((l) => l + eol).join('')),
    lineCount: lines.length,
    added,
    conflicts,
    warnings,
  };
}

/**
 * The sentence a kept-but-different parameter gets — docs/specs/SPEC-record-steps.md
 * §10, verbatim. It names no value: the existing line may hold a secret
 * written literally, and the recorded one is on the page the author just used.
 */
export function parameterConflictWarning(c: ParameterConflict): string {
  return `Parameter ${c.name} already exists with a different value; the recorded value was not added.`;
}

/**
 * `text` with `edits` applied the way the editor applies one edit builder:
 * every range is in the ORIGINAL coordinates, and insertions at the same
 * point keep their list order. Used by the unit tests to read cases as
 * before/after documents; the command applies the edits through the editor.
 */
export function applyRecordEdits(text: string, edits: RecordEdit[]): string {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const offset = (line: number, char: number): number => (starts[line] ?? text.length) + char;
  const ordered = edits
    .map((edit, index) => ({ edit, index, start: offset(edit.startLine, edit.startChar), end: offset(edit.endLine, edit.endChar) }))
    // Back to front, so earlier offsets stay valid; at one point, the later
    // listed edit goes in first so the earlier one ends up in front of it.
    .sort((a, b) => b.start - a.start || b.index - a.index);
  let out = text;
  for (const { edit, start, end } of ordered) out = out.slice(0, start) + edit.text + out.slice(end);
  return out;
}

// ---------------------------------------------------------------------------
// Record New Test
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export type NewTestName = { ok: true; fileName: string; title: string } | { ok: false; reason: string };

/**
 * A test name the author typed, as a safe file name (`<name>.md`) and a title.
 * A trailing `.md` is accepted and not doubled. No folders: the file goes in
 * the project's tests directory, and a path would be a second way to say
 * where that is.
 */
export function validateNewTestName(raw: string): NewTestName {
  const name = raw.trim().replace(/\.md$/i, '').trim();
  if (name === '') return { ok: false, reason: 'Give the test a name, e.g. pay-by-cash.' };
  if (/[\\/]/.test(name)) return { ok: false, reason: 'Use a plain file name, with no folders.' };
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
    return { ok: false, reason: 'A file name cannot contain < > : " | ? * or control characters.' };
  }
  if (!/^[A-Za-z0-9]/.test(name)) return { ok: false, reason: 'Start the name with a letter or a digit.' };
  if (/[. ]$/.test(name)) return { ok: false, reason: 'A file name cannot end with a dot or a space.' };
  if (WINDOWS_RESERVED.test(name.split('.')[0] ?? '')) {
    return { ok: false, reason: `"${name}" is a reserved device name on Windows; pick another.` };
  }
  if (name.length > 100) return { ok: false, reason: 'Keep the name under 100 characters.' };
  return { ok: true, fileName: `${name}.md`, title: titleFromName(name) };
}

/** Words title case leaves lower-case unless they open or close the title. */
const TITLE_SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor',
  'of', 'off', 'on', 'onto', 'or', 'per', 'so', 'the', 'to', 'up', 'via', 'with', 'yet',
]);

/**
 * The new test's `# Title`, in title case (docs/specs/SPEC-record-steps.md
 * §7.2): separators become spaces and each word is capitalised, except the
 * short joining words in the middle — `pay-by-cash` → `Pay by Cash`. Letters
 * the author already capitalised stay (`api-login` → `Api Login`, but
 * `API-login` → `API Login`).
 */
export function titleFromName(name: string): string {
  const words = name.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  return words
    .map((word, i) => {
      const inner = i > 0 && i < words.length - 1;
      if (inner && TITLE_SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * The new file (decision 11): a title, `## Config` with the project's
 * `baseUrl` when one is known, an empty `## Parameters`, and `## Steps`.
 * `cursorLine` is the empty line under `## Steps`, where the steps will go.
 */
export function newTestSkeleton(args: { title: string; baseUrl?: string | null }): {
  text: string;
  cursorLine: number;
} {
  const lines = [
    `# ${args.title}`,
    '',
    '## Config',
    ...(args.baseUrl ? [`- baseUrl: ${args.baseUrl}`] : []),
    '',
    '## Parameters',
    '',
    '## Steps',
    '',
  ];
  return { text: lines.join('\n'), cursorLine: lines.length };
}

/**
 * The `baseUrl` a new test should start at. The project has no `baseUrl`
 * setting of its own — each test declares one under `## Config` — so this is
 * the one the author is looking at (`preferred`, the active test's), else the
 * one most of the project's tests use (first seen wins a tie). Raw values
 * travel, so `$APP_URL` stays a reference.
 */
export function inferBaseUrl(texts: string[], preferred?: string | null): string | null {
  if (preferred && preferred.trim() !== '') return preferred.trim();
  const counts = new Map<string, number>();
  for (const text of texts) {
    const value = parseConfig(text)['baseUrl']?.trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The directory part of a glob that has no wildcards in it: `tests/**\/*.md` →
 * `tests`, `**\/*.md` → ``. An absolute or climbing prefix is not a place in
 * the workspace and reads as none.
 */
export function globStaticPrefix(glob: string): string {
  const segments = glob.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (seg === '' || /[*?[\]{}!]/.test(seg)) break;
    if (seg === '..' || /^[A-Za-z]:$/.test(seg)) return '';
    if (seg !== '.') out.push(seg);
  }
  return out.join('/');
}

/**
 * Where Record New Test creates the file: the project's `tests.dir` from
 * `aiui.config.json`; else the fixed folder `testbench-native.testsGlob`
 * starts in (`tests/**\/*.md` → `tests/`), which is where Test Explorer looks;
 * else the workspace folder itself (the default glob, `**\/*.md`, starts
 * there).
 */
export function newTestDir(args: {
  configTestsDir: string | null;
  testsGlob: string;
  workspaceRoot: string;
}): { dir: string; source: 'config' | 'glob' | 'workspace' } {
  if (args.configTestsDir) return { dir: args.configTestsDir, source: 'config' };
  const prefix = globStaticPrefix(args.testsGlob);
  if (prefix !== '') return { dir: path.resolve(args.workspaceRoot, prefix), source: 'glob' };
  return { dir: args.workspaceRoot, source: 'workspace' };
}

/** `m:ss` since the recording started, for the panel's action list. */
export function formatRecordTime(atMs: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(atMs) ? atMs : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The status bar's text while recording (SPEC-record-steps.md §3.2). */
export function recordingStatusText(state: { phase: string; actions: Array<{ dropped: boolean }> }): string {
  if (state.phase === 'finishing') return 'Finishing…';
  if (state.phase === 'starting') return 'Recording — starting…';
  const n = state.actions.filter((a) => !a.dropped).length;
  return `Recording — ${n} ${n === 1 ? 'action' : 'actions'}`;
}

// ---------------------------------------------------------------------------
// The Recording block's state, frame by frame
// ---------------------------------------------------------------------------

/** A fresh Recording block for `uri`. */
export function newRecordingState(args: { uri: string; file: string; mode: 'cursor' | 'new' }): RecordingPanelState {
  return {
    uri: args.uri,
    file: args.file,
    mode: args.mode,
    phase: 'starting',
    pickArmed: false,
    actions: [],
    draft: null,
    drafting: false,
  };
}

/**
 * Fold one record-stream frame into the Recording block. Returns whether the
 * state changed — the caller re-posts the panel only then.
 *
 * The live draft (decision 9, SPEC-record-steps.md §9.2): each `record:draft`
 * REPLACES the Steps so far list whole — the model may have rewritten its last
 * steps, so there is nothing to merge — and one whose `revision` is not newer
 * than the draft held is ignored, so a late frame cannot put an older draft
 * back. `record:drafting` is the "updating…" marker; `record:writing` is
 * Finishing…, after which the actions are frozen for the ✕ (only `cancel`
 * still does anything server-side).
 *
 * `output`, `record:result` and `done` are not the block's business.
 */
export function applyRecordFrame(state: RecordingPanelState, event: { type: string } & Record<string, unknown>): boolean {
  switch (event.type) {
    case 'record:started':
      if (state.phase === 'starting') state.phase = 'recording';
      state.startedUrl = String(event['url'] ?? '');
      return true;
    case 'record:action': {
      const id = String(event['id'] ?? '');
      if (id === '') return false;
      const tab = event['tab'];
      const entry = {
        id,
        kind: String(event['kind'] ?? 'click') as RecordActionKind,
        summary: String(event['summary'] ?? ''),
        atMs: Number(event['atMs']) || 0,
        ...(tab !== undefined && tab !== null && { tab: String(tab) }),
        dropped: false,
      };
      // An id sent twice is the same action restated; the author's ✕ stays.
      const at = state.actions.findIndex((a) => a.id === id);
      if (at >= 0) state.actions[at] = { ...entry, dropped: state.actions[at]!.dropped };
      else state.actions.push(entry);
      // An action only arrives once the recorder is listening, whatever
      // became of `record:started`. After Stop one can still arrive (a field
      // being typed into is collected then); it joins the list as it is.
      if (state.phase === 'starting') state.phase = 'recording';
      return true;
    }
    case 'record:pick':
      state.pickArmed = event['armed'] === true;
      return true;
    case 'record:drafting':
      state.drafting = event['busy'] === true;
      return true;
    case 'record:draft': {
      const revision = Number(event['revision']);
      if (!Number.isFinite(revision)) return false;
      if (state.draft !== null && revision <= state.draft.revision) return false;
      const through = event['through'];
      state.draft = {
        revision,
        steps: (Array.isArray(event['steps']) ? event['steps'] : []).map(cleanStepText).filter((s) => s !== ''),
        parameters: (Array.isArray(event['parameters']) ? event['parameters'] : [])
          .map((p) => {
            const o = (p ?? {}) as { name?: unknown; value?: unknown };
            return { name: String(o.name ?? '').trim(), value: String(o.value ?? '') };
          })
          .filter((p) => p.name !== ''),
        notes: (Array.isArray(event['notes']) ? event['notes'] : []).map(String).filter((n) => n.trim() !== ''),
        ...(typeof through === 'string' && through !== '' && { through }),
      };
      return true;
    }
    case 'record:writing':
      state.phase = 'finishing';
      state.pickArmed = false;
      return true;
    default:
      return false;
  }
}
