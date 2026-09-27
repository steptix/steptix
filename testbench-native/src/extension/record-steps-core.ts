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
 * While recording, every draft is written the same way (`beginLiveRecord`,
 * `liveRecordWrite`): the first write fixes the place and keeps the document
 * as it stood then; each later draft is that same plan against that same text,
 * written into the regions the recording owns (`RecordSlot`), which are
 * carried through the author's own edits (`trackRecordSlots`) and, where
 * offsets cannot follow an edit, found again by what they hold
 * (`locateLiveRecord`) — the recording never overwrites text it cannot prove
 * it wrote. The empty draft puts back what the file had.
 *
 * What counts as a step is runner-core's `classifyLines`, with the fence
 * correction renumber-core makes: a numbered line inside a ``` fence is text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  classifyLines,
  parseConfig,
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
/** A depth-1 or depth-2 ATX heading — the ones that open and close the
 *  server parser's `## Parameters` section (src/parser/markdown.ts). */
const TOP_HEADING_RE = /^ {0,3}(#{1,2})(?:[ \t]+(.*?))?[ \t]*$/;
/** A list item: a bullet with any of the three markers Markdown allows, or
 *  an ordered item — the parser reads every list under the heading. */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const PARAMETER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A GFM delimiter row — src/parser/data-rows.ts `DELIMITER_RE`, verbatim:
 *  `| --- | :-: |` and its unpiped forms (`--- | ---`, `---`). */
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** Any ATX heading — src/parser/line-grammar.ts `ANY_HEADING_RE`: one never
 *  opens a table, and it ends one. */
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;

interface LineModel {
  lines: string[];
  classified: ClassifiedLine[];
  fenced: boolean[];
  /**
   * Per line, the 0-based index of the header row of the data table it is
   * part of (header, delimiter or row), or -1 — see `tableTopsOf`.
   */
  tableTop: number[];
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
  return { lines, classified, fenced, tableTop: tableTopsOf(lines, fenced, classified), stepsIdx };
}

/**
 * A `|` not escaped with a backslash — src/parser/data-rows.ts
 * `hasUnescapedPipe`, verbatim: `a \| b` holds none.
 */
function hasUnescapedPipe(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === '|') return true;
  }
  return false;
}

/**
 * Where the data tables are, by the server parser's rule
 * (src/parser/data-rows.ts: `scanDataTable`, `looksLikeTable`, `parseTable`).
 * A table opens at a line holding an unescaped `|` whose very next line is a
 * non-blank delimiter row; the pipes at a row's ends are optional, so
 * `user | pass` / `--- | ---` / `a | b` is a table exactly as `| user |` /
 * `| --- |` / `| a |` is. Its rows then run on while each line is non-blank,
 * not a heading, and holds an unescaped `|`. Like the parser's scan, a blank
 * line, a heading or an HTML comment (from its `<!--` line to the one holding
 * `-->`) never opens one.
 *
 * Fenced lines and frontmatter are never table lines here. The parser's scan
 * does not know fences, but under a flow's heading a table in one comes after
 * the fence line — prose — which it refuses, and only the table a flow opens
 * with is ever a place to record from.
 *
 * Returns, per line, the header row's 0-based index, or -1.
 */
function tableTopsOf(lines: string[], fenced: boolean[], classified: ClassifiedLine[]): number[] {
  const tops = new Array<number>(lines.length).fill(-1);
  const inert = (i: number): boolean =>
    fenced[i] === true || isFenceDelimiter(lines[i] ?? '') || classified[i]?.kind === 'frontmatter';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (inert(i) || raw.trim() === '' || ANY_HEADING_RE.test(raw)) continue;
    if (raw.trimStart().startsWith('<!--')) {
      while (i < lines.length - 1 && !(lines[i] ?? '').includes('-->')) i++;
      continue;
    }
    const next = lines[i + 1];
    if (
      !hasUnescapedPipe(raw) ||
      next === undefined ||
      inert(i + 1) ||
      next.trim() === '' ||
      !TABLE_DELIMITER_RE.test(next)
    ) {
      continue;
    }
    tops[i] = i;
    tops[i + 1] = i;
    let k = i + 2;
    for (; k < lines.length; k++) {
      const row = lines[k] ?? '';
      if (inert(k) || row.trim() === '' || ANY_HEADING_RE.test(row) || !hasUnescapedPipe(row)) break;
      tops[k] = i;
    }
    i = k - 1;
  }
  return tops;
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
 * step is its own block — and neither is a fence. A line with pipes and no
 * delimiter row under it is not a table (`tableTopsOf`), so it is folded.
 */
