/**
 * IntelliSense for `${env.X}` / `${data.X.Y}` / `${<source>.X}` / `${envName}`
 * references — the vscode-free half, so the cursor-context parse, the JSON
 * tree walk, and the secret masking are unit-testable under `node --test`.
 *
 * The grammar mirrored here is the runtime's, from
 * src/parser/interpolate-env-data.ts:
 *
 *   ${ <namespace> . <dotted-path> }     namespace: [A-Za-z_][A-Za-z0-9_]*
 *                                        path segs: [A-Za-z0-9_-]* ('.'-joined)
 *   ${ envName }                         the one no-dot token
 *
 * with optional whitespace just inside the braces. Where the runtime and this
 * file could disagree about what a reference is, the runtime wins — completion
 * only ever *offers*; it never validates.
 *
 * The same file also holds the `{{name}}` half — the *runtime* variables a run
 * fills in per step, as opposed to the parse-time `${...}` references above.
 * Its SOURCE OF TRUTH is `PLACEHOLDER_SOURCE` in src/parser/parameters.ts,
 * which the extension cannot import and therefore mirrors by hand:
 *
 *   {{name}}                             name: \w+, no whitespace
 *   {{name.property}}                    property: [A-Za-z_][A-Za-z0-9_]*
 *
 * One property segment and no more (`{{order.address.city}}` is not a
 * reference), and the root deliberately stays `\w+` because `{{1st}}` always
 * resolved — docs/specs/SPEC-structured-table-reads.md §8.3. The complete
 * mirror of that regex lives next door in env-data-definition-core.ts
 * (`PARAM_REF_RE`); tests/placeholder-grammar-parity.test.js fails if either
 * side parts company with the runtime's literal.
 *
 * What this file matches is narrower, and stays FLAT on purpose: the patterns
 * below find the names a step WRITES, and a step writes a variable, never one
 * property of one (`Set {{order.id}} to …` is not a Set step, and a `For each`
 * header binds `order`, not `order.id`). The one dotted thing here is
 * {@link findForEachBinding}, which answers "where does `{{order}}` — and so
 * `{{order.id}}` — come from" by its root.
 *
 * Neither half reads anything off disk: a `{{}}` resolves against the run's
 * variable map, which is fed by the file's `## Parameters`, by whatever
 * earlier steps capture, and — per pass — by the enclosing loop.
 */
import {
  buildSectionIndex,
  classifyLines,
  extractSections,
  isSecretFlatName,
  maskRecordSecrets,
  matchText,
  parseControlLine,
  resolveValueFromEnv,
} from 'ai-ui-automation-runner-core';
// `.ts` specifier, not the usual `.js`: this module is loaded directly by
// `node --test` (see tests/env-data-completion.test.js), whose ESM resolver
// will not map a `.js` specifier onto a `.ts` file. esbuild and tsc both
// accept it. Sibling core modules are otherwise import-free by convention.
import { isFenceDelimiter } from './step-region-core.ts';

// ---------------------------------------------------------------------------
// Data tree shape (mirrors src/env/data-loader.ts — the extension package
// can't import it, and the shape is just "parsed JSON").
// ---------------------------------------------------------------------------

export type DataValue =
  | string
  | number
  | boolean
  | null
  | DataValue[]
  | { [key: string]: DataValue };

export type DataObject = { [key: string]: DataValue };

// ---------------------------------------------------------------------------
// Cursor context — what is being completed at a position
// ---------------------------------------------------------------------------

/** Cursor is typing the namespace itself: `${`, `${da`, `${ en`. */
export interface NamespaceContext {
  kind: 'namespace';
  /** Characters typed so far (`da` in `${da`). */
  partial: string;
  /** 0-based column where the partial starts (just past `${` + whitespace). */
  replaceStart: number;
}

/** Cursor is typing a dotted path inside a known namespace: `${data.us`,
 *  `${data.users.`, `${endpoints.api.ur`. */
export interface PathContext {
  kind: 'path';
  namespace: string;
  /** Complete segments between the namespace and the one being typed
   *  (`['users']` in `${data.users.ad`). */
  parentPath: string[];
  /** The segment being typed (may be empty, right after a `.`). */
  partial: string;
  /** 0-based column where the partial segment starts. */
  replaceStart: number;
}

export type RefContext = NamespaceContext | PathContext;

/** Namespace: letter/underscore first — same as the runtime's `buildPattern`
 *  input rule. Path segments additionally admit digits-first (`users.0`) and
 *  hyphens, same as the runtime's `[A-Za-z0-9_.\-]+` path class. */
const BODY_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]*)*$/;

/** One path segment as the runtime can address it: `lookupDataPath` splits
 *  the reference on `.`, so a completable key must be a single non-empty run
 *  of this class — a key containing a dot, space, or `@` has no reference
 *  that reaches it and must not be offered. */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * What `${...` reference, if any, the cursor at `character` is inside on
 * `line`. Null when the cursor is not inside an open reference (no `${`
 * before it, a `}` already closed it, or the text since `${` isn't a
 * reference prefix). References never span lines, so line-local is exact.
 */
export function refContextAt(line: string, character: number): RefContext | null {
  const before = line.slice(0, character);
  const open = before.lastIndexOf('${');
  if (open === -1) return null;
  const inner = before.slice(open + 2);
  if (inner.includes('}')) return null;

  // `${\s*` — the runtime tolerates whitespace after the brace.
  const ws = /^\s*/.exec(inner)![0].length;
  const body = inner.slice(ws);
  const bodyStart = open + 2 + ws;

  if (body === '') return { kind: 'namespace', partial: '', replaceStart: bodyStart };
  if (!BODY_RE.test(body)) return null;

  const segments = body.split('.');
  if (segments.length === 1) {
    return { kind: 'namespace', partial: segments[0]!, replaceStart: bodyStart };
  }
  const partial = segments[segments.length - 1]!;
  return {
    kind: 'path',
    namespace: segments[0]!,
    parentPath: segments.slice(1, -1),
    partial,
    replaceStart: character - partial.length,
  };
}

