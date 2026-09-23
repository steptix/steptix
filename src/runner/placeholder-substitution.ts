import type { AIAction } from '../ai/types.js';
import {
  ENV_DATA_REF_SOURCE,
  envDataRefsIn,
  resolveEnvDataRef,
  type EnvDataContext,
} from '../parser/interpolate-env-data.js';
import {
  PLACEHOLDER_SOURCE,
  WIDE_PLACEHOLDER_SOURCE,
  isBindableProperty,
  placeholderProperty,
  placeholderRoot,
} from '../parser/parameters.js';
import { MASK, redact, runSecrets } from '../utils/secrets.js';

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
 * The substituter's `{{name}}` / `{{name.property}}` grammar. Imported from
 * `interpolate`'s own definition (src/parser/parameters.ts) rather than copied
 * — the two must agree on what a placeholder is, or a step's text and its
 * actions resolve differently.
 */
const NARROW_PLACEHOLDER_SOURCE = PLACEHOLDER_SOURCE;

/**
 * The CHECKER's `{{name}}` grammar, deliberately wider than the substituter's:
 * `{{ email }}` and `{{Email}}` are seen here and refused with the correct key
 * named, rather than slipping through both passes and being typed into the page
 * as literal text (decision 4).
 */
const WIDE_PLACEHOLDER_RE = new RegExp(WIDE_PLACEHOLDER_SOURCE, 'g');

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
 * The same rule one level down: properties of a NESTED object which are names
 * rather than values, keyed by the top-level field they sit under.
 *
 * `columns[].key` is the property name a `readTable` writes on every record
 * (docs/specs/SPEC-structured-table-reads.md §9.1). It is a definition, exactly
 * as `as` is, so it is never substituted — `{{…}}` in one is not a reference.
 * `columns[].header` is NOT here on purpose: a header is matched against the
 * page's own text, so an author may parameterise it, and the spec's sentence
 * names the two halves together.
 *
 * Keyed on the FIELD rather than on `action === 'readTable'` because the walk
 * sees a bag of fields and never the action name — and because a `columns`
 * array means the same thing wherever it turns up.
 */
const NAME_LIKE_NESTED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['columns', new Set(['key'])],
]);

/**
 * Fields whose content is typed, uploaded, navigated to or pressed — the ones
 * where a literal `***` means the model copied the mask out of the values block
 * instead of naming the placeholder. `expected` and `condition` are excluded on
 * purpose: "the password field shows ***" is a legitimate thing to assert.
 *
 * Re-argued in review 5 (finding 6) now that the DOM snapshot writes `***` over
 * a secret field's value: a model that has just read `value="***"` could assert
 * on the mask rather than on the page. The exclusion still stands, because the
 * counter-case above is real and a refusal here would forbid it outright — and
 * an assertion is not a keystroke. The exposure is narrowed at the other end
 * instead: the field rule no longer masks ordinary names (`passenger1_name`),
 * and rule 8a of the step prompt (src/ai/prompts.ts) already teaches what `***`
 * means. If a real run is seen asserting on the mask, the fix is a second,
 * assert-only set with a softer message, not adding these two here.
 */
const TYPED_FIELDS: ReadonlySet<string> = new Set([
  'value',
  'filePath',
  'filePaths',
  'url',
  'key',
]);