function isContinuation(m: LineModel, idx: number): boolean {
  const raw = m.lines[idx] ?? '';
  return (
    !m.fenced[idx] &&
    m.classified[idx]?.kind === 'prose' &&
    raw.trim() !== '' &&
    !isTableRow(m, idx) &&
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

/** A line of a data table — header, delimiter or row — by the parser's rule
 *  (`tableTopsOf`): leading pipes optional, escaped pipes not counted. */
function isTableRow(m: LineModel, idx: number): boolean {
  return (m.tableTop[idx] ?? -1) >= 0;
}

/**
 * The first line at or below `idx` that is neither blank nor part of an HTML
 * comment — what the parser lets sit between a flow's heading and its table
 * (src/parser/data-rows.ts). A comment runs from its `<!--` line to the line
 * holding `-->`.
 */
function skipGapDown(m: LineModel, idx: number): number {
  let i = idx;
  while (i < m.lines.length && !m.fenced[i]) {
    const raw = (m.lines[i] ?? '').trim();
    if (raw === '') {
      i++;
    } else if (raw.startsWith('<!--')) {
      let j = i;
      while (j < m.lines.length && !(m.lines[j] ?? '').includes('-->')) j++;
      i = j + 1;
    } else {
      break;
    }
  }
  return i;
}

/** `skipGapDown` upwards: the first line at or above `idx` that is neither
 *  blank nor part of an HTML comment, or -1. */
function skipGapUp(m: LineModel, idx: number): number {
  let i = idx;
  while (i >= 0 && !m.fenced[i]) {
    const raw = (m.lines[i] ?? '').trim();
    if (raw === '') {
      i--;
    } else if (raw.endsWith('-->')) {
      let j = i;
      while (j >= 0 && !(m.lines[j] ?? '').includes('<!--')) j--;
      if (j < 0) break;
      i = j - 1;
    } else {
      break;
    }
  }
  return i;
}

/**
 * The data table a flow opens with — directly under its heading, blank lines
 * and comments aside, which is the one place the parser accepts it — as its
 * first and last row (0-based), or null. `headingIdx` is `## Steps` or the
 * `### Section`.
 */
function tableUnder(m: LineModel, headingIdx: number): { first: number; last: number } | null {
  if (headingIdx < 0) return null;
  let i = skipGapDown(m, headingIdx + 1);
  // The first line past the gap must OPEN a table — its header row.
  if (i >= m.lines.length || m.tableTop[i] !== i) return null;
  const first = i;
  while (i + 1 < m.lines.length && m.tableTop[i + 1] === first) i++;
  return { first, last: i };
}

/** The heading a flow hangs off: `## Steps` for the main flow, or its section's. */
function flowHeadingIdx(m: LineModel, section: string | null): number {
  return section === null ? m.stepsIdx : sectionHeadingIdx(m, section);
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
  /**
   * `line` has been carried through every edit made to the document while
   * recording (`trackAnchorThroughChanges`), so it IS the anchor line now,
   * whatever its text has become (a renumber rewrites it). False once an edit
   * deleted or merged the line itself, and absent on an anchor nobody
   * tracked: then the line is found again by its text.
   */
  tracked?: boolean;
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
  // The blank line after a flow's data table: the table sits directly under
  // the flow's heading, so this opens that flow (its steps follow the table).
  // A table anywhere else — under a step, after prose — is not a place.
  if (isTableRow(m, j)) {
    const h = skipGapUp(m, m.tableTop[j]! - 1);
    if (h >= 0 && h === m.stepsIdx) {
      return { ok: true, anchor: { line: h + 1, text: m.lines[h] ?? '', kind: 'heading', section: null } };
    }
    if (h >= 0 && kindAt(m, h) === 'section-heading') {
      const name = sectionNameOf(m.lines[h] ?? '');
      if (name === '') return { ok: false, reason: CURSOR_REFUSALS.unnamedSection };
      return { ok: true, anchor: { line: h + 1, text: m.lines[h] ?? '', kind: 'heading', section: name } };
    }
    return { ok: false, reason: CURSOR_REFUSALS.notAStep };
  }
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
  /**
   * The same edits by what each one is, for the live writer
   * (`liveRecordWrite`): the text of the block inserted after the anchor, the
   * text inserted for `## Parameters` ('' when nothing is added), and the new
   * ordinal of each later step of the flow that is renumbered (0-based line
   * in the planned text).
   *
   * `lines` is the block's numbered step lines one by one, and `blankBefore`,
   * `blankAfter`, `eol` and `lineEnd` how `block` is made of them — so a
   * block the author's own lines split into parts can be laid out part by
   * part (`liveRecordWrite`).
   */
  parts: {
    block: string;
    params: string;
    renumber: Array<{ line: number; text: string }>;
    lines: string[];
    blankBefore: boolean;
    blankAfter: boolean;
    eol: string;
    lineEnd: boolean;
  };
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
 * The anchor is found as `locateAnchor` says: a tracked anchor where the
 * edits made while recording carried it, else by its text. When neither finds
 * it the steps go at the end of the flow the anchor was in, and `fellBack`
 * says so — not literally the end of the `## Steps` span, which would put
 * main-flow steps inside the last section's body.
 *
 * A flow that has no steps yet but opens with a data table gets its steps
 * AFTER the table: the parser refuses a table that comes after a step.
 */
export function planRecordInsertion(
  text: string,
  args: { anchor: RecordAnchor | null; steps: unknown[]; parameters: unknown[] },
): RecordInsertionPlan | { error: string } {
  const steps = cleanSteps(args.steps);
  if (steps.length === 0) return { error: 'The recording came back with no steps.' };
  const placed = placeRecording(text, args.anchor);
  if ('error' in placed) return placed;
  const { m, eol, section, fellBack, insertAt, blankBefore, blankAfter, ones, prev } = placed;
  const warnings = [...placed.warnings];

  const newLines = steps.map((s, k) => `${ones ? 1 : prev + 1 + k}. ${s}`);
  const block = [...(blankBefore ? [''] : []), ...newLines, ...(blankAfter ? [''] : [])];

  const edits: RecordEdit[] = [];
  const at = blockPoint(placed);
  const blockText = blockTextAt(at, block, eol);
  edits.push(point(at.line, at.char, blockText));

  // The rest of the flow, renumbered by the Renumber Steps walk over the
  // document as it will read: the inserted steps are non-targets, so the walk
  // continues from their numbers exactly as it continues from any step written
  // above a selection.
  const simLines = [...m.lines.slice(0, insertAt), ...block, ...m.lines.slice(insertAt)];
  const sim = modelOf(simLines.join('\n'));
  const targets: number[] = [];
  for (let i = insertAt + block.length; i < sim.lines.length && !ones; i++) {
    const kind = kindAt(sim, i);
    if (kind === 'section-heading') break;
    if (kind === (section === null ? 'step' : 'section-step')) targets.push(i + 1);
  }
  const renumber: Array<{ line: number; text: string }> = [];
  if (targets.length > 0) {
    for (const edit of computeRenumberEdits(sim.lines.join('\n'), targets)) {
      const orig = edit.line - 1 - block.length;
      edits.push({ startLine: orig, startChar: 0, endLine: orig, endChar: edit.digits, text: String(edit.ordinal) });
      renumber.push({ line: orig, text: String(edit.ordinal) });
    }
  }

  // ── Parameters ─────────────────────────────────────────────────────────
  const params = planParameters(m, args.parameters, eol);
  warnings.push(...params.warnings);
  let shift = 0;
  if (params.edit) {
    edits.push(params.edit);
    if (params.edit.startLine < insertAt) shift = params.lineCount;
  }

  const firstStep = insertAt + 1 + (blankBefore ? 1 : 0) + shift;
  return {
    edits,
    parts: {
      block: blockText,
      params: params.edit?.text ?? '',
      renumber,
      lines: newLines,
      blankBefore,
      blankAfter,
      eol,
      lineEnd: at.lineEnd,
    },
    insertedLines: newLines.map((_, k) => firstStep + k),
    section,
    fellBack,
    parametersAdded: params.added,
    parameterConflicts: params.conflicts,
    warnings,
  };
}

/** Step texts as they will be written, blanks dropped. */
function cleanSteps(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).map(cleanStepText).filter((s) => s !== '');
}

/**
 * Where a recording's steps go in `text`, and how they are numbered — all of
 * it independent of what the steps say, so the live writer can fix it once
 * and write every draft of the recording into the same place.
 */
interface Placement {
  m: LineModel;
  eol: string;
  /** The flow the steps join. */
  section: string | null;
  /** The anchor was not found again: the steps go at the end of its flow. */
  fellBack: boolean;
  /** The fallback, said. */
  warnings: string[];
  /** 0-based line the block goes in front of (`m.lines.length`: after the
   *  last line, which has no line break of its own). */
  insertAt: number;
  /** A blank line goes in ahead of the steps (after a table with none). */
  blankBefore: boolean;
  /** A blank line goes in after them (a flow opened straight above a heading). */
  blankAfter: boolean;
  /** The flow is written `1.` throughout: the new steps are `1.` too, and
   *  nothing is renumbered. */
  ones: boolean;
  /** The number the new steps continue from. */
  prev: number;
}

function placeRecording(text: string, anchor: RecordAnchor | null): Placement | { error: string } {
  const m = modelOf(text);
  if (m.stepsIdx < 0) return { error: 'the file has no ## Steps heading any more' };
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const warnings: string[] = [];

  // ── Where ──────────────────────────────────────────────────────────────
  let fellBack = false;
  let section: string | null = anchor?.section ?? null;
  let anchorIdx: number;
  let anchorKind: 'step' | 'heading';
  const located = anchor === null ? null : locateAnchor(m, anchor);
  if (located !== null) {
    anchorIdx = located.idx;
    anchorKind = anchor!.kind;
    section = located.section;
  } else {
    if (anchor !== null) {
      fellBack = true;
      if (section !== null && sectionHeadingIdx(m, section) < 0) section = null;
    }
    const end = endOfFlow(m, section);
    anchorIdx = end.idx;
    anchorKind = end.kind;
  }
  if (fellBack) {
    warnings.push(
      'The line you started recording from was deleted or changed while you were recording, so the steps went ' +
        'at the end of ' +
        (section === null ? 'the main flow.' : `the "${section}" section.`),
    );
  }

  let insertAt: number;
  /** A blank line goes in ahead of the steps (after a table with none). */
  let blankBefore = false;
  if (anchorKind === 'step') {
    insertAt = anchorIdx + 1;
    while (insertAt < m.lines.length && isContinuation(m, insertAt)) insertAt++;
  } else {
    // Ahead of the flow's first step, so the new steps take its place in the
    // list and share its spacing. A flow with no steps yet: after its data
    // table when it has one — the parser requires the table to come first,
    // "before the numbered steps it feeds" — else directly under the heading.
    const first = flowSteps(m, section)[0];
    const table = first === undefined ? tableUnder(m, flowHeadingIdx(m, section)) : null;
    if (first !== undefined) {
      insertAt = first;
    } else if (table) {
      // After the blank line that ends the table. The last entry of `lines`
      // is not a line when the file ends in a newline — it is what follows
      // it — so a table that ends the file gets a blank line of its own.
      insertAt = table.last + 1;
      const blankFollows =
        insertAt < m.lines.length - 1 && (m.lines[insertAt] ?? '').trim() === '' && !m.fenced[insertAt];
      if (blankFollows) insertAt++;
      else blankBefore = true;
    } else {
      insertAt = anchorIdx + 1;
    }
  }
  // A flow opened straight above a heading gets a blank line before it. After
  // a step the author's own spacing stands.
  const blankAfter =
    anchorKind === 'heading' &&
    insertAt < m.lines.length &&
    /^#/.test(m.lines[insertAt] ?? '') &&
    !m.fenced[insertAt];

  // ── Numbers ────────────────────────────────────────────────────────────
  // The flow's own style: a flow written `1.` throughout (two steps or more,
  // every one `1.`) stays that way, and nothing after the new steps is
  // renumbered. Otherwise the new steps continue from the anchor's number.
  const ones = allOnes(m, section);
  const prev = anchorKind === 'step' ? writtenOrdinal(m, anchorIdx, section) : 0;
  return { m, eol, section, fellBack, warnings, insertAt, blankBefore, blankAfter, ones, prev };
}

/**
 * The point the block is inserted at: the start of line `insertAt`, or — when
 * the steps go after the last line, which has no line break of its own — the
 * end of that line, the block then written break-first (`lineEnd`).
 */
function blockPoint(p: Placement): { line: number; char: number; lineEnd: boolean } {
  if (p.insertAt < p.m.lines.length) return { line: p.insertAt, char: 0, lineEnd: false };
  const last = p.m.lines.length - 1;
  return { line: last, char: (p.m.lines[last] ?? '').length, lineEnd: true };
}

function blockTextAt(at: { lineEnd: boolean }, block: string[], eol: string): string {
  return at.lineEnd ? block.map((l) => eol + l).join('') : block.map((l) => l + eol).join('');
}

/**
 * The later steps of the flow a recording renumbers (0-based lines in the
 * placement's text), each with its ordinal as written: every step of that flow
 * after the insertion point, up to the next section heading. None in a flow
 * written `1.` throughout, which is never renumbered.
 */
function tailOf(p: Placement): Array<{ line: number; digits: string }> {
  const out: Array<{ line: number; digits: string }> = [];
  if (p.ones) return out;
  const wanted = p.section === null ? 'step' : 'section-step';
  for (let i = p.insertAt; i < p.m.lines.length; i++) {
    const kind = kindAt(p.m, i);
    if (kind === 'section-heading') break;
    if (kind !== wanted) continue;
    const digits = LEADING_ORDINAL_RE.exec(p.m.lines[i] ?? '')?.[1];
    if (digits !== undefined) out.push({ line: i, digits });
  }
  return out;
}

function point(line: number, char: number, text: string): RecordEdit {
  return { startLine: line, startChar: char, endLine: line, endChar: char, text };
}

/**
 * Find the anchor in the document as it is now, and the flow it is in.
 *
 * A TRACKED anchor's line is taken as it stands — its text may have changed
 * (a renumber rewrites `2.` to `3.`), and its section may have been renamed —
 * as long as it is still the same kind of line. Text is the fallback, for an
 * anchor nobody tracked or one whose line an edit deleted: where it was, else
 * the one line in the same flow with that exact text.
 */
function locateAnchor(m: LineModel, anchor: RecordAnchor): { idx: number; section: string | null } | null {
  if (anchor.tracked === true) {
    const idx = anchor.line - 1;
    const kind = kindAt(m, idx);
    if (anchor.kind === 'step' && isStepKind(kind)) {
      return { idx, section: kind === 'section-step' ? sectionOf(m, idx) : null };
    }
    if (anchor.kind === 'heading' && idx === m.stepsIdx) return { idx, section: null };
    if (anchor.kind === 'heading' && kind === 'section-heading') {
      const name = sectionNameOf(m.lines[idx] ?? '');
      if (name !== '') return { idx, section: name };
    }
  }
  if (anchor.kind === 'heading') {
    if (anchor.section === null) return { idx: m.stepsIdx, section: null };
    const idx = sectionHeadingIdx(m, anchor.section);
    return idx < 0 ? null : { idx, section: anchor.section };
  }
  const wanted = anchor.section === null ? 'step' : 'section-step';
  const matches = (idx: number): boolean =>
    m.lines[idx] === anchor.text &&
    kindAt(m, idx) === wanted &&
    (anchor.section === null || sectionOf(m, idx) === anchor.section);
  // Where it was only when nobody tracked it: a tracked anchor that got here
  // has lost its line, and an identical line now at that position is a
  // different step.
  if (anchor.tracked === undefined && matches(anchor.line - 1)) {
    return { idx: anchor.line - 1, section: anchor.section };
  }
  const found: number[] = [];
  for (let i = 0; i < m.lines.length; i++) if (matches(i)) found.push(i);
  return found.length === 1 ? { idx: found[0]!, section: anchor.section } : null;
}

/** The last step of a flow, or its heading when it has none. */
function endOfFlow(m: LineModel, section: string | null): { idx: number; kind: 'step' | 'heading' } {
  const steps = flowSteps(m, section);
  const last = steps[steps.length - 1];
  if (last !== undefined) return { idx: last, kind: 'step' };
  return { idx: flowHeadingIdx(m, section), kind: 'heading' };
}

/** A flow numbered `1.` on every step (two or more of them) — a style some
 *  authors use; a new step joins it as `1.` too. */
function allOnes(m: LineModel, section: string | null): boolean {
  const steps = flowSteps(m, section);
  return steps.length >= 2 && steps.every((i) => LEADING_ORDINAL_RE.exec(m.lines[i] ?? '')?.[1] === '1');
}

// ---------------------------------------------------------------------------
// Following the anchor through edits made while recording
// ---------------------------------------------------------------------------

/**
 * One text change, as VS Code reports it (`TextDocumentContentChangeEvent`):
 * the replaced range, 0-based, in the document as it was before the change,
 * and the text put in its place.
 */
export interface DocumentChange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
}

/**
 * Carry the anchor through one batch of edits (one `onDidChangeTextDocument`
 * event). Lines added or removed above it move it; edits inside it — a
 * renumber, a typo fixed — leave it where it is; an edit that deletes the
 * line, or merges its start into the line above, loses it (`tracked: false`),
 * and the insertion falls back to finding it by its text.
 *
 * Changes are applied bottom-up, so each one's range is still in the
 * coordinates it was reported in whichever convention the batch used.
 * `anchor.line` is 1-based, the changes 0-based, as VS Code reports them.
 */
export function trackAnchorThroughChanges(anchor: RecordAnchor, changes: DocumentChange[]): RecordAnchor {
  if (anchor.tracked === false) return anchor;
  let line = anchor.line - 1;
  const ordered = [...changes].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar);
  for (const c of ordered) {
    const added = (c.text.match(/\n/g) ?? []).length;
    const delta = added - (c.endLine - c.startLine);
    if (c.startLine > line) continue;
    if (c.endLine < line) {
      line += delta;
      continue;
    }
    if (c.startLine < line) {
      // The change reaches the anchor line from above and stops at its very
      // start. The line survives, still starting a line, only when nothing is
      // glued in front of it: whole lines deleted (from column 0, nothing put
      // in), or a replacement that ends in a line break.
      const keepsStart = c.text === '' ? c.startChar === 0 : c.text.endsWith('\n');
      if (c.endLine === line && c.endChar === 0 && keepsStart) {
        line += delta;
        continue;
      }
      return { ...anchor, tracked: false };
    }
    // The change starts on the anchor line.
    if (c.startChar > 0) continue; // after the line's start: the line stays
    if (c.endLine > line) return { ...anchor, tracked: false }; // the line deleted
    // Within the line from column 0: the rest of the line follows whatever
    // was put in — lines typed in front of it push it down, and a renumber
    // (no break) edits it in place.
    line += added;
  }
  return { ...anchor, line: line + 1, tracked: true };
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
 * The `## Parameters` section as the SERVER's parser reads it
 * (src/parser/markdown.ts): a depth-2 heading named Parameters, outside
 * frontmatter and fenced blocks, running to the next depth-1 or depth-2
 * heading (a `###` inside it does not end it); its items are list items —
 * `-`, `*`, `+` or numbered — of the form `key: value`, split at the first
 * colon, both halves trimmed. The parser reads EVERY such section, the last of
 * a duplicated key winning, so `items` holds them all; the heading and end
 * are the first section's, where new lines go. Null when there is none.
 */
function scanParameters(m: LineModel): {
  headingIdx: number;
  end: number;
  items: Array<{ key: string; value: string; line: number }>;
} | null {
  const headingAt = (i: number): RegExpExecArray | null =>
    m.fenced[i] || isFenceDelimiter(m.lines[i] ?? '') || m.classified[i]?.kind === 'frontmatter'
      ? null
      : TOP_HEADING_RE.exec(m.lines[i] ?? '');
  const isParameters = (h: RegExpExecArray | null): boolean =>
    h !== null && h[1]!.length === 2 && (h[2] ?? '').replace(/[ \t]+#+$/, '').trim().toLowerCase() === 'parameters';

  let first: { headingIdx: number; end: number } | null = null;
  const items: Array<{ key: string; value: string; line: number }> = [];
  for (let i = 0; i < m.lines.length; i++) {
    if (!isParameters(headingAt(i))) continue;
    const headingIdx = i;
    let end = m.lines.length;
    for (let k = headingIdx + 1; k < m.lines.length; k++) {
      if (headingAt(k)) {
        end = k;
        break;
      }
    }
    first ??= { headingIdx, end };
    for (let k = headingIdx + 1; k < end; k++) {
      if (m.fenced[k] || isFenceDelimiter(m.lines[k] ?? '')) continue;
      const item = LIST_ITEM_RE.exec(m.lines[k] ?? '');
      if (!item) continue;
      const text = item[1]!;
      const colon = text.indexOf(':');
      if (colon < 0) continue;
      const key = text.slice(0, colon).trim();
      if (key !== '') items.push({ key, value: text.slice(colon + 1).trim(), line: k });
    }
    i = end - 1;
  }
  return first === null ? null : { ...first, items };
}

/**
 * The `## Parameters` half of the edit (decision 8): each recorded parameter
 * the file does not have is added; one it has with the same value is left;
 * one it has with a DIFFERENT value is left too, and reported, because the
 * author's line is theirs and the recorded steps now read its value.
 *
 * Values are written as they came. Only what a parameter line cannot carry is
 * touched: surrounding whitespace, which the parser trims when it reads the
 * line (so it is trimmed here, and compared trimmed), and a line break, which
 * would end the line — such a parameter is left out, with a warning naming it.
 */
function planParameters(
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
  const section = scanParameters(m);
  // Last one wins, as the parser reads a duplicated key.
  const existing = new Map<string, string>();
  for (const item of section?.items ?? []) existing.set(item.key, item.value);

  const added: string[] = [];
  const conflicts: ParameterConflict[] = [];
  const warnings: string[] = [];
  const toAdd: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(recorded) ? recorded : []) {
    const p = (raw ?? {}) as { name?: unknown; value?: unknown };
    const name = String(p.name ?? '').trim();
    const rawValue = String(p.value ?? '');
    if (!PARAMETER_NAME_RE.test(name)) {
      warnings.push(`Left out a parameter named "${name}": a parameter name is letters, digits and _.`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    if (/[\r\n]/.test(rawValue.trim())) {
      warnings.push(
        `Left out parameter "${name}": its value has a line break, which a parameter line cannot hold. ` +
          `Add it under ## Parameters yourself before running.`,
      );
      continue;
    }
    const value = rawValue.trim();
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

  const at = parametersPoint(m, section);
  if (at.create) {
    // No section: create one immediately above `## Steps`. Always depth 2 —
    // the parser reads no other.
    const block = ['## Parameters', ...toAdd, ''];
    return {
      edit: point(at.line, at.char, (at.blankBefore ? eol : '') + block.map((l) => l + eol).join('')),
      lineCount: block.length + (at.blankBefore ? 1 : 0),
      added,
      conflicts,
      warnings,
    };
  }
  if (at.lineEnd) {
    return {
      edit: point(at.line, at.char, toAdd.map((l) => eol + l).join('')),
      lineCount: toAdd.length,
      added,
      conflicts,
      warnings,
    };
  }
  // A heading straight after the new bullets gets its blank line back.
  const lines = at.headingNext ? [...toAdd, ''] : toAdd;
  return {
    edit: point(at.line, at.char, lines.map((l) => l + eol).join('')),
    lineCount: lines.length,
    added,
    conflicts,
    warnings,
  };
}

/**
 * Where new parameter lines go — which does not depend on what they are, so
 * the live writer fixes it once: after the first `## Parameters` section's
 * last item (after its last non-blank line outside a fence when it has none,
 * the heading itself when it is empty); or, with no section, a new one
 * created immediately above `## Steps`. `lineEnd`: the point is the end of the
 * file's last line, which has no line break, so lines are written break-first.
 */
function parametersPoint(
  m: LineModel,
  section: ReturnType<typeof scanParameters> = scanParameters(m),
): { line: number; char: number; lineEnd: boolean; create: boolean; blankBefore: boolean; headingNext: boolean } {
  if (section === null) {
    const blankBefore = m.stepsIdx > 0 && (m.lines[m.stepsIdx - 1] ?? '').trim() !== '';
    return { line: m.stepsIdx, char: 0, lineEnd: false, create: true, blankBefore, headingNext: false };
  }
  let after = section.headingIdx;
  const own = section.items.filter((item) => item.line < section.end);
  if (own.length > 0) {
    after = Math.max(...own.map((item) => item.line));
  } else {
    for (let i = section.end - 1; i > section.headingIdx; i--) {
      if ((m.lines[i] ?? '').trim() !== '' && !m.fenced[i] && !isFenceDelimiter(m.lines[i] ?? '')) {
        after = i;
        break;
      }
    }
  }
  const at = after + 1;
  if (at >= m.lines.length) {
    const last = m.lines.length - 1;
    return { line: last, char: (m.lines[last] ?? '').length, lineEnd: true, create: false, blankBefore: false, headingNext: false };
  }
  return { line: at, char: 0, lineEnd: false, create: false, blankBefore: false, headingNext: /^#/.test(m.lines[at] ?? '') };
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
// The file while recording: every draft written in place of the last
// ---------------------------------------------------------------------------
//
// The rule every function below serves (SPEC-record-steps.md §7): the
// recording never overwrites text it cannot prove it wrote. What it wrote is
// kept as TEXT — the block's lines, the parameter lines, each later step's
// number and the rest of its line — and every write first checks that text is
// still where the offsets say (`locateLiveRecord`). Offsets are only the fast
// path. When a change came that they cannot follow exactly (an undo or redo, a
// revert or reload, a line-ending change, anything reaching across the edge of
// what was written), the text is looked for instead; found exactly once, the
// recording carries on from there; with nothing of it left, it starts again at
// the anchor; otherwise it stops writing into the file (`lost`).

/**
 * A region of the document a recording owns while it runs, as offsets into the
 * document as it is NOW (0-based UTF-16 code units — VS Code's `rangeOffset`).
 *
 *  - `block`: the recorded steps after the anchor, with the blank lines a
 *    table or a following heading needs. Empty until a draft has steps.
 *  - `params`: the parameter lines the recording added, or the whole
 *    `## Parameters` section it created. Empty while it adds none.
 *  - `tail`: the number of one later step of the same flow, which the block
 *    renumbers — `start` is its line's start, `end` the end of its digits.
 *    `original` is what the file had, and what the empty draft writes back.
 *  - `mine`: a line the AUTHOR wrote into the recorded lines while recording
 *    (stories/testbench-record-toolbar.md §"Steps typed in the editor") —
 *    below the last recorded line (End, Enter) or between two of them. It is
 *    the author's text: never written, never taken out, followed so the
 *    recording writes around it. The block is then several `block` slots,
 *    one between each two of the author's lines ("the run": block, mine,
 *    block, …, block — each part of it possibly empty).
 */
export interface RecordSlot {
  kind: 'params' | 'block' | 'tail' | 'mine';
  start: number;
  end: number;
  /** The slot hangs off the END of a line — its text starts with a line
   *  break — because it follows the file's last line, which has none. */
  lineEnd: boolean;
  /** What the recording last wrote here: the block's or the parameters' text
   *  ('' before any), or a later step's digits (its original ones until the
   *  first renumber). */
  wrote: string;
  /** `tail`: the step's 0-based line in `LiveRecord.base`. */
  line?: number;
  /** `tail`: its number as the file had it. */
  original?: string;
  /** `tail`: the rest of its line after the digits, as it last read. With
   *  `wrote`, the whole line the step is looked for by when `placed` is false. */
  rest?: string;
  /** `tail`: its number is where `start` says. False once anything touched
   *  the line's start or its number (typing in front of it, indenting it,
   *  editing the number, deleting the line) — the line is then the author's
   *  unless it is found again, exactly, by its text. */
  placed?: boolean;
  /** `block`/`params`: an edit wholly inside since the last write — the slot
   *  no longer reads `wrote`, and the next draft writes over it (warned). */
  touched?: boolean;
  /** `mine`: names the line across writes (`m1`, `m2`…). For `mine`, `wrote`
   *  is the line as it reads now — the author's text, followed as they type. */
  key?: string;
  /**
   * `mine`: `typing` until the author leaves the line with text on it — it is
   * not a step yet, and the recording writes around it; `sent` once it went
   * to the server as an `add-step`; `kept` when the server did not take it
   * (it stays in the file as the author's text, and is never sent again).
   */
  status?: 'typing' | 'sent' | 'kept';
  /** `mine`, `sent`: the id the server gave the step (`record:step`). */
  stepId?: string;
  /** `mine`, `sent`: the step as it was sent — what the server's step for it
   *  reads, whatever the author does to the line afterwards. */
  sentText?: string;
  /** `mine`: its step was one of the draft last written (`authoredIds`). */
  inDraft?: boolean;
  /**
   * `mine`: the line's leading number as the recording numbered it — the
   * author's line takes the recording's numbering once the draft holds its
   * step (stories/testbench-record-toolbar.md §"Locking in": "a leading number
   * or list marker you typed is removed and replaced by the recording's
   * numbering"). `digits`: only the number of an `N.` line is replaced;
   * `marker`: a list marker, `N)` or nothing is replaced by `N. `. `author` is
   * what was there before, given back when the draft no longer holds the step
   * and at the empty draft; `wrote` what the recording put there. `'author'`:
   * the author changed it since — the number is theirs again, for good, as a
   * later step's is (§7).
   */
  number?: { mode: 'digits' | 'marker'; author: string; wrote: string } | 'author';
}

/**
 * One state of the file a recording wrote: the document as it stood when the
 * recording first wrote to it (`base`), the anchor as found there, the flow,
 * and the slots with what was written in them.
 */
export interface LiveState {
  base: string;
  anchor: RecordAnchor | null;
  /** The flow the steps join — where later steps are looked for by text. */
  section: string | null;
  slots: RecordSlot[];
}

/**
 * What a recording keeps so that each draft replaces the last one in the file
 * rather than being inserted again: its state now, and the state after every
 * earlier write (`history`) — an undo can bring any of those back, including
 * one from before the recording started again at its anchor (a revert, then
 * Ctrl+Z).
 *
 * What a draft writes is a pure function of `base`, `anchor` and the draft —
 * the same `planRecordInsertion` a one-shot insertion uses — so the file after
 * drafts d1…dn reads as dn alone would have made it, and the EMPTY draft puts
 * back exactly what the file had: no block, no added parameter lines, every
 * later step's number as it was written. What the author changed elsewhere
 * meanwhile is outside the slots, and stays.
 */
export interface LiveRecord extends LiveState {
  /** A change since the last write that the offsets could not follow
   *  exactly: before anything is written, the recording's text is looked for
   *  (`locateLiveRecord`). */
  uncertain: boolean;
  /** Earlier states that held written steps, oldest first. */
  history: LiveState[];
}

/** The state part of a record, for its history. */
function stateOf(record: LiveState): LiveState {
  return { base: record.base, anchor: record.anchor, section: record.section, slots: record.slots };
}

/** The state holds steps the recording wrote. */
const holdsSteps = (state: LiveState): boolean => state.slots.some((s) => s.kind === 'block' && s.wrote !== '');

/** A replacement in offsets of the document as it is — `start === end` inserts. */
export interface OffsetEdit {
  start: number;
  end: number;
  text: string;
  /** The slot it writes, when a live write made it. */
  kind?: RecordSlot['kind'];
}

/** How many earlier writes an undo is looked for among. */
const HISTORY_LIMIT = 50;

/** SPEC-record-steps.md §7: why a recording stopped writing into its file. */
export const RECORDING_NOT_FOUND = 'the recorded steps could not be found in the file any more';

/**
 * Fix where a recording writes into `text`: the block's point after the
 * anchor, the parameters' point, and the number of every later step of that
 * flow. Nothing is written yet — every slot but the tails is empty. Fails as
 * `planRecordInsertion` does when there is no `## Steps` to write under, and —
 * `strict`, when the recording starts again after its text vanished — when the
 * anchor itself cannot be found.
 */
export function beginLiveRecord(
  text: string,
  anchor: RecordAnchor | null,
  opts: { strict?: boolean } = {},
): LiveRecord | { error: string } {
  const placed = placeRecording(text, anchor);
  if ('error' in placed) return placed;
  if (opts.strict && placed.fellBack) return { error: 'the line the steps go after could not be found' };
  const starts = lineStarts(text);
  const at = (line: number, char: number): number => (starts[line] ?? text.length) + char;
  const params = parametersPoint(placed.m);
  const block = blockPoint(placed);
  const slots: RecordSlot[] = [
    { kind: 'params', start: at(params.line, params.char), end: at(params.line, params.char), lineEnd: params.lineEnd, wrote: '' },
    { kind: 'block', start: at(block.line, block.char), end: at(block.line, block.char), lineEnd: block.lineEnd, wrote: '' },
    ...tailOf(placed).map(
      (t): RecordSlot => ({
        kind: 'tail',
        start: at(t.line, 0),
        end: at(t.line, t.digits.length),
        lineEnd: false,
        wrote: t.digits,
        line: t.line,
        original: t.digits,
        rest: (placed.m.lines[t.line] ?? '').slice(t.digits.length),
        placed: true,
      }),
    ),
  ];
  return {
    base: text,
    anchor: anchor === null ? null : { ...anchor },
    section: placed.section,
    slots: sortSlots(slots),
    uncertain: false,
    history: [],
  };
}

export interface LiveRecordWrite {
  /** What to change, in offsets of the document as it is now. Slots that
   *  already hold what the draft wants are not touched. */
  edits: OffsetEdit[];
  /** The slots once `edits` are applied. */
  slots: RecordSlot[];
  /** The record once `edits` are applied — keep it for the next write. */
  record: LiveRecord;
  /** The document once `edits` are applied. */
  text: string;
  /** The draft's plan against `base` — its section, the parameters it adds
   *  and its warnings — or null for the empty draft. */
  plan: RecordInsertionPlan | null;
  /** Before writing, the recording's text was not where the offsets said:
   *  `found` again by its text, or — nothing of it left — written `fresh` at
   *  the anchor. */
  relocated: 'no' | 'found' | 'fresh';
}

/**
 * The edits that make `current` — the document as it is now, holding whatever
 * the recording wrote last — read as `draft`: each slot replaced by what the
 * draft puts there. A draft with no steps is the empty draft: it takes out
 * everything the recording wrote (parameters too — they only exist for the
 * steps) and writes each later step's number back as the file had it.
 *
 * First, what the recording wrote is found (`locateLiveRecord`). When it
 * cannot be — gone in part, or there twice — nothing is written: `lost`, and
 * the caller stops writing into the file. When NONE of it is left (an undo
 * took the drafts out, a revert or reload put the file back) a draft is
 * written afresh at the anchor — `opts.anchor`, the anchor as the caller has
 * followed it, else the record's own found by its text — as the first write
 * was; the empty draft then has nothing to take out.
 *
 * The author's own lines inside the recorded block (`mine` slots —
 * stories/testbench-record-toolbar.md §"Steps typed in the editor") are never
 * written: the draft is laid out AROUND them (`layoutRun`). One whose step the
 * draft holds (`authored`/`authoredIds` name it) IS that step — the draft's
 * text for it is not written again beside it; one the draft does not hold
 * yet divides the draft by how many of its steps are above it in the file.
 * Every block part is changed only where it differs (`slotEdits`), so steps
 * the draft left as they were — the locked ones — are not rewritten, bar a
 * number the author's line pushed on. The empty draft takes every block part
 * out and leaves the author's lines where they are.
 */
export function liveRecordWrite(
  live: LiveRecord,
  current: string,
  draft: LiveDraft,
  opts: { anchor?: RecordAnchor | null } = {},
): LiveRecordWrite | { error: string; lost?: boolean } {
  const { steps, authoredAt } = draftSteps(draft);
  const where = locateLiveRecord(live, current, opts.anchor);
  if (where.status === 'lost') return { error: where.reason, lost: true };
  let record: LiveRecord;
  /** The history the record carries on: every earlier state that held steps. */
  let prior: LiveState[];
  let relocated: LiveRecordWrite['relocated'] = where.status === 'found' && where.moved ? 'found' : 'no';
  if (where.status === 'absent') {
    if (steps.length === 0) {
      return { edits: [], slots: live.slots, record: live, text: current, plan: null, relocated: 'no' };
    }
    const anchor = opts.anchor !== undefined ? opts.anchor : live.anchor && { ...live.anchor, tracked: false };
    const begun = beginLiveRecord(current, anchor, { strict: true });
    if ('error' in begun) return { error: `${RECORDING_NOT_FOUND} (${begun.error})`, lost: true };
    record = begun;
    prior = holdsSteps(live) ? [...live.history, stateOf(live)] : live.history;
    relocated = 'fresh';
  } else {
    record = where.record;
    prior = holdsSteps(record) ? [...record.history, stateOf(record)] : record.history;
  }
  record = adoptStepIds(record, steps, authoredAt, draft.foreignIds ?? []);

  let plan: RecordInsertionPlan | null = null;
  let want: (slot: RecordSlot) => string = (slot) => (slot.kind === 'tail' ? (slot.original ?? '') : '');
  /** `mine` slots the draft holds the step of, each with its number. */
  let joined = new Map<RecordSlot, string>();
  if (steps.length > 0) {
    const planned = planRecordInsertion(record.base, { anchor: record.anchor, steps, parameters: draft.parameters });
    if ('error' in planned) return planned;
    plan = planned;
    const layout = layoutRun(record.slots, planned.parts, authoredAt);
    // The draft places the author's lines in an order the file does not have
    // them in: nothing written can be proved right.
    if (layout === null) return { error: RECORDING_NOT_FOUND, lost: true };
    joined = layout.joined;
    const renumbered = new Map(planned.parts.renumber.map((r) => [r.line, r.text]));
    want = (slot) =>
      slot.kind === 'block'
        ? (layout.blocks.get(slot) ?? '')
        : slot.kind === 'params'
          ? planned.parts.params
          : (renumbered.get(slot.line ?? -1) ?? slot.original ?? '');
  }

  const edits: OffsetEdit[] = [];
  const written: RecordSlot[] = [];
  const shifts: Array<{ at: number; delta: number }> = [];
  let delta = 0;
  let floor = 0;
  for (const slot of record.slots) {
    // A later step whose line is not where it was and could not be found by
    // its text is the author's now: not written, not renumbered.
    if (slot.kind === 'tail' && slot.placed === false) continue;
    // A line of the author's: never written — bar its leading number, which
    // follows the recording's numbering while the draft holds its step — it
    // moves with the writes above it, and says whether the draft holds it.
    if (slot.kind === 'mine') {
      floor = Math.max(floor, slot.end);
      const renumbered = numberAuthorLine(slot, joined.get(slot) ?? null);
      if (renumbered.edit) {
        edits.push(renumbered.edit);
        shifts.push({ at: slot.end, delta: renumbered.wrote.length - slot.wrote.length });
      }
      const start = slot.start + delta;
      const next: RecordSlot = { ...slot, start, end: start + renumbered.wrote.length, wrote: renumbered.wrote, inDraft: joined.has(slot) };
      if (renumbered.number === undefined) delete next.number;
      else next.number = renumbered.number;
      written.push(next);
      delta += renumbered.wrote.length - slot.wrote.length;
      continue;
    }
    // Overlapping slots cannot come out of the tracker or the search; one that
    // did would be written twice, so it is left alone.
    if (slot.start < floor) continue;
    floor = slot.end;
    const text = want(slot);
    const now = current.slice(slot.start, slot.end);
    if (now !== text) {
      edits.push(...slotEdits(slot, now, text));
      shifts.push({ at: slot.end, delta: text.length - (slot.end - slot.start) });
    }
    const start = slot.start + delta;
    written.push({ ...slot, start, end: start + text.length, wrote: text, touched: false });
    delta += text.length - (slot.end - slot.start);
  }
  // Steps the author has taken over keep their place as a hint, moved past
  // the writes above them.
  for (const slot of record.slots) {
    if (slot.kind !== 'tail' || slot.placed !== false) continue;
    const moved = shifts.filter((s) => s.at <= slot.start).reduce((sum, s) => sum + s.delta, 0);
    written.push({ ...slot, start: slot.start + moved, end: slot.end + moved });
  }
  const slots = sortSlots(written);
  const history = prior.slice(-HISTORY_LIMIT);
  return {
    edits,
    slots,
    record: { ...record, slots, uncertain: false, history },
    text: applyOffsetEdits(current, edits),
    plan,
    relocated,
  };
}

/**
 * A draft as the live writer takes it: `record:draft`'s steps and parameters,
 * and — since the browser toolbar — which of its steps the author wrote. The
 * empty draft is `{ steps: [], parameters: [] }`.
 */
export interface LiveDraft {
  steps: unknown[];
  parameters: unknown[];
  /** Indices into `steps` of the author's own steps (`record:draft.authored`). */
  authored?: unknown;
  /** Their ids, parallel to `authored` (`record:draft.authoredIds`). */
  authoredIds?: unknown;
  /** Ids `record:step` said came from the toolbar or the panel: never taken
   *  for a line the author typed in the file. */
  foreignIds?: string[];
}

/** The draft's steps as they will be written (blanks dropped), and where each
 *  of the author's steps is among them, by its id. */
function draftSteps(draft: LiveDraft): { steps: string[]; authoredAt: Map<string, number> } {
  const raw = Array.isArray(draft.steps) ? draft.steps : [];
  const steps: string[] = [];
  const cleanIndex = new Map<number, number>();
  raw.forEach((r, i) => {
    const s = cleanStepText(r);
    if (s === '') return;
    cleanIndex.set(i, steps.length);
    steps.push(s);
  });
  const authored = Array.isArray(draft.authored) ? draft.authored : [];
  const ids = Array.isArray(draft.authoredIds) ? draft.authoredIds : [];
  const authoredAt = new Map<string, number>();
  authored.forEach((idx, k) => {
    const id = ids[k];
    const at = cleanIndex.get(Number(idx));
    if (typeof id === 'string' && id !== '' && at !== undefined) authoredAt.set(id, at);
  });
  return { steps, authoredAt };
}

/**
 * Name each line of the author's that was sent and has no id yet by the
 * draft step that is it: an id of the draft's author steps not known to be
 * the toolbar's or the panel's, whose text is that line's as it was sent. A
 * draft can arrive before the `record:step` that names the id, and a line
 * taken for none of the draft's steps would be written a second time as the
 * recording's.
 */
function adoptStepIds(record: LiveRecord, steps: string[], authoredAt: Map<string, number>, foreign: string[]): LiveRecord {
  const named = new Set(record.slots.flatMap((s) => (s.kind === 'mine' && s.stepId ? [s.stepId] : [])));
  let slots = record.slots;
  for (const [id, idx] of authoredAt) {
    if (named.has(id) || foreign.includes(id)) continue;
    const text = steps[idx];
    const k = slots.findIndex((s) => s.kind === 'mine' && s.status === 'sent' && !s.stepId && s.sentText === text);
    if (k < 0) continue;
    slots = slots.map((s, i) => (i === k ? { ...s, stepId: id } : s));
    named.add(id);
  }
  return slots === record.slots ? record : { ...record, slots };
}

/**
 * The draft laid out around the author's lines: the text of every block part
 * of the run (block, mine, block, …, block), and which of the author's lines
 * the draft holds. Null when the draft holds the author's lines in an order
 * the file does not (the writer then writes nothing).
 *
 * A line whose step the draft holds (its id among `authoredAt`) is that step:
 * the steps before it go above it, the ones after below, and it is not
 * written. A line the draft does not hold divides the draft by count: as many
 * steps above it as the file has above it now (the draft the author saw) —
 * or, at the end of the run with none of the recording's lines below it, all
 * of them, as a line typed below the block always had.
 */
function layoutRun(
  slots: RecordSlot[],
  parts: RecordInsertionPlan['parts'],
  authoredAt: Map<string, number>,
): { blocks: Map<RecordSlot, string>; joined: Map<RecordSlot, string> } | null {
  const run = slots.filter(isRun);
  const n = parts.lines.length;
  const mines = run.flatMap((s, i) => (s.kind === 'mine' ? [i] : []));
  // block, mine, block, …, block — what `settleRun` leaves.
  if (run.length !== 2 * mines.length + 1 || run.some((s, i) => (i % 2 === 0) !== (s.kind === 'block'))) return null;
  const at = (s: RecordSlot): number | undefined => (s.stepId ? authoredAt.get(s.stepId) : undefined);
  const cuts: Array<{ cut: number; consumes: boolean }> = [];
  /** The author's lines the draft holds, each with the number its step takes. */
  const joined = new Map<RecordSlot, string>();
  let floor = 0;
  for (let j = 0; j < mines.length; j++) {
    const i = mines[j]!;
    const mine = run[i]!;
    const idx = at(mine);
    if (idx !== undefined) {
      if (idx < floor) return null;
      cuts.push({ cut: idx, consumes: true });
      joined.set(mine, LEADING_ORDINAL_RE.exec(parts.lines[idx] ?? '')?.[1] ?? String(idx + 1));
      floor = idx + 1;
      continue;
    }
    let cut: number;
    if (atRunEnd(run, i)) {
      cut = n;
    } else {
      let upper = n;
      for (let k = j + 1; k < mines.length; k++) {
        const below = at(run[mines[k]!]!);
        if (below !== undefined) {
          upper = below;
          break;
        }
      }
      cut = Math.min(Math.max(stepsAbove(run, i), floor), Math.max(upper, floor));
    }
    cuts.push({ cut, consumes: false });
    floor = cut;
  }
  const blocks = new Map<RecordSlot, string>();
  let from = 0;
  for (let j = 0; j <= mines.length; j++) {
    const block = run[2 * j]!;
    const to = j < mines.length ? cuts[j]!.cut : n;
    const lines = [
      ...(j === 0 && parts.blankBefore ? [''] : []),
      ...parts.lines.slice(from, Math.max(from, to)),
      ...(j === mines.length && parts.blankAfter ? [''] : []),
    ];
    blocks.set(block, linesText(lines, block.lineEnd, parts.eol));
    if (j < mines.length) from = cuts[j]!.cut + (cuts[j]!.consumes ? 1 : 0);
  }
  return { blocks, joined };
}

/**
 * A line of the author's, numbered as the recording numbers its steps while
 * the draft holds its step (`want`: that step's number), or given back the
 * number it had when the draft no longer does (`want` null — the empty draft
 * too). Only the leading number is ever touched: the digits of an `N.` line,
 * else the list marker (or nothing) in front of the text, replaced by `N. `.
 * A number the author changed after the recording set it is theirs from then
 * on (`'author'`), and a number the recording never changed is not given
 * anything back.
 */
function numberAuthorLine(
  slot: RecordSlot,
  want: string | null,
): { wrote: string; number?: RecordSlot['number']; edit?: OffsetEdit } {
  const lead = slot.lineEnd ? (slot.wrote.startsWith('\r\n') ? 2 : slot.wrote.startsWith('\n') ? 1 : 0) : 0;
  const state = slot.number;
  if (state === 'author') return { wrote: slot.wrote, number: 'author' };
  const cur = authorLinePrefix(slot.wrote.slice(lead));
  // The number sits after the line's indentation, which is the author's.
  const from = lead + (cur?.indent ?? 0);
  const line = slot.wrote.slice(from);
  const intact =
    state === undefined ||
    (state.mode === 'digits' ? cur?.mode === 'digits' && cur.text === state.wrote : line.startsWith(state.wrote));
  if (!intact) return { wrote: slot.wrote, number: 'author' };
  const at = slot.start + from;
  const replace = (was: string, to: string): { wrote: string; edit: OffsetEdit } => ({
    wrote: slot.wrote.slice(0, from) + to + line.slice(was.length),
    edit: { start: at, end: at + was.length, text: to, kind: 'mine' },
  });
  if (want === null) {
    if (state === undefined) return { wrote: slot.wrote };
    return replace(state.wrote, state.author);
  }
  // An indented line with no number of its own is left as it is.
  if (!state && !cur) return { wrote: slot.wrote };
  const mode = state ? state.mode : cur!.mode;
  const now = state ? state.wrote : cur!.text;
  const target = mode === 'digits' ? want : `${want}. `;
  if (now === target) return { wrote: slot.wrote, ...(state && { number: state }) };
  return { ...replace(now, target), number: { mode, author: state ? state.author : cur!.text, wrote: target } };
}

/**
 * The leading number of a line the author typed: the digits of `N.` (after
 * any indentation), or — unindented — the list marker (`-`, `*`, `+`, `N)`)
 * with the space after it, or ''. Null for an indented line with no number.
 */
function authorLinePrefix(line: string): { mode: 'digits' | 'marker'; text: string; indent: number } | null {
  const digits = /^([ \t]*)(\d{1,9})(?=\.(?:[ \t]|\r?\n|$))/.exec(line);
  if (digits) return { mode: 'digits', text: digits[2]!, indent: digits[1]!.length };
  if (/^[ \t]/.test(line)) return null;
  const marker = /^(?:\d{1,9}\)|[-*+])[ \t]+/.exec(line);
  return { mode: 'marker', text: marker ? marker[0] : '', indent: 0 };
}

/** Lines as a slot's text: each ended by `eol`, or — a slot hanging off the
 *  end of a line (`lineEnd`) — each begun by it. */
function linesText(lines: string[], lineEnd: boolean, eol: string): string {
  return lineEnd ? lines.map((l) => eol + l).join('') : lines.map((l) => l + eol).join('');
}

/** A part of the run: the recorded block's, or a line of the author's. */
const isRun = (s: RecordSlot): boolean => s.kind === 'block' || s.kind === 'mine';

/** The steps a block part holds: its non-blank lines (the blank ones are the
 *  spacing a table or a following heading needs). */
const stepCount = (text: string): number => text.split(/\r?\n/).filter((l) => l.trim() !== '').length;

/**
 * How many of the draft last written are above the run's part `i`: the steps
 * of the block parts above, and the author's lines above whose step that
 * draft held.
 */
function stepsAbove(run: RecordSlot[], i: number): number {
  let n = 0;
  for (let k = 0; k < i; k++) {
    const s = run[k]!;
    n += s.kind === 'block' ? stepCount(s.wrote) : s.inDraft ? 1 : 0;
  }
  return n;
}

/**
 * The run's part `i` is at its end: none of the recording's steps below it,
 * and none of the author's lines below it that went to the server. A line
 * typed there is "below the block": every step goes above it until the
 * server places it.
 */
function atRunEnd(run: RecordSlot[], i: number): boolean {
  for (let k = i + 1; k < run.length; k++) {
    const s = run[k]!;
    if (s.kind === 'block' ? stepCount(s.wrote) > 0 : s.status === 'sent') return false;
  }
  return true;
}

/**
 * The edits that turn a slot reading `now` into `next`. A block part changes
 * only where it differs, line by line — the lines both share at its start and
 * end are not touched, and a line whose only change is its leading number
 * has only the number replaced — so steps the draft kept as they were (the
 * locked ones) are never rewritten. Parameters and later numbers are
 * replaced whole, as they always were.
 */
function slotEdits(slot: RecordSlot, now: string, next: string): OffsetEdit[] {
  if (slot.kind !== 'block' || now === '' || next === '') {
    return [{ start: slot.start, end: slot.end, text: next, kind: slot.kind }];
  }
  const a = unitsOf(now, slot.lineEnd);
  const b = unitsOf(next, slot.lineEnd);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const midA = a.slice(p, a.length - q);
  const midB = b.slice(p, b.length - q);
  let at = slot.start + a.slice(0, p).join('').length;
  if (midA.length !== midB.length) {
    const len = midA.join('').length;
    return [{ start: at, end: at + len, text: midB.join(''), kind: 'block' }];
  }
  const out: OffsetEdit[] = [];
  for (let k = 0; k < midA.length; k++) {
    const x = midA[k]!;
    const y = midB[k]!;
    if (x !== y) {
      const lead = slot.lineEnd ? (x.startsWith('\r\n') ? 2 : x.startsWith('\n') ? 1 : 0) : 0;
      const dx = /^\d+(?=\.)/.exec(x.slice(lead))?.[0];
      const dy = /^\d+(?=\.)/.exec(y.slice(lead))?.[0];
      const sameLead = x.slice(0, lead) === y.slice(0, lead);
      if (dx !== undefined && dy !== undefined && sameLead && x.slice(lead + dx.length) === y.slice(lead + dy.length)) {
        out.push({ start: at + lead, end: at + lead + dx.length, text: dy, kind: 'block' });
      } else {
        out.push({ start: at, end: at + x.length, text: y, kind: 'block' });
      }
    }
    at += x.length;
  }
  return out;
}

/**
 * A slot's text as its lines, each with its line break: ended by it, or — a
 * slot hanging off the end of a line (`lineEnd`) — begun by it. Joined, the
 * units are the text again.
 */
function unitsOf(text: string, lineEnd: boolean): string[] {
  const out: string[] = [];
  if (!lineEnd) {
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        out.push(text.slice(from, i + 1));
        from = i + 1;
      }
    }
    if (from < text.length) out.push(text.slice(from));
    return out;
  }
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i > 0 && text[i - 1] === '\r' ? i - 1 : i);
  }
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((s, k) => text.slice(s, starts[k + 1] ?? text.length)).filter((u) => u !== '');
}

/** A unit's line, without its line break. */
function unitLine(unit: string): string {
  return unit.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/** The author's line a `mine` slot holds, without its line break. */
function mineLineText(slot: RecordSlot): string {
  return unitLine(slot.wrote);
}

/**
 * A line the author typed, as the step it becomes: whitespace collapsed, and
 * a leading number (`8.`, `8)`) or list marker (`-`, `*`, `+`) taken off —
 * the recording numbers its steps itself (stories/testbench-record-toolbar.md
 * §"Locking in"). '' when nothing is left: not a step.
 */
export function cleanAuthorLine(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\d{1,9}[.)]|[-*+])(?:\s+|$)/, '')
    .trim();
}

