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
 * runtime's `\{\{(\w+)\}\}`, src/parser/parameters.ts) and the locator for a
 * `- name:` bullet under `## Parameters`. Its other jump target — the step
 * that captures a name — is located by `captureWriteRange` in
 * env-data-completion-core.ts, next to the capture patterns it must mirror.
 */

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
  DOTTED_REF_RE.lastIndex = 0;
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

  ENV_NAME_REF_RE.lastIndex = 0;
  for (const m of line.matchAll(ENV_NAME_REF_RE)) {
    const start = m.index!;
    if (character >= start && character <= start + m[0].length) {
      return { namespace: 'envName', path: [], segmentIndex: -1 };
    }
  }
  return null;
}

/** The runtime's `{{name}}` grammar (src/parser/parameters.ts): `\w+`, no
 *  whitespace, flat. Finding one inside `${{name}}` is deliberate — the
 *  `${` parse above rejects it while the runtime resolves the inner pair. */
const PARAM_REF_RE = /\{\{(\w+)\}\}/g;

/**
 * The complete `{{name}}` reference the cursor at `character` sits inside on
 * `line`, or null. Same inclusive-edges rule as `refAtPosition`.
 */
export function paramRefAtPosition(line: string, character: number): { name: string } | null {
  PARAM_REF_RE.lastIndex = 0;
  for (const m of line.matchAll(PARAM_REF_RE)) {
    const start = m.index!;
    if (character >= start && character <= start + m[0].length) {
      return { name: m[1]! };
    }
  }
  return null;
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
 * Walk `path` into raw JSON text, tracking source positions, and return the
 * deepest token reached — the exact key on a full match, the nearest existing
 * ancestor on a partial one (`depth` says which).
 *
 * Matching mirrors the runtime's `lookupDataPath` (src/env/data-loader.ts):
 * object segments by key equality — where a duplicated key resolves to its
 * LAST occurrence, because that is what `JSON.parse` keeps — and array
 * segments by `Number(segment)` as a bounds-checked integer index.
 *
 * The scanner assumes `text` is valid JSON (callers gate on a successful
 * `JSON.parse` first); if it trips anyway it returns what it had matched so
 * far rather than throwing.
 */
export function locateJsonPath(text: string, path: string[]): JsonPathTarget {
  let best = { offset: 0, length: 0, depth: 0 };

  const skipWs = (i: number): number => {
    while (i < text.length && ' \t\r\n'.includes(text[i]!)) i++;
    return i;
  };

  /** Scan the string starting at `i` (an opening quote). Returns the offset
   *  just past the closing quote and the decoded value. */
  const scanString = (i: number): { end: number; value: string } => {
    let out = '';
    i++; // past the opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const esc = text[i + 1]!;
        if (esc === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          out += esc === 'b' ? '\b'
            : esc === 'f' ? '\f'
            : esc === 'n' ? '\n'
            : esc === 'r' ? '\r'
            : esc === 't' ? '\t'
            : esc; // `"` `\` `/` decode to themselves
          i += 2;
        }
      } else {
        out += text[i];
        i++;
      }
    }
    if (text[i] !== '"') throw new Error('unterminated string');
    return { end: i + 1, value: out };
  };

  /** Offset just past the value starting at `i`. */
  const skipValue = (i: number): number => {
    const c = text[i];
    if (c === '"') return scanString(i).end;
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i = skipWs(i + 1);
      if (text[i] === close) return i + 1;
      while (true) {
        if (c === '{') {
          i = skipWs(scanString(i).end); // key
          if (text[i] !== ':') throw new Error('expected :');
          i = skipWs(i + 1);
        }
        i = skipWs(skipValue(i));
        if (text[i] === ',') {
          i = skipWs(i + 1);
          continue;
        }
        if (text[i] !== close) throw new Error(`expected ${close}`);
        return i + 1;
      }
    }
    // Scalar: number / true / false / null.
    let end = i;
    while (end < text.length && !' \t\r\n,]}'.includes(text[end]!)) end++;
    if (end === i) throw new Error('empty value');
    return end;
  };

  /** Descend into the value at `i` looking for `path[depth]`. */
  const descend = (i: number, depth: number): void => {
    if (depth >= path.length) return;
    const segment = path[depth]!;
    const c = text[i];

    if (c === '{') {
      // Remember the LAST member matching the segment — `JSON.parse` keeps
      // the last duplicate, so that is the one the runtime resolves.
      let match: { keyOffset: number; keyLength: number; valueStart: number } | null = null;
      i = skipWs(i + 1);
      if (text[i] !== '}') {
        while (true) {
          const keyStart = i; // at the opening quote
          const key = scanString(i);
          i = skipWs(key.end);
          if (text[i] !== ':') throw new Error('expected :');
          const valueStart = skipWs(i + 1);
          if (key.value === segment) {
            match = {
              keyOffset: keyStart + 1,
              keyLength: key.end - keyStart - 2, // raw text between the quotes
              valueStart,
            };
          }
          i = skipWs(skipValue(valueStart));
          if (text[i] === ',') {
            i = skipWs(i + 1);
            continue;
          }
          break;
        }
      }
      if (match) {
        best = { offset: match.keyOffset, length: match.keyLength, depth: depth + 1 };
        descend(match.valueStart, depth + 1);
      }
      return;
    }

    if (c === '[') {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0) return;
      i = skipWs(i + 1);
      if (text[i] === ']') return;
      for (let elem = 0; ; elem++) {
        if (elem === idx) {
          best = { offset: i, length: 0, depth: depth + 1 };
          descend(i, depth + 1);
          return;
        }
        i = skipWs(skipValue(i));
        if (text[i] !== ',') return; // `]` — index out of range
        i = skipWs(i + 1);
      }
    }
    // Scalar — nothing to descend into.
  };

  try {
    descend(skipWs(0), 0);
  } catch {
    // Fall through with the deepest position reached before the trip.
  }

  const before = text.slice(0, best.offset);
  const lineBreak = before.lastIndexOf('\n');
  return {
    line: (before.match(/\n/g) ?? []).length,
    column: best.offset - lineBreak - 1,
    length: best.length,
    depth: best.depth,
  };
}

