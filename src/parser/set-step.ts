/**
 * `Set {{name}} to "template"` — the one step that writes a variable from
 * other variables, with no model and no page (stories/variable-assignment.md).
 *
 * Two entry points, and the split is the story's:
 *
 *  - {@link parseSetStep} is what every RUNTIME asks. It answers "is this a
 *    Set step, and what does it say" and nothing else, so a loop can branch on
 *    it cheaply. It is matched against the step as AUTHORED, before `{{…}}`
 *    interpolation — a target that had already been substituted would read as
 *    its own value on the second run (§Locked, "Recognised on the authored
 *    line").
 *  - {@link setStepError} is what every PARSE-TIME validator asks. A line that
 *    opens `Set {{name}} to` has claimed the form the way `[skill:` claims one,
 *    so a claim that does not complete is an error naming the line rather than
 *    prose handed to a model.
 *
 * Both take the instruction — the text after the `N. ` ordinal, with any
 * `[no-hooks]` marker already stripped (`extractSteps` does that before
 * anything here runs).
 */

export interface ParsedSetStep {
  /** The variable being written, by its authored name. */
  name: string;
  /** The quoted text, still holding whatever `{{…}}` / `${…}` it was written
   *  with. Resolving it is the runner's job, not the parser's. */
  template: string;
}

/**
 * The complete form. `(.*)` is greedy, so it runs to the LAST quote on the
 * line: `Set {{q}} to "say "hi""` stores `say "hi"` and there is no escape
 * syntax to learn. `\s*$` is what makes trailing text an error rather than a
 * second, silent writer.
 */
const SET_STEP_RE = /^set\s+\{\{(\w+)\}\}\s+to\s+"(.*)"\s*$/i;

/**
 * The CLAIM: `Set {{name}} to` at the start of the instruction.
 *
 * Deliberately wider than {@link SET_STEP_RE} on the braces (`{{ name }}`
 * matches here and not there), so a spacing slip gets the error that names it
 * rather than falling through to prose — the same courtesy
 * `checkOneString`'s wide placeholder grammar pays a model
 * (src/runner/placeholder-substitution.ts).
 *
 * The trailing `to` is load-bearing and is why this can claim at all. `Set
 * {{field}} using the dropdown` names no destination and stays prose; only the
 * `to` says an assignment was meant.
 */
const CLAIM_RE = /^set\s+\{\{\s*\w+\s*\}\}\s+to\b/i;

/** The braces as written, for an error that can quote them back. */
const TARGET_BRACES_RE = /^set\s+(\{\{\s*(\w+)\s*\}\})/i;

/** `{ name, template }`, or null when the line is not a Set step at all.
 *  A line that CLAIMS the form and does not parse also answers null here —
 *  {@link setStepError} is what turns that into a diagnostic. */
export function parseSetStep(instruction: string): ParsedSetStep | null {
  const match = SET_STEP_RE.exec(instruction.trim());
  if (!match) return null;
  return { name: match[1]!, template: match[2]! };
}

/** True when the line opens `Set {{name}} to` — whether or not it completes. */
export function isSetStepClaim(instruction: string): boolean {
  return CLAIM_RE.test(instruction.trim());
}

/**
 * The parse error for a line that claims the form and does not complete it,
 * or null when the line either parses or never claimed.
 *
 * `where` is appended verbatim (e.g. ` in tests/foo.md at line 7`) so one
 * message serves the markdown parser, the MCP assembler and anything else
 * that validates ahead of a run.
 */
export function setStepError(instruction: string, where = ''): string | null {
  const trimmed = instruction.trim();
  if (!isSetStepClaim(trimmed)) return null;
  if (parseSetStep(trimmed) !== null) return null;

  const lead = `Cannot parse the step "${trimmed}"${where}`;

  // Spacing inside the braces — the one near-miss worth naming on its own,
  // because the line looks right and `interpolate` would never have replaced
  // it either.
  const braces = TARGET_BRACES_RE.exec(trimmed);
  if (braces && braces[1] !== `{{${braces[2]}}}`) {
    return (
      `${lead}. A placeholder carries no spaces inside its braces — ` +
      `write \`Set {{${braces[2]}}} to "…"\`.`
    );
  }

  const afterTo = trimmed.replace(CLAIM_RE, '').trim();
  if (!afterTo.startsWith('"')) {
    return (
      `${lead}. The value assigned must be a double-quoted string: ` +
      `write \`Set {{name}} to "…"\`, with every variable it uses inside the ` +
      `quotes (\`Set {{reference}} to "Ref: {{account_number}}"\`). ` +
      `An unquoted value is prose about the page, which this step cannot run.`
    );
  }
  // One quote and no other: opened, never closed. Two or more means the value
  // is closed and something followed it — the full form requires the closing
  // quote to be the end of the line, so reaching here proves it was not.
  if (afterTo.lastIndexOf('"') === 0) {
    return `${lead}. The value assigned opens with a quote and never closes it.`;
  }
  return (
    `${lead}. Nothing may follow the closing quote — the assignment is the ` +
    `whole step. Move the rest to its own step.`
  );
}