/**
 * Text the author gave as steps — the Add step box, the Add Step to Recording
 * command — as the steps it is: one per non-blank line, in order, each
 * cleaned as `cleanAuthorLine` cleans a line typed in the file.
 */
export function splitAuthorSteps(text: unknown): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(cleanAuthorLine)
    .filter((s) => s !== '');
}

/** `text` with offset edits applied, all in `text`'s offsets. At one start, a
 *  wider range goes first, and of two insertions the earlier listed ends up
 *  in front — as one editor edit applies them. */
export function applyOffsetEdits(text: string, edits: OffsetEdit[]): string {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => b.edit.start - a.edit.start || b.edit.end - a.edit.end || b.index - a.index);
  let out = text;
  for (const { edit } of ordered) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** One change as VS Code reports it: `rangeOffset`, `rangeLength`, `text`. */
export interface OffsetChange {
  offset: number;
  length: number;
  text: string;
}

/**
 * Carry the slots through one batch of edits someone else made (one
 * `onDidChangeTextDocument` event that was not the recording's own write),
 * where the offsets CAN follow them:
 *
 *  - an edit before a slot moves it; one after leaves it;
 *  - an edit wholly inside the block or the parameters — the lines being
 *    recorded — is taken into the slot, so the next draft rewrites it, and
 *    `touched` says so (the author is warned, once);
 *  - an edit that reaches ACROSS a slot's edge — part inside, part out — can
 *    not be followed by offsets: `uncertain`, and the next write finds the
 *    recording's text by the text itself;
 *  - a later step's number is the recording's only while its line starts with
 *    exactly that number: anything that touches the line's start or its
 *    number unplaces it (`placed: false`) — typing in front of it, indenting
 *    it, editing the number, deleting the line. It is written again only if
 *    its whole line is found again, exactly.
 *
 * At a slot's edge an insertion is outside when it cannot be part of it:
 * whole lines put in at its start go above it; typing at the start of the line
 * after it is that line's; and a line break typed at the end of its last line
 * (End, Enter) starts a line BELOW it, which is the author's. Typing at the
 * start of a recorded line, or at the end of the last one when the block ends
 * the file, is inside.
 */
