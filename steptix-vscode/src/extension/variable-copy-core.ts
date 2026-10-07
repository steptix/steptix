/**
 * What "Copy" on a variable puts on the clipboard, what the status bar says
 * about it, and what "Export as CSV" writes — for both places Steptix lists
 * variables: the Variables TreeView (variables-view.ts) and the Test Runner
 * panel's Variables section, whose menu posts `copyVariable` /
 * `exportVariables` messages to the host rather than touching the clipboard or
 * the disk itself. One rule for both, here.
 *
 * Pure (no `vscode`) so tests/variable-copy.test.js can pin the text.
 *
 * A masked value copies UNMASKED. The mask keeps a credential off the screen —
 * a screen share, a screenshot in an issue — and a row of stars on the
 * clipboard would be no use to anyone, so copying is the deliberate way to get
 * the real value. The menu says so ("Copy Unmasked Value"), and so does the
 * status bar, so a secret never reaches the clipboard without the word
 * "unmasked" in front of the person who put it there.
 *
 * The CSV export is the other way round: it writes what the view SHOWS,
 * masked. A file is an artefact — it gets attached, committed, mailed — and
 * the rule everywhere else in Steptix is that what reaches a file is masked
 * (the report stars a value even `## Config`'s `unmask` shows live).
 */
import { PARAM_REF_RE } from './env-data-definition-core.ts';

/**
 * - `value`: the value as captured, unmasked.
 * - `name`: the name as the row shows it.
 * - `placeholder`: `{{name}}`, ready to paste into a step.
 */
export type VariableCopyKind = 'value' | 'name' | 'placeholder';

export interface VariableCopyTarget {
  name: string;
  /** The raw value. Absent for a row the panel lists before a run has given
   *  it one — a declared `[output: x]` that nothing has captured yet. */
  value?: string;
  /** Whether the row shows the value masked. Only changes the wording. */
  masked?: boolean;
}

/** The text for the clipboard, or an explanation of why there is none. */
export type VariableCopyResult =
  | { ok: true; text: string; status: string }
  | { ok: false; status: string };

/** Matches the expander's per-instance rename of a skill's own variables —
 *  the same prefix variables-view.ts hides at the test frame. */
const SKILL_INTERNAL_PREFIX = /^__skill\d+_/;

/**
 * The `{{…}}` placeholder that reads `name`, or null when no placeholder can.
 *
 * Inside a skill frame the view lists the skill's own variables under their
 * expanded names (`__skill2_query`); the skill file says `{{query}}`, so that
 * is what pasting there needs. A name the runtime grammar cannot reference —
 * a record column with a space or a dash in it, a second dot — gets null
 * rather than a placeholder that would be typed into the page as text.
 */
export function placeholderFor(name: string): string | null {
  const local = name.replace(SKILL_INTERNAL_PREFIX, '');
  const text = `{{${local}}}`;
  const matches = [...text.matchAll(PARAM_REF_RE)];
  return matches.length === 1 && matches[0]![0] === text ? text : null;
}

export function variableCopy(kind: VariableCopyKind, target: VariableCopyTarget): VariableCopyResult {
  const { name } = target;
  switch (kind) {
    case 'name':
      return { ok: true, text: name, status: `Steptix: copied the name ${name}` };
    case 'placeholder': {
      const placeholder = placeholderFor(name);
      if (placeholder === null) {
        return { ok: false, status: `Steptix: ${name} cannot be written as a {{placeholder}}` };
      }
      return { ok: true, text: placeholder, status: `Steptix: copied ${placeholder}` };
    }
    case 'value': {
      if (target.value === undefined) {
        return { ok: false, status: `Steptix: ${name} has no value yet` };
      }
      const which = target.masked ? 'the unmasked value' : 'the value';
      const empty = target.value === '' ? ' (empty)' : '';
      return { ok: true, text: target.value, status: `Steptix: copied ${which} of ${name}${empty}` };
    }
  }
}

/** One exported variable: the name, and the value as the view SHOWS it. */
export interface VariableExportRow {
  name: string;
  value: string;
}

/** A field quoted only when it must be: a comma, a quote or a line break. */
function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The rows as CSV (RFC 4180): a `name,value` header, CRLF line ends, and a
 * value written exactly as given — a whole JSON table stays one field, quotes
 * doubled. Starts with a UTF-8 byte-order mark: without one, Excel reads the
 * file in the ANSI code page and garbles any non-ASCII value.
 */
export function variablesCsv(rows: readonly VariableExportRow[]): string {
  const lines = ['name,value', ...rows.map((r) => `${csvField(r.name)},${csvField(r.value)}`)];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** The save dialog's suggested name: `login.md` → `login-variables.csv`. */
export function variablesCsvFileName(testPath: string | null): string {
  const base = testPath?.split(/[\\/]/).pop()?.replace(/\.md$/i, '');
  return `${base || 'steptix'}-variables.csv`;
}