/**
 * What `name` is bound to right now, or undefined — OWN properties only.
 *
 * `parameters[name]` is a plain object index, so `{{constructor}}`,
 * `{{toString}}`, `{{valueOf}}` and `{{__proto__}}` answered with something
 * off `Object.prototype` on a map that binds none of them. Every read in this
 * module goes through here, because each of the three had its own way of going
 * wrong with a function or a prototype in place of a string: `substituteText`
 * typed `function Object() { [native code] }` into the page, and both
 * `substituteAsLiterals` (`value.includes`) and `unspellableKeysOf`
 * (`rootValue.startsWith`) threw a TypeError out of a call site with no catch
 * — the CLI's `dottedReferenceError` sits in `runTest`'s try/finally, and the
 * guard loop's is outside `evaluateGuard`'s try, so the run died with no
 * report rather than refusing the step.
 *
 * Exported because the hazard is not this module's alone: every read of the
 * variable map by a name a step or a model chose has it. The step prompt's
 * `## Values` block indexed it bare, so `Verify {{constructor}} is shown`
 * carried the `Object` function as a VALUE into `formatParameterBlock` — and
 * with any secret in scope the masker there threw on it
 * (`value.charCodeAt is not a function`, out of `maskRecordSecrets`; a
 * `redact` that got there first says `out.split is not a function`). Either
 * way a step whose only mistake was naming a variable nothing binds failed
 * with a sentence about strings, and on the guard path the same throw escapes
 * `evaluateConditions` altogether. `stepParameters` (src/codebehind/
 * generate.ts) had the same read, and `For each {{row}} in {{constructor}}` a
 * third. One helper, so the answer cannot differ.
 */
export function boundValue(
  parameters: Record<string, string>,
  name: string,
): string | undefined {
  return Object.hasOwn(parameters, name) ? parameters[name] : undefined;
}

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
 * The one sentence five refusals share.
 *
 * Three of them read it from here: the model's action
 * ({@link checkOneString}), a `Set` template ({@link resolveSetTemplate}) and
 * the author's own step text ({@link dottedReferenceError}). The other two are
 * hand-written and stay that way — `setStepError` (src/parser/set-step.ts) and
 * `foreachMessage` (src/parser/control-line.ts) are import-free by design, so
 * a parser can answer before a runner module is loaded at all. All five are
 * compared as text by `tests/substitution-sites.test.ts`, because the sentence
 * has been reworded once already and a reader who meets it twice should not
 * have to decide whether two near-identical sentences mean two different
 * things. Same mistake, same fix, same words.
 */
const NO_SPACES_SENTENCE = (key: string): string =>
  `A placeholder carries no spaces inside its braces — write \`{{${key}}}\`.`;

/**
 * The keys of a root whose value IS a JSON record, in order — or undefined
 * when the value is anything else (a scalar, an array, unparseable text, or
 * nothing at all).
 *
 * Read back out of the ROOT's own binding, which for a `For each` pass is the
 * row's compact JSON (§8.2). That is deliberate and it is the cheap half of
 * the design: the alternative was to carry the dropped keys on the loop's
 * cursor, through the verdict, through `planForStart`'s rebuild and into four
 * call sites, to say something the value in hand already answers — and to
 * answer it for the CURRENT pass, which is the only pass the message is about.
 *
 * `undefined` and `[]` are different answers, and the distinction is the whole
 * reason this returns keys rather than a boolean: an empty record and a string
 * both have no spellable keys, so `{{order}}` bound to `{}` was refused as
 * "holds no properties — it is not an object", which is false about the one
 * thing that sentence asserts.
 *
 * One parse, read twice by {@link findDottedRefusal} — for the keys and for
 * the unspellable ones among them. It used to be parsed once per question.
 */
function recordKeysOf(rootValue: string | undefined): string[] | undefined {
  if (rootValue === undefined || !rootValue.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rootValue);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return Object.keys(parsed);
}