export function trackRecordSlots(
  slots: RecordSlot[],
  changes: OffsetChange[],
): { slots: RecordSlot[]; touched: boolean; uncertain: boolean } {
  const out = slots.map((s) => ({ ...s }));
  let touched = false;
  let uncertain = false;
  // Bottom-up, so each change's offsets are still those it was reported in.
  const ordered = [...changes].sort((a, b) => b.offset - a.offset);
  for (const c of ordered) {
    const delta = c.text.length - c.length;
    // The run's last part with text in it: a line opened under it (End,
    // Enter) is the author's new line below the block — one of theirs from
    // here on (stories/testbench-record-toolbar.md §"Steps typed in the
    // editor"), which the recording writes around rather than below.
    const last = [...out].reverse().find((s) => isRun(s) && s.end > s.start);
    let opened: RecordSlot | null = null;
    for (const slot of out) {
      if (slot.kind === 'tail') {
        trackTail(slot, c, delta);
        continue;
      }
      const relation = regionRelation(slot, c);
      if (slot === last && relation === 'after' && opensLineBelow(slot, c)) opened = lineOpenedBelow(slot, c);
      switch (relation) {
        case 'before':
          slot.start += delta;
          slot.end += delta;
          break;
        case 'after':
          break;
        case 'inside':
          // The author's own line is theirs to edit: nothing to warn about.
          if (slot.kind !== 'mine') {
            touched = true;
            slot.touched = true;
          }
          slot.end += delta;
          break;
        case 'across':
          // Left where it was: the next write looks for it by its text.
          uncertain = true;
          break;
      }
    }
    if (opened && last) out.splice(out.indexOf(last) + 1, 0, opened);
  }
  return { slots: out, touched, uncertain };
}

