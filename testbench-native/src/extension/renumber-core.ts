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
 */
import { classifyLines, type LineKind } from 'ai-ui-automation-runner-core';

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
  const selected = new Set(selectedLines);
  const anyStepSelected = classified.some(
    (entry) => isRenumberable(entry.kind) && selected.has(entry.line),
  );

  const edits: RenumberEdit[] = [];
  let prev = 0;

  for (let i = 0; i < classified.length; i++) {
    const entry = classified[i]!;
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
      prev = Number(written);
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
 */
export function renumberText(text: string, selectedLines: number[]): string {
  const edits = new Map(
    computeRenumberEdits(text, selectedLines).map((edit) => [edit.line, edit] as const),
  );
  if (edits.size === 0) return text;
  // Split on '\n' alone so a CRLF file keeps the '\r' at the end of each
  // piece: an edit replaces only the leading digit run, exactly as the
  // editor-side range does, and line endings ride through untouched.
  return text
    .split('\n')
    .map((raw, i) => {
      const edit = edits.get(i + 1);
      return edit ? String(edit.ordinal) + raw.slice(edit.digits) : raw;
    })
    .join('\n');
}
