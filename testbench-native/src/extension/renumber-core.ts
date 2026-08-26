/**
 * The Renumber Steps numbering walk, with no VS Code dependency.
 *
 * Kept separate from `commands/index.ts` (which imports `vscode`) so every
 * case in stories/specs/step-renumbering.md §5 is testable under `node --test`,
 * which cannot load the `vscode` module.
 *
 * What counts as a step is runner-core's `classifyLines` and nothing else. An
 * ordinal is presentation — `extractSteps` strips it before anything reaches
 * the wire — so a command that invented its own grammar here would renumber
 * lines nothing runs, and claim they were steps by doing so.
 *
 * One correction on top of that grammar: `classifyLines` deliberately does not
 * track ``` fences, so a numbered line inside a fence within the Steps span
 * classifies as a step (step-region-core.ts documents the same blindness for
 * completion). Completion merely offers a dropdown there; this walk REWRITES
 * text, so fenced lines are made invisible to it — never rewritten, never
 * feeding the counter, and a fenced `###` never restarting it.
 */
import { classifyLines, type LineKind } from 'ai-ui-automation-runner-core';
// The `.ts` extension (not the usual `.js`) is load-bearing: this module and
// step-region-core are the vscode-free pair the `node --test` suite imports
// directly, and node's type stripping resolves specifiers literally — it
// never rewrites `.js` to `.ts`. esbuild and tsc (allowImportingTsExtensions)
// both accept the literal form, so all three toolchains agree on it.
import { isFenceDelimiter } from './step-region-core.ts';

export interface RenumberEdit {
  /** 1-based line. */
  line: number;
  /** Length of the leading digit run to replace. */
  digits: number;
  /** The ordinal to write. */
  ordinal: number;
}

/**
 * The leading digit run of a numbered item. `classifyLines` only calls a line
 * a step when it starts this way, so on a renumberable line the match is
 * total.
 */
const LEADING_DIGITS_RE = /^(\d+)\./;

/** Main flow and section bodies are numbered; nothing else is (spec §2). */
function isRenumberable(kind: LineKind): boolean {
  return kind === 'step' || kind === 'section-step';
}

/**
 * Per-line "inside a fenced code block" flags, by the same delimiter-toggle
 * rule as step-region-core's `isInsideFence` — one pass instead of its
 * per-call rescan. A delimiter line itself never classifies as a step or a
 * section heading, so its own flag is never consulted.
 */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    mask[i] = open;
    if (isFenceDelimiter(lines[i] ?? '')) open = !open;
  }
  return mask;
}

/**
 * The per-line ordinal rewrites that make `text` sequential, or `[]` when it
 * already is.
 *
 * `selectedLines` (1-based) narrows the *targets*; every renumberable line is
 * targeted when the selection names none of them, so an empty selection and a
 * prose-only one both mean "renumber the document". There is deliberately only
 * one numbering routine: renumber-all is this walk with everything targeted.
 *
 * A non-target step still feeds its ordinal **as written** into the counter —
 * that is what "continuing from the step above" means, and it is why a tail
 * selection after an insert produces the natural fix rather than restarting
 * at 1.
 */
export function computeRenumberEdits(text: string, selectedLines: number[]): RenumberEdit[] {
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(text);
  const fenced = fenceMask(lines);
  const selected = new Set(selectedLines);
  const anyStepSelected = classified.some(
    (entry) => !fenced[entry.line - 1] && isRenumberable(entry.kind) && selected.has(entry.line),
  );

  const edits: RenumberEdit[] = [];
  let prev = 0;

  for (let i = 0; i < classified.length; i++) {
    const entry = classified[i]!;
    // Fenced lines are literal text wearing a step's (or heading's) shape.
    if (fenced[i]) continue;
    // A section heading is what makes each body start from 1. A hashes-only
    // `###` is one of these too, so its body restarts as well — renumbering
    // does not care that the file would be refused at run time.
    if (entry.kind === 'section-heading') {
      prev = 0;
      continue;
    }
    if (!isRenumberable(entry.kind)) continue;

    const match = LEADING_DIGITS_RE.exec(lines[i] ?? '');
    // Total by construction; the guard keeps this function total rather than
    // relying on a grammar that lives in another package.
    if (!match) continue;
    const written = match[1]!;

    if (anyStepSelected && !selected.has(entry.line)) {
      // An ordinal beyond exact float range would poison every target below
      // it (`String(1e21 + 1)` is `"1e+21"`, which stops being a step at
      // all), so such a line keeps its text AND keeps out of the counter.
      const asWritten = Number(written);
      if (Number.isSafeInteger(asWritten)) prev = asWritten;
      continue;
    }

    const ordinal = prev + 1;
    prev = ordinal;
    // Compared as text, not as a number, so `007.` is rewritten to `7.`
    // rather than read as already correct.
    if (written !== String(ordinal)) {
      edits.push({ line: entry.line, digits: written.length, ordinal });
    }
  }

  return edits;
}

/**
 * `text` with those rewrites applied. Used by the unit tests so cases read as
 * before/after documents, and by nothing else — the command applies the edits
 * through the editor so the result is one undo step on the live buffer.
 *
 * Splits on '\n' alone so a CRLF file keeps the '\r' at the end of each
 * piece: an edit replaces only the leading digit run, exactly as the
 * editor-side range does, and line endings ride through untouched.
 */
export function renumberText(text: string, selectedLines: number[]): string {
  const lines = text.split('\n');
  for (const edit of computeRenumberEdits(text, selectedLines)) {
    lines[edit.line - 1] = String(edit.ordinal) + (lines[edit.line - 1] ?? '').slice(edit.digits);
  }
  return lines.join('\n');
}