/** `c` is End, Enter on the last line of `slot`: a line break typed at that
 *  line's end, starting a new line below it (`regionRelation`'s case). */
function opensLineBelow(slot: RecordSlot, c: OffsetChange): boolean {
  if (c.length !== 0) return false;
  if (slot.lineEnd) return c.offset === slot.end && startsWithBreak(c.text);
  const eol = slot.wrote.endsWith('\r\n') ? '\r\n' : '\n';
  return slot.wrote.endsWith(eol) && c.offset === slot.end - eol.length && c.text.startsWith(eol);
}

/** The author's new line `c` opened under `slot` (see `opensLineBelow`), as
 *  the change leaves it: right after the slot, typing. */
function lineOpenedBelow(slot: RecordSlot, c: OffsetChange): RecordSlot {
  const eol = c.text.startsWith('\r\n') ? '\r\n' : '\n';
  return {
    kind: 'mine',
    start: slot.end,
    end: slot.end + c.text.length,
    lineEnd: slot.lineEnd,
    wrote: slot.lineEnd ? c.text : c.text.slice(eol.length) + eol,
    key: nextMineKey(),
    status: 'typing',
  };
}

let mineKeys = 0;
/** A fresh name for a line of the author's. */
function nextMineKey(): string {
  mineKeys += 1;
  return `m${mineKeys}`;
}

function regionRelation(slot: RecordSlot, c: OffsetChange): 'before' | 'after' | 'inside' | 'across' {
  const { start: s, end: e } = slot;
  const cEnd = c.offset + c.length;
  if (cEnd < s) return 'before';
  if (c.offset > e) return 'after';
  if (c.length > 0) {
    if (cEnd === s) return 'before';
    if (c.offset === e) return 'after';
    // A line of the author's: anything wholly within it is theirs, the whole
    // line deleted or typed over included.
    if (slot.kind === 'mine' && c.offset >= s && cEnd <= e) return 'inside';
    // Inside only when some of the slot's text is left on one side of it:
    // the whole slot replaced is the author's text in its place.
    if (s < e && c.offset >= s && cEnd <= e && (c.offset > s || cEnd < e)) return 'inside';
    return 'across';
  }
  // An insertion at an edge, or inside.
  if (s === e) {
    // Nothing written there yet: the point stays below whole lines typed at
    // it, and above typing that joins the line it is in front of.
    return slot.lineEnd || endsWithBreak(c.text) ? 'before' : 'after';
  }
  if (c.offset === s) return slot.lineEnd || endsWithBreak(c.text) ? 'before' : 'inside';
  if (c.offset === e) {
    // The start of the line after the slot — unless the slot ends mid-line
    // (the block ends the file): then it is the end of the last recorded
    // line, where a line break starts a new line of the author's below it.
    if (!slot.lineEnd) return 'after';
    return startsWithBreak(c.text) ? 'after' : 'inside';
  }
  // End, Enter on the slot's last line: the break goes in just before the
  // slot's own final break, and the slot's text is unchanged up to its end —
  // the new line after it is the author's.
  const eol = slot.wrote.endsWith('\r\n') ? '\r\n' : '\n';
  if (!slot.lineEnd && slot.wrote.endsWith(eol) && c.offset === e - eol.length && c.text.startsWith(eol)) return 'after';
  return 'inside';
}

/** Follow one later step's number through a change (see `trackRecordSlots`). */
function trackTail(slot: RecordSlot, c: OffsetChange, delta: number): void {
  const cEnd = c.offset + c.length;
  // Wholly above the line — or a line deleted above it, ending at its start.
  if (cEnd < slot.start || (c.length > 0 && cEnd === slot.start)) {
    slot.start += delta;
    slot.end += delta;
    return;
  }
  if (slot.placed === false) return;
  if (c.length === 0 && c.offset === slot.start) {
    // Whole lines typed in front of it push it down; anything else joins the
    // front of its line.
    if (endsWithBreak(c.text)) {
      slot.start += delta;
      slot.end += delta;
    } else {
      slot.placed = false;
    }
    return;
  }
  // After the number's dot: the step's own text, or later lines.
  if (c.offset > slot.end) return;
  slot.placed = false;
}

const endsWithBreak = (text: string): boolean => text.endsWith('\n');
const startsWithBreak = (text: string): boolean => text.startsWith('\n') || text.startsWith('\r\n');

/** Where a recording's text is now — see `locateLiveRecord`. */
export type LiveRecordLocation =
  | { status: 'found'; record: LiveRecord; moved: boolean }
  | { status: 'absent' }
  | { status: 'lost'; reason: string };

/**
 * Find what the recording wrote in `current`.
 *
 * Fast path — nothing since the last write the offsets could not follow: each
 * region still reads what was written there (or was only edited inside, and
 * warned about), and each later step's line still starts with the number the
 * recording gave it. A later step that does not is looked for by its whole
 * line; not found exactly once, it is the author's (`placed: false`).
 *
 * Otherwise the text itself is looked for — the last write's, then each
 * earlier write's, each with the base it was planned against (undo walks back
 * through them): the block's lines as one run exactly once in the file,
 * starting at a line and below the anchor; the parameter lines it added
 * exactly once; nothing of any write's lines left outside those; each later
 * step's line exactly once in the flow below the block. Found: `found`, with
 * the slots where it is. Not found, and not one line the recording wrote is
 * left in the file (more often than the base had it): `absent`. Anything
 * else — part of it left, all of it there twice, or lines edited inside since
 * the last write that are not back as written — is `lost`.
 *
 * `anchor` is the anchor as the caller followed it through the document's
 * edits; without it, the record's own is found by its text.
 */
export function locateLiveRecord(live: LiveRecord, current: string, anchor?: RecordAnchor | null): LiveRecordLocation {
  const record = withEol(live, current);
  let m: LineModel | null = null;
  const model = (): LineModel => (m ??= modelOf(current));
  if (!record.uncertain) {
    // The author's lines inside the block, as the offsets followed them.
    const settled = settleRun(record, current);
    const inPlace = settled && verifyInPlace(settled, current, model);
    if (inPlace) return { status: 'found', record: inPlace, moved: false };
  }
  const found = anchor !== undefined ? anchor : record.anchor && { ...record.anchor, tracked: false };
  const anchorIdx = found === null ? model().stepsIdx : (locateAnchor(model(), found)?.idx ?? -1);
  const paramsPoint = (base: string) => (): { at: number; lineEnd: boolean } | null => {
    const p = parametersPoint(model());
    // No `## Steps` to create a section above any more.
    if (p.line < 0) return null;
    // A section created since, or removed: the planned lines were written for
    // the other case.
    if (p.create !== parametersPoint(modelOf(base)).create) return null;
    return { at: (lineStarts(current)[p.line] ?? current.length) + p.char, lineEnd: p.lineEnd };
  };
  // Newest first: the last write, then each earlier one an undo may have
  // brought back — each with the base it was planned against. Lines the
  // author edited inside since the last write hold text that is neither
  // theirs nor the recording's: only that write, exactly as written (an undo
  // of the edit), is taken; an earlier one could match part of it.
  const touched = record.slots.some((s) => s.touched);
  const states = touched ? [stateOf(record)] : [stateOf(record), ...[...record.history].reverse()];
  for (const state of states) {
    const slots = findWritten(current, model, state.slots, state.section, anchorIdx, paramsPoint(state.base));
    if (slots && nothingLeft(record, current, slots)) {
      // What became of the author's lines since (sent, their ids) is not
      // undone with the text: a line sent once is never sent again.
      const found: LiveRecord = { ...state, slots, uncertain: false, history: record.history };
      return { status: 'found', record: carryAuthorState(record, found), moved: true };
    }
  }
  // Nothing of the recording's left — unless a line of the author's is: a
  // draft written afresh would put its step in a second time, beside it.
  if (!touched && nothingLeft(record, current) && !authorLinesLeft(record, current)) return { status: 'absent' };
  return { status: 'lost', reason: RECORDING_NOT_FOUND };
}

