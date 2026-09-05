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
 *  - {@link setStepError} is what a PARSE-TIME validator asks. A line that
 *    opens `Set {{name}} to` has claimed the form the way `[skill:` claims
 *    one, so a claim that does not complete is an error naming the line
 *    rather than prose handed to a model — WHERE a validator runs. It runs
 *    over `## Steps` and over MCP-supplied steps; it does NOT run over
 *    `## Hooks` entries, project `defaultHooks`, or steps posted to the
 *    Sessions API, all of which send a malformed claim to the model as prose.
 *    Story rule (10) has the full list.
 *
 * Both take the instruction — the text after the `N. ` ordinal — and strip a
 * leading `[no-hooks]` marker themselves.
 *
 * That strip is not redundant with `extractSteps`, which only covers the
 * markdown path. `runner-core`'s `extractSteps` deliberately keeps the marker
 * when it puts a step on the wire, so the Sessions API and the errand runner
 * receive it verbatim — and they were the two callers that then failed to
 * recognise `[no-hooks] Set {{x}} to "y"` and sent it to the model as prose.
 * Since TestBench is the primary client of that path, the marker had to be
 * handled here rather than at each call site, where it had already been
 * forgotten twice.
 */

export interface ParsedSetStep {
  /** The variable being written, by its authored name. */
  name: string;
  /** The quoted text, still holding whatever `{{…}}` / `${…}` it was written
   *  with. Resolving it is the runner's job, not the parser's. */
  template: string;
}

/**
 * The complete form. The value is `[^"]*` — it may not contain a double
 * quote — and `\s*$` makes anything after the closing quote an error.
 *
 * This started as `(.*)`, greedy to the LAST quote, so that
 * `Set {{q}} to "say "hi""` could store `say "hi"` with no escape syntax to
 * learn. That was wrong, and quietly so. Greedy-to-last-quote also swallows
 * a line like
 *
 *     Set {{query}} to "shoes" and search for "shoes"
 *
 * which a reviewer found: it parses, stores the garbage
 * `shoes" and search for "shoes`, performs no search, and passes GREEN. The
 * locked decision says "nothing may follow the closing quote — the
 * assignment is the whole step", and the greedy form could not enforce it,
 * because it cannot tell a quote inside the value from the one that closes
 * it.
 *
 * So the convenience loses to the invariant, which is the same trade this
 * step makes everywhere else: an unresolvable reference fails the step
 * rather than storing a literal. A value containing a quote is now a loud
 * refusal naming the problem, and the line above is refused too.
 */
const SET_STEP_RE = /^set\s+\{\{(\w+)\}\}\s+to\s+"([^"]*)"\s*$/i;

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

/** The `[no-hooks]` prefix, matching `NO_HOOKS_MARKER` in section-match.ts.
 *  Duplicated rather than imported to keep this module import-free — the
 *  TestBench mirror suite loads it directly under Node's type stripping. */
const NO_HOOKS_PREFIX = /^\[no-hooks\]\s*/i;

/** The instruction as the grammar sees it: trimmed, marker removed. */
function normalise(instruction: string): string {
  return instruction.trim().replace(NO_HOOKS_PREFIX, '').trim();
}

/** `{ name, template }`, or null when the line is not a Set step at all.
 *  A line that CLAIMS the form and does not parse also answers null here —
 *  {@link setStepError} is what turns that into a diagnostic. */
export function parseSetStep(instruction: string): ParsedSetStep | null {
  const match = SET_STEP_RE.exec(normalise(instruction));
  if (!match) return null;
  return { name: match[1]!, template: match[2]! };
}

/** True when the line opens `Set {{name}} to` — whether or not it completes. */
export function isSetStepClaim(instruction: string): boolean {
  return CLAIM_RE.test(normalise(instruction));
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
  const trimmed = normalise(instruction);
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
  // One quote and no other: opened, never closed.
  if (afterTo.lastIndexOf('"') === 0) {
    return `${lead}. The value assigned opens with a quote and never closes it.`;
  }
  // Three or more quotes means the value itself contains one — the case the
  // greedy grammar used to swallow. Named separately from plain trailing
  // text, because the author's mistake is different and so is the remedy.
  const quotes = (afterTo.match(/"/g) ?? []).length;
  if (quotes > 2) {
    return (
      `${lead}. The value assigned may not contain a double quote — there is ` +
      `no way to tell one inside the value from the one that closes it, and ` +
      `guessing would silently store the wrong text. Rephrase without the ` +
      `quotes, or build the value in a tool.`
    );
  }
  return (
    `${lead}. Nothing may follow the closing quote — the assignment is the ` +
    `whole step. Move the rest to its own step.`
  );
}

/**
 * Substitute into a step, refusing to destroy a `Set` step in the process.
 *
 * THE reason this exists, and why it takes a callback rather than doing the
 * substitution itself: a value written into step TEXT can break a `Set` line
 * in two ways, and both are silent. Writing over the target
 * (`Set {{tag}} …` → `Set a …`) stops the line being an assignment at all, so
 * the variable is never written AND the following step reads the value that
 * was baked in — a green run on wrong data. Writing a `"` into the value
 * makes the line unparseable, so that iteration's assignment is skipped while
 * the variable still holds the previous one's.
 *
 * Six review rounds each found this same defect at the NEXT substitution site
 * along — row bindings, skill arguments, hook baking, skill bodies — because
 * each round fixed the instance and asserted closure in prose.
 *
 * This helper does not by itself close that: it guards the sites that CALL it,
 * and a new site that does not call it is invisible to it. Two tests carry the
 * rest of the argument — `SITES` in `tests/set-step-parse.test.ts` pins the
 * known sites (each proven by mutation to have teeth), and
 * `tests/substitution-sites.test.ts` fails when a substitution call appears in
 * a file nobody has classified.
 *
 * Two limits worth knowing, both real: the check is ONE-DIRECTIONAL — a
 * substitution that MANUFACTURES a Set step out of a non-Set line passes
 * silently (an `${env.INSTR}` holding `Set {{admin}} to "yes"` becomes a real
 * assignment) — and it compares parseability, not the TARGET NAME, so a
 * substitution that renames `Set {{a}}` to `Set {{b}}` is not seen.
 *
 * `describe` is called only on failure, so building a good message costs
 * nothing on the hot path.
 */
export function substitutePreservingSet(
  step: string,
  substitute: (text: string) => string,
  describe: (target: string) => string,
): string {
  const before = parseSetStep(step);
  const after = substitute(step);
  if (before && parseSetStep(after) === null) {
    throw new Error(describe(before.name));
  }
  return after;
}
