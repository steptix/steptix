import { unmarkLoopBindings } from '../utils/loop-bindings.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { logger } from '../utils/logger.js';

/**
 * Resolve parameter values using the priority chain:
 * 1. Inline value (already in the map)
 * 2. Environment variable ($VAR_NAME)
 * 3. Data file row (injected externally)
 * 4. Prompt user at runtime
 */
export async function resolveParameters(
  rawParams: Record<string, string>,
  dataRow?: Record<string, string>,
  promptUser = true,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(rawParams)) {
    resolved[key] = await resolveValue(key, rawValue, dataRow, promptUser);
  }

  // Merge any additional keys from the data row that weren't in rawParams
  if (dataRow) {
    for (const [key, value] of Object.entries(dataRow)) {
      if (!(key in resolved)) {
        resolved[key] = resolveEnvRef(key, value);
      }
    }
  }

  return resolved;
}

/**
 * Apply the `$VAR` rule to a value: a leading `$` names an environment
 * variable, anything else is a literal.
 *
 * A row's cell goes through this for the same reason a `## Parameters` value
 * does — so a password can live in `.env` and the table can hold
 * `$TEST_PASSWORD` rather than the secret. Until data-driven rows this was
 * skipped for rows entirely: `resolveValue` returned a row's cell before it
 * reached the `$` branch, so a `dataFile:` row holding `$TEST_PASSWORD` typed
 * that literal string into the page.
 *
 * An unset variable stays literal with a warning rather than becoming empty:
 * an empty password submits a form and fails somewhere far from the cause.
 */
function resolveEnvRef(key: string, rawValue: string): string {
  if (!rawValue.startsWith('$')) return rawValue;
  const envVarName = rawValue.slice(1);
  const envValue = process.env[envVarName];
  if (envValue !== undefined) {
    logger.debug(`Parameter "${key}" resolved from env var $${envVarName}`);
    return envValue;
  }
  logger.warn(`Environment variable $${envVarName} not set for parameter "${key}"`);
  return rawValue;
}

async function resolveValue(
  key: string,
  rawValue: string,
  dataRow?: Record<string, string>,
  promptUser = true,
): Promise<string> {
  // 1. Check data row override (highest priority for data-driven tests).
  //     The cell still goes through the `$VAR` rule — a row is a set of
  //     parameter values that happens to arrive in a table, and a cell that
  //     resolved differently from the `## Parameters` line it shadows would
  //     be a trap rather than a shorthand.
  if (dataRow && key in dataRow) {
    const dataValue = dataRow[key];
    if (dataValue !== undefined) {
      const resolvedValue = resolveEnvRef(key, dataValue);
      logger.debug(`Parameter "${key}" resolved from data row: ${maskSecret(key, resolvedValue)}`);
      return resolvedValue;
    }
  }

  // 2. Environment variable: value starts with $
  if (rawValue.startsWith('$')) {
    const envVarName = rawValue.slice(1);
    const envValue = process.env[envVarName];
    if (envValue !== undefined) {
      logger.debug(`Parameter "${key}" resolved from env var $${envVarName}`);
      return envValue;
    }
    logger.warn(`Environment variable $${envVarName} not set for parameter "${key}"`);
  }

  // 3. Inline value (non-empty, not a reference)
  if (rawValue && !rawValue.startsWith('$') && rawValue !== '{{' + key + '}}') {
    logger.debug(`Parameter "${key}" resolved from inline value`);
    return rawValue;
  }

  // 4. Prompt user
  if (promptUser) {
    const value = await promptForValue(key);
    return value;
  }

  logger.warn(`Parameter "${key}" could not be resolved, using empty string`);
  return '';
}

/**
 * Names that mark a value as a secret: hidden at the prompt, masked in logs,
 * redacted from a compile's recording. One rule, so a name the prompt hides
 * is a name the recording redacts.
 */
export function isSecretName(name: string): boolean {
  return /password|secret|token|key/i.test(name);
}

