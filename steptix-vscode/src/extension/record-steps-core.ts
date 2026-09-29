/**
 * Record Steps — where the recorded steps go, and the one edit that puts them
 * there (stories/steptix-record-steps.md, decisions 8 and 11). No `vscode`
 * import, so every rule is pinned under `node --test`.
 *
 * The server records and the model writes; Steptix does the editing. What
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
} from 'steptix-runner-core';
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

/** A line that opens an HTML comment, as the parser's table scan reads one
 *  (src/parser/data-rows.ts): its `<!--` line, whatever indentation. */
function opensHtmlComment(raw: string): boolean {
  return raw.trimStart().startsWith('<!--');
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
    if (opensHtmlComment(raw)) {
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
 *    (stories/steptix-record-toolbar.md §"Steps typed in the editor") —
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
  /**
   * `mine`, `sent`: it went with no `afterStep` — below everything recorded —
   * so the server puts it after every step drafted until it does. Until a
   * draft holds it, it is at the end of the run as far as any line above it
   * is concerned: every step goes above it.
   */
  sentAtEnd?: boolean;
  /** `mine`: its step was one of the draft last written (`authoredIds`). */
  inDraft?: boolean;
  /**
   * `mine`: the line's leading number as the recording numbered it — the
   * author's line takes the recording's numbering once the draft holds its
   * step (stories/steptix-record-toolbar.md §"Locking in": "a leading number
   * or list marker you typed is removed and replaced by the recording's
   * numbering"). `digits`: only the number of an `N.` line is replaced;
   * `marker`: a list marker, `N)` or nothing is replaced by `N. `. `author` is
   * what was there before, given back when the draft no longer holds the step
   * and at the empty draft; `wrote` what the recording put there. `'author'`:
   * the author changed it since — the number is theirs again, for good, as a
   * later step's is (§7).
   */
  number?: { mode: 'digits' | 'marker'; author: string; wrote: string } | 'author';
  /**
   * `mine`, once sent: the line as the recording last left it — as it read
   * when it was sent, then as each write that numbered it (or put it back)
   * made it, while the author had not changed it meanwhile. A line whose step
   * is dropped is taken out of the file only when it still reads exactly this
   * (`dropped`).
   */
  recAs?: string;
  /**
   * `mine`: its step was dropped — the panel's ✕ or the toolbar's Undo
   * (stories/steptix-record-toolbar.md §"Undo and locked steps": removing a
   * step of yours "takes your line out"). `hidden`: taken out of the file —
   * the slot is empty where the line was, and `hiddenText` is the line, put
   * back there when the step is restored and by the empty draft. `left`: the
   * author had edited the line since the recording last left it, so it stayed
   * in the file (said once). Absent: not dropped.
   */
  dropped?: 'hidden' | 'left';
  /** `mine`, `dropped: 'hidden'` or `cleared`: the line taken out, with its
   *  line break. */
  hiddenText?: string;
  /**
   * `block`: the step each of its lines holds — one entry per line of
   * `wrote` (`unitsOf`), the step's id (`record:draft.ids`), or null for a
   * blank line the block carries for spacing. Absent when the draft written
   * carried no ids (a server that predates editing): an edit inside its lines
   * is then written over by the next draft, as it always was.
   */
  ids?: Array<string | null>;
  /**
   * `mine`: `edit` — a line the RECORDING wrote that the author changed
   * (stories/steptix-record-edit-steps.md §"In the file"). It is being
   * edited from their first keystroke: never written again but for its
   * leading number, which stays the recording's; `stepId` is the step it
   * stands for. Absent: a line the author typed as a new step.
   */
  origin?: 'edit';
  /** `mine`, `edit`: the step's words as the line read when the author began
   *  to edit it — a line changed back to them, with nothing sent, is no edit. */
  editOf?: string;
  /** `mine`: an `edit-step` went for it that neither a `record:edited` nor a
   *  draft has shown the server took yet (and it was not refused). */
  unacked?: boolean;
  /**
   * `mine`: newer words for its step from elsewhere — the browser's drawer or
   * the panel (`record:edited`) — which the next write puts on the line in
   * place of its step's text, unless the author is editing the line: then the
   * file wins, and what they commit is sent.
   */
  follow?: string;
  /** `mine`, `edit` (or `emptied`): taken out by the recording's clear-out
   *  (`LiveDraft.clear`) — Cancel takes out every step the recording wrote,
   *  reworded ones too — and put back (from `hiddenText`) by the next draft,
   *  as the result at Stop is. */
  cleared?: boolean;
  /**
   * `mine`: a recorded line the author emptied, or left only a number — its
   * step deleted, the line theirs. While it has no words on it the empty
   * draft takes it out with the steps (it was the recording's line, and
   * nothing of the author's is lost); words typed on it make it a new line of
   * theirs like any other.
   */
  emptied?: boolean;
  /**
   * `mine`: the line stood for a step until the author emptied it (a delete):
   * the step, its words, and whether the line was a reworded recorded one.
   * Its words back on it — Ctrl+Z of the emptying — are that step restored.
   */
  emptiedOf?: { id: string; words: string; reworded: boolean };
  /**
   * `block`: the steps this part held when the recording's clear-out
   * (`LiveDraft.clear`) took them out — Stop after the author typed takes the
   * drafts out, then writes the result. Until the next draft is written the
   * part counts as holding them, so a line of the author's between two parts
   * keeps its place among the steps: the result is laid out as it would have
   * been over the draft (`stepsAbove`, `atRunEnd`, `layoutByCount`).
   */
  clearedSteps?: number;
  /** `mine`: the draft last written held its step when the clear-out ran
   *  (`inDraft`, which the clear-out resets) — counted as it was, as above. */
  clearedHeld?: boolean;
  /**
   * `mine`: an undo or redo left the line with words that are not what the
   * server holds for its step from the file — the author's rewording undone.
   * It counts at once, wherever the cursor is (`commitLineEdits`): an undo is
   * not typing, and a second Ctrl+Z (the recording's own write, say) before
   * the cursor leaves the line would leave the server with the undone words.
   */
  commitNow?: boolean;
  /**
   * `mine`, `edit`: a recorded line the author MOVED — Alt+Up/Down, or cut
   * and pasted back among the recorded lines (a line whose words are a step
   * this file deleted is that step restored) — with its step's words. It is
   * the author's line where they put it: the recording never writes its
   * words, and lays the draft out around it by what the file has above it
   * (`layoutByCount`), not by where the draft has its step. `held`: a draft
   * has held its step since — one that later does not (the model rewrote the
   * step) is answered with an `edit-step` of the line's words, which puts the
   * step back under its id, so it is not written a second time beside it.
   */
  moved?: 'waiting' | 'held';
  /**
   * `mine`: the line took in text from outside the recorded lines — a
   * recorded line joined with the line above the block (`above`: Backspace at
   * its start, or a selection from above it typed over) or below it
   * (`below`: Delete at its end) (`rereadRun`). It is the recorded step's
   * line, being edited; but it holds a line of the author's too, so the
   * recording's clear-out (Cancel) leaves it rather than take their text out
   * with it, and it keeps its own leading number. `above`: it holds the line
   * the steps go after, so it stays the run's first line — no step is ever
   * written above it (`layoutRun`).
   */
  joined?: 'above' | 'below';
  /**
   * `mine`: newer words for its step came from the drawer or the panel and
   * the line did not take them (the author had changed it since — the file
   * wins), while its words were already what went from the file: they go
   * again when the author leaves the line, so the server does not keep the
   * drawer's words the file does not have.
   */
  resend?: boolean;
}

/**
 * An undo put text back on lines the author had emptied of their step
 * (`RecordSlot.emptiedOf`): Ctrl+Z of the emptying is a Restore
 * (stories/steptix-record-edit-steps.md §"Delete"). Each such line stands
 * for its step again — a reworded line being edited (what it says goes to the
 * server as an edit when the author leaves it, or it is the recording's line
 * again if it says the step's words), a typed one as it went — and the step is
 * restored. Words typed on an emptied line by hand make a new line instead.
 */
function relinkEmptied(record: LiveRecord, book: LineBook): LiveRecord {
  let changed = false;
  const slots = record.slots.map((s) => {
    if (s.kind !== 'mine' || !s.emptiedOf || cleanAuthorLine(mineLineText(s)) === '') return s;
    const { id, words, reworded } = s.emptiedOf;
    changed = true;
    if (book.deleted.has(id)) {
      book.deleted.delete(id);
      const waiting = book.queue.findIndex((q) => q.action === 'drop' && q.id === id);
      if (waiting >= 0) book.queue.splice(waiting, 1);
      else book.queue.push({ action: 'restore', id });
    }
    const next: RecordSlot = { ...s, stepId: id };
    delete next.emptiedOf;
    delete next.emptied;
    if (reworded) {
      next.origin = 'edit';
      next.status = 'typing';
      next.editOf = words;
      next.inDraft = true;
    } else {
      next.status = 'sent';
      next.sentText = words;
    }
    return next;
  });
  return changed ? { ...record, slots } : record;
}

/**
 * What the author did to the recording's steps in the file that the server
 * has to hear, and what it knows of their words — one per recording, kept by
 * whoever drives it (step-recorder.ts, or a test), and handed to the functions
 * that follow the file (stories/steptix-record-edit-steps.md). Not part of
 * a `LiveRecord`: the states an undo brings back are text, and what was sent
 * stays sent whichever of them is in the file.
 */
export interface LineBook {
  /** Steps whose line the author deleted (a whole line gone, or one emptied
   *  and left): left out of every draft written from then on — one in flight
   *  still holds them — until the line comes back or the step is restored. */
  deleted: Set<string>;
  /** `drop` / `restore` to send, in order: a line deleted, a line back. */
  queue: Array<{ action: 'drop' | 'restore'; id: string }>;
  /** The words the server holds as the author's for a step, by id: each
   *  `edit-step` sent from the file, and each `record:edited`. */
  told: Map<string, string>;
  /** The steps whose words in `told` came from the file — an `edit-step` of
   *  ours — rather than the drawer or the panel. */
  fromFile: Set<string>;
  /** Lines the author typed, sent, and deleted before their step had an id:
   *  the text each went as — dropped once `record:step` names it. */
  unnamed: string[];
  /** The words each step in `deleted` had in the file when its line went,
   *  and whether that line was one the author typed: a line with those words
   *  back among the recorded lines (cut and pasted, or typed again) is that
   *  step restored, not a new step. */
  deletedWords: Map<string, { words: string; typed: boolean }>;
}

/** An empty book, for a recording that has just begun. */
export function newLineBook(): LineBook {
  return { deleted: new Set(), queue: [], told: new Map(), fromFile: new Set(), unnamed: [], deletedWords: new Map() };
}

/** Take the controls waiting in `book`, in order. */
export function takeLineControls(book: LineBook): Array<{ action: 'drop' | 'restore'; id: string }> {
  return book.queue.splice(0, book.queue.length);
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
  /**
   * The `revision` of the draft these slots hold (`record:draft.revision`):
   * what an `afterStep` counted against them refers to. Absent until a draft
   * that carried one was written.
   */
  revision?: number;
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
  /** Earlier states that held written steps, oldest first — the writes, and
   *  the file before each edit or delete of the author's that changed what
   *  the lines are (an undo of it brings that one back). */
  history: LiveState[];
  /** The drafts written carry step ids (`record:draft.ids`): the author's
   *  edits and deletes of recorded lines are followed and sent. False or
   *  absent — a server that predates editing — and an edit inside the
   *  recorded lines is written over by the next draft, warned, as before. */
  editable?: boolean;
  /**
   * Lines the recording wrote that the author moved out of it — above the
   * line the steps go after (`rereadRun`) — as they read then: theirs from
   * then on. When what the recording wrote is looked for by its text, these
   * are not "the recording's text left elsewhere" (`nothingLeft`).
   */
  outside?: string[];
}

/** The state part of a record, for its history. */
function stateOf(record: LiveState): LiveState {
  return {
    base: record.base,
    anchor: record.anchor,
    section: record.section,
    slots: record.slots,
    ...(record.revision !== undefined && { revision: record.revision }),
  };
}

/** The state holds steps the recording wrote — or lines of the author's
 *  among them: a state an undo can bring back all the same. */
const holdsSteps = (state: LiveState): boolean =>
  state.slots.some(
    (s) =>
      (s.kind === 'block' && s.wrote !== '') ||
      // Every recorded line reworded, or deleted with later steps renumbered
      // for them, or with only the author's own lines left (their typed ones,
      // lines they emptied): an undo can bring that state back.
      (s.kind === 'mine' && s.wrote !== '') ||
      (s.kind === 'tail' && s.placed !== false && s.wrote !== s.original),
  );

/** A replacement in offsets of the document as it is — `start === end` inserts. */
export interface OffsetEdit {
  start: number;
  end: number;
  text: string;
  /** The slot it writes, when a live write made it. */
  kind?: RecordSlot['kind'];
  /**
   * `mine` edits: what the write does to a line of the author's — its
   * leading `number`; `hide` / `reveal` it (its step dropped, restored); `clear`
   * it (the empty draft takes reworded lines out) or bring it back; `follow`:
   * put newer words for its step, given elsewhere, in place of its text.
   */
  why?: 'number' | 'hide' | 'reveal' | 'clear' | 'follow';
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
  /** Lines of the author's whose step was dropped by this write's draft and
   *  that stayed in the file because the author had edited them — the line
   *  as it reads, for the one sentence that says so. */
  left: Array<{ key: string; line: string }>;
  /** `numbersLater`: the draft only renumbered, and nothing was written —
   *  the record takes the draft's revision; the numbers catch up with the
   *  next write that changes anything else. */
  postponed?: boolean;
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
 * stories/steptix-record-toolbar.md §"Steps typed in the editor") are never
 * written: the draft is laid out AROUND them (`layoutRun`). One whose step the
 * draft holds (by its id, `record:draft.ids` — or `authored`/`authoredIds`
 * from a server that sends no ids) IS that step — the draft's text for it is
 * not written again beside it; one the draft does not hold yet divides the
 * draft by how many of its steps are above it in the file. Every block part is
 * changed only where it differs (`slotEdits`), so steps the draft left as they
 * were are not rewritten, bar a number the author's line pushed on. The empty
 * draft takes every block part out and leaves the lines the author typed where
 * they are.
 *
 * A recorded line the author changed (stories/steptix-record-edit-steps.md
 * §"In the file", `RecordSlot.origin` `edit`) is theirs from the first
 * keystroke, held by the step it stands for: never written again but for its
 * leading number, which stays the recording's — and, when newer words for its
 * step came from the browser's drawer or the panel while the author is not
 * editing it (`RecordSlot.follow`), its text. It is a step the recording
 * wrote, though: the recording's clear-out (`draft.clear` — Cancel, the
 * drafts taken out before the result) takes it out, and the next draft puts
 * it back where it was.
 *
 * A draft that holds the author's lines in an order the file does not have
 * them in (the server placed two lines at one point the other way round) is
 * laid out by count instead (`layoutRun`): every line of the author's the
 * draft holds is still that step, never written beside it, and the steps are
 * numbered in the order the file has them.
 *
 * A line of the author's whose step was dropped (`draft.droppedIds`) is taken
 * out of the file when it still reads as the recording last left it, and put
 * back where it was when the step is restored and by the empty draft; one the
 * author edited since stays, and is listed in `left` (`RecordSlot.dropped`).
 * The steps whose lines the author deleted (`book.deleted`) are left out of
 * every draft: one in flight still holds them, and writing it would put the
 * line back.
 */
