import type { AIAction } from '../ai/types.js';
import {
  ENV_DATA_REF_SOURCE,
  envDataRefsIn,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import { MASK } from '../utils/secrets.js';

/**
 * The model names the value it used; the executor puts the value in
 * (stories/placeholder-preserving-actions.md, decisions 3 and 4).
 *
 * The step prompt shows the AUTHORED step — `Enter the email {{email}}` — with
 * a `## Values` block saying what each reference holds, so the action the model
 * plans carries `"value": "{{email}}"` rather than the literal. Everything in
 * this module is what happens next, on the executor's side of that bargain:
 *
 *  - {@link checkTurnReferences} reads every reference in every action of a
 *    turn BEFORE any of them runs, and refuses the whole turn on one it cannot
 *    answer. Per turn, not per step: a `needs_reeval` second turn is checked
 *    when it arrives and the first turn's actions stand.
 *  - {@link substituteAction} returns a COPY with every string leaf resolved.
 *    The emitted object is never written to — the transcript, the recording
 *    and the cache keep it exactly as the model wrote it, which is the whole
 *    point of asking for the placeholder in the first place.
 *
 * Pure functions with no page, no config and no logger, so the rules can be
 * tested without a browser.
 */

/**
 * The substituter's `{{name}}` grammar. Deliberately identical to
 * `interpolate`'s (src/parser/parameters.ts) — the two must agree on what a
 * placeholder is, or a step's text and its actions resolve differently.
 */
const NARROW_PLACEHOLDER_SOURCE = '\\{\\{(\\w+)\\}\\}';

/**
 * The CHECKER's `{{name}}` grammar, deliberately wider than the substituter's:
 * `{{ email }}` and `{{Email}}` are seen here and refused with the correct key
 * named, rather than slipping through both passes and being typed into the page
 * as literal text (decision 4).
 */
const WIDE_PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** Both syntaxes in ONE pass, so substitution never re-scans what it inserted:
 *  a value that itself contains `{{` is inserted verbatim. Group 1 is a
 *  `{{name}}`, group 2 a `${…}` reference. */
const SUBSTITUTE_RE = new RegExp(`${NARROW_PLACEHOLDER_SOURCE}|${ENV_DATA_REF_SOURCE}`, 'g');

/**
 * Fields whose string is a NAME, not a value, and which the walk therefore
 * skips entirely: `as` defines a variable, `pattern` is a regular expression,
 * `action` and `against` are enum tags, `attribute` is a DOM attribute name.
 * A `{{…}}` in one of these is not a reference and must be neither refused nor
 * substituted (decisions 3 and 4).
 */
const NAME_LIKE_FIELDS: ReadonlySet<string> = new Set([
  'as',
  'pattern',
  'action',
  'against',
  'attribute',
]);

/**
 * Fields whose content is typed, uploaded, navigated to or pressed — the ones
 * where a literal `***` means the model copied the mask out of the values block
 * instead of naming the placeholder. `expected` and `condition` are excluded on
 * purpose: "the password field shows ***" is a legitimate thing to assert.
 */
const TYPED_FIELDS: ReadonlySet<string> = new Set([
  'value',
  'filePath',
  'filePaths',
  'url',
  'key',
]);

/** Everything a substitution needs: the live parameter map and, when the run
 *  has an environment, the context its `${…}` references resolve against. */
export interface PlaceholderValues {
  parameters: Record<string, string>;
  envData?: EnvDataContext | undefined;
}

/** What {@link collectReferences} found in one string. */
export interface CollectedReferences {
  /** `{{…}}` occurrences by the WIDE grammar. `raw` is the exact text matched,
   *  so the checker can tell `{{email}}` from `{{ email }}`. */
  placeholders: Array<{ name: string; raw: string }>;
  /** `${…}` references, as the bare name inside the braces (`data.url`). */
  envRefs: string[];
}

/** Every reference one string makes, in both syntaxes. */
export function collectReferences(text: string): CollectedReferences {
  const placeholders: Array<{ name: string; raw: string }> = [];
  for (const m of text.matchAll(WIDE_PLACEHOLDER_RE)) {
    placeholders.push({ name: m[1]!, raw: m[0] });
  }
  return { placeholders, envRefs: envDataRefsIn(text) };
}

/**
 * The names a step DEFINES by writing `store as {{x}}` / `save as {{x}}` in
 * prose. The bracketed `[store as: x]` form is `referencedVariableNames`'
 * `captures` half (src/skills/expander.ts); this covers the other spelling
 * `isExtractionStep` already recognises. A definition is not a reference: it
 * stays out of the values table and is never refused as unknown.
 */
export function inlineStoreAsNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:store|save)\s+(?:it\s+)?as\s+\{\{\s*(\w+)\s*\}\}/gi)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Visit every string leaf of an action — including array entries (`filePaths`)
 * and the nested objects of an `api_call` (`body`, `apiHeaders`) — with the
 * top-level field name each leaf sits under. {@link NAME_LIKE_FIELDS} are
 * skipped.
 */