/**
 * `to` with each of the author's lines carrying what `from` knows about the
 * same line (by its key): whether it was sent, and the id the server gave it.
 * A write planned before the author left a line, or an undo that brought an
 * earlier state back, must not forget that the line went to the server.
 */
export function carryAuthorState(from: LiveRecord, to: LiveRecord): LiveRecord {
  const known = new Map(from.slots.flatMap((s) => (s.kind === 'mine' && s.key ? [[s.key, s] as const] : [])));
  if (known.size === 0) return to;
  let changed = false;
  const slots = to.slots.map((s) => {
    const k = s.kind === 'mine' && s.key ? known.get(s.key) : undefined;
    if (!k || (k.status === s.status && k.stepId === s.stepId && k.sentText === s.sentText)) return s;
    changed = true;
    return {
      ...s,
      status: k.status,
      ...(k.stepId !== undefined && { stepId: k.stepId }),
      ...(k.sentText !== undefined && { sentText: k.sentText }),
    };
  });
  return changed ? { ...to, slots } : to;
}

/** A line of the author's — one any state of the record holds — is in the file
 *  more often than the base it was written into had it. */
function authorLinesLeft(record: LiveRecord, current: string): boolean {
  const count = (text: string, line: string): number => text.split(/\r?\n/).filter((l) => l === line).length;
  for (const state of [record, ...record.history]) {
    for (const slot of state.slots) {
      if (slot.kind !== 'mine') continue;
      const line = mineLineText(slot);
      if (line.trim() !== '' && count(current, line) > count(state.base, line)) return true;
    }
  }
  return false;
}

/**
 * Follow the record through one change event that was not the recording's own
 * write — what the extension's change listener does, kept here so it is
 * pinned without a host. `uncertain` marks an event the offsets must not be
 * trusted for at all (an undo or redo, a revert or a reload from disk: VS Code
 * reports those as line diffs that can reach across the recording's lines).
 * Whenever the record is uncertain its text is looked for at once, so the
 * highlight is right; what is not found now is looked for again at the next
 * write. `touched`: an edit wholly inside the recorded lines — the author is
 * warned about that, and about nothing else.
 */
export function followLiveRecord(
  live: LiveRecord,
  changes: OffsetChange[],
  opts: { text: () => string; uncertain?: boolean; anchor?: RecordAnchor | null },
): { record: LiveRecord; touched: boolean } {
  const tracked = opts.uncertain
    ? { slots: live.slots, touched: false, uncertain: true }
    : trackRecordSlots(live.slots, changes);
  let record: LiveRecord = { ...live, slots: tracked.slots, uncertain: live.uncertain || tracked.uncertain };
  let touched = tracked.touched && !tracked.uncertain;
  // Only an edit inside the block, or a run that holds lines of the author's
  // (or just opened one), has anything to settle: every other keystroke is
  // followed by offsets alone, without reading the document.
  if (!record.uncertain && (tracked.touched || record.slots.some((s) => s.kind === 'mine'))) {
    // Whole lines typed between the recorded ones are the author's new lines,
    // not an edit of the recording's: only what is still an edit inside a
    // recorded line is warned about.
    const settled = settleRun(record, opts.text());
    if (settled) {
      record = settled;
      touched = touched && settled.slots.some((s) => s.touched === true);
    } else {
      record = { ...record, uncertain: true };
      touched = false;
    }
  }
  if (record.uncertain) {
    const where = locateLiveRecord(record, opts.text(), opts.anchor);
    if (where.status === 'found') record = where.record;
  }
  return { record, touched };
}

/**
 * The run — the recorded block and the author's lines in it — made to read as
 * the offsets followed it, after the author's edits
 * (stories/testbench-record-toolbar.md §"Steps typed in the editor"):
 *
 *  - each line of the author's reads what the author has typed on it (a line
 *    Enter split into several is several lines; one deleted whole is gone,
 *    and the block parts on either side of it are one again);
 *  - a block part edited only by WHOLE lines put in between its lines — End,
 *    Enter on a recorded line and typing, or a paste — is split around them,
 *    and they are the author's new lines; above the first recorded line they
 *    are not (§7: lines above the block are outside it), and an edit of a
 *    recorded line itself stays one inside the block (`touched`, warned);
 *  - whole lines that appeared between two parts of the run are the author's
 *    new lines too;
 *  - and the run is block, mine, block, …, block again, an empty block part
 *    kept right after each line of the author's.
 *
 * Offsets only: null when they do not describe whole lines any more — the
 * caller then looks for the recording by its text.
 */
function settleRun(record: LiveRecord, text: string): LiveRecord | null {
  const sorted = sortSlots(record.slots);
  const run = sorted.filter(isRun);
  if (run.length === 0) return record;
  const others = sorted.filter((s) => !isRun(s));
  const firstBlock = run[0];
  const parts: RecordSlot[] = [];
  for (const slot of run) {
    if (slot.start < 0 || slot.end > text.length || slot.start > slot.end) return null;
    const now = text.slice(slot.start, slot.end);
    if (slot.kind === 'mine') {
      if (now === '') continue; // deleted: the author's to delete
      if (!wholeLines(text, slot.start, slot.end, slot.lineEnd)) return null;
      const units = unitsOf(now, slot.lineEnd);
      // The unit that still reads as the line did keeps its name; the rest are
      // new lines of the author's.
      let own = units.indexOf(slot.wrote);
      if (own < 0) own = Math.max(0, units.findIndex((u) => unitLine(u).trim() !== ''));
      let at = slot.start;
      units.forEach((unit, k) => {
        parts.push(
          k === own
            ? { ...slot, start: at, end: at + unit.length, wrote: unit }
            : typingLine(at, unit, slot.lineEnd),
        );
        at += unit.length;
      });
      continue;
    }
    if (!slot.touched || now === slot.wrote) {
      parts.push(now === slot.wrote ? { ...slot, touched: false } : slot);
      continue;
    }
    const split = insertedLines(slot.wrote, now, slot.lineEnd);
    // Above the first recorded line: outside the block, not a line of the
    // author's inside it — left as an edit inside, as it always was.
    const above = slot === firstBlock ? firstStepUnit(slot.wrote, slot.lineEnd) : -1;
    if (!split || split.some((p) => p.mine && p.before <= above)) {
      parts.push(slot);
      continue;
    }
    let at = slot.start;
    for (const p of split) {
      parts.push(
        p.mine
          ? typingLine(at, p.text, slot.lineEnd)
          : { ...slot, start: at, end: at + p.text.length, wrote: p.text, touched: false },
      );
      at += p.text.length;
    }
  }
  // Whole lines between two parts of the run: the author's new lines. Above
  // every recorded line — nothing but empty block parts before them — they
  // are outside the block: the empty parts move down past them.
  const withGaps: RecordSlot[] = [];
  for (const slot of parts) {
    const prev = withGaps[withGaps.length - 1];
    if (prev && prev.end > slot.start) return null;
    if (prev && prev.end < slot.start) {
      if (withGaps.every((s) => s.kind === 'block' && s.start === s.end)) {
        for (const s of withGaps) s.start = s.end = slot.start;
      } else {
        const lineEnd = prev.lineEnd && !atLineStart(text, prev.end);
        if (!wholeLines(text, prev.end, slot.start, lineEnd)) return null;
        let at = prev.end;
        for (const unit of unitsOf(text.slice(prev.end, slot.start), lineEnd)) {
          withGaps.push(typingLine(at, unit, lineEnd));
          at += unit.length;
        }
      }
    }
    withGaps.push({ ...slot });
  }
  // block, mine, block, …, block.
  const out: RecordSlot[] = [];
  for (const slot of withGaps) {
    const prev = out[out.length - 1];
    if (slot.kind === 'block') {
      if (prev?.kind === 'block') {
        // A line of the author's between them was deleted: one part again.
        if (prev.end !== slot.start || (prev.lineEnd !== slot.lineEnd && prev.end > prev.start && slot.end > slot.start)) {
          return null;
        }
        if (prev.end === prev.start) prev.lineEnd = slot.lineEnd;
        prev.end = slot.end;
        prev.wrote += slot.wrote;
        prev.touched = prev.touched === true || slot.touched === true;
        continue;
      }
      out.push(slot);
      continue;
    }
    if (!prev || prev.kind === 'mine') out.push(emptyBlock(slot.start, slot.lineEnd));
    out.push(slot);
  }
  if (out[out.length - 1]?.kind === 'mine') {
    const lastMine = out[out.length - 1]!;
    out.push(emptyBlock(lastMine.end, lastMine.lineEnd));
  }
  // An empty block part sits right after the author's line before it — or,
  // the first one, right in front of the line after it.
  for (let i = 0; i < out.length; i++) {
    const slot = out[i]!;
    if (slot.kind !== 'block' || slot.start !== slot.end) continue;
    const before = out[i - 1];
    const after = out[i + 1];
    if (before?.kind === 'mine') {
      slot.start = slot.end = before.end;
      slot.lineEnd = before.lineEnd;
    } else if (!before && after?.kind === 'mine') {
      slot.start = slot.end = after.start;
      slot.lineEnd = after.lineEnd;
    }
  }
  return { ...record, slots: sortSlots([...others, ...out]) };
}

/** One `add-step` for lines the author finished writing in the file. */
export interface AuthorStepCommit {
  /** The keys of the author's lines it carries, in order. */
  keys: string[];
  /** Their steps, one per line, as sent (`cleanAuthorLine`). */
  lines: string[];
  /**
   * The step of the draft last written that the first of them follows — its
   * 0-based index in that draft (the server puts them at `afterStep + 1`).
   * Absent when they are at the end of the run, below everything recorded:
   * the server puts them after all of it.
   */
  afterStep?: number;
}

/**
 * The author's lines that count as WRITTEN now (stories/testbench-record-toolbar.md
 * §"Steps typed in the editor"): lines not counted yet (`typing`) with a step
 * on them that no cursor is on — the author left the line, by moving the
 * cursor or pressing Enter. A blank line never counts, and a line a cursor is
 * on is still being typed: a half-finished sentence is not locked in.
 *
 * Each counted line becomes `sent`; lines next to each other that count at
 * once are ONE add-step, several lines in order. `cursors` are offsets into
 * `text`, the document as it is; a record whose offsets cannot be trusted
 * (`uncertain`) counts nothing.
 */
export function commitAuthorLines(
  live: LiveRecord,
  text: string,
  cursors: number[],
): { record: LiveRecord; commits: AuthorStepCommit[] } {
  if (live.uncertain) return { record: live, commits: [] };
  const run = live.slots.filter(isRun);
  const now = new Map<RecordSlot, string>();
  for (let i = 0; i < run.length; i++) {
    const s = run[i]!;
    if (s.kind !== 'mine' || s.status !== 'typing' || !s.key) continue;
    if (text.slice(s.start, s.end) !== s.wrote) continue; // not where it was followed to
    const step = cleanAuthorLine(mineLineText(s));
    if (step === '') continue;
    // Above every step the recording holds (they were all dropped since the
    // line was typed): not a place in the recording — lines above the block
    // are outside it.
    if (!atRunEnd(run, i) && stepsAbove(run, i) === 0) continue;
    const brk = s.lineEnd ? (s.wrote.startsWith('\r\n') ? 2 : 1) : s.wrote.endsWith('\r\n') ? 2 : s.wrote.endsWith('\n') ? 1 : 0;
    const from = s.lineEnd ? s.start + brk : s.start;
    const to = s.lineEnd ? s.end : s.end - brk;
    if (cursors.some((c) => c >= from && c <= to)) continue;
    now.set(s, step);
  }
  if (now.size === 0) return { record: live, commits: [] };
  const commits: AuthorStepCommit[] = [];
  let open: AuthorStepCommit | null = null;
  for (let i = 0; i < run.length; i++) {
    const s = run[i]!;
    if (s.kind === 'block') {
      if (s.end > s.start) open = null;
      continue;
    }
    const step = now.get(s);
    if (step === undefined) {
      open = null;
      continue;
    }
    if (open === null) {
      open = { keys: [], lines: [], ...(!atRunEnd(run, i) && { afterStep: stepsAbove(run, i) - 1 }) };
      commits.push(open);
    }
    open.keys.push(s.key!);
    open.lines.push(step);
  }
  const slots = live.slots.map((s) => {
    const step = now.get(s);
    return step === undefined ? s : { ...s, status: 'sent' as const, sentText: step };
  });
  return { record: { ...live, slots }, commits };
}

/**
 * `record:step` named a step from the editor: the line of the author's that
 * was sent as that text, and has no id yet, is that step.
 */
export function assignAuthorStepId(live: LiveRecord, id: string, text: unknown): LiveRecord {
  if (live.slots.some((s) => s.kind === 'mine' && s.stepId === id)) return live;
  const want = cleanStepText(text);
  const k = live.slots.findIndex((s) => s.kind === 'mine' && s.status === 'sent' && !s.stepId && s.sentText === want);
  if (k < 0) return live;
  return { ...live, slots: live.slots.map((s, i) => (i === k ? { ...s, stepId: id } : s)) };
}

/**
 * The server did not take these lines (the add-step failed, or did nothing):
 * they stay the author's text in the file — `kept`, never sent again — and
 * the recording keeps writing around them.
 */
export function keepAuthorLines(live: LiveRecord, keys: string[]): LiveRecord {
  const slots = live.slots.map((s) =>
    s.kind === 'mine' && s.key && keys.includes(s.key) && s.status === 'sent' && !s.stepId ? { ...s, status: 'kept' as const } : s,
  );
  return { ...live, slots };
}

/** The author's lines in the recorded block, in order — for the panel's tests
 *  and the log. */
export function authorLinesOf(
  live: LiveRecord,
): Array<{ key: string; line: string; status: 'typing' | 'sent' | 'kept'; stepId?: string; inDraft: boolean }> {
  return live.slots
    .filter((s) => s.kind === 'mine')
    .map((s) => ({
      key: s.key ?? '',
      line: mineLineText(s),
      status: s.status ?? 'typing',
      ...(s.stepId !== undefined && { stepId: s.stepId }),
      inDraft: s.inDraft === true,
    }));
}

/** `text[start, end)` is whole lines: each ended by its line break, or — a
 *  region hanging off the end of a line — each begun by one. */