// ---------------------------------------------------------------------------
// Locating an assignment inside .env text
// ---------------------------------------------------------------------------

/**
 * The line defining `name` in `.env`-format text, or null. Mirrors
 * runner-core's `parseEnv` line grammar — blank/`#` lines skipped, an
 * `export ` prefix tolerated, the key being everything before the first `=`
 * trimmed — leniently: a malformed line elsewhere (which makes `parseEnv`
 * throw and a run fail) doesn't stop the scan, because "where is this
 * written" is exactly what the author needs to go fix. The LAST assignment
 * wins, as it does in `parseEnv`'s composed map.
 */
export function findEnvLine(
  text: string,
  name: string,
): { line: number; column: number; length: number } | null {
  const lines = text.split(/\r?\n/);
  let hit: { line: number; column: number; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const stripped = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (key !== name) continue;
    // Column of the key's first char in the raw line: leading whitespace,
    // plus the stripped prefix, plus any padding between it and the key.
    const column =
      (raw.length - raw.trimStart().length) +
      (trimmed.length - stripped.length) +
      (stripped.length - stripped.trimStart().length);
    hit = { line: i, column, length: key.length };
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Locating a `- name:` bullet under `## Parameters`
// ---------------------------------------------------------------------------

// Mirrors runner-core's `parseSection` (test-meta.ts) exactly — that is what
// the run path calls (via `parseParameters`) to build the parameter map, but
// it returns values only, so the line scan is restated here with positions.
const SECTION_HEADING_RE = /^(#{2,})\s+(\S.*?)\s*$/;
const SECTION_ITEM_RE = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/;

/**
 * The bullet declaring parameter `name`, or null. Scope is the FIRST
 * `## Parameters` section (case-insensitive, any `##`+ depth), ending at the
 * next heading of the same or shallower depth; among duplicate bullets the
 * LAST wins — all of it because `parseSection` reads the file that way, and
 * navigation must land on the line whose value the run would use.
 */
export function findParameterBullet(
  text: string,
  name: string,
): { line: number; column: number; length: number } | null {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  let sectionDepth = 0;
  let hit: { line: number; column: number; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const heading = SECTION_HEADING_RE.exec(raw);
    if (heading) {
      if (inSection && heading[1]!.length <= sectionDepth) break;
      if (!inSection && heading[2]!.toLowerCase() === 'parameters') {
        inSection = true;
        sectionDepth = heading[1]!.length;
      }
      continue;
    }
    if (!inSection) continue;
    const item = SECTION_ITEM_RE.exec(raw);
    if (!item || item[1] !== name) continue;
    // The key is the line's first word-run (nothing before it but whitespace
    // and `-`), so indexOf finds its exact column.
    hit = { line: i, column: raw.indexOf(name), length: name.length };
  }
  return hit;
}