/**
 * What `{{...` runtime reference, if any, the cursor at `character` is inside
 * on `line`: the nearest `{{` before it, plus whatever has been typed since.
 * Null when there is no `{{`, when the reference is already closed, or when
 * the text since it isn't a name the runtime could resolve.
 *
 * The `/^\w*$/` gate is the runtime's name class relaxed to admit the empty
 * partial (nothing typed yet). It subsumes the "no `}` in between" rule rather
 * than restating it — `}` is not a `\w` character, so a cursor sitting past a
 * closed `{{x}}` fails the same test.
 *
 * It is the ROOT's class only, deliberately: a partial with a dot in it —
 * `{{order.` — yields null and no dropdown opens. Completing a property would
 * mean deriving the aliases from the `as <key>` words of whichever `Read …`
 * step wrote the list the enclosing `For each` iterates, and the spec makes
 * that optional and phase 3 for exactly that reason
 * (SPEC-structured-table-reads.md §8.4: offer only explicit aliases, never a
 * guess from prose). Declining to offer is the honest answer meanwhile; F12 on
 * the finished reference still works, through PARAM_REF_RE next door.
 *
 * `${{` yields the *inner* `{{`: the `${` parse above rejects it (`{` is not a
 * namespace character) while the runtime does find a resolvable `{{name}}`
 * inside it, so the `{{` at offset+1 is the one that wins here too.
 */
export function paramContextAt(
  line: string,
  character: number,
): { partial: string; replaceStart: number } | null {
  const before = line.slice(0, character);
  const open = before.lastIndexOf('{{');
  if (open === -1) return null;
  const partial = before.slice(open + 2);
  if (!/^\w*$/.test(partial)) return null;
  return { partial, replaceStart: open + 2 };
}

// ---------------------------------------------------------------------------
// Frontmatter span (for the skill dataSources-path special case)
// ---------------------------------------------------------------------------

/**
 * Whether 0-based `lineIdx` sits inside the YAML frontmatter block, per
 * runner-core's `classifyLines` — the same span every other editor feature
 * uses (decorations, diagnostics, step regions), so completion cannot invent
 * a fourth frontmatter grammar. Delimiter lines count as inside; that is
 * immaterial here because a `---` fence line can never also contain the open
 * `${` that gets this function consulted.
 *
 * Inside the span, `${...}` is a *path* placeholder (skill `dataSources:`
 * values), where the runtime allows only `${env.X}` and `${envName}` — and
 * only for skills.
 */
export function inFrontmatter(
  text: string,
  lineIdx: number,
  classified: ClassifiedLines = classifyLines(text),
): boolean {
  return classified[lineIdx]?.kind === 'frontmatter';
}

/** What `classifyLines` returns — accepted by the functions here so one
 *  classification can serve a whole completion request. */
type ClassifiedLines = ReturnType<typeof classifyLines>;

// ---------------------------------------------------------------------------
// Capture names — the `{{}}` variables a step *writes*
// ---------------------------------------------------------------------------

/** A runtime variable that is in scope at a given point in the run, located
 *  at the exact token that writes it so navigation and scope come from one
 *  walk (an editor selecting a different token than the walk attributed the
 *  write to is a drift that no test can see). */
export interface CaptureName {
  name: string;
  marker: 'input' | 'output' | 'as' | 'out-alias' | 'set';
  /** 1-based line of the capturing step or hook entry. */
  line: number;
  /** 0-based column of the name token on that line, and its length. */
  column: number;
  length: number;
}

/**
 * Every statically-knowable way a step names something it writes, each mirrored
 * from the component that already binds it.
 *
 * What is deliberately NOT here: prose storage (`... and store it as {{x}}`).
 * The runtime reads that shape only in `isExtractionStep`
 * (src/runner/step-executor.ts:296-306), which picks a richer DOM snapshot and
 * binds nothing; the name itself comes from the AI's `read`/`count` action,
 * and the model is told to use a given name only when the step carries
 * `[store as: name]`, deriving its own snake_case name otherwise
 * (src/ai/prompts.ts:195). Offering a prose name would promise a binding the
 * run does not make. Authors who want a capture to complete downstream write
 * `[store as: name]`, which the third pattern below covers.
 *
 * Patterns are matched against a step's INSTRUCTION — the text after the `N. `
 * ordinal, or after a hook entry's `scope:` — because that is what the runner
 * matches, and two of these are anchored to its start.
 */
const CAPTURE_PATTERNS: ReadonlyArray<{
  re: RegExp;
  marker: CaptureName['marker'];
}> = [
  // Runtime prompt answers and DOM captures. Anchored, because the runner
  // anchors: `INPUT_STEP_PATTERN` / `OUTPUT_STEP_PATTERN`
  // (src/runner/test-runner.ts:43,49) only match at the instruction's start, so
  // a marker anywhere else binds nothing. (`^` with no `/m` also makes these
  // single-match, which is the other half of the runner's behaviour.)
  { re: /^\[input:\s*(\w+)\]/gdi, marker: 'input' },
  { re: /^\[output:\s*(\w+)\]/gdi, marker: 'output' },
  // Inline captures, both spellings (cf. STORE_AS_RE, src/skills/expander.ts),
  // anywhere in the instruction — that is how the AI prompt reads them, and how
  // the runner's own `[output:]` enrichment appends one.
  { re: /\[(?:store\s+)?as:\s*(\w+)\]/gdi, marker: 'as' },
  // `[skill: n out.k="alias"]` — the QUOTED alias is what enters the caller's
  // scope (variables-panel.js:43); `out.k` is the callee's own name and is not
  // addressable from here. One invocation may expose several.
  { re: /\bout\.\w+\s*=\s*"([^"]+)"/gd, marker: 'out-alias' },
  // `Set {{name}} to "…"` (stories/variable-assignment.md). Anchored and
  // single-match, because the runtime is: `parseSetStep` reads the whole
  // instruction, so a `Set …` further along a line binds nothing.
  //
  // The value is a LOOKAHEAD so that a line the runtime refuses — an
  // unquoted value, trailing text, or a value containing a quote — offers no
  // name for a file that cannot run, while the match text still ends at the
  // name. `[^"]*` mirrors `parseSetStep`'s own grammar exactly; it used to be
  // `.*`, which accepted `Set {{a}} to "x" and click "Save"` here and stored
  // garbage there.
  { re: /^set\s+\{\{(\w+)\}\}\s+to\s+(?="[^"]*"\s*$)/gdi, marker: 'set' },
];