export function walkActionStrings(
  action: AIAction,
  fn: (text: string, field: string) => void,
): void {
  for (const [field, value] of Object.entries(action as unknown as Record<string, unknown>)) {
    if (NAME_LIKE_FIELDS.has(field)) continue;
    walkStrings(value, (text) => fn(text, field));
  }
}

function walkStrings(value: unknown, fn: (text: string) => void): void {
  if (typeof value === 'string') {
    fn(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, fn);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto === Object.prototype || proto === null) {
      for (const item of Object.values(value as Record<string, unknown>)) walkStrings(item, fn);
    }
  }
}

/**
 * A copy of the action with every walked string leaf passed through `fn`.
 * Identity-preserving: an action nothing changed in is returned as itself, so a
 * turn with no placeholders allocates nothing and `emitted === substituted` is
 * a meaningful test.
 */
export function mapActionStrings(action: AIAction, fn: (text: string) => string): AIAction {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(action as unknown as Record<string, unknown>)) {
    if (NAME_LIKE_FIELDS.has(field)) {
      out[field] = value;
      continue;
    }
    const mapped = mapStrings(value, fn);
    if (mapped !== value) changed = true;
    out[field] = mapped;
  }
  return changed ? (out as unknown as AIAction) : action;
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const mapped = mapStrings(item, fn);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto === Object.prototype || proto === null) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const mapped = mapStrings(v, fn);
        if (mapped !== v) changed = true;
        out[k] = mapped;
      }
      return changed ? out : value;
    }
  }
  return value;
}

/** One string with both syntaxes resolved, in a single pass. A reference the
 *  values cannot answer is left as written — the checker has already refused
 *  the turn by the time this runs, so this is the belt to that braces. */
export function substituteText(text: string, values: PlaceholderValues): string {
  if (!text.includes('{{') && !text.includes('${')) return text;
  return text.replace(SUBSTITUTE_RE, (match: string, name: string | undefined, ref: string | undefined) => {
    if (name !== undefined) {
      const value = values.parameters[name];
      return value === undefined ? match : value;
    }
    if (ref !== undefined && values.envData) {
      const value = resolveEnvDataRef(ref, values.envData);
      return value === undefined ? match : value;
    }
    return match;
  });
}

/**
 * The action to act with: a copy of what the model emitted, with every string
 * leaf substituted. Never mutates its input — the recording, the transcript and
 * the cache keep the placeholder-bearing original (stories/upload-action.md
 * locked "the action object is never written to").
 */
export function substituteAction(action: AIAction, values: PlaceholderValues): AIAction {
  return mapActionStrings(action, (text) => substituteText(text, values));
}

/**
 * What a turn is checked against. `known` is what has a value right now;
 * `definedLater` is what some later step will capture, so the refusal can say
 * "not yet" rather than send the reader looking for a typo.
 */
export interface TurnReferenceContext {
  known: ReadonlySet<string>;
  definedLater?: ReadonlySet<string> | undefined;
  /** `${…}` is only checked when the run HAS an environment. Without one
   *  nothing resolved those references in the step text either, so refusing
   *  here would fail a turn on text the model read off the page. */
  envData?: EnvDataContext | undefined;
}

/**
 * The refusal message for a turn that references something this run cannot
 * answer, or `undefined` when every action of it is safe to run.
 *
 * Checked for the WHOLE turn before any of its actions runs (decision 4): one
 * bad reference and none of them execute, so a login step cannot type the
 * username and then fail on the password.
 */