export function liveRecordWrite(
  live: LiveRecord,
  current: string,
  draft: LiveDraft,
  opts: { anchor?: RecordAnchor | null; book?: LineBook; numbersLater?: boolean } = {},
): LiveRecordWrite | { error: string; lost?: boolean } {
  const book = opts.book ?? newLineBook();
  const where = locateLiveRecord(live, current, opts.anchor, book);
  if (where.status === 'lost') return { error: where.reason, lost: true };
  // After the search: a line an undo brought back is restored by it.
  const droppedNow = (): Set<string> =>
    new Set<string>([...(Array.isArray(draft.droppedIds) ? draft.droppedIds : []), ...book.deleted]);
  let d = draftSteps(draft, droppedNow());
  // A line the author typed, sent, and deleted before its step had a name:
  // the draft holding that step (by its text, no line naming its id) is the
  // one to leave out — the step goes, it is not written back as the
  // recording's.
  if (book.unnamed.length > 0 && where.status === 'found') {
    const named = new Set(where.record.slots.flatMap((s) => (s.kind === 'mine' && s.stepId ? [s.stepId] : [])));
    for (const [id, idx] of d.authoredAt) {
      if (named.has(id) || (draft.foreignIds ?? []).includes(id)) continue;
      const k = book.unnamed.indexOf(d.steps[idx] ?? '');
      if (k < 0) continue;
      book.unnamed.splice(k, 1);
      stepGone(book, id, d.steps[idx], true);
    }
    d = draftSteps(draft, droppedNow());
  }
  const { steps } = d;
  const empty = steps.length === 0;
  let record: LiveRecord;
  /** The history the record carries on: every earlier state that held steps. */
  let prior: LiveState[];
  let relocated: LiveRecordWrite['relocated'] = where.status === 'found' && where.moved ? 'found' : 'no';
  if (where.status === 'absent') {
    if (empty) {
      return { edits: [], slots: live.slots, record: live, text: current, plan: null, relocated: 'no', left: [] };
    }
    const anchor = opts.anchor !== undefined ? opts.anchor : live.anchor && { ...live.anchor, tracked: false };
    const begun = beginLiveRecord(current, anchor, { strict: true });
    if ('error' in begun) return { error: `${RECORDING_NOT_FOUND} (${begun.error})`, lost: true };
    record = {
      ...begun,
      ...(live.editable !== undefined && { editable: live.editable }),
      ...(live.outside !== undefined && { outside: live.outside }),
    };
    prior = holdsSteps(live) ? [...live.history, stateOf(live)] : live.history;
    relocated = 'fresh';
  } else {
    record = where.record;
    prior = holdsSteps(record) ? [...record.history, stateOf(record)] : record.history;
  }
  record = adoptStepIds(record, d, draft.foreignIds ?? []);
  // Whether the author's edits of recorded lines are followed: the drafts say
  // which step each line is. The empty draft (Cancel) says nothing about it.
  if (!empty) record = { ...record, editable: d.hasIds };

  // What becomes of each line of the author's whose step was dropped, or
  // restored, since the last write — and each reworded line the empty draft
  // took out, now steps come again. Only a step dropped elsewhere (the
  // drawer, the panel, the toolbar's Undo) takes a line of theirs out: one
  // whose line they deleted in the file never takes ANOTHER line with it —
  // their line stays, standing for nothing (the model rewrote the step they
  // were editing, they deleted its new line, and their edit had landed on it).
  const clearing = empty && draft.clear === true;
  const drops = dropActions(record.slots, new Set(Array.isArray(draft.droppedIds) ? draft.droppedIds : []), clearing);
  const left: LiveRecordWrite['left'] = [];
  for (const [slot, act] of drops) if (act === 'left') left.push({ key: slot.key ?? '', line: mineLineText(slot) });
  const dropState = (slot: RecordSlot): RecordSlot['dropped'] => {
    const act = drops.get(slot);
    if (act === 'hide' || act === 'keep-hidden') return 'hidden';
    if (act === 'left') return 'left';
    // A reworded line left in the file when its step was dropped, and taken
    // out by the empty draft since, comes back left.
    if (act === 'reveal' && slot.cleared === true && slot.dropped === 'left') return 'left';
    if (act === 'reveal' || act === 'undrop') return undefined;
    return slot.dropped;
  };
  const held = heldLines(record.slots, d, (s) => dropState(s) !== undefined, draft.adoptSentByText === true);

  let plan: RecordInsertionPlan | null = null;
  let want: (slot: RecordSlot) => string = (slot) => (slot.kind === 'tail' ? (slot.original ?? '') : '');
  /** `mine` slots the draft holds the step of, each with its number. */
  let joined = new Map<RecordSlot, string>();
  /** The step ids each block part's lines hold, as written. */
  let blockIds = new Map<RecordSlot, Array<string | null>>();
  if (!empty) {
    const planned = planRecordInsertion(record.base, { anchor: record.anchor, steps, parameters: draft.parameters });
    if ('error' in planned) return planned;
    plan = planned;
    // A line of the author's below another counts as of THIS draft: one it
    // holds now is a step of it, whatever the last draft said. A reworded
    // line is where a step of the recording's was.
    const placed = (s: RecordSlot): boolean =>
      dropState(s) === undefined &&
      (s.origin === 'edit' ? true : s.status === 'sent' && (held.has(s) || s.sentAtEnd !== true));
    const layout = layoutRun(record.slots, planned.parts, d.ids, (s) => held.get(s), placed);
    // Not block, mine, block, …, block: nothing written can be proved right.
    if (layout === null) return { error: RECORDING_NOT_FOUND, lost: true };
    joined = layout.joined;
    if (d.hasIds) blockIds = layout.ids;
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
  /** A part of the run as this write leaves it — with, at the recording's
   *  clear-out, what it held until then (`clearedSteps`, `clearedHeld`): the
   *  next draft (the result at Stop) lays the author's lines out among the
   *  steps as they were, not at the top of the block. */
  const push = (was: RecordSlot, next: RecordSlot): void => {
    delete next.clearedSteps;
    delete next.clearedHeld;
    if (clearing && was.kind === 'block') {
      const held = blockSteps(was);
      if (held > 0) next.clearedSteps = held;
    } else if (clearing && was.kind === 'mine' && (was.inDraft === true || was.clearedHeld === true)) {
      next.clearedHeld = true;
    }
    written.push(next);
  };
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
      const act = drops.get(slot);
      const start = slot.start + delta;
      const len = slot.end - slot.start;
      // The recording's clear-out: a line the author reworded stands for a
      // step the recording wrote, and goes with the rest — kept, to put back
      // if a draft comes again (the result at Stop after the drafts were
      // taken out).
      if (clearing && goesWithSteps(slot)) {
        const text = slot.cleared === true || slot.dropped === 'hidden' ? (slot.hiddenText ?? '') : slot.wrote;
        if (len > 0) {
          edits.push({ start: slot.start, end: slot.end, text: '', kind: 'mine', why: 'clear' });
          shifts.push({ at: slot.end, delta: -len });
        }
        const next: RecordSlot = { ...slot, start, end: start, wrote: '', hiddenText: text, cleared: true, inDraft: false };
        delete next.follow;
        push(slot, next);
        delta -= len;
        continue;
      }
      if (act === 'hide') {
        // Its step was dropped and the line reads as the recording left it:
        // taken out, kept to put back.
        if (len > 0) {
          edits.push({ start: slot.start, end: slot.end, text: '', kind: 'mine', why: 'hide' });
          shifts.push({ at: slot.end, delta: -len });
        }
        push(slot, { ...slot, start, end: start, wrote: '', hiddenText: slot.wrote, dropped: 'hidden', inDraft: false });
        delta -= len;
        continue;
      }
      if (act === 'keep-hidden') {
        // Taken out by the empty draft, and its step is dropped now: it stays
        // out, as a dropped step's line.
        const next: RecordSlot = { ...slot, start, end: start, inDraft: false, dropped: 'hidden' };
        delete next.cleared;
        push(slot, next);
        continue;
      }
      if ((slot.dropped === 'hidden' || slot.cleared === true) && act !== 'reveal') {
        push(slot, { ...slot, start, end: start, inDraft: false });
        continue;
      }
      // Put back where it was — its step restored, the clear-out, or a draft
      // again after the clear-out took a reworded line out — and numbered as
      // it is now.
      const revealing = act === 'reveal';
      const shown: RecordSlot = revealing
        ? { ...slot, wrote: slot.hiddenText ?? '', end: slot.start + (slot.hiddenText ?? '').length }
        : slot;
      // A line that took in a line from outside the block keeps the number
      // it has: it came with that line.
      const number = slot.joined !== undefined ? null : (joined.get(slot) ?? null);
      // Newer words for its step from the drawer or the panel: put on the
      // line — only while it reads as the recording last held it; the author
      // changed it since, and the file wins.
      let base = shown;
      let followed = false;
      if (slot.follow !== undefined && number !== null && !changedSince(shown)) {
        const words = followLine(shown, slot.follow);
        if (words !== null) {
          base = { ...shown, wrote: words, end: shown.start + words.length };
          followed = true;
        }
      }
      const renumbered = numberAuthorLine(base, number);
      if (revealing) {
        if (renumbered.wrote !== '') {
          edits.push({ start: slot.start, end: slot.start, text: renumbered.wrote, kind: 'mine', why: 'reveal' });
          shifts.push({ at: slot.start, delta: renumbered.wrote.length });
        }
      } else if (followed) {
        // One edit for the line's text, its number with it: the two meet at
        // a line with no number of its own.
        const lead = lineBreakLead(slot);
        const tail = slot.lineEnd ? 0 : slot.wrote.length - lead - mineLineText(slot).length;
        edits.push({
          start: slot.start + lead,
          end: slot.end - tail,
          text: renumbered.wrote.slice(lead, renumbered.wrote.length - tail),
          kind: 'mine',
          why: 'follow',
        });
        shifts.push({ at: slot.end, delta: renumbered.wrote.length - len });
      } else if (renumbered.edit) {
        edits.push(renumbered.edit);
        shifts.push({ at: slot.end, delta: renumbered.wrote.length - len });
      }
      const next: RecordSlot = { ...slot, start, end: start + renumbered.wrote.length, wrote: renumbered.wrote, inDraft: joined.has(slot) };
      if (slot.moved === 'waiting' && joined.has(slot)) next.moved = 'held';
      if (renumbered.number === undefined) delete next.number;
      else next.number = renumbered.number;
      delete next.hiddenText;
      delete next.cleared;
      const state = dropState(slot);
      if (state === undefined) delete next.dropped;
      else next.dropped = state;
      if (followed) {
        next.sentText = slot.follow;
        next.recAs = renumbered.wrote;
        delete next.follow;
      } else if (slot.follow !== undefined && changedSince(shown)) {
        // The author changed the line: what they commit goes instead.
        delete next.follow;
      }
      // What the recording leaves the line as — unless the author had changed
      // it since the recording last did: then it stays changed.
      const changed = revealing || renumbered.wrote !== slot.wrote;
      if (!followed && changed && hasStep(slot) && (revealing || slot.wrote === slot.recAs)) next.recAs = renumbered.wrote;
      push(slot, next);
      delta += renumbered.wrote.length - len;
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
    const next: RecordSlot = { ...slot, start, end: start + text.length, wrote: text, touched: false };
    if (slot.kind === 'block') {
      const ids = blockIds.get(slot);
      if (ids !== undefined) next.ids = ids;
      else if (d.hasIds || empty) next.ids = unitsOf(text, slot.lineEnd).map(() => null);
      else delete next.ids;
    }
    push(slot, next);
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
  const revision = typeof draft.revision === 'number' && Number.isFinite(draft.revision) ? draft.revision : record.revision;
  // `numbersLater` (the author's own edit is the last change, so what Ctrl+Z
  // undoes next): a draft that would only give steps their numbers — the
  // server's answer to a line they deleted, say — is not written now. Written,
  // it is an undo step of its own on top of theirs, and one Ctrl+Z would take
  // back the renumbering instead of their delete. The record is as it was,
  // but for the draft's revision; the next write catches the numbers up.
  if (opts.numbersLater === true && relocated === 'no' && edits.length > 0 && edits.every((e) => /^\d+$/.test(e.text) && /^\d+$/.test(current.slice(e.start, e.end))) && sameShape(record.slots, slots)) {
    return {
      edits: [],
      slots: record.slots,
      record: { ...record, uncertain: false, ...(revision !== undefined && { revision }) },
      text: current,
      plan,
      relocated,
      left,
      postponed: true,
    };
  }
  return {
    edits,
    slots,
    record: { ...record, slots, uncertain: false, history, ...(revision !== undefined && { revision }) },
    text: applyOffsetEdits(current, edits),
    plan,
    relocated,
    left,
  };
}

/** Two sets of slots that differ at most in the text they hold (the numbers
 *  written on them): the same parts, in order, standing for the same steps,
 *  held by the draft or not alike. */
function sameShape(a: RecordSlot[], b: RecordSlot[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return (
      x.kind === y.kind &&
      x.key === y.key &&
      x.stepId === y.stepId &&
      x.inDraft === y.inDraft &&
      x.dropped === y.dropped &&
      x.placed === y.placed &&
      x.moved === y.moved &&
      JSON.stringify(x.ids ?? null) === JSON.stringify(y.ids ?? null)
    );
  });
}

/** A line of the author's that the empty draft takes out with the steps: a
 *  recorded line they reworded, or one they emptied of its step and left with
 *  no words (`RecordSlot.emptied`). */
function goesWithSteps(s: RecordSlot): boolean {
  // A line that took in a line of the author's from outside the block stays:
  // taking it out would take their text with it.
  if (s.joined !== undefined) return false;
  return s.origin === 'edit' || (s.emptied === true && cleanAuthorLine(mineLineText(s)) === '');
}

/** A line of the author's stands for a step: a reworded recorded line, or a
 *  typed one that went to the server. */
function hasStep(s: RecordSlot): boolean {
  return s.origin === 'edit' ? s.status !== 'typing' || s.stepId !== undefined : s.status === 'sent';
}

/** The author is editing the line: a reworded one not committed yet, or any
 *  whose words are no longer what went to the server for it. */
function beingEdited(s: RecordSlot): boolean {
  return s.status === 'typing' || cleanAuthorLine(mineLineText(s)) !== s.sentText;
}

/** How many characters of a `mine` slot's text are the line break in front
 *  of its line (a slot hanging off the end of a line). */
function lineBreakLead(s: RecordSlot): number {
  return s.lineEnd ? (s.wrote.startsWith('\r\n') ? 2 : s.wrote.startsWith('\n') ? 1 : 0) : 0;
}

/**
 * A line of the author's with `words` in place of its step's text — the
 * number or marker in front of it, and the line break, as they are. Null when
 * there is nothing on the line to replace.
 */
function followLine(slot: RecordSlot, words: string): string | null {
  const lead = lineBreakLead(slot);
  const line = mineLineText(slot);
  const at = stepTextStart(line);
  if (line.slice(at).trim() === '') return null;
  const tail = slot.wrote.slice(lead + line.length);
  return slot.wrote.slice(0, lead) + line.slice(0, at) + words + tail;
}

/** Where a line's step text starts: after its indentation, and its leading
 *  number (`8.`, `8)`) or list marker with the space after it. */
function stepTextStart(line: string): number {
  return /^[ \t]*(?:(?:\d{1,9}[.)]|[-*+])(?:[ \t]+|$))?/.exec(line)?.[0].length ?? 0;
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
  /**
   * Every step's id, parallel to `steps` (`record:draft.ids` — or, for the
   * result, which carries none, the last draft's mapped onto it:
   * `idsForResult`). Absent from a server that predates editing.
   */
  ids?: unknown;
  /** Indices into `steps` of the author's rewordings (`record:draft.edited`). */
  edited?: unknown;
  /** Ids `record:step` said came from the toolbar or the panel: never taken
   *  for a line the author typed in the file. */
  foreignIds?: string[];
  /** The draft's `revision` (`record:draft.revision`), kept with what the
   *  write leaves (`LiveState.revision`). Absent for the result and the empty
   *  draft: the record keeps the one it had. */
  revision?: number;
  /**
   * Ids of steps that are dropped now — an author's step struck in the panel,
   * by its ✕ or the toolbar's Undo, or a step deleted from Steps so far. Each is
   * left out of the draft (the draft the server sends next is this one without
   * it), and a line of the author's that is one is taken out of the file
   * (`RecordSlot.dropped`).
   */
  droppedIds?: string[];
  /**
   * The recording's own taking-out of what it wrote — Cancel, a recording
   * that ends in an error, the drafts taken out before the result goes in
   * (`{ steps: [], parameters: [], clear: true }`): the recorded lines the
   * author reworded or emptied go with it. A draft of the server's that has
   * no steps (every one deleted) takes out the recording's lines only: the
   * author's stay where they are.
   */
  clear?: boolean;
  /**
   * The result at Stop: a line of the author's that went to the server and
   * that no draft held yet (sent just before Stop) is the result's step with
   * the text it was sent as — `record:result` does not say which steps are the
   * author's, and writing that step as the recording's would put it in the
   * file a second time, beside the line.
   */
  adoptSentByText?: boolean;
}

/** A draft's steps as they will be written — see `draftSteps`. */
interface DraftSteps {
  steps: string[];
  /** Each step's id, parallel to `steps` ('' where the draft names none). */
  ids: string[];
  /** The author's steps, by their `authoredIds` id. */
  authoredAt: Map<string, number>;
  /** The author's steps the draft names no id for. */
  anonymous: number[];
  /** The author's rewordings (`record:draft.edited`), as indices into `steps`. */
  edited: Set<number>;
  /** The draft named its steps' ids (`record:draft.ids`). */
  hasIds: boolean;
}

/**
 * The draft's steps as they will be written (blanks dropped, and the steps
 * that are dropped now), each with its id, and where each of the author's
 * steps is among them: by its id, or — `anonymous` — at an index the draft
 * names no id for (a server that sends `authored` without `authoredIds`).
 */
function draftSteps(draft: LiveDraft, dropped: ReadonlySet<string>): DraftSteps {
  const raw = Array.isArray(draft.steps) ? draft.steps : [];
  const authored = Array.isArray(draft.authored) ? draft.authored : [];
  const authorIds = Array.isArray(draft.authoredIds) ? draft.authoredIds : [];
  const rawIds = Array.isArray(draft.ids) ? draft.ids : null;
  const rawEdited = new Set((Array.isArray(draft.edited) ? draft.edited : []).map((i) => Number(i)));
  /** Each author step's raw index, with its id ('' when none is named). */
  const idAt = new Map<number, string>();
  authored.forEach((idx, k) => {
    const i = Number(idx);
    if (!Number.isInteger(i) || idAt.has(i)) return;
    const id = authorIds[k];
    idAt.set(i, typeof id === 'string' ? id : '');
  });
  const steps: string[] = [];
  const ids: string[] = [];
  const authoredAt = new Map<string, number>();
  const anonymous: number[] = [];
  const edited = new Set<number>();
  raw.forEach((r, i) => {
    const s = cleanStepText(r);
    if (s === '') return;
    const aid = idAt.get(i);
    const sid = typeof rawIds?.[i] === 'string' ? (rawIds[i] as string) : '';
    if ((aid !== undefined && aid !== '' && dropped.has(aid)) || (sid !== '' && dropped.has(sid))) return;
    if (aid !== undefined && aid !== '' && !authoredAt.has(aid)) authoredAt.set(aid, steps.length);
    else if (aid !== undefined) anonymous.push(steps.length);
    if (rawEdited.has(i)) edited.add(steps.length);
    ids.push(sid !== '' ? sid : (aid ?? ''));
    steps.push(s);
  });
  return { steps, ids, authoredAt, anonymous, edited, hasIds: rawIds !== null };
}

/**
 * The author's lines the draft holds, each with its step's index: by the id
 * of the step the line stands for (`record:draft.ids`, or `authoredIds` from a
 * server that sends no ids) — or, for a step the draft names no id for, by the
 * text the line was sent as, in order. A reworded recorded line is held by
 * its step's id, while it is being edited too: the recording stops writing
 * that line at the first keystroke. `bySentText` (the result at Stop): a line
 * sent that neither names is the first step not the author's with its text. A
 * line whose step is dropped is held by nothing.
 */
function heldLines(
  slots: RecordSlot[],
  d: DraftSteps,
  isDropped: (slot: RecordSlot) => boolean,
  bySentText = false,
): Map<RecordSlot, number> {
  const held = new Map<RecordSlot, number>();
  const taken = new Set<number>();
  const idAt = new Map<string, number>();
  d.ids.forEach((id, i) => {
    if (id !== '' && !idAt.has(id)) idAt.set(id, i);
  });
  const mines = slots.filter(
    (s) => s.kind === 'mine' && !isDropped(s) && (s.origin === 'edit' || s.status === 'sent'),
  );
  for (const s of mines) {
    if (!s.stepId) continue;
    const idx = idAt.get(s.stepId) ?? (s.origin === 'edit' ? undefined : d.authoredAt.get(s.stepId));
    if (idx === undefined || taken.has(idx)) continue;
    held.set(s, idx);
    taken.add(idx);
  }
  const typed = mines.filter((s) => s.origin !== 'edit');
  for (const s of typed) {
    if (held.has(s)) continue;
    const idx = d.anonymous.find((i) => !taken.has(i) && d.steps[i] === s.sentText);
    if (idx === undefined) continue;
    held.set(s, idx);
    taken.add(idx);
  }
  if (bySentText) {
    const theirs = new Set([...d.authoredAt.values(), ...d.anonymous]);
    for (const s of typed) {
      if (held.has(s)) continue;
      const idx = d.steps.findIndex((t, i) => t === s.sentText && !taken.has(i) && !theirs.has(i));
      if (idx < 0) continue;
      held.set(s, idx);
      taken.add(idx);
    }
  }
  return held;
}

/**
 * What a write does to each line of the author's whose step is dropped or
 * restored (`dropped`: `LiveDraft.droppedIds`):
 *
 *  - `hide` — dropped since the last write, and the line reads exactly as the
 *    recording last left it (`recAs`): taken out of the file;
 *  - `left` — dropped, but the author has changed the line since: it stays,
 *    and the caller says so once;
 *  - `reveal` — taken out, and now restored, or the recording's clear-out
 *    (`clearing`: Cancel puts every line of the author's back); or a line the
 *    clear-out took out, now any other draft comes: put back where it was;
 *  - `keep-hidden` — a line the clear-out took out, whose step is dropped
 *    now: it stays out, as a dropped step's line;
 *  - `undrop` — left in the file when dropped, and now restored or the
 *    clear-out: an ordinary line of the author's again.
 *
 * A reworded (or emptied) line under the clear-out is the write's own
 * business: out (`goesWithSteps`).
 */
