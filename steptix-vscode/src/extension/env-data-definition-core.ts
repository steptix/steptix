/**
 * Go-to-definition for `${env.X}` / `${data.X.Y}` / `${<source>.X}` references
 * — the vscode-free half, so the reference hit-test, the position-tracking
 * JSON walk, and the `.env` assignment scan are unit-testable under
 * `node --test`. The vscode wiring (file resolution, Locations, warnings)
 * lives in env-data-definition.ts.
 *
 * Where the completion side (env-data-completion-core.ts) parses an OPEN
 * reference being typed at the cursor, definition parses COMPLETE references:
 * the runtime only ever resolves a closed `${...}`, and F12 lands on finished
 * text. The grammar mirrored is the runtime's ANY_REF_RE
 * (src/parser/interpolate-env-data.ts):
 *
 *   ${ <namespace> . <dotted-path> }     namespace: [A-Za-z_][A-Za-z0-9_]*
 *                                        path: [A-Za-z0-9_.\-]+
 *   ${ envName }                         the one no-dot token
 *
 * with optional whitespace just inside the braces. Anything looser (an
 * unclosed `${data.`, a `${{`) is not a reference the runtime would resolve,
 * so it is not a jump target either.
 *
 * The `{{name}}` runtime half lives here too: its cursor hit-test (the
 * runtime's `PLACEHOLDER_SOURCE`, src/parser/parameters.ts — `{{name}}` and
 * `{{name.property}}`) and the locator for a `- name:` bullet under
 * `## Parameters`. Its other jump targets — the step that captures a name,
 * and the `For each` header that binds a loop item — are reported by
 * `captureNamesBefore` and `findForEachBinding` in
 * env-data-completion-core.ts, which carry each write's column so scope and
 * position come from one walk.
 *
 * Where a grammar is owned elsewhere, this file locates rather than restates
 * it: the `.env` and `## Parameters` scans delegate to runner-core's
 * `scanServerEnv` / `scanSectionItems`, which return positions beside the
 * values their map-building siblings parse.
 */
import { parseTree, type Node } from 'jsonc-parser';
import { classifyLines, scanSectionItems, scanServerEnv } from 'steptix-runner-core';
// `.ts` specifier for the reason the sibling core states: this module is
// loaded directly by `node --test`, whose ESM resolver will not map a `.js`
// specifier onto a `.ts` file. The dependency runs one way — the scope walk
// lives next door and nothing there asks anything of this file.
import {
  POST_HOOK_SCOPES,
  allCaptureWrites,
  bodyOwnerAt,
  captureNamesBefore,
  findForEachBinding,
  hookScopeAt,
} from './env-data-completion-core.ts';

// ---------------------------------------------------------------------------
// Reference under the cursor
// ---------------------------------------------------------------------------

/** A complete `${...}` reference containing the cursor. */
export interface RefAtPosition {
  /** The namespace token (`data`, `env`, a declared source — or `envName`). */
  namespace: string;
  /** Dotted-path segments after the namespace (empty for `${envName}`). */
  path: string[];
  /** Which token the cursor sits on: -1 the namespace, else an index into
   *  `path`. Cursor on `${`/`}`/padding clamps to the nearest token, so F12
   *  works from anywhere inside the reference. */
  segmentIndex: number;
}

/** The runtime's dotted-reference pattern (ANY_REF_RE without the `envName`
 *  alternative — that one is matched separately below). */
const DOTTED_REF_RE = /\$\{(\s*)([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_.\-]+)\s*\}/g;
const ENV_NAME_REF_RE = /\$\{\s*envName\s*\}/g;

/**
 * The complete reference the cursor at `character` sits inside on `line`,
 * or null. "Inside" spans the whole `${...}` token inclusive of both ends,
 * matching how the invocation provider treats its token edges. References
 * never span lines, so line-local is exact.
 */