export function checkTurnReferences(
  actions: readonly AIAction[],
  ctx: TurnReferenceContext,
): string | undefined {
  for (const action of actions) {
    // A `prompt` action executes nothing — it asks the user a question, and
    // its text is the model's own words about what it could not decide.
    if (action.action === 'prompt') continue;
    let refusal: string | undefined;
    walkActionStrings(action, (text, field) => {
      if (refusal !== undefined) return;
      refusal = checkOneString(text, field, action, ctx);
    });
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function checkOneString(
  text: string,
  field: string,
  action: AIAction,
  ctx: TurnReferenceContext,
): string | undefined {
  const where = `${describe(action)} `;
  if (TYPED_FIELDS.has(field) && text.trim() === MASK) {
    return (
      `${where}would enter "${MASK}" into "${field}". That is a mask over a secret ` +
      `value, never a value to type — write the placeholder the "## Values" block ` +
      `lists and the framework substitutes the real value.`
    );
  }

  const { placeholders, envRefs } = collectReferences(text);
  for (const { name, raw } of placeholders) {
    const canonical = `{{${name}}}`;
    if (raw !== canonical) {
      // Right name, wrong spelling: `{{ email }}` matches nothing the
      // substituter replaces, so the page would receive the braces.
      const key = ctx.known.has(name) ? name : (nearMatch(name, ctx.known) ?? name);
      return (
        `${where}wrote \`${raw}\` in "${field}". A placeholder carries no spaces ` +
        `inside its braces — write \`{{${key}}}\`.`
      );
    }
    if (ctx.known.has(name)) continue;
    const near = nearMatch(name, ctx.known);
    if (near !== undefined) {
      return (
        `${where}references \`${canonical}\` in "${field}", which is not a parameter ` +
        `or captured variable of this run — did you mean \`{{${near}}}\`?`
      );
    }
    if (ctx.definedLater?.has(name)) {
      return (
        `${where}references \`${canonical}\` in "${field}", which has no value yet: ` +
        `it is captured later in this test, or by a step this run skipped.`
      );
    }
    return (
      `${where}references \`${canonical}\` in "${field}", which is not a parameter ` +
      `or captured variable of this run.`
    );
  }

  if (ctx.envData) {
    for (const ref of envRefs) {
      if (resolveEnvDataRef(ref, ctx.envData) !== undefined) continue;
      return (
        `${where}references \`\${${ref}}\` in "${field}", which this run's ` +
        `environment and data files cannot resolve.`
      );
    }
  }
  return undefined;
}

function describe(action: AIAction): string {
  const label = action.description ? ` ("${action.description}")` : '';
  return `Step refused before any action ran: the "${action.action}" action${label}`;
}

/** A known name that differs only in case — what `{{Email}}` meant. */
function nearMatch(name: string, known: ReadonlySet<string>): string | undefined {
  const lower = name.toLowerCase();
  for (const candidate of known) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  return undefined;
}

/**
 * Replace `{{placeholder}}` tokens in an action with resolved parameter values.
 *
 * Lifted out of the step cache (which is being retired) and generalised from
 * the `value`/upload-path pair to the same deep walk the executor uses, because
 * a cached action can now carry a placeholder in any field the model chose to
 * name one in — `selector: "text={{plan}}"` most obviously.
 *
 * A path restored here is the parameter's RAW spelling, backslashes and all;
 * the executor and `step.filePath` normalise at the point of use, so both
 * spellings resolve to the same file.
 */
export function forwardInterpolate(
  actions: AIAction[],
  params: Record<string, string>,
): AIAction[] {
  if (Object.keys(params).length === 0) return actions;
  return actions.map((action) => substituteAction(action, { parameters: params }));
}

/**
 * The value a `Set {{name}} to "template"` step stores, or the reason it
 * cannot (stories/variable-assignment.md §Where it runs).
 *
 * Lives here rather than beside the parser because it is the same job the
 * executor's own substitution does — resolve both syntaxes over one string —
 * and because the refusals should read as one family with
 * `checkOneString`'s. A Set step names no action and no field, so the prefix
 * differs and the rest is deliberately word-for-word.
 *
 * The check is the whole point of the split: `substituteText` leaves a
 * reference it cannot answer exactly as written, which for an action is
 * belt-and-braces behind a turn the checker already refused, but for a Set
 * step would store the literal `{{acount_number}}` and pass the step green.
 *
 * `${…}` is checked only when the run HAS an environment, matching
 * `checkOneString`: without one, nothing resolved those references in any
 * other step's text either, so refusing here would single out the one step
 * that can see it.
 */
export function resolveSetTemplate(
  name: string,
  template: string,
  values: PlaceholderValues,
  definedLater?: ReadonlySet<string> | undefined,
): { value: string } | { error: string } {
  const where = `Set {{${name}}}: the template`;
  const known = new Set(Object.keys(values.parameters));
  const { placeholders, envRefs } = collectReferences(template);

  for (const { name: ref, raw } of placeholders) {
    const canonical = `{{${ref}}}`;
    if (raw !== canonical) {
      const key = known.has(ref) ? ref : (nearMatch(ref, known) ?? ref);
      return {
        error:
          `${where} wrote \`${raw}\`. A placeholder carries no spaces inside ` +
          `its braces — write \`{{${key}}}\`.`,
      };
    }
    if (known.has(ref)) continue;
    const near = nearMatch(ref, known);
    if (near !== undefined) {
      return {
        error:
          `${where} references \`${canonical}\`, which is not a parameter or ` +
          `captured variable of this run — did you mean \`{{${near}}}\`?`,
      };
    }
    if (definedLater?.has(ref)) {
      return {
        error:
          `${where} references \`${canonical}\`, which has no value yet: it is ` +
          `captured later in this test, or by a step this run skipped.`,
      };
    }
    return {
      error:
        `${where} references \`${canonical}\`, which is not a parameter or ` +
        `captured variable of this run.`,
    };
  }

  if (values.envData) {
    for (const ref of envRefs) {
      if (resolveEnvDataRef(ref, values.envData) !== undefined) continue;
      return {
        error:
          `${where} references \`\${${ref}}\`, which this run's environment ` +
          `and data files cannot resolve.`,
      };
    }
  }

  return { value: substituteText(template, values) };
}