async function promptForValue(key: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const isSecret = isSecretName(key);
    const hint = isSecret ? ' (input hidden)' : '';
    const answer = await rl.question(`  Enter value for "${key}"${hint}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * The PROPERTY half of a dotted name, as a regex source: one identifier.
 *
 * Named because three things need the same answer — the grammar below, the
 * "more than one segment" warning further down, and {@link isBindableProperty}
 * asking whether a record's KEY could become one. Written out three times,
 * they are three mirrors of a rule that has already moved once.
 */
const PROPERTY_SEGMENT_SOURCE = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * The NAME inside a runtime placeholder: `name`, or `name.property` for one
 * direct property of an object a `For each` bound
 * (docs/specs/SPEC-structured-table-reads.md §8.3).
 *
 * This is the one definition; every other copy of the grammar in `src/`
 * imports it, because a step's text and its actions resolving differently is
 * the failure that keeps recurring. The copies that must stay hand-written —
 * TestBench's `env-data-completion-core.ts` / `env-data-definition-core.ts`,
 * which cannot import `src/` — are kept honest by
 * `tests/placeholder-dotted.test.ts`.
 *
 * The root segment stays `\w+` rather than tightening to the spec's
 * `[A-Za-z_][A-Za-z0-9_]*`: this feature ADDS a property segment, and
 * narrowing what a bare `{{1st}}` means is a separate decision with its own
 * blast radius (`data-rows.ts` already notes the looseness deliberately). The
 * PROPERTY segment does follow the identifier rule, because nothing accepted
 * one before and `{{order.1}}` is not a name anyone means.
 *
 * One property segment only. `{{order.address.city}}` matches nothing and is
 * left literal, exactly as it was before this existed (§8.2).
 */
export const PLACEHOLDER_NAME_SOURCE = `\\w+(?:\\.${PROPERTY_SEGMENT_SOURCE})?`;

/** `{{name}}` / `{{name.property}}`, no whitespace inside the braces. Group 1
 *  is the whole name, dot included. */
export const PLACEHOLDER_SOURCE = `\\{\\{(${PLACEHOLDER_NAME_SOURCE})\\}\\}`;

/** The same, tolerating whitespace inside the braces — what a CHECKER wants,
 *  so `{{ order.id }}` is seen and refused with the right name rather than
 *  slipping through and being typed into the page as literal text. */
export const WIDE_PLACEHOLDER_SOURCE = `\\{\\{\\s*(${PLACEHOLDER_NAME_SOURCE})\\s*\\}\\}`;

/** A fresh global matcher, because a module-level `/g` regex carries
 *  `lastIndex` between calls and `.test` would answer false every other time. */
export function placeholderRe(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, 'g');
}

/** The `name` half of a placeholder name: `order` for both `order` and
 *  `order.id`. What a rename or a scope lookup keys on — the property segment
 *  belongs to the object the name holds, not to the variable map. */
export function placeholderRoot(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/** The `property` half, or undefined for a flat name. */
export function placeholderProperty(name: string): string | undefined {
  const dot = name.indexOf('.');
  return dot === -1 ? undefined : name.slice(dot + 1);
}

/**
 * Write `value` into the live variable map under `name`
 * (docs/specs/SPEC-structured-table-reads.md §8.2).
 *
 * The ONE way anything writes that map: a `For each` pass, a `Set`, a `read` /
 * `count` / `readTable` capture, an `[input:]` answer, a tool's `setVar`, a
 * code-behind `setVar`. Two rules, and each of them shipped in one or two
 * writers out of nine before this existed.
 *
 * **Own property, not assignment.** `map[name] = value` hits
 * `Object.prototype`'s setter when `name` is `__proto__`, which silently
 * ignores a string: the step reported PASSED with the value in its `outputs`
 * while the map held nothing. `passBindings` builds a pass's bindings with a
 * computed key, so `For each {{__proto__}} in {{orders}}` produced exactly
 * that — the flat `{{__proto__}}` bound nothing while `{{__proto__.id}}`, an
 * ordinary key, resolved.
 *
 * **A rebind of a ROOT erases that root's dotted keys.** Only a `For each`
 * pass writes `item.property`, and they belong to the value the root held
 * when the pass bound it. So `Read the order id [store as: order]` after a
 * `For each {{order}} …` must not leave `order.id` holding the last pass's
 * id — it did, and `{{order.id}}` went on substituting a row the author had
 * just overwritten, with §8.3's refusal unable to fire on a key that was
 * still there.
 *
 * Guarded on the flat spelling, because a dotted name is a PROPERTY write
 * rather than a rebind: it must not erase its own siblings. Nothing writes one
 * today; the guard is so that a future writer cannot.
 *
 * Here, beside {@link placeholderRoot}, rather than in a run module: a `Set`
 * step needs it and has no page, no model and no cache, and importing it from
 * `control-runtime.ts` dragged the step executor — Playwright and the AI
 * client — into that module's import graph.
 */
export function bindVariable(
  map: Record<string, string>,
  name: string,
  value: string,
): void {
  Object.defineProperty(map, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  if (!name.includes('.')) clearDottedKeys(map, new Set([name]));
}

/**
 * Drop every `root.<anything>` binding for each of `roots`, leaving flat names
 * and every other root alone.
 *
 * {@link bindVariable}'s second half, exported because `applyPassBindings`
 * (src/runner/control-runtime.ts) needs it for a whole pass at once: it clears
 * every root the incoming bindings name BEFORE assigning any of them, since
 * the pass writes the flat name and its properties together and doing them one
 * at a time would depend on key order.
 *
 * Flat names are not this rule's business: a pass rebinds its own base name,
 * and clearing other flat variables would delete captures.
 */
export function clearDottedKeys(
  map: Record<string, string>,
  roots: ReadonlySet<string>,
): void {
  const dropped: string[] = [];
  for (const key of Object.keys(map)) {
    if (!key.includes('.')) continue;
    if (!roots.has(placeholderRoot(key))) continue;
    delete map[key];
    dropped.push(key);
  }
  // The mark and the entry go together: a later entry of the same name is
  // nobody's binding (src/utils/loop-bindings.ts).
  unmarkLoopBindings(map, dropped);
}

/** The property segment on its own, anchored — what a RECORD's key has to
 *  look like to become one. Built from the grammar's own source, so a key and
 *  a reference can never disagree about what is spellable. */
const PROPERTY_SEGMENT_RE = new RegExp(`^${PROPERTY_SEGMENT_SOURCE}$`);

/** The three names that are not data. `__proto__` on a plain object literal
 *  from `JSON.parse` is an own property rather than the setter, but a binding
 *  named after one of these travels into maps that are not — and a variable
 *  called `constructor` is a trap wherever it lands. */
const RESERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * Can this object key become a `{{item.key}}` binding
 * (docs/specs/SPEC-structured-table-reads.md §8.2)?
 *
 * Here rather than beside the `For each` that asks, because the answer is a
 * fact about the GRAMMAR: the property segment is defined two lines up, and a
 * second copy of `[A-Za-z_][A-Za-z0-9_]*` in the planner is the kind of mirror
 * that drifts. `dottedReferenceError` asks it too — it explains a missing
 * binding by naming the keys that could never have had one — so the rule has
 * two readers and one home.
 *
 * `content-type` and `Order ID` fail on the grammar; `constructor` passes the
 * grammar and fails here, which is the same answer to the same question for
 * the caller: this key binds nothing.
 */
export function isBindableProperty(key: string): boolean {
  return PROPERTY_SEGMENT_RE.test(key) && !RESERVED_PROPERTY_NAMES.has(key);
}

/**
 * Substitute {{placeholders}} in a string with resolved parameter values.
 *
 * `defines` names the placeholders this line WRITES rather than reads — a
 * `For each` header's item (`controlLineDefines`, src/parser/control-line.ts).
 * They are exempt from the warning only: a definition has no value yet by
 * definition, and warning about it fired on every correct table loop. A
 * PROPERTY of a defined name is exempt with it — `For each {{order}} in
 * {{orders}}, Click the row whose Order ID is "{{order.id}}"` is §4.6's own
 * recommended form, and a rule that exempted `{{order}}` alone went on
 * warning about `{{order.id}}` on the same line, on every loop entry. The
 * SUBSTITUTION is deliberately left alone — `{{payment}}` still resolves if
 * the map happens to hold it, exactly as before — because the loops use the
 * authored line for the guard row and the interpolated one for a partial
 * re-run probe, and changing what that probe sees is a different decision
 * from quietening a log line.
 */
export function interpolate(
  text: string,
  params: Record<string, string>,
  defines?: ReadonlySet<string> | undefined,
): string {
  warnMultiSegment(text);
  return text.replace(placeholderRe(), (match, key: string) => {
    // `hasOwn`, not `in`: `in` walks the prototype chain, so `{{constructor}}`
    // and `{{toString}}` substituted a stringified native function into the
    // step text on a map that binds neither. Same hazard, and the same
    // one-word fix, as `boundValue` in
    // [placeholder-substitution.ts](../runner/placeholder-substitution.ts).
    if (Object.hasOwn(params, key)) {
      return params[key] ?? match;
    }
    // The ROOT, so `{{order.id}}` is covered by a line that defines `order`.
    // A definition is flat by construction (a step writes a variable, never
    // one property of one), but the name is asked for as well as its root so
    // that a `defines` set which one day holds a dotted name still answers.
    if (!defines?.has(key) && !defines?.has(placeholderRoot(key))) {
      logger.warn(`Unresolved placeholder: {{${key}}}`);
    }
    return match;
  });
}

/** `{{a.b.c}}` — a root and TWO or more property segments, which is one more
 *  than the grammar has. Same segment source as the grammar, so "one more
 *  than" stays true of whatever the grammar accepts. */
const MULTI_SEGMENT_RE = new RegExp(
  `\\{\\{\\s*(\\w+(?:\\.${PROPERTY_SEGMENT_SOURCE}){2,})\\s*\\}\\}`,
  'g',
);

/**
 * Say something about `{{order.address.city}}`.
 *
 * It matches neither grammar, so it is neither substituted nor warned about as
 * unresolved — it is simply left in the step text, and reaches the model as
 * six literal braces. That is the quietest possible failure for what is
 * obviously an attempt at a reference: the author reads a step that did not
 * work and nothing anywhere says why.
 *
 * One property segment is the v1 rule
 * (docs/specs/SPEC-structured-table-reads.md §8.2), so the warning names the
 * rule rather than the typo. Once per distinct name per call: the same
 * reference twice in one line is one mistake.
 *
 * Exported because {@link interpolate} is not the only place a line is read:
 * the CLI dispatches a CONTROL line — a `For each` header, an `If`'s condition
 * — and `continue`s before it ever reaches the `interpolate` call above, so
 * `{{a.b.c}}` on a control line was silent there while the Sessions API and
 * the Electron adapter (which resolve every line's text before the control
 * dispatch) warned about it. The CLI calls this directly instead; the guard
 * line itself must NOT be interpolated, since the guard path owns its own
 * substitution.
 */
export function warnMultiSegment(text: string): void {
  if (!text.includes('{{')) return;
  let seen: Set<string> | undefined;
  for (const m of text.matchAll(MULTI_SEGMENT_RE)) {
    const name = m[1]!;
    seen ??= new Set();
    if (seen.has(name)) continue;
    seen.add(name);
    logger.warn(`{{${name}}} is not a placeholder: only one property segment is supported`);
  }
}

/** Load a data file and return an array of parameter rows */
export async function loadDataFile(
  dataFilePath: string,
  projectRoot: string,
): Promise<Array<Record<string, string>>> {
  const absPath = path.resolve(projectRoot, dataFilePath);

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch {
    throw new Error(`Data file not found: ${absPath}`);
  }

  if (dataFilePath.endsWith('.json')) {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Data file must contain a JSON array: ${absPath}`);
    }
    return parsed.map((row, i) => {
      if (typeof row !== 'object' || row === null) {
        throw new Error(`Data file row ${i} is not an object: ${absPath}`);
      }
      return Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    });
  }

  if (dataFilePath.endsWith('.csv')) {
    return parseCsv(content);
  }

  throw new Error(`Unsupported data file format (expected .json or .csv): ${absPath}`);
}

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = (lines[0] ?? '').split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

function maskSecret(key: string, value: string): string {
  if (isSecretName(key)) {
    return value.length > 0 ? '***' : '(empty)';
  }
  return value;
}