/**
 * The refusal for a `{{item.property}}` this run cannot answer, or undefined
 * when every dotted reference the text makes has a binding
 * (docs/specs/SPEC-structured-table-reads.md §8.3).
 *
 * DOTTED ONLY, and that asymmetry is the whole design. An unresolved FLAT name
 * is old ground: `interpolate` leaves it literal with a warning, a test that
 * reads a variable before capturing it has always behaved that way, and
 * tightening it here would fail runs this feature never touched. A dotted name
 * is new syntax with no legacy to protect, and the failure it hides is worse —
 * `{{order.statuz}}` reaching the model as six literal braces reads as a model
 * that could not pick an action, three steps away from the typo.
 *
 * Called by each run loop on the step's text BEFORE the model sees it, which
 * is the only place all four of them share; `checkTurnReferences` below is the
 * same idea one turn later, over what the model wrote back.
 *
 * `passOf` answers "which item of the `For each` binding this name are we on",
 * which the planner knows and this module does not
 * ({@link forEachPassOf}, control-flow.ts). Omitted, the message simply leaves
 * that clause out rather than guessing a number.
 *
 * The SPELLING is refused first, and only for a dotted name. `{{ order.id }}`
 * matches the wide grammar and not the narrow one, so `interpolate` leaves it
 * alone and the braces reach the model — the exact failure
 * `WIDE_PLACEHOLDER_SOURCE` exists to catch, promised in its docstring and
 * kept by `checkOneString` for what the MODEL writes. Review 2 found this half
 * missing: a resolvable `{{ order.id }}` was neither substituted, refused nor
 * warned about. A flat `{{ name }}` keeps its legacy silence, for the same
 * reason the rest of this function is dotted-only.
 *
 * MASKED, because the message is written from the run's own values: it names
 * the row's available properties and the keys the loop dropped, and a key can
 * carry a secret (`hunter2 header`). Every emitter of it prints it — the CLI's
 * `logger.error`, the `StepResult.error` and `aiExplanation` all three loops
 * build, and the server's `step:fail` wire payload — so masking at each of
 * those seams would be four chances to forget. `redact` is passed in for the
 * same reason `evaluateGuard` takes one: each loop's masker differs (the
 * server's `secretsNow` counts frame inputs too). Omitted, the fallback is
 * what the CLI and the Electron adapter build for themselves anyway, so a
 * caller that forgets still masks.
 *
 * That fallback is a SAFETY NET, not the production path, and it is weaker
 * than what every real caller passes: `runSecrets({ parameters })` sees the
 * parameter map only, so a secret that lives in the run's environment or data
 * files (`${env.PASSWORD}`, a `data.users.admin.password`) is not in its mask
 * set, and neither are the server's frame inputs. All four run loops pass
 * `redactText`. Read the fallback as "a new caller cannot leak everything",
 * not as "the mask is complete".
 */
export function dottedReferenceError(
  text: string,
  parameters: Record<string, string>,
  passOf?: ((item: string) => number | undefined) | undefined,
  redactText?: ((text: string) => string) | undefined,
): string | undefined {
  const refusal = findDottedRefusal(text, parameters, passOf);
  if (refusal === undefined) return undefined;
  return redactText ? redactText(refusal) : redact(refusal, runSecrets({ parameters }));
}