function dropActions(
  slots: RecordSlot[],
  dropped: ReadonlySet<string>,
  clearing: boolean,
): Map<RecordSlot, 'hide' | 'left' | 'reveal' | 'undrop' | 'keep-hidden'> {
  const out = new Map<RecordSlot, 'hide' | 'left' | 'reveal' | 'undrop' | 'keep-hidden'>();
  for (const s of slots) {
    if (s.kind !== 'mine') continue;
    // The recording's clear-out puts every line of the author's back; a draft
    // of the server's with no steps is still a draft, its drops and all.
    const isDropped = !clearing && hasStep(s) && s.stepId !== undefined && dropped.has(s.stepId);
    if (s.cleared === true) {
      if (clearing) continue;
      out.set(s, isDropped && s.dropped !== 'left' ? 'keep-hidden' : 'reveal');
      continue;
    }
    if (clearing && goesWithSteps(s)) continue;
    if (isDropped && s.dropped === undefined) {
      out.set(s, s.recAs !== undefined && s.wrote === s.recAs && s.wrote !== '' ? 'hide' : 'left');
    } else if (!isDropped && s.dropped !== undefined) {
      out.set(s, s.dropped === 'hidden' ? 'reveal' : 'undrop');
    }
  }
  return out;
}

/**
 * Name each line of the author's that went to the server with no id yet by
 * the draft step that is it:
 *
 *  - a typed line: an id of the draft's author steps not known to be the
 *    toolbar's or the panel's, whose text is that line's as it was sent. A
 *    draft can arrive before the `record:step` that names the id, and a line
 *    taken for none of the draft's steps would be written a second time as
 *    the recording's.
 *  - a reworded line whose step is not in the draft any more: the step the
 *    draft shows as the author's rewording with the words the line went as —
 *    the model rewrote the step while the author was editing it, and the
 *    server put the edit on the step that stands for its actions now. Without
 *    it, that step would be written beside the line, the author's words twice.
 *
 * And a line whose `edit-step` the draft shows taken — its step reworded with
 * the words it went as — is no longer waiting for the server.
 */
function adoptStepIds(record: LiveRecord, d: DraftSteps, foreign: string[]): LiveRecord {
  const named = new Set(record.slots.flatMap((s) => (s.kind === 'mine' && s.stepId ? [s.stepId] : [])));
  let slots = record.slots;
  const set = (k: number, patch: Partial<RecordSlot>): void => {
    slots = slots.map((s, i) => (i === k ? { ...s, ...patch } : s));
  };
  for (const [id, idx] of d.authoredAt) {
    if (named.has(id) || foreign.includes(id)) continue;
    const text = d.steps[idx];
    const k = slots.findIndex((s) => s.kind === 'mine' && s.origin !== 'edit' && s.status === 'sent' && !s.stepId && s.sentText === text);
    if (k < 0) continue;
    set(k, { stepId: id });
    named.add(id);
  }
  const inDraft = new Set(d.ids.filter((id) => id !== ''));
  for (const i of d.edited) {
    const id = d.ids[i];
    if (!id || named.has(id)) continue;
    const k = slots.findIndex(
      (s) =>
        s.kind === 'mine' &&
        hasStep(s) &&
        s.sentText === d.steps[i] &&
        s.stepId !== undefined &&
        !inDraft.has(s.stepId),
    );
    if (k < 0) continue;
    set(k, { stepId: id, unacked: false });
    named.add(id);
  }
  slots.forEach((s, k) => {
    if (s.kind !== 'mine' || s.unacked !== true || !s.stepId) return;
    const idx = d.ids.indexOf(s.stepId);
    if (idx >= 0 && d.edited.has(idx) && d.steps[idx] === s.sentText) set(k, { unacked: false });
  });
  return slots === record.slots ? record : { ...record, slots };
}

/**
 * The draft laid out around the author's lines: the text of every block part
 * of the run (block, mine, block, …, block), the step id each of its lines
 * holds (`ids`: one per step of the draft), and which of the author's lines
 * the draft holds, each with the number its step takes. Null only when the
 * run is not block, mine, block, …, block.
 *
 * A line whose step the draft holds (`heldAt`) is that step: the steps before
 * it go above it, the ones after below, and it is not written. A line the
 * draft does not hold divides the draft by count: as many steps above it as
 * the file has above it now (the draft the author saw) — or, at the end of the
 * run with none of the recording's lines below it, all of them, as a line
 * typed below the block always had.
 *
 * When the draft holds the author's lines in an order the file does not have
 * them in — the server put two lines aimed at one point the other way round —
 * the draft's order cannot be followed without writing a line of the
 * author's a second time, so the lines are laid out by count instead
 * (`layoutByCount`).
 */
function layoutRun(
  slots: RecordSlot[],
  parts: RecordInsertionPlan['parts'],
  ids: string[],
  heldAt: (slot: RecordSlot) => number | undefined,
  placed: (slot: RecordSlot) => boolean,
): { blocks: Map<RecordSlot, string>; ids: Map<RecordSlot, Array<string | null>>; joined: Map<RecordSlot, string> } | null {
  const run = slots.filter(isRun);
  const mines = run.flatMap((s, i) => (s.kind === 'mine' ? [i] : []));
  // block, mine, block, …, block — what `settleRun` leaves.
  if (run.length !== 2 * mines.length + 1 || run.some((s, i) => (i % 2 === 0) !== (s.kind === 'block'))) return null;
  const held = mines.map((i) => heldAt(run[i]!));
  // A line the author moved is where they put it, not where the draft has
  // its step: laid out by count, around what the file has above it. So is a
  // line that took in the line the steps go after: nothing goes above it.
  if (mines.some((i, j) => (held[j] !== undefined && run[i]!.moved !== undefined) || run[i]!.joined === 'above')) {
    return layoutByCount(run, mines, held, parts, ids, placed);
  }
  return layoutByDraft(run, mines, held, parts, ids, placed) ?? layoutByCount(run, mines, held, parts, ids, placed);
}

/** A block part's lines, and the step each holds: `steps` are indices into
 *  the draft; `blankBefore` / `blankAfter` its spacing lines. */
function blockPart(
  block: RecordSlot,
  lines: string[],
  steps: number[],
  ids: string[],
  parts: RecordInsertionPlan['parts'],
  first: boolean,
  last: boolean,
): { text: string; ids: Array<string | null> } {
  const before = first && parts.blankBefore;
  const after = last && parts.blankAfter;
  return {
    text: linesText([...(before ? [''] : []), ...lines, ...(after ? [''] : [])], block.lineEnd, parts.eol),
    ids: [...(before ? [null] : []), ...steps.map((k) => ids[k] || null), ...(after ? [null] : [])],
  };
}

/** `layoutRun` in the draft's order, or null when the draft holds the
 *  author's lines in an order the file does not have them in. */
function layoutByDraft(
  run: RecordSlot[],
  mines: number[],
  held: Array<number | undefined>,
  parts: RecordInsertionPlan['parts'],
  ids: string[],
  placed: (slot: RecordSlot) => boolean,
): { blocks: Map<RecordSlot, string>; ids: Map<RecordSlot, Array<string | null>>; joined: Map<RecordSlot, string> } | null {
  const n = parts.lines.length;
  const cuts: Array<{ cut: number; consumes: boolean }> = [];
  /** The author's lines the draft holds, each with the number its step takes. */
  const joined = new Map<RecordSlot, string>();
  let floor = 0;
  for (let j = 0; j < mines.length; j++) {
    const i = mines[j]!;
    const mine = run[i]!;
    const idx = held[j];
    if (idx !== undefined) {
      if (idx < floor) return null;
      cuts.push({ cut: idx, consumes: true });
      joined.set(mine, LEADING_ORDINAL_RE.exec(parts.lines[idx] ?? '')?.[1] ?? String(idx + 1));
      floor = idx + 1;
      continue;
    }
    let cut: number;
    // A reworded line the draft does not hold (the model rewrote its step
    // meanwhile) is where its step was, not below everything.
    if (mine.origin !== 'edit' && atRunEnd(run, i, placed)) {
      cut = n;
    } else {
      let upper = n;
      for (let k = j + 1; k < mines.length; k++) {
        const below = held[k];
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
  const blockIds = new Map<RecordSlot, Array<string | null>>();
  let from = 0;
  for (let j = 0; j <= mines.length; j++) {
    const block = run[2 * j]!;
    const to = Math.max(from, j < mines.length ? cuts[j]!.cut : n);
    const range = Array.from({ length: to - from }, (_, k) => from + k);
    const part = blockPart(block, range.map((k) => parts.lines[k]!), range, ids, parts, j === 0, j === mines.length);
    blocks.set(block, part.text);
    blockIds.set(block, part.ids);
    if (j < mines.length) from = cuts[j]!.cut + (cuts[j]!.consumes ? 1 : 0);
  }
  return { blocks, ids: blockIds, joined };
}

/**
 * `layoutRun` by count, for a draft whose order of the author's lines the file
 * does not have. Every line of the author's the draft holds is its step, so
 * none of those steps is written; the draft's other steps are divided around
 * the author's lines by count — above a held line, as many as the draft has
 * before its step; above one it does not hold, as many as the file has above
 * it now (all of them at the end of the run) — never fewer than above the line
 * before it. The steps are then numbered in the order the file has them: the
 * recording's lines and the held lines of the author's alike, from the number
 * the draft's first step has (or all `1.` in a flow written that way).
 */
function layoutByCount(
  run: RecordSlot[],
  mines: number[],
  held: Array<number | undefined>,
  parts: RecordInsertionPlan['parts'],
  ids: string[],
  placed: (slot: RecordSlot) => boolean,
): { blocks: Map<RecordSlot, string>; ids: Map<RecordSlot, Array<string | null>>; joined: Map<RecordSlot, string> } {
  const n = parts.lines.length;
  const consumed = new Set(held.filter((h): h is number => h !== undefined));
  /** The draft's steps that are not the author's lines, by index. */
  const rest: number[] = [];
  for (let k = 0; k < n; k++) if (!consumed.has(k)) rest.push(k);
  const ordinal = (k: number): string => LEADING_ORDINAL_RE.exec(parts.lines[k] ?? '')?.[1] ?? '';
  // The planned lines are `${number}. ${step}` (`planRecordInsertion`).
  const stepOf = (k: number): string => (parts.lines[k] ?? '').slice(ordinal(k).length + 2);
  const ones = n >= 2 && parts.lines.every((_, k) => ordinal(k) === '1');
  let next = Number(ordinal(0)) || 1;
  const label = (): string => (ones ? '1' : String(next++));
  const cuts: number[] = [];
  let floor = 0;
  mines.forEach((i, j) => {
    const h = held[j];
    let want: number;
    if (run[i]!.joined === 'above') {
      // It holds the line the steps go after: the run starts with it.
      want = 0;
    } else if (h !== undefined && run[i]!.moved !== undefined) {
      // Moved there by the author: as many of the recording's steps above it
      // as the file has.
      want = 0;
      for (let k = 0; k < i; k++) if (run[k]!.kind === 'block') want += blockSteps(run[k]!);
    } else if (h !== undefined) {
      want = rest.filter((k) => k < h).length;
    } else if (run[i]!.origin !== 'edit' && atRunEnd(run, i, placed)) {
      want = rest.length;
    } else {
      want = 0;
      for (let k = 0; k < i; k++) if (run[k]!.kind === 'block') want += blockSteps(run[k]!);
    }
    const cut = Math.min(Math.max(want, floor), rest.length);
    cuts.push(cut);
    floor = cut;
  });
  const blocks = new Map<RecordSlot, string>();
  const blockIds = new Map<RecordSlot, Array<string | null>>();
  const joined = new Map<RecordSlot, string>();
  let from = 0;
  for (let j = 0; j <= mines.length; j++) {
    const block = run[2 * j]!;
    const to = j < mines.length ? cuts[j]! : rest.length;
    const range = rest.slice(from, Math.max(from, to));
    const part = blockPart(block, range.map((k) => `${label()}. ${stepOf(k)}`), range, ids, parts, j === 0, j === mines.length);
    blocks.set(block, part.text);
    blockIds.set(block, part.ids);
    if (j < mines.length) {
      if (held[j] !== undefined) joined.set(run[mines[j]!]!, label());
      from = Math.max(from, to);
    }
  }
  return { blocks, ids: blockIds, joined };
}

/**
 * A line of the author's, numbered as the recording numbers its steps while
 * the draft holds its step (`want`: that step's number), or given back the
 * number it had when the draft no longer does (`want` null — the empty draft
 * too). Only the leading number is ever touched: the digits of an `N.` line,
 * else the list marker (or nothing) in front of the text, replaced by `N. `.
 * A number the author changed after the recording set it is theirs from then
 * on (`'author'`) — the recording's number is kept as state from the first
 * write that holds the step, even when the author's number already was that
 * one, so a later edit of it is seen — and a number the recording never
 * changed is not given anything back. A line with nothing on it but a number
 * is not given one.
 *
 * A reworded recorded line (`origin` `edit`) is the recording's to number
 * throughout — "numbers stay the recording's" — so a number the author changes
 * on it is written over, and nothing is given back when the draft does not
 * hold it.
 */
function numberAuthorLine(
  slot: RecordSlot,
  want: string | null,
): { wrote: string; number?: RecordSlot['number']; edit?: OffsetEdit } {
  const lead = lineBreakLead(slot);
  const reworded = slot.origin === 'edit';
  let state = slot.number;
  if (reworded && want === null) return { wrote: slot.wrote, ...(state !== undefined && { number: state }) };
  if (reworded && state === 'author') state = undefined;
  if (state === 'author') return { wrote: slot.wrote, number: 'author' };
  const cur = authorLinePrefix(slot.wrote.slice(lead));
  const intact =
    state === undefined ||
    (state.mode === 'digits'
      ? cur?.mode === 'digits' && cur.text === state.wrote
      : slot.wrote.slice(lead + (cur?.indent ?? 0)).startsWith(state.wrote));
  if (!intact) {
    if (!reworded) return { wrote: slot.wrote, number: 'author' };
    state = undefined;
  }
  // The number sits after the line's indentation, which is the author's.
  const from = lead + (cur?.indent ?? 0);
  const line = slot.wrote.slice(from);
  const at = slot.start + from;
  const replace = (was: string, to: string): { wrote: string; edit?: OffsetEdit } =>
    was === to
      ? { wrote: slot.wrote }
      : {
          wrote: slot.wrote.slice(0, from) + to + line.slice(was.length),
          edit: { start: at, end: at + was.length, text: to, kind: 'mine', why: 'number' },
        };
  if (want === null) {
    if (state === undefined) return { wrote: slot.wrote };
    return replace(state.wrote, state.author);
  }
  // An indented line with no number of its own is left as it is, and so is a
  // line with no step on it (the author emptied it).
  if (!state && !cur) return { wrote: slot.wrote };
  if (cleanAuthorLine(unitLine(slot.wrote)) === '') return { wrote: slot.wrote, ...(state && { number: state }) };
  const mode = state ? state.mode : cur!.mode;
  const now = state ? state.wrote : cur!.text;
  const target = mode === 'digits' ? want : `${want}. `;
  const number = { mode, author: state ? state.author : cur!.text, wrote: target };
  return { ...replace(now, target), number };
}

/**
 * The sentence for a line of the author's that stayed in the file when its
 * step was dropped, because they had edited it (stories/steptix-record-toolbar.md
 * §"Undo and locked steps"): the step named by the number the line carries,
 * else by the line it is on in the file (`fileLine`, 0-based; -1 or absent
 * when not known). Never by its words: a line the server refused may hold a
 * secret (SPEC-record-steps §7.6).
 */
export function leftInFileText(line: string, fileLine = -1): string {
  const prefix = authorLinePrefix(line);
  const name =
    prefix?.mode === 'digits' ? `Your step ${prefix.text}` : fileLine >= 0 ? `Your step on line ${fileLine + 1}` : 'A step of yours';
  return `${name} was left in the file because you edited it — delete it if you meant to.`;
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

/** The steps a block part holds — or, emptied by the recording's clear-out
 *  since the last draft, held until then (`RecordSlot.clearedSteps`). */
const blockSteps = (s: RecordSlot): number => (s.wrote === '' && s.clearedSteps !== undefined ? s.clearedSteps : stepCount(s.wrote));

/**
 * How many of the draft last written are above the run's part `i`: the steps
 * of the block parts above, and the author's lines above whose step that
 * draft held — as they were before the recording's clear-out, when it ran
 * since (Stop: the drafts out, then the result).
 */
function stepsAbove(run: RecordSlot[], i: number): number {
  let n = 0;
  for (let k = 0; k < i; k++) {
    const s = run[k]!;
    n += s.kind === 'block' ? blockSteps(s) : s.inDraft || s.clearedHeld ? 1 : 0;
  }
  return n;
}

/**
 * The run's part `i` is at its end: none of the recording's steps below it,
 * and none of the author's lines below it that a draft holds or that went to
 * the server aimed at a step (and were not dropped since). A line typed there
 * is "below the block": every step goes above it until the server places it.
 * A line below it that went with no `afterStep` is below the block too — the
 * server puts it after everything drafted until then — so it does not count
 * until a draft holds it. `placed` says of a line of the author's whether it
 * counts: by default as of the draft last written (`placedLine`); a write
 * laying out a new draft asks with what that draft holds.
 */
function atRunEnd(run: RecordSlot[], i: number, placed: (s: RecordSlot) => boolean = placedLine): boolean {
  for (let k = i + 1; k < run.length; k++) {
    const s = run[k]!;
    if (s.kind === 'block' ? blockSteps(s) > 0 : placed(s)) return false;
  }
  return true;
}

/** A line of the author's that has a place among the recording's steps, as
 *  of the draft last written: one it holds, or one sent aimed at a step — or
 *  a recorded line they reworded, which is where its step was. */
function placedLine(s: RecordSlot): boolean {
  if (s.dropped !== undefined || s.cleared === true) return false;
  if (s.origin === 'edit') return true;
  return s.status === 'sent' && (s.inDraft === true || s.sentAtEnd !== true);
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
  // The lines both have — by their words, a number or marker in front aside —
  // matched in order (a longest common subsequence), so a line that stays is
  // never rewritten because lines went in or out around it, and one whose
  // number alone differs has only its number replaced.
  const key = (u: string): string => `${lineBreakOf(u)}\u0000${stepWords(u)}`;
  const ka = a.map(key);
  const kb = b.map(key);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = ka[i] === kb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: OffsetEdit[] = [];
  let at = slot.start;
  let i = 0;
  let j = 0;
  /** Lines of `a` from `from` replaced by `b`'s lines from `fromB`: one edit. */
  const hunk = (from: number, fromB: number): void => {
    const was = a.slice(from, i).join('');
    const text = b.slice(fromB, j).join('');
    if (was === text) return;
    out.push({ start: at, end: at + was.length, text, kind: 'block' });
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && ka[i] === kb[j]) {
      const x = a[i]!;
      const y = b[j]!;
      if (x !== y) out.push(...prefixEdits(slot, at, x, y));
      at += x.length;
      i++;
      j++;
      continue;
    }
    const from = i;
    const fromB = j;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && ka[i] === kb[j]) break;
      if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) i++;
      else j++;
    }
    hunk(from, fromB);
    at += a.slice(from, i).join('').length;
  }
  return out;
}