function wholeLines(text: string, start: number, end: number, lineEnd: boolean): boolean {
  if (start === end) return true;
  const part = text.slice(start, end);
  return lineEnd ? atLineEnd(text, start) && startsWithBreak(part) && atLineEnd(text, end) : atLineStart(text, start) && part.endsWith('\n');
}

/** A new line of the author's at `at`, reading `unit`, not counted yet. */
function typingLine(at: number, unit: string, lineEnd: boolean): RecordSlot {
  return { kind: 'mine', start: at, end: at + unit.length, lineEnd, wrote: unit, key: nextMineKey(), status: 'typing' };
}

function emptyBlock(at: number, lineEnd: boolean): RecordSlot {
  return { kind: 'block', start: at, end: at, lineEnd, wrote: '' };
}

/** The index of the first unit of `text` holding a step (a non-blank line), or
 *  the number of units when there is none. */
function firstStepUnit(text: string, lineEnd: boolean): number {
  const units = unitsOf(text, lineEnd);
  const i = units.findIndex((u) => unitLine(u).trim() !== '');
  return i < 0 ? units.length : i;
}

/**
 * `now` as `was` with whole lines put in between its lines, and nothing else
 * changed — each piece in order, `mine` for an inserted line (`before`: how
 * many of `was`'s lines are above it), the recording's runs of lines
 * otherwise. Null when `now` is anything else.
 */
function insertedLines(
  was: string,
  now: string,
  lineEnd: boolean,
): Array<{ text: string; mine: boolean; before: number }> | null {
  const a = unitsOf(was, lineEnd);
  const b = unitsOf(now, lineEnd);
  if (b.length <= a.length || b.join('') !== now) return null;
  const out: Array<{ text: string; mine: boolean; before: number }> = [];
  let i = 0;
  for (const unit of b) {
    if (i < a.length && unit === a[i]) {
      const last = out[out.length - 1];
      if (last && !last.mine) last.text += unit;
      else out.push({ text: unit, mine: false, before: i });
      i++;
    } else {
      out.push({ text: unit, mine: true, before: i });
    }
  }
  return i === a.length ? out : null;
}

/**
 * The record with its text in the document's line endings: when something
 * converted the file's line breaks (LF to CRLF, or back) while recording, the
 * base and everything written are converted the same way, and the offsets are
 * not trusted until the text is found again.
 */
function withEol(record: LiveRecord, current: string): LiveRecord {
  if (!current.includes('\n') || !record.base.includes('\n')) return record;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  if ((record.base.includes('\r\n') ? '\r\n' : '\n') === eol) return record;
  const convert = (s: string): string => s.replace(/\r?\n/g, eol);
  const stateIn = <T extends LiveState>(state: T): T => ({
    ...state,
    base: convert(state.base),
    slots: state.slots.map((s) => (s.kind === 'tail' ? s : { ...s, wrote: convert(s.wrote) })),
  });
  return { ...stateIn(record), history: record.history.map(stateIn), uncertain: true };
}

/** The fast path of `locateLiveRecord`, or null when it does not hold. */
function verifyInPlace(record: LiveRecord, current: string, model: () => LineModel): LiveRecord | null {
  const regions: RecordSlot[] = [];
  let blockEnd = 0;
  for (const slot of record.slots) {
    if (slot.kind === 'tail') continue;
    if (!regionInPlace(current, slot)) return null;
    regions.push({ ...slot });
    // Later steps are looked for below the whole run, the author's lines in it
    // included.
    if (isRun(slot)) blockEnd = Math.max(blockEnd, slot.end);
  }
  const tails = placeTails(
    record.slots.filter((s) => s.kind === 'tail'),
    current,
    model,
    blockEnd,
    record.section,
  );
  return { ...record, slots: sortSlots([...regions, ...tails]) };
}

/** A block or parameters slot still where the offsets say: at a line
 *  boundary, reading what was written — or edited only inside since. */
function regionInPlace(current: string, slot: RecordSlot): boolean {
  if (slot.start < 0 || slot.end > current.length || slot.start > slot.end) return false;
  if (!slot.touched && current.slice(slot.start, slot.end) !== slot.wrote) return false;
  return slot.lineEnd ? atLineEnd(current, slot.start) : atLineStart(current, slot.start);
}

const atLineStart = (text: string, at: number): boolean => at === 0 || text[at - 1] === '\n';
const atLineEnd = (text: string, at: number): boolean => at === text.length || text[at] === '\n' || text[at] === '\r';

/**
 * Every later step placed: those whose line still starts with the number the
 * recording wrote, where the offsets say (the rest of the line read again —
 * it is the author's to edit); the others looked for by their whole line,
 * exactly once, in the flow below `after`. Not found: `placed: false`.
 */
function placeTails(
  tails: RecordSlot[],
  current: string,
  model: () => LineModel,
  after: number,
  section: string | null,
): RecordSlot[] {
  const out: RecordSlot[] = [];
  let starts: number[] | null = null;
  for (const tail of tails) {
    if (tail.placed !== false && tailInPlace(current, tail)) {
      out.push({ ...tail, placed: true, rest: restOfLine(current, tail.start + tail.wrote.length) });
      continue;
    }
    starts ??= lineStarts(current);
    const m = model();
    const target = tail.wrote + (tail.rest ?? '');
    const wanted = section === null ? 'step' : 'section-step';
    let from = lineAtOffset(starts, after);
    if ((starts[from] ?? 0) < after) from++;
    const hits: number[] = [];
    for (let i = from; i < m.lines.length; i++) {
      const kind = kindAt(m, i);
      if (kind === 'section-heading') break;
      if (kind === wanted && m.lines[i] === target) hits.push(i);
    }
    const hit = hits.length === 1 ? starts[hits[0]!] : undefined;
    out.push(
      hit === undefined
        ? { ...tail, placed: false }
        : { ...tail, start: hit, end: hit + tail.wrote.length, placed: true },
    );
  }
  return out;
}

function tailInPlace(current: string, tail: RecordSlot): boolean {
  return (
    tail.end - tail.start === tail.wrote.length &&
    atLineStart(current, tail.start) &&
    current.startsWith(tail.wrote, tail.start) &&
    current[tail.start + tail.wrote.length] === '.'
  );
}

function restOfLine(text: string, from: number): string {
  let end = text.indexOf('\n', from);
  if (end < 0) end = text.length;
  if (end > from && text[end - 1] === '\r') end--;
  return text.slice(from, end);
}

/**
 * The slots of one earlier write, found in `current` by what they hold, or
 * null. `anchorIdx`: the block must start below that line (-1: anywhere).
 * `paramsPoint`: where parameters would go now, for a write that added none.
 */
function findWritten(
  current: string,
  model: () => LineModel,
  snapshot: RecordSlot[],
  section: string | null,
  anchorIdx: number,
  paramsPoint: () => { at: number; lineEnd: boolean } | null,
): RecordSlot[] | null {
  // The run — the block, and the author's lines in it — as one text: it is
  // one run of whole lines in the file.
  const run = sortSlots(snapshot).filter(isRun);
  const params = snapshot.find((s) => s.kind === 'params');
  const block = run.find((s) => s.wrote !== '');
  if (!block || !run.some((s) => s.kind === 'block' && s.wrote !== '')) return null;
  const runText = run.map((s) => s.wrote).join('');
  const blockAt = uniqueAt(current, runText, block.lineEnd);
  if (blockAt === null) return null;
  const blockEnd = blockAt + runText.length;
  if (anchorIdx >= 0) {
    const lead = block.lineEnd ? (block.wrote.startsWith('\r\n') ? 2 : 1) : 0;
    const first = lineAtOffset(lineStarts(current), blockAt + lead);
    if (first <= anchorIdx) return null;
  }
  const regions: RecordSlot[] = [];
  let pos = blockAt;
  for (const part of run) {
    regions.push({ ...part, start: pos, end: pos + part.wrote.length, touched: false });
    pos += part.wrote.length;
  }
  if (params) {
    if (params.wrote !== '') {
      const at = uniqueAt(current, params.wrote, params.lineEnd);
      if (at === null) return null;
      const end = at + params.wrote.length;
      if (at < blockEnd && end > blockAt) return null;
      regions.push({ ...params, start: at, end, touched: false });
    } else {
      const point = paramsPoint();
      if (point === null || point.lineEnd !== params.lineEnd) return null;
      regions.push({ ...params, start: point.at, end: point.at, touched: false });
    }
  }
  const tails = placeTails(
    snapshot.filter((s) => s.kind === 'tail').map((t) => ({ ...t, placed: false })),
    current,
    model,
    blockEnd,
    section,
  );
  return sortSlots([...regions, ...tails]);
}

/**
 * The one place `needle` stands in `hay` as whole lines — starting at a line
 * start, or (`lineEnd`, text that starts with its line break) ending at a
 * line's end — or null when it stands nowhere, or in more than one place.
 */
function uniqueAt(hay: string, needle: string, lineEnd: boolean): number | null {
  let found: number | null = null;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const ok = lineEnd ? atLineEnd(hay, i + needle.length) : atLineStart(hay, i);
    if (!ok) continue;
    if (found !== null) return null;
    found = i;
  }
  return found;
}

/**
 * Not one line any write of this recording put in the file is there now more
 * often than the base had it — the block's and the parameters' lines, and each
 * later step's line as renumbered — leaving out the lines of `found`, the
 * write just found in the file. With nothing found, this is "none of it is
 * left"; with a write found, "none of it is left anywhere else": a match that
 * leaves another write's line outside it is only part of what is there (an
 * earlier, shorter draft matching the start of a later one), and not taken.
 */
function nothingLeft(record: LiveRecord, current: string, found: RecordSlot[] | null = null): boolean {
  const counts = (text: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) out.set(line, (out.get(line) ?? 0) + 1);
    return out;
  };
  const now = counts(current);
  for (const slot of found ?? []) {
    const lines =
      slot.kind === 'tail' ? (slot.placed ? [slot.wrote + (slot.rest ?? '')] : []) : slot.wrote.split(/\r?\n/);
    for (const line of lines) now.set(line, (now.get(line) ?? 0) - 1);
  }
  // Each state against the base it was written into.
  for (const state of [record, ...record.history]) {
    const base = counts(state.base);
    const ours = new Set<string>();
    for (const slot of state.slots) {
      if (slot.kind === 'tail') {
        if (slot.wrote !== slot.original) ours.add(slot.wrote + (slot.rest ?? ''));
        continue;
      }
      // The author's lines are theirs, not the recording's.
      if (slot.kind === 'mine') continue;
      for (const line of slot.wrote.split(/\r?\n/)) if (line.trim() !== '') ours.add(line);
    }
    for (const line of ours) if ((now.get(line) ?? 0) > (base.get(line) ?? 0)) return false;
  }
  return true;
}

/** In document order; at one offset the parameters come before the block, and
 *  the block before the step it is inserted ahead of — the order the text
 *  reads in (a stable sort of slots listed in that order). */
function sortSlots(slots: RecordSlot[]): RecordSlot[] {
  // The run's parts (block and mine) share a rank: at one offset — an empty
  // block part against the author's line after it — they keep the order they
  // are listed in, which is the run's (a stable sort).
  const rank = { params: 0, block: 1, mine: 1, tail: 2 } as const;
  return [...slots].sort((a, b) => a.start - b.start || rank[a.kind] - rank[b.kind]);
}

/**
 * The 0-based lines that hold recorded text — the block's steps and the
 * parameter lines — for the highlight and the selection. Blank lines the
 * block carries for spacing are left out.
 */