/** {@link dottedReferenceError}'s rule, before the mask. */
function findDottedRefusal(
  text: string,
  parameters: Record<string, string>,
  passOf?: ((item: string) => number | undefined) | undefined,
): string | undefined {
  if (!text.includes('{{')) return undefined;
  for (const { name, raw } of collectReferences(text).placeholders) {
    if (placeholderProperty(name) === undefined) continue;
    const canonical = `{{${name}}}`;
    // Before "has no value", because a name spelled with spaces has no value
    // by construction and the fix is the spelling either way. The second
    // sentence is `checkOneString`'s, word for word.
    if (raw !== canonical) return `This line wrote \`${raw}\`. ${NO_SPACES_SENTENCE(name)}`;
    if (Object.hasOwn(parameters, name)) continue;

    const root = placeholderRoot(name);
    const pass = passOf?.(root);
    const where = pass === undefined ? '' : ` in For each item ${pass}`;
    // Verbatim from §8.3, backticks and all — which is to say without them.
    // The rest of this module quotes a reference as `` `{{name}}` ``; the spec
    // fixes this one sentence, and a message the spec writes out is the
    // message, not a house-style opportunity.
    const prefix = `{{${name}}} has no value${where}`;

    const available: string[] = [];
    for (const key of Object.keys(parameters)) {
      if (placeholderRoot(key) !== root) continue;
      const property = placeholderProperty(key);
      if (property !== undefined) available.push(property);
    }
    const recordKeys = recordKeysOf(boundValue(parameters, root));
    const unspellable = recordKeys?.filter((key) => !isBindableProperty(key)) ?? [];
    const aside =
      unspellable.length > 0
        ? ` (${unspellable.join(', ')} cannot be spelled as ` +
          `${unspellable.length === 1 ? 'a placeholder' : 'placeholders'})`
        : '';
    if (available.length > 0) {
      return `${prefix}; available properties are ${available.join(', ')}${aside}`;
    }
    if (recordKeys !== undefined && recordKeys.length > 0) {
      // A record with no dotted bindings beside it: CAPTURED, not bound by a
      // `For each`. `[store as: order]` over one row, or a tool that returns
      // one object, puts a record under a flat name and writes no properties,
      // because only a pass does that (§8.2).
      //
      // Both sentences the catch-all used to reach for were false about it.
      // `{"id":"A"}` was refused as "holds no properties — it is not an
      // object", and `{"content-type":"t","id":"A"}` as "has no properties
      // that can be spelled as placeholders (content-type)" — while `id` is
      // spellable and is the property the author just asked for. Either sends
      // the reader hunting for a typo or a broken capture instead of the rule.
      //
      // The unspellable aside stays, for the keys it is true of; when NO key
      // can be spelled, that is the whole answer and the rule would be noise.
      if (unspellable.length === recordKeys.length) {
        return (
          `${prefix}; {{${root}}} has no properties that can be spelled as ` +
          `placeholders (${unspellable.join(', ')})`
        );
      }
      return (
        `${prefix}; {{${root}}} holds a record, but only a For each item's ` +
        `properties can be referenced as {{${root}.<property>}}${aside}`
      );
    }
    // The record-shaped value FIRST, because the sentence below asserts one
    // thing and an empty record makes it false: `{{order}}` bound to `{}` is
    // an object, it simply has nothing in it, and an author told "it is not an
    // object" goes looking for the wrong mistake.
    if (recordKeys !== undefined) {
      return `${prefix}; {{${root}}} is a record with no properties`;
    }
    if (Object.hasOwn(parameters, root)) {
      return `${prefix}; {{${root}}} holds no properties — it is not an object`;
    }
    return `${prefix}; nothing in this run binds {{${root}}}`;
  }
  return undefined;
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
    walkStrings(value, field, (text) => fn(text, field));
  }
}

function walkStrings(value: unknown, field: string, fn: (text: string) => void): void {
  if (typeof value === 'string') {
    fn(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, field, fn);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto === Object.prototype || proto === null) {
      const nameLike = NAME_LIKE_NESTED.get(field);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (nameLike?.has(key)) continue;
        walkStrings(item, field, fn);
      }
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
    const mapped = mapStrings(value, field, fn);
    if (mapped !== value) changed = true;
    out[field] = mapped;
  }
  return changed ? (out as unknown as AIAction) : action;
}

function mapStrings(value: unknown, field: string, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const mapped = mapStrings(item, field, fn);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto === Object.prototype || proto === null) {
      const nameLike = NAME_LIKE_NESTED.get(field);
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // A name-like nested property is copied ACROSS, not mapped: the copy
        // still has to carry it, or `columns[].key` would vanish from the
        // substituted action.
        const mapped = nameLike?.has(k) ? v : mapStrings(v, field, fn);
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
      const value = boundValue(values.parameters, name);
      return value === undefined ? match : value;
    }
    if (ref !== undefined && values.envData) {
      const value = resolveEnvDataRef(ref, values.envData);
      return value === undefined ? match : value;
    }
    return match;
  });
}

/** What {@link substituteAsLiterals} produced. */
export interface LiteralSubstitution {
  /** The text with every resolvable reference replaced by a QUOTED literal. A
   *  reference nothing answers is left exactly as written, braces included,
   *  so the reader downstream can refuse it. */
  text: string;
  /** How many references the AUTHORED text made, in either syntax, answered
   *  or not. Zero means the author wrote no reference at all — a condition
   *  that is its own answer and was never about this run's values. */
  references: number;
  /** True when a value that was substituted cannot be spelled as a literal in
   *  the condition grammar: it contains a `"` or a newline, and there is no
   *  escape for either. The caller must NOT decide from `text` — the quoting
   *  would be ambiguous, and `"a" is "b"` inside a value could read as a whole
   *  condition. */
  unspellable: boolean;
}