/** A line's own break, as its unit carries it (in front of it, or after). */
function lineBreakOf(unit: string): string {
  return /^\r?\n/.exec(unit)?.[0] ?? /\r?\n$/.exec(unit)?.[0] ?? '';
}

/**
 * Two lines with the same words and a different number or marker in front:
 * only that is replaced — the digits alone when both are `N.` lines.
 */
function prefixEdits(slot: RecordSlot, at: number, x: string, y: string): OffsetEdit[] {
  const lead = slot.lineEnd ? lineBreakOf(x).length : 0;
  const lx = unitLine(x);
  const ly = unitLine(y);
  const px = lx.slice(0, stepTextStart(lx));
  const py = ly.slice(0, stepTextStart(ly));
  const dx = /^(\d+)\.[ \t]/.exec(px);
  const dy = /^(\d+)\.[ \t]/.exec(py);
  if (dx && dy && px.slice(dx[1]!.length) === py.slice(dy[1]!.length)) {
    return [{ start: at + lead, end: at + lead + dx[1]!.length, text: dy[1]!, kind: 'block' }];
  }
  if (lx.slice(px.length) !== ly.slice(py.length)) return [{ start: at, end: at + x.length, text: y, kind: 'block' }];
  return [{ start: at + lead, end: at + lead + px.length, text: py, kind: 'block' }];
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
 * the recording numbers its steps itself (stories/steptix-record-toolbar.md
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
 *
 * `editable` (the drafts carry step ids — stories/steptix-record-edit-steps.md):
 * the author edits and deletes the recorded lines as they please, so an edit
 * over a block part's whole text is inside it too (every step of it reworded
 * or deleted), and whole lines deleted across several parts of the run — lines
 * of the recording's and of the author's together — are followed: each part
 * loses the lines of it that went. `text`, the document after the event, is
 * needed for that (one change only: it is the text that change left).
 */
export function trackRecordSlots(
  slots: RecordSlot[],
  changes: OffsetChange[],
  opts: { editable?: boolean; text?: string } = {},
): { slots: RecordSlot[]; touched: boolean; uncertain: boolean } {
  const out = slots.map((s) => ({ ...s }));
  let touched = false;
  let uncertain = false;
  // Bottom-up, so each change's offsets are still those it was reported in.
  const ordered = [...changes].sort((a, b) => b.offset - a.offset);
  for (const c of ordered) {
    const delta = c.text.length - c.length;
    if (opts.editable && ordered.length === 1 && opts.text !== undefined && deletesWholeLinesAcross(out, c, opts.text)) {
      const cEnd = c.offset + c.length;
      for (const slot of out) {
        if (slot.kind === 'tail') {
          trackTail(slot, c, delta);
          continue;
        }
        if (!isRun(slot)) {
          const relation = regionRelation(slot, c, true);
          if (relation === 'before') {
            slot.start += delta;
            slot.end += delta;
          } else if (relation !== 'after') {
            uncertain = true;
          }
          continue;
        }
        if (slot.end <= c.offset && slot.start < c.offset) continue;
        if (slot.start >= cEnd) {
          slot.start += delta;
          slot.end += delta;
          continue;
        }
        const removed = Math.max(0, Math.min(slot.end, cEnd) - Math.max(slot.start, c.offset));
        const start = Math.min(slot.start, c.offset);
        slot.end = start + (slot.end - slot.start - removed);
        slot.start = start;
        if (slot.kind === 'block' && removed > 0) slot.touched = true;
      }
      continue;
    }
    // The run's last part with text in it: a line opened under it (End,
    // Enter) is the author's new line below the block — one of theirs from
    // here on (stories/steptix-record-toolbar.md §"Steps typed in the
    // editor"), which the recording writes around rather than below.
    const last = [...out].reverse().find((s) => isRun(s) && s.end > s.start);
    let opened: RecordSlot | null = null;
    for (const slot of out) {
      if (slot.kind === 'tail') {
        trackTail(slot, c, delta);
        continue;
      }
      const relation = regionRelation(slot, c, opts.editable === true);
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

function regionRelation(slot: RecordSlot, c: OffsetChange, editable = false): 'before' | 'after' | 'inside' | 'across' {
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
    // Recorded lines whose steps the author may reword and delete: all of
    // them at once is every step reworded, or deleted (`settleRun` tells).
    if (editable && slot.kind === 'block' && slot.ids !== undefined && c.offset >= s && cEnd <= e) return 'inside';
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

/** The offsets inside a slot's text where one of its lines starts or ends. */
function unitBounds(text: string, lineEnd: boolean): Set<number> {
  const out = new Set<number>([0]);
  let at = 0;
  for (const unit of unitsOf(text, lineEnd)) {
    at += unit.length;
    out.add(at);
  }
  return out;
}

/**
 * `c` deletes whole lines from two or more parts of the run at once — a line
 * of the recording's with the author's line under it, say — and leaves the
 * lines around it whole: each part it reaches loses whole lines of its own,
 * and what is left joins at a line's start (or, the run hanging off the end of
 * the file's last line, at a line's end). `after` is the document the change
 * left. A block part with no step ids is not followed this way.
 */
function deletesWholeLinesAcross(slots: RecordSlot[], c: OffsetChange, after: string): boolean {
  if (c.text !== '' || c.length === 0) return false;
  const cEnd = c.offset + c.length;
  const hit = slots.filter((s) => isRun(s) && s.end > s.start && s.start < cEnd && c.offset < s.end);
  if (hit.length < 2) return false;
  for (const s of hit) {
    if (s.kind === 'block' && s.ids === undefined) return false;
    const bounds = unitBounds(s.wrote, s.lineEnd);
    if (!bounds.has(Math.max(s.start, c.offset) - s.start) || !bounds.has(Math.min(s.end, cEnd) - s.start)) return false;
  }
  return hit[0]!.lineEnd ? atLineEnd(after, c.offset) : atLineStart(after, c.offset);
}

/**
 * `c` lies within the text of one line of the run — a line of the author's,
 * or (`recorded`) a recorded line of a block part whose step ids are known —
 * not its line break, nothing of the lines around it, and puts no line break
 * in. An undo or redo like that, which no earlier state of the file explains,
 * is of the author's typing on the line.
 */
function insideOneLine(slots: RecordSlot[], c: OffsetChange, recorded = false): boolean {
  if (/[\r\n]/.test(c.text)) return false;
  const within = (lineStart: number, unit: string, lineEnd: boolean): boolean => {
    const lead = lineEnd ? (unit.startsWith('\r\n') ? 2 : unit.startsWith('\n') ? 1 : 0) : 0;
    const from = lineStart + lead;
    const to = from + unitLine(unit).length;
    return c.offset >= from && c.offset + c.length <= to;
  };
  return slots.some((s) => {
    if (s.end <= s.start) return false;
    if (s.kind === 'mine') return within(s.start, s.wrote, s.lineEnd);
    if (s.kind !== 'block' || !recorded || s.ids === undefined) return false;
    let at = s.start;
    for (const unit of unitsOf(s.wrote, s.lineEnd)) {
      if (within(at, unit, s.lineEnd)) return true;
      at += unit.length;
    }
    return false;
  });
}

/**
 * The run's parts as the kinds of line they hold: each block part's step ids
 * (and its text), each line of the author's by its name — what changes when
 * the author rewords, deletes or adds a line, so that the file as it stood
 * just before is kept for an undo to find (`followLiveRecord`).
 */
function runShape(record: LiveRecord): string {
  return record.slots
    .filter(isRun)
    .map((s) => (s.kind === 'mine' ? `m:${s.key}:${s.wrote === '' ? 0 : 1}:${s.origin ?? ''}` : `b:${JSON.stringify(s.ids ?? null)}:${s.wrote}`))
    .join('|');
}

/**
 * A line of the author's is gone from the file — deleted whole, or taken out
 * by an undo: its step, when it stands for one, is deleted too
 * (stories/steptix-record-edit-steps.md §"In the file": "deleting whole lines
 * is a delete as soon as the lines are gone"). A typed line that went to the
 * server before its step had an id waits for `record:step` to name it.
 */
function lineGone(book: LineBook, slot: RecordSlot): void {
  if (slot.kind !== 'mine' || slot.dropped !== undefined || slot.cleared === true) return;
  if (slot.stepId !== undefined && hasStep(slot)) {
    stepGone(book, slot.stepId, cleanAuthorLine(mineLineText(slot)), slot.origin !== 'edit');
  } else if (slot.origin !== 'edit' && slot.status === 'sent' && slot.sentText !== undefined) {
    book.unnamed.push(slot.sentText);
  }
}

/** A step's line was deleted from the file: `drop` it, once. `words`: what
 *  the line said, for a line with them back to restore it by; `typed`: the
 *  line was one the author typed (a restored one is theirs again). */
function stepGone(book: LineBook, id: string, words?: string, typed = false): void {
  if (words !== undefined && words !== '') book.deletedWords.set(id, { words, typed });
  if (book.deleted.has(id)) return;
  book.deleted.add(id);
  // A restore of it still waiting to go is moot.
  const waiting = book.queue.findIndex((q) => q.action === 'restore' && q.id === id);
  if (waiting >= 0) book.queue.splice(waiting, 1);
  else book.queue.push({ action: 'drop', id });
}

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
 *
 * A state found by its text may be one from before the author deleted a line
 * of a step, or before a line of theirs was there (an undo): `book` hears what
 * that does to the steps (`reconcileLines`) — a deleted line back is its step
 * restored, a line of theirs gone is its step deleted.
 */
export function locateLiveRecord(
  live: LiveRecord,
  current: string,
  anchor?: RecordAnchor | null,
  book: LineBook = newLineBook(),
): LiveRecordLocation {
  const record = withEol(live, current);
  let m: LineModel | null = null;
  const model = (): LineModel => (m ??= modelOf(current));
  if (!record.uncertain) {
    // The author's lines inside the block, as the offsets followed them.
    const settled = settleRun(record, current, book);
    const inPlace = settled && verifyInPlace(settled.record, current, model);
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
  // Where steps go now, after the anchor — for a state whose run is empty.
  const emptyPoint = (): { at: number; lineEnd: boolean } | null => {
    const placed = placeRecording(current, found);
    if ('error' in placed || placed.fellBack) return null;
    const p = blockPoint(placed);
    return { at: (lineStarts(current)[p.line] ?? current.length) + p.char, lineEnd: p.lineEnd };
  };
  // Newest first: the last write, then each earlier one an undo may have
  // brought back — each with the base it was planned against. Lines the
  // author edited inside since the last write hold text that is neither
  // theirs nor the recording's: only that write, exactly as written (an undo
  // of the edit), is taken; an earlier one could match part of it.
  const touched = record.slots.some((s) => s.touched);
  const states = touched ? [stateOf(record)] : [stateOf(record), ...[...record.history].reverse()];
  /** The run's extent in the file, as a state was found. */
  const extent = (slots: RecordSlot[]): { start: number; end: number } => {
    const run = slots.filter(isRun);
    return { start: Math.min(...run.map((s) => s.start)), end: Math.max(...run.map((s) => s.end)) };
  };
  let best: { state: LiveState; slots: RecordSlot[] } | null = null;
  for (const state of states) {
    const slots = findWritten(current, model, state.slots, state.section, anchorIdx, paramsPoint(state.base), emptyPoint);
    if (!slots || !nothingLeft(record, current, slots)) continue;
    if (!best) {
      best = { state, slots };
      continue;
    }
    // An earlier state that is the same run with more of it in the file — a
    // line of it the author deleted at its edge, and Ctrl+Z put back — says
    // more of the file than the newest one that matched: it is the one.
    const a = extent(best.slots);
    const b = extent(slots);
    if (b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start) best = { state, slots };
  }
  if (best) {
    // What became of the author's lines since (sent, their ids) is not
    // undone with the text: a line sent once is never sent again.
    const found: LiveRecord = {
      ...best.state,
      slots: best.slots,
      uncertain: false,
      history: record.history,
      ...(record.editable !== undefined && { editable: record.editable }),
      ...(record.outside !== undefined && { outside: record.outside }),
    };
    return { status: 'found', record: reconcileLines(record, carryAuthorState(record, found), book), moved: true };
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
    // The line as the recording left it, when it was sent: known only to the
    // record that sent it.
    const recAs = s.recAs ?? k?.recAs;
    const same =
      k !== undefined &&
      k.status === s.status &&
      k.stepId === s.stepId &&
      k.sentText === s.sentText &&
      k.sentAtEnd === s.sentAtEnd &&
      k.origin === s.origin &&
      k.editOf === s.editOf &&
      k.unacked === s.unacked &&
      k.follow === s.follow &&
      k.emptied === s.emptied &&
      k.commitNow === s.commitNow &&
      k.resend === s.resend &&
      // Moved (a write may have seen it held since: `to`'s is the newer).
      (k.moved === undefined || s.moved !== undefined) &&
      JSON.stringify(k.emptiedOf) === JSON.stringify(s.emptiedOf) &&
      recAs === s.recAs;
    if (!k || same) return s;
    changed = true;
    const next: RecordSlot = {
      ...s,
      status: k.status,
      ...(k.stepId !== undefined && { stepId: k.stepId }),
      ...(k.sentText !== undefined && { sentText: k.sentText }),
      ...(k.sentAtEnd !== undefined && { sentAtEnd: k.sentAtEnd }),
      ...(k.origin !== undefined && { origin: k.origin }),
      ...(k.editOf !== undefined && { editOf: k.editOf }),
      ...(recAs !== undefined && { recAs }),
      ...(k.moved !== undefined && s.moved === undefined && { moved: k.moved }),
    };
    if (k.unacked !== undefined) next.unacked = k.unacked;
    else delete next.unacked;
    if (k.commitNow === true) next.commitNow = true;
    else delete next.commitNow;
    if (k.resend === true) next.resend = true;
    else delete next.resend;
    if (k.follow !== undefined) next.follow = k.follow;
    else delete next.follow;
    if (k.emptied === true) next.emptied = true;
    else delete next.emptied;
    if (k.emptiedOf !== undefined) next.emptiedOf = k.emptiedOf;
    else delete next.emptiedOf;
    // Emptied since (its step deleted): no longer the step's line, whatever
    // the state it is carried into says.
    if (k.emptiedOf !== undefined && k.stepId === undefined) {
      delete next.origin;
      delete next.stepId;
      delete next.editOf;
      delete next.sentText;
      delete next.recAs;
      delete next.unacked;
      delete next.follow;
      next.status = k.status ?? 'typing';
    }
    return next;
  });
  return changed ? { ...to, slots } : to;
}

/**
 * The state an undo brought back (`found`), measured against the record as it
 * was (`prev`), for what it means to the steps (stories/steptix-record-edit-steps.md
 * §"In the file"):
 *
 *  - a line of a step the author deleted is back: Ctrl+Z of the deletion is a
 *    Restore — `restore` it (or, the `drop` not sent yet, send neither);
 *  - a line of the author's that stood for a step is gone: the undo took out
 *    their typing, which deletes its step as deleting the line would;
 *  - a line they reworded, whose rewording went to the server, is back as the
 *    recording wrote it (the undo went back past their edit): the line is
 *    theirs again, being edited — its words now go to the server when they
 *    leave it, as an edit back, rather than the next draft writing the
 *    rewording over the undo.
 */
function reconcileLines(prev: LiveRecord, found: LiveRecord, book: LineBook): LiveRecord {
  if (found.editable !== true) return found;
  const present = new Set<string>();
  for (const s of found.slots) {
    if (s.kind === 'block') for (const id of s.ids ?? []) if (id) present.add(id);
    if (s.kind === 'mine' && s.stepId !== undefined && s.wrote !== '' && hasStep(s)) present.add(s.stepId);
  }
  for (const id of [...book.deleted]) {
    if (!present.has(id)) continue;
    book.deleted.delete(id);
    const waiting = book.queue.findIndex((q) => q.action === 'drop' && q.id === id);
    if (waiting >= 0) book.queue.splice(waiting, 1);
    else book.queue.push({ action: 'restore', id });
  }
  // A typed line back before its step had a name: not to be dropped when
  // `record:step` names it.
  for (const s of found.slots) {
    if (s.kind !== 'mine' || s.origin === 'edit' || s.status !== 'sent' || s.stepId || s.wrote === '') continue;
    const k = s.sentText === undefined ? -1 : book.unnamed.indexOf(s.sentText);
    if (k >= 0) book.unnamed.splice(k, 1);
  }
  const keys = new Set(found.slots.flatMap((s) => (s.kind === 'mine' && s.key ? [s.key] : [])));
  /** Reworded lines whose rewording went to the server, now the recording's
   *  line again — by the name the line had, when it had one. */
  const back = new Map<string, string | undefined>();
  for (const s of prev.slots) {
    if (s.kind !== 'mine' || !s.key || keys.has(s.key) || s.wrote === '') continue;
    if (s.origin === 'edit' && s.stepId !== undefined && present.has(s.stepId)) {
      back.set(s.stepId, s.key);
      continue;
    }
    lineGone(book, s);
  }
  // A recorded line whose words are not what the file told the server for
  // its step — whichever state of the file brought it back.
  for (const s of found.slots) {
    if (s.kind !== 'block' || !s.ids) continue;
    unitsOf(s.wrote, s.lineEnd).forEach((unit, k) => {
      const id = s.ids?.[k];
      if (!id || !book.fromFile.has(id)) return;
      if (cleanAuthorLine(unitLine(unit)) !== book.told.get(id) && !back.has(id)) back.set(id, undefined);
    });
  }
  for (const [id, key] of [...back]) {
    if (!book.fromFile.has(id)) back.delete(id);
    else if (key === undefined) back.set(id, nextMineKey());
  }
  if (back.size === 0) return found;
  const slots: RecordSlot[] = [];
  for (const s of found.slots) {
    const ids = s.kind === 'block' ? s.ids : undefined;
    if (!ids || !ids.some((id) => id !== null && back.has(id))) {
      slots.push(s);
      continue;
    }
    // Split the block part around each such line: block, mine, block.
    const units = unitsOf(s.wrote, s.lineEnd);
    let at = s.start;
    let piece: RecordSlot = { ...s, start: at, end: at, wrote: '', ids: [] };
    units.forEach((unit, k) => {
      const id = ids[k] ?? null;
      const key = id !== null ? back.get(id) : undefined;
      if (key !== undefined) {
        slots.push(piece);
        slots.push({
          kind: 'mine',
          start: at,
          end: at + unit.length,
          lineEnd: s.lineEnd,
          wrote: unit,
          key,
          origin: 'edit',
          stepId: id!,
          status: 'typing',
          editOf: cleanAuthorLine(unitLine(unit)),
          inDraft: true,
        });
        piece = { ...s, start: at + unit.length, end: at + unit.length, wrote: '', ids: [] };
      } else {
        piece = { ...piece, end: piece.end + unit.length, wrote: piece.wrote + unit, ids: [...(piece.ids ?? []), id] };
      }
      at += unit.length;
    });
    slots.push(piece);
  }
  return { ...found, slots: sortSlots(slots) };
}

/** A line of the author's — one any state of the record holds — is in the file
 *  more often than the base it was written into had it. */
function authorLinesLeft(record: LiveRecord, current: string): boolean {
  const count = (text: string, line: string): number => text.split(/\r?\n/).filter((l) => l === line).length;
  // A line the author moved out of the recording is no step of it any more.
  const out = (line: string): number => (record.outside ?? []).filter((l) => l === line).length;
  for (const state of [record, ...record.history]) {
    for (const slot of state.slots) {
      if (slot.kind !== 'mine') continue;
      const line = mineLineText(slot);
      if (line.trim() !== '' && count(current, line) - out(line) > count(state.base, line)) return true;
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
 * write. `touched`: an edit wholly inside the recorded lines that the next
 * draft writes over — the author is warned about that, and about nothing
 * else. With step ids in the drafts (`editable`) there is none but a blank
 * spacing line typed on: a recorded line changed is the author's, a line
 * deleted is its step deleted (`settleRun`), and what that means is put in
 * `book` for the caller to send.
 *
 * `undo`: the uncertain event is an undo or redo. An undo of one of the
 * recording's writes puts the file back as an earlier state, and is found by
 * its text. One that is not, whose every change lies within the text of one
 * line of the run — the author's typing on a line, undone — is followed by
 * offsets after all, as the typing was (with step ids in the drafts: on a
 * recorded line it is a rewording, as any edit of the line is).
 */
export function followLiveRecord(
  live: LiveRecord,
  changes: OffsetChange[],
  opts: { text: () => string; uncertain?: boolean; undo?: boolean; anchor?: RecordAnchor | null; book?: LineBook },
): { record: LiveRecord; touched: boolean } {
  const book = opts.book ?? newLineBook();
  const editable = live.editable === true;
  // Within one line of the author's: their typing, undone — followed as it
  // was typed. (The recording writes nothing on their lines but a number.)
  const inTheirLine =
    opts.undo === true && !live.uncertain && changes.length > 0 && changes.every((c) => insideOneLine(live.slots, c));
  if (opts.uncertain === true && !inTheirLine) {
    const uncertain: LiveRecord = { ...live, uncertain: true };
    const where = locateLiveRecord(uncertain, opts.text(), opts.anchor, book);
    if (where.status === 'found') return { record: opts.undo === true ? commitUndone(where.record, book) : where.record, touched: false };
    const followable =
      where.status === 'lost' &&
      opts.undo === true &&
      !live.uncertain &&
      changes.length > 0 &&
      changes.every((c) => insideOneLine(live.slots, c, editable));
    if (!followable) return { record: uncertain, touched: false };
  }
  // Alt+Up/Down (a line deleted and put in again on the other side of its
  // neighbour, in one event): read as a move, line by line — by offsets alone
  // the line put in at the block's first line reads as one typed above it,
  // and its old place as its step deleted.
  if (editable && opts.undo !== true && !live.uncertain && isLineMove(changes)) {
    const reread = rereadRun(live, changes, opts.text(), book, opts.anchor);
    if (reread) return { record: { ...reread, history: [...live.history, stateOf(live)].slice(-HISTORY_LIMIT) }, touched: false };
  }
  const tracked = trackRecordSlots(live.slots, changes, { editable, ...(editable && changes.length === 1 && { text: opts.text() }) });
  let record: LiveRecord = { ...live, slots: tracked.slots, uncertain: live.uncertain || tracked.uncertain };
  let touched = tracked.touched && !tracked.uncertain;
  // Only an edit inside the block, or a run that holds lines of the author's
  // (or just opened one), has anything to settle: every other keystroke is
  // followed by offsets alone, without reading the document.
  if (!record.uncertain && (tracked.touched || record.slots.some((s) => s.kind === 'mine'))) {
    // Whole lines typed between the recorded ones are the author's new lines,
    // not an edit of the recording's: only what is still an edit inside a
    // recorded line is warned about.
    const settled = settleRun(record, opts.text(), book);
    if (settled) {
      record = settled.record;
      touched = touched && settled.warn;
      // Ctrl+Z of emptying a line is its step restored.
      if (opts.undo === true) record = relinkEmptied(record, book);
      // The file as it stood just before an edit that changed what the
      // recorded lines are — a line reworded, deleted, added: an undo of the
      // edit brings that back, and is found by it (`locateLiveRecord`).
      if (editable && !live.uncertain && runShape(record) !== runShape(live)) {
        record = { ...record, history: [...record.history, stateOf(live)].slice(-HISTORY_LIMIT) };
      }
    } else {
      record = { ...record, uncertain: true };
      touched = false;
    }
  }
  // An edit of the author's the offsets could not follow — reaching across
  // the edge of the recorded lines, or of a line of theirs among them — with
  // step ids: the run is read again line by line (`rereadRun`), each line
  // still some step's, rather than given up on (review of 0.5.158: P6, P7,
  // D3, C1 detached the recording, and Stop then put steps in twice).
  if (editable && opts.undo !== true && !live.uncertain && (record.uncertain || !runOnLines(record, opts.text()))) {
    const reread = rereadRun(live, changes, opts.text(), book, opts.anchor);
    if (reread) {
      record = { ...reread, history: [...live.history, stateOf(live)].slice(-HISTORY_LIMIT) };
      touched = false;
    }
  }
  if (record.uncertain) {
    const where = locateLiveRecord(record, opts.text(), opts.anchor, book);
    if (where.status === 'found') record = where.record;
  }
  if (opts.undo === true) record = commitUndone(record, book);
  return { record, touched };
}

/**
 * One event that moves whole lines past their neighbour, as VS Code 1.95
 * reports Alt+Up/Down (measured): the lines put in again (`T\n` at a line's
 * start, or `\nT` at a line's end) and their old place deleted (`T` with one
 * line break), nothing else.
 */
function isLineMove(changes: OffsetChange[]): boolean {
  if (changes.length !== 2) return false;
  const put = changes.find((c) => c.length === 0 && c.text !== '');
  const cut = changes.find((c) => c.length > 0 && c.text === '');
  if (!put || !cut) return false;
  const body = put.text.endsWith('\n') ? put.text.slice(0, -1) : put.text.startsWith('\n') ? put.text.slice(1) : null;
  return body !== null && cut.length === body.length + 1;
}

/** Every part of the run starts at a line's start and holds whole lines — as
 *  a write needs it to (`verifyInPlace`). A run hanging off the end of the
 *  file's last line (`lineEnd`) is not checked here. */
function runOnLines(record: LiveRecord, text: string): boolean {
  for (const s of record.slots) {
    if (!isRun(s) || s.lineEnd) continue;
    if (s.start < 0 || s.end > text.length || s.start > s.end) return false;
    if (!atLineStart(text, s.start)) return false;
    if (s.end > s.start && text[s.end - 1] !== '\n') return false;
  }
  return true;
}

/**
 * The run read again, line by line, after a change the offsets could not
 * follow (see `followLiveRecord`) — with step ids only. The recorded text is
 * mapped through the change: each line the run had either survives on some
 * line now (moved, renumbered, or edited), or is gone; a new line with no
 * old line on it is the author's own.
 *
 *  - A line that took in text from outside the recorded lines — Backspace at
 *    the start of the first, Delete at the end of the last, a selection from
 *    above the block typed over — is the recorded step's line being edited
 *    (`joined`: it holds a line of the author's too, so the clear-out leaves
 *    it). Two recorded lines made one are the first one's, the second gone,
 *    as inside the block.
 *  - A line that is back with the words of one that went (Alt+Up/Down across
 *    a line of the author's or past the block's edge) is that line, moved.
 *  - A line moved in from outside (the step below the block, Alt+Down on the
 *    last recorded line) is the author's, as a line typed there would be;
 *    one that is a later step the recording renumbered keeps the number it
 *    had, for Cancel to give back.
 *
 *  - A recorded line moved above the line the steps go after (`anchor`, as
 *    the caller followed it) has left the recording, as lines above the
 *    block are outside it (§7): its step is deleted, its text the author's.
 *
 * Null when this cannot follow it either — no ids, a run hanging off the end
 * of the file, the parameters touched, nothing of the run left — and the
 * caller looks for the recording by its text, as before.
 */
function rereadRun(
  live: LiveRecord,
  changes: OffsetChange[],
  text: string,
  book: LineBook,
  anchor?: RecordAnchor | null,
): LiveRecord | null {
  if (live.editable !== true || live.uncertain || changes.length === 0) return null;
  const sorted = sortSlots(live.slots);
  const run = sorted.filter(isRun);
  if (run.length === 0 || run.some((s) => s.lineEnd)) return null;
  const R0 = run[0]!.start;
  const R1 = run[run.length - 1]!.end;
  if (R1 <= R0) return null;
  const params = sorted.find((s) => s.kind === 'params');
  if (params && changes.some((c) => regionRelation(params, c) !== 'before' && regionRelation(params, c) !== 'after')) return null;

  /** The run's lines as the recording last knew them. */
  interface Old {
    start: number;
    end: number;
    text: string;
    /** A recorded line: its step's id (null: a blank spacing line). */
    rec?: string | null;
    /** A line of the author's. */
    mine?: RecordSlot;
  }
  const olds: Old[] = [];
  /** Lines of the author's taken out of the file (a dropped step's, the
   *  clear-out's), kept where they were: before the line `before`. */
  const zeros: Array<{ slot: RecordSlot; before: number }> = [];
  for (const part of run) {
    if (part.kind === 'mine') {
      if (part.start === part.end) zeros.push({ slot: part, before: olds.length });
      else olds.push({ start: part.start, end: part.end, text: part.wrote, mine: part });
      continue;
    }
    if (part.wrote === '') continue;
    const units = unitsOf(part.wrote, false);
    if (!part.ids || part.ids.length !== units.length) return null;
    let at = part.start;
    units.forEach((u, k) => {
      olds.push({ start: at, end: at + u.length, text: u, rec: part.ids![k] ?? null });
      at += u.length;
    });
  }
  if (olds.length === 0) return null;

  // Positions through the change: `after` a text put in right there (whole
  // lines typed at the start of the first recorded line go above the block),
  // `before` it (typing at the start of the line after the block is that
  // line's); a position inside a replaced range goes to that range's end or
  // start.
  const asc = [...changes].sort((a, b) => a.offset - b.offset);
  const map = (p: number, bias: 'before' | 'after'): number => {
    let shift = 0;
    for (const c of asc) {
      const end = c.offset + c.length;
      if (end < p || (c.length > 0 && end === p) || (c.length === 0 && c.offset === p && bias === 'after')) {
        shift += c.text.length - c.length;
        continue;
      }
      if (c.offset >= p) break;
      return c.offset + shift + (bias === 'after' ? c.text.length : 0);
    }
    return p + shift;
  };
  // Lines put in right at the run's start are read with it: one that is a
  // line of the run moved there is the run's first line now; any other is
  // above the run, as before (`first`, below).
  const newR0 = map(R0, 'before');
  const newR1 = map(R1, 'before');
  if (newR1 < newR0) return null;
  const S = text.lastIndexOf('\n', newR0 - 1) + 1;
  let E = newR1;
  if (!atLineStart(text, E)) {
    const nl = text.indexOf('\n', E);
    if (nl < 0) return null;
    E = nl + 1;
  }
  if (E <= S || text[E - 1] !== '\n') return null;
  const lines = unitsOf(text.slice(S, E), false);
  const lineStartsNow: number[] = [];
  {
    let at = S;
    for (const u of lines) {
      lineStartsNow.push(at);
      at += u.length;
    }
  }
  const lineOf = (pos: number): number => {
    let k = 0;
    while (k + 1 < lineStartsNow.length && lineStartsNow[k + 1]! <= pos) k++;
    return k;
  };

  // Where each old line's text is now: the line its start lands on, when any
  // of its text is left (or was typed over).
  const owners: Array<Old[]> = lines.map(() => []);
  const gone: Old[] = [];
  for (const o of olds) {
    const brk = o.text.endsWith('\r\n') ? 2 : o.text.endsWith('\n') ? 1 : 0;
    const from = map(o.start, 'after');
    const to = map(o.end - brk, 'before');
    const blank = o.end - brk === o.start;
    if (from < S || from >= E || (!blank && to <= from)) {
      gone.push(o);
      continue;
    }
    const k = lineOf(from);
    // A blank line survives only as a blank line where it was.
    if (blank && unitLine(lines[k]!) !== '') {
      gone.push(o);
      continue;
    }
    owners[k]!.push(o);
  }
  /** Each line now: the old line it is (first of those on it: two made one
   *  are the first's), whether it is word for word that line, and whether it
   *  took in text from outside the run. */
  const now: Array<{ old: Old | null; same: boolean; joined?: 'above' | 'below' }> = lines.map((u, k) => {
    const on = owners[k]!;
    const old = on[0] ?? null;
    for (const extra of on.slice(1)) gone.push(extra);
    const start = lineStartsNow[k]!;
    const joined = old === null ? undefined : start < newR0 ? 'above' : start + unitLine(u).length > newR1 ? 'below' : undefined;
    return { old, same: old !== null && old.text === u, ...(joined && { joined }) };
  });
  // A line with no old line on it but the words of one that went is that one
  // — moved (Alt+Up/Down reports the line put in again, and its old place
  // deleted).
  now.forEach((n, k) => {
    if (n.old !== null) return;
    const words = stepWords(lines[k]!);
    if (words === '') return;
    const g = gone.findIndex((o) => stepWords(o.text) === words && (o.rec != null || o.mine !== undefined));
    if (g < 0) return;
    n.old = gone.splice(g, 1)[0]!;
    n.same = n.old.text === lines[k];
  });
  // Above the line the steps go after: outside the recording (§7) — a line
  // of the run moved there has left it.
  /** Where the steps go when every line of the run has left it that way:
   *  the start of the line after the anchor's. */
  let emptyAt = -1;
  const movedOut: string[] = [];
  if (anchor) {
    const at = locateAnchor(modelOf(text), anchor);
    const starts = lineStarts(text);
    const anchorStart = at ? (starts[at.idx] ?? -1) : -1;
    now.forEach((n, k) => {
      if (n.old === null || lineStartsNow[k]! >= anchorStart) return;
      gone.push(n.old);
      n.old = null;
      movedOut.push(unitLine(lines[k]!));
      if (at) emptyAt = starts[at.idx + 1] ?? text.length;
    });
  }
  // The first line of the run now is the first with an old line on it: the
  // new lines above it are outside the recording (§7, "Edges").
  let first = now.findIndex((n) => n.old !== null);
  if (first < 0 && emptyAt < 0) return null;
  if (first < 0) first = lines.length;
  // A later step the recording renumbered, moved above the run (Alt+Down on
  // its only line): outside it, the author's line — its number is no longer
  // the recording's to give back, nor its text the recording's.
  const renumbered = new Set(
    sorted.filter((t) => t.kind === 'tail' && t.wrote !== t.original).map((t) => `${t.wrote}${t.rest ?? ''}`),
  );
  for (let k = 0; k < first; k++) if (renumbered.has(unitLine(lines[k]!))) movedOut.push(unitLine(lines[k]!));
  // Of the lines that are old ones, the most still in their order stay where
  // the recording has them; the rest were moved by the author.
  const oldIndex = new Map(olds.map((o, i) => [o, i] as const));
  const inOrder = keptInOrder(now.flatMap((n, k) => (n.old ? [[k, oldIndex.get(n.old)!] as const] : [])));

  for (const o of gone) {
    if (o.mine) lineGone(book, o.mine);
    else if (o.rec) stepGone(book, o.rec, cleanAuthorLine(unitLine(o.text)));
  }

  const tails = sorted.filter((s) => s.kind === 'tail');
  const parts: RecordSlot[] = [];
  let block: RecordSlot | null = null;
  const closeBlock = (): void => {
    if (block) parts.push(block);
    block = null;
  };
  /** Lines of the author's taken out of the file, put back before `k`'s line. */
  const zerosBefore = (k: number | null, at: number): void => {
    for (const z of zeros) {
      const target = z.before < olds.length ? now.findIndex((n) => n.old === olds[z.before]) : -1;
      if ((k === null && target < 0) || (k !== null && target === k)) {
        closeBlock();
        parts.push({ ...z.slot, start: at, end: at });
      }
    }
  };
  let at = first < lines.length ? lineStartsNow[first]! : emptyAt;
  for (let k = first; k < lines.length; k++) {
    const u = lines[k]!;
    const n = now[k]!;
    zerosBefore(k, at);
    const o = n.old;
    if (o && o.mine) {
      closeBlock();
      const moved = !inOrder.has(k) && hasStep(o.mine) && o.mine.stepId !== undefined;
      const next: RecordSlot = { ...o.mine, start: at, end: at + u.length, wrote: u };
      if (moved && next.moved === undefined) next.moved = next.inDraft === true ? 'held' : 'waiting';
      // Holding the anchor's line stays so, whatever else joins it.
      if (n.joined) next.joined = next.joined === 'above' ? 'above' : n.joined;
      parts.push(next);
    } else if (o && o.rec !== undefined && o.rec !== null && !n.same && stepWords(u) !== stepWords(o.text)) {
      // Its words changed: the step's line, being edited.
      closeBlock();
      parts.push({
        kind: 'mine',
        start: at,
        end: at + u.length,
        lineEnd: false,
        wrote: u,
        key: nextMineKey(),
        origin: 'edit',
        stepId: o.rec,
        status: 'typing',
        editOf: cleanAuthorLine(unitLine(o.text)),
        inDraft: true,
        ...(n.joined && { joined: n.joined }),
      });
    } else if (o && o.rec !== undefined && o.rec !== null && !inOrder.has(k)) {
      closeBlock();
      parts.push(movedLine(at, u, false, o.rec, 'held'));
    } else if (o && o.rec !== undefined) {
      // The recording's line, where it was (renumbered at most).
      if (!block) block = { kind: 'block', start: at, end: at, lineEnd: false, wrote: '', ids: [], touched: false };
      block.end += u.length;
      block.wrote += u;
      block.ids!.push(o.rec);
    } else {
      // A line of the author's: typed, pasted, or moved in from outside.
      closeBlock();
      const line = typingLine(at, u, false);
      const tail = tails.find((t) => t.wrote !== t.original && `${t.wrote}${t.rest ?? ''}` === unitLine(u));
      if (tail) line.number = { mode: 'digits', author: tail.original ?? tail.wrote, wrote: tail.wrote };
      parts.push(line);
    }
    at += u.length;
  }
  zerosBefore(null, at);
  closeBlock();
  // Every line moved out: the run is empty, where the steps go.
  if (!parts.some((p) => p.kind === 'block')) parts.unshift({ ...emptyBlock(first < lines.length ? lineStartsNow[first]! : at, false), ids: [] });

  // The rest of the record by offsets: later steps (their lines touched are
  // the author's now), the parameters (untouched).
  const tracked = trackRecordSlots(live.slots, changes, { editable: true });
  const others = tracked.slots.filter((s) => !isRun(s));
  const rebuilt: LiveRecord = {
    ...live,
    slots: sortSlots([...others, ...parts]),
    uncertain: false,
    ...(movedOut.length > 0 && { outside: [...(live.outside ?? []), ...movedOut] }),
  };
  const settled = settleRun(rebuilt, text, book);
  if (!settled || !runOnLines(settled.record, text)) return null;
  return settled.record;
}

/**
 * After an undo or redo: each line standing for a step whose words are no
 * longer what the server holds for it from the file (`LineBook.told`) — the
 * author's rewording undone, back to the model's words or an earlier one —
 * counts at once (`RecordSlot.commitNow`). An `edit-step` back to the model's
 * words releases the rewording on the server; without it, a second Ctrl+Z
 * before the cursor left the line (the recording's own write undone) left the
 * server holding words the file no longer has, and Stop wrote them back
 * (review of tb 0.5.158, P10).
 */
function commitUndone(record: LiveRecord, book: LineBook): LiveRecord {
  if (record.uncertain || record.editable !== true) return record;
  let changed = false;
  const slots = record.slots.map((s) => {
    if (s.kind !== 'mine' || s.commitNow === true || !s.stepId || s.dropped !== undefined || s.cleared === true || s.wrote === '') return s;
    if (!hasStep(s) || !book.fromFile.has(s.stepId)) return s;
    const told = book.told.get(s.stepId);
    const words = cleanAuthorLine(mineLineText(s));
    if (told === undefined || words === told || words === '') return s;
    changed = true;
    return { ...s, commitNow: true };
  });
  return changed ? { ...record, slots } : record;
}

/**
 * The run — the recorded block and the author's lines in it — made to read as
 * the offsets followed it, after the author's edits
 * (stories/steptix-record-toolbar.md §"Steps typed in the editor"):
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
 * With step ids in the drafts (`editable` — stories/steptix-record-edit-steps.md
 * §"In the file") the author edits the recorded lines themselves too:
 *
 *  - a recorded line whose words changed is theirs from that keystroke — a
 *    `mine` line of `edit` origin, standing for its step, which the recording
 *    no longer writes; one whose NUMBER alone changed stays the recording's,
 *    which puts its number back ("numbers stay the recording's");
 *  - a recorded line deleted whole is its step deleted (`book`), and so is a
 *    line of the author's that stood for a step.
 *
 * `warn`: an edit inside the recorded lines is left for the next draft to
 * write over (a server that sends no ids, or a blank spacing line typed on).
 *
 * Offsets only: null when they do not describe whole lines any more — the
 * caller then looks for the recording by its text.
 */
function settleRun(record: LiveRecord, text: string, book: LineBook = newLineBook()): { record: LiveRecord; warn: boolean } | null {
  const editable = record.editable === true;
  const sorted = sortSlots(record.slots);
  const run = sorted.filter(isRun);
  if (run.length === 0) return { record, warn: false };
  const others = sorted.filter((s) => !isRun(s));
  const firstBlock = run[0];
  const parts: RecordSlot[] = [];
  let warn = false;
  for (const slot of run) {
    if (slot.start < 0 || slot.end > text.length || slot.start > slot.end) return null;
    const now = text.slice(slot.start, slot.end);
    if (slot.kind === 'mine') {
      // Taken out because its step was dropped, or by the empty draft: kept
      // where it was, empty, to put back.
      if (slot.dropped === 'hidden' || slot.cleared === true) {
        if (now !== '') return null;
        parts.push(slot);
        continue;
      }
      if (now === '') {
        // Deleted: the author's to delete — and, a line that stood for a
        // step, that step deleted too.
        if (editable) lineGone(book, slot);
        continue;
      }
      if (!wholeLines(text, slot.start, slot.end, slot.lineEnd)) return null;
      const units = unitsOf(now, slot.lineEnd);
      // The unit that still reads as the line did keeps its name — or the one
      // that still says its step (Enter typed at the start of a line: a new
      // line above it, not the step reworded); the rest are new lines of the
      // author's.
      let own = units.indexOf(slot.wrote);
      const says = slot.sentText ?? slot.editOf;
      if (own < 0 && says !== undefined) own = units.findIndex((u) => cleanAuthorLine(unitLine(u)) === says);
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
    if (editable && slot.ids !== undefined) {
      const diff = diffBlock(slot, now, slot === firstBlock);
      if (!diff) return null;
      for (const g of diff.gone) stepGone(book, g.id, g.words);
      if (diff.stale) warn = true;
      let at = slot.start;
      for (const p of diff.pieces) {
        const end = at + p.text.length;
        if (p.kind === 'edit') {
          parts.push({
            kind: 'mine',
            start: at,
            end,
            lineEnd: slot.lineEnd,
            wrote: p.text,
            key: nextMineKey(),
            origin: 'edit',
            stepId: p.id!,
            status: 'typing',
            editOf: p.was ?? '',
            inDraft: true,
          });
        } else if (p.kind === 'moved') {
          parts.push(movedLine(at, p.text, slot.lineEnd, p.id!, 'held'));
        } else if (p.kind === 'new') {
          parts.push(typingLine(at, p.text, slot.lineEnd));
        } else {
          parts.push({ ...slot, start: at, end, wrote: p.text, ids: p.ids ?? [], touched: false });
        }
        at = end;
      }
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
        const ids = joinIds(prev, slot);
        prev.end = slot.end;
        prev.wrote += slot.wrote;
        prev.touched = prev.touched === true || slot.touched === true;
        if (ids === undefined) delete prev.ids;
        else prev.ids = ids;
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
    // An empty part holds no step.
    if (editable && slot.ids === undefined) slot.ids = [];
  }
  // An edit inside a recorded line the next draft writes over (no step ids).
  if (out.some((s) => s.kind === 'block' && s.touched === true)) warn = true;
  return { record: { ...record, slots: sortSlots([...others, ...out]) }, warn };
}

/** The step ids of two block parts made one; undefined when either part
 *  holds lines with no ids (an empty part holds none). */
function joinIds(a: RecordSlot, b: RecordSlot): Array<string | null> | undefined {
  const x = a.ids ?? (a.wrote === '' ? [] : undefined);
  const y = b.ids ?? (b.wrote === '' ? [] : undefined);
  return x && y ? [...x, ...y] : undefined;
}

/**
 * A line's words without its leading number or list marker (and the space
 * after it) or its line break — what an edit changes. Two lines whose words
 * are the same differ in their number alone.
 */
function stepWords(unit: string): string {
  const line = unitLine(unit);
  return line.slice(stepTextStart(line));
}

/**
 * A block part whose step ids are known, as the author changed it (`now`):
 * line by line against what the recording wrote (`slot.wrote`), the lines
 * both have at the start and the end set aside, and the rest paired in order —
 *
 *  - a recorded line whose words changed: the author's rewording, `edit`;
 *  - one whose number alone changed: still the recording's (`rec`), and the
 *    next write gives it its number back;
 *  - a recorded line with no counterpart left: deleted — its step `gone`;
 *  - a line with no recorded counterpart: a new line of the author's, `new` —
 *    except above the first recorded line of the run, which is outside it (§7)
 *    and stays an edit the next draft writes over (`stale`), as it always was;
 *  - a blank spacing line typed on, or deleted: the recording's, written over
 *    by the next draft (`stale`).
 *
 * Null when `now` is not whole lines, or the ids do not fit the lines.
 */
function diffBlock(
  slot: RecordSlot,
  now: string,
  first: boolean,
): {
  pieces: Array<{ text: string; kind: 'rec' | 'edit' | 'new' | 'moved'; id?: string; was?: string; ids?: Array<string | null> }>;
  gone: Array<{ id: string; words: string }>;
  stale: boolean;
} | null {
  if (now !== '' && !(slot.lineEnd ? startsWithBreak(now) : now.endsWith('\n'))) return null;
  const a = unitsOf(slot.wrote, slot.lineEnd);
  const b = unitsOf(now, slot.lineEnd);
  if (b.join('') !== now) return null;
  const ids = slot.ids ?? [];
  if (ids.length !== a.length) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const flat: Array<{ text: string; kind: 'rec' | 'edit' | 'new' | 'moved'; id: string | null; was?: string }> = [];
  const gone: Array<{ id: string; words: string }> = [];
  let stale = false;
  for (let i = 0; i < p; i++) flat.push({ text: a[i]!, kind: 'rec', id: ids[i] ?? null });
  const midA = a.slice(p, a.length - q);
  const midB = b.slice(p, b.length - q);
  const idA = (i: number): string | null => ids[p + i] ?? null;
  // First, a changed line whose words (its number aside) a recorded line of
  // the stretch had is that line — renumbered, or MOVED (Alt+Up/Down): it
  // keeps its step's id (review of 0.5.158, D1: pairing by position read a
  // swap as two rewordings, each step then standing for the other's action).
  const byWords = new Map<number, number>();
  const taken = new Set<number>();
  midB.forEach((nu, j) => {
    const w = stepWords(nu);
    if (w === '') return;
    const i = midA.findIndex((old, k) => !taken.has(k) && idA(k) !== null && stepWords(old) === w);
    if (i < 0) return;
    byWords.set(j, i);
    taken.add(i);
  });
  // Of those, the most that are still in their order stay the recording's;
  // the rest moved, and are the author's lines where they put them.
  const inOrder = keptInOrder([...byWords.keys()].sort((x, y) => x - y).map((j) => [j, byWords.get(j)!] as const));
  // The others, paired in order: a line whose words changed is its step's
  // rewording; one with no counterpart is gone, or new.
  const restA = midA.map((_, i) => i).filter((i) => !taken.has(i));
  const restB = midB.map((_, j) => j).filter((j) => !byWords.has(j));
  const byPlace = new Map<number, number>();
  restB.forEach((j, k) => {
    if (k < restA.length) byPlace.set(j, restA[k]!);
  });
  midB.forEach((nu, j) => {
    const w = byWords.get(j);
    if (w !== undefined) {
      flat.push({ text: nu, kind: inOrder.has(j) ? 'rec' : 'moved', id: idA(w) });
      return;
    }
    const i = byPlace.get(j);
    if (i === undefined) {
      flat.push({ text: nu, kind: 'new', id: null });
      return;
    }
    const old = midA[i]!;
    const id = idA(i);
    if (id === null) {
      flat.push({ text: nu, kind: 'rec', id: null });
      stale = true;
    } else if (stepWords(nu) !== '' && stepWords(nu) === stepWords(old)) {
      flat.push({ text: nu, kind: 'rec', id });
    } else {
      flat.push({ text: nu, kind: 'edit', id, was: cleanAuthorLine(unitLine(old)) });
    }
  });
  for (const i of restA.slice(restB.length)) {
    const id = idA(i);
    if (id !== null) gone.push({ id, words: cleanAuthorLine(unitLine(midA[i]!)) });
    else stale = true;
  }
  for (let i = a.length - q; i < a.length; i++) flat.push({ text: a[i]!, kind: 'rec', id: ids[i] ?? null });
  // Above the run's first recorded line: outside the recording, left as an
  // edit inside the block, as it always was.
  if (first) {
    for (const f of flat) {
      if (f.id !== null) break;
      if (f.kind === 'new') {
        f.kind = 'rec';
        stale = true;
      }
    }
  }
  const pieces: Array<{ text: string; kind: 'rec' | 'edit' | 'new' | 'moved'; id?: string; was?: string; ids?: Array<string | null> }> = [];
  // Every line of it gone: the part stays, empty, where the steps go.
  if (flat.length === 0) pieces.push({ text: '', kind: 'rec', ids: [] });
  for (const f of flat) {
    const last = pieces[pieces.length - 1];
    if (f.kind === 'rec' && last?.kind === 'rec') {
      last.text += f.text;
      last.ids!.push(f.id);
      continue;
    }
    if (f.kind === 'rec') pieces.push({ text: f.text, kind: 'rec', ids: [f.id] });
    else pieces.push({ text: f.text, kind: f.kind, ...(f.id !== null && { id: f.id }), ...(f.was !== undefined && { was: f.was }) });
  }
  return { pieces, gone, stale };
}

/**
 * Of lines paired with where they were (`[new index, old index]`, in new
 * order), the most that are still in their old order — a longest increasing
 * run of old indices, the earlier lines kept on a tie (so after Alt+Down the
 * line that went down is the one that moved). Returns their new indices.
 */
function keptInOrder(pairs: ReadonlyArray<readonly [number, number]>): Set<number> {
  const n = pairs.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let k = 0; k < n; k++) {
    for (let m = 0; m < k; m++) {
      if (pairs[m]![1] < pairs[k]![1] && len[m]! + 1 > len[k]!) {
        len[k] = len[m]! + 1;
        prev[k] = m;
      }
    }
  }
  let end = -1;
  for (let k = 0; k < n; k++) if (end < 0 || len[k]! > len[end]!) end = k;
  const out = new Set<number>();
  for (let k = end; k >= 0; k = prev[k]!) out.add(pairs[k]![0]);
  return out;
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
  /**
   * The `revision` of the draft `afterStep` counts in — the one written into
   * the file when the lines were counted (`LiveState.revision`), whenever the
   * add-step itself goes out. Absent before any draft carried one.
   */
  revision?: number;
}

/**
 * The author's lines that count as WRITTEN now (stories/steptix-record-toolbar.md
 * §"Steps typed in the editor"): lines not counted yet (`typing`) with a step
 * on them that no cursor is on — the author left the line, by moving the
 * cursor or pressing Enter. A blank line never counts, and a line a cursor is
 * on is still being typed: a half-finished sentence is not locked in. Only a
 * line that is a step, or becomes one when the recording numbers it, counts
 * (`authorLineIsStep`): a heading, a table row, a fence or a comment typed
 * there is the author's text and is never sent.
 *
 * Each counted line becomes `sent`. The lines that count between the same two
 * steps of the draft last written (the recording's lines, and the author's
 * lines that draft holds) go as ONE add-step, in order: `afterStep` names the
 * step above them, and all of them follow it. They go only while no other
 * line between those two steps is sent and not yet held by a draft: that one
 * names the same step, and two add-steps aimed at one step land in whichever
 * order the server puts them. So a line waits until the draft that holds its
 * neighbour is written, and then names it (`afterStep` past it, or before it
 * by counting only what is above) — the caller counts again after each write.
 * `final` (Stop) sends every line that counts, waiting for nothing: nothing
 * later would send it, and a draft that places two of them the other way round
 * is laid out by count (`layoutRun`) rather than lost.
 *
 * `cursors` are offsets into `text`, the document as it is; `final` ignores
 * them — a line the cursor is still on at Stop is finished. A record whose
 * offsets cannot be trusted (`uncertain`) counts nothing.
 */
export function commitAuthorLines(
  live: LiveRecord,
  text: string,
  cursors: number[],
  opts: { final?: boolean; book?: LineBook } = {},
): { record: LiveRecord; commits: AuthorStepCommit[] } {
  if (live.uncertain) return { record: live, commits: [] };
  const run = live.slots.filter(isRun);
  let model: LineModel | null = null;
  let starts: number[] | null = null;
  const ready = new Map<RecordSlot, string>();
  /** Lines that are a step this file deleted, back: restored, not added. */
  const restored = new Map<RecordSlot, string>();
  for (let i = 0; i < run.length; i++) {
    const s = run[i]!;
    // A reworded recorded line is not a new step: `commitLineEdits` sends it.
    if (s.kind !== 'mine' || s.status !== 'typing' || !s.key || s.origin === 'edit') continue;
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
    if (!opts.final && cursors.some((c) => c >= from && c <= to)) continue;
    model ??= modelOf(text);
    starts ??= lineStarts(text);
    if (!authorLineIsStep(model, lineAtOffset(starts, from))) continue;
    // The words of a step whose line this file deleted (and that is not back
    // yet): a line cut and pasted, or deleted and typed again, is that step
    // restored — its actions with it — not a new step of the author's with
    // none (review of 0.5.158, P and E).
    const book = opts.book;
    const back = book
      ? [...book.deleted].find((id) => book.deletedWords.get(id)?.words === step && ![...restored.values()].includes(id))
      : undefined;
    if (back !== undefined) {
      restored.set(s, back);
      continue;
    }
    ready.set(s, step);
  }
  if (restored.size > 0 && opts.book) {
    const book = opts.book;
    const typed = new Set<string>();
    for (const id of restored.values()) {
      if (book.deletedWords.get(id)?.typed === true) typed.add(id);
      book.deleted.delete(id);
      book.deletedWords.delete(id);
      // A drop of it not sent yet is moot; otherwise it goes back.
      const waiting = book.queue.findIndex((q) => q.action === 'drop' && q.id === id);
      if (waiting >= 0) book.queue.splice(waiting, 1);
      else book.queue.push({ action: 'restore', id });
    }
    live = {
      ...live,
      slots: live.slots.map((s) => {
        const id = restored.get(s);
        if (id === undefined) return s;
        const line = { ...movedLine(s.start, s.wrote, s.lineEnd, id, 'waiting'), key: s.key! };
        // A line the author typed, back: theirs again, as it went (Cancel keeps it).
        if (typed.has(id)) {
          delete line.origin;
          delete line.editOf;
        }
        return line;
      }),
    };
  }
  if (ready.size === 0) return { record: live, commits: [] };
  const commits: AuthorStepCommit[] = [];
  /** The author's lines since the last step of the draft written. */
  let gap: RecordSlot[] = [];
  const close = (): void => {
    const lines = gap;
    gap = [];
    const go = lines.filter((s) => ready.has(s));
    if (go.length === 0) return;
    // Sent and not held yet: its step is aimed at the same place.
    const waiting = lines.some((s) => s.status === 'sent' && !s.inDraft && s.dropped === undefined);
    if (waiting && !opts.final) {
      for (const s of go) ready.delete(s);
      return;
    }
    const i = run.indexOf(go[0]!);
    commits.push({
      keys: go.map((s) => s.key!),
      lines: go.map((s) => ready.get(s)!),
      ...(!atRunEnd(run, i) && { afterStep: stepsAbove(run, i) - 1 }),
      ...(live.revision !== undefined && { revision: live.revision }),
    });
  };
  for (const s of run) {
    const step =
      s.kind === 'block'
        ? stepCount(s.wrote) > 0
        : (s.origin === 'edit' || s.status === 'sent') && s.inDraft === true && s.dropped === undefined && s.cleared !== true;
    if (step) {
      close();
      continue;
    }
    if (s.kind === 'mine' && s.origin !== 'edit') gap.push(s);
  }
  close();
  const atEnd = new Set(commits.filter((c) => c.afterStep === undefined).flatMap((c) => c.keys));
  const slots = live.slots.map((s) => {
    const step = ready.get(s);
    if (step === undefined) return s;
    return { ...s, status: 'sent' as const, sentText: step, recAs: s.wrote, ...(atEnd.has(s.key!) && { sentAtEnd: true }) };
  });
  return { record: { ...live, slots }, commits };
}

/**
 * A line the author typed into the recorded block is a step: one already
 * (`N. text`), or one when the recording numbers it — text or a list item — by
 * the line model (`classifyLines`, with fences and data tables as `modelOf`
 * reads them). A heading (which would open a section or end `## Steps`), a
 * numbered item a `####` heading makes inert, a data table's line, a fence or
 * a line inside one, and an HTML comment are not.
 */
function authorLineIsStep(m: LineModel, idx: number): boolean {
  const raw = m.lines[idx] ?? '';
  if (m.fenced[idx] || isFenceDelimiter(raw) || isTableRow(m, idx)) return false;
  const kind = kindAt(m, idx);
  if (isStepKind(kind)) return true;
  if (kind !== 'prose' || opensHtmlComment(raw)) return false;
  // Text or a list item: a step once the recording numbers it — which it is
  // only inside `## Steps`, and not under a `####` heading. Asked of the line
  // model itself, with the line numbered.
  const numbered = [...m.lines];
  numbered[idx] = `1. ${cleanAuthorLine(raw)}`;
  return isStepKind(classifyLines(numbered.join('\n'))[idx]?.kind);
}

/**
 * `record:step` named a step from the editor: the line of the author's that
 * was sent as that text, and has no id yet, is that step.
 */
export function assignAuthorStepId(live: LiveRecord, id: string, text: unknown, book?: LineBook): LiveRecord {
  if (live.slots.some((s) => s.kind === 'mine' && s.stepId === id)) return live;
  const want = cleanStepText(text);
  const k = live.slots.findIndex((s) => s.kind === 'mine' && s.origin !== 'edit' && s.status === 'sent' && !s.stepId && s.sentText === want);
  if (k < 0) {
    // The line was deleted before its step had a name: the step goes too.
    const gone = book?.unnamed.indexOf(want) ?? -1;
    if (book && gone >= 0) {
      book.unnamed.splice(gone, 1);
      stepGone(book, id, want, true);
    }
    return live;
  }
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

/**
 * One control for a line of the author's that stands for a step: the words
 * they left on it (`edit-step`), or — a line emptied, or left only a number —
 * its step deleted (`drop`).
 */
export interface LineEditCommit {
  /** The line's name (`RecordSlot.key`). */
  key: string;
  action: 'edit-step' | 'drop';
  /** The step (`record:draft.ids`, or an author step's `s` id). */
  id: string;
  /** `edit-step`: the words, one line, as `cleanAuthorLine` leaves them. */
  text?: string;
  /** `edit-step`: the revision of the draft last written into the file. */
  revision?: number;
  /** `edit-step`: the author's words the server held for the step before
   *  this one, if any — what it still holds when it does not take this one. */
  was?: string;
  /** `edit-step`: `was` came from the file too. */
  wasFromFile?: boolean;
}

/**
 * The author's edits of steps in the file that count NOW
 * (stories/steptix-record-edit-steps.md §"In the file"): a line standing for
 * a step — a recorded line they reworded, or a line they typed whose step the
 * server has named — whose words are not what went to the server for it, with
 * no cursor on it (`final`, Stop: whatever the cursor). The moments a typed
 * line counts: the cursor leaves it, the window loses focus, Stop.
 *
 *  - empty, or only a number: a delete — `drop`. The line stays as they left
 *    it, a line of theirs with no step on it.
 *  - the words the server already has for the step (a reworded line changed
 *    back before anything was sent): no edit. A reworded line is the
 *    recording's line again (`absorbLine`); its number is the recording's.
 *  - otherwise: `edit-step` with the words — the line then waits for the
 *    server to say it took them (`unacked`), and newer words from the drawer
 *    meanwhile are not put on it.
 *
 * Nothing while the record's offsets cannot be trusted, or before the drafts
 * carry step ids (a server that predates editing): a typed line edited after
 * it went is then the author's text, as it always was.
 */
export function commitLineEdits(
  live: LiveRecord,
  text: string,
  cursors: number[],
  opts: { final?: boolean; book?: LineBook; onlyUndone?: boolean } = {},
): { record: LiveRecord; commits: LineEditCommit[] } {
  if (live.uncertain || live.editable !== true) return { record: live, commits: [] };
  const book = opts.book ?? newLineBook();
  const commits: LineEditCommit[] = [];
  const patch = new Map<string, RecordSlot>();
  const absorb: string[] = [];
  for (const s of live.slots) {
    if (s.kind !== 'mine' || !s.key || !s.stepId || s.dropped !== undefined || s.cleared === true || s.wrote === '') continue;
    // `onlyUndone`: the lines an undo left with words the server does not
    // hold, which count wherever the cursor is (`RecordSlot.commitNow`).
    if (opts.onlyUndone === true && s.commitNow !== true) continue;
    const reworded = s.origin === 'edit';
    if (!reworded && s.status !== 'sent') continue;
    if (text.slice(s.start, s.end) !== s.wrote) continue; // not where it was followed to
    const words = cleanAuthorLine(mineLineText(s));
    const typing = reworded && s.status === 'typing';
    // A line the author moved whose step a draft held and the one written
    // since does not (the model rewrote it): its words go, wherever the
    // cursor is — the server puts them back under the step's id, and the
    // model's new step is not left beside the line.
    const pin = s.moved === 'held' && s.inDraft === false && s.status === 'sent' && s.unacked !== true && words !== '';
    if (!typing && words === s.sentText && !pin && s.resend !== true) {
      // What the server has: nothing to send.
      if (s.commitNow === true) patch.set(s.key, withoutCommitNow(s));
      continue;
    }
    const lead = lineBreakLead(s);
    const from = s.start + lead;
    const to = from + mineLineText(s).length;
    if (!opts.final && s.commitNow !== true && !pin && cursors.some((c) => c >= from && c <= to)) continue;
    const id = s.stepId;
    if (words === '') {
      commits.push({ key: s.key, action: 'drop', id });
      book.deleted.add(id);
      const had = s.sentText ?? (reworded ? (book.told.get(id) ?? s.editOf) : undefined);
      if (had !== undefined && had !== '') book.deletedWords.set(id, { words: had, typed: !reworded });
      patch.set(s.key, {
        kind: 'mine',
        start: s.start,
        end: s.end,
        lineEnd: s.lineEnd,
        wrote: s.wrote,
        key: s.key,
        status: 'typing',
        ...(reworded && { emptied: true }),
        ...(had !== undefined && { emptiedOf: { id, words: had, reworded } }),
      });
      continue;
    }
    const server = book.told.get(id) ?? (reworded ? s.editOf : s.sentText);
    if (words === server && !pin) {
      if (reworded && !book.told.has(id) && s.moved === undefined) absorb.push(s.key);
      else patch.set(s.key, withoutCommitNow({ ...s, status: 'sent', sentText: words }));
      continue;
    }
    const told = book.told.get(id);
    commits.push({
      key: s.key,
      action: 'edit-step',
      id,
      text: words,
      ...(live.revision !== undefined && { revision: live.revision }),
      ...(told !== undefined && { was: told }),
      ...(book.fromFile.has(id) && { wasFromFile: true }),
    });
    book.told.set(id, words);
    book.fromFile.add(id);
    const next: RecordSlot = withoutCommitNow({ ...s, status: 'sent', sentText: words, recAs: s.wrote, unacked: true });
    delete next.follow;
    patch.set(s.key, next);
  }
  if (patch.size === 0 && absorb.length === 0) return { record: live, commits };
  let record: LiveRecord = {
    ...live,
    slots: live.slots.map((s) => (s.kind === 'mine' && s.key && patch.has(s.key) ? patch.get(s.key)! : s)),
  };
  for (const key of absorb) record = absorbLine(record, key);
  return { record, commits };
}

/** A line of the author's that no longer has anything waiting to go: to
 *  count at once (`commitNow`), or its words to go again (`resend`). */
function withoutCommitNow(s: RecordSlot): RecordSlot {
  if (s.commitNow === undefined && s.resend === undefined) return s;
  const next = { ...s };
  delete next.commitNow;
  delete next.resend;
  return next;
}

/**
 * A reworded line that is the recording's again — its words back to the
 * step's, with nothing sent — made part of the block around it: the block
 * part above, the line, and the block part below are one part, the line
 * holding its step's id. The next write gives it the recording's number.
 */
function absorbLine(record: LiveRecord, key: string): LiveRecord {
  const sorted = sortSlots(record.slots);
  const run = sorted.filter(isRun);
  const i = run.findIndex((s) => s.kind === 'mine' && s.key === key);
  const above = run[i - 1];
  const below = run[i + 1];
  const mine = run[i];
  if (!mine || above?.kind !== 'block' || below?.kind !== 'block' || above.end !== mine.start || mine.end !== below.start) return record;
  const aboveIds = above.ids ?? (above.wrote === '' ? [] : undefined);
  const belowIds = below.ids ?? (below.wrote === '' ? [] : undefined);
  if (aboveIds === undefined || belowIds === undefined) return record;
  const merged: RecordSlot = {
    ...above,
    end: below.end,
    lineEnd: above.start === above.end ? mine.lineEnd : above.lineEnd,
    wrote: above.wrote + mine.wrote + below.wrote,
    ids: [...aboveIds, mine.stepId ?? null, ...belowIds],
    touched: false,
  };
  const slots = sorted.filter((s) => s !== mine && s !== below).map((s) => (s === above ? merged : s));
  return { ...record, slots: sortSlots(slots) };
}

/**
 * The server did not take an `edit-step` (it answered `ignored` — a secret it
 * knows, say — or the call failed): the line stays as the author wrote it,
 * standing for its step, and is sent again only when they change it again;
 * the server still holds the words it had. A reworded recorded line is `kept`;
 * a line the author typed stays `sent` — for a typed line `kept` means its
 * add-step was refused and it stands for nothing, and the draft would then
 * write its step a second time beside it.
 */
export function editRefused(live: LiveRecord, commit: LineEditCommit, book: LineBook): LiveRecord {
  if (commit.action !== 'edit-step') return live;
  if (book.told.get(commit.id) === commit.text) {
    if (commit.was !== undefined) book.told.set(commit.id, commit.was);
    else book.told.delete(commit.id);
    if (commit.wasFromFile !== true) book.fromFile.delete(commit.id);
  }
  const slots = live.slots.map((s) =>
    s.kind === 'mine' && s.key === commit.key && s.sentText === commit.text
      ? { ...s, status: s.origin === 'edit' ? ('kept' as const) : ('sent' as const), unacked: false }
      : s,
  );
  return { ...live, slots };
}

/**
 * `record:edited`: a step's words changed (stories/steptix-record-edit-steps.md).
 *
 *  - From the file (`editor`): the server took an `edit-step` of ours — the
 *    line it went from stops waiting, and stands for the step the frame names
 *    (the one the edit was sent for, or, the model having rewritten that one,
 *    the step that stands for its actions now).
 *  - From the drawer or the panel: newer words for the step. A line of the
 *    author's standing for it takes them at the next write — unless the author
 *    is editing it (the file wins; what they commit goes instead), or an edit
 *    of theirs is still on its way (the server took the drawer's words first,
 *    so theirs are the newer).
 *
 * Either way, the server holds these words for the step now.
 */
export function noteStepEdited(
  live: LiveRecord,
  event: { id?: unknown; text?: unknown; source?: unknown },
  book: LineBook,
): LiveRecord {
  const id = String(event.id ?? '');
  const text = cleanStepText(event.text);
  if (id === '' || text === '') return live;
  book.told.set(id, text);
  if (event.source === 'editor') book.fromFile.add(id);
  else book.fromFile.delete(id);
  const lines = live.slots.filter((s) => s.kind === 'mine' && s.dropped === undefined && s.cleared !== true && s.wrote !== '');
  let slots = live.slots;
  if (event.source === 'editor') {
    // The edit of ours it answers: the one that went with these words — an
    // echo of an older edit of the line does not answer the newer one.
    const k =
      lines.find((s) => s.unacked === true && s.stepId === id && s.sentText === text) ??
      lines.find((s) => s.unacked === true && s.sentText === text);
    if (k) slots = slots.map((s) => (s === k ? { ...s, unacked: false, stepId: id } : s));
    // A reworded line sent back to the model's words (an undo of the
    // rewording, or the words typed again): the server released the edit —
    // the step is the model's again, and so is its line, which the recording
    // writes (and the model may rewrite) as any other. Not while another line
    // of the author's stands for the same step: that one holds it.
    const shared = (x: RecordSlot): boolean =>
      x.kind === 'mine' && x.key !== k?.key && x.stepId === id && x.wrote !== '' && x.dropped === undefined;
    if (
      k &&
      k.origin === 'edit' &&
      k.moved === undefined &&
      k.editOf === text &&
      cleanAuthorLine(mineLineText(k)) === text &&
      k.key &&
      !slots.some(shared)
    ) {
      book.told.delete(id);
      book.fromFile.delete(id);
      return absorbLine({ ...live, slots }, k.key);
    }
  }
  // Words from the file are that line's: never put on another one (two lines
  // can stand for one step — the model rewrote the step one was being edited
  // for, and the author reworded its new line too).
  if (event.source === 'editor') return slots === live.slots ? live : { ...live, slots };
  // The line standing for the step takes the drawer's or the panel's words
  // for it — unless an edit of the author's is on its way (the server heard
  // these first, so theirs are the newer), or they have changed the line since
  // the recording last held it (the file wins: `followDeclined`).
  const k = slots.find((s) => s.kind === 'mine' && s.dropped === undefined && s.cleared !== true && s.wrote !== '' && s.stepId === id && hasStep(s));
  // A line that took in a line from outside the block never takes words from
  // elsewhere: they would write over the author's line inside it.
  const keeps = (s: RecordSlot): boolean => changedSince(s) || s.joined !== undefined;
  if (k && k.unacked !== true && keeps(k) && cleanAuthorLine(mineLineText(k)) !== text && cleanAuthorLine(mineLineText(k)) === k.sentText) {
    // The file wins, and its words already went: they go again (after these),
    // or the server would keep words the file does not have.
    return { ...live, slots: slots.map((s) => (s === k ? { ...s, resend: true } : s)) };
  }
  if (!k || k.unacked === true || keeps(k)) return slots === live.slots ? live : { ...live, slots };
  const follow = cleanAuthorLine(mineLineText(k)) === text ? undefined : text;
  if (follow === k.follow) return slots === live.slots ? live : { ...live, slots };
  return {
    ...live,
    slots: slots.map((s) => {
      if (s !== k) return s;
      const next: RecordSlot = { ...s };
      if (follow === undefined) delete next.follow;
      else next.follow = follow;
      return next;
    }),
  };
}

/** The author has changed a line of theirs since the recording last held it:
 *  they are editing it, or its words or any of it read otherwise now. */
function changedSince(s: RecordSlot): boolean {
  return beingEdited(s) || (s.recAs !== undefined && s.wrote !== s.recAs);
}

/**
 * Newer words for a step from the drawer or the panel (`record:edited`) that a
 * line of the author's standing for it will NOT take, because they have
 * changed the line since the recording last held it: its key, for the one
 * sentence the log says about it — or null. The file wins; what they leave on
 * the line goes to the server as their edit when they leave it.
 */
export function followDeclined(live: LiveRecord, event: { id?: unknown; text?: unknown; source?: unknown }): string | null {
  if (event.source === 'editor') return null;
  const id = String(event.id ?? '');
  const text = cleanStepText(event.text);
  const k = live.slots.find((s) => s.kind === 'mine' && s.dropped === undefined && s.cleared !== true && s.wrote !== '' && s.stepId === id && hasStep(s));
  if (!k || k.unacked === true || !(changedSince(k) || k.joined !== undefined) || cleanAuthorLine(mineLineText(k)) === text) return null;
  return k.key ?? null;
}

/**
 * A step was restored (`record:dropped` `dropped: false`, the panel's Restore):
 * its line, if the author had deleted it, is no longer kept out of the drafts.
 */
export function noteStepRestored(id: string, book: LineBook): void {
  book.deleted.delete(id);
  const waiting = book.queue.findIndex((q) => q.id === id);
  if (waiting >= 0) book.queue.splice(waiting, 1);
}

/** The author's lines in the recorded block, in order — for the panel's tests
 *  and the log. */
export function authorLinesOf(live: LiveRecord): Array<{
  key: string;
  line: string;
  status: 'typing' | 'sent' | 'kept';
  stepId?: string;
  inDraft: boolean;
  dropped?: 'hidden' | 'left';
  /** A recorded line the author reworded (absent: a line they typed). */
  origin?: 'edit';
  /** Taken out by the empty draft. */
  cleared?: boolean;
  /** An `edit-step` went for it and is not answered yet. */
  unacked?: boolean;
}> {
  return live.slots
    .filter((s) => s.kind === 'mine')
    .map((s) => ({
      key: s.key ?? '',
      // A line taken out of the file: as it read when it was.
      line: s.dropped === 'hidden' || s.cleared === true ? unitLine(s.hiddenText ?? '') : mineLineText(s),
      status: s.status ?? 'typing',
      ...(s.stepId !== undefined && { stepId: s.stepId }),
      inDraft: s.inDraft === true,
      ...(s.dropped !== undefined && { dropped: s.dropped }),
      ...(s.origin !== undefined && { origin: s.origin }),
      ...(s.cleared === true && { cleared: true }),
      ...(s.unacked === true && { unacked: true }),
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

/**
 * A recorded line the author moved (`RecordSlot.moved`), at `at`, reading
 * `unit`: the step `id`'s line, with its words — nothing to send for it. The
 * recording no longer writes its words; its number stays the recording's.
 * `held`: the draft last written holds the step (a line moved among the
 * recorded ones); `waiting`: not yet (a deleted step's line put back, whose
 * restore is on its way).
 */
function movedLine(at: number, unit: string, lineEnd: boolean, id: string, moved: 'waiting' | 'held'): RecordSlot {
  const words = cleanAuthorLine(unitLine(unit));
  return {
    kind: 'mine',
    start: at,
    end: at + unit.length,
    lineEnd,
    wrote: unit,
    key: nextMineKey(),
    origin: 'edit',
    stepId: id,
    status: 'sent',
    editOf: words,
    sentText: words,
    recAs: unit,
    inDraft: moved === 'held',
    moved,
  };
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
  emptyPoint?: () => { at: number; lineEnd: boolean } | null,
): RecordSlot[] | null {
  // The run — the block, and the author's lines in it — as one text: it is
  // one run of whole lines in the file.
  const run = sortSlots(snapshot).filter(isRun);
  const params = snapshot.find((s) => s.kind === 'params');
  // A run with nothing in it — every recorded line deleted — that renumbered
  // later steps: found by those, the run where the steps go after the anchor.
  if (!run.some((s) => s.wrote !== '')) {
    if (!emptyPoint || (params && params.wrote !== '')) return null;
    if (!snapshot.some((s) => s.kind === 'tail' && s.placed !== false && s.wrote !== s.original)) return null;
    const point = emptyPoint();
    if (!point) return null;
    const regions: RecordSlot[] = run.map((part) => ({ ...part, start: point.at, end: point.at, lineEnd: point.lineEnd, touched: false }));
    if (params) {
      const p = paramsPoint();
      if (p === null || p.lineEnd !== params.lineEnd) return null;
      regions.push({ ...params, start: p.at, end: p.at, touched: false });
    }
    const tails = placeTails(
      snapshot.filter((s) => s.kind === 'tail').map((t) => ({ ...t, placed: false })),
      current,
      model,
      point.at,
      section,
    );
    if (!tails.some((t) => t.placed === true && t.wrote !== t.original)) return null;
    return sortSlots([...regions, ...tails]);
  }
  // A run whose every recorded line the author reworded or deleted is their
  // lines alone: found by them.
  const block = run.find((s) => s.wrote !== '');
  if (!block) return null;
  const runText = run.map((s) => s.wrote).join('');
  let blockAt: number | null;
  if (runText.trim() === '') {
    // Blank lines alone (every step's line deleted or emptied, the author's
    // blank lines left): never one place in a file by their text — looked for
    // where the steps go, after the anchor, and taken only if they are there.
    const point = emptyPoint?.() ?? null;
    blockAt = point !== null && point.lineEnd === block.lineEnd && current.startsWith(runText, point.at) ? point.at : null;
  } else {
    blockAt = uniqueAt(current, runText, block.lineEnd);
  }
  if (blockAt === null) return null;
  const blockEnd = blockAt + runText.length;
  if (anchorIdx >= 0) {
    const lead = block.lineEnd ? (block.wrote.startsWith('\r\n') ? 2 : 1) : 0;
    const first = lineAtOffset(lineStarts(current), blockAt + lead);
    // The run starts below the anchor line — or ON it, when its first line is
    // a recorded line that took the anchor line in (Backspace at its start).
    if (first < anchorIdx || (first === anchorIdx && !(block.kind === 'mine' && block.joined === 'above'))) return null;
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
  // Lines the author moved out of the recording are theirs.
  for (const line of record.outside ?? []) now.set(line, (now.get(line) ?? 0) - 1);
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
   * (stories/steptix-record-toolbar.md §"Steps typed in the editor"): the
   * removal takes out the recording's parts and keeps the author's — but for
   * a recorded line they reworded (`edit`), which goes with the recording's
   * steps, as Cancel takes it. Absent: all of `block` is the recording's.
   */
  parts?: Array<{ text: string; mine: boolean; edit?: boolean }>;
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
    ...(mine && {
      parts: run
        .filter((s) => s.wrote !== '')
        .map((s) => ({ text: s.wrote, mine: s.kind === 'mine', ...(s.kind === 'mine' && goesWithSteps(s) && { edit: true }) })),
    }),
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
        // A reworded line is taken out with the recording's lines.
        kind: p.mine && p.edit !== true ? ('mine' as const) : ('block' as const),
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
 *  - a project (a `steptix.config.json` inside the workspace): its `tests.dir`,
 *    or — when it declares none — the server's default, `./tests` beside the
 *    config (src/config/defaults.ts);
 *  - no project: the fixed folder `steptix.testsGlob` starts in
 *    (`tests/**\/*.md` → `tests/`), which is where Test Explorer looks; else
 *    the workspace folder itself (the default glob, `**\/*.md`, starts there).
 *
 * A folder outside the workspace is refused — before anything is created —
 * since Steptix can neither discover nor record a test there.
 */
export function newTestDir(args: {
  /** The project's `steptix.config.json`, or null when there is none. */
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
        `a test there. Open the project's folder, or point tests.dir in steptix.config.json inside it.`,
    };
  }
  return { dir, source };
}

/** Folders the project search never enters, besides every dot-folder (`.git`,
 *  `.vscode-test`, `.live-shards`, a worktree under `.claude/`…): installed
 *  packages and build output, which carry other projects' configs. */
const PROJECT_SEARCH_SKIP = new Set(['node_modules', 'dist']);

/**
 * Every `steptix.config.json` inside `root`, for Record New Test when the active
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
      if (e.isFile() && e.name === 'steptix.config.json') found.push(path.join(dir, e.name));
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
  // stories/steptix-record-toolbar.md §"Pause and resume, in detail".
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
      // Each step's id (stories/steptix-record-edit-steps.md): what the ✕ on
      // a Steps so far row, and the file's lines, name a step by.
      const rawIds = Array.isArray(event['ids']) ? event['ids'] : null;
      const stepIds: string[] = [];
      if (rawIds) raw.forEach((_, i) => kept.has(i) && stepIds.push(typeof rawIds[i] === 'string' ? (rawIds[i] as string) : ''));
      const edited = [
        ...new Set(
          (Array.isArray(event['edited']) ? event['edited'] : [])
            .map((idx) => kept.get(Number(idx)))
            .filter((at): at is number => at !== undefined),
        ),
      ].sort((a, b) => a - b);
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
        // Locking (stories/steptix-record-toolbar.md §"Locking in"): the
        // steps the model can no longer rewrite — the engine's business, kept
        // for the log, never shown to the author (stories/steptix-record-edit-steps.md,
        // decision 1).
        ...(Number.isFinite(locked) && locked > 0 && { locked: Math.min(Math.floor(locked), steps.length) }),
        ...(authored.length > 0 && { authored, authoredIds }),
        ...(rawIds && { ids: stepIds }),
        ...(edited.length > 0 && { edited }),
      };
      // A deleted step the draft holds again was restored.
      if (state.deletedSteps && rawIds) {
        const back = state.deletedSteps.filter((d) => stepIds.includes(d.id));
        if (back.length > 0) state.deletedSteps = state.deletedSteps.filter((d) => !stepIds.includes(d.id));
      }
      return true;
    }
    case 'record:edited': {
      // `✎ Edited step 4` where it happened — a marker: an edit is not undone
      // from the panel (the file's Ctrl+Z undoes a file edit).
      const id = String(event['id'] ?? '');
      const text = cleanStepText(event['text']);
      if (id === '' || text === '') return false;
      const raw = event['source'];
      const source: 'toolbar' | 'editor' | 'panel' | undefined =
        raw === 'toolbar' || raw === 'editor' || raw === 'panel' ? raw : undefined;
      const at = state.draft?.ids?.indexOf(id) ?? -1;
      const n = state.actions.filter((a) => a.kind === 'edit').length;
      const last = state.actions[state.actions.length - 1];
      state.actions.push({
        id: `edit-${n + 1}`,
        kind: 'edit',
        action: false,
        summary: at >= 0 ? `Edited step ${at + 1}: ${text}` : `Edited a step: ${text}`,
        atMs: last?.atMs ?? 0,
        dropped: false,
        ...(source !== undefined && { source }),
      });
      return true;
    }
    case 'record:writing':
      state.phase = 'finishing';
      state.pickArmed = false;
      return true;
    case 'record:paused': {
      // stories/steptix-record-toolbar.md §"Pause and resume, in detail":
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
      // A drop or restore made in the browser (the toolbar's Undo, Restore),
      // or a step deleted or restored anywhere, with the actions it stood for
      // (stories/steptix-record-edit-steps.md, decision 2).
      const id = String(event['id'] ?? '');
      const dropped = event['dropped'] === true;
      let changed = markStepDeleted(state, id, dropped);
      const row = state.actions.find((a) => a.id === id);
      if (row && row.kind !== 'pause' && row.kind !== 'resume' && row.kind !== 'edit' && row.dropped !== dropped) {
        row.dropped = dropped;
        changed = true;
      }
      const actions = Array.isArray(event['actions']) ? event['actions'].map(String) : [];
      for (const actionId of actions) {
        const a = state.actions.find((x) => x.id === actionId);
        if (!a || a.kind === 'pause' || a.kind === 'resume' || a.kind === 'edit' || a.kind === 'step') continue;
        if (dropped) {
          if (a.dropped && a.droppedWith === id) continue;
          a.dropped = true;
          a.droppedWith = id;
          changed = true;
        } else if (a.dropped) {
          a.dropped = false;
          delete a.droppedWith;
          changed = true;
        }
      }
      return changed;
    }
    default:
      return false;
  }
}

/**
 * A step deleted from, or restored to, Steps so far (the panel's ✕ and
 * Restore, the drawer's, a line deleted in the file): a deleted one stays in
 * the list, struck, with Restore, after the step that was before it — or at
 * the top — until it is restored. Returns whether the list changed. An id that
 * is no step of the draft (an action's) changes nothing.
 */
export function markStepDeleted(state: RecordingPanelState, id: string, deleted: boolean): boolean {
  const list = state.deletedSteps ?? [];
  const at = list.findIndex((d) => d.id === id);
  if (!deleted) {
    if (at < 0) return false;
    state.deletedSteps = list.filter((d) => d.id !== id);
    return true;
  }
  if (at >= 0) return false;
  const draft = state.draft;
  const idx = draft?.ids?.indexOf(id) ?? -1;
  let text: string | undefined;
  let after: string | null = null;
  if (draft && idx >= 0) {
    text = draft.steps[idx];
    after = idx > 0 ? (draft.ids?.[idx - 1] || null) : null;
  } else {
    // An author's step the draft has no ids for: its row says what it was.
    const row = state.actions.find((a) => a.id === id && a.kind === 'step');
    const k = draft?.authoredIds?.indexOf(id) ?? -1;
    if (!row || !draft || k < 0) return false;
    const i = draft.authored?.[k] ?? -1;
    text = row.summary;
    after = i > 0 ? (draft.ids?.[i - 1] || null) : null;
  }
  if (text === undefined) return false;
  state.deletedSteps = [...list, { id, text, after }];
  return true;
}

/**
 * Steps so far, marked: "yours" on each step the author wrote
 * (stories/steptix-record-toolbar.md) or reworded
 * (stories/steptix-record-edit-steps.md). No step is locked against the
 * author, so no lock is shown (decision 1).
 */
export function draftStepMarks(
  draft: { steps: string[]; authored?: number[]; edited?: number[] } | null,
): Array<{ yours: boolean }> {
  if (!draft) return [];
  const yours = new Set([
    ...(Array.isArray(draft.authored) ? draft.authored : []),
    ...(Array.isArray(draft.edited) ? draft.edited : []),
  ]);
  return draft.steps.map((_, i) => ({ yours: yours.has(i) }));
}

/**
 * The author's steps of the last draft, placed in the RESULT: `record:result`
 * does not say which of its steps are the author's, and the result is the
 * last draft with its open steps brought up to date — the author's steps are
 * all in the locked part, so each is where the draft had it, or (a model that
 * moved things anyway) the next step on with the same text. One not found is
 * left out: its line in the file is then the author's text beside the result.
 * A step the draft named no id for keeps '' as its id: the writer then knows
 * its line by the text it was sent as.
 */
export function authoredForResult(
  draft: { steps: string[]; authored?: number[]; authoredIds?: string[] } | null,
  resultSteps: unknown[],
): { authored: number[]; authoredIds: string[] } {
  const result = (Array.isArray(resultSteps) ? resultSteps : []).map(cleanStepText).filter((s) => s !== '');
  const authored: number[] = [];
  const authoredIds: string[] = [];
  if (!draft?.authored) return { authored, authoredIds };
  let from = 0;
  draft.authored.forEach((idx, k) => {
    const id = draft.authoredIds?.[k] ?? '';
    const text = draft.steps[idx];
    if (text === undefined) return;
    let at = result[idx] === text && idx >= from ? idx : -1;
    if (at < 0) at = result.indexOf(text, from);
    if (at < 0) return;
    authored.push(at);
    authoredIds.push(id);
    from = at + 1;
  });
  return { authored, authoredIds };
}

/**
 * The last draft's step ids placed in the RESULT, which carries none
 * (stories/steptix-record-edit-steps.md): each step is where the draft had
 * it, or — the final call moved or rewrote around it — the next step on with
 * the same text; one the final call rewrote has no id ('') and is the
 * recording's line. `edited` places the author's rewordings the same way.
 * Both absent when the draft carried no ids (a server that predates editing).
 * The writer holds the lines of the author's that stand for steps by these,
 * so a reworded line is never written a second time beside the result's step.
 */
export function idsForResult(
  draft: { steps: string[]; ids?: string[]; edited?: number[] } | null,
  resultSteps: unknown[],
): { ids?: string[]; edited?: number[] } {
  if (!draft || !Array.isArray(draft.ids)) return {};
  const result = (Array.isArray(resultSteps) ? resultSteps : []).map(cleanStepText).filter((s) => s !== '');
  const ids = result.map(() => '');
  const edited: number[] = [];
  const reworded = new Set(draft.edited ?? []);
  let from = 0;
  draft.steps.forEach((text, i) => {
    const id = draft.ids?.[i] ?? '';
    let at = result[i] === text && i >= from ? i : -1;
    if (at < 0) at = result.indexOf(text, from);
    if (at < 0) return;
    ids[at] = id;
    if (reworded.has(i)) edited.push(at);
    from = at + 1;
  });
  return { ids, edited };
}

/**
 * The result as the one-shot insertion at Stop puts it in, for a recording
 * that gave up on its file (SPEC-record-steps.md §7.4): every step but the
 * author's own whose line is still in the file. A line typed in the file is
 * the author's and stays where they put it, so its step is not inserted a
 * second time beside it. `result.authored` / `authoredIds` place the author's
 * steps in the result (`authoredForResult`); a line is known by the id its
 * step has, or — no id — by the text it was sent as, and found in `current`
 * as it last read or by that text. `kept`: the steps left out.
 */
export function oneShotSteps(
  live: LiveRecord | null,
  current: string,
  result: { steps: unknown[]; authored?: number[]; authoredIds?: string[]; ids?: string[] },
): { steps: string[]; kept: string[]; groups: Array<{ steps: string[]; after: number | null }> } {
  const steps = cleanSteps(result.steps);
  const lines = current.split(/\r?\n/);
  const inFile = (s: RecordSlot): boolean => {
    const line = mineLineText(s);
    return (line.trim() !== '' && lines.includes(line)) || (s.sentText !== undefined && lines.some((l) => cleanAuthorLine(l) === s.sentText));
  };
  const skip = new Set<number>();
  // A recorded line the author reworded, still in the file: its step (the
  // result's, by the id the last draft gave it) is that line.
  const stepIds = Array.isArray(result.ids) ? result.ids : [];
  for (const s of live?.slots ?? []) {
    if (s.kind !== 'mine' || s.origin !== 'edit' || !s.stepId || s.dropped === 'hidden' || s.cleared === true) continue;
    const idx = stepIds.indexOf(s.stepId);
    if (idx >= 0 && inFile(s)) skip.add(idx);
  }
  const done = (): { steps: string[]; kept: string[]; groups: Array<{ steps: string[]; after: number | null }> } => {
    recordedStillThere(live, current, steps, skip);
    return {
      steps: steps.filter((_, i) => !skip.has(i)),
      kept: steps.filter((_, i) => skip.has(i)),
      groups: insertionGroups(live, current, steps, skip),
    };
  };
  const mines = (live?.slots ?? []).filter((s) => s.kind === 'mine' && s.origin !== 'edit' && s.status === 'sent' && s.dropped !== 'hidden');
  if (mines.length === 0) return done();
  const used = new Set<RecordSlot>();
  const authored = result.authored ?? [];
  const ids = result.authoredIds ?? [];
  authored.forEach((idx, k) => {
    const id = ids[k];
    const text = steps[idx];
    if (text === undefined) return;
    const mine =
      (id ? mines.find((s) => !used.has(s) && s.stepId === id) : undefined) ??
      mines.find((s) => !used.has(s) && !s.stepId && s.sentText === text);
    if (!mine) return;
    used.add(mine);
    if (inFile(mine)) skip.add(idx);
  });
  // A line sent that no draft held (just before Stop): the result's first
  // step with its text that is not an author's step of the draft.
  const theirs = new Set(authored);
  for (const mine of mines) {
    if (used.has(mine) || !inFile(mine)) continue;
    const idx = steps.findIndex((t, i) => t === mine.sentText && !theirs.has(i) && !skip.has(i));
    if (idx >= 0) skip.add(idx);
  }
  return done();
}

/**
 * Belt and braces for the one-shot insertion (review of 0.5.158: P6, P7, D3
 * duplicated steps at Stop): a step of the result whose line the recording
 * wrote is still in the file, word for word (its number aside), is not put in
 * a second time. A line counts when the recording wrote lines with those
 * words in any state it kept, and the file has more lines with them than it
 * had before the recording began — as many steps as that are left out.
 */
function recordedStillThere(live: LiveRecord | null, current: string, steps: string[], skip: Set<number>): void {
  if (!live) return;
  const written = new Set<string>();
  for (const state of [live, ...live.history]) {
    for (const s of state.slots) {
      if (s.kind !== 'block') continue;
      for (const u of unitsOf(s.wrote, s.lineEnd)) {
        const w = cleanAuthorLine(unitLine(u));
        if (w !== '') written.add(w);
      }
    }
  }
  const count = (text: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) {
      const w = cleanAuthorLine(line);
      if (w !== '') out.set(w, (out.get(w) ?? 0) + 1);
    }
    return out;
  };
  const now = count(current);
  const before = count(live.base);
  const left = new Map<string, number>();
  for (const [w, n] of now) if (written.has(w)) left.set(w, n - (before.get(w) ?? 0));
  // What the other rules left out already used up lines with its words.
  skip.forEach((i) => {
    const w = steps[i];
    if (w !== undefined && left.has(w)) left.set(w, left.get(w)! - 1);
  });
  steps.forEach((w, i) => {
    if (skip.has(i) || (left.get(w) ?? 0) <= 0) return;
    left.set(w, left.get(w)! - 1);
    skip.add(i);
  });
}

/**
 * Where the one-shot insertion puts what is left of the result, when steps of
 * it are left out because their lines are still in the file: each run of
 * steps going in, after the line of the step left out just before it in the
 * result (the 0-based line), or — none before it — at the anchor (`null`), so
 * the file keeps the result's order around the lines still there. A left-out
 * step's line is the first one, below the one before, with its words (a line
 * of the author's by what it reads, else by what it went as).
 */
function insertionGroups(
  live: LiveRecord | null,
  current: string,
  steps: string[],
  skip: Set<number>,
): Array<{ steps: string[]; after: number | null }> {
  const lines = current.split(/\r?\n/).map((l) => cleanAuthorLine(l));
  const mines = (live?.slots ?? []).filter((s) => s.kind === 'mine' && s.wrote !== '');
  const groups: Array<{ steps: string[]; after: number | null }> = [];
  let after: number | null = null;
  let group: { steps: string[]; after: number | null } | null = null;
  steps.forEach((step, i) => {
    if (!skip.has(i)) {
      if (!group) {
        group = { steps: [], after };
        groups.push(group);
      }
      group.steps.push(step);
      return;
    }
    // Its words, or those of a line of the author's that is this step.
    const words = new Set([step, ...mines.filter((m) => m.sentText === step || m.editOf === step).map((m) => cleanAuthorLine(mineLineText(m)))]);
    const from = after === null ? 0 : after + 1;
    let at = lines.findIndex((l, k) => k >= from && words.has(l));
    if (at < 0) at = lines.findIndex((l) => words.has(l));
    // Its line not found: the run around it stays one (two runs after the
    // same line would go in the other way round).
    if (at < 0) return;
    after = at;
    group = null;
  });
  return groups;
}