export function recordedLines(
  text: string,
  slots: RecordSlot[],
  kinds: Array<RecordSlot['kind']> = ['params', 'block'],
): number[] {
  const starts = lineStarts(text);
  const out = new Set<number>();
  for (const slot of slots) {
    if (!kinds.includes(slot.kind) || slot.end <= slot.start || slot.placed === false) continue;
    for (let line = lineAtOffset(starts, slot.start); line < starts.length && starts[line]! < slot.end; line++) {
      const lineEnd = line + 1 < starts.length ? starts[line + 1]! : text.length;
      const part = text.slice(Math.max(slot.start, starts[line]!), Math.min(slot.end, lineEnd));
      if (part.trim() !== '') out.add(line);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// A recording the window closed on (reload, extension host restart)
// ---------------------------------------------------------------------------

/**
 * What a recording has written into its file, kept in the workspace's state
 * after every write so that a recording cut off by a window reload — whose
 * dirty buffer hot exit restores, draft and all — can be taken back out at the
 * next activation. Text only: offsets mean nothing after a restart.
 */
export interface UnfinishedRecording {
  /** The recorded block as one run of lines — the author's own lines in it
   *  included, when `parts` says there are any. */
  block: string;
  blockLineEnd: boolean;
  /**
   * `block` in order, when lines of the author's are in it
   * (stories/testbench-record-toolbar.md §"Steps typed in the editor"): the
   * removal takes out the recording's parts and keeps the author's. Absent:
   * all of `block` is the recording's.
   */
  parts?: Array<{ text: string; mine: boolean }>;
  params: string;
  paramsLineEnd: boolean;
  section: string | null;
  /** Later steps the recording renumbered: the number it wrote, the one the
   *  file had, and the rest of the line. */
  tails: Array<{ wrote: string; original: string; rest: string }>;
}

/** The record as `UnfinishedRecording`, or null when nothing of it is in the
 *  file (no steps written, or not where the offsets say). */
export function unfinishedRecordingOf(live: LiveRecord): UnfinishedRecording | null {
  if (live.uncertain) return null;
  const run = live.slots.filter(isRun);
  const block = run.find((s) => s.wrote !== '');
  const params = live.slots.find((s) => s.kind === 'params');
  if (!block || !run.some((s) => s.kind === 'block' && s.wrote !== '')) return null;
  const mine = run.some((s) => s.kind === 'mine');
  return {
    block: run.map((s) => s.wrote).join(''),
    blockLineEnd: block.lineEnd,
    ...(mine && { parts: run.filter((s) => s.wrote !== '').map((s) => ({ text: s.wrote, mine: s.kind === 'mine' })) }),
    params: params?.wrote ?? '',
    paramsLineEnd: params?.lineEnd ?? false,
    section: live.section,
    tails: live.slots
      .filter((s) => s.kind === 'tail' && s.placed !== false && s.wrote !== s.original)
      .map((s) => ({ wrote: s.wrote, original: s.original ?? '', rest: s.rest ?? '' })),
  };
}

/**
 * The edits that take an unfinished recording back out of `current` — its
 * block and parameter lines removed, each later step it renumbered given its
 * number back — or null when its block and parameter lines are not in the file
 * exactly once each (edited since, or gone): then nothing is offered, because
 * nothing can be proved to be the recording's. A later step whose line is not
 * found exactly keeps whatever number it has.
 */
export function removeUnfinishedRecording(
  current: string,
  unfinished: UnfinishedRecording,
): { edits: OffsetEdit[]; text: string } | null {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const convert = (s: string): string => s.replace(/\r?\n/g, eol);
  const run: RecordSlot[] = Array.isArray(unfinished.parts)
    ? unfinished.parts.map((p) => ({
        kind: p.mine ? ('mine' as const) : ('block' as const),
        start: 0,
        end: 0,
        lineEnd: unfinished.blockLineEnd,
        wrote: convert(String(p.text ?? '')),
      }))
    : [{ kind: 'block', start: 0, end: 0, lineEnd: unfinished.blockLineEnd, wrote: convert(unfinished.block) }];
  const snapshot: RecordSlot[] = [
    { kind: 'params', start: 0, end: 0, lineEnd: unfinished.paramsLineEnd, wrote: convert(unfinished.params) },
    ...run,
    ...unfinished.tails.map(
      (t): RecordSlot => ({ kind: 'tail', start: 0, end: 0, lineEnd: false, wrote: t.wrote, original: t.original, rest: t.rest }),
    ),
  ];
  let m: LineModel | null = null;
  const found = findWritten(
    current,
    () => (m ??= modelOf(current)),
    snapshot,
    unfinished.section,
    -1,
    () => ({ at: 0, lineEnd: unfinished.paramsLineEnd }),
  );
  if (!found) return null;
  const edits: OffsetEdit[] = [];
  for (const slot of found) {
    if (slot.kind === 'tail') {
      if (slot.placed && slot.wrote !== slot.original) {
        edits.push({ start: slot.start, end: slot.end, text: slot.original ?? '', kind: 'tail' });
      }
    } else if (slot.kind !== 'mine' && slot.end > slot.start) {
      // The author's own lines in the block stay.
      edits.push({ start: slot.start, end: slot.end, text: '', kind: slot.kind });
    }
  }
  return { edits, text: applyOffsetEdits(current, edits) };
}

/** Offset of the start of every line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** The 0-based line holding `offset`. */
function lineAtOffset(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
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
 * Where Record New Test creates the file (SPEC-record-steps.md §7.2):
 *
 *  - a project (an `aiui.config.json` inside the workspace): its `tests.dir`,
 *    or — when it declares none — the server's default, `./tests` beside the
 *    config (src/config/defaults.ts);
 *  - no project: the fixed folder `testbench-native.testsGlob` starts in
 *    (`tests/**\/*.md` → `tests/`), which is where Test Explorer looks; else
 *    the workspace folder itself (the default glob, `**\/*.md`, starts there).
 *
 * A folder outside the workspace is refused — before anything is created —
 * since TestBench can neither discover nor record a test there.
 */
export function newTestDir(args: {
  /** The project's `aiui.config.json`, or null when there is none. */
  configPath: string | null;
  /** Its `tests.dir`, resolved; null when it declares none. */
  configTestsDir: string | null;
  testsGlob: string;
  workspaceRoot: string;
}):
  | { dir: string; source: 'config' | 'config-default' | 'glob' | 'workspace' }
  | { refused: string } {
  let dir: string;
  let source: 'config' | 'config-default' | 'glob' | 'workspace';
  if (args.configPath && args.configTestsDir) {
    dir = path.resolve(args.configTestsDir);
    source = 'config';
  } else if (args.configPath) {
    dir = path.resolve(path.dirname(args.configPath), 'tests');
    source = 'config-default';
  } else {
    const prefix = globStaticPrefix(args.testsGlob);
    dir = prefix !== '' ? path.resolve(args.workspaceRoot, prefix) : path.resolve(args.workspaceRoot);
    source = prefix !== '' ? 'glob' : 'workspace';
  }
  const rel = path.relative(path.resolve(args.workspaceRoot), dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      refused:
        `The project's tests folder (${dir}) is outside this workspace, so Record New Test cannot create ` +
        `a test there. Open the project's folder, or point tests.dir in aiui.config.json inside it.`,
    };
  }
  return { dir, source };
}

/** Folders the project search never enters, besides every dot-folder (`.git`,
 *  `.vscode-test`, `.live-shards`, a worktree under `.claude/`…): installed
 *  packages and build output, which carry other projects' configs. */
const PROJECT_SEARCH_SKIP = new Set(['node_modules', 'dist']);

/**
 * Every `aiui.config.json` inside `root`, for Record New Test when the active
 * editor leads to none (SPEC-record-steps.md §7.2): a workspace whose project
 * sits in a subfolder, with no editor open inside it. A shallow search — the
 * root's own folder and up to `maxDepth` levels below it, at most `maxDirs`
 * folders read, symlinks and junctions not followed — shallowest first, then
 * by path. One is the project; several are for the author to choose between.
 */
export function findProjectConfigs(root: string, opts: { maxDepth?: number; maxDirs?: number } = {}): string[] {
  const maxDepth = opts.maxDepth ?? 3;
  let budget = opts.maxDirs ?? 2000;
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(root), depth: 0 }];
  // Breadth first, so a budget that runs out has read the shallow folders.
  while (queue.length > 0 && budget-- > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === 'aiui.config.json') found.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && !PROJECT_SEARCH_SKIP.has(e.name)) {
        queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  const base = path.resolve(root);
  const rel = (p: string): string[] => path.relative(base, p).split(path.sep);
  return found.sort((a, b) => rel(a).length - rel(b).length || rel(a).join('/').localeCompare(rel(b).join('/')));
}

/**
 * Text for a VS Code notification from something the page or the model wrote
 * (a note, a server error). Notifications turn `[text](target)` into a
 * clickable link — `command:` targets included — so the one pattern that
 * makes a link is broken up; the words are unchanged.
 */
export function plainNotificationText(text: string): string {
  return text.replace(/\]\s*\(/g, '] (');
}

/**
 * The steps and parameters a recording produced, as text the author can paste
 * — what is shown in the output channel, and copied by "Copy steps", when the
 * insertion itself could not be made. A result is never lost.
 */
export function recordedStepsText(steps: unknown[], parameters: unknown[]): string {
  const lines = (Array.isArray(steps) ? steps : [])
    .map(cleanStepText)
    .filter((s) => s !== '')
    .map((s, i) => `${i + 1}. ${s}`);
  const params = (Array.isArray(parameters) ? parameters : [])
    .map((p) => (p ?? {}) as { name?: unknown; value?: unknown })
    .filter((p) => String(p.name ?? '').trim() !== '')
    .map((p) => {
      const value = String(p.value ?? '').trim();
      // A line break would end the parameter line; shown escaped instead, so
      // the value is still all there.
      return `- ${String(p.name).trim()}: ${/[\r\n]/.test(value) ? JSON.stringify(value) : value}`;
    });
  return [...(params.length > 0 ? ['## Parameters', ...params, ''] : []), '## Steps', ...lines].join('\n');
}

/** `m:ss` since the recording started, for the panel's action list. */
export function formatRecordTime(atMs: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(atMs) ? atMs : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The status bar's text while recording (SPEC-record-steps.md §3.2). "N
 * actions" counts ACTIONS in decision 4's sense — not the events (typing,
 * selecting…) that ride with them — and not the ones the author dropped.
 */
export function recordingStatusText(state: {
  phase: string;
  paused?: boolean;
  actions: Array<{ dropped: boolean; action?: boolean }>;
}): string {
  if (state.phase === 'finishing') return 'Finishing…';
  if (state.phase === 'starting') return 'Recording — starting…';
  const n = state.actions.filter((a) => !a.dropped && a.action !== false).length;
  // stories/testbench-record-toolbar.md §"Pause and resume, in detail".
  return `${state.paused ? 'Recording paused' : 'Recording'} — ${n} ${n === 1 ? 'action' : 'actions'}`;
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
        // Absent reads as an action: every frame was one before the flag.
        action: event['action'] !== false,
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
      // Blank steps are dropped, so the author's indices are mapped onto the
      // steps as kept.
      const raw = Array.isArray(event['steps']) ? event['steps'] : [];
      const steps: string[] = [];
      const kept = new Map<number, number>();
      raw.forEach((r, i) => {
        const s = cleanStepText(r);
        if (s === '') return;
        kept.set(i, steps.length);
        steps.push(s);
      });
      const ids = Array.isArray(event['authoredIds']) ? event['authoredIds'] : [];
      const authored: number[] = [];
      const authoredIds: string[] = [];
      (Array.isArray(event['authored']) ? event['authored'] : []).forEach((idx, k) => {
        const at = kept.get(Number(idx));
        if (at === undefined || authored.includes(at)) return;
        authored.push(at);
        authoredIds.push(typeof ids[k] === 'string' ? (ids[k] as string) : '');
      });
      const locked = Number(event['locked']);
      state.draft = {
        revision,
        steps,
        parameters: (Array.isArray(event['parameters']) ? event['parameters'] : [])
          .map((p) => {
            const o = (p ?? {}) as { name?: unknown; value?: unknown };
            return { name: String(o.name ?? '').trim(), value: String(o.value ?? '') };
          })
          .filter((p) => p.name !== ''),
        notes: (Array.isArray(event['notes']) ? event['notes'] : []).map(String).filter((n) => n.trim() !== ''),
        ...(typeof through === 'string' && through !== '' && { through }),
        // Locking (stories/testbench-record-toolbar.md §"Locking in"): the
        // steps the model can no longer rewrite, and the author's own.
        ...(Number.isFinite(locked) && locked > 0 && { locked: Math.min(Math.floor(locked), steps.length) }),
        ...(authored.length > 0 && { authored, authoredIds }),
      };
      return true;
    }
    case 'record:writing':
      state.phase = 'finishing';
      state.pickArmed = false;
      return true;
    case 'record:paused': {
      // stories/testbench-record-toolbar.md §"Pause and resume, in detail":
      // a `❚❚ Paused` / `▶ Resumed` row where it happened, and the status.
      const paused = event['paused'] === true;
      if ((state.paused === true) === paused) return false;
      state.paused = paused;
      if (paused) state.pickArmed = false;
      const n = state.actions.filter((a) => a.kind === 'pause' || a.kind === 'resume').length;
      state.actions.push({
        id: `${paused ? 'pause' : 'resume'}-${n + 1}`,
        kind: paused ? 'pause' : 'resume',
        action: false,
        summary: paused ? 'Paused' : 'Resumed',
        atMs: Number(event['atMs']) || 0,
        dropped: false,
      });
      return true;
    }
    case 'record:step': {
      // A step of the author's joined the recording: `✎ Your step: …`, with
      // a ✕ that drops it by its id like an action's.
      const id = String(event['id'] ?? '');
      const text = cleanStepText(event['text']);
      if (id === '' || text === '') return false;
      const raw = event['source'];
      const source: 'toolbar' | 'editor' | 'panel' | undefined =
        raw === 'toolbar' || raw === 'editor' || raw === 'panel' ? raw : undefined;
      const entry = {
        id,
        kind: 'step' as const,
        action: false,
        summary: text,
        atMs: Number(event['atMs']) || 0,
        dropped: false,
        ...(source !== undefined && { source }),
      };
      const at = state.actions.findIndex((a) => a.id === id);
      if (at >= 0) state.actions[at] = { ...entry, dropped: state.actions[at]!.dropped };
      else state.actions.push(entry);
      return true;
    }
    case 'record:dropped': {
      // A drop or restore made in the browser (the toolbar's Undo, Restore).
      const row = state.actions.find((a) => a.id === String(event['id'] ?? ''));
      const dropped = event['dropped'] === true;
      if (!row || row.kind === 'pause' || row.kind === 'resume' || row.dropped === dropped) return false;
      row.dropped = dropped;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Steps so far, marked (stories/testbench-record-toolbar.md): a lock on each
 * locked step — the model can no longer rewrite it — and "yours" on each
 * step the author wrote.
 */
export function draftStepMarks(
  draft: { steps: string[]; locked?: number; authored?: number[] } | null,
): Array<{ locked: boolean; yours: boolean }> {
  if (!draft) return [];
  const locked = Number.isFinite(draft.locked) ? Number(draft.locked) : 0;
  const yours = new Set(Array.isArray(draft.authored) ? draft.authored : []);
  return draft.steps.map((_, i) => ({ locked: i < locked, yours: yours.has(i) }));
}

/**
 * The author's steps of the last draft, placed in the RESULT: `record:result`
 * does not say which of its steps are the author's, and the result is the
 * last draft with its open steps brought up to date — the author's steps are
 * all in the locked part, so each is where the draft had it, or (a model that
 * moved things anyway) the next step on with the same text. One not found is
 * left out: its line in the file is then the author's text beside the result.
 */
export function authoredForResult(
  draft: { steps: string[]; authored?: number[]; authoredIds?: string[] } | null,
  resultSteps: unknown[],
): { authored: number[]; authoredIds: string[] } {
  const result = (Array.isArray(resultSteps) ? resultSteps : []).map(cleanStepText).filter((s) => s !== '');
  const authored: number[] = [];
  const authoredIds: string[] = [];
  if (!draft?.authored || !draft.authoredIds) return { authored, authoredIds };
  let from = 0;
  draft.authored.forEach((idx, k) => {
    const id = draft.authoredIds?.[k] ?? '';
    const text = draft.steps[idx];
    if (id === '' || text === undefined) return;
    let at = result[idx] === text && idx >= from ? idx : -1;
    if (at < 0) at = result.indexOf(text, from);
    if (at < 0) return;
    authored.push(at);
    authoredIds.push(id);
    from = at + 1;
  });
  return { authored, authoredIds };
}