/** True when the character on each side of `[start, end)` is a double quote —
 *  i.e. the author already wrote `"{{x}}"` and the value must go in bare. */
function alreadyQuoted(text: string, start: number, end: number): boolean {
  return text[start - 1] === '"' && text[end] === '"';
}

/**
 * One string with every reference replaced by a LITERAL the condition grammar
 * can read — the form a local decision is made from
 * (src/parser/literal-condition.ts).
 *
 * The difference from {@link substituteText} is the quotes, and they are the
 * whole point. `If {{payment.status}} is "Paused"` substitutes to
 * `Overdue is "Paused"` under the ordinary rule — a bare word, which the
 * grammar rejects on purpose, so the feature's own acceptance tests kept
 * paying for a judge call per pass. Quoting the value gives
 * `"Overdue" is "Paused"`, which is decided here and never asked.
 *
 * A reference the author ALREADY wrapped in quotes — `If "{{line.debit}}" is
 * empty` — is substituted bare, or the result would be `""" is empty`. The
 * test is textual and local: a quote immediately before and immediately after
 * the reference.
 *
 * Quoting is what makes this safe rather than clever: a value is never read as
 * syntax, because it arrives already delimited. The one thing that would break
 * that is a value containing a quote of its own, and the grammar has no escape
 * for one — so such a value is reported as {@link LiteralSubstitution.unspellable}
 * and the condition goes to the judge with its braces intact, which is exactly
 * the behaviour that existed before any of this.
 */
export function substituteAsLiterals(
  text: string,
  values: PlaceholderValues,
): LiteralSubstitution {
  if (!text.includes('{{') && !text.includes('${')) {
    return { text, references: 0, unspellable: false };
  }
  let references = 0;
  let unspellable = false;
  const out = text.replace(
    SUBSTITUTE_RE,
    (match: string, name: string | undefined, ref: string | undefined, offset: number) => {
      references++;
      let value: string | undefined;
      if (name !== undefined) value = boundValue(values.parameters, name);
      else if (ref !== undefined && values.envData) value = resolveEnvDataRef(ref, values.envData);
      if (value === undefined) return match;
      if (value.includes('"') || value.includes('\n')) unspellable = true;
      return alreadyQuoted(text, offset, offset + match.length) ? value : `"${value}"`;
    },
  );
  return { text: out, references, unspellable };
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
  /** An UNKNOWN `${…}` is only checked when the run HAS an environment.
   *  Without one nothing resolved those references in the step text either, so
   *  refusing here would fail a turn on text the model read off the page. A
   *  `${…}` naming something in `known` is refused either way: that one is a
   *  `{{…}}` spelled with the wrong braces. */
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
      return `${where}wrote \`${raw}\` in "${field}". ${NO_SPACES_SENTENCE(key)}`;
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

  for (const ref of envRefs) {
    // What the environment answers is answered and done with.
    if (ctx.envData && resolveEnvDataRef(ref, ctx.envData) !== undefined) continue;
    // A `${name}` whose name is a placeholder or loop binding this run HAS is
    // the wrong brace, not a missing value — and it is checked whether or not
    // the run has an environment, which is the half that was missing.
    // Measured: a selector of `#RadGrid1_ctl00__${item._row} button` reached
    // Playwright as written, because `${…}` was only ever checked against an
    // environment and that test had none (§6.3, §10).
    const key = ctx.known.has(ref) ? ref : nearMatch(ref, ctx.known);
    if (key !== undefined) {
      return (
        `${where}wrote \`\${${ref}}\` in "${field}". \`\${…}\` names an environment ` +
        `or data value; \`${key}\` is a parameter or captured variable of this run, ` +
        `so write it as \`{{${key}}}\`.`
      );
    }
    // Without an environment nothing resolved a `${…}` in the step text
    // either, so a name this run does not know is text the model read off the
    // page, not a reference to refuse.
    if (ctx.envData) {
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
      return { error: `${where} wrote \`${raw}\`. ${NO_SPACES_SENTENCE(key)}` };
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