export function refAtPosition(line: string, character: number): RefAtPosition | null {
  for (const m of line.matchAll(DOTTED_REF_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (character < start || character > end) continue;

    const body = `${m[2]!}.${m[3]!}`;
    const bodyStart = start + 2 + m[1]!.length; // past `${` and the padding
    const segments = body.split('.');

    // Token ranges are [segStart, segEnd] inclusive of the end column (cursor
    // just past the last char still hits), and the scan clamps: a cursor left
    // of the body (on `${`) reads as the namespace, right of it (padding, `}`)
    // as the last segment.
    let onSegment = segments.length - 1;
    let segStart = bodyStart;
    for (let i = 0; i < segments.length; i++) {
      const segEnd = segStart + segments[i]!.length;
      if (character <= segEnd) {
        onSegment = i;
        break;
      }
      segStart = segEnd + 1; // past the `.`
    }
    return {
      namespace: segments[0]!,
      path: segments.slice(1),
      segmentIndex: onSegment - 1,
    };
  }

  for (const m of line.matchAll(ENV_NAME_REF_RE)) {
    const start = m.index!;
    if (character >= start && character <= start + m[0].length) {
      return { namespace: 'envName', path: [], segmentIndex: -1 };
    }
  }
  return null;
}

/**
 * The runtime's `{{name}}` / `{{name.property}}` grammar, no whitespace.
 *
 * SOURCE OF TRUTH: `PLACEHOLDER_SOURCE` in src/parser/parameters.ts. The
 * extension cannot import `src/`, so this literal is that string character for
 * character, and tests/placeholder-grammar-parity.test.js fails the moment the
 * two part company. The root stays `\w+` — `{{1st}}` has always resolved — and
 * only the one optional property segment follows the identifier rule; there is
 * no second one, so `{{order.address.city}}` is not a reference
 * (docs/specs/SPEC-structured-table-reads.md §8.3).
 *
 * The width is what makes a dotted reference ONE token. The flat mirror this
 * replaces matched nothing at all in `{{order.id}}` — there is no `}}` after
 * `order` — so F12 and Peek went dead on every property of every table loop,
 * silently; and a looser scanner, one that took the prefix and left `.id}}`
 * behind as text, would have been worse: it would have reported confidently
 * about `{{order}}`, a different variable.
 *
 * Finding one inside `${{name}}` is deliberate — the `${` parse above rejects
 * it while the runtime resolves the inner pair.
 *
 * USE IT WITH `matchAll` ONLY. This is a module-level `/g` regex, and `/g`
 * carries `lastIndex` between calls: `.test()` and `.exec()` on it answer
 * about wherever the previous call stopped, so the same line alternates
 * between matching and not. `String.prototype.matchAll` is immune — it
 * iterates over its own clone and leaves this object's `lastIndex` at 0 —
 * which is why every reader here (and the parity test) goes through it, and
 * why the runtime, whose readers DO call `.test()`, exports a
 * `placeholderRe()` factory instead of the constant
 * (src/parser/parameters.ts). Need a `.test()`, add a factory beside this;
 * do not reach for this one.
 */
export const PARAM_REF_RE = /\{\{(\w+(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}\}/g;

/**
 * The complete `{{name}}` reference the cursor at `character` sits inside on
 * `line`, or null. Same inclusive-edges rule as `refAtPosition`.
 */
export function paramRefAtPosition(line: string, character: number): { name: string } | null {
  for (const m of line.matchAll(PARAM_REF_RE)) {
    const start = m.index!;
    if (character >= start && character <= start + m[0].length) {
      return { name: m[1]! };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where a `{{name}}` comes from
// ---------------------------------------------------------------------------

/** A jump target inside this file: 0-based line, 0-based column, length. */
export interface ParamHit {
  line: number;
  column: number;
  length: number;
}

/**
 * What defines a `{{name}}` at a point in a file — `found` with every target
 * in the order the editor should list them, or the reason there is none.
 *
 * The `line` on a miss is 1-based, because it is spoken to a human in a
 * toast; the `line` on a hit is 0-based, because it addresses an editor.
 */
export type ParamDefinition =
  | { kind: 'found'; hits: ParamHit[] }
  /** A step writes the name, further along the run than this line. */
  | { kind: 'later-capture'; line: number }
  /** A `For each` binds it, in this same body, below this line. */
  | { kind: 'later-loop'; line: number }
  /** Nothing in the file binds it at all. */
  | { kind: 'none' };

/**
 * Everything that defines `{{name}}` at 0-based `lineIdx`, in the order the
 * editor should offer them — or why nothing does.
 *
 * Three sources, and a dotted name reorders them. A `## Parameters` bullet
 * holds a string and a `[store as:]` writes one; neither is ever where
 * `{{order.id}}` came from, because only a record a `For each` bound has
 * properties at all. So for a dotted name the loop header leads and the flat
 * sources are the fallback; for a flat `{{order}}` it is the other way round
 * — a `For each` binds for the length of its body, while a capture or a
 * parameter is the value the author asked about everywhere else in the file.
 * Everything is asked about the ROOT throughout (`order` for `order.id`):
 * the planner binds a record and its properties together, once per pass, and
 * field-level navigation is explicitly not required
 * (docs/specs/SPEC-structured-table-reads.md §8.4).
 *
 * All the hits are returned rather than one, so a name written more than once
 * peeks as a list: the run's LAST write is the live value while a reader
 * looking for where a name comes from usually wants the first, and the editor
 * should not have to guess which question is being asked.
 *
 * Reachability is asked only where the text can answer it. A `For each` in
 * the SAME body, below this line, runs after this point — that is the
 * `later-loop` miss. Across bodies nothing is claimed: a section body is
 * defined below the main flow that calls it, so "below" and "after" are
 * different questions there ({@link findForEachBinding} says the same).
 */
export function paramDefinition(
  text: string,
  lineIdx: number,
  name: string,
  classified: ReturnType<typeof classifyLines> = classifyLines(text),
): ParamDefinition {
  const root = name.split('.')[0]!;
  const dotted = name !== root;

  const flat: ParamHit[] = [];
  const bullet = findParameterBullet(text, root);
  if (bullet) flat.push(bullet);

  // A post-hook reads after the whole flow; anything else reads where it
  // sits. `mainFlowOnly` also keeps the hook line — which belongs to no
  // section — from being attributed to whatever section encloses it.
  const postHook = POST_HOOK_SCOPES.has(hookScopeAt(text, lineIdx) ?? '');
  const writes = captureNamesBefore(text, postHook ? classified.length : lineIdx, classified, {
    mainFlowOnly: postHook,
    dedupe: false,
  }).filter((c) => c.name === root);
  for (const write of writes) flat.push({ ...write, line: write.line - 1 });

  const headers = findForEachBinding(text, root, classified);
  const owner = headers.length > 0 ? bodyOwnerAt(text, lineIdx, classified) : null;
  // A header on this very line binds its own inline tail, so only a STRICTLY
  // lower line in the same body is out of reach.
  const reached = headers.filter(
    (h) => h.line <= lineIdx || bodyOwnerAt(text, h.line, classified) !== owner,
  );

  const hits = dotted ? [...reached, ...flat] : [...flat, ...reached];
  if (hits.length > 0) return { kind: 'found', hits };

  // Nothing binds it here. Distinguish "later in the run" from "nowhere",
  // which is a different question from the scope walk above: that walk
  // resolves an owning section for its position, so a file ending inside a
  // section body would drop the main-flow steps below its call site and
  // misreport them as never written.
  const later = allCaptureWrites(text, classified).find((c) => c.name === root);
  if (later) return { kind: 'later-capture', line: later.line };
  if (headers.length > 0) return { kind: 'later-loop', line: headers[0]!.line + 1 };
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Locating a dotted path inside JSON text
// ---------------------------------------------------------------------------

/** Where a dotted path leads inside a JSON document's raw text. */
export interface JsonPathTarget {
  /** 0-based position of the deepest located token: an object key's first
   *  character (inside its quotes), or an array element's first value
   *  character. `{0,0}` when nothing matched. */
  line: number;
  column: number;
  /** Character length of the located key text — what an editor should
   *  highlight. 0 for array elements and the nothing-matched fallback. */
  length: number;
  /** How many leading segments of the requested path were found. Equal to
   *  `path.length` on an exact hit. */
  depth: number;
}

/**
 * Walk `path` into raw JSON text and return the deepest token reached — the
 * exact key on a full match, the nearest existing ancestor on a partial one
 * (`depth` says which).
 *
 * Matching mirrors the runtime's `lookupDataPath` (src/env/data-loader.ts):
 * object segments by key equality — where a duplicated key resolves to its
 * LAST occurrence, because that is what `JSON.parse` keeps — and array
 * segments by `Number(segment)` as a bounds-checked integer index. Note
 * `findNodeAtLocation` cannot serve here: it returns the FIRST of duplicate
 * keys, and answers `undefined` rather than naming how far it got.
 *
 * Positions come from jsonc-parser's `parseTree` (VS Code's own JSON tooling)
 * rather than a hand-rolled scanner, so string escapes, number forms, and
 * whitespace are somebody else's solved problem. A document too malformed to
 * produce a tree yields the top of the file; callers gate on a successful
 * `JSON.parse` first, so that is a fallback, not the normal path.
 */
export function locateJsonPath(text: string, path: string[]): JsonPathTarget {
  let best = { offset: 0, length: 0, depth: 0 };
  let node = parseTree(text);

  for (let depth = 0; node !== undefined && depth < path.length; depth++) {
    const segment = path[depth]!;

    if (node.type === 'object') {
      // Last matching property wins, so scan all of them rather than stopping
      // at the first — `JSON.parse` keeps the last duplicate.
      let match: Node | undefined;
      for (const property of node.children ?? []) {
        if (property.children?.[0]?.value === segment) match = property;
      }
      const key = match?.children?.[0];
      if (!key) return toTarget(text, best);
      // `offset`/`length` span the quotes; the selection is the text inside.
      best = { offset: key.offset + 1, length: Math.max(0, key.length - 2), depth: depth + 1 };
      node = match?.children?.[1];
      continue;
    }

    if (node.type === 'array') {
      const index = Number(segment);
      const element = node.children?.[index];
      if (!Number.isInteger(index) || index < 0 || !element) return toTarget(text, best);
      // An element has no key token to select — land on its first character.
      best = { offset: element.offset, length: 0, depth: depth + 1 };
      node = element;
      continue;
    }

    return toTarget(text, best); // a scalar — nothing deeper to address
  }

  return toTarget(text, best);
}

/** Offset → line/column, counting newlines without copying the prefix. */
function toTarget(
  text: string,
  best: { offset: number; length: number; depth: number },
): JsonPathTarget {
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < best.offset; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: best.offset - lineStart, length: best.length, depth: best.depth };
}

// ---------------------------------------------------------------------------
// Locating an assignment inside .env text
// ---------------------------------------------------------------------------

/**
 * The line assigning `name` in `.env`-format text, or null.
 *
 * Delegates to runner-core's `scanServerEnv`, which reads the file the way
 * the SERVER does when it resolves `${env.X}` (`parseEnvFile`,
 * src/env/loader.ts) rather than the way the stricter `parseEnv` does — so
 * navigation and the composed values this feature offers come from one
 * grammar, and it is the grammar a real run applies. The LAST assignment
 * wins, as it does in that map.
 */
export function findEnvLine(
  text: string,
  name: string,
): { line: number; column: number; length: number } | null {
  let hit: { line: number; column: number; length: number } | null = null;
  for (const entry of scanServerEnv(text)) {
    if (entry.key === name) hit = { line: entry.line, column: entry.column, length: entry.length };
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Locating a `- name:` bullet under `## Parameters`
// ---------------------------------------------------------------------------

/**
 * The bullet declaring parameter `name`, or null.
 *
 * Delegates to runner-core's `scanSectionItems`, the same scan `parseSection`
 * builds the run's parameter map from — so the section-entry/exit rules and
 * the bullet grammar are stated once, and F12 cannot disagree with what the
 * run reads. Among duplicate bullets the LAST wins, matching that map.
 */
export function findParameterBullet(
  text: string,
  name: string,
): { line: number; column: number; length: number } | null {
  let hit: { line: number; column: number; length: number } | null = null;
  for (const item of scanSectionItems(text, 'Parameters')) {
    if (item.key === name) hit = { line: item.line, column: item.column, length: item.length };
  }
  return hit;
}