/** `N. ` ordinal, plus any `[no-hooks]` marker — stripped to get the
 *  instruction the runtime sees.
 *
 *  The marker is stripped in two places on the runtime side, and it needs
 *  both: `extractSteps` (markdown.ts) removes it on the CLI's parse, but the
 *  wire deliberately carries it verbatim, so `parseSetStep` strips it too.
 *  A mirror that stripped only the ordinal went blind to
 *  `[no-hooks] Set {{x}} to "…"` — no completion, no F12, no panel row. Only
 *  the ANCHORED patterns (input, output, set) were affected; the others
 *  match anywhere on the line. */
const STEP_PREFIX_RE = /^\s*\d+\.\s+(?:\[no-hooks\]\s*)?/i;
/** `## Hooks` heading, and its `- scope: instruction` entries. Scope names
 *  match the parser's `HOOK_SCOPES` (src/parser/markdown.ts:25). */
const HOOKS_HEADING_RE = /^(#{2,})\s+hooks\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const HOOK_ENTRY_RE = /^\s*-\s+(\w+)\s*:\s*(.+)$/;
/** Hook scopes that run BEFORE the steps, so their captures are in scope for
 *  a `{{}}` in any step. `after` / `afterEach` run later and are not. */
const PRE_HOOK_SCOPES = new Set(['before', 'beforeeach']);

/**
 * The runtime variables in scope at 0-based `lineIdx`, in execution order,
 * deduped by name (the first write wins).
 *
 * Scope is what has *executed* by this point, which is not the same as what is
 * written above it in the file:
 *
 *  - `## Hooks` `before` / `beforeEach` entries run ahead of every step
 *    wherever they are authored, so they always lead. `after` / `afterEach`
 *    run later and are never in scope for a step.
 *  - A `### Name` section body executes where it is CALLED, not where it is
 *    defined — bodies sit below the main flow. So the main flow is walked in
 *    order and each call splices its callee's body in (transitively, with a
 *    cycle guard), rather than reading the file top to bottom.
 *  - With the cursor inside a section body, that body's own earlier steps are
 *    in scope, plus whatever ran before the section's *earliest* call site.
 *    A section called from several places has several truths; the earliest is
 *    the conservative one — it is what every call site has in common.
 *
 * Fenced code blocks are excluded. `classifyLines` does not track fences (it is
 * why `isInsideFence` exists next door), so a numbered line inside an example
 * fence classifies as a `step` and would otherwise contribute captures no run
 * ever makes.
 *
 * `opts.mainFlowOnly` forces the main-flow reading, ignoring any section that
 * encloses `lineIdx`. It exists for readers that are not themselves steps —
 * an `after` hook runs once the whole main flow has, so its scope is the flow
 * entire, not "whatever section this line happens to sit in".
 * `opts.dedupe: false` keeps every write of a name rather than the first,
 * which is what navigation wants: the run's last write is the live value.
 */
export function captureNamesBefore(
  text: string,
  lineIdx: number,
  classified: ClassifiedLines = classifyLines(text),
  { mainFlowOnly = false, dedupe = true }: { mainFlowOnly?: boolean; dedupe?: boolean } = {},
): CaptureName[] {
  const lines = text.split(/\r?\n/);
  const fenced = fenceMask(lines);
  const isStep = (i: number): boolean => {
    const kind = classified[i]?.kind;
    return !fenced[i] && (kind === 'step' || kind === 'section-step');
  };

  // Which section (if any) each step line belongs to, and the body of each —
  // keyed the way `buildSectionIndex` keys them, so a call resolves to the
  // same definition the expander would pick (first definition wins).
  const { sections, bodyOf, ownerOf } = sectionBodies(text, isStep);
  const index = buildSectionIndex(text);
  const callAt = new Map<number, string>();
  for (const call of index.calls) {
    const key = matchText(call.name);
    if (index.sections.has(key)) callAt.set(call.line - 1, key);
  }

  /** Push a step line and, when it calls a section, that section's body. */
  const walk = (line: number, acc: number[], open: Set<string>): void => {
    acc.push(line);
    const key = callAt.get(line);
    if (!key || open.has(key)) return; // unresolved call, or a cycle
    open.add(key);
    for (const bodyLine of bodyOf.get(key) ?? []) walk(bodyLine, acc, open);
    open.delete(key);
  };

  /** Main-flow steps executing strictly before `stopLine`, expanded. */
  const mainFlowBefore = (stopLine: number): number[] => {
    const acc: number[] = [];
    for (let i = 0; i < stopLine && i < classified.length; i++) {
      if (classified[i]?.kind !== 'step' || fenced[i]) continue;
      walk(i, acc, new Set());
    }
    return acc;
  };

  const executed: number[] = [];
  const owner =
    mainFlowOnly ? null
    : ownerOf.get(lineIdx) ?? nearestSectionAbove(lineIdx, sections, classified, fenced);
  if (owner !== null) {
    // Inside a section body: everything before its earliest call site, then
    // this body's own steps above the cursor.
    const callLines = [...callAt.entries()]
      .filter(([, key]) => key === owner)
      .map(([line]) => line);
    if (callLines.length > 0) executed.push(...mainFlowBefore(Math.min(...callLines)));
    for (const bodyLine of bodyOf.get(owner) ?? []) {
      if (bodyLine >= lineIdx) break;
      walk(bodyLine, executed, new Set([owner]));
    }
  } else {
    executed.push(...mainFlowBefore(lineIdx));
  }

  const out: CaptureName[] = [];
  // Pre-hooks first — they run before step 1 wherever they are authored.
  for (const hook of preHookEntries(lines, fenced)) {
    out.push(...writesIn(hook.instruction, hook.line, hook.column));
  }
  for (const line of executed) {
    const raw = lines[line] ?? '';
    const instruction = raw.replace(STEP_PREFIX_RE, '');
    out.push(...writesIn(instruction, line + 1, raw.length - instruction.length));
  }
  return dedupe ? dedupeByName(out) : out;
}

/**
 * Every capture write anywhere in the file, in file order — regardless of
 * whether it is reachable from any particular cursor position.
 *
 * This answers "is this name ever written, and where", which is a different
 * question from `captureNamesBefore`'s "what is in scope here" and must not
 * be approximated by asking the latter about the end of the file: that walk
 * resolves an owning section for its position, so a file ending inside a
 * `### Section` body would silently drop the main-flow steps below that
 * section's call site.
 */
export function allCaptureWrites(
  text: string,
  classified: ClassifiedLines = classifyLines(text),
): CaptureName[] {
  const lines = text.split(/\r?\n/);
  const fenced = fenceMask(lines);
  const out: CaptureName[] = [];
  for (const hook of hookEntries(lines, fenced)) {
    out.push(...writesIn(hook.instruction, hook.line, hook.column));
  }
  for (let i = 0; i < lines.length; i++) {
    const kind = classified[i]?.kind;
    if (fenced[i] || (kind !== 'step' && kind !== 'section-step')) continue;
    const raw = lines[i] ?? '';
    const instruction = raw.replace(STEP_PREFIX_RE, '');
    out.push(...writesIn(instruction, i + 1, raw.length - instruction.length));
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * The writes an instruction makes, left to right, each located in the raw
 * line via `offset` — the width of whatever preceded the instruction there
 * (a `N. ` ordinal, or a hook entry's `- scope: ` lead-in).
 *
 * Hits from every pattern are merged back into positional order because one
 * step can both invoke a skill and store a capture of its own, and the
 * left-to-right reading is the one an author would predict.
 */
function writesIn(instruction: string, line: number, offset: number): CaptureName[] {
  const hits: Array<{ at: number; name: string; marker: CaptureName['marker'] }> = [];
  for (const { re, marker } of CAPTURE_PATTERNS) {
    for (const m of instruction.matchAll(re)) {
      // The group's OWN start offset, via the `d` flag, rather than
      // `m[0].lastIndexOf(m[1])`.
      //
      // That heuristic assumed the name is the last name-shaped token of the
      // match. Four patterns satisfy it; the `set` one does not, because its
      // match text ends with the keyword ` to `. Measured before the fix:
      // `Set {{to}} to "x"` located the name at the keyword, and `{{t}}` and
      // `{{o}}` likewise — F12 and completion pointed at the wrong span.
      // `indices` is exact for every pattern and needs no assumption at all.
      const at = m.indices?.[1]?.[0] ?? (m.index ?? 0) + m[0].lastIndexOf(m[1]!);
      hits.push({ at, name: m[1]!, marker });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  // `{{...}}` can only express `\w+`, so a quoted alias like "order id" has no
  // reference form and must not be offered — accepting it would author a
  // placeholder the run can never resolve. The other patterns capture `(\w+)`
  // already; testing uniformly means the guard cannot be lost when a pattern
  // is added.
  return hits
    .filter((hit) => /^\w+$/.test(hit.name))
    .map((hit) => ({
      name: hit.name,
      marker: hit.marker,
      line,
      column: offset + hit.at,
      length: hit.name.length,
    }));
}

/** First write of each name wins — the value a `{{}}` holds until something
 *  overwrites it, and the one completion previews. */
function dedupeByName(writes: CaptureName[]): CaptureName[] {
  const seen = new Set<string>();
  return writes.filter((w) => (seen.has(w.name) ? false : (seen.add(w.name), true)));
}

/**
 * Every `### Section` body, keyed as `buildSectionIndex` keys them: the step
 * lines each body holds, and the owning key of each of those lines. One
 * definition of "which body is this line in", shared by the scope walk and by
 * {@link bodyOwnerAt}, because two readings of that would be two answers to
 * the same question.
 *
 * `isStep` is the caller's line filter — classification plus the fence mask —
 * so a body never claims a line no run would execute.
 */
function sectionBodies(
  text: string,
  isStep: (line: number) => boolean,
): {
  sections: ReturnType<typeof extractSections>;
  bodyOf: Map<string, number[]>;
  ownerOf: Map<number, string>;
} {
  const sections = extractSections(text);
  const bodyOf = new Map<string, number[]>();
  const ownerOf = new Map<number, string>();
  for (const section of sections) {
    const key = matchText(section.name);
    if (key === '') continue;
    const body = section.steps.map((s) => s.line - 1).filter(isStep);
    if (!bodyOf.has(key)) bodyOf.set(key, body);
    for (const line of body) if (!ownerOf.has(line)) ownerOf.set(line, key);
  }
  return { sections, bodyOf, ownerOf };
}

/**
 * The `### Section` body 0-based `lineIdx` sits in, keyed as the section index
 * keys it — or null for the main flow.
 *
 * The same reading `captureNamesBefore` makes of the cursor's own line,
 * exported for the callers that have to compare two lines' bodies rather than
 * walk one: `{{order.id}}` on a body's line 2 and a `For each {{order}}` on
 * its line 5 are in one body, and the second runs after the first. Across
 * bodies no such comparison is possible from the text alone, which is why
 * `findForEachBinding` filters on neither.
 */
export function bodyOwnerAt(
  text: string,
  lineIdx: number,
  classified: ClassifiedLines = classifyLines(text),
): string | null {
  const lines = text.split(/\r?\n/);
  const fenced = fenceMask(lines);
  const isStep = (i: number): boolean => {
    const kind = classified[i]?.kind;
    return !fenced[i] && (kind === 'step' || kind === 'section-step');
  };
  const { sections, ownerOf } = sectionBodies(text, isStep);
  return ownerOf.get(lineIdx) ?? nearestSectionAbove(lineIdx, sections, classified, fenced);
}

/**
 * The section body containing `lineIdx` when the cursor is on a blank or
 * prose line inside one (a step being typed classifies as prose until it has
 * content, so the owner map alone would miss exactly the live case).
 */
function nearestSectionAbove(
  lineIdx: number,
  sections: ReturnType<typeof extractSections>,
  classified: ClassifiedLines,
  fenced: boolean[],
): string | null {
  let owner: string | null = null;
  for (let i = 0; i < lineIdx && i < classified.length; i++) {
    const kind = classified[i]?.kind;
    if (fenced[i]) continue;
    if (kind === 'section-heading') {
      const section = sections.find((s) => s.headingLine === i + 1);
      const key = section ? matchText(section.name) : '';
      owner = key === '' ? null : key;
    } else if (kind === 'heading' || kind === 'step') {
      // Back out to the main flow: a `## ` heading closes the Steps span, and
      // a main-flow step can only appear before any section body.
      owner = null;
    }
  }
  return owner;
}

/**
 * Every `For each {{item}} in {{list}}, …` header that binds `name`'s ROOT,
 * in file order, located at its `{{item}}` token.
 *
 * A loop item is the one runtime variable no step writes: `captureNamesBefore`
 * knows `[store as:]`, `[input:]`, `[output:]`, an `out.k="alias"` and a `Set`
 * — all of which are markers a step carries — while `{{order}}` is bound by
 * the planner, once per pass, and `{{order.id}}` with it
 * (docs/specs/SPEC-structured-table-reads.md §8.2). Without this the editor
 * has nothing to say about either, and — since a dotted name can never be a
 * capture — F12 on `{{order.id}}` would toast "no step stores it" on every
 * correct table loop.
 *
 * By the root, because that is what the header binds: `{{order.id}}` and
 * `{{order}}` have the same origin, and field-level navigation is explicitly
 * not required (§8.4).
 *
 * The header grammar is runner-core's `parseControlLine`, the same reading the
 * runtime makes, so a line this walks to is a line that really loops. Two
 * further gates decide whether a matching line is one a RUN would reach:
 *
 *  - `classifyLines`, exactly as `captureNamesBefore` uses it: only a `step`
 *    or a `section-step` binds anything. A numbered line under a `####`
 *    heading classifies as `inert-step` — TestBench's own diagnostic calls it
 *    "This step never runs" — and one outside the `## Steps` span is prose.
 *    Resolving to either would send F12 to a line the extension elsewhere
 *    says is dead.
 *  - Fenced example blocks, excluded for the reason `captureNamesBefore`
 *    excludes them: a run binds nothing there, and `classifyLines` does not
 *    track fences.
 *
 * WHAT THIS DOES NOT DO is scope. Every binding in the file is returned, in
 * file order, with no filter on position and none on reachability: a `For
 * each` three lines BELOW the reference is in this list, and so is one in a
 * section that never calls the section the reference sits in. That is
 * deliberate rather than pending — a section body is DEFINED out of order
 * (bodies sit under the main flow that calls them), so "below the reference"
 * does not mean "after it" in general, and a position filter here would drop
 * the ordinary case: a loop on line 3 whose body is defined on line 20.
 * `bodyOwnerAt` is what a caller uses to ask the one question that can be
 * answered line-locally — is this binding in the SAME body as the reference,
 * and below it? — which is the case the definition provider reports as
 * "written on line N, which the run reaches after this point".
 */
export function findForEachBinding(
  text: string,
  name: string,
  classified: ClassifiedLines = classifyLines(text),
): Array<{ line: number; column: number; length: number }> {
  const item = name.split('.')[0]!;
  const lines = text.split(/\r?\n/);
  const fenced = fenceMask(lines);
  const out: Array<{ line: number; column: number; length: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (fenced[i]) continue;
    const kind = classified[i]?.kind;
    if (kind !== 'step' && kind !== 'section-step') continue;
    if (!STEP_PREFIX_RE.test(raw)) continue;
    const control = parseControlLine(raw.replace(STEP_PREFIX_RE, ''));
    if (control?.kind !== 'foreach' || control.item !== item) continue;
    // The token, not the line: an editor selecting the whole header would
    // highlight the body call as well as the name it is asking about.
    const column = raw.indexOf(`{{${item}}}`);
    if (column === -1) continue;
    out.push({ line: i, column: column + 2, length: item.length });
  }
  return out;
}

/** A `For each {{item}} in {{list}}` binding that is live at some point in the
 *  run — what the `{{` dropdown offers beside parameters and captures. */
export interface LoopItemBinding {
  /** The item name the header binds (`payment`), which is the completion. */
  name: string;
  /** The list it iterates (`payments`), for the dropdown's detail. */
  list: string;
  /** 1-based line of the `For each` header. */
  line: number;
}

/**
 * The loop items in scope at 0-based `lineIdx`, innermost loop first.
 *
 * A loop item is bound by the planner for the length of a pass, so it is in
 * scope in the BODY the `For each` tail calls — and, transitively, in every
 * body that body calls, since the binding lives in the run's variable map
 * rather than in a lexical block. It is also in scope on the header's own
 * line, where an inline tail (`For each {{p}} in {{ps}}, Verify {{p.payee}}`)
 * reads it.
 *
 * Spec §8.4 defers PROPERTY completion after `{{order.` — the aliases come
 * from a natural-language read step and guessing them from prose is
 * forbidden. The item name itself is not a guess: it is written verbatim on
 * the header this walk found, and without it the dropdown inside a loop body
 * silently omits the one variable the body is about.
 *
 * Where several call sites reach a body, every one of their items is offered.
 * That is looser than `captureNamesBefore`'s earliest-call-site reading, and
 * deliberately so in this direction only: completion offers, and an item
 * bound on one of two call paths is a name the author may legitimately write
 * (the run then decides). Nothing here widens what F12 or a diagnostic will
 * claim.
 */
export function loopItemsInScope(
  text: string,
  lineIdx: number,
  classified: ClassifiedLines = classifyLines(text),
): LoopItemBinding[] {
  const lines = text.split(/\r?\n/);
  const fenced = fenceMask(lines);
  const isStep = (i: number): boolean => {
    const kind = classified[i]?.kind;
    return !fenced[i] && (kind === 'step' || kind === 'section-step');
  };
  const { sections, ownerOf } = sectionBodies(text, isStep);
  const index = buildSectionIndex(text);
  const callAt = new Map<number, string>();
  for (const call of index.calls) {
    const key = matchText(call.name);
    if (index.sections.has(key)) callAt.set(call.line - 1, key);
  }

  /** The `For each` a step line IS, or null — same gates as
   *  `findForEachBinding`, so one reading decides what loops. */
  const foreachAt = (line: number): { item: string; list: string } | null => {
    if (!isStep(line)) return null;
    const raw = lines[line] ?? '';
    if (!STEP_PREFIX_RE.test(raw)) return null;
    const control = parseControlLine(raw.replace(STEP_PREFIX_RE, ''));
    return control?.kind === 'foreach' ? { item: control.item, list: control.list } : null;
  };

  const out: LoopItemBinding[] = [];
  const seen = new Set<string>();
  const add = (line: number, hit: { item: string; list: string }): void => {
    if (seen.has(hit.item)) return;
    seen.add(hit.item);
    out.push({ name: hit.item, list: hit.list, line: line + 1 });
  };

  const own = foreachAt(lineIdx);
  if (own) add(lineIdx, own);

  let owner = ownerOf.get(lineIdx) ?? nearestSectionAbove(lineIdx, sections, classified, fenced);
  const open = new Set<string>();
  while (owner !== null && !open.has(owner)) {
    open.add(owner);
    const callers = [...callAt.entries()]
      .filter(([, key]) => key === owner)
      .map(([line]) => line)
      .sort((a, b) => a - b);
    for (const line of callers) {
      const hit = foreachAt(line);
      if (hit) add(line, hit);
    }
    // Keep climbing from the first call site: a body called from another
    // body is inside that one's loops too.
    const above = callers.length > 0 ? (ownerOf.get(callers[0]!) ?? null) : null;
    owner = above;
  }
  return out;
}

/** One `## Hooks` entry: its instruction, 1-based line, the scope it declares,
 *  and the column the instruction starts at within the raw line. */
interface HookEntry {
  instruction: string;
  line: number;
  scope: string;
  column: number;
}

/** Every `## Hooks` entry, whatever its scope. */
function hookEntries(lines: string[], fenced: boolean[]): HookEntry[] {
  const out: HookEntry[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (fenced[i]) continue;
    const heading = ANY_HEADING_RE.exec(raw);
    if (heading) {
      const hooks = HOOKS_HEADING_RE.exec(raw);
      depth = hooks ? hooks[1]!.length : 0;
      continue;
    }
    if (depth === 0) continue;
    const entry = HOOK_ENTRY_RE.exec(raw);
    if (!entry) continue;
    const body = entry[2]!;
    const instruction = body.trim();
    // Group 2 runs to end-of-line, so it is a suffix of the raw line; the
    // trim then shifts the start by whatever padding it removed.
    const column = raw.length - body.length + (body.length - body.trimStart().length);
    out.push({ instruction, line: i + 1, scope: entry[1]!.toLowerCase(), column });
  }
  return out;
}

/** `## Hooks` entries that run before the steps. */
function preHookEntries(lines: string[], fenced: boolean[]): HookEntry[] {
  return hookEntries(lines, fenced).filter((h) => PRE_HOOK_SCOPES.has(h.scope));
}

/**
 * The hook scope declared on `lineIdx` (0-based), or null when that line is
 * not a hook entry. A `{{}}` READ on a post-hook line is in scope for
 * everything the main flow wrote, since the hook runs after it — the mirror
 * of `PRE_HOOK_SCOPES`, which handles the same asymmetry for writes.
 */
export function hookScopeAt(text: string, lineIdx: number): string | null {
  const lines = text.split(/\r?\n/);
  const entry = hookEntries(lines, fenceMask(lines)).find((h) => h.line === lineIdx + 1);
  return entry ? entry.scope : null;
}

/** Hook scopes that run AFTER the steps, so a `{{}}` read on one of their
 *  lines sees everything the flow wrote. */
export const POST_HOOK_SCOPES: ReadonlySet<string> = new Set(['after', 'aftereach']);

/**
 * Whether 0-based `lineIdx` sits inside a fenced code block.
 *
 * `captureNamesBefore` already excludes fenced lines as writes; a reference
 * READ inside a fence is the same kind of non-thing — a run interpolates
 * nothing there — so editor features must not report on it either.
 */
export function isFencedLine(text: string, lineIdx: number): boolean {
  return fenceMask(text.split(/\r?\n/))[lineIdx] ?? false;
}

/** Per-line "is inside a fenced block" mask, one pass. Delimiter lines count
 *  as inside — they are never steps anyway. Same naive delimiter rule as
 *  `isInsideFence`, whose trade-offs are documented there. */
function fenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceDelimiter(lines[i] ?? '')) {
      open = !open;
      mask[i] = true;
      continue;
    }
    mask[i] = open;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Tree walking + `$VAR` leaf resolution
// ---------------------------------------------------------------------------

/**
 * Walk `parts` into a parsed data tree — the same semantics as the runtime's
 * `lookupDataPath` (arrays take integer segments), except over a whole
 * prefix rather than a full reference. Undefined on any miss.
 */
export function walkTree(tree: DataValue | undefined, parts: string[]): DataValue | undefined {
  let cur: DataValue | undefined = tree;
  for (const part of parts) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!(part in cur)) return undefined;
      cur = cur[part];
    }
  }
  return cur;
}

/**
 * Replace `$NAME` string leaves with the env var's value, so previews show
 * what the run would substitute (the loader's `resolveSecrets`). Leaves
 * delegate to runner-core's `resolveValueFromEnv` — the same lookup the
 * `## Parameters` `$VAR` path uses; an unset var keeps the literal, same as
 * the runtime. (The loader's `/^\$[A-Z_][A-Z0-9_]*$/i` gate is observably
 * equivalent here: these env maps come from `parseEnv`, whose keys are
 * always identifier-shaped.)
 */
export function resolveDataTree(value: DataValue, env: Record<string, string>): DataValue {
  if (typeof value === 'string') return resolveValueFromEnv(value, env);
  if (Array.isArray(value)) return value.map((v) => resolveDataTree(v, env));
  if (value && typeof value === 'object') {
    const out: DataObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDataTree(v, env);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

/** Star-mask in the same shape `maskIfSecret` renders elsewhere. */
function maskValue(value: string): string {
  if (value.length === 0) return '(empty)';
  return '*'.repeat(Math.min(value.length, 8));
}

/**
 * Mask `value` when the name (a single env var, or a '.'-joined data path) is
 * secret-shaped anywhere along it — matching the runtime's
 * `envDataSecretValues`, which treats a secret-named key as tainting
 * everything beneath it. Works on the joined path because no pattern word
 * contains '.'.
 *
 * `isSecretFlatName` is runner-core's copy of the runtime's `isSecretName`
 * (src/parser/parameters.ts), and it is the FLAT rule on purpose: every
 * segment of a `${data.…}` path is a name from an author's own file, so
 * nothing here is a record column and the narrow record rule would be the
 * wrong question. Calling it rather than re-spelling the regex is the point —
 * this file used to carry a third copy, kept because runner-core's was once
 * narrower than the runtime's; it no longer is, and a completion detail is as
 * public as a report, so there is one flat rule on the client now.
 */
function maskIfSecretName(name: string, value: string): string {
  return isSecretFlatName(name) ? maskValue(value) : value;
}

/**
 * The `{{` dropdown's masker for a DECLARED PARAMETER: the author's own name
 * first, and then the value's SHAPE.
 *
 * The name check alone is the whole rule everywhere else in this file, and it
 * is enough there: a `${data.…}` leaf is one scalar and an env var is one
 * string, so if the name does not say secret there is nothing inside to say
 * it. A parameter is the one place a RECORD can arrive — a `## Parameters`
 * entry may hold a captured table verbatim, `[{"payee":"Alinta",
 * "password":"hunter2"}]` — and `readTable` made that ordinary. The report
 * redacts it column by column (`maskRecordSecrets` is runner-core's mirror of
 * the server's rule); without this the dropdown printed it in full, under a
 * parameter name like `rows` that says nothing at all.
 *
 * Masked BEFORE previewing, not after: `previewValue` truncates at
 * PREVIEW_MAX and a truncated record no longer parses as JSON, so a table long
 * enough to be cut — which is most of them — would come back untouched.
 * Star-masking a whole secret-NAMED value is unaffected either way, since
 * `maskValue` caps at eight stars.
 */
function maskParamPreview(name: string, value: string): string {
  if (isSecretFlatName(name)) return maskValue(previewValue(value));
  return previewValue(maskRecordSecrets(value));
}

// ---------------------------------------------------------------------------
// Plain completion descriptors (mapped to vscode.CompletionItem by the caller)
// ---------------------------------------------------------------------------

export interface PlainCompletion {
  label: string;
  kind:
    | 'namespace'
    | 'env-var'
    | 'branch'
    | 'leaf'
    | 'env-name'
    | 'parameter'
    | 'capture'
    | 'loop-item';
  /** Short right-hand text: a masked value preview, the node shape, or where
   *  a capture is written. */
  detail?: string;
  /** Text to insert when it differs from the label (`data.` for a namespace). */
  insertText?: string;
  /** Re-open the suggest widget after accepting (namespace items, whose
   *  mandatory `.` was just inserted). */
  chain?: boolean;
  sortText: string;
}

const PREVIEW_MAX = 48;

/** A leaf as step text would receive it (runtime `stringifyDataValue`),
 *  flattened + truncated for a one-line detail. */
function previewValue(v: DataValue): string {
  const s =
    v === null ? ''
    : typeof v === 'string' ? v
    : typeof v === 'object' ? JSON.stringify(v)
    : String(v);
  const flat = s.replace(/\r?\n/g, '␤');
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

/**
 * Completions for the node at `parentPath` inside `tree`: the keys of an
 * object, the indices of an array, nothing for a leaf (there is nothing
 * deeper to type). Keys the reference grammar cannot address (a dot, space,
 * `@`, …) are not offered — accepting one would author a reference the
 * runtime can never resolve. `namespace` is the already-typed lead-in,
 * required because it participates in secret masking (a source *named*
 * `passwords` taints its whole tree).
 */
export function treeCompletions(
  tree: DataValue | undefined,
  parentPath: string[],
  namespace: string,
): PlainCompletion[] {
  const node = walkTree(tree, parentPath);
  if (node === undefined || node === null || typeof node !== 'object') return [];

  const entries: Array<[string, DataValue]> = Array.isArray(node)
    ? node.map((v, i) => [String(i), v] as [string, DataValue])
    : Object.entries(node).filter(([key]) => SEGMENT_RE.test(key));

  return entries.map(([key, value], i) => {
    const isBranch = value !== null && typeof value === 'object';
    const fullPath = [namespace, ...parentPath, key].join('.');
    return {
      label: key,
      kind: isBranch ? 'branch' : 'leaf',
      detail: isBranch
        ? Array.isArray(value)
          ? `[${value.length} item${value.length === 1 ? '' : 's'}]`
          : `{${Object.keys(value).length} key${Object.keys(value).length === 1 ? '' : 's'}}`
        : maskIfSecretName(fullPath, previewValue(value)),
      // JSON author order, not alphabetical — data files group related keys.
      sortText: String(i).padStart(4, '0'),
    };
  });
}

/** Completions for `${env.` — every key of the composed env map, masked. */
export function envVarCompletions(env: Record<string, string>): PlainCompletion[] {
  return Object.keys(env)
    .sort((a, b) => a.localeCompare(b))
    .map((name, i) => ({
      label: name,
      kind: 'env-var' as const,
      detail: maskIfSecretName(name, previewValue(env[name]!)),
      sortText: String(i).padStart(4, '0'),
    }));
}

export interface NamespaceOptions {
  /** Active env name. Callers only ask for completions when an env is
   *  selected — with none, a run interpolates nothing, so nothing is
   *  offerable (the wiring returns [] before reaching here). */
  envName: string;
  /** Detail for the `data` item, e.g. `fixtures/data/local.json` (possibly
   *  suffixed ` (not found)`). Null suppresses the item — the caller passes
   *  null for skills, which never see the caller-env data file. */
  dataDetail: string | null;
  /** Declared `dataSources` names with their declared paths as detail. */
  sources: Array<{ name: string; detail: string }>;
  /** Detail for the `env` item (which .env file(s) feed it). */
  envDetail: string;
  /** Restrict to what a dataSources *path string* may reference (`env` +
   *  `envName` only) — set inside a skill's frontmatter. */
  pathPosition?: boolean;
}

/**
 * The namespace-level completions for `${` — `data`, each declared source,
 * `env`, and `envName`. Namespace items insert their trailing `.` (it is
 * mandatory in the grammar) and chain straight into the next level.
 */
export function namespaceCompletions(opts: NamespaceOptions): PlainCompletion[] {
  const out: PlainCompletion[] = [];
  if (!opts.pathPosition) {
    if (opts.dataDetail !== null) {
      out.push({
        label: 'data',
        kind: 'namespace',
        detail: opts.dataDetail,
        insertText: 'data.',
        chain: true,
        sortText: '0',
      });
    }
    for (const [i, s] of opts.sources.entries()) {
      out.push({
        label: s.name,
        kind: 'namespace',
        detail: s.detail,
        insertText: `${s.name}.`,
        chain: true,
        sortText: `1_${String(i).padStart(2, '0')}`,
      });
    }
  }
  out.push({
    label: 'env',
    kind: 'namespace',
    detail: opts.envDetail,
    insertText: 'env.',
    chain: true,
    sortText: '2',
  });
  out.push({
    label: 'envName',
    kind: 'env-name',
    detail: opts.envName,
    sortText: '3',
  });
  return out;
}

/**
 * The `{{` dropdown: declared parameters first, then the names earlier steps
 * capture, then the items of the loops enclosing this line. Deduped across all
 * three — a name that is more than one lists once, under the source the run
 * resolves it from first.
 *
 * `params` values arrive already `$VAR`-resolved: the caller composes `.env`
 * with `.env.<envName>` and runs runner-core's `resolveValueFromEnv`, exactly
 * as the run does, so the preview is what would be substituted. Masking is by
 * the parameter's own name under the runtime rule above, and then by the
 * VALUE's shape (`maskParamPreview`), so the dropdown never shows what a
 * report would redact — not even a record-shaped value under a name that says
 * nothing. An unset `$VAR`, which previews as its own literal, is masked all
 * the same when the name is secret-shaped.
 *
 * Captures carry no preview: their values exist only mid-run. Their detail
 * names the marker form and the 1-based line that writes it, derived from the
 * `CaptureName` union rather than the spelling found in the source (`[as:]`
 * covers `[store as: x]` and the prose `store it as {{x}}` alike).
 *
 * Loop items last, for the same reason and with the same absence of a
 * preview: `{{payment}}` holds one record per pass, so the only static fact
 * about it is the header that binds it. They are offered as the flat item
 * name alone — the properties after `{{payment.` are phase 3
 * (SPEC-structured-table-reads.md §8.4).
 */
export function paramCompletions(
  params: Record<string, string>,
  captures: CaptureName[],
  loops: LoopItemBinding[] = [],
): PlainCompletion[] {
  const out: PlainCompletion[] = [];
  const seen = new Set<string>();

  for (const [name, value] of Object.entries(params)) {
    seen.add(name);
    out.push({
      label: name,
      kind: 'parameter',
      detail: maskParamPreview(name, value),
      // Declared order inside the group; the group prefix keeps every
      // parameter above every capture.
      sortText: `0_${String(out.length).padStart(4, '0')}`,
    });
  }

  const paramCount = out.length;
  for (const capture of captures) {
    // `captureNamesBefore` already deduped its own list; this catches the
    // cross-source collision and keeps the function total for any caller.
    if (seen.has(capture.name)) continue;
    seen.add(capture.name);
    out.push({
      label: capture.name,
      kind: 'capture',
      detail: `[${capture.marker}:] on line ${capture.line}`,
      sortText: `1_${String(out.length - paramCount).padStart(4, '0')}`,
    });
  }

  const beforeLoops = out.length;
  for (const loop of loops) {
    if (seen.has(loop.name)) continue;
    seen.add(loop.name);
    out.push({
      label: loop.name,
      kind: 'loop-item',
      detail: `each {{${loop.list}}} on line ${loop.line}`,
      sortText: `2_${String(out.length - beforeLoops).padStart(4, '0')}`,
    });
  }

  return out;
}
